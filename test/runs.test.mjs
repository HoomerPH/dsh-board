/**
 * Run-controller tests (Slice 0 items 0.3–0.10): merge safety, gate serialization,
 * worker lifecycle and failure containment. No model calls: workers are fake
 * agents, merges run against real throwaway Git repositories.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { addWorktree, commitIn, defaultAgents, deferred, delay, fakeShell, gitRepo, makeBoard, tempDir, waitFor } from './helpers.mjs'
import { createBoardStore } from '../lib/store.js'
import { createRunController } from '../lib/runs.js'

/** Create a ticket parked at the review gate with a real worktree that has one commit. */
function seedGateRun(repo, store, { title = 'ticket', file = 'work.txt', branch }) {
  const ticket = store.createTicket({ title, assignee: 'coder' })
  store.updateTicket({ id: ticket.id, status: 'ready' })
  store.updateTicket({ id: ticket.id, status: 'in_progress' })
  const worktree = addWorktree(repo, branch)
  commitIn(repo, worktree.path, { [file]: `content of ${file}\n` })
  const run = store.addRun(ticket, { status: 'awaiting_review', sessionId: 'session-1' })
  store.patchRun(run, { worktree })
  store.updateTicket({ id: ticket.id, status: 'in_review' })
  return { ticket, run, worktree }
}

function startAgentRun(store, ticket) {
  store.updateTicket({ id: ticket.id, status: 'ready' })
}

test('approval squash-merges into the branch the run started from and cleans up', async () => {
  const repo = gitRepo()
  const { store, runs } = await makeBoard({ repo })
  const { ticket, run, worktree } = seedGateRun(repo, store, { branch: 'board/b-1' })

  await runs.approve(ticket.id)
  assert.equal(store.find(ticket.id).status, 'done')
  assert.equal(run.status, 'approved')
  assert.ok(run.merge?.short)
  assert.equal(run.merge.baseBranch, 'master')
  assert.equal(repo.git(['branch', '--list', worktree.branch]), '')
  assert.ok(repo.git(['log', '--oneline', '-1']).includes('B-1'))
  assert.equal(store.find(ticket.id).currentRunId, null)
})

test('approval refuses when the base checkout is on a different branch', async () => {
  const repo = gitRepo()
  const { store, runs } = await makeBoard({ repo })
  const { ticket, worktree } = seedGateRun(repo, store, { branch: 'board/b-2' })
  repo.git(['checkout', '-q', '-b', 'release'])

  await assert.rejects(runs.approve(ticket.id), /is on "release" but this run started from "master"/)
  assert.equal(store.find(ticket.id).status, 'in_review')
  assert.notEqual(repo.git(['branch', '--list', worktree.branch]), '')
  assert.equal(repo.git(['log', '--oneline', '-1']).includes('B-2'), false)
})

test('approval refuses when the base branch no longer contains the run base commit', async () => {
  const repo = gitRepo()
  writeFileSync(join(repo.dir, 'second.txt'), 'second\n')
  repo.git(['add', '-A'])
  repo.git(['commit', '-qm', 'second base commit'])
  const { store, runs } = await makeBoard({ repo })
  const { ticket } = seedGateRun(repo, store, { branch: 'board/b-3' })
  repo.git(['reset', '--hard', 'HEAD~1'])

  await assert.rejects(runs.approve(ticket.id), /no longer contains/)
  assert.equal(store.find(ticket.id).status, 'in_review')
})

test('approval accepts a base that advanced with normal commits', async () => {
  const repo = gitRepo()
  const { store, runs } = await makeBoard({ repo })
  const { ticket } = seedGateRun(repo, store, { branch: 'board/b-4' })
  writeFileSync(join(repo.dir, 'later.txt'), 'later\n')
  repo.git(['add', '-A'])
  repo.git(['commit', '-qm', 'advance base'])

  await runs.approve(ticket.id)
  assert.equal(store.find(ticket.id).status, 'done')
  assert.ok(repo.git(['log', '--oneline', '-1']).includes('B-1'))
})

test('concurrent approvals serialize and never mix their files', async () => {
  const repo = gitRepo()
  const { store, runs } = await makeBoard({ repo })
  const first = seedGateRun(repo, store, { title: 'first', file: 'one.txt', branch: 'board/b-5' })
  const second = seedGateRun(repo, store, { title: 'second', file: 'two.txt', branch: 'board/b-6' })

  await Promise.all([runs.approve(first.ticket.id), runs.approve(second.ticket.id)])

  assert.equal(store.find(first.ticket.id).status, 'done')
  assert.equal(store.find(second.ticket.id).status, 'done')
  const log = repo.git(['log', '--format=%H %s']).split('\n')
  for (const [key, file] of [
    ['B-1', 'one.txt'],
    ['B-2', 'two.txt'],
  ]) {
    const commit = log.find(line => line.includes(`${key}:`))
    assert.ok(commit, `expected a squash commit for ${key}`)
    const sha = commit.split(' ')[0]
    const files = repo.git(['show', '--name-only', '--format=', sha]).split('\n').filter(Boolean)
    assert.deepEqual(files, [file], `${key} must merge exactly its own file`)
  }
})

test('a failed squash commit rolls the index back and preserves user work', async () => {
  const repo = gitRepo()
  const { store, runs } = await makeBoard({ repo })
  const { ticket } = seedGateRun(repo, store, { branch: 'board/b-7' })
  // The hook runs after the squash is staged, inside the approval window, and
  // edits a TRACKED file: `git reset --hard` would discard it, `--merge` keeps it.
  writeFileSync(
    join(repo.dir, '.git', 'hooks', 'pre-commit'),
    '#!/bin/sh\nprintf "user notes\\n" > notes.txt\nprintf "edited inside the approval window\\n" > README.md\nexit 1\n',
    { mode: 0o755 },
  )
  const headBefore = repo.git(['rev-parse', 'HEAD'])

  await assert.rejects(runs.approve(ticket.id), /squash commit failed/)
  assert.equal(store.find(ticket.id).status, 'in_review')
  assert.deepEqual(
    repo.git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean),
    [],
    'the index must be rolled back',
  )
  assert.equal(repo.git(['rev-parse', 'HEAD']), headBefore)
  assert.equal(repo.git(['show', '--name-only', '--format=', 'HEAD']).includes('work.txt'), false)
  assert.match(repo.git(['status', '--porcelain']), /M README\.md/, 'a tracked edit must survive the rollback')
  assert.equal(repo.git(['status', '--porcelain']).split('\n').includes('?? notes.txt'), true)
  assert.match(readFileSync(join(repo.dir, 'README.md'), 'utf8'), /edited inside the approval window/)
  assert.equal(repo.git(['log', '--format=%s']).includes('B-1:'), false)
})

