/**
 * Host-route and model-tool guard tests (Slice 0 items 0.6, 0.7, 0.12).
 * The plugin is mounted on a fake context: routes are called with real Request
 * objects, tools with the same (args, exec) contract the Harness uses.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createBoardStore } from '../lib/store.js'
import {
  addWorktree,
  findTool,
  callAction,
  commitIn,
  connectSse,
  defaultAgents,
  deferred,
  fakeShell,
  fakeWebServer,
  getDiff,
  getPresets,
  getState,
  getTicket,
  gitRepo,
  loadPlugin,
  tempDir,
  waitFor,
} from './helpers.mjs'

const iso = () => new Date().toISOString()

function seedBoard(dataDir, ticket) {
  writeFileSync(
    join(dataDir, 'board.json'),
    JSON.stringify({ version: 1, board: { name: 'Test' }, nextKey: 2, tickets: [ticket] }),
  )
}

const gateTicket = () => ({
  id: 't-1',
  key: 'B-1',
  title: 'review me',
  description: '',
  acceptance: [],
  status: 'in_review',
  assignee: 'coder',
  createdAt: iso(),
  updatedAt: iso(),
  activity: [],
  artifacts: [],
  runs: [{ id: 'run-1', status: 'awaiting_review', startedAt: iso(), endedAt: null, sessionId: 'session-1', tokens: 0, reason: null }],
  currentRunId: 'run-1',
  budget: { tokens: null },
})

test('the human route refuses to mark a ticket done without approving it', async () => {
  const { routes, cleanups } = await loadPlugin({ workspace: tempDir() })
  try {
    const created = await callAction(routes, { action: 'create', title: 'needs approval' })
    const ticket = created.body.tickets[0]
    const response = await callAction(routes, { action: 'update', id: ticket.id, status: 'done' })
    assert.equal(response.status, 409)
    assert.match(response.body.error, /approve a ticket from In Review/)
    const state = await getState(routes)
    assert.equal(state.body.tickets[0].status, 'backlog')
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('the human route refuses to move a gate ticket out of the gate', async () => {
  const dataDir = tempDir()
  seedBoard(dataDir, gateTicket())
  const { routes, cleanups } = await loadPlugin({ workspace: tempDir(), dataDir })
  try {
    const response = await callAction(routes, { action: 'update', id: 'B-1', status: 'in_progress' })
    assert.equal(response.status, 409)
    assert.match(response.body.error, /leaves the gate only through/)
    const state = await getState(routes)
    assert.equal(state.body.tickets[0].status, 'in_review')
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('the human route refuses to park a running ticket at the gate', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { routes, cleanups } = await loadPlugin({ workspace: tempDir(), services: { agents } })
  try {
    const created = await callAction(routes, { action: 'create', title: 'running' })
    const ticket = created.body.tickets[0]
    await callAction(routes, { action: 'assign', id: ticket.id, assignee: 'coder' })
    await callAction(routes, { action: 'update', id: ticket.id, status: 'ready' })
    await waitFor(async () => {
      const state = await getState(routes)
      return state.body.tickets.find(item => item.id === ticket.id)?.runs.at(-1)?.status === 'running'
    })
    const response = await callAction(routes, { action: 'update', id: ticket.id, status: 'in_review' })
    assert.equal(response.status, 409)
    assert.match(response.body.error, /worker is still running/)
  } finally {
    idle.resolve()
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('board_update lets an agent reach the gate but not leave it', async () => {
  const dataDir = tempDir()
  const ticket = gateTicket()
  ticket.currentRunId = null
  ticket.runs[0].status = 'awaiting_review'
  seedBoard(dataDir, ticket)
  const { tools, cleanups } = await loadPlugin({ workspace: tempDir(), dataDir })
  try {
    const update = findTool(tools, 'board_update')
    const exec = { agent: { id: 'coder' } }
    await assert.rejects(update.execute({ id: 'B-1', status: 'in_progress' }, exec), /may only move a ticket to In Review or Blocked/)
    await assert.rejects(update.execute({ id: 'B-1', status: 'done' }, exec), /cannot mark a ticket Done/)
    await assert.rejects(update.execute({ id: 'B-1', status: 'in_review' }), /needs a calling agent/)
    const cyclic = await update.execute({ id: 'B-1', status: 'in_review' }, exec)
    assert.equal(cyclic, 'B-1 is now [in_review] @coder')
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('board_create always starts in the initial state, whatever status is requested', async () => {
  const { tools, cleanups } = await loadPlugin({ workspace: tempDir() })
  try {
    const create = findTool(tools, 'board_create')
    const result = await create.execute({ title: 'sneaky', status: 'done' })
    assert.match(result, /\[backlog\]/)
    const update = findTool(tools, 'board_update')
    await assert.rejects(update.execute({ id: 'B-1', status: 'in_review' }), /can only move its own in-progress ticket/)
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('board_claim assigns the calling agent and refuses to assign someone else', async () => {
  const { tools, routes, cleanups } = await loadPlugin({ workspace: tempDir() })
  try {
    const create = findTool(tools, 'board_create')
    await create.execute({ title: 'claim me' })
    await create.execute({ title: 'not yours' })
    const claim = findTool(tools, 'board_claim')
    await assert.rejects(claim.execute({ id: 'B-2', assignee: 'victim' }, { agent: { id: 'agent-7' } }), /cannot claim B-2 for "victim"/)
    const result = await claim.execute({ id: 'B-1' }, { agent: { id: 'agent-7' } })
    assert.match(result, /as agent-7/)
    const state = await getState(routes)
    assert.equal(state.body.tickets.find(ticket => ticket.key === 'B-1').assignee, 'agent-7')
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('documented run-controller config reaches the controller and the snapshot', async () => {
  const { plugin, routes, cleanups } = await loadPlugin({
    workspace: tempDir(),
    config: { agentPreset: 'other-preset', worktrees: false, maxWorkers: 3 },
  })
  try {
    assert.equal(plugin.agentPreset, 'other-preset')
    assert.equal(plugin.worktrees, false)
    const state = await getState(routes)
    assert.equal(state.body.board.maxWorkers, 3)
    assert.deepEqual(state.body.queue, [])
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('a gate ticket with no work behind it can be moved back', async () => {
  const dataDir = tempDir()
  const ticket = gateTicket()
  ticket.currentRunId = null
  ticket.runs = []
  seedBoard(dataDir, ticket)
  const { routes, cleanups } = await loadPlugin({ workspace: tempDir(), dataDir })
  try {
    const response = await callAction(routes, { action: 'update', id: 'B-1', status: 'backlog' })
    assert.equal(response.status, 200)
    assert.equal(response.body.tickets[0].status, 'backlog')
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('a gate ticket with an unmerged branch still cannot be moved out', async () => {
  const dataDir = tempDir()
  const ticket = gateTicket()
  ticket.currentRunId = null
  ticket.runs[0].worktree = { path: '/tmp/nonexistent', branch: 'board/b-1', baseCommit: 'abc', baseBranch: 'master' }
  seedBoard(dataDir, ticket)
  const { routes, cleanups } = await loadPlugin({ workspace: tempDir(), dataDir })
  try {
    const response = await callAction(routes, { action: 'update', id: 'B-1', status: 'in_progress' })
    assert.equal(response.status, 409)
    assert.match(response.body.error, /open run or an unmerged branch/)
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('the action route refuses to cancel a ticket parked at the gate', async () => {
  const dataDir = tempDir()
  seedBoard(dataDir, gateTicket())
  const { routes, cleanups } = await loadPlugin({ workspace: tempDir(), dataDir })
  try {
    const response = await callAction(routes, { action: 'cancel', id: 'B-1' })
    assert.equal(response.status, 400)
    assert.match(response.body.error, /closed with Reject/)
    const state = await getState(routes)
    assert.equal(state.body.tickets[0].status, 'in_review')
    assert.equal(state.body.tickets[0].runs[0].status, 'awaiting_review')
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('board_update refuses to touch another agent\'s ticket', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { tools, routes, cleanups } = await loadPlugin({ workspace: tempDir(), services: { agents } })
  try {
    const create = findTool(tools, 'board_create')
    await create.execute({ title: 'owned by B' })
    await callAction(routes, { action: 'assign', id: 'B-1', assignee: 'agent-B' })
    await callAction(routes, { action: 'update', id: 'B-1', status: 'ready' })
    await waitFor(async () => {
      const state = await getState(routes)
      return state.body.tickets[0]?.runs.at(-1)?.status === 'running'
    })
    const update = findTool(tools, 'board_update')
    await assert.rejects(update.execute({ id: 'B-1', status: 'in_review' }, { agent: { id: 'agent-A' } }), /assigned to agent-B/)
    const moved = await update.execute({ id: 'B-1', status: 'in_review' }, { agent: { id: 'agent-B' } })
    assert.match(moved, /in_review/)
  } finally {
    idle.resolve()
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('board_claim only claims unassigned tickets in an initial or dispatch state', async () => {
  const dataDir = tempDir()
  const base = {
    description: '',
    acceptance: [],
    createdAt: iso(),
    updatedAt: iso(),
    activity: [],
    artifacts: [],
    runs: [],
    currentRunId: null,
    budget: { tokens: null },
  }
  writeFileSync(
    join(dataDir, 'board.json'),
    JSON.stringify({
      version: 1,
      board: { name: 'Claims' },
      nextKey: 4,
      tickets: [
        { ...base, id: 't-1', key: 'B-1', title: 'assigned', status: 'backlog', assignee: 'agent-B' },
        { ...base, id: 't-2', key: 'B-2', title: 'in review', status: 'in_review', assignee: null },
        { ...base, id: 't-3', key: 'B-3', title: 'free', status: 'backlog', assignee: null },
      ],
    }),
  )
  const { tools, cleanups } = await loadPlugin({ workspace: tempDir(), dataDir })
  try {
    const claim = findTool(tools, 'board_claim')
    await assert.rejects(claim.execute({ id: 'B-1' }, { agent: { id: 'agent-A' } }), /already assigned to agent-B/)
    await assert.rejects(claim.execute({ id: 'B-2' }, { agent: { id: 'agent-A' } }), /only unassigned Backlog or Ready/)
    const claimed = await claim.execute({ id: 'B-3' }, { agent: { id: 'agent-A' } })
    assert.match(claimed, /as agent-A/)
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('a ticket can be created with acceptance criteria and checks', async () => {
  const { routes, cleanups } = await loadPlugin({ workspace: tempDir() })
  try {
    const created = await callAction(routes, {
      action: 'create',
      title: 'with checks',
      acceptance: 'line one\nline two',
      checks: 'tests :: npm test\nlint :: npm run lint',
    })
    const ticket = created.body.tickets[0]
    assert.deepEqual(ticket.acceptance, ['line one', 'line two'])
    assert.equal(ticket.checks.length, 2)
    assert.equal(ticket.checks[0].name, 'tests')
    assert.equal(ticket.checks[1].command, 'npm run lint')
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('the diff route returns the unmerged run branch change', async () => {
  const repo = gitRepo()
  const worktree = addWorktree(repo, 'board/b-1')
  commitIn(repo, worktree.path, { 'work.txt': 'hello diff\n' })
  const dataDir = tempDir()
  const ticket = gateTicket()
  ticket.runs[0].worktree = worktree
  seedBoard(dataDir, ticket)
  const { routes, cleanups } = await loadPlugin({ workspace: repo.dir, dataDir })
  try {
    const diff = await getDiff(routes, 'B-1')
    assert.equal(diff.status, 200)
    assert.equal(diff.body.available, true)
    assert.equal(diff.body.branch, 'board/b-1')
    assert.equal(diff.body.baseBranch, 'master')
    assert.ok(diff.body.files.some(file => file.path === 'work.txt'))
    assert.match(diff.body.patch, /\+hello diff/)
    assert.equal(diff.body.truncated, false)
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('a large multi-byte diff is capped by bytes and flagged as truncated', async () => {
  const repo = gitRepo()
  const worktree = addWorktree(repo, 'board/b-1')
  const huge = 'é'.repeat(300000)
  commitIn(repo, worktree.path, { 'huge.txt': huge + '\n' })
  const dataDir = tempDir()
  const ticket = gateTicket()
  ticket.runs[0].worktree = worktree
  seedBoard(dataDir, ticket)
  const { routes, cleanups } = await loadPlugin({ workspace: repo.dir, dataDir })
  try {
    const diff = await getDiff(routes, 'B-1')
    assert.equal(diff.status, 200)
    assert.equal(diff.body.available, true)
    assert.equal(diff.body.truncated, true)
    assert.ok(diff.body.bytes > 600000)
    assert.ok(Buffer.byteLength(diff.body.patch) <= 200004, 'the cap is bytes, not UTF-16 units')
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('the diff route explains when there is no run branch', async () => {
  const dataDir = tempDir()
  seedBoard(dataDir, gateTicket())
  const { routes, cleanups } = await loadPlugin({ workspace: tempDir(), dataDir })
  try {
    const diff = await getDiff(routes, 'B-1')
    assert.equal(diff.status, 200)
    assert.equal(diff.body.available, false)
    assert.match(diff.body.reason, /no unmerged run branch/)
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('failing checks block approval until the human overrides', async () => {
  const repo = gitRepo()
  const worktree = addWorktree(repo, 'board/b-1')
  commitIn(repo, worktree.path, { 'work.txt': 'checked work\n' })
  const dataDir = tempDir()
  const ticket = gateTicket()
  ticket.checks = [{ name: 'tests', command: 'npm test', timeoutMs: null }]
  ticket.runs[0].worktree = worktree
  seedBoard(dataDir, ticket)
  const shell = fakeShell({ failures: ['npm test'] })
  const { routes, cleanups } = await loadPlugin({ workspace: repo.dir, dataDir, services: { shell } })
  try {
    const blocked = await callAction(routes, { action: 'approve', id: 'B-1' })
    assert.equal(blocked.status, 400)
    assert.match(blocked.body.error, /checks failed \(tests\)/)
    const state = await getState(routes)
    assert.equal(state.body.tickets[0].status, 'in_review')
    assert.equal(state.body.tickets[0].runs[0].checks[0].exitCode, 1)

    const approved = await callAction(routes, { action: 'approve', id: 'B-1', overrideChecks: true, reason: 'flaky suite, verified manually' })
    assert.equal(approved.status, 200)
    const after = approved.body.tickets[0]
    assert.equal(after.status, 'done')
    assert.equal(after.runs[0].checks[0].exitCode, 1)
    assert.equal(after.runs[0].checksOverridden.reason, 'flaky suite, verified manually')
    assert.ok(after.activity.some(event => event.kind === 'checks-override'))
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('a comment on a running ticket is delivered to the worker session', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { routes, cleanups } = await loadPlugin({ workspace: tempDir(), services: { agents } })
  try {
    const created = await callAction(routes, { action: 'create', title: 'live steering' })
    const id = created.body.tickets[0].id
    await callAction(routes, { action: 'assign', id, assignee: 'coder' })
    await callAction(routes, { action: 'update', id, status: 'ready' })
    await waitFor(async () => {
      const state = await getState(routes)
      return state.body.tickets[0]?.runs.at(-1)?.status === 'running'
    })

    const commented = await callAction(routes, { action: 'comment', id, text: 'add a guard clause' })
    assert.equal(commented.status, 200)
    assert.equal(commented.body.delivery.delivered, true)
    const ticket = commented.body.tickets[0]
    const comment = [...ticket.activity].reverse().find(event => event.kind === 'comment')
    assert.ok(comment.deliveredTo, 'the comment must be marked as delivered')
    assert.equal(agents.handles[0].agent.followups.length, 2)
    assert.match(agents.handles[0].agent.followups[1].content[0].text, /add a guard clause/)
  } finally {
    idle.resolve()
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('a comment on a parked ticket is stored without delivery', async () => {
  const dataDir = tempDir()
  seedBoard(dataDir, gateTicket())
  const { routes, cleanups } = await loadPlugin({ workspace: tempDir(), dataDir })
  try {
    const commented = await callAction(routes, { action: 'comment', id: 'B-1', text: 'waiting on review' })
    assert.equal(commented.status, 200)
    assert.equal(commented.body.delivery.delivered, false)
    const comment = [...commented.body.tickets[0].activity].reverse().find(event => event.kind === 'comment')
    assert.equal(comment.deliveredTo, undefined)
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('acceptance criteria can be edited through the action route', async () => {
  const { routes, cleanups } = await loadPlugin({ workspace: tempDir() })
  try {
    const created = await callAction(routes, { action: 'create', title: 'edit acceptance' })
    const id = created.body.tickets[0].id
    const updated = await callAction(routes, { action: 'update', id, acceptance: 'must pass\n- must be documented' })
    assert.equal(updated.status, 200)
    assert.deepEqual(updated.body.tickets[0].acceptance, ['must pass', 'must be documented'])
    assert.deepEqual((await getState(routes)).body.tickets[0].acceptance, ['must pass', 'must be documented'])
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('the presets route lists agent presets for the assignee picker', async () => {
  const agentPresets = {
    async list() {
      return [
        { id: 'coder', name: 'Coder', description: 'writes code' },
        { id: 'broken-one', name: 'Broken', broken: true },
      ]
    },
  }
  const { routes, cleanups } = await loadPlugin({ workspace: tempDir(), services: { agentPresets } })
  try {
    const presets = await getPresets(routes)
    assert.equal(presets.status, 200)
    assert.equal(presets.body.presets.length, 2)
    assert.deepEqual(presets.body.presets[0], { id: 'coder', name: 'Coder', description: 'writes code', broken: false })
    assert.equal(presets.body.presets[1].broken, true)
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('the SSE channel refuses unauthenticated clients and pushes revisions', async () => {
  const webServer = fakeWebServer()
  const trust = headers => (headers && headers.cookie === 'session=ok' ? undefined : 401)
  const { routes, cleanups } = await loadPlugin({ workspace: tempDir(), services: { webServer, trust } })
  try {
    const route = webServer.routes.find(candidate => candidate.path === '/board/events')
    assert.ok(route, 'the events channel must be registered')

    const denied = connectSse(route, { headers: {} })
    await denied.run()
    assert.equal(denied.res.status, 401)
    assert.equal(denied.chunks.length, 0)

    const client = connectSse(route, { headers: { cookie: 'session=ok' } })
    await client.run()
    assert.equal(client.res.status, 200)
    assert.match(String(client.res.headers['content-type']), /text\/event-stream/)

    await callAction(routes, { action: 'create', title: 'push me' })
    const frames = client.chunks
      .filter(chunk => chunk.startsWith('data: '))
      .map(chunk => JSON.parse(chunk.slice('data: '.length)))
    assert.ok(frames.length >= 2, 'connect frame plus one push')
    assert.ok(frames.at(-1).revision > frames[0].revision)
    client.handlers.close?.()
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('the SSE channel refuses more than its listener cap', async () => {
  const webServer = fakeWebServer()
  const { cleanups } = await loadPlugin({ workspace: tempDir(), services: { webServer, trust: () => undefined } })
  try {
    const route = webServer.routes.find(candidate => candidate.path === '/board/events')
    const clients = []
    for (let index = 0; index < 20; index += 1) {
      const client = connectSse(route, { headers: { cookie: 'ok' } })
      await client.run()
      clients.push(client)
    }
    assert.equal(clients[0].res.status, 200)
    const overflow = connectSse(route, { headers: { cookie: 'ok' } })
    await overflow.run()
    assert.equal(overflow.res.status, 503)
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('tickets can be created with dependencies, priority and budgets', async () => {
  const { routes, cleanups } = await loadPlugin({ workspace: tempDir() })
  try {
    await callAction(routes, { action: 'create', title: 'base' })
    const created = await callAction(routes, {
      action: 'create',
      title: 'dependent',
      blockedBy: 'B-1',
      priority: 4,
      budgetMinutes: 5,
    })
    const dependent = created.body.tickets.find(ticket => ticket.key === 'B-2')
    assert.deepEqual(dependent.blockedBy, [created.body.tickets.find(ticket => ticket.key === 'B-1').id])
    assert.equal(dependent.priority, 4)
    assert.equal(dependent.budget.minutes, 5)
    assert.equal(typeof created.body.health, 'object')
    assert.equal(created.body.health.tickets, 2)
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('dependencies and priority can be edited through the action route', async () => {
  const { routes, cleanups } = await loadPlugin({ workspace: tempDir() })
  try {
    await callAction(routes, { action: 'create', title: 'a' })
    await callAction(routes, { action: 'create', title: 'b' })
    const updated = await callAction(routes, { action: 'update', id: 'B-2', blockedBy: 'B-1', priority: '2' })
    assert.equal(updated.status, 200)
    const ticket = updated.body.tickets.find(item => item.key === 'B-2')
    assert.equal(ticket.priority, 2)
    assert.equal(ticket.blockedBy.length, 1)
    const cyc = await callAction(routes, { action: 'update', id: 'B-1', blockedBy: 'B-2' })
    assert.equal(cyc.status, 400)
    assert.match(cyc.body.error, /dependency cycle/)
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('archive and unarchive through the action route', async () => {
  const { routes, cleanups } = await loadPlugin({ workspace: tempDir() })
  try {
    await callAction(routes, { action: 'create', title: 'archivable' })
    const archived = await callAction(routes, { action: 'archive', id: 'B-1' })
    assert.ok(archived.body.tickets[0].archivedAt)
    const restored = await callAction(routes, { action: 'unarchive', id: 'B-1' })
    assert.equal(restored.body.tickets[0].archivedAt, null)
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('the prune action reports removed and kept checkouts', async () => {
  const { routes, cleanups } = await loadPlugin({ workspace: tempDir() })
  try {
    const response = await callAction(routes, { action: 'prune' })
    assert.equal(response.status, 200)
    assert.deepEqual(response.body.prune, { removed: [], kept: [], skipped: [], errors: [] })
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('the state route can serve a compact summary and the ticket route the detail', async () => {
  const { routes, cleanups } = await loadPlugin({ workspace: tempDir() })
  try {
    const created = await callAction(routes, { action: 'create', title: 'summary me', acceptance: 'one' })
    const id = created.body.tickets[0].id
    const summary = await getState(routes, { summary: true })
    assert.equal(summary.status, 200)
    const card = summary.body.tickets[0]
    assert.equal(card.title, 'summary me')
    assert.equal(card.activityCount, 1)
    assert.equal(card.artifactCount, 0)
    assert.equal(card.activity, undefined)
    assert.equal(card.runs, undefined)
    assert.equal(typeof summary.body.health, 'object')
    assert.equal(summary.body.board.archivedCount, 0)

    const detail = await getTicket(routes, id)
    assert.equal(detail.status, 200)
    assert.equal(detail.body.ticket.acceptance[0], 'one')
    assert.equal(detail.body.ticket.activity.length, 1)
    assert.equal(Array.isArray(detail.body.ticket.runs), true)

    const missing = await getTicket(routes, 'nope')
    assert.equal(missing.status, 404)
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('planning sessions, submission and approval create subtasks', async () => {
  const agents = defaultAgents()
  const { routes, tools, cleanups } = await loadPlugin({ workspace: tempDir(), services: { agents } })
  try {
    const created = await callAction(routes, { action: 'create', title: 'planned', assignee: 'coder' })
    const id = created.body.tickets[0].id
    const started = await callAction(routes, { action: 'plan-start', id })
    assert.equal(started.status, 200)
    const sessionId = started.body.planSessionId
    assert.ok(sessionId)
    assert.equal(started.body.tickets[0].plan.sessionId, sessionId)

    const submit = findTool(tools, 'board_submit_plan')
    await assert.rejects(submit.execute({ id, markdown: '# plan' }, { agent: { id: 'someone-else' } }), /only the planning session/)
    const result = await submit.execute(
      { id, markdown: '# Plan\n- do it', acceptance: 'works', decomposition: JSON.stringify([{ title: 'part one' }, { title: 'part two', blockedBy: [1] }]) },
      { agent: { id: sessionId } },
    )
    assert.match(result, /Plan v1 submitted/)

    const changes = await callAction(routes, { action: 'plan-changes', id, feedback: 'split it further' })
    assert.equal(changes.status, 200)
    assert.equal(changes.body.tickets[0].plan.status, 'draft')
    assert.ok(agents.handles[0].agent.followups.some(message => String(JSON.stringify(message)).includes('split it further')))

    await submit.execute({ id, markdown: '# Plan v2', decomposition: JSON.stringify([{ title: 'part one' }, { title: 'part two', blockedBy: [1] }]) }, { agent: { id: sessionId } })
    const approved = await callAction(routes, { action: 'plan-approve', id })
    assert.equal(approved.status, 200)
    const parent = approved.body.tickets.find(ticket => ticket.id === id)
    assert.equal(parent.plan.status, 'approved')
    assert.equal(parent.subtaskIds.length, 2)
    const children = approved.body.tickets.filter(ticket => ticket.parentId === id)
    assert.equal(children.length, 2)
    const blockedChild = children.find(ticket => ticket.blockedBy.length === 1)
    const firstChild = children.find(ticket => ticket.id !== blockedChild.id)
    assert.equal(Boolean(blockedChild), true)
    assert.equal(blockedChild.blockedBy[0], firstChild.id)
    assert.equal(children.every(ticket => ticket.assignee === 'coder'), true)
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('a worker question pauses the ticket and the answer resumes the same session', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { routes, tools, cleanups } = await loadPlugin({ workspace: tempDir(), services: { agents } })
  try {
    const created = await callAction(routes, { action: 'create', title: 'blocked on a decision', assignee: 'coder' })
    const id = created.body.tickets[0].id
    await callAction(routes, { action: 'update', id, status: 'ready' })
    await waitFor(async () => {
      const state = await getState(routes)
      return state.body.tickets[0]?.runs.at(-1)?.status === 'running'
    })
    let state = await getState(routes)
    const sessionId = state.body.tickets[0].runs.at(-1).sessionId
    const ask = findTool(tools, 'board_ask')
    await assert.rejects(ask.execute({ id, question: 'Which API?' }, { agent: { id: 'not-this-worker' } }), /only the run/)
    await ask.execute({ id, question: 'Which API should this use?' }, { agent: { id: sessionId } })
    state = await getState(routes)
    assert.equal(state.body.tickets[0].status, 'blocked')
    assert.equal(state.body.tickets[0].needsInput.question, 'Which API should this use?')
    assert.equal(state.body.tickets[0].runs.at(-1).status, 'needs_input')

    idle.resolve()
    await waitFor(async () => {
      const next = await getState(routes)
      return next.body.tickets[0].archivedAt === null && next.body.tickets[0].runs.length === 1
    })
    const answered = await callAction(routes, { action: 'answer', id, answer: 'Use the REST endpoint.' })
    assert.equal(answered.status, 200)
    const ticket = answered.body.tickets[0]
    assert.equal(ticket.status, 'in_progress')
    assert.equal(ticket.needsInput, null)
    assert.equal(ticket.runs.length, 2)
    assert.equal(agents.created.some(item => item.resumed), true)
    const followup = agents.handles[agents.handles.length - 1].agent.followups.at(-1)
    assert.match(JSON.stringify(followup), /Use the REST endpoint/)
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('the autonomy policy lets agents triage and enforces the WIP limit', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { routes, tools, cleanups } = await loadPlugin({
    workspace: tempDir(),
    services: { agents },
    config: { autonomy: { agentsCanReady: true, agentsCanAssign: true, wipLimit: 1 } },
  })
  try {
    const update = findTool(tools, 'board_update')
    const created = await callAction(routes, { action: 'create', title: 'triage this' })
    const id = created.body.tickets[0].id
    const result = await update.execute({ id, status: 'ready', assignee: 'coder-2' }, { agent: { id: 'planner-1' } })
    assert.match(result, /\[in_progress\]/)

    const state = await getState(routes)
    assert.equal(state.body.board.autonomy.wipLimit, 1)
    assert.equal(state.body.board.autonomy.agentsCanReady, true)
    assert.equal(state.body.tickets[0].assignee, 'coder-2')
    assert.equal(state.body.tickets[0].status, 'in_progress')
    const triageEvent = state.body.tickets[0].activity.find(event => event.kind === 'status' && event.by === 'planner-1')
    assert.ok(triageEvent, 'the triage transition is attributed to the agent')

    const second = await callAction(routes, { action: 'create', title: 'next one' })
    const secondId = second.body.tickets.find(ticket => ticket.title === 'next one').id
    await assert.rejects(
      update.execute({ id: secondId, status: 'ready', assignee: 'coder-2' }, { agent: { id: 'planner-1' } }),
      /WIP limit reached/,
    )
  } finally {
    idle.resolve()
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('without the autonomy policy agents cannot triage or assign', async () => {
  const { routes, tools, cleanups } = await loadPlugin({ workspace: tempDir() })
  try {
    const update = findTool(tools, 'board_update')
    const created = await callAction(routes, { action: 'create', title: 'no policy' })
    const id = created.body.tickets[0].id
    await assert.rejects(update.execute({ id, status: 'ready' }, { agent: { id: 'planner-1' } }), /agents cannot move tickets to/)
    await assert.rejects(update.execute({ id, assignee: 'coder-2' }, { agent: { id: 'planner-1' } }), /agents cannot assign tickets/)
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('an independent reviewer records a verdict on a parked ticket', async () => {
  const { routes, tools, cleanups } = await loadPlugin({ workspace: tempDir() })
  try {
    const created = await callAction(routes, { action: 'create', title: 'review me' })
    const id = created.body.tickets[0].id
    const review = findTool(tools, 'board_review')
    await assert.rejects(review.execute({ id, verdict: 'approved' }, { agent: { id: 'reviewer-1' } }), /reviews are accepted only at/)
    await callAction(routes, { action: 'update', id, status: 'ready' })
    await callAction(routes, { action: 'update', id, status: 'in_progress' })
    await callAction(routes, { action: 'update', id, status: 'in_review' })

    const result = await review.execute({ id, verdict: 'changes_requested', notes: 'add a test' }, { agent: { id: 'reviewer-1' } })
    assert.match(result, /changes_requested/)
    const state = await getState(routes)
    const ticket = state.body.tickets[0]
    assert.equal(ticket.review.verdict, 'changes_requested')
    assert.equal(ticket.review.reviewer, 'reviewer-1')
    assert.equal(ticket.review.notes, 'add a test')
    assert.equal(ticket.status, 'in_review')
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('an opt-in policy can auto-reject a reviewer change request', async () => {
  const agents = defaultAgents()
  const { routes, tools, cleanups } = await loadPlugin({
    workspace: tempDir(),
    services: { agents },
    config: { autonomy: { autoRejectOnChanges: true } },
  })
  try {
    const created = await callAction(routes, { action: 'create', title: 'auto reject me' })
    const id = created.body.tickets[0].id
    await callAction(routes, { action: 'update', id, status: 'ready' })
    await callAction(routes, { action: 'update', id, status: 'in_progress' })
    await callAction(routes, { action: 'update', id, status: 'in_review' })
    const review = findTool(tools, 'board_review')
    const result = await review.execute({ id, verdict: 'changes_requested', notes: 'fix the edge case' }, { agent: { id: 'reviewer-1' } })
    assert.match(result, /rejected automatically/)
    const state = await getState(routes)
    const ticket = state.body.tickets[0]
    assert.equal(ticket.review, null)
    assert.ok((ticket.runs ?? []).length >= 1, 'reject resumed the worker with a new run')
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('the default assignee is applied when a plan is approved', async () => {
  const { routes, tools, cleanups } = await loadPlugin({
    workspace: tempDir(),
    config: { autonomy: { defaultAssignee: 'worker-1' } },
  })
  try {
    const created = await callAction(routes, { action: 'create', title: 'auto assigned' })
    const id = created.body.tickets[0].id
    const started = await callAction(routes, { action: 'plan-start', id })
    const submit = findTool(tools, 'board_submit_plan')
    await submit.execute(
      { id, markdown: '# plan', decomposition: JSON.stringify([{ title: 'half one' }, { title: 'half two' }]) },
      { agent: { id: started.body.planSessionId } },
    )
    const approved = await callAction(routes, { action: 'plan-approve', id })
    assert.equal(approved.status, 200)
    const parent = approved.body.tickets.find(ticket => ticket.id === id)
    assert.equal(parent.assignee, 'worker-1')
    const children = approved.body.tickets.filter(ticket => ticket.parentId === id)
    assert.equal(children.length, 2)
    assert.equal(children.every(ticket => ticket.assignee === 'worker-1'), true)
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('batch actions run per ticket and report individual failures', async () => {
  const { routes, cleanups } = await loadPlugin({ workspace: tempDir() })
  try {
    const make = async title => (await callAction(routes, { action: 'create', title })).body.tickets.find(ticket => ticket.title === title)
    const a = await make('batch a')
    const b = await make('batch b')
    const c = await make('batch c')

    const assigned = await callAction(routes, { action: 'batch', op: 'assign', ids: [a.id, b.id], assignee: 'coder-9' })
    assert.equal(assigned.status, 200)
    assert.equal(assigned.body.batch.every(result => result.ok), true)
    assert.equal(assigned.body.tickets.find(ticket => ticket.id === a.id).assignee, 'coder-9')
    assert.equal(assigned.body.tickets.find(ticket => ticket.id === b.id).assignee, 'coder-9')

    const archived = await callAction(routes, { action: 'batch', op: 'archive', ids: [c.id] })
    assert.equal(archived.body.tickets.find(ticket => ticket.id === c.id).archivedAt !== null, true)

    const approveFailure = await callAction(routes, { action: 'batch', op: 'approve', ids: [a.id] })
    assert.equal(approveFailure.body.batch[0].ok, false)
    assert.match(approveFailure.body.batch[0].error, /only tickets in/)

    const unknown = await callAction(routes, { action: 'batch', op: 'nope', ids: [a.id] })
    assert.equal(unknown.body.batch[0].ok, false)
    assert.match(unknown.body.batch[0].error, /unknown batch op/)

    const capped = await callAction(routes, {
      action: 'batch',
      op: 'assign',
      ids: Array.from({ length: 60 }, (_, index) => 'missing-' + index),
      assignee: 'x',
    })
    assert.equal(capped.body.batch.length, 50)
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('webhooks receive new notifications with an HMAC signature', async () => {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (calls.length <= 2) return new Response('boom', { status: 500 })
    return new Response('ok', { status: 200 })
  }
  const { routes, tools, cleanups } = await loadPlugin({
    workspace: tempDir(),
    config: { webhooks: [{ url: 'http://hook.test/board', secret: 's3cret', retries: 2 }, { url: 'not-a-url' }] },
  })
  try {
    const created = await callAction(routes, { action: 'create', title: 'webhook me' })
    const id = created.body.tickets[0].id
    const started = await callAction(routes, { action: 'plan-start', id })
    const submit = findTool(tools, 'board_submit_plan')
    await submit.execute({ id, markdown: '# plan' }, { agent: { id: started.body.planSessionId } })
    await waitFor(() => calls.length >= 3)
    assert.equal(calls.length, 3)
    const delivered = calls.find(call => call.url === 'http://hook.test/board')
    const payload = JSON.parse(calls[2].init.body)
    assert.match(payload.text, /plan_review/)
    assert.match(payload.text, /B-1/)
    assert.match(calls[2].init.headers['x-board-signature'], /^sha256=[0-9a-f]{64}$/)
    assert.ok(delivered)
    const state = await getState(routes)
    const entry = state.body.board.webhookLog.find(item => item.ok)
    assert.equal(entry.attempts, 3)
  } finally {
    globalThis.fetch = originalFetch
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('a storage warning is surfaced through the state route', async () => {
  const dataDir = tempDir()
  writeFileSync(join(dataDir, 'board.json'), '{"tickets": [')
  writeFileSync(
    join(dataDir, 'board.json.bak'),
    JSON.stringify({ version: 1, board: { name: 'Recovered' }, nextKey: 2, tickets: [{ id: 't-1', key: 'B-1', title: 'kept', status: 'backlog', activity: [] }] }),
  )
  const { routes, cleanups } = await loadPlugin({ workspace: tempDir(), dataDir })
  try {
    const state = await getState(routes)
    assert.match(state.body.board.warning, /unreadable/)
    assert.equal(state.body.tickets[0].title, 'kept')
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('cancel then retry through the action route settles before responding', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { routes, cleanups } = await loadPlugin({ workspace: tempDir(), services: { agents } })
  try {
    const created = await callAction(routes, { action: 'create', title: 'retry me' })
    const ticket = created.body.tickets[0]
    await callAction(routes, { action: 'assign', id: ticket.id, assignee: 'coder' })
    await callAction(routes, { action: 'update', id: ticket.id, status: 'ready' })
    await waitFor(async () => {
      const state = await getState(routes)
      return state.body.tickets.find(item => item.id === ticket.id)?.runs.at(-1)?.status === 'running'
    })
    const cancelled = await callAction(routes, { action: 'cancel', id: ticket.id })
    assert.equal(cancelled.status, 200)
    assert.equal(cancelled.body.tickets.find(item => item.id === ticket.id).status, 'blocked')

    const retried = await callAction(routes, { action: 'retry', id: ticket.id })
    assert.equal(retried.status, 200)
    const after = retried.body.tickets.find(item => item.id === ticket.id)
    assert.equal(after.status, 'in_progress')
    assert.equal(after.runs.length, 2)
  } finally {
    idle.resolve()
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('a rejected controller action answers with the error message instead of an unhandled rejection', async () => {
  const { routes, cleanups } = await loadPlugin({ workspace: tempDir() })
  try {
    const created = await callAction(routes, { action: 'create', title: 'not reviewable' })
    const ticket = created.body.tickets[0]
    const response = await callAction(routes, { action: 'approve', id: ticket.id })
    assert.equal(response.status, 400)
    assert.match(response.body.error, /only tickets in In Review can be approved/)
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('the transcript route parses board-owned session logs and rejects foreign sessions', async () => {
  const dir = tempDir()
  const store = createBoardStore({ file: join(dir, 'board.json') })
  const ticket = store.createTicket({ title: 'transcript ticket' })
  store.addRun(ticket, { status: 'running', sessionId: 'session-transcript' })
  store.save()

  const sessionsDir = tempDir()
  const sessionDir = join(sessionsDir, '--test--', 'session-transcript')
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(
    join(sessionDir, 'session.v4.jsonl'),
    [
      JSON.stringify({ type: 'user/message', time: 1, data: { content: [{ type: 'text', text: 'build the widget' }] } }),
      JSON.stringify({ type: 'user/message', time: 2, data: { content: [{ type: 'text', text: 'Current runtime context. skip me' }] } }),
      JSON.stringify({
        type: 'assistant/message',
        time: 3,
        data: { message: { content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'on it' }] } },
      }),
      JSON.stringify({ type: 'tool/call', time: 4, data: { name: 'shell' } }),
    ].join('\n'),
  )

  const { routes, cleanups } = await loadPlugin({ dataDir: dir, workspace: tempDir(), config: { sessionsDir } })
  try {
    const route = routes.find(item => item.path === '/api/board/transcript')
    const response = await route.fetch(new Request('http://board.test/api/board/transcript?sessionId=session-transcript'))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.messages.map(message => message.role), ['user', 'assistant', 'tool'])
    assert.equal(body.messages[0].text, 'build the widget')
    assert.equal(body.messages[1].text, 'on it')
    assert.equal(body.truncated, false)

    const foreign = await route.fetch(new Request('http://board.test/api/board/transcript?sessionId=session-foreign'))
    assert.equal(foreign.status, 404)
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('board_team_task publishes a ticket to Agent Teams', async () => {
  const calls = []
  const agentTeams = {
    async createTask(caller, request) {
      calls.push({ caller, request })
      return { id: 'T-1', revision: 1, subject: request.subject }
    },
    getTask() {
      return { id: 'T-1', revision: 2, status: 'claimed', ownerName: 'teammate-1' }
    },
  }
  const { routes, tools, cleanups } = await loadPlugin({ workspace: tempDir(), services: { agentTeams } })
  try {
    const created = await callAction(routes, { action: 'create', title: 'team publish' })
    const id = created.body.tickets[0].id
    const publish = findTool(tools, 'board_team_task')
    const result = await publish.execute({ id }, { agent: { id: 'agent-1', session: { id: 'session-1' } } })
    assert.match(result, /team task T-1/)
    assert.equal(calls.length, 1)
    assert.match(calls[0].request.subject, /B-1: team publish/)
    const ticket = await getTicket(routes, id)
    assert.equal(ticket.body.ticket.teamTaskId, 'T-1')
    assert.equal(ticket.body.ticket.teamTaskRevision, 1)

    const sync = findTool(tools, 'board_team_sync')
    const synced = await sync.execute({ id }, { agent: { id: 'agent-1', session: { id: 'session-1' } } })
    assert.match(synced, /Synced B-1/)
    const afterSync = await getTicket(routes, id)
    assert.equal(afterSync.body.ticket.assignee, 'teammate-1')
    assert.equal(afterSync.body.ticket.teamTaskRevision, 2)
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('a reviewer session is cancelled when its token budget is exceeded', async () => {
  const agents = defaultAgents()
  const tokenMeter = { measure: () => ({ totalTokens: 50 }) }
  const { routes, cleanups } = await loadPlugin({
    workspace: tempDir(),
    services: { agents, tokenMeter },
    config: { autonomy: { reviewerPreset: 'standard', reviewerTokenBudget: 10, reviewerBudgetCheckMs: 20 } },
  })
  try {
    const created = await callAction(routes, { action: 'create', title: 'budgeted review' })
    const id = created.body.tickets[0].id
    await callAction(routes, { action: 'update', id, status: 'ready' })
    await callAction(routes, { action: 'update', id, status: 'in_progress' })
    await callAction(routes, { action: 'update', id, status: 'in_review' })
    await waitFor(() => agents.handles[0] && agents.handles[0].agent.cancels.length === 1)
    const state = await getState(routes)
    assert.equal(Boolean(state.body.tickets[0].reviewSessionId), true)
    assert.equal(
      (state.body.notifications ?? []).some(item => item.kind === 'reviewer_budget'),
      true,
      'the budget stop is recorded in the inbox',
    )
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('auto-merge completes a trusted, reviewer-approved ticket', async () => {
  const repo = gitRepo()
  const dir = tempDir()
  const store = createBoardStore({ file: join(dir, 'board.json') })
  const ticket = store.createTicket({ title: 'auto merge me', assignee: 'coder' })
  store.updateTicket({ id: ticket.id, status: 'ready' })
  store.updateTicket({ id: ticket.id, status: 'in_progress' })
  const worktree = addWorktree(repo, 'board/auto-merge')
  commitIn(repo, worktree.path, { 'auto.txt': 'merged content\n' })
  const run = store.addRun(ticket, { status: 'awaiting_review', sessionId: 'session-auto' })
  store.patchRun(run, { worktree })
  store.updateTicket({ id: ticket.id, status: 'in_review' })
  store.updateTicket({ id: ticket.id, checks: 'unit :: echo ok' })
  store.save()

  const { routes, tools, cleanups } = await loadPlugin({
    dataDir: dir,
    workspace: repo.dir,
    services: { shell: fakeShell() },
    config: { autonomy: { autoMerge: true } },
  })
  try {
    const review = findTool(tools, 'board_review')
    const result = await review.execute({ id: ticket.id, verdict: 'approved', notes: 'looks good' }, { agent: { id: 'reviewer-9' } })
    assert.match(result, /merged automatically/)
    const state = await getState(routes)
    const done = state.body.tickets[0]
    assert.equal(done.status, 'done')
    assert.ok(done.runs.at(-1).merge, 'the merge is recorded on the run')
    assert.equal(done.checks[0].source, 'human')
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('board_team_sync completes the shared team task when the ticket is done', async () => {
  const updates = []
  const agentTeams = {
    getTask() {
      return { id: 'T-2', revision: 1, status: 'in_progress', ownerName: 'teammate-2' }
    },
    async updateTask(caller, request) {
      updates.push({ caller, request })
      return { id: 'T-2', revision: 2, status: 'completed', ownerName: 'teammate-2' }
    },
  }
  const dir = tempDir()
  const store = createBoardStore({ file: join(dir, 'board.json') })
  const seeded = store.createTicket({ title: 'team complete', assignee: 'coder' })
  store.updateTicket({ id: seeded.id, status: 'done' })
  store.setTeamTask(seeded.id, { id: 'T-2', revision: 1 })
  store.save()

  const { tools, cleanups } = await loadPlugin({ dataDir: dir, workspace: tempDir(), services: { agentTeams } })
  try {
    const sync = findTool(tools, 'board_team_sync')
    const result = await sync.execute({ id: seeded.id }, { agent: { id: 'agent-1', session: { id: 'session-1' } } })
    assert.match(result, /team task completed/)
    assert.equal(updates.length, 1)
    assert.deepEqual(updates[0].request, { taskId: 'T-2', expectedRevision: 1, action: 'complete' })
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})
