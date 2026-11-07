#!/usr/bin/env node
/**
 * Offline checks for the board store and workflow model.
 *
 * No Harness boot, no model calls: these assert the invariants the plugin
 * depends on. Run with `node scripts/check.mjs` (or `npm run check`).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBoardStore, normalizeWorkflow, DEFAULT_WORKFLOW } from '../lib/store.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-board-check-'))
const results = []

function check(name, run) {
  try {
    run()
    results.push({ name, ok: true })
    console.log(`ok   ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error: error.message })
    console.log(`FAIL ${name}: ${error.message}`)
  }
}

check('default workflow keeps its roles', () => {
  const workflow = normalizeWorkflow({})
  assert.equal(workflow.initial, DEFAULT_WORKFLOW.initial)
  assert.equal(workflow.dispatch, 'ready')
  assert.equal(workflow.gate, 'in_review')
  assert.equal(workflow.done, 'done')
  assert.equal(workflow.blocked, 'blocked')
})

check('a custom workflow without roles falls back to first/last state', () => {
  const workflow = normalizeWorkflow({ states: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })
  assert.equal(workflow.initial, 'a')
  assert.equal(workflow.dispatch, 'a')
  assert.equal(workflow.gate, 'c')
  assert.equal(workflow.done, 'c')
})

check('duplicate state ids are rejected', () => {
  assert.throws(() => normalizeWorkflow({ states: [{ id: 'x' }, { id: 'x' }] }), /unique/)
})

check('transitions are enforced on updates', () => {
  const store = createBoardStore({
    file: join(dir, 'transitions.json'),
    workflow: normalizeWorkflow({
      states: [{ id: 'triage', label: 'Triage' }, { id: 'queued', label: 'Queued' }, { id: 'building', label: 'Building' }],
      initial: 'triage',
      dispatch: 'queued',
      transitions: { triage: ['queued'], queued: ['building'], building: [] },
    }),
  })
  const ticket = store.createTicket({ title: 'transition test', by: 'test' })
  assert.equal(ticket.status, 'triage')
  assert.throws(() => store.updateTicket({ id: ticket.id, status: 'building', by: 'test' }), /illegal transition/)
  store.updateTicket({ id: ticket.id, status: 'queued', by: 'test' })
  assert.equal(store.find(ticket.id).status, 'queued')
})

check('unknown statuses migrate to the initial state on load', () => {
  const file = join(dir, 'migrate.json')
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      board: { name: 'Migrate' },
      nextKey: 2,
      tickets: [
        {
          id: 't1',
          key: 'B-1',
          title: 'old ticket',
          status: 'in_review',
          assignee: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          activity: [],
        },
      ],
    }),
  )
  const store = createBoardStore({
    file,
    workflow: normalizeWorkflow({ states: [{ id: 'triage', label: 'Triage' }, { id: 'shipped', label: 'Shipped' }], initial: 'triage' }),
  })
  const migrated = store.find('B-1')
  assert.equal(migrated.status, 'triage')
  const note = migrated.activity.at(-1)
  assert.equal(note.kind, 'migrated')
  assert.match(note.text, /in_review/)
  const persisted = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(persisted.tickets[0].status, 'triage')
})

check('snapshot exposes states, roles, and queue-free board shape', () => {
  const store = createBoardStore({ file: join(dir, 'snapshot.json') })
  const snapshot = store.snapshot()
  assert.equal(Array.isArray(snapshot.board.states), true)
  assert.equal(snapshot.board.workflow.gate, 'in_review')
  assert.equal(snapshot.board.workflow.dispatch, 'ready')
  assert.equal(Array.isArray(snapshot.tickets), true)
})

check('state labels are used in activity text', () => {
  const store = createBoardStore({
    file: join(dir, 'labels.json'),
    workflow: normalizeWorkflow({
      states: [{ id: 'triage', label: 'Triage' }, { id: 'review', label: 'Review' }],
      gate: 'review',
    }),
  })
  const ticket = store.createTicket({ title: 'label test', by: 'test' })
  store.updateTicket({ id: ticket.id, status: 'review', by: 'test' })
  assert.match(ticket.activity.at(-1).text, /Triage → Review/)
})

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