test('a run that cannot name its base branch is refused rather than guessed', async () => {
  const repo = gitRepo()
  const { store, runs } = await makeBoard({ repo })
  const { ticket } = seedGateRun(repo, store, { branch: 'board/b-8' })
  const run = store.currentRun(store.find(ticket.id))
  delete run.worktree.baseBranch

  await assert.rejects(runs.approve(ticket.id), /does not record which branch/)
  assert.equal(store.find(ticket.id).status, 'in_review')
})

test('approval refuses while the worker is still running', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { store, runs } = await makeBoard({ repo: gitRepo(), services: { agents } })
  const ticket = store.createTicket({ title: 'running', assignee: 'coder' })
  startAgentRun(store, ticket)
  await runs.start(ticket.id)
  await waitFor(() => runs.active.get(ticket.id)?.phase === 'running')

  await assert.rejects(runs.approve(ticket.id), /still running/)
  idle.resolve()
  await waitFor(() => runs.active.size === 0)
  await runs.dispose()
})

test('rejection refuses while the worker is still running', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { store, runs } = await makeBoard({ repo: gitRepo(), services: { agents } })
  const ticket = store.createTicket({ title: 'running', assignee: 'coder' })
  startAgentRun(store, ticket)
  await runs.start(ticket.id)
  await waitFor(() => runs.active.get(ticket.id)?.phase === 'running')

  await assert.rejects(runs.reject(ticket.id, 'try again'), /still running/)
  idle.resolve()
  await waitFor(() => runs.active.size === 0)
  await runs.dispose()
})

test('a ticket parked at the gate releases its agent and frees the slot', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { store, runs } = await makeBoard({ repo: gitRepo(), services: { agents }, config: { maxWorkers: 1 } })
  const ticket = store.createTicket({ title: 'parked', assignee: 'coder' })
  startAgentRun(store, ticket)
  await runs.start(ticket.id)
  await waitFor(() => runs.active.get(ticket.id)?.phase === 'running')
  store.updateTicket({ id: ticket.id, status: 'in_review' })
  idle.resolve()

  await waitFor(() => store.find(ticket.id).status === 'in_review' && runs.active.size === 0)
  const run = store.currentRun(store.find(ticket.id))
  assert.equal(run.status, 'awaiting_review')
  assert.equal(agents.handles[0].disposed, true)
  assert.equal(runs.runningCount(), 0)
  await runs.dispose()
})

test('cancelling while a worker session is being created does not resurrect the run', async () => {
  const pending = deferred()
  const agents = { create: () => pending.promise, resume: () => pending.promise }
  const { store, runs } = await makeBoard({ repo: gitRepo(), services: { agents } })
  const ticket = store.createTicket({ title: 'slow create', assignee: 'coder' })
  startAgentRun(store, ticket)
  await runs.start(ticket.id)
  await waitFor(() => runs.active.get(ticket.id)?.phase === 'starting')

  await runs.cancel(ticket.id, 'human')
  const handle = {
    agent: {
      id: 'late-agent',
      session: { id: 'late' },
      followups: [],
      followup(message) {
        this.followups.push(message)
      },
      whenIdle: () => Promise.resolve(),
      cancel() {},
    },
    disposed: false,
    async dispose() {
      this.disposed = true
    },
  }
  pending.resolve(handle)

  await waitFor(() => handle.disposed && runs.active.size === 0)
  const run = store.find(ticket.id).runs.at(-1)
  assert.equal(run.status, 'cancelled')
  assert.equal(handle.agent.followups.length, 0, 'a cancelled run must not be driven')
  assert.equal(runs.runningCount(), 0)
  await runs.dispose()
})

test('a failed save during cancel still frees the worker slot', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { store, runs } = await makeBoard({ repo: gitRepo(), services: { agents }, config: { maxWorkers: 1 } })
  const ticket = store.createTicket({ title: 'disk full', assignee: 'coder' })
  startAgentRun(store, ticket)
  await runs.start(ticket.id)
  await waitFor(() => runs.active.get(ticket.id)?.phase === 'running')
  const originalSave = store.save
  store.save = () => {
    throw new Error('ENOSPC: no space left on device')
  }
  try {
    await assert.rejects(runs.cancel(ticket.id), /ENOSPC/)
  } finally {
    store.save = originalSave
  }
  assert.equal(runs.runningCount(), 0)
  assert.equal(runs.active.size, 0)
  idle.resolve()
  await runs.dispose()
})

test('a failing turn is recorded without an unhandled rejection even when its save fails', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { store, runs } = await makeBoard({ repo: gitRepo(), services: { agents } })
  const ticket = store.createTicket({ title: 'boom', assignee: 'coder' })
  startAgentRun(store, ticket)
  await runs.start(ticket.id)
  await waitFor(() => runs.active.get(ticket.id)?.phase === 'running')

  const unhandled = []
  const onUnhandled = reason => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  const originalSave = store.save
  store.save = () => {
    throw new Error('ENOSPC: no space left on device')
  }
  try {
    idle.reject(new Error('model exploded'))
    await waitFor(() => store.find(ticket.id).status === 'blocked' && runs.active.size === 0)
    await new Promise(resolve => setTimeout(resolve, 50))
  } finally {
    store.save = originalSave
    process.off('unhandledRejection', onUnhandled)
  }
  assert.deepEqual(unhandled, [])
  assert.equal(store.find(ticket.id).status, 'blocked')
  assert.match(store.find(ticket.id).runs[0].reason, /model exploded/)
  await runs.dispose()
})

test('worktrees can be disabled by configuration', async () => {
  const spy = { calls: 0, async create() { this.calls += 1; throw new Error('should not be called') } }
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { store, runs } = await makeBoard({ repo: gitRepo(), services: { agents, worktrees: spy }, config: { worktrees: false } })
  const ticket = store.createTicket({ title: 'shared checkout', assignee: 'coder' })
  startAgentRun(store, ticket)
  await runs.start(ticket.id)
  await waitFor(() => runs.active.get(ticket.id)?.phase === 'running')
  assert.equal(spy.calls, 0)
  assert.equal(store.find(ticket.id).runs[0].worktree, undefined)
  idle.resolve()
  await waitFor(() => runs.active.size === 0)
  await runs.dispose()
})

test('extra ready tickets wait in the queue and are reported', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { store, runs } = await makeBoard({ repo: gitRepo(), services: { agents }, config: { maxWorkers: 1 } })
  const first = store.createTicket({ title: 'first', assignee: 'coder' })
  const second = store.createTicket({ title: 'second', assignee: 'coder' })
  for (const ticket of [first, second]) startAgentRun(store, ticket)

  await runs.start(first.id)
  await runs.start(second.id)
  await waitFor(() => runs.active.get(first.id)?.phase === 'running')
  assert.equal(runs.queued().length, 1)
  assert.equal(runs.queued()[0], second.id)
  idle.resolve()
  await waitFor(() => store.find(second.id).status === 'in_progress' || store.find(second.id).status === 'in_review')
  await runs.dispose()
})

