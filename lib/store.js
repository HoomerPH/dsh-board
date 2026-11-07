/**
 * Durable ticket store for dsh-board.
 *
 * One JSON document holds the board, its tickets, their activity log, and the
 * run history. Every mutation goes through this module so the HTTP action route
 * and the model tools share one state machine.
 *
 * The workflow is per-board configuration: states, display labels, semantic
 * roles (initial / dispatch / active / gate / done / blocked), and optional
 * allowed transitions. Older tickets whose status is not part of a changed
 * workflow are migrated to the initial state with a recorded activity event.
 *
 * Durability rules (Slice 0):
 *   - an unreadable board.json is never treated as an empty board: it is moved
 *     aside (`.corrupt-<stamp>`), the last good `.bak` is restored when it can
 *     be, and the reason is surfaced as `loadWarning`;
 *   - every save is guarded by the (mtime, size) of the file the store loaded,
 *     so a second writer on the same dataDir fails loudly instead of clobbering
 *     tickets;
 *   - writes go to a unique temp file, are fsynced, then renamed into place, and
 *     the previous good file is kept as `board.json.bak`;
 *   - a mutation is validated before it is applied and rolled back if the write
 *     fails, so a rejected action never leaks half a change into the next save.
 */
import { copyFileSync, existsSync, fsyncSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

export const SCHEMA_VERSION = 2

export const DEFAULT_WORKFLOW = {
  states: [
    { id: 'backlog', label: 'Backlog' },
    { id: 'ready', label: 'Ready' },
    { id: 'in_progress', label: 'In Progress' },
    { id: 'in_review', label: 'In Review' },
    { id: 'done', label: 'Done' },
    { id: 'blocked', label: 'Blocked' },
  ],
  initial: 'backlog',
  dispatch: 'ready',
  active: 'in_progress',
  gate: 'in_review',
  done: 'done',
  blocked: 'blocked',
  transitions: null,
}

export const now = () => new Date().toISOString()

/** Validate and normalize a workflow definition; unknown roles fall back to the first/last state. */
export function normalizeWorkflow(input = {}) {
  const source = Array.isArray(input.states) && input.states.length ? input.states : DEFAULT_WORKFLOW.states
  const states = source.map(state => ({ id: String(state.id), label: String(state.label ?? state.id) }))
  const ids = states.map(state => state.id)
  if (new Set(ids).size !== ids.length) throw new Error('workflow states must have unique ids')
  if (!ids.every(id => id.trim())) throw new Error('workflow state ids must not be empty')
  const pick = (value, fallback) => (typeof value === 'string' && ids.includes(value) ? value : fallback)
  // Roles fall back to the default workflow's roles, then to the first/last state
  // (so a custom workflow that omits roles still resolves to ids it defines).
  const role = (value, fallback) => pick(value, fallback)
  const workflow = {
    states,
    initial: role(input.initial, pick(DEFAULT_WORKFLOW.initial, ids[0])),
    dispatch: role(input.dispatch, pick(DEFAULT_WORKFLOW.dispatch, ids[0])),
    active: role(input.active, pick(DEFAULT_WORKFLOW.active, ids[0])),
    gate: role(input.gate, pick(DEFAULT_WORKFLOW.gate, ids[ids.length - 1])),
    done: role(input.done, pick(DEFAULT_WORKFLOW.done, ids[ids.length - 1])),
    blocked: role(input.blocked, pick(DEFAULT_WORKFLOW.blocked, ids[ids.length - 1])),
    transitions: null,
  }
  if (input.transitions && typeof input.transitions === 'object') {
    const transitions = {}
    for (const [from, targets] of Object.entries(input.transitions)) {
      if (!ids.includes(from) || !Array.isArray(targets)) continue
      transitions[from] = targets.filter(target => ids.includes(target))
    }
    workflow.transitions = transitions
  }
  return workflow
}

/** Accept an array or newline text of acceptance criteria. */
function normalizeAcceptance(input) {
  if (input === undefined || input === null || input === '') return []
  const list = Array.isArray(input) ? input : String(input).split('\n')
  return list
    .map(item => String(item).replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean)
}

/** Normalize one check definition; strings accept "name :: command [:: timeoutMs]". */
function normalizeCheck(entry) {
  if (typeof entry === 'string') {
    const parts = entry.split('::').map(part => part.trim())
    const [maybeName, maybeCommand, maybeTimeout] = parts
    const command = maybeCommand || maybeName
    if (!command) return null
    const name = maybeCommand ? maybeName || command.slice(0, 40) : command.slice(0, 40)
    const timeoutMs = Number(maybeTimeout) > 0 ? Number(maybeTimeout) : null
    return { name, command, timeoutMs }
  }
  if (!entry || typeof entry !== 'object') return null
  const command = String(entry.command ?? '').trim()
  if (!command) return null
  const name = String(entry.name ?? '').trim() || command.slice(0, 40)
  const timeoutMs = Number(entry.timeoutMs) > 0 ? Number(entry.timeoutMs) : null
  const source = ['human', 'plan', 'agent'].includes(entry.source) ? entry.source : null
  return source ? { name, command, timeoutMs, source } : { name, command, timeoutMs }
}

/** Accept an array or newline-separated text of checks (max 20). */
export function normalizeChecks(input, { strict = true } = {}) {
  if (input === undefined || input === null || input === '') return []
  const list = Array.isArray(input)
    ? input
    : String(input)
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
  const checks = list.map(normalizeCheck).filter(Boolean)
  if (checks.length > 20) {
    // Stored boards may predate the cap; boot must clamp, user input must fail.
    if (!strict) return checks.slice(0, 20)
    throw new Error('a ticket can hold at most 20 checks')
  }
  return checks
}

const ACTIVITY_CAP = 500
const ARTIFACT_CAP = 100
const RUN_CAP = 200

const PLAN_STATES = ['draft', 'submitted', 'approved']

function normalizePlan(input) {
  if (!input || typeof input !== 'object') return null
  const status = PLAN_STATES.includes(input.status) ? input.status : 'draft'
  const decomposition = Array.isArray(input.decomposition)
    ? input.decomposition.slice(0, 10).map(item => ({
        title: String(item?.title ?? '').trim(),
        description: String(item?.description ?? ''),
        acceptance: normalizeAcceptance(item?.acceptance),
        checks: normalizeChecks(item?.checks, { strict: false }),
        blockedBy: Array.isArray(item?.blockedBy)
          ? item.blockedBy.map(Number).filter(index => Number.isInteger(index) && index >= 1)
          : [],
      })).filter(item => item.title)
    : []
  return {
    status,
    version: Number(input.version) || 0,
    markdown: String(input.markdown ?? ''),
    acceptance: normalizeAcceptance(input.acceptance),
    decomposition,
    checks: normalizeChecks(input.checks, { strict: false }),
    sessionId: input.sessionId ? String(input.sessionId) : null,
    feedback: Array.isArray(input.feedback) ? input.feedback.slice(-20).map(String) : [],
    submittedAt: input.submittedAt ?? null,
    approvedAt: input.approvedAt ?? null,
  }
}

function normalizeTicket(ticket) {
  ticket.acceptance = Array.isArray(ticket.acceptance) ? ticket.acceptance.slice(0, 50) : []
  ticket.checks = normalizeChecks(ticket.checks, { strict: false })
  ticket.activity = Array.isArray(ticket.activity) ? ticket.activity.slice(-ACTIVITY_CAP) : []
  ticket.artifacts = Array.isArray(ticket.artifacts) ? ticket.artifacts.slice(-ARTIFACT_CAP) : []
  ticket.runs = Array.isArray(ticket.runs) ? ticket.runs.slice(-RUN_CAP) : []
  ticket.currentRunId = ticket.currentRunId ?? null
  ticket.blockedBy = Array.isArray(ticket.blockedBy) ? ticket.blockedBy.map(String) : []
  ticket.priority = Number.isFinite(Number(ticket.priority)) ? Number(ticket.priority) : 0
  ticket.queuedAt = ticket.queuedAt ?? null
  ticket.archivedAt = ticket.archivedAt ?? null
  ticket.doneAt = ticket.doneAt ?? null
  ticket.plan = normalizePlan(ticket.plan)
  ticket.needsInput = ticket.needsInput && ticket.needsInput.question ? {
    question: String(ticket.needsInput.question),
    sessionId: ticket.needsInput.sessionId ? String(ticket.needsInput.sessionId) : null,
    runId: ticket.needsInput.runId ? String(ticket.needsInput.runId) : null,
    at: ticket.needsInput.at ?? now(),
  } : null
  ticket.reviewSessionId = ticket.reviewSessionId ? String(ticket.reviewSessionId) : null
  ticket.teamTaskId = ticket.teamTaskId ? String(ticket.teamTaskId) : null
  ticket.teamTaskRevision = Number.isFinite(Number(ticket.teamTaskRevision)) ? Number(ticket.teamTaskRevision) : null
  ticket.review =
    ticket.review && ['approved', 'changes_requested'].includes(ticket.review.verdict)
      ? {
          verdict: ticket.review.verdict,
          notes: String(ticket.review.notes ?? ''),
          reviewer: ticket.review.reviewer ? String(ticket.review.reviewer) : null,
          at: ticket.review.at ?? now(),
        }
      : null
  ticket.pendingAnswer = ticket.pendingAnswer && ticket.pendingAnswer.text ? {
    text: String(ticket.pendingAnswer.text),
    sessionId: ticket.pendingAnswer.sessionId ? String(ticket.pendingAnswer.sessionId) : null,
  } : null
  ticket.parentId = ticket.parentId ?? null
  ticket.subtaskIds = Array.isArray(ticket.subtaskIds) ? ticket.subtaskIds.map(String) : []
  ticket.budget = ticket.budget && typeof ticket.budget === 'object' ? ticket.budget : {}
  ticket.budget.tokens = Number(ticket.budget.tokens) > 0 ? Number(ticket.budget.tokens) : null
  ticket.budget.minutes = Number(ticket.budget.minutes) > 0 ? Number(ticket.budget.minutes) : null
  return ticket
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')
const keyNumber = key => {
  const match = /-(\d+)$/.exec(String(key ?? ''))
  return match ? Number(match[1]) : 0
}

function hashOf(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

function statOf(file) {
  try {
    const stat = statSync(file)
    return { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, ctimeMs: stat.ctimeMs }
  } catch {
    return null
  }
}

function readJson(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || !Array.isArray(parsed.tickets)) return { error: 'document has no tickets array' }
    return { data: parsed }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function fsyncFile(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    fsyncSync(fd)
  } catch {
    /* fsync is best-effort on filesystems that refuse it */
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* closed already */
      }
    }
  }
}

