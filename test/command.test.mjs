/**
 * `/board` intake command tests.
 *
 * The command is host-side: it creates a ticket, binds the invoking chat
 * session as the ticket's planning session, and wakes the agent to brainstorm.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callAction, defaultAgents, findTool, getState, loadPlugin, tempDir, waitFor } from './helpers.mjs'

function chatAgent(id = 'session-chat-1') {
  return {
    id,
    session: { id },
    followups: [],
    followup(message) {
      this.followups.push(message)
    },
  }
}

test('/board creates a ticket, binds this session, and wakes the planner agent', async () => {
  const { commands, tools, routes, cleanups } = await loadPlugin({ workspace: tempDir() })
  try {
    const board = commands.find(definition => definition.name === 'board')
    assert.ok(board, '/board must be registered')
    assert.match(board.description, /board ticket/i)

    const agent = chatAgent()
    const result = await board.handler({ agent, rawInput: 'add a health endpoint to the checkout API', attachments: [], signal: new AbortController().signal, commandId: 'c1' })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /Created B-1/)

    const state = await getState(routes)
    const ticket = state.body.tickets.find(item => item.key === 'B-1')
    assert.equal(ticket.status, 'backlog')
    assert.equal(ticket.title, 'add a health endpoint to the checkout API')
    assert.equal(ticket.description, 'add a health endpoint to the checkout API')
    assert.equal(ticket.plan.sessionId, 'session-chat-1')
    assert.equal(ticket.plan.status, 'draft')

    assert.equal(agent.followups.length, 1)
    const brief = JSON.stringify(agent.followups[0])
    assert.match(brief, /B-1/)
    assert.match(brief, /board_submit_plan/)

    // A plan submitted from that same chat session is accepted.
    const submit = findTool(tools, 'board_submit_plan')
    await submit.execute(
      {
        id: 'B-1',
        markdown: '# Plan\nShip a health endpoint.',
        acceptance: 'GET /health returns ok',
        checks: 'unit :: echo ok',
      },
      { agent: { id: 'session-chat-1', session: { id: 'session-chat-1' } } },
    )
    const approved = await callAction(routes, { action: 'plan-approve', id: 'B-1' })
    assert.equal(approved.status, 200)
    const planned = approved.body.tickets.find(item => item.key === 'B-1')
    assert.equal(planned.plan.status, 'approved')
    assert.deepEqual(planned.acceptance, ['GET /health returns ok'])
    assert.equal(planned.checks[0].name, 'unit')
    assert.equal(planned.status, 'ready')
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('plan review raises an inbox notification that /board notifications clears', async () => {
  const { commands, routes, tools, cleanups } = await loadPlugin({ workspace: tempDir() })
  try {
    const board = commands.find(definition => definition.name === 'board')
    const agent = chatAgent('session-chat-inbox')
    const invocation = rawInput => ({ agent, rawInput, attachments: [], signal: new AbortController().signal, commandId: 'ci' })
    await board.handler(invocation('build the inbox'))
    const created = await getState(routes)
    const id = created.body.tickets[0].id
    const started = await callAction(routes, { action: 'plan-start', id })
    const sessionId = started.body.planSessionId
    const submit = findTool(tools, 'board_submit_plan')
    await submit.execute({ id, markdown: '# plan' }, { agent: { id: sessionId } })

    const inbox = await board.handler(invocation('notifications'))
    assert.equal(inbox.kind, 'success')
    assert.match(inbox.text, /plan_review/)
    const marked = await callAction(routes, { action: 'notifications-read' })
    assert.equal(marked.status, 200)
    assert.equal(marked.body.board.unreadNotifications, 0)
    const again = await board.handler(invocation('notifications'))
    assert.equal(again.text, 'Inbox empty.')
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('a reviewer session opens automatically when a run reaches the gate', async () => {
  const agents = defaultAgents()
  const { routes, cleanups } = await loadPlugin({
    workspace: tempDir(),
    services: { agents },
    config: { autonomy: { reviewerPreset: 'standard' } },
  })
  try {
    const created = await callAction(routes, { action: 'create', title: 'needs a reviewer' })
    const id = created.body.tickets[0].id
    await callAction(routes, { action: 'update', id, status: 'ready' })
    await callAction(routes, { action: 'update', id, status: 'in_progress' })
    await callAction(routes, { action: 'update', id, status: 'in_review' })
    await waitFor(async () => Boolean((await getState(routes)).body.tickets[0].reviewSessionId))
    const state = await getState(routes)
    assert.ok(state.body.tickets[0].reviewSessionId)
    assert.equal(agents.created.length, 1)
    const brief = JSON.stringify(agents.handles[0].agent.followups.at(-1))
    assert.match(brief, /board_review/)
    assert.match(brief, /needs a reviewer/)
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('/board list, show and approve work from the chat', async () => {
  const { commands, tools, routes, cleanups } = await loadPlugin({ workspace: tempDir() })
  try {
    const board = commands.find(definition => definition.name === 'board')
    const agent = chatAgent('session-chat-3')
    const invocation = rawInput => ({ agent, rawInput, attachments: [], signal: new AbortController().signal, commandId: 'c3' })
    await board.handler(invocation('ship the export button'))

    const list = await board.handler(invocation('list'))
    assert.equal(list.kind, 'success')
    assert.match(list.text, /B-1/)
    assert.match(list.text, /ship the export button/)

    const show = await board.handler(invocation('show B-1'))
    assert.equal(show.kind, 'success')
    assert.match(show.text, /B-1 — ship the export button/)
    assert.match(show.text, /plan: v0 draft/)

    assert.equal((await board.handler(invocation('approve B-1'))).kind, 'error')
    const submit = findTool(tools, 'board_submit_plan')
    await submit.execute({ id: 'B-1', markdown: '# Plan\nBuild it.' }, { agent: { id: 'session-chat-3' } })
    const approved = await board.handler(invocation('approve B-1'))
    assert.equal(approved.kind, 'success')
    assert.match(approved.text, /Approved B-1/)
    const state = await getState(routes)
    assert.equal(state.body.tickets[0].plan.status, 'approved')
    assert.equal((await board.handler(invocation('show NOPE-9'))).kind, 'error')
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})

test('bare /board creates a placeholder ticket and another session cannot submit its plan', async () => {
  const { commands, tools, routes, cleanups } = await loadPlugin({ workspace: tempDir() })
  try {
    const board = commands.find(definition => definition.name === 'board')
    const agent = chatAgent('session-chat-2')
    const result = await board.handler({ agent, rawInput: '   ', attachments: [], signal: new AbortController().signal, commandId: 'c2' })
    assert.equal(result.kind, 'success')
    const state = await getState(routes)
    const ticket = state.body.tickets.find(item => item.key === 'B-1')
    assert.equal(ticket.title, 'Untitled board work')
    assert.equal(ticket.plan.sessionId, 'session-chat-2')

    const submit = findTool(tools, 'board_submit_plan')
    await assert.rejects(
      submit.execute({ id: 'B-1', markdown: '# nope' }, { agent: { id: 'session-other', session: { id: 'session-other' } } }),
      /only the planning session/,
    )
  } finally {
    for (const cleanup of cleanups) await cleanup?.()
  }
})