test('a blocked ticket can be retried into a fresh run', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { store, runs } = await makeBoard({ repo: gitRepo(), services: { agents } })
  const ticket = store.createTicket({ title: 'retry me', assignee: 'coder' })
  startAgentRun(store, ticket)
  await runs.start(ticket.id)
  await waitFor(() => runs.active.get(ticket.id)?.phase === 'running')
  await runs.cancel(ticket.id)
  assert.equal(store.find(ticket.id).status, 'blocked')

  await runs.retry(ticket.id)
  assert.equal(store.find(ticket.id).status, 'in_progress')
  assert.equal(store.find(ticket.id).runs.length, 2)
  idle.resolve()
  await waitFor(() => runs.active.size === 0)
  await runs.dispose()
})

test('a save failure while dispatching does not crash the pump', async () => {
  const agents = defaultAgents()
  const { store, runs } = await makeBoard({ repo: gitRepo(), services: { agents } })
  const ticket = store.createTicket({ title: 'dispatch', assignee: 'coder' })
  startAgentRun(store, ticket)
  const originalSave = store.save
  store.save = () => {
    throw new Error('ENOSPC: no space left on device')
  }
  try {
    assert.doesNotThrow(() => runs.pump())
  } finally {
    store.save = originalSave
  }
  // The ticket stays dispatchable and a later pump recovers.
  assert.equal(runs.active.size, 0)
  runs.pump()
  await waitFor(() => runs.active.get(ticket.id)?.phase === 'running' || store.find(ticket.id).runs.length > 0)
  await runs.dispose()
})

test('cancelling a ticket at the review gate is refused (Reject closes it)', async () => {
  const repo = gitRepo()
  const { store, runs } = await makeBoard({ repo })
  const { ticket, worktree } = seedGateRun(repo, store, { branch: 'board/b-9' })

  await assert.rejects(runs.cancel(ticket.id, 'human'), /closed with Reject/)
  assert.equal(store.find(ticket.id).status, 'in_review')
  assert.notEqual(repo.git(['branch', '--list', worktree.branch]), '')
})

test('a ticket the worker moved to blocked can be retried', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { store, runs } = await makeBoard({ repo: gitRepo(), services: { agents } })
  const ticket = store.createTicket({ title: 'worker gives up', assignee: 'coder' })
  startAgentRun(store, ticket)
  await runs.start(ticket.id)
  await waitFor(() => runs.active.get(ticket.id)?.phase === 'running')
  store.updateTicket({ id: ticket.id, status: 'blocked' })
  idle.resolve()

  await waitFor(() => store.find(ticket.id).status === 'blocked' && runs.active.size === 0)
  const run = store.find(ticket.id).runs.at(-1)
  assert.equal(run.status, 'blocked')
  assert.equal(store.find(ticket.id).currentRunId, null, 'a settled blocked run must release the ticket')

  await runs.retry(ticket.id)
  assert.equal(store.find(ticket.id).status, 'in_progress')
  assert.equal(store.find(ticket.id).runs.length, 2)
  await runs.dispose()
})

test('an approval whose record write failed is completed by retrying, exactly once', async () => {
  const repo = gitRepo()
  const { store, runs } = await makeBoard({ repo })
  const { ticket } = seedGateRun(repo, store, { branch: 'board/b-10' })
  const originalSave = store.save.bind(store)
  let failuresLeft = 1
  store.save = () => {
    if (failuresLeft > 0) {
      failuresLeft -= 1
      throw new Error('ENOSPC: no space left on device')
    }
    return originalSave()
  }
  try {
    await assert.rejects(runs.approve(ticket.id), /approve again/)
    assert.equal(store.find(ticket.id).status, 'in_review')
    // The squash commit exists, the branch is gone: the retry adopts the commit.
    await runs.approve(ticket.id)
    assert.equal(store.find(ticket.id).status, 'done')
    const run = store.find(ticket.id).runs.at(-1)
    assert.equal(run.merge.recovered, true)
  } finally {
    store.save = originalSave
  }
  const commits = repo.git(['log', '--format=%s']).split('\n').filter(line => line.startsWith('B-1:'))
  assert.equal(commits.length, 1, 'the work must be merged exactly once')
  assert.equal(repo.git(['branch', '--list', 'board/b-10']), '')
})

test('a base rename after the run starts does not block approval', async () => {
  const repo = gitRepo()
  const { store, runs } = await makeBoard({ repo })
  const ticket = store.createTicket({ title: 'renamed base', assignee: 'coder' })
  store.updateTicket({ id: ticket.id, status: 'ready' })
  store.updateTicket({ id: ticket.id, status: 'in_progress' })
  const worktree = addWorktree(repo, 'board/b-11')
  // The run edits README.md under its original name.
  commitIn(repo, worktree.path, { 'README.md': 'run edit\n' })
  // The base renames the tracked file after the run started.
  repo.git(['mv', 'README.md', 'RENAMED.md'])
  repo.git(['commit', '-qm', 'rename on the base'])
  const run = store.addRun(ticket, { status: 'awaiting_review', sessionId: 'session-1' })
  store.patchRun(run, { worktree })
  store.updateTicket({ id: ticket.id, status: 'in_review' })

  await runs.approve(ticket.id)
  assert.equal(store.find(ticket.id).status, 'done')
  assert.match(readFileSync(join(repo.dir, 'RENAMED.md'), 'utf8'), /run edit/)
})

test('a conflicting base is refused and rolled back cleanly', async () => {
  const repo = gitRepo()
  const { store, runs } = await makeBoard({ repo })
  const ticket = store.createTicket({ title: 'conflict', assignee: 'coder' })
  store.updateTicket({ id: ticket.id, status: 'ready' })
  store.updateTicket({ id: ticket.id, status: 'in_progress' })
  const worktree = addWorktree(repo, 'board/b-12')
  commitIn(repo, worktree.path, { 'README.md': 'branch version\n' })
  writeFileSync(join(repo.dir, 'README.md'), 'base version\n')
  repo.git(['add', '-A'])
  repo.git(['commit', '-qm', 'base changes the same file'])
  const run = store.addRun(ticket, { status: 'awaiting_review', sessionId: 'session-1' })
  store.patchRun(run, { worktree })
  store.updateTicket({ id: ticket.id, status: 'in_review' })

  await assert.rejects(runs.approve(ticket.id), /merge of .* failed/)
  assert.equal(store.find(ticket.id).status, 'in_review')
  assert.deepEqual(repo.git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean), [])
  assert.notEqual(repo.git(['branch', '--list', worktree.branch]), '')
})

