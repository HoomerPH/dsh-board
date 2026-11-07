/**
 * Client bundle unit tests. The bundle registers itself with the Harness module
 * loader; importing it here captures that definition, then a fake React renders
 * the pure helpers without a DOM.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const captured = {}
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured.definition = definition
      return definition
    },
  },
}

const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children }
  },
  useState: value => [value, () => {}],
  useEffect: () => {},
  useMemo: factory => factory(),
  useRef: value => ({ current: value }),
}

await import('../lib/client.js')

function clientExports() {
  const definition = captured.definition
  assert.ok(definition && typeof definition.factory === 'function', 'the client bundle registered a factory')
  return definition.factory(name => {
    if (name === 'react') return fakeReact
    throw new Error('unexpected require: ' + name)
  })
}

test('csvCell quotes commas, quotes and newlines', () => {
  const { csvCell } = clientExports().__test
  assert.equal(csvCell('plain'), 'plain')
  assert.equal(csvCell('a,b'), '"a,b"')
  assert.equal(csvCell('say "hi"'), '"say ""hi"""')
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"')
  assert.equal(csvCell(undefined), '')
})

test('ticketsToCsv emits a header and one row per ticket', () => {
  const { ticketsToCsv } = clientExports().__test
  const csv = ticketsToCsv([
    { key: 'B-1', title: 'first, with comma', status: 'ready', assignee: 'coder', planStatus: 'approved', priority: 2, blockedBy: ['x'] },
    { key: 'B-2', title: 'second', status: 'backlog', assignee: null, planStatus: null, priority: 0, blockedBy: [] },
  ])
  const lines = csv.trim().split('\n')
  assert.equal(lines[0], 'key,title,status,assignee,plan,priority,blocked_by,updated')
  assert.equal(lines.length, 3)
  assert.match(lines[1], /^B-1,"first, with comma",ready,coder,approved,2,1,/)
})

test('renderInline handles bold, code and ticket links', () => {
  const { renderInline } = clientExports().__test
  const opened = []
  const parts = renderInline('use **bold** `code` and B-3', key => opened.push(key))
  const strong = parts.find(part => part && part.type === 'strong')
  const code = parts.find(part => part && part.type === 'code')
  const link = parts.find(part => part && part.type === 'button')
  assert.equal(strong.children[0], 'bold')
  assert.equal(code.props.className, 'dshb-md-inline')
  assert.equal(link.children[0], 'B-3')
  link.props.onClick()
  assert.deepEqual(opened, ['B-3'])
})

test('renderMarkdown renders headings, bullets and fenced code', () => {
  const { renderMarkdown } = clientExports().__test
  const blocks = renderMarkdown('## Title\n- item\n```\nline\n```', null)
  assert.equal(blocks[0].props.className, 'dshb-md-h2')
  assert.equal(blocks[1].props.className, 'dshb-md-li')
  assert.equal(blocks[2].props.className, 'dshb-md-code')
  assert.equal(blocks[2].children[0], 'line')
})

function nodeText(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  return (node.children ?? []).map(nodeText).join('')
}

test('TicketCard renders status chips, focus/selection and click behavior', () => {
  const { TicketCard } = clientExports().__test
  const ticket = {
    id: 't-7',
    key: 'B-7',
    title: 'Card title',
    status: 'in_review',
    assignee: 'coder',
    planStatus: 'submitted',
    subtaskCount: 2,
    priority: 2,
    blockedBy: ['dep-1', 'dep-2'],
    activityCount: 5,
    updatedAt: new Date().toISOString(),
    runs: [{ status: 'awaiting_review', checks: [{ name: 'unit', exitCode: 1 }], checksFailed: 1, checksRan: 1 }],
  }
  const opened = []
  const toggled = []
  const card = TicketCard({
    ticket,
    queued: true,
    queuePosition: 1,
    focused: true,
    selectMode: true,
    selected: true,
    onToggle: id => toggled.push(id),
    onOpen: id => opened.push(id),
  })
  const className = card.props.className
  assert.match(className, /dshb-card/)
  assert.match(className, /dshb-card-focused/)
  assert.match(className, /dshb-card-selected/)
  const text = nodeText(card)
  assert.match(text, /B-7/)
  assert.match(text, /Card title/)
  assert.match(text, /plan review/)
  assert.match(text, /2 subtasks/)
  assert.match(text, /blocked by 2/)
  assert.match(text, /checks ✗/)
  assert.match(text, /#1 queued/)
  assert.match(text, /@coder/)

  card.props.onClick()
  assert.deepEqual(toggled, ['t-7'])
  assert.deepEqual(opened, [])

  const normal = TicketCard({ ticket, onOpen: id => opened.push(id) })
  normal.props.onClick()
  assert.deepEqual(opened, ['t-7'])
  assert.doesNotMatch(normal.props.className, /dshb-card-selected/)
})
