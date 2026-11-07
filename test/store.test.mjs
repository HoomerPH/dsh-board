/**
 * Store durability and mutation-atomicity tests (Slice 0 items 0.1, 0.2, 0.11
 * and key continuity). Each test corresponds to a reported failure mode.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, existsSync, readFileSync, readdirSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
import { createBoardStore, normalizeWorkflow } from '../lib/store.js'
import { tempDir } from './helpers.mjs'

const boardFile = dir => join(dir, 'board.json')
const readBoard = dir => JSON.parse(readFileSync(boardFile(dir), 'utf8'))
const quarantineOf = dir => readdirSync(dir).find(name => name.includes('.corrupt-'))

test('a corrupt board.json is quarantined and the last good backup is restored', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  const store = createBoardStore({ file })
  store.createTicket({ title: 'one' })
  store.createTicket({ title: 'two' })
  const corrupt = '{"version":1,"tickets":[{"id":"t-1"'
  writeFileSync(file, corrupt)

  const recovered = createBoardStore({ file })
  assert.match(recovered.loadWarning, /unreadable/)
  assert.match(recovered.loadWarning, /moved to/)
  assert.match(recovered.loadWarning, /restored the last good board/)
  assert.deepEqual(
    recovered.list().map(ticket => ticket.key),
    ['B-1', 'B-2'],
  )
  const quarantine = quarantineOf(dir)
  assert.ok(quarantine, 'the unreadable file must be preserved')
  assert.equal(readFileSync(join(dir, quarantine), 'utf8'), corrupt)
  // Keys never restart, even after recovery.
  assert.equal(recovered.createTicket({ title: 'three' }).key, 'B-3')
  assert.equal(readBoard(dir).tickets.length, 3)
})

test('a corrupt board.json with no usable backup starts empty without losing the original bytes', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  const corrupt = 'not json at all'
  writeFileSync(file, corrupt)

  const store = createBoardStore({ file })
  assert.match(store.loadWarning, /unreadable/)
  assert.equal(store.list().length, 0)
  assert.equal(readFileSync(join(dir, quarantineOf(dir)), 'utf8'), corrupt)
  const ticket = store.createTicket({ title: 'after corruption' })
  assert.equal(ticket.key, 'B-1')
  assert.equal(readBoard(dir).tickets.length, 1)
})

test('a second writer is refused instead of clobbering tickets', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  createBoardStore({ file }).createTicket({ title: 'seed' })

  const first = createBoardStore({ file })
  const second = createBoardStore({ file })
  first.createTicket({ title: 'from first' })
  assert.throws(() => second.createTicket({ title: 'from second' }), /changed on disk/)
  // The refused mutation is rolled back in memory and on disk.
  assert.equal(second.list().length, 1)
  assert.deepEqual(
    readBoard(dir).tickets.map(ticket => ticket.title),
    ['seed', 'from first'],
  )
})

test('a board that booted empty refuses a file written by another instance', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  const store = createBoardStore({ file })
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      board: { name: 'Other' },
      nextKey: 2,
      tickets: [{ id: 'x', key: 'B-1', title: 'theirs', status: 'backlog', activity: [] }],
    }),
  )
  assert.throws(() => store.createTicket({ title: 'mine' }), /(appeared|changed) on disk/)
  assert.equal(store.list().length, 0)
  assert.equal(readBoard(dir).tickets[0].title, 'theirs')
})

test('a rejected update leaves neither memory nor disk changed', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  const store = createBoardStore({ file })
  const ticket = store.createTicket({ title: 'original' })

  assert.throws(() => store.updateTicket({ id: ticket.id, title: 'renamed', status: 'not-a-status' }), /unknown status/)
  assert.equal(store.find(ticket.id).title, 'original')
  assert.equal(readBoard(dir).tickets[0].title, 'original')
})

test('a transition-rejected update is not half applied', () => {
  const dir = tempDir()
  const store = createBoardStore({
    file: boardFile(dir),
    workflow: normalizeWorkflow({
      states: [{ id: 'triage' }, { id: 'building' }],
      initial: 'triage',
      dispatch: 'triage',
      active: 'building',
      transitions: { triage: [], building: [] },
    }),
  })
  const ticket = store.createTicket({ title: 'locked' })
  assert.throws(() => store.updateTicket({ id: ticket.id, title: 'should not stick', status: 'building' }), /illegal transition/)
  assert.equal(store.find(ticket.id).title, 'locked')
  assert.equal(store.find(ticket.id).status, 'triage')
})

test('a failed disk write rolls the mutation back', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  const store = createBoardStore({ file })
  const ticket = store.createTicket({ title: 'rollback me' })
  const activityBefore = ticket.activity.length
  chmodSync(dir, 0o500)
  try {
    assert.throws(() => store.commentTicket({ id: ticket.id, text: 'lost comment', by: 'human' }))
  } finally {
    chmodSync(dir, 0o700)
  }
  assert.equal(ticket.activity.length, activityBefore)
  assert.equal(store.find(ticket.id).activity.length, activityBefore)
  store.commentTicket({ id: ticket.id, text: 'kept', by: 'human' })
  assert.equal(readBoard(dir).tickets[0].activity.at(-1).text, 'kept')
})

test('nextKey is derived from the highest ticket key on the board', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      board: { name: 'Keys' },
      nextKey: 2,
      tickets: [{ id: 't-9', key: 'B-9', title: 'high key', status: 'backlog', activity: [] }],
    }),
  )
  const store = createBoardStore({ file })
  assert.equal(store.createTicket({ title: 'new' }).key, 'B-10')
})

test('a same-size file restored with an old mtime is still detected as a different file', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  const store = createBoardStore({ file })
  store.createTicket({ title: 'seed' })
  const stat = statSync(file)
  const original = readFileSync(file, 'utf8')
  const mutated = original.replace('"title": "seed"', '"title": "hack"')
  assert.equal(mutated.length, original.length)
  const replacement = `${file}.replacement`
  writeFileSync(replacement, mutated)
  utimesSync(replacement, stat.atime, stat.mtime)
  renameSync(replacement, file)
  assert.throws(() => store.createTicket({ title: 'after' }), /changed on disk/)
  assert.equal(store.list().length, 1)
})

test('a metadata-only change (chmod) does not wedge the writer guard', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  const store = createBoardStore({ file })
  store.createTicket({ title: 'one' })
  chmodSync(file, 0o600)
  const ticket = store.createTicket({ title: 'two' })
  assert.equal(ticket.key, 'B-2')
  chmodSync(file, 0o644)
})

test('checks parse from text and arrays, persist, and can be cleared', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  const store = createBoardStore({ file })
  const ticket = store.createTicket({ title: 'checks', checks: 'tests :: npm test\nlint :: npm run lint :: 60000' })
  assert.deepEqual(ticket.checks, [
    { name: 'tests', command: 'npm test', timeoutMs: null },
    { name: 'lint', command: 'npm run lint', timeoutMs: 60000 },
  ])
  store.updateTicket({ id: ticket.id, checks: [{ name: 'build', command: 'npm run build' }] })
  assert.equal(store.find(ticket.id).checks[0].command, 'npm run build')
  assert.equal(createBoardStore({ file }).find(ticket.id).checks[0].name, 'build')
  store.updateTicket({ id: ticket.id, checks: '' })
  assert.deepEqual(store.find(ticket.id).checks, [])
  const tooMany = Array.from({ length: 21 }, (_, index) => ({ command: 'check-' + index }))
  assert.throws(() => store.updateTicket({ id: ticket.id, checks: tooMany }), /at most 20/)
  assert.deepEqual(store.find(ticket.id).checks, [])
})

test('a stored board over the check cap is clamped on load instead of failing to boot', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      board: { name: 'Many checks' },
      nextKey: 2,
      tickets: [
        {
          id: 't-1',
          key: 'B-1',
          title: 'many checks',
          status: 'backlog',
          activity: [],
          checks: Array.from({ length: 25 }, (_, index) => ({ name: 'c' + index, command: 'echo ' + index })),
        },
      ],
    }),
  )
  const store = createBoardStore({ file })
  assert.equal(store.find('B-1').checks.length, 20)
})

test('a failed save restores the check list and the per-run check results it invalidated', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  const store = createBoardStore({ file })
  const ticket = store.createTicket({ title: 'checks rollback', checks: 'unit :: echo one' })
  const run = store.addRun(ticket, { status: 'awaiting_review', sessionId: 'session-1' })
  store.patchRun(run, { checks: [{ name: 'unit', command: 'echo one', exitCode: 0 }], checksKey: 'old' })
  store.save()
  chmodSync(dir, 0o500)
  try {
    assert.throws(() => store.updateTicket({ id: ticket.id, checks: 'unit :: echo two' }))
  } finally {
    chmodSync(dir, 0o700)
  }
  assert.deepEqual(store.find(ticket.id).checks, [{ name: 'unit', command: 'echo one', timeoutMs: null }])
  assert.equal(store.find(ticket.id).runs[0].checks.length, 1, 'invalidated run results must be restored too')
  assert.equal(store.find(ticket.id).runs[0].checksKey, 'old')
  store.updateTicket({ id: ticket.id, title: 'after' })
  assert.deepEqual(readBoard(dir).tickets[0].checks, [{ name: 'unit', command: 'echo one', timeoutMs: null }])
  assert.equal(readBoard(dir).tickets[0].runs[0].checksKey, 'old')
})

test('acceptance criteria can be edited and persist', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  const store = createBoardStore({ file })
  const ticket = store.createTicket({ title: 'criteria' })
  store.updateTicket({ id: ticket.id, acceptance: 'first\n- second' })
  assert.deepEqual(store.find(ticket.id).acceptance, ['first', 'second'])
  assert.deepEqual(createBoardStore({ file }).find(ticket.id).acceptance, ['first', 'second'])
  const tooMany = Array.from({ length: 51 }, (_, index) => 'item-' + index)
  assert.throws(() => store.updateTicket({ id: ticket.id, acceptance: tooMany }), /at most 50/)
  assert.equal(store.find(ticket.id).acceptance.length, 2)
})

test('a delivered comment is annotated with the receiving run and persists', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  const store = createBoardStore({ file })
  const ticket = store.createTicket({ title: 'steered' })
  store.commentTicket({ id: ticket.id, text: 'please add a test', by: 'human' })
  store.annotateComment(ticket.id, 'run-42')
  assert.equal(store.find(ticket.id).activity.at(-1).deliveredTo, 'run-42')
  assert.equal(createBoardStore({ file }).find(ticket.id).activity.at(-1).deliveredTo, 'run-42')
})

test('a failed save restores acceptance criteria too', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  const store = createBoardStore({ file })
  const ticket = store.createTicket({ title: 'acceptance rollback', acceptance: 'old criterion' })
  chmodSync(dir, 0o500)
  try {
    assert.throws(() => store.updateTicket({ id: ticket.id, acceptance: 'new criterion' }))
  } finally {
    chmodSync(dir, 0o700)
  }
  assert.deepEqual(store.find(ticket.id).acceptance, ['old criterion'])
  store.updateTicket({ id: ticket.id, title: 'after the failure' })
  assert.deepEqual(readBoard(dir).tickets[0].acceptance, ['old criterion'])
})

test('a create with too many acceptance criteria is rejected without burning a key', () => {
  const dir = tempDir()
  const store = createBoardStore({ file: boardFile(dir) })
  assert.equal(store.createTicket({ title: 'first' }).key, 'B-1')
  const tooMany = Array.from({ length: 51 }, (_, index) => 'criterion-' + index)
  assert.throws(() => store.createTicket({ title: 'bad', acceptance: tooMany }), /at most 50/)
  assert.equal(store.createTicket({ title: 'next' }).key, 'B-2')
})

test('a stored board with too many acceptance criteria clamps on load', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      board: { name: 'Clamp' },
      nextKey: 2,
      tickets: [
        {
          id: 't-1',
          key: 'B-1',
          title: 'many criteria',
          status: 'backlog',
          activity: [],
          acceptance: Array.from({ length: 60 }, (_, index) => 'item-' + index),
        },
      ],
    }),
  )
  assert.equal(createBoardStore({ file }).find('B-1').acceptance.length, 50)
})

test('a comment records delivery in the same write', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  const store = createBoardStore({ file })
  const ticket = store.createTicket({ title: 'one write' })
  store.commentTicket({ id: ticket.id, text: 'deliver me', by: 'human', deliveredTo: 'run-9' })
  assert.equal(readBoard(dir).tickets[0].activity.at(-1).deliveredTo, 'run-9')
})

test('dependencies are validated (unknown, self, cycle) and persisted', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  const store = createBoardStore({ file })
  const first = store.createTicket({ title: 'first' })
  const second = store.createTicket({ title: 'second', blockedBy: first.key })
  assert.deepEqual(second.blockedBy, [first.id])
  assert.throws(() => store.createTicket({ title: 'bad', blockedBy: 'nope' }), /unknown dependency/)
  assert.throws(() => store.updateTicket({ id: first.id, blockedBy: 'B-1' }), /unknown dependency|itself/)
  assert.throws(() => store.updateTicket({ id: first.id, blockedBy: second.key }), /dependency cycle/)
  assert.deepEqual(createBoardStore({ file }).find(second.id).blockedBy, [first.id])
})

test('priority, wall-clock budget and archive persist', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  const store = createBoardStore({ file })
  const ticket = store.createTicket({ title: 'planning', priority: 3, budgetMinutes: 15 })
  assert.equal(ticket.priority, 3)
  assert.equal(ticket.budget.minutes, 15)
  store.updateTicket({ id: ticket.id, priority: 7, budgetMinutes: 0 })
  assert.equal(store.find(ticket.id).priority, 7)
  assert.equal(store.find(ticket.id).budget.minutes, null)
  store.setArchived(ticket.id, true, 'human')
  assert.ok(store.find(ticket.id).archivedAt)
  assert.equal(createBoardStore({ file }).find(ticket.id).archivedAt !== null, true)
  store.setArchived(ticket.id, false, 'human')
  assert.equal(createBoardStore({ file }).find(ticket.id).archivedAt, null)
})

test('activity and artifacts are capped on append and load', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  const store = createBoardStore({ file })
  const ticket = store.createTicket({ title: 'caps' })
  for (let index = 0; index < 520; index += 1) store.commentTicket({ id: ticket.id, text: 'note ' + index, by: 'human' })
  assert.equal(store.find(ticket.id).activity.length, 500)
  assert.match(store.find(ticket.id).activity.at(-1).text, /note 519/)
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      board: { name: 'Caps' },
      nextKey: 2,
      tickets: [
        {
          id: 't-1',
          key: 'B-1',
          title: 'loaded caps',
          status: 'backlog',
          activity: Array.from({ length: 600 }, (_, index) => ({ at: '2026-01-01T00:00:00.000Z', by: 'human', kind: 'comment', text: 'x' + index })),
          artifacts: Array.from({ length: 150 }, (_, index) => ({ kind: 'link', uri: 'u' + index, label: 'l' })),
        },
      ],
    }),
  )
  const loaded = createBoardStore({ file })
  assert.equal(loaded.find('B-1').activity.length, 500)
  assert.equal(loaded.find('B-1').artifacts.length, 100)
})

test('health reports cycle time, reviews and tokens per merge', () => {
  const dir = tempDir()
  const store = createBoardStore({ file: boardFile(dir) })
  const ticket = store.createTicket({ title: 'health' })
  store.updateTicket({ id: ticket.id, status: 'ready' })
  store.updateTicket({ id: ticket.id, status: 'in_progress' })
  const run = store.addRun(ticket, { status: 'approved' })
  store.patchRun(run, { tokens: 1000, merge: { short: 'abc1234', baseBranch: 'main' } })
  store.closeRun(ticket, run, 'approved', null)
  store.updateTicket({ id: ticket.id, status: 'in_review' })
  store.updateTicket({ id: ticket.id, status: 'done' })
  const health = store.health()
  assert.equal(health.done, 1)
  assert.equal(health.reviewsPerTicket, 1)
  assert.equal(health.mergedCommits, 1)
  assert.equal(health.tokensPerMerge, 1000)
  assert.ok(health.cycleHours !== null)
})

test('a failed save at the activity cap keeps the oldest events and restores Slice 3 fields', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  const store = createBoardStore({ file })
  const ticket = store.createTicket({ title: 'cap rollback' })
  const seed = Array.from({ length: 500 }, (_, index) => ({ at: '2026-01-01T00:00:00.000Z', by: 'human', kind: 'comment', text: 'old-' + index }))
  ticket.activity = seed
  store.save()
  chmodSync(dir, 0o500)
  try {
    assert.throws(() => store.commentTicket({ id: ticket.id, text: 'new comment', by: 'human' }))
    assert.throws(() => store.updateTicket({ id: ticket.id, priority: 9, blockedBy: [], budgetMinutes: 2 }))
  } finally {
    chmodSync(dir, 0o700)
  }
  assert.equal(store.find(ticket.id).activity.length, 500)
  assert.equal(store.find(ticket.id).activity[0].text, 'old-0')
  assert.equal(store.find(ticket.id).priority, 0)
  assert.equal(store.find(ticket.id).budget.minutes, null)
})

test('archiving refuses an active or unmerged ticket without force', () => {
  const dir = tempDir()
  const store = createBoardStore({ file: boardFile(dir) })
  const ticket = store.createTicket({ title: 'guarded' })
  const run = store.addRun(ticket, { status: 'awaiting_review' })
  assert.throws(() => store.setArchived(ticket.id, true, 'human'), /active run/)
  store.closeRun(ticket, run, 'rejected', 'gave up')
  store.patchRun(run, { worktree: { path: '/tmp/x', branch: 'board/x', baseCommit: 'abc' } })
  assert.throws(() => store.setArchived(ticket.id, true, 'human'), /unmerged run branch/)
  store.setArchived(ticket.id, true, 'human', { force: true })
  assert.ok(store.find(ticket.id).archivedAt)
})

test('a blocked ticket cannot be claimed before its dependencies are done', () => {
  const dir = tempDir()
  const store = createBoardStore({ file: boardFile(dir) })
  const dependency = store.createTicket({ title: 'dependency' })
  const dependent = store.createTicket({ title: 'dependent', blockedBy: dependency.key })
  assert.throws(() => store.claimTicket({ id: dependent.id }, 'agent-1'), /blocked by 1 ticket/)
  store.updateTicket({ id: dependency.id, status: 'ready' })
  store.updateTicket({ id: dependency.id, status: 'in_progress' })
  store.updateTicket({ id: dependency.id, status: 'in_review' })
  store.updateTicket({ id: dependency.id, status: 'done' })
  store.claimTicket({ id: dependent.id }, 'agent-1')
  assert.equal(store.find(dependent.id).assignee, 'agent-1')
})

test('a v1 board migrates to schema 2 with doneAt and metrics', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      board: { name: 'Old' },
      nextKey: 2,
      tickets: [
        {
          id: 't-1',
          key: 'B-1',
          title: 'old done',
          status: 'done',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
          activity: [{ at: '2026-01-02T00:00:00.000Z', by: 'human', kind: 'gate', text: 'approved → Done' }],
        },
      ],
    }),
  )
  const store = createBoardStore({ file })
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 2)
  assert.equal(store.find('B-1').doneAt, '2026-01-02T00:00:00.000Z')
  assert.equal(store.state.metrics.length, 0)
})

test('repeated saves rotate numbered backups', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  const store = createBoardStore({ file, backupCount: 3 })
  store.createTicket({ title: 'one' })
  store.save()
  store.save()
  store.save()
  const backups = readdirSync(dir).filter(name => name.startsWith('board.json.bak')).sort()
  assert.deepEqual(backups, ['board.json.bak', 'board.json.bak.1', 'board.json.bak.2', 'board.json.bak.3'])
})

test('completions are recorded as metrics and surface as 7-day throughput', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  const store = createBoardStore({ file })
  const ticket = store.createTicket({ title: 'metric' })
  store.updateTicket({ id: ticket.id, status: 'ready' })
  store.updateTicket({ id: ticket.id, status: 'in_progress' })
  const run = store.addRun(ticket, { status: 'done', tokens: 500 })
  store.closeRun(ticket, run, 'done', null)
  store.updateTicket({ id: ticket.id, status: 'in_review' })
  store.updateTicket({ id: ticket.id, status: 'done' })
  assert.equal(store.state.metrics.length, 1)
  assert.equal(store.state.metrics[0].key, 'B-1')
  assert.equal(store.state.metrics[0].tokens, 500)
  assert.equal(store.health().throughput7d, 1)
  assert.equal(createBoardStore({ file }).state.metrics.length, 1)
})

test('review verdicts are gate-only and plan checks become trusted', () => {
  const dir = tempDir()
  const store = createBoardStore({ file: boardFile(dir) })
  const ticket = store.createTicket({ title: 'trusted checks' })
  assert.throws(() => store.setReview(ticket.id, { verdict: 'approved' }), /reviews are accepted only at/)
  store.updateTicket({ id: ticket.id, status: 'ready' })
  store.updateTicket({ id: ticket.id, status: 'in_progress' })
  store.updateTicket({ id: ticket.id, status: 'in_review' })
  store.setReview(ticket.id, { verdict: 'approved', notes: 'looks good', reviewer: 'r-1' })
  const reviewed = store.find(ticket.id)
  assert.equal(reviewed.review.verdict, 'approved')
  assert.equal(reviewed.review.notes, 'looks good')
  assert.equal(reviewed.review.reviewer, 'r-1')
  store.updateTicket({ id: ticket.id, checks: 'unit :: echo ok' })
  assert.equal(store.find(ticket.id).checks[0].source, 'human')

  const planned = store.createTicket({ title: 'planned checks' })
  store.startPlanning(planned.id, 'session-plan')
  store.submitPlan(planned.id, { markdown: '# plan', checks: 'unit :: echo ok' }, 'session-plan')
  store.approvePlan(planned.id)
  assert.equal(store.find(planned.id).checks[0].source, 'plan')
})

test('insights aggregate live tickets, runs and checks', () => {
  const dir = tempDir()
  const store = createBoardStore({ file: boardFile(dir) })
  const ticket = store.createTicket({ title: 'measured' })
  const run = store.addRun(ticket, { status: 'failed', sessionId: 'session-1' })
  store.patchRun(run, { checks: [{ name: 'unit', command: 'echo ok', exitCode: 1 }] })
  const report = store.insights()
  assert.equal(report.tickets, 1)
  assert.equal(report.byStatus.backlog, 1)
  assert.equal(report.runsTotal, 1)
  assert.equal(report.runsFailed, 1)
  assert.equal(report.failedRunRate, 1)
  assert.equal(report.checksRan, 1)
  assert.equal(report.checksFailed, 1)
  assert.equal(report.checksPassRate, 0)
})

test('sqlite guards a second writer, exports JSON and exposes query columns', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  const sqliteFile = join(dir, 'board.sqlite')
  const first = createBoardStore({ file, backend: 'sqlite', sqliteFile })
  const ticket = first.createTicket({ title: 'row one', assignee: 'coder' })
  const second = createBoardStore({ file, backend: 'sqlite', sqliteFile })

  first.updateTicket({ id: ticket.id, status: 'ready' })
  assert.throws(() => second.createTicket({ title: 'must not clobber' }), /changed in another process/)
  assert.equal(second.list().some(item => item.title === 'must not clobber'), false)

  const reopened = createBoardStore({ file, backend: 'sqlite', sqliteFile })
  assert.equal(reopened.list().length, 1)
  assert.equal(reopened.find(ticket.id).status, 'ready')

  const exportPath = join(dir, 'exported.json')
  reopened.exportJson(exportPath)
  const exported = JSON.parse(readFileSync(exportPath, 'utf8'))
  assert.equal(exported.tickets.length, 1)
  assert.equal(exported.tickets[0].key, ticket.key)
  assert.equal(exported.version, 2)

  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(sqliteFile)
  try {
    const row = db.prepare('SELECT key, status, assignee, plan_status, archived, priority FROM tickets WHERE id = ?').get(ticket.id)
    assert.equal(row.key, ticket.key)
    assert.equal(row.status, 'ready')
    assert.equal(row.assignee, 'coder')
    assert.equal(row.plan_status, null)
    assert.equal(row.archived, 0)
    assert.equal(row.priority, 0)
  } finally {
    db.close()
  }
})

test('the sqlite backend imports board.json and persists across instances', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  const sqliteFile = join(dir, 'board.sqlite')

  const jsonStore = createBoardStore({ file })
  const imported = jsonStore.createTicket({ title: 'from json', assignee: 'coder' })

  const store = createBoardStore({ file, backend: 'sqlite', sqliteFile })
  assert.equal(store.find(imported.id).title, 'from json')
  const added = store.createTicket({ title: 'sqlite native' })
  store.addNotification('test', added, 'persist me')

  const reopened = createBoardStore({ file, backend: 'sqlite', sqliteFile })
  assert.equal(reopened.list().length, 2)
  assert.equal(reopened.find(added.id).title, 'sqlite native')
  assert.equal(reopened.notifications().length, 1)
  assert.equal(reopened.state.nextKey, 3)
  assert.equal(existsSync(sqliteFile), true)
  assert.equal(existsSync(`${sqliteFile}.bak`), true)
})

test('the plan lifecycle gates readiness and decomposes into subtasks', () => {
  const dir = tempDir()
  const store = createBoardStore({ file: boardFile(dir) })
  const ticket = store.createTicket({ title: 'planned work', assignee: 'coder' })
  assert.throws(() => store.approvePlan(ticket.id), /no plan/)
  store.startPlanning(ticket.id, 'session-plan')
  const submitted = store.submitPlan(
    ticket.id,
    {
      markdown: '# Plan\nDo the thing.',
      acceptance: 'works\ndocumented',
      decomposition: [
        { title: 'first slice', description: 'a' },
        { title: 'second slice', description: 'b', blockedBy: [1] },
      ],
    },
    'session-plan',
  )
  assert.equal(submitted.version, 1)
  assert.equal(submitted.status, 'submitted')
  assert.equal(submitted.decomposition.length, 2)
  store.requestPlanChanges(ticket.id, 'split the API work out', 'human')
  assert.equal(store.find(ticket.id).plan.status, 'draft')
  assert.deepEqual(store.find(ticket.id).plan.feedback, ['split the API work out'])
  store.submitPlan(ticket.id, { markdown: '# Plan v2', decomposition: [
    { title: 'API', description: 'endpoint' },
    { title: 'UI', description: 'screen', blockedBy: [1] },
  ] }, 'session-plan')
  store.approvePlan(ticket.id, 'human')
  const approved = store.find(ticket.id)
  assert.equal(approved.plan.status, 'approved')
  assert.equal(approved.status, 'ready')
  assert.equal(approved.subtaskIds.length, 2)
  const children = approved.subtaskIds.map(id => store.find(id))
  assert.deepEqual(children.map(child => child.key), ['B-2', 'B-3'])
  assert.equal(children[1].blockedBy.includes(children[0].id), true)
  assert.equal(children[0].parentId, ticket.id)
  assert.equal(store.find(ticket.id).subtaskIds.length, 2)
})

test('a parent ticket completes when all its subtasks are done', () => {
  const dir = tempDir()
  const store = createBoardStore({ file: boardFile(dir) })
  const parent = store.createTicket({ title: 'umbrella' })
  store.startPlanning(parent.id, 'session-plan')
  store.submitPlan(parent.id, { markdown: '# plan', decomposition: [{ title: 'only child' }] }, 'session-plan')
  store.approvePlan(parent.id, 'human')
  const child = store.find(store.find(parent.id).subtaskIds[0])
  assert.equal(store.completeParentIfReady(child.id), false)
  store.updateTicket({ id: child.id, status: 'in_progress' })
  store.updateTicket({ id: child.id, status: 'in_review' })
  store.updateTicket({ id: child.id, status: 'done' })
  assert.equal(store.find(parent.id).status, 'done')
  assert.ok(store.find(parent.id).doneAt)
})

test('the load warning is exposed to clients', () => {
  const dir = tempDir()
  writeFileSync(boardFile(dir), '{"tickets": [')
  const store = createBoardStore({ file: boardFile(dir) })
  assert.ok(existsSync(join(dir, quarantineOf(dir))))
  assert.match(store.snapshot().board.warning, /unreadable/)
})

test('journal backend replays deltas, tolerates a bad line and compacts', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  const journalFile = `${file}.journal`
  const store = createBoardStore({ file, backend: 'journal', journalCompactionLines: 1000 })
  const ticket = store.createTicket({ title: 'journaled', assignee: 'coder' })
  store.updateTicket({ id: ticket.id, status: 'ready' })
  assert.equal(existsSync(journalFile), true)
  assert.equal(existsSync(file), false, 'no snapshot is written before compaction')

  const reopened = createBoardStore({ file, backend: 'journal', journalCompactionLines: 1000 })
  assert.equal(reopened.find(ticket.id).status, 'ready')

  appendFileSync(journalFile, '{"broken":\n')
  const tolerant = createBoardStore({ file, backend: 'journal', journalCompactionLines: 1000 })
  assert.match(tolerant.loadWarning, /unreadable line/)
  assert.equal(tolerant.find(ticket.id).status, 'ready')

  const compactor = createBoardStore({ file, backend: 'journal', journalCompactionLines: 1 })
  compactor.updateTicket({ id: ticket.id, title: 'renamed' })
  assert.equal(existsSync(file), true)
  assert.equal(readFileSync(journalFile, 'utf8'), '')
  const reread = createBoardStore({ file, backend: 'journal', journalCompactionLines: 1000 })
  assert.equal(reread.find(ticket.id).title, 'renamed')
})

test('journal backend refuses a second writer instead of interleaving deltas', () => {
  const dir = tempDir()
  const file = boardFile(dir)
  const first = createBoardStore({ file, backend: 'journal', journalCompactionLines: 1000 })
  const ticket = first.createTicket({ title: 'first writer' })
  const second = createBoardStore({ file, backend: 'journal', journalCompactionLines: 1000 })

  first.updateTicket({ id: ticket.id, title: 'first writer renamed' })
  assert.throws(() => second.createTicket({ title: 'must not interleave' }), /changed in another process/)
  assert.equal(second.list().some(item => item.title === 'must not interleave'), false)

  const reopened = createBoardStore({ file, backend: 'journal', journalCompactionLines: 1000 })
  assert.equal(reopened.find(ticket.id).title, 'first writer renamed')
  assert.equal(reopened.list().length, 1)
})