test('a settled run executes its checks before parking at the gate', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const shell = fakeShell()
  const { store, runs } = await makeBoard({ repo: gitRepo(), services: { agents, shell } })
  const ticket = store.createTicket({ title: 'checked run', assignee: 'coder', checks: 'unit :: npm test' })
  startAgentRun(store, ticket)
  await runs.start(ticket.id)
  await waitFor(() => runs.active.get(ticket.id)?.phase === 'running')
  store.updateTicket({ id: ticket.id, status: 'in_review' })
  idle.resolve()

  await waitFor(() => {
    const run = store.find(ticket.id).runs[0]
    return store.find(ticket.id).status === 'in_review' && run.status === 'awaiting_review' && runs.active.size === 0
  })
  const run = store.find(ticket.id).runs[0]
  assert.equal(run.checks.length, 1)
  assert.equal(run.checks[0].name, 'unit')
  assert.equal(run.checks[0].exitCode, 0)
  assert.equal(shell.calls.length, 1)
  assert.match(shell.calls[0].command, /npm test/)
  assert.ok(store.find(ticket.id).activity.some(event => event.kind === 'checks' && /passed/.test(event.text)))
  await runs.dispose()
})

test('approval is refused while a run is still executing its checks', async () => {
  const shellGate = deferred()
  const shell = fakeShell({ gate: shellGate })
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { store, runs } = await makeBoard({ repo: gitRepo(), services: { agents, shell } })
  const ticket = store.createTicket({ title: 'checking', assignee: 'coder', checks: 'unit :: npm test' })
  startAgentRun(store, ticket)
  await runs.start(ticket.id)
  await waitFor(() => runs.active.get(ticket.id)?.phase === 'running')
  store.updateTicket({ id: ticket.id, status: 'in_review' })
  idle.resolve()

  await waitFor(() => runs.active.get(ticket.id)?.phase === 'checking')
  await assert.rejects(runs.approve(ticket.id), /checks for this run are still running/)
  shellGate.resolve()
  await waitFor(() => store.find(ticket.id).runs[0].status === 'awaiting_review' && runs.active.size === 0)
  await runs.dispose()
})

test('red checks block approval even when the run has no worktree', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const shell = fakeShell({ failures: ['npm test'] })
  const { store, runs } = await makeBoard({ repo: gitRepo(), services: { agents, shell }, config: { worktrees: false } })
  const ticket = store.createTicket({ title: 'shared checkout', assignee: 'coder', checks: 'unit :: npm test' })
  startAgentRun(store, ticket)
  await runs.start(ticket.id)
  await waitFor(() => runs.active.get(ticket.id)?.phase === 'running')
  store.updateTicket({ id: ticket.id, status: 'in_review' })
  idle.resolve()
  await waitFor(() => store.find(ticket.id).runs[0].status === 'awaiting_review' && runs.active.size === 0)

  await assert.rejects(runs.approve(ticket.id), /checks failed \(unit\)/)
  await assert.rejects(runs.approve(ticket.id, 'human', { overrideChecks: true }), /override reason is required/)
  await runs.approve(ticket.id, 'human', { overrideChecks: true, reason: 'shared checkout, tested by hand' })
  const run = store.find(ticket.id).runs[0]
  assert.equal(store.find(ticket.id).status, 'done')
  assert.equal(run.checks[0].exitCode, 1)
  assert.equal(run.checksOverridden.reason, 'shared checkout, tested by hand')
  await runs.dispose()
})

test('a check killed by a signal is a failure, not a pass', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const shell = fakeShell({ kills: ['npm test'] })
  const { store, runs } = await makeBoard({ repo: gitRepo(), services: { agents, shell }, config: { worktrees: false } })
  const ticket = store.createTicket({ title: 'killed check', assignee: 'coder', checks: 'unit :: npm test' })
  startAgentRun(store, ticket)
  await runs.start(ticket.id)
  await waitFor(() => runs.active.get(ticket.id)?.phase === 'running')
  store.updateTicket({ id: ticket.id, status: 'in_review' })
  idle.resolve()
  await waitFor(() => store.find(ticket.id).runs[0].status === 'awaiting_review' && runs.active.size === 0)

  await assert.rejects(runs.approve(ticket.id), /checks failed \(unit\)/)
  assert.equal(store.find(ticket.id).runs[0].checks[0].signal, 'SIGKILL')
  await runs.dispose()
})

test('an override is not recorded when the merge itself is refused', async () => {
  const repo = gitRepo()
  const { store, runs } = await makeBoard({ repo })
  const shell = fakeShell({ failures: ['npm test'] })
  // The run lives in a real worktree; the base checkout is dirty, so the merge refuses.
  const ticket = store.createTicket({ title: 'override + dirty base', assignee: 'coder', checks: 'unit :: npm test' })
  store.updateTicket({ id: ticket.id, status: 'ready' })
  store.updateTicket({ id: ticket.id, status: 'in_progress' })
  const worktree = addWorktree(repo, 'board/b-13')
  commitIn(repo, worktree.path, { 'work.txt': 'work\n' })
  const run = store.addRun(ticket, { status: 'awaiting_review', sessionId: 'session-1' })
  store.patchRun(run, { worktree })
  store.updateTicket({ id: ticket.id, status: 'in_review' })
  writeFileSync(join(repo.dir, 'README.md'), 'dirty base\n')

  await assert.rejects(runs.approve(ticket.id, 'human', { overrideChecks: true, reason: 'trying' }), /uncommitted changes/)
  assert.equal(store.find(ticket.id).status, 'in_review')
  assert.equal(store.find(ticket.id).runs[0].checksOverridden, undefined)
})

test('editing the checks after they ran forces a re-run before approval', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const shell = fakeShell()
  const { store, runs } = await makeBoard({ repo: gitRepo(), services: { agents, shell } })
  const ticket = store.createTicket({ title: 'edited checks', assignee: 'coder', checks: 'unit :: echo pass' })
  startAgentRun(store, ticket)
  await runs.start(ticket.id)
  await waitFor(() => runs.active.get(ticket.id)?.phase === 'running')
  store.updateTicket({ id: ticket.id, status: 'in_review' })
  idle.resolve()
  await waitFor(() => store.find(ticket.id).runs[0].status === 'awaiting_review' && runs.active.size === 0)
  assert.equal(shell.calls.length, 1)
  assert.equal(store.find(ticket.id).runs[0].checksKey, JSON.stringify([{ name: 'unit', command: 'echo pass', timeoutMs: null }]))

  store.updateTicket({ id: ticket.id, checks: 'unit :: echo changed' })
  assert.equal(store.find(ticket.id).runs[0].checks, undefined, 'editing checks invalidates the stored result')
  await runs.approve(ticket.id)
  assert.equal(shell.calls.length, 2)
  assert.match(shell.calls[1].command, /echo changed/)
  assert.equal(store.find(ticket.id).status, 'done')
})