function normalizeRefs(input) {
  if (input === undefined || input === null || input === '') return []
  const list = Array.isArray(input) ? input : String(input).split(/[,\s]+/)
  return list.map(item => String(item).trim()).filter(Boolean)
}

export function createBoardStore({
  file,
  boardName = 'Agent Sprint',
  workflow: workflowInput,
  onChange,
  backupCount = 3,
  backend = 'json',
  sqliteFile,
  journalFile,
  journalCompactionLines = 200,
} = {}) {
  const workflow = normalizeWorkflow(workflowInput ?? {})
  const sqlitePath = sqliteFile ?? (file ? String(file).replace(/\.json$/i, '.sqlite') : `${boardName.toLowerCase().replace(/\s+/g, '-')}.sqlite`)
  const openSqliteStore = () => {
    let DatabaseSync
    try {
      ;({ DatabaseSync } = require('node:sqlite'))
    } catch (error) {
      throw new Error(`node:sqlite is not available (${error instanceof Error ? error.message : String(error)})`)
    }
    mkdirSync(dirname(sqlitePath), { recursive: true })
    const db = new DatabaseSync(sqlitePath)
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA synchronous = NORMAL;')
    db.exec('PRAGMA busy_timeout = 5000;')
    const integrity = db.prepare('PRAGMA integrity_check').get()
    if (integrity && integrity.integrity_check && integrity.integrity_check !== 'ok') {
      db.close()
      throw new Error(`sqlite integrity check failed: ${integrity.integrity_check}`)
    }
    // Rotate a backup of the (checkpointed) database on each open, mirroring board.json's .bak.
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
      if (backupCount > 0) {
        for (let index = backupCount; index >= 2; index -= 1) {
          const from = `${sqlitePath}.bak.${index - 1}`
          const to = `${sqlitePath}.bak.${index}`
          if (existsSync(from)) {
            try {
              renameSync(from, to)
            } catch {
              /* rotation is best-effort */
            }
          }
        }
        if (existsSync(`${sqlitePath}.bak`)) {
          try {
            renameSync(`${sqlitePath}.bak`, `${sqlitePath}.bak.1`)
          } catch {
            /* rotation is best-effort */
          }
        }
        if (existsSync(sqlitePath)) copyFileSync(sqlitePath, `${sqlitePath}.bak`)
      }
    } catch {
      /* the backup is best-effort; integrity already passed */
    }
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        key TEXT,
        position INTEGER NOT NULL,
        status TEXT NOT NULL,
        assignee TEXT,
        plan_status TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        priority INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, json TEXT NOT NULL);`)
    const columns = db.prepare('PRAGMA table_info(tickets)').all().map(column => column.name)
    for (const [name, declaration] of [
      ['key', 'TEXT'],
      ['assignee', 'TEXT'],
      ['plan_status', 'TEXT'],
      ['archived', 'INTEGER NOT NULL DEFAULT 0'],
      ['priority', 'INTEGER NOT NULL DEFAULT 0'],
    ]) {
      if (!columns.includes(name)) db.exec(`ALTER TABLE tickets ADD COLUMN ${name} ${declaration}`)
    }
    db.exec('CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets (status)')
    const schemaRow = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get()
    const schemaVersion = schemaRow ? Number(JSON.parse(schemaRow.value)) || 0 : 0
    if (schemaVersion < 2) {
      const update = db.prepare(
        'UPDATE tickets SET key = ?, assignee = ?, plan_status = ?, archived = ?, priority = ? WHERE id = ?',
      )
      for (const row of db.prepare('SELECT id, json FROM tickets').all()) {
        let ticket
        try {
          ticket = JSON.parse(row.json)
        } catch {
          continue
        }
        update.run(
          ticket.key ?? null,
          ticket.assignee ?? null,
          ticket.plan?.status ?? null,
          ticket.archivedAt ? 1 : 0,
          Number(ticket.priority) || 0,
          row.id,
        )
      }
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(2))
    }
    const revisionRow = db.prepare("SELECT value FROM meta WHERE key = 'revision'").get()
    const revision = revisionRow ? Number(JSON.parse(revisionRow.value)) || 0 : 0
    return {
      db,
      path: sqlitePath,
      revision,
      lastTickets: new Map(),
      lastNotifications: new Map(),
      lastBoard: null,
      lastMetrics: null,
    }
  }
  const journal =
    backend === 'journal'
      ? {
          path: journalFile ?? `${file}.journal`,
          lines: 0,
          size: null,
          lastTickets: new Map(),
          lastNotifications: null,
          lastMeta: null,
        }
      : null
  let sqlite = null
  if (backend === 'sqlite') {
    try {
      sqlite = openSqliteStore()
    } catch (error) {
      console.warn(`[board] sqlite backend unavailable (${error instanceof Error ? error.message : String(error)}); falling back to board.json`)
    }
  }

  function readSqliteMeta(key) {
    const row = sqlite.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
    return row ? JSON.parse(row.value) : null
  }

  function loadSqlite() {
    const warnings = []
    const board = readSqliteMeta('board')
    let data
    let needsPersist = false
    if (!board) {
      let imported = null
      if (file) {
        const primary = readJson(file)
        if (!primary.error) imported = primary.data
        else {
          const backup = readJson(`${file}.bak`)
          if (!backup.error) imported = backup.data
        }
        if (imported) warnings.push(`imported ${file} into ${sqlite.path}`)
      }
      data = imported ?? { version: SCHEMA_VERSION, board: { name: boardName }, nextKey: 1, tickets: [], metrics: [] }
      needsPersist = true
    } else {
      const tickets = sqlite.db.prepare('SELECT json FROM tickets ORDER BY position ASC').all().map(row => JSON.parse(row.json))
      const notifications = sqlite.db.prepare('SELECT json FROM notifications ORDER BY rowid ASC').all().map(row => JSON.parse(row.json))
      data = { ...board, tickets, notifications }
      sqlite.lastBoard = JSON.stringify({ version: board.version ?? SCHEMA_VERSION, board: board.board, nextKey: board.nextKey, metrics: board.metrics ?? [] })
      sqlite.lastMetrics = JSON.stringify(board.metrics ?? [])
      for (const ticket of tickets) sqlite.lastTickets.set(ticket.id, JSON.stringify(ticket))
      for (const item of notifications) sqlite.lastNotifications.set(item.id, JSON.stringify(item))
    }
    data.board = data.board ?? { name: boardName }
    return { data, migrated: false, warning: warnings.length ? warnings.join(' · ') : null, needsPersist }
  }

  function saveSqlite() {
    const db = sqlite.db
    const boardValue = JSON.stringify({ version: state.version ?? SCHEMA_VERSION, board: state.board, nextKey: state.nextKey, metrics: state.metrics ?? [] })
    const metricsValue = JSON.stringify(state.metrics ?? [])
    const upsertMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    const upsertTicket = db.prepare(
      `INSERT INTO tickets (id, key, position, status, assignee, plan_status, archived, priority, updated_at, json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         key = excluded.key, position = excluded.position, status = excluded.status,
         assignee = excluded.assignee, plan_status = excluded.plan_status,
         archived = excluded.archived, priority = excluded.priority,
         updated_at = excluded.updated_at, json = excluded.json`,
    )
    const deleteTicket = db.prepare('DELETE FROM tickets WHERE id = ?')
    const upsertNotification = db.prepare('INSERT INTO notifications (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json')
    const deleteNotification = db.prepare('DELETE FROM notifications WHERE id = ?')
    db.exec('BEGIN IMMEDIATE')
    try {
      const revisionRow = db.prepare("SELECT value FROM meta WHERE key = 'revision'").get()
      const storedRevision = revisionRow ? Number(JSON.parse(revisionRow.value)) || 0 : 0
      if (storedRevision !== sqlite.revision) {
        throw new Error(
          `board.sqlite changed in another process (revision ${sqlite.revision} → ${storedRevision}); restart this board before making changes`,
        )
      }
      if (boardValue !== sqlite.lastBoard) {
        upsertMeta.run('board', boardValue)
        sqlite.lastBoard = boardValue
      }
      if (metricsValue !== sqlite.lastMetrics) {
        upsertMeta.run('metrics', metricsValue)
        sqlite.lastMetrics = metricsValue
      }
      const keep = new Set()
      state.tickets.forEach((ticket, index) => {
        keep.add(ticket.id)
        const json = JSON.stringify(ticket)
        if (sqlite.lastTickets.get(ticket.id) !== json) {
          upsertTicket.run(
            ticket.id,
            ticket.key ?? null,
            index,
            ticket.status,
            ticket.assignee ?? null,
            ticket.plan?.status ?? null,
            ticket.archivedAt ? 1 : 0,
            Number(ticket.priority) || 0,
            ticket.updatedAt ?? null,
            json,
          )
          sqlite.lastTickets.set(ticket.id, json)
        }
      })
      for (const id of [...sqlite.lastTickets.keys()]) {
        if (!keep.has(id)) {
          deleteTicket.run(id)
          sqlite.lastTickets.delete(id)
        }
      }
      const notifications = Array.isArray(state.notifications) ? state.notifications : []
      const keepNotifications = new Set()
      for (const item of notifications) {
        keepNotifications.add(item.id)
        const json = JSON.stringify(item)
        if (sqlite.lastNotifications.get(item.id) !== json) {
          upsertNotification.run(item.id, json)
          sqlite.lastNotifications.set(item.id, json)
        }
      }
      for (const id of [...sqlite.lastNotifications.keys()]) {
        if (!keepNotifications.has(id)) {
          deleteNotification.run(id)
          sqlite.lastNotifications.delete(id)
        }
      }
      const nextRevision = sqlite.revision + 1
      upsertMeta.run('revision', JSON.stringify(nextRevision))
      sqlite.revision = nextRevision
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* rollback is best-effort */
      }
      throw error
    }
  }
  const stateIds = workflow.states.map(state => state.id)
  const stateIdSet = new Set(stateIds)
  let loadWarning = null
  let baseline = null

  /**
   * Load the board, quarantining a file that cannot be parsed instead of
   * silently starting empty (which the next save would then make permanent).
   */
  function loadJournal() {
    const warnings = []
    const primary = readJson(file)
    let data = primary.error ? null : primary.data
    if (!data) {
      const backup = readJson(`${file}.bak`)
      if (!backup.error) {
        data = backup.data
        warnings.push('restored the board snapshot from board.json.bak')
      }
    }
    if (!data) data = { version: SCHEMA_VERSION, board: { name: boardName }, nextKey: 1, tickets: [], metrics: [] }
    let lines = 0
    if (existsSync(journal.path)) {
      const text = readFileSync(journal.path, 'utf8')
      for (const rawLine of text.split('\n')) {
        if (!rawLine.trim()) continue
        let entry
        try {
          entry = JSON.parse(rawLine)
        } catch {
          warnings.push('the journal has an unreadable line; the rest of it was ignored')
          break
        }
        if (entry.meta) {
          data.version = entry.meta.version ?? data.version
          data.board = entry.meta.board ?? data.board
          data.nextKey = entry.meta.nextKey ?? data.nextKey
          data.metrics = Array.isArray(entry.meta.metrics) ? entry.meta.metrics : data.metrics
        }
        if (Array.isArray(entry.upserts)) {
          for (const ticket of entry.upserts) {
            const index = data.tickets.findIndex(candidate => candidate.id === ticket.id)
            if (index === -1) data.tickets.push(ticket)
            else data.tickets[index] = ticket
          }
        }
        if (Array.isArray(entry.deletes)) {
          data.tickets = data.tickets.filter(ticket => !entry.deletes.includes(ticket.id))
        }
        if (Array.isArray(entry.notifications)) data.notifications = entry.notifications
        lines += 1
      }
    }
    data.board = data.board ?? { name: boardName }
    journal.lines = lines
    journal.size = existsSync(journal.path) ? statSync(journal.path).size : 0
    journal.lastTickets = new Map(data.tickets.map(ticket => [ticket.id, JSON.stringify(ticket)]))
    journal.lastNotifications = JSON.stringify(data.notifications ?? [])
    journal.lastMeta = JSON.stringify({ version: data.version ?? SCHEMA_VERSION, board: data.board, nextKey: data.nextKey, metrics: data.metrics ?? [] })
    return { data, migrated: false, warning: warnings.length ? warnings.join(' · ') : null, needsPersist: false }
  }

  function compactJournal() {
    mkdirSync(dirname(file), { recursive: true })
    const body = JSON.stringify(
      {
        version: state.version ?? SCHEMA_VERSION,
        board: state.board,
        nextKey: state.nextKey,
        tickets: state.tickets,
        notifications: state.notifications ?? [],
        metrics: state.metrics ?? [],
      },
      null,
      2,
    )
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temp, body)
    fsyncFile(temp)
    renameSync(temp, file)
    fsyncFile(dirname(file))
    try {
      if (backupCount > 0 && existsSync(`${file}.bak`)) renameSync(`${file}.bak`, `${file}.bak.1`)
      copyFileSync(file, `${file}.bak`)
    } catch {
      /* the backup is best-effort */
    }
    writeFileSync(journal.path, '')
    fsyncFile(journal.path)
    journal.lines = 0
    journal.size = 0
    journal.lastMeta = JSON.stringify({ version: state.version ?? SCHEMA_VERSION, board: state.board, nextKey: state.nextKey, metrics: state.metrics ?? [] })
    journal.lastNotifications = JSON.stringify(state.notifications ?? [])
    baseline = statOf(file)
    baselineHash = hashOf(file)
  }

  function saveJournal() {
    const upserts = []
    const keep = new Set()
    state.tickets.forEach(ticket => {
      keep.add(ticket.id)
      const json = JSON.stringify(ticket)
      if (journal.lastTickets.get(ticket.id) !== json) {
        upserts.push(ticket)
        journal.lastTickets.set(ticket.id, json)
      }
    })
    const deletes = [...journal.lastTickets.keys()].filter(id => !keep.has(id))
    for (const id of deletes) journal.lastTickets.delete(id)
    const meta = { version: state.version ?? SCHEMA_VERSION, board: state.board, nextKey: state.nextKey, metrics: state.metrics ?? [] }
    const metaJson = JSON.stringify(meta)
    const notifications = state.notifications ?? []
    const notificationsJson = JSON.stringify(notifications)
    const changed = upserts.length || deletes.length || metaJson !== journal.lastMeta || notificationsJson !== journal.lastNotifications
    if (!changed) {
      if (typeof onChange === 'function') {
        try {
          onChange()
        } catch {
          /* observers must never break a write */
        }
      }
      return
    }
    const entry = { seq: journal.lines + 1, at: new Date().toISOString() }
    if (metaJson !== journal.lastMeta) entry.meta = meta
    if (upserts.length) entry.upserts = upserts
    if (deletes.length) entry.deletes = deletes
    if (notificationsJson !== journal.lastNotifications) entry.notifications = notifications
    mkdirSync(dirname(journal.path), { recursive: true })
    const observed = existsSync(journal.path) ? statSync(journal.path).size : 0
    if (journal.size !== null && observed !== journal.size) {
      throw new Error(
        `board journal changed in another process (size ${journal.size} → ${observed}); restart this board before making changes`,
      )
    }
    const fd = openSync(journal.path, 'a')
    try {
      writeSync(fd, JSON.stringify(entry) + '\n')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    journal.lines += 1
    journal.size = observed + Buffer.byteLength(JSON.stringify(entry) + '\n')
    journal.lastMeta = metaJson
    journal.lastNotifications = notificationsJson
    if (journal.lines > journalCompactionLines) compactJournal()
    if (typeof onChange === 'function') {
      try {
        onChange()
      } catch {
        /* observers must never break a write */
      }
    }
  }

  function load() {
    if (sqlite) return loadSqlite()
    if (journal) return loadJournal()
    const warnings = []
    const primary = readJson(file)
    let data = null
    if (!primary.error) {
      data = primary.data
    } else if (existsSync(file)) {
      const quarantine = `${file}.corrupt-${stamp()}`
      try {
        renameSync(file, quarantine)
        warnings.push(`board.json is unreadable (${primary.error}); the file was moved to ${quarantine}`)
      } catch (error) {
        warnings.push(`board.json is unreadable (${primary.error}) and could not be moved aside: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!data) {
      const backup = readJson(`${file}.bak`)
      if (!backup.error) {
        data = backup.data
        warnings.push('restored the last good board from board.json.bak')
      } else if (existsSync(`${file}.bak`) && !/ENOENT/.test(backup.error)) {
        warnings.push(`board.json.bak is also unreadable (${backup.error})`)
      }
    }
    if (!data) {
      data = { version: 1, board: { name: boardName }, nextKey: 1, tickets: [] }
    }
    data.board = data.board ?? { name: boardName }
    let migrated = false
    if ((Number(data.version) || 1) < SCHEMA_VERSION) {
      for (const ticket of data.tickets) {
        if (!ticket.doneAt && ticket.status === 'done') {
          const gate = [...(ticket.activity ?? [])].reverse().find(event => event.kind === 'gate' && /approved|→|->/.test(String(event.text ?? '')))
          ticket.doneAt = gate?.at ?? ticket.updatedAt ?? null
        }
      }
      data.version = SCHEMA_VERSION
      migrated = true
    }
    data.version = data.version ?? SCHEMA_VERSION
    data.metrics = Array.isArray(data.metrics) ? data.metrics.slice(-500) : []
    for (const ticket of data.tickets) {
      normalizeTicket(ticket)
      if (!stateIdSet.has(ticket.status)) {
        const previous = ticket.status
        ticket.status = workflow.initial
        ticket.updatedAt = now()
        ticket.activity.push({
          at: ticket.updatedAt,
          by: 'system',
          kind: 'migrated',
          text: `status "${previous}" is not part of this workflow; moved to ${workflow.initial}`,
        })
        migrated = true
      }
    }
    // A dependency that no longer exists must not silently count as satisfied.
    const knownIds = new Set(data.tickets.map(ticket => ticket.id))
    for (const ticket of data.tickets) {
      const kept = ticket.blockedBy.filter(id => knownIds.has(id))
      if (kept.length !== ticket.blockedBy.length) {
        ticket.blockedBy = kept
        ticket.updatedAt = now()
        ticket.activity.push({
          at: ticket.updatedAt,
          by: 'system',
          kind: 'dependencies',
          text: 'dropped dependencies that no longer exist',
        })
        migrated = true
      }
    }
    // Keys are never reused, even after a quarantine/restore: derive the counter
    // from what is actually on the board as well as the persisted counter.
    const highestKey = data.tickets.reduce((max, ticket) => Math.max(max, keyNumber(ticket.key)), 0)
    data.nextKey = Math.max(Number(data.nextKey) || 1, highestKey + 1)
    return { data, migrated, warning: warnings.length ? warnings.join(' · ') : null }
  }

  const loaded = load()
  const state = loaded.data
  loadWarning = loaded.warning
  baseline = sqlite ? null : statOf(file)
  let baselineHash = !sqlite && baseline ? hashOf(file) : null

  if (loaded.warning) console.warn(`[board] ${loaded.warning}`)

  function save() {
    if (journal) {
      saveJournal()
      return
    }
    if (sqlite) {
      saveSqlite()
      if (typeof onChange === 'function') {
        try {
          onChange()
        } catch {
          /* observers must never break a successful write */
        }
      }
      return
    }
    const current = statOf(file)
    if (!baseline && current) {
      throw new Error(`board.json appeared on disk (${file}) while this board was running; another instance wrote it — restart this board`)
    }
    if (baseline && !current) {
      throw new Error(`board.json disappeared while the board was running (${file}); stop and restart the board`)
    }
    const metadataChanged =
      baseline &&
      current &&
      (current.mtimeMs !== baseline.mtimeMs || current.size !== baseline.size || current.ino !== baseline.ino)
    if (metadataChanged) {
      // Metadata can change without a content change (chmod, a copy with the same
      // bytes); only refuse when the bytes themselves differ from what was loaded.
      const currentHash = hashOf(file)
      if (!baselineHash || currentHash !== baselineHash) {
        throw new Error(`board.json changed on disk (${file}); another board instance is writing it — restart this board before making changes`)
      }
    }
    mkdirSync(dirname(file), { recursive: true })
    const body = JSON.stringify(state, null, 2)
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, body)
      fsyncFile(temp)
      renameSync(temp, file)
      fsyncFile(dirname(file))
    } catch (error) {
      try {
        if (existsSync(temp)) unlinkSync(temp)
      } catch {
        /* temp cleanup is best-effort */
      }
      throw error
    }
    // `.bak` mirrors the last committed state; older generations rotate to
    // `.bak.1 … .bak.N` so a bad write can be rolled back a few steps.
    try {
      if (backupCount > 0) {
        // Shift numbered generations up, then the current backup becomes .1.
        for (let index = backupCount; index >= 2; index -= 1) {
          const from = `${file}.bak.${index - 1}`
          const to = `${file}.bak.${index}`
          if (existsSync(from)) {
            try {
              renameSync(from, to)
            } catch {
              /* rotation is best-effort */
            }
          }
        }
        if (existsSync(`${file}.bak`)) {
          try {
            renameSync(`${file}.bak`, `${file}.bak.1`)
          } catch {
            /* rotation is best-effort */
          }
        }
      }
      copyFileSync(file, `${file}.bak`)
    } catch {
      /* the backup is best-effort; the primary write already landed atomically */
    }
    baseline = statOf(file)
    baselineHash = hashOf(file)
    if (typeof onChange === 'function') {
      try {
        onChange()
      } catch {
        /* observers must never break a successful write */
      }
    }
  }

  if (loaded.migrated || loaded.needsPersist) {
    try {
      save()
    } catch (error) {
      // A migration that cannot be persisted must warn, not stop the plugin boot.
      const message = `workflow migration could not be persisted: ${error instanceof Error ? error.message : String(error)}`
      loadWarning = loadWarning ? `${loadWarning} · ${message}` : message
      console.warn(`[board] ${message}`)
    }
  }

  function stateLabel(id) {
    return workflow.states.find(candidate => candidate.id === id)?.label ?? id
  }

  function allowedTransitions(status) {
    if (workflow.transitions) return workflow.transitions[status] ?? []
    return stateIds.filter(id => id !== status)
  }

  function list() {
    return state.tickets
  }

  function find(id) {
    const ticket = state.tickets.find(item => item.id === id || item.key === id)
    if (!ticket) throw new Error(`ticket not found: ${id}`)
    return ticket
  }

  function touch(ticket, by, kind, text) {
    ticket.updatedAt = now()
    ticket.activity.push({ at: ticket.updatedAt, by: by || 'human', kind, text: String(text) })
    if (ticket.activity.length > ACTIVITY_CAP) ticket.activity.splice(0, ticket.activity.length - ACTIVITY_CAP)
  }

  function assertStatus(status) {
    if (!stateIdSet.has(status)) {
      throw new Error(`unknown status "${status}"; expected one of ${stateIds.join(', ')}`)
    }
  }

  function assertTransition(from, to) {
    if (from === to) return
    if (!workflow.transitions) return
    const allowed = workflow.transitions[from] ?? []
    if (!allowed.includes(to)) {
      throw new Error(`illegal transition ${from} → ${to}; allowed: ${allowed.length ? allowed.join(', ') : '(none)'}`)
    }
  }

  function captureTicket(ticket) {
    return {
      updatedAt: ticket.updatedAt,
      status: ticket.status,
      assignee: ticket.assignee,
      title: ticket.title,
      description: ticket.description,
      acceptance: Array.isArray(ticket.acceptance) ? [...ticket.acceptance] : [],
      checks: Array.isArray(ticket.checks) ? ticket.checks.map(check => ({ ...check })) : [],
      activity: ticket.activity.map(event => ({ ...event })),
      artifacts: ticket.artifacts.map(artifact => ({ ...artifact })),
      blockedBy: Array.isArray(ticket.blockedBy) ? [...ticket.blockedBy] : [],
      priority: ticket.priority,
      queuedAt: ticket.queuedAt,
      archivedAt: ticket.archivedAt,
      doneAt: ticket.doneAt,
      budgetTokens: ticket.budget?.tokens ?? null,
      budgetMinutes: ticket.budget?.minutes ?? null,
      activityLength: ticket.activity.length,
      artifactsLength: ticket.artifacts.length,
      runs: ticket.runs.map(run => ({ ...run })),
      currentRunId: ticket.currentRunId,
    }
  }

  function restoreTicket(ticket, snapshot) {
    ticket.updatedAt = snapshot.updatedAt
    ticket.status = snapshot.status
    ticket.assignee = snapshot.assignee
    ticket.title = snapshot.title
    ticket.description = snapshot.description
    ticket.acceptance = Array.isArray(snapshot.acceptance) ? [...snapshot.acceptance] : []
    ticket.checks = Array.isArray(snapshot.checks) ? snapshot.checks.map(check => ({ ...check })) : []
    ticket.activity = snapshot.activity.map(event => ({ ...event }))
    ticket.artifacts = snapshot.artifacts.map(artifact => ({ ...artifact }))
    ticket.blockedBy = [...snapshot.blockedBy]
    ticket.priority = snapshot.priority
    ticket.queuedAt = snapshot.queuedAt
    ticket.archivedAt = snapshot.archivedAt
    ticket.doneAt = snapshot.doneAt
    if (ticket.budget) ticket.budget.tokens = snapshot.budgetTokens
    if (ticket.budget) ticket.budget.minutes = snapshot.budgetMinutes
    ticket.activity.length = snapshot.activityLength
    ticket.artifacts.length = snapshot.artifactsLength
    for (let index = 0; index < snapshot.runs.length; index += 1) {
      const target = ticket.runs[index]
      const source = snapshot.runs[index]
      if (!target) continue
      for (const key of Object.keys(target)) {
        if (!(key in source)) delete target[key]
      }
      Object.assign(target, source)
    }
    ticket.runs.length = snapshot.runs.length
    ticket.currentRunId = snapshot.currentRunId
  }

  /** Apply a mutation and persist it; anything that fails leaves the ticket untouched. */
  function transact(ticket, mutate) {
    const snapshot = captureTicket(ticket)
    try {
      mutate()
      save()
      return ticket
    } catch (error) {
      restoreTicket(ticket, snapshot)
      throw error
    }
  }

  function resolveDependencies(refs, selfId) {
    const ids = []
    for (const ref of normalizeRefs(refs)) {
      const dependency = state.tickets.find(item => item.id === ref || item.key === ref)
      if (!dependency) throw new Error(`unknown dependency: ${ref}`)
      if (dependency.id === selfId) throw new Error('a ticket cannot depend on itself')
      if (!ids.includes(dependency.id)) ids.push(dependency.id)
    }
    // Walking blockedBy edges from the new dependencies must never reach the ticket.
    if (selfId) {
      const seen = new Set()
      const walk = ticketId => {
        if (ticketId === selfId) throw new Error(`dependency cycle: ${selfId} is reachable from its own dependencies`)
        if (seen.has(ticketId)) return
        seen.add(ticketId)
        const ticket = state.tickets.find(item => item.id === ticketId)
        for (const next of ticket?.blockedBy ?? []) walk(next)
      }
      for (const id of ids) walk(id)
    }
    return ids
  }

  function setQueued(ticketId, queued) {
    const ticket = find(ticketId)
    const next = queued ? ticket.queuedAt ?? now() : null
    if (ticket.queuedAt === next) return ticket
    return transact(ticket, () => {
      ticket.queuedAt = next
    })
  }

  function setArchived(ticketId, archived, by = 'human', { force = false } = {}) {
    const ticket = find(ticketId)
    if (archived) {
      if (ticket.currentRunId) throw new Error(`${ticket.key} has an active run; approve or reject it before archiving`)
      const openWork = ticket.runs.some(run => run.worktree && !run.merge && !run.prunedAt && !run.worktree.superseded)
      if (openWork && !force) {
        throw new Error(`${ticket.key} has an unmerged run branch; archive with force to discard it, or review it first`)
      }
      if (openWork && force) {
        for (const run of ticket.runs) {
          if (run.worktree && !run.merge && !run.prunedAt) run.abandonedAt = now()
        }
      }
    }
    return transact(ticket, () => {
      ticket.archivedAt = archived ? now() : null
      if (archived) ticket.queuedAt = null
      touch(ticket, by, 'archive', archived ? `archived${force ? ' (force)' : ''}` : 'unarchived')
    })
  }

  /** Track one completion so the board keeps history, not just a live snapshot. */
  function recordCompletion(ticket) {
    const created = Date.parse(ticket.createdAt)
    const finishedAt = Date.now()
    const entry = {
      at: new Date(finishedAt).toISOString(),
      key: ticket.key,
      cycleHours: Number.isFinite(created) ? Math.max(0, (finishedAt - created) / 3600000) : null,
      reviews: Array.isArray(ticket.runs) ? ticket.runs.length : 0,
      tokens: Array.isArray(ticket.runs) ? ticket.runs.reduce((sum, run) => sum + (Number(run.tokens) || 0), 0) : 0,
    }
    state.metrics.push(entry)
    if (state.metrics.length > 500) state.metrics.splice(0, state.metrics.length - 500)
  }

  /** Aggregate delivery metrics used by the Insights panel. */
  function insights() {
    const live = state.tickets.filter(ticket => !ticket.archivedAt)
    const metrics = Array.isArray(state.metrics) ? state.metrics : []
    const day = 86400000
    const nowMs = Date.now()
    const recent = windowMs =>
      metrics.filter(entry => {
        const at = Date.parse(entry.at)
        return Number.isFinite(at) && nowMs - at <= windowMs
      })
    const values = list => list.map(Number).filter(Number.isFinite)
    const average = list => {
      const vals = values(list)
      return vals.length ? vals.reduce((total, value) => total + value, 0) / vals.length : null
    }
    const median = list => {
      const vals = values(list).sort((left, right) => left - right)
      if (!vals.length) return null
      const mid = Math.floor(vals.length / 2)
      return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2
    }
    let runsTotal = 0
    let runsFailed = 0
    let checksRan = 0
    let checksFailed = 0
    for (const ticket of live) {
      for (const run of ticket.runs ?? []) {
        runsTotal += 1
        if (run.status === 'failed') runsFailed += 1
        for (const check of run.checks ?? []) {
          checksRan += 1
          if (check.exitCode !== 0 || check.timedOut || check.aborted || check.signal) checksFailed += 1
        }
      }
    }
    const byStatus = {}
    for (const ticket of live) byStatus[ticket.status] = (byStatus[ticket.status] ?? 0) + 1
    const cycle = metrics.map(entry => entry.cycleHours)
    return {
      tickets: live.length,
      archived: state.tickets.length - live.length,
      byStatus,
      throughput7d: recent(7 * day).length,
      throughput30d: recent(30 * day).length,
      cycleHoursAvg: average(cycle),
      cycleHoursP50: median(cycle),
      tokensPerMergeAvg: average(metrics.map(entry => entry.tokens)),
      reviewsPerTicketAvg: average(metrics.map(entry => entry.reviews)),
      runsTotal,
      runsFailed,
      failedRunRate: runsTotal ? runsFailed / runsTotal : null,
      checksRan,
      checksFailed,
      checksPassRate: checksRan ? 1 - checksFailed / checksRan : null,
    }
  }

  function health() {
    const live = state.tickets.filter(ticket => !ticket.archivedAt)
    const done = live.filter(ticket => ticket.status === workflow.done)
    const cycleHours = []
    for (const ticket of done) {
      const created = Date.parse(ticket.createdAt)
      const finished = Date.parse(ticket.doneAt ?? ticket.updatedAt)
      if (Number.isFinite(created) && Number.isFinite(finished) && finished >= created) cycleHours.push((finished - created) / 3600000)
    }
    const runs = live.flatMap(ticket => ticket.runs)
    const merged = runs.filter(run => run.merge)
    const tokens = merged.map(run => Number(run.tokens) || 0).filter(tokens => tokens > 0)
    const median = values => {
      if (!values.length) return null
      const sorted = [...values].sort((a, b) => a - b)
      const middle = Math.floor(sorted.length / 2)
      return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
    }
    const weekAgo = Date.now() - 7 * 86400000
    const throughput7d = state.metrics.filter(entry => Date.parse(entry.at) >= weekAgo).length
    return {
      tickets: live.length,
      done: done.length,
      throughput7d,
      cycleHours: median(cycleHours),
      reviewsPerTicket: live.length ? Math.round((runs.length / live.length) * 100) / 100 : null,
      mergedCommits: merged.length,
      tokensPerMerge: tokens.length ? Math.round(tokens.reduce((sum, value) => sum + value, 0) / tokens.length) : null,
    }
  }

  function buildTicket({ title, description = '', acceptance = [], checks = [], status, assignee = null, blockedBy = [], priority = 0, parentId = null }) {
    const nextKey = state.nextKey++
    const ticket = normalizeTicket({
      id: `t-${randomUUID().slice(0, 8)}`,
      key: `B-${nextKey}`,
      title,
      description,
      acceptance,
      checks,
      status,
      assignee,
      blockedBy,
      priority,
      parentId,
      subtaskIds: [],
      createdAt: now(),
      updatedAt: now(),
      activity: [],
      artifacts: [],
      runs: [],
      currentRunId: null,
      budget: { tokens: null, minutes: null },
      queuedAt: null,
      archivedAt: null,
      doneAt: null,
    })
    touch(ticket, 'system', 'created', `created by plan approval in ${stateLabel(status)}`)
    state.tickets.push(ticket)
    return ticket
  }

  function startPlanning(ticketId, sessionId, by = 'human') {
    const ticket = find(ticketId)
    if (ticket.plan?.status === 'approved') throw new Error(`${ticket.key}'s plan is already approved`)
    if (ticket.currentRunId) throw new Error(`${ticket.key} has an active run; finish it before planning`)
    return transact(ticket, () => {
      ticket.plan = normalizePlan({ ...(ticket.plan ?? {}), status: 'draft', sessionId: sessionId ?? ticket.plan?.sessionId })
      touch(ticket, by, 'plan', `planning session ${ticket.plan.sessionId} bound`)
    })
  }

  function submitPlan(ticketId, input, by = 'planner') {
    const ticket = find(ticketId)
    if (!ticket.plan) throw new Error('this ticket has no planning session')
    if (ticket.plan.status === 'approved') throw new Error('the plan is already approved')
    const markdown = String(input.markdown ?? '').trim()
    if (!markdown) throw new Error('a plan needs a markdown body')
    const next = normalizePlan({
      ...ticket.plan,
      status: 'submitted',
      version: (ticket.plan.version ?? 0) + 1,
      markdown,
      acceptance: input.acceptance ?? ticket.plan.acceptance,
      checks: input.checks ?? ticket.plan.checks,
      decomposition: input.decomposition ?? ticket.plan.decomposition,
      submittedAt: now(),
    })
    if (next.decomposition.some((item, index) => item.blockedBy.some(dep => dep > index || dep === index + 1))) {
      throw new Error('decomposition blockedBy indexes must point to earlier subtasks (1-based)')
    }
    transact(ticket, () => {
      ticket.plan = next
      pushNotification('plan_review', ticket, `${ticket.key} has a plan ready for review (v${next.version})`)
      touch(ticket, by, 'plan', `plan v${next.version} submitted (${next.decomposition.length} subtask(s))`)
    })
    return ticket.plan
  }

  function requestPlanChanges(ticketId, feedback, by = 'human') {
    const ticket = find(ticketId)
    if (!ticket.plan) throw new Error('this ticket has no planning session')
    if (ticket.plan.status === 'approved') throw new Error('the plan is already approved')
    const text = String(feedback ?? '').trim()
    if (!text) throw new Error('feedback is required')
    transact(ticket, () => {
      ticket.plan.status = 'draft'
      ticket.plan.feedback.push(text)
      touch(ticket, by, 'plan', `plan changes requested: ${text.slice(0, 140)}`)
    })
    return ticket.plan
  }

  function approvePlan(ticketId, by = 'human') {
    const ticket = find(ticketId)
    const plan = ticket.plan
    if (!plan) throw new Error('this ticket has no plan')
    if (plan.status !== 'submitted') throw new Error(`plan must be submitted before approval (current: ${plan.status})`)
    if (ticket.currentRunId) throw new Error(`${ticket.key} has an active run`)
    return transact(ticket, () => {
      plan.status = 'approved'
      plan.approvedAt = now()
      // The approved plan is the contract for the run: fill a ticket-level
      // acceptance/check list that was never set by hand.
      if (plan.acceptance.length && !(ticket.acceptance?.length)) ticket.acceptance = [...plan.acceptance]
      if (plan.checks.length && !(ticket.checks?.length)) {
        ticket.checks = plan.checks.map(check => ({ ...check, source: 'plan' }))
      }
      touch(ticket, by, 'plan', `plan v${plan.version} approved`)
      if (plan.decomposition.length) {
        const children = []
        for (const item of plan.decomposition) {
          const blockedBy = [
            ...(ticket.blockedBy ?? []),
            ...item.blockedBy.map(index => children[index - 1]?.id).filter(Boolean),
          ]
          children.push(
            buildTicket({
              title: item.title,
              description: item.description,
              acceptance: item.acceptance,
              checks: item.checks.map(check => ({ ...check, source: 'plan' })),
              status: workflow.dispatch,
              assignee: ticket.assignee ?? null,
              blockedBy,
              priority: Number(ticket.priority) || 0,
              parentId: ticket.id,
            }),
          )
        }
        ticket.subtaskIds = children.map(child => child.id)
        ticket.status = workflow.dispatch
        ticket.queuedAt = null
        touch(ticket, 'system', 'plan', `decomposed into ${children.length} subtask(s)`)
      } else {
        ticket.status = workflow.dispatch
        ticket.queuedAt = null
        touch(ticket, 'system', 'plan', 'single-ticket plan; ready for dispatch')
      }
    })
  }

  function setNeedsInput(ticketId, { question, sessionId, runId }, by = 'agent') {
    const ticket = find(ticketId)
    const text = String(question ?? '').trim()
    if (!text) throw new Error('a question is required')
    return transact(ticket, () => {
      ticket.needsInput = { question: text, sessionId: sessionId ?? null, runId: runId ?? null, at: now() }
      pushNotification('needs_input', ticket, `${ticket.key} is waiting for an answer: ${text.slice(0, 160)}`)
      touch(ticket, by, 'needs_input', text.slice(0, 300))
    })
  }

  function answerInput(ticketId, answer, by = 'human') {
    const ticket = find(ticketId)
    if (!ticket.needsInput) throw new Error(`${ticket.key} is not waiting for an answer`)
    const text = String(answer ?? '').trim()
    if (!text) throw new Error('an answer is required')
    return transact(ticket, () => {
      ticket.pendingAnswer = { text, sessionId: ticket.needsInput.sessionId }
      ticket.needsInput = null
      ticket.status = workflow.dispatch
      ticket.queuedAt = null
      touch(ticket, by, 'answer', text.slice(0, 300))
    })
  }

  function clearPendingAnswer(ticket) {
    if (!ticket.pendingAnswer) return
    ticket.pendingAnswer = null
  }

  function setReview(ticketId, { verdict, notes, reviewer } = {}, by = 'reviewer') {
    const ticket = find(ticketId)
    if (!['approved', 'changes_requested'].includes(verdict)) throw new Error('review verdict must be "approved" or "changes_requested"')
    if (ticket.status !== workflow.gate) {
      throw new Error(`${ticket.key} is ${stateLabel(ticket.status)}; reviews are accepted only at ${stateLabel(workflow.gate)}`)
    }
    return transact(ticket, () => {
      ticket.review = {
        verdict,
        notes: String(notes ?? '').slice(0, 2000),
        reviewer: reviewer ? String(reviewer) : null,
        at: now(),
      }
      pushNotification('review_verdict', ticket, `${ticket.key}: reviewer ${verdict}${ticket.review.notes ? ` — ${ticket.review.notes.slice(0, 160)}` : ''}`)
      touch(ticket, by, 'review', `reviewer ${verdict}${ticket.review.notes ? `: ${ticket.review.notes.slice(0, 200)}` : ''}`)
    })
  }

  function notificationList() {
    if (!Array.isArray(state.notifications)) state.notifications = []
    return state.notifications
  }

  function pushNotification(kind, ticket, text) {
    const list = notificationList()
    list.push({
      id: `n-${randomUUID().slice(0, 8)}`,
      kind,
      ticketId: ticket?.id ?? null,
      ticketKey: ticket?.key ?? null,
      text: String(text ?? ''),
      at: new Date().toISOString(),
      readAt: null,
    })
    if (list.length > 100) state.notifications = list.slice(-100)
  }

  function addNotification(kind, ticket, text) {
    pushNotification(kind, ticket, text)
    try {
      save()
    } catch {
      /* notifications are best-effort and must never block the mutation */
    }
  }

  function notifications({ unreadOnly = false } = {}) {
    const list = notificationList()
    return (unreadOnly ? list.filter(item => !item.readAt) : list).map(item => ({ ...item }))
  }

  function markNotificationsRead(ids) {
    const list = notificationList()
    const wanted = ids ? new Set(ids) : null
    let count = 0
    const at = new Date().toISOString()
    for (const item of list) {
      if (item.readAt) continue
      if (wanted && !wanted.has(item.id)) continue
      item.readAt = at
      count += 1
    }
    if (count) {
      try {
        save()
      } catch {
        /* best-effort */
      }
    }
    return count
  }

  function setTeamTask(ticketId, task) {
    const ticket = find(ticketId)
    return transact(ticket, () => {
      ticket.teamTaskId = task?.id ? String(task.id) : null
      ticket.teamTaskRevision = Number.isFinite(Number(task?.revision)) ? Number(task.revision) : null
      touch(ticket, 'agent', 'team', task?.id ? `published as team task ${task.id}` : 'team task link cleared')
    })
  }

  function setReviewSession(ticketId, sessionId) {
    const ticket = find(ticketId)
    return transact(ticket, () => {
      ticket.reviewSessionId = sessionId ? String(sessionId) : null
    })
  }

  function clearReview(ticketId) {
    const ticket = find(ticketId)
    if (!ticket.review && !ticket.reviewSessionId) return false
    ticket.review = null
    ticket.reviewSessionId = null
    return true
  }

  function completeParentIfReady(childId) {
    const child = find(childId)
    if (!child.parentId) return false
    const parent = state.tickets.find(item => item.id === child.parentId)
    if (!parent || parent.status === workflow.done) return false
    const children = (parent.subtaskIds ?? []).map(id => state.tickets.find(item => item.id === id)).filter(Boolean)
    if (!children.length || children.some(item => item.status !== workflow.done)) return false
    parent.status = workflow.done
    parent.doneAt = now()
    recordCompletion(parent)
    touch(parent, 'system', 'plan', 'all subtasks are done; parent completed')
    return true
  }

  function createTicket(input) {
    const title = String(input.title ?? '').trim()
    if (!title) throw new Error('title is required')
    const status = input.status ?? workflow.initial
    assertStatus(status)
    const acceptance = normalizeAcceptance(input.acceptance)
    if (acceptance.length > 50) throw new Error('a ticket can hold at most 50 acceptance criteria')
    const checks = normalizeChecks(input.checks)
    const id = `t-${randomUUID().slice(0, 8)}`
    const blockedBy = resolveDependencies(input.blockedBy, id)
    const priority = Number.isFinite(Number(input.priority)) ? Number(input.priority) : 0
    const nextKey = state.nextKey
    const ticket = normalizeTicket({
      id,
      key: `B-${nextKey}`,
      title,
      description: String(input.description ?? ''),
      acceptance,
      checks,
      status,
      assignee: input.assignee ?? null,
      blockedBy,
      priority,
      createdAt: now(),
      updatedAt: now(),
      activity: [],
      artifacts: [],
      runs: [],
      currentRunId: null,
      budget: {
        tokens: Number.isFinite(input.budgetTokens) && input.budgetTokens > 0 ? input.budgetTokens : null,
        minutes: Number.isFinite(input.budgetMinutes) && input.budgetMinutes > 0 ? input.budgetMinutes : null,
      },
      archivedAt: null,
      queuedAt: null,
    })
    touch(ticket, input.by ?? 'human', 'created', `created in ${stateLabel(status)}`)
    state.nextKey = nextKey + 1
    const previousKey = nextKey
    state.tickets.push(ticket)
    try {
      save()
    } catch (error) {
      state.tickets.pop()
      state.nextKey = previousKey
      throw error
    }
    return ticket
  }

  function updateTicket(input) {
    const ticket = find(input.id)
    const by = input.by ?? 'human'
    // Validate everything before the first mutation (Slice 0.11).
    if (input.title !== undefined) {
      const title = String(input.title).trim()
      if (!title) throw new Error('title cannot be empty')
    }
    if (input.status !== undefined && input.status !== ticket.status) {
      assertStatus(input.status)
      assertTransition(ticket.status, input.status)
    }
    if (input.checks !== undefined) normalizeChecks(input.checks)
    if (input.acceptance !== undefined) {
      const acceptance = normalizeAcceptance(input.acceptance)
      if (acceptance.length > 50) throw new Error('a ticket can hold at most 50 acceptance criteria')
    }
    if (input.blockedBy !== undefined) resolveDependencies(input.blockedBy, ticket.id)
    return transact(ticket, () => {
      if (input.title !== undefined) {
        const title = String(input.title).trim()
        if (title !== ticket.title) {
          ticket.title = title
          touch(ticket, by, 'edited', 'title updated')
        }
      }
      if (input.description !== undefined && String(input.description) !== ticket.description) {
        ticket.description = String(input.description)
        touch(ticket, by, 'edited', 'description updated')
      }
      if (input.status !== undefined && input.status !== ticket.status) {
        const from = ticket.status
        ticket.status = input.status
        if (input.status === workflow.done) {
          ticket.doneAt = now()
          recordCompletion(ticket)
          completeParentIfReady(ticket.id)
        } else if (from === workflow.done) ticket.doneAt = null
        if (input.status !== workflow.dispatch) ticket.queuedAt = null
        touch(ticket, by, 'status', `${stateLabel(from)} → ${stateLabel(input.status)}`)
      }
      if (input.assignee !== undefined) {
        const next = input.assignee === null || input.assignee === '' ? null : String(input.assignee)
        if (next !== ticket.assignee) {
          const from = ticket.assignee ?? 'unassigned'
          ticket.assignee = next
          touch(ticket, by, 'assignee', `${from} → ${next ?? 'unassigned'}`)
        }
      }
      if (input.blockedBy !== undefined) {
        const nextDeps = resolveDependencies(input.blockedBy, ticket.id)
        if (JSON.stringify(nextDeps) !== JSON.stringify(ticket.blockedBy)) {
          ticket.blockedBy = nextDeps
          touch(ticket, by, 'dependencies', nextDeps.length ? `blocked by ${nextDeps.length} ticket(s)` : 'dependencies cleared')
        }
      }
      if (input.priority !== undefined) {
        const priority = Number(input.priority)
        const next = Number.isFinite(priority) ? Math.trunc(priority) : 0
        if (next !== ticket.priority) {
          ticket.priority = next
          touch(ticket, by, 'priority', `priority set to ${next}`)
        }
      }
      if (input.budgetTokens !== undefined) {
        const tokens = Number(input.budgetTokens)
        ticket.budget.tokens = Number.isFinite(tokens) && tokens > 0 ? tokens : null
        touch(ticket, by, 'budget', tokens > 0 ? `token budget set to ${tokens}` : 'token budget cleared')
      }
      if (input.budgetMinutes !== undefined) {
        const minutes = Number(input.budgetMinutes)
        ticket.budget.minutes = Number.isFinite(minutes) && minutes > 0 ? minutes : null
        touch(ticket, by, 'budget', ticket.budget.minutes ? `wall-clock budget set to ${ticket.budget.minutes}m` : 'wall-clock budget cleared')
      }
      if (input.acceptance !== undefined) {
        const nextAcceptance = normalizeAcceptance(input.acceptance)
        if (JSON.stringify(nextAcceptance) !== JSON.stringify(ticket.acceptance)) {
          ticket.acceptance = nextAcceptance
          touch(ticket, by, 'acceptance', `acceptance criteria updated (${nextAcceptance.length})`)
        }
      }
      if (input.checks !== undefined) {
        const nextChecks = normalizeChecks(input.checks).map(check => ({ ...check, source: check.source ?? 'human' }))
        const changed = JSON.stringify(nextChecks) !== JSON.stringify(ticket.checks)
        ticket.checks = nextChecks
        touch(ticket, by, 'checks', nextChecks.length ? `checks set: ${nextChecks.map(check => check.name).join(', ')}` : 'checks cleared')
        // A changed check list invalidates the results of every unmerged run, so
        // approval runs the new commands instead of trusting stale outcomes.
        if (changed) {
          for (const run of ticket.runs) {
            if (run.merge) continue
            delete run.checks
            delete run.checksAt
          }
        }
      }
    })
  }

  function claimTicket(input, actor) {
    const ticket = find(input.id)
    const pending = (ticket.blockedBy ?? []).filter(id => {
      const dependency = state.tickets.find(item => item.id === id)
      return !dependency || dependency.status !== workflow.done
    })
    if (pending.length) throw new Error(`${ticket.key} is blocked by ${pending.length} ticket(s); finish them before claiming`)
    const agentId = input.assignee && String(input.assignee) !== '' ? String(input.assignee) : actor
    const by = input.by ?? agentId
    if (ticket.assignee && ticket.assignee !== agentId) {
      throw new Error(`ticket ${ticket.key} is already claimed by ${ticket.assignee}`)
    }
    return transact(ticket, () => {
      ticket.assignee = agentId
      if (ticket.status === workflow.initial || ticket.status === workflow.dispatch) {
        const from = ticket.status
        ticket.status = workflow.active
        touch(ticket, by, 'claim', `${stateLabel(from)} → ${stateLabel(workflow.active)} (claimed by ${agentId})`)
      } else {
        touch(ticket, by, 'claim', `claimed by ${agentId}`)
      }
    })
  }

  function commentTicket(input) {
    const ticket = find(input.id)
    const text = String(input.text ?? '').trim()
    if (!text) throw new Error('text is required')
    return transact(ticket, () => {
      touch(ticket, input.by ?? 'human', 'comment', text)
      if (input.deliveredTo) ticket.activity[ticket.activity.length - 1].deliveredTo = String(input.deliveredTo)
    })
  }

  /** Mark the newest comment on a ticket as delivered to a live run. */
  function annotateComment(id, runId) {
    const ticket = find(id)
    const event = [...ticket.activity].reverse().find(candidate => candidate.kind === 'comment')
    if (!event) return ticket
    return transact(ticket, () => {
      event.deliveredTo = runId
    })
  }

  function artifactTicket(input) {
    const ticket = find(input.id)
    const uri = String(input.uri ?? '').trim()
    if (!uri) throw new Error('uri is required')
    const kind = String(input.kind ?? 'link')
    return transact(ticket, () => {
      ticket.artifacts.push({ kind, uri, label: input.label ? String(input.label) : uri, at: now(), by: input.by ?? 'human' })
      if (ticket.artifacts.length > ARTIFACT_CAP) ticket.artifacts.splice(0, ticket.artifacts.length - ARTIFACT_CAP)
      touch(ticket, input.by ?? 'human', 'artifact', `${kind}: ${input.label ?? uri}`)
    })
  }

  function addRun(ticket, patch = {}) {
    const run = {
      id: `run-${randomUUID().slice(0, 8)}`,
      status: 'starting',
      startedAt: now(),
      endedAt: null,
      sessionId: null,
      tokens: 0,
      reason: null,
      ...patch,
    }
    ticket.runs.push(run)
    if (ticket.runs.length > RUN_CAP) ticket.runs.splice(0, ticket.runs.length - RUN_CAP)
    ticket.currentRunId = run.id
    return run
  }

  function patchRun(run, patch) {
    Object.assign(run, patch)
    return run
  }

  function closeRun(ticket, run, status, reason) {
    run.status = status
    run.endedAt = now()
    if (reason !== undefined) run.reason = reason
    if (ticket.currentRunId === run.id) ticket.currentRunId = null
    return run
  }

  function currentRun(ticket) {
    if (!ticket.currentRunId) return null
    return ticket.runs.find(run => run.id === ticket.currentRunId) ?? null
  }

  function snapshot() {
    const order = id => {
      const index = stateIds.indexOf(id)
      return index === -1 ? stateIds.length : index
    }
    return {
      board: {
        name: state.board.name,
        states: workflow.states,
        workflow: {
          initial: workflow.initial,
          dispatch: workflow.dispatch,
          active: workflow.active,
          gate: workflow.gate,
          done: workflow.done,
          blocked: workflow.blocked,
          transitions: workflow.transitions,
        },
        ...(loadWarning ? { warning: loadWarning } : {}),
      },
      tickets: [...state.tickets].sort((a, b) => order(a.status) - order(b.status) || a.key.localeCompare(b.key)),
      health: health(),
      at: now(),
    }
  }

  /** Write the current board as a board.json-shaped snapshot (atomic replace). */
  function exportJson(targetFile) {
    if (!targetFile) throw new Error('exportJson needs a target file')
    mkdirSync(dirname(targetFile), { recursive: true })
    const temp = `${targetFile}.${process.pid}.${randomUUID()}.tmp`
    const body = JSON.stringify(
      {
        version: state.version ?? SCHEMA_VERSION,
        board: state.board,
        nextKey: state.nextKey,
        tickets: state.tickets,
        notifications: Array.isArray(state.notifications) ? state.notifications : [],
        metrics: state.metrics ?? [],
      },
      null,
      2,
    )
    writeFileSync(temp, body)
    fsyncFile(temp)
    renameSync(temp, targetFile)
    fsyncFile(dirname(targetFile))
    return targetFile
  }

  return {
    state,
    workflow,
    file,
    stateLabel,
    allowedTransitions,
    save,
    list,
    find,
    touch,
    createTicket,
    updateTicket,
    setQueued,
    setArchived,
    setReview,
    setReviewSession,
    setTeamTask,
    clearReview,
    addNotification,
    notifications,
    markNotificationsRead,
    setNeedsInput,
    answerInput,
    clearPendingAnswer,
    startPlanning,
    submitPlan,
    requestPlanChanges,
    approvePlan,
    completeParentIfReady,
    recordCompletion,
    health,
    insights,
    claimTicket,
    commentTicket,
    annotateComment,
    artifactTicket,
    addRun,
    patchRun,
    closeRun,
    currentRun,
    snapshot,
    exportJson,
    assertStatus,
    get loadWarning() {
      return loadWarning
    },
  }
}