test('rejecting is refused while the checks are running', async () => {
  const shellGate = deferred()
  const shell = fakeShell({ gate: shellGate })
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { store, runs } = await makeBoard({ repo: gitRepo(), services: { agents, shell } })
  const ticket = store.createTicket({ title: 'checking reject', assignee: 'coder', checks: 'unit :: npm test' })
  startAgentRun(store, ticket)
  await runs.start(ticket.id)
  await waitFor(() => runs.active.get(ticket.id)?.phase === 'running')
  store.updateTicket({ id: ticket.id, status: 'in_review' })
  idle.resolve()
  await waitFor(() => runs.active.get(ticket.id)?.phase === 'checking')
  await assert.rejects(runs.reject(ticket.id, 'try later'), /checks for this run are still running/)
  shellGate.resolve()
  await waitFor(() => runs.active.size === 0)
  await runs.dispose()
})

test('uncommitted tracked changes block approval until the checkout is clean', async () => {
  const repo = gitRepo()
  const shell = fakeShell()
  const { store, runs } = await makeBoard({ repo, services: { shell } })
  const { ticket, worktree } = seedGateRun(repo, store, { branch: 'board/b-16' })
  store.updateTicket({ id: ticket.id, checks: 'unit :: echo pass' })
  // The worker (or an external edit) leaves a tracked file modified but uncommitted.
  writeFileSync(join(worktree.path, 'work.txt'), 'uncommitted edit\n')

  await assert.rejects(runs.approve(ticket.id), /uncommitted tracked changes/)
  assert.equal(store.find(ticket.id).status, 'in_review')

  // Cleaning the checkout makes approval possible again, and the checks re-run on it.
  repo.git(['checkout', '--', 'work.txt'], worktree.path)
  await runs.approve(ticket.id)
  assert.equal(store.find(ticket.id).status, 'done')
  assert.equal(shell.calls.length, 2)
})

test('a commit made after the checks ran forces them to run again', async () => {
  const repo = gitRepo()
  const shell = fakeShell()
  const { store, runs } = await makeBoard({ repo, services: { shell } })
  const { ticket, worktree } = seedGateRun(repo, store, { branch: 'board/b-17' })
  store.updateTicket({ id: ticket.id, checks: 'unit :: echo pass' })
  // First approval attempt runs the checks; make the base dirty so it refuses afterwards.
  writeFileSync(join(repo.dir, 'README.md'), 'dirty base\n')
  await assert.rejects(runs.approve(ticket.id), /uncommitted changes/)
  assert.equal(shell.calls.length, 1)
  repo.git(['checkout', '--', 'README.md'])
  // The branch gains a commit after the checks were recorded.
  commitIn(repo, worktree.path, { 'later.txt': 'later\n' }, 'later commit')
  await runs.approve(ticket.id)
  assert.equal(shell.calls.length, 2, 'checks must re-run for the new HEAD')
  assert.equal(store.find(ticket.id).status, 'done')
})

test('a comment is delivered to a live worker and not to a parked ticket', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { store, runs } = await makeBoard({ repo: gitRepo(), services: { agents } })
  const ticket = store.createTicket({ title: 'steer me', assignee: 'coder' })
  startAgentRun(store, ticket)
  await runs.start(ticket.id)
  await waitFor(() => runs.active.get(ticket.id)?.phase === 'running')

  const live = runs.steer(ticket.id, 'please add a test')
  assert.equal(live.delivered, true)
  assert.equal(agents.handles[0].agent.followups.length, 2)
  assert.match(agents.handles[0].agent.followups[1].content[0].text, /please add a test/)

  idle.resolve()
  await waitFor(() => runs.active.size === 0)
  const parked = runs.steer(ticket.id, 'too late')
  assert.equal(parked.delivered, false)
  assert.equal(agents.handles[0].agent.followups.length, 2)
  await runs.dispose()
})

test('a comment that arrives as a turn ends keeps the run alive until it is handled', async () => {
  const idles = []
  const idleFactory = () => {
    const gate = deferred()
    idles.push(gate)
    return gate.promise
  }
  const agents = defaultAgents({ idleFactory })
  const { store, runs } = await makeBoard({ repo: gitRepo(), services: { agents } })
  const ticket = store.createTicket({ title: 'steer at the edge', assignee: 'coder' })
  startAgentRun(store, ticket)
  await runs.start(ticket.id)
  await waitFor(() => runs.active.get(ticket.id)?.phase === 'running')
  assert.equal(idles.length, 1)

  assert.equal(runs.steer(ticket.id, 'one more thing').delivered, true)
  idles[0].resolve()
  await waitFor(() => idles.length >= 2)
  assert.equal(store.find(ticket.id).status, 'in_progress', 'a pending steer must keep the run open')

  idles[1].resolve()
  await waitFor(() => runs.active.size === 0)
  assert.match(agents.handles[0].agent.followups[1].content[0].text, /one more thing/)
  assert.equal(store.find(ticket.id).status, 'in_review')
  await runs.dispose()
})

test('a ticket waits for its dependencies and starts once they are done', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { store, runs } = await makeBoard({ repo: gitRepo(), services: { agents }, config: { maxWorkers: 2 } })
  const first = store.createTicket({ title: 'dependency', assignee: 'coder' })
  const second = store.createTicket({ title: 'dependent', assignee: 'coder', blockedBy: first.key })
  startAgentRun(store, first)
  startAgentRun(store, second)

  await runs.start(first.id)
  await waitFor(() => runs.active.get(first.id)?.phase === 'running')
  await assert.rejects(runs.start(second.id), /waits for another ticket/)

  store.updateTicket({ id: first.id, status: 'in_review' })
  store.updateTicket({ id: first.id, status: 'done' })
  runs.pump()
  await waitFor(() => store.find(second.id).runs.length > 0)
  assert.equal(store.find(second.id).status, 'in_progress')
  await runs.dispose()
})

test('the queue survives a restart and runs by priority', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { store, runs, harness } = await makeBoard({ repo: gitRepo(), services: { agents }, config: { maxWorkers: 1 } })
  const tickets = [
    store.createTicket({ title: 'running', assignee: 'coder' }),
    store.createTicket({ title: 'plain', assignee: 'coder' }),
    store.createTicket({ title: 'urgent', assignee: 'coder', priority: 5 }),
    store.createTicket({ title: 'soon', assignee: 'coder', priority: 1 }),
  ]
  for (const ticket of tickets) startAgentRun(store, ticket)
  await runs.start(tickets[0].id)
  await waitFor(() => runs.active.get(tickets[0].id)?.phase === 'running')
  for (const ticket of tickets.slice(1)) await runs.start(ticket.id)
  assert.deepEqual(runs.queued().map(id => store.find(id).key), ['B-3', 'B-4', 'B-2'])
  assert.ok(store.find(tickets[1].id).queuedAt)

  // A fresh controller over the same file rebuilds the queue from the board.
  const reloaded = createBoardStore({ file: store.file })
  const restarted = createRunController({ ctx: harness.ctx, store: reloaded, config: { workspace: store.file, maxWorkers: 1 }, log: () => {} })
  restarted.recover()
  assert.deepEqual(restarted.queued().map(id => reloaded.find(id).key), ['B-3', 'B-4', 'B-2'])
  await restarted.dispose()
  await runs.dispose()
})

test('a wall-clock budget stops an overrunning run', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { store, runs } = await makeBoard({ repo: gitRepo(), services: { agents } })
  const ticket = store.createTicket({ title: 'too slow', assignee: 'coder' })
  store.updateTicket({ id: ticket.id, budgetMinutes: 0.001 })
  startAgentRun(store, ticket)
  await runs.start(ticket.id)
  await waitFor(() => runs.active.get(ticket.id)?.phase === 'running')
  await delay(150)
  idle.resolve()
  await waitFor(() => runs.active.size === 0 && store.find(ticket.id).status === 'blocked')
  assert.match(store.find(ticket.id).runs[0].reason, /wall-clock budget exceeded/)
  await runs.dispose()
})

test('prune removes merged or archived leftovers and keeps live unmerged branches', async () => {
  const repo = gitRepo()
  const { store, runs } = await makeBoard({ repo })
  const merged = store.createTicket({ title: 'merged', assignee: 'coder' })
  store.updateTicket({ id: merged.id, status: 'ready' })
  store.updateTicket({ id: merged.id, status: 'in_progress' })
  const mergedWorktree = addWorktree(repo, 'board/prune-me')
  const mergedRun = store.addRun(merged, { status: 'approved' })
  store.patchRun(mergedRun, { worktree: mergedWorktree, merge: { short: 'abc1234', baseBranch: 'master' } })
  store.closeRun(merged, mergedRun, 'approved', null)
  store.updateTicket({ id: merged.id, status: 'in_review' })
  store.updateTicket({ id: merged.id, status: 'done' })

  const open = store.createTicket({ title: 'unmerged', assignee: 'coder' })
  store.updateTicket({ id: open.id, status: 'ready' })
  store.updateTicket({ id: open.id, status: 'in_progress' })
  const keptWorktree = addWorktree(repo, 'board/keep-me')
  const openRun = store.addRun(open, { status: 'awaiting_review' })
  store.patchRun(openRun, { worktree: keptWorktree })

  const report = await runs.prune()
  assert.ok(report.removed.some(entry => entry.ticket === 'B-1'))
  assert.ok(report.skipped.some(entry => entry.ticket === 'B-2' && /run is active/.test(entry.reason)))
  assert.equal(existsSync(mergedWorktree.path), false)
  assert.notEqual(repo.git(['branch', '--list', 'board/keep-me']), '')
  await runs.dispose()
})

test('archived tickets only lose unmerged work with force', async () => {
  const repo = gitRepo()
  const { store, runs } = await makeBoard({ repo })
  const ticket = store.createTicket({ title: 'abandoned', assignee: 'coder' })
  store.updateTicket({ id: ticket.id, status: 'ready' })
  store.updateTicket({ id: ticket.id, status: 'in_progress' })
  const worktree = addWorktree(repo, 'board/abandon-me')
  const run = store.addRun(ticket, { status: 'awaiting_review' })
  store.patchRun(run, { worktree })
  store.closeRun(ticket, run, 'rejected', 'gave up')
  assert.throws(() => store.setArchived(ticket.id, true, 'human'), /unmerged run branch/)
  store.setArchived(ticket.id, true, 'human', { force: true })

  const skipped = await runs.prune({ includeArchived: true })
  assert.ok(skipped.skipped.some(entry => entry.ticket === 'B-1' && /force/.test(entry.reason)))
  assert.ok(existsSync(worktree.path))

  const forced = await runs.prune({ includeArchived: true, force: true })
  assert.ok(forced.removed.some(entry => entry.ticket === 'B-1'))
  assert.equal(existsSync(worktree.path), false)
  assert.equal(store.find(ticket.id).runs[0].worktree.pruned, true)
  await runs.dispose()
})

test('rejecting is refused when no worker slot is free', async () => {
  const repo = gitRepo()
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { store, runs } = await makeBoard({ repo, services: { agents }, config: { maxWorkers: 1 } })
  // One running ticket occupies the only slot.
  const running = store.createTicket({ title: 'running', assignee: 'coder' })
  startAgentRun(store, running)
  await runs.start(running.id)
  await waitFor(() => runs.active.get(running.id)?.phase === 'running')
  // A gate ticket to reject.
  const { ticket } = seedGateRun(repo, store, { branch: 'board/reject-me' })
  await assert.rejects(runs.reject(ticket.id, 'needs work'), /no worker slot is free/)
  assert.equal(store.find(ticket.id).status, 'in_review')
  idle.resolve()
  await waitFor(() => runs.active.size === 0)
  await runs.dispose()
})

test('lowering the wall-clock budget mid-run stops the run at settle', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { store, runs } = await makeBoard({ repo: gitRepo(), services: { agents } })
  const ticket = store.createTicket({ title: 'budget shrank', assignee: 'coder' })
  store.updateTicket({ id: ticket.id, budgetMinutes: 10 })
  startAgentRun(store, ticket)
  await runs.start(ticket.id)
  await waitFor(() => runs.active.get(ticket.id)?.phase === 'running')
  store.updateTicket({ id: ticket.id, budgetMinutes: 0.0001 })
  await delay(120)
  idle.resolve()
  await waitFor(() => store.find(ticket.id).status === 'blocked')
  assert.match(store.find(ticket.id).runs[0].reason, /wall-clock budget exceeded/)
  await runs.dispose()
})

test('leaving the dispatch state clears the durable queue marker', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { store, runs } = await makeBoard({ repo: gitRepo(), services: { agents }, config: { maxWorkers: 1 } })
  const first = store.createTicket({ title: 'first', assignee: 'coder' })
  const second = store.createTicket({ title: 'second', assignee: 'coder' })
  startAgentRun(store, first)
  startAgentRun(store, second)
  await runs.start(first.id)
  await waitFor(() => runs.active.get(first.id)?.phase === 'running')
  await runs.start(second.id)
  assert.ok(store.find(second.id).queuedAt)
  store.updateTicket({ id: second.id, status: 'backlog' })
  assert.equal(store.find(second.id).queuedAt, null)
  idle.resolve()
  await waitFor(() => runs.active.size === 0)
  await runs.dispose()
})

test('a ticket can be archived after a rejection cycle', async () => {
  const repo = gitRepo()
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { store, runs } = await makeBoard({ repo, services: { agents }, config: { maxWorkers: 2 } })
  const { ticket, run: rejectedRun } = seedGateRun(repo, store, { branch: 'board/cycle' })
  await runs.reject(ticket.id, 'needs another pass')
  const current = store.currentRun(store.find(ticket.id))
  assert.equal(store.find(ticket.id).runs.find(item => item.id === rejectedRun.id).worktree.superseded, true)
  assert.equal(current.worktree.path, rejectedRun.worktree.path)
  // The reworked run merges; the superseded run must not block archiving.
  store.patchRun(current, { merge: { short: 'abc1234', baseBranch: 'master' } })
  store.closeRun(store.find(ticket.id), current, 'approved', null)
  store.find(ticket.id).status = 'done'
  store.save()
  store.setArchived(ticket.id, true, 'human')
  assert.ok(store.find(ticket.id).archivedAt)
  await runs.dispose()
})

test('a wall-clock budget added to a running run is enforced', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { store, runs } = await makeBoard({ repo: gitRepo(), services: { agents } })
  const ticket = store.createTicket({ title: 'budget added later', assignee: 'coder' })
  startAgentRun(store, ticket)
  await runs.start(ticket.id)
  await waitFor(() => runs.active.get(ticket.id)?.phase === 'running')
  store.updateTicket({ id: ticket.id, budgetMinutes: 0.0001 })
  await delay(120)
  idle.resolve()
  await waitFor(() => store.find(ticket.id).status === 'blocked')
  assert.match(store.find(ticket.id).runs[0].reason, /wall-clock budget exceeded/)
  await runs.dispose()
})

test('a ticket moved out of Ready and back is re-stamped in the queue', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { store, runs } = await makeBoard({ repo: gitRepo(), services: { agents }, config: { maxWorkers: 1 } })
  const first = store.createTicket({ title: 'first', assignee: 'coder' })
  const second = store.createTicket({ title: 'second', assignee: 'coder' })
  startAgentRun(store, first)
  startAgentRun(store, second)
  await runs.start(first.id)
  await waitFor(() => runs.active.get(first.id)?.phase === 'running')
  await runs.start(second.id)
  assert.ok(store.find(second.id).queuedAt)
  store.updateTicket({ id: second.id, status: 'backlog' })
  assert.equal(store.find(second.id).queuedAt, null)
  store.updateTicket({ id: second.id, status: 'ready' })
  runs.pump()
  assert.ok(store.find(second.id).queuedAt, 're-entering Ready must re-stamp the queue marker')
  assert.ok(runs.queued().includes(second.id))
  idle.resolve()
  await waitFor(() => runs.active.size === 0)
  await runs.dispose()
})

test('subagent tokens count against the run budget and are recorded', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const tokenMeter = { measure: session => ({ totalTokens: Number(session?.tokens) || 0 }) }
  const { store, runs, harness } = await makeBoard({ repo: gitRepo(), services: { agents, tokenMeter } })
  const ticket = store.createTicket({ title: 'delegating', assignee: 'coder' })
  store.updateTicket({ id: ticket.id, budgetTokens: 100 })
  startAgentRun(store, ticket)
  await runs.start(ticket.id)
  await waitFor(() => runs.active.get(ticket.id)?.phase === 'running')
  const parentId = agents.handles[0].agent.id
  harness.emit('session/created', { id: 'child-1', header: { parentSession: parentId }, tokens: 60 })
  harness.emit('session/created', { id: 'child-2', header: { parentSession: 'child-1' }, tokens: 50 })
  await waitFor(() => (store.find(ticket.id).runs[0].subagents ?? []).length === 2)

  idle.resolve()
  await waitFor(() => store.find(ticket.id).status === 'blocked')
  const run = store.find(ticket.id).runs[0]
  assert.match(run.reason, /token budget exceeded/)
  assert.equal(run.tokens, 110)
  assert.equal(run.subagents.length, 2)
  await runs.dispose()
})

test('the subagent fan-out cap cancels the run', async () => {
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { store, runs, harness } = await makeBoard({ repo: gitRepo(), services: { agents }, config: { maxSubagents: 1 } })
  const ticket = store.createTicket({ title: 'over-delegating', assignee: 'coder' })
  startAgentRun(store, ticket)
  await runs.start(ticket.id)
  await waitFor(() => runs.active.get(ticket.id)?.phase === 'running')
  const parentId = agents.handles[0].agent.id
  harness.emit('session/created', { id: 'cap-child-1', header: { parentSession: parentId } })
  harness.emit('session/created', { id: 'cap-child-2', header: { parentSession: parentId } })
  assert.equal(agents.handles[0].agent.cancels.length, 1)
  idle.resolve()
  await waitFor(() => store.find(ticket.id).status === 'blocked')
  assert.match(store.find(ticket.id).runs[0].reason, /subagent fan-out exceeded/)
  await runs.dispose()
})

test('a ticket created in a temp directory workspace still runs without worktrees', async () => {
  const workspace = tempDir()
  const idle = deferred()
  const agents = defaultAgents({ idle: idle.promise })
  const { store, runs } = await makeBoard({ repo: undefined, services: { agents }, config: { workspace } })
  const ticket = store.createTicket({ title: 'no git', assignee: 'coder' })
  startAgentRun(store, ticket)
  await runs.start(ticket.id)
  await waitFor(() => runs.active.get(ticket.id)?.phase === 'running')
  idle.resolve()
  await waitFor(() => runs.active.size === 0)
  assert.equal(store.find(ticket.id).status, 'in_review')
  await runs.dispose()
})

test('gc reports and removes orphaned board worktrees and branches', async () => {
  const repo = gitRepo()
  const { runs } = await makeBoard({ repo })
  const git = args => execFileSync('git', args, { cwd: repo.dir }).toString().trim()
  try {
    git(['branch', 'board/orphan-branch'])
    git(['branch', 'feature/keep'])
    const worktreePath = join(tempDir(), 'orphan-worktree')
    git(['worktree', 'add', '-b', 'board/orphan-worktree', worktreePath, 'HEAD'])

    const dry = await runs.gc()
    assert.equal(dry.dryRun, true)
    assert.equal(dry.worktrees.some(item => item.path === worktreePath), true)
    assert.equal(dry.branches.includes('board/orphan-branch'), true)
    assert.equal(dry.branches.includes('feature/keep'), false)

    const applied = await runs.gc({ apply: true })
    assert.equal(applied.removed.worktrees, 1)
    assert.equal(existsSync(worktreePath), false)
    const branches = git(['branch', '--list'])
    assert.equal(branches.includes('board/orphan-branch'), false)
    assert.equal(branches.includes('board/orphan-worktree'), false)
    assert.equal(branches.includes('feature/keep'), true)
    assert.deepEqual(applied.errors, [])
  } finally {
    await runs.dispose()
  }
})

test('PR mode pushes the branch, opens a pull request and completes on merge', async () => {
  const repo = gitRepo()
  const bare = join(tempDir(), 'origin.git')
  execFileSync('git', ['init', '--bare', bare])
  execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo.dir })
  const { store, runs } = await makeBoard({
    repo,
    config: { pullRequest: { repository: 'acme/repo', token: 'test-token', base: 'main' } },
  })
  const { ticket, run } = seedGateRun(repo, store, { branch: 'board/pr-slug' })
  run.worktree.repositoryRoot = repo.dir
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify({ html_url: 'https://github.test/acme/repo/pull/7', number: 7 }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const result = await runs.openPullRequest(ticket.id)
    assert.equal(result.url, 'https://github.test/acme/repo/pull/7')
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /\/repos\/acme\/repo\/pulls$/)
    const body = JSON.parse(calls[0].init.body)
    assert.equal(body.head, 'board/pr-slug')
    assert.equal(body.base, 'main')
    const opened = store.find(ticket.id)
    assert.equal(opened.status, 'in_review')
    assert.equal(opened.runs.at(-1).pullRequest.url, 'https://github.test/acme/repo/pull/7')
    assert.equal(opened.artifacts.some(artifact => artifact.kind === 'pr'), true)

    await runs.markPullRequestMerged(ticket.id)
    const merged = store.find(ticket.id)
    assert.equal(merged.status, 'done')
    assert.equal(merged.runs.at(-1).merge.pr, 'https://github.test/acme/repo/pull/7')
  } finally {
    globalThis.fetch = originalFetch
    await runs.dispose()
  }
})

test('a checks deny policy blocks commands without executing them', async () => {
  const repo = gitRepo()
  const { store, runs } = await makeBoard({ repo, config: { checks: { deny: ['rm -rf'] } } })
  const { ticket } = seedGateRun(repo, store, { branch: 'board/deny-policy' })
  store.updateTicket({ id: ticket.id, checks: 'cleanup :: rm -rf /tmp/board-test-marker' })
  await assert.rejects(runs.approve(ticket.id), /checks failed/)
  const check = store.find(ticket.id).runs.at(-1).checks.find(item => item.name === 'cleanup')
  assert.equal(check.blocked, true)
  assert.match(check.error, /board checks policy/)
  assert.equal(check.exitCode, null)
  await runs.dispose()
})

test('a stale plan approval is refused at merge time', async () => {
  const repo = gitRepo()
  const { store, runs } = await makeBoard({ repo, config: { approvalTtlHours: 1 } })
  const { ticket } = seedGateRun(repo, store, { branch: 'board/ttl' })
  ticket.plan = {
    status: 'approved',
    version: 1,
    markdown: '# plan',
    acceptance: [],
    decomposition: [],
    checks: [],
    sessionId: null,
    feedback: [],
    submittedAt: null,
    approvedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  }
  await assert.rejects(runs.approve(ticket.id), /approval expired/)
  await runs.dispose()
})

test('GitLab PR mode creates a merge request and prunes the worktree when merged', async () => {
  const repo = gitRepo()
  const bare = join(tempDir(), 'gl-origin.git')
  execFileSync('git', ['init', '--bare', bare])
  execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo.dir })
  const { store, runs } = await makeBoard({
    repo,
    config: {
      pullRequest: { provider: 'gitlab', repository: 'group/project', token: 'gl-token', base: 'main', apiBase: 'https://gitlab.test/api/v4' },
    },
  })
  const { ticket, run } = seedGateRun(repo, store, { branch: 'board/gitlab-slug' })
  run.worktree.repositoryRoot = repo.dir
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify({ web_url: 'https://gitlab.test/group/project/-/merge_requests/3', iid: 3 }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const result = await runs.openPullRequest(ticket.id)
    assert.equal(result.url, 'https://gitlab.test/group/project/-/merge_requests/3')
    assert.equal(calls[0].url, 'https://gitlab.test/api/v4/projects/group%2Fproject/merge_requests')
    assert.equal(calls[0].init.headers['PRIVATE-TOKEN'], 'gl-token')
    const body = JSON.parse(calls[0].init.body)
    assert.equal(body.source_branch, 'board/gitlab-slug')
    assert.equal(body.target_branch, 'main')

    await runs.markPullRequestMerged(ticket.id)
    const merged = store.find(ticket.id)
    assert.equal(merged.status, 'done')
    assert.equal(merged.runs.at(-1).merge.pr, 'https://gitlab.test/group/project/-/merge_requests/3')
    assert.equal(merged.runs.at(-1).worktree.pruned, true)
    assert.equal(existsSync(worktreePathOf(merged)), false)
  } finally {
    globalThis.fetch = originalFetch
    await runs.dispose()
  }
})

function worktreePathOf(ticket) {
  const find = list => (Array.isArray(list) ? list.find(item => item && item.worktree && !item.merge && !item.prunedAt) : null)
  const run = find(ticket.runs) ?? [...ticket.runs].reverse().find(item => item.worktree)
  return run?.worktree?.path ?? ''
}

test('pull-request auto-sync completes a ticket once the PR merges', async () => {
  const repo = gitRepo()
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify({ merged: true, state: 'closed', merged_at: new Date().toISOString() }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const { store, runs } = await makeBoard({
    repo,
    config: { pullRequest: { repository: 'acme/repo', token: 'test-token', base: 'main', autoSync: true, pollMs: 1000 } },
  })
  try {
    const ticket = store.createTicket({ title: 'polled pull request', assignee: 'coder' })
    store.updateTicket({ id: ticket.id, status: 'ready' })
    store.updateTicket({ id: ticket.id, status: 'in_progress' })
    store.updateTicket({ id: ticket.id, status: 'in_review' })
    const run = store.addRun(ticket, { status: 'awaiting_review', sessionId: 'session-poll' })
    store.patchRun(run, { pullRequest: { url: 'https://github.test/acme/repo/pull/9', number: 9, base: 'main' } })
    store.save()

    await waitFor(() => store.find(ticket.id).status === 'done')
    assert.equal(calls.length >= 1, true)
    assert.match(calls[0].url, /\/repos\/acme\/repo\/pulls\/9$/)
    assert.equal(store.find(ticket.id).runs.at(-1).merge.pr, 'https://github.test/acme/repo/pull/9')
  } finally {
    globalThis.fetch = originalFetch
    await runs.dispose()
  }
})
