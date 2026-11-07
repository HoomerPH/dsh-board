/**
 * dsh-board — ticket-first board for a DeepSeek Harness profile.
 *
 * The durable unit here is the ticket, not the chat session:
 *   - a JSON-backed ticket store under $DSH_HOME/board/board.json
 *   - a run controller that binds Ready tickets to real agent sessions
 *   - model-facing tools so workers read/update tickets and attach artifacts
 *   - exact Fetch routes consumed by the client panel in ./client.js
 *
 * Zero runtime dependencies: the tool registry accepts raw JSON Schema, every
 * harness service is resolved through ctx.get().
 */
import { dirname, join } from 'node:path'
import { createHmac, randomUUID } from 'node:crypto'
import { existsSync as fileExists, readdirSync as listDir, readFileSync as readFile } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'
import { createBoardStore } from './store.js'
import { createRunController } from './runs.js'

export const name = 'dsh-board'
export const inject = ['tools', 'connection']

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

function tool({ name, description, properties = {}, required = [], run }) {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return run(args ?? {}, exec)
    },
  }
}

const str = description => ({ type: 'string', description })

export function apply(ctx, config = {}) {
  const dataDir = config.dataDir ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'board')
  const storePath = join(dataDir, 'board.json')
  // Every successful save bumps the revision and wakes the push channel, so the
  // panel does not have to poll the whole board.
  const sseClients = new Set()
  let revision = 0
  function broadcast() {
    revision += 1
    if (!sseClients.size) return
    const frame = `data: ${JSON.stringify({ revision, at: Date.now() })}\n\n`
    for (const client of [...sseClients]) {
      if (client.destroyed || client.writableEnded) {
        sseClients.delete(client)
        continue
      }
      try {
        client.write(frame)
      } catch {
        sseClients.delete(client)
        try {
          client.destroy?.()
        } catch {
          /* already gone */
        }
      }
    }
  }
  const reviewerPreset = config.autonomy?.reviewerPreset ? String(config.autonomy.reviewerPreset) : null
  const webhooks = normalizeWebhooks(config.webhooks)
  const webhookLog = []
  const seenNotifications = new Set()
  // Never replay the inbox that existed before this process started.
  const webhookStartedAt = new Date().toISOString()
  const reviewHandles = new Map()
  const reviewTimers = new Set()
  const reviewSpawned = new Set()

  const store = createBoardStore({
    file: storePath,
    backend: config.backend === 'sqlite' || config.backend === 'journal' ? config.backend : 'json',
    ...(config.sqliteFile ? { sqliteFile: String(config.sqliteFile) } : {}),
    ...(config.journalFile ? { journalFile: String(config.journalFile) } : {}),
    ...(Number(config.journalCompactionLines) > 0 ? { journalCompactionLines: Number(config.journalCompactionLines) } : {}),
    boardName: config.boardName ?? 'Agent Sprint',
    workflow: config.workflow,
    onChange: () => {
      broadcast()
      try {
        setTimeout(() => {
          dispatchWebhooks()
          if (reviewerPreset) void maybeAutoReview()
        }, 0)
      } catch {
        /* scheduling is best-effort */
      }
    },
    backupCount: Number.isFinite(Number(config.backupCount)) ? Number(config.backupCount) : 3,
  })
  const runs = createRunController({
    ctx,
    store,
    // Every documented run-controller key has to reach the controller; the old
    // subset silently ignored `agentPreset` and `worktrees`.
    config: {
      workspace: config.workspace ?? process.cwd(),
      maxWorkers: config.maxWorkers ?? 2,
      agentPreset: config.agentPreset,
      maxSubagents: config.maxSubagents,
      worktrees: config.worktrees,
      gitTimeoutMs: config.gitTimeoutMs,
    },
    log: (...args) => console.log(...args),
  })

  try {
    runs.recover()
  } catch (error) {
    console.log(`[board] recovery failed: ${String(error)}`)
  }
  ctx.effect(
    () => () => {
      void runs.dispose()
    },
    'dsh-board: dispose workers',
  )
  const bootTimer = setTimeout(() => {
    try {
      runs.pump()
    } catch (error) {
      console.log(`[board] initial dispatch failed: ${String(error)}`)
    }
  }, 1200)
  bootTimer.unref?.()

  // Retention: archive done tickets after N days and prune merged leftovers.
  const archiveAfterDays = Number.isFinite(Number(config.archiveAfterDays)) ? Number(config.archiveAfterDays) : 30
  const pruneMerged = config.pruneMerged !== false
  function retention() {
    try {
      if (archiveAfterDays > 0) {
        const cutoff = Date.now() - archiveAfterDays * 86400000
        for (const ticket of store.list()) {
          if (ticket.status !== store.workflow.done || ticket.archivedAt || ticket.currentRunId) continue
          const finished = Date.parse(ticket.doneAt ?? ticket.updatedAt)
          if (!Number.isFinite(finished) || finished >= cutoff) continue
          try {
            store.setArchived(ticket.id, true, 'system')
            console.log(`[board] archived ${ticket.key} after ${archiveAfterDays} days`)
          } catch (error) {
            console.log(`[board] could not archive ${ticket.key}: ${String(error)}`)
          }
        }
      }
      if (pruneMerged) {
        void runs
          .prune({ includeArchived: false })
          .then(report => {
            if (report.removed.length) console.log(`[board] pruned ${report.removed.length} merged checkout(s)`)
          })
          .catch(error => console.log(`[board] prune failed: ${String(error)}`))
      }
    } catch (error) {
      console.log(`[board] retention failed: ${String(error)}`)
    }
  }
  const retentionTimer = setTimeout(retention, 4000)
  retentionTimer.unref?.()
  const retentionInterval = setInterval(retention, 3600000)
  retentionInterval.unref?.()
  ctx.effect(
    () => () => {
      clearTimeout(retentionTimer)
      clearInterval(retentionInterval)
    },
    'dsh-board: stop retention',
  )

  function dispatch() {
    try {
      runs.pump()
    } catch (error) {
      console.log(`[board] dispatch failed: ${String(error)}`)
    }
  }

  /** A card-sized view of a ticket: no activity, artifacts or run history. */
  function summarize(ticket) {
    const run = store.currentRun(ticket) ?? (ticket.runs.length ? ticket.runs[ticket.runs.length - 1] : null)
    const checks = Array.isArray(run?.checks) ? run.checks : []
    const failed = checks.filter(
      check => !check.skipped && !(check.exitCode === 0 && !check.timedOut && !check.aborted && !check.signal),
    )
    return {
      id: ticket.id,
      key: ticket.key,
      title: ticket.title,
      status: ticket.status,
      assignee: ticket.assignee ?? null,
      priority: ticket.priority ?? 0,
      blockedBy: ticket.blockedBy ?? [],
      budget: ticket.budget,
      queuedAt: ticket.queuedAt ?? null,
      archivedAt: ticket.archivedAt ?? null,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      activityCount: ticket.activity.length,
      artifactCount: ticket.artifacts.length,
      checks: (ticket.checks ?? []).map(check => ({ name: check.name, command: check.command, timeoutMs: check.timeoutMs ?? null })),
      planStatus: ticket.plan?.status ?? null,
      planVersion: ticket.plan?.version ?? 0,
      subtaskCount: (ticket.subtaskIds ?? []).length,
      needsInput: Boolean(ticket.needsInput),
      parentId: ticket.parentId ?? null,
      run: run
        ? {
            id: run.id,
            status: run.status,
            tokens: run.tokens,
            sessionId: run.sessionId ?? null,
            merge: run.merge ?? null,
            worktree: run.worktree
              ? { branch: run.worktree.branch ?? null, baseBranch: run.worktree.baseBranch ?? null, pruned: Boolean(run.worktree.pruned) }
              : null,
            checksFailed: failed.length,
            checksRan: checks.length,
            subagentsCount: Array.isArray(run.subagents) ? run.subagents.length : 0,
          }
        : null,
    }
  }

  /** Board state for clients: the durable store plus the live run queue. */
  const autonomy = {
    agentsCanReady: Boolean(config.autonomy?.agentsCanReady),
    agentsCanAssign: Boolean(config.autonomy?.agentsCanAssign),
    wipLimit: Math.max(0, Number(config.autonomy?.wipLimit) || 0),
    // Opt-in: a reviewer-approved ticket with trusted, passing checks may merge
    // itself. Off by default; the reviewer verdict and check provenance are required.
    autoMerge: Boolean(config.autonomy?.autoMerge),
    // A reviewer that requests changes can reject the ticket automatically,
    // which resumes the same worker session with the notes (opt-in).
    autoRejectOnChanges: Boolean(config.autonomy?.autoRejectOnChanges),
    // When set, an approved plan on an unassigned ticket assigns this agent so
    // the scheduler can dispatch it without a second drawer visit.
    defaultAssignee: config.autonomy?.defaultAssignee ? String(config.autonomy.defaultAssignee) : null,
    // Reviewer sessions are plain sessions; this caps their token spend (0 = off).
    reviewerTokenBudget: Math.max(0, Number(config.autonomy?.reviewerTokenBudget) || 0),
    reviewerBudgetCheckMs: Math.max(10, Number(config.autonomy?.reviewerBudgetCheckMs) || 5000),
  }

  function normalizeWebhooks(input) {
    if (!Array.isArray(input)) return []
    return input
      .map(entry => (typeof entry === 'string' ? { url: entry } : entry))
      .filter(entry => {
        try {
          const url = new URL(String(entry?.url ?? ''))
          return url.protocol === 'http:' || url.protocol === 'https:'
        } catch {
          console.log(`[board] ignoring invalid webhook URL: ${String(entry?.url)}`)
          return false
        }
      })
      .map(entry => ({
        url: String(entry.url),
        secret: entry.secret ? String(entry.secret) : null,
        events: Array.isArray(entry.events) ? entry.events.map(String) : null,
        retries: Math.min(5, Math.max(0, Number(entry.retries ?? 2)) || 0),
      }))
      .slice(0, 10)
  }

  async function deliverWebhook(hook, notification) {
    const payload = {
      text: `[${notification.ticketKey ?? 'board'}] ${notification.kind}: ${notification.text}`,
      kind: notification.kind,
      ticketKey: notification.ticketKey,
      ticketId: notification.ticketId,
      at: notification.at,
      text_body: notification.text,
    }
    const body = JSON.stringify(payload)
    const headers = { 'content-type': 'application/json', 'user-agent': 'dsh-board-webhook' }
    if (hook.secret) headers['x-board-signature'] = 'sha256=' + createHmac('sha256', hook.secret).update(body).digest('hex')
    const attempts = 1 + (hook.retries ?? 2)
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetch(hook.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) })
        if (!response.ok) throw new Error(`status ${response.status}`)
        webhookLog.push({ url: hook.url, kind: notification.kind, ok: true, status: response.status, attempts: attempt, at: new Date().toISOString() })
        if (webhookLog.length > 50) webhookLog.splice(0, webhookLog.length - 50)
        return
      } catch (error) {
        if (attempt >= attempts) {
          webhookLog.push({ url: hook.url, kind: notification.kind, ok: false, error: String(error), attempts: attempt, at: new Date().toISOString() })
          if (webhookLog.length > 50) webhookLog.splice(0, webhookLog.length - 50)
          console.log(`[board] webhook ${hook.url} failed after ${attempt} attempt(s): ${String(error)}`)
          return
        }
        await new Promise(resolve => setTimeout(resolve, 100 * 2 ** (attempt - 1)))
      }
    }
  }

  function dispatchWebhooks() {
    if (!webhooks.length) return
    for (const notification of store.notifications()) {
      if (seenNotifications.has(notification.id)) continue
      seenNotifications.add(notification.id)
      if (notification.at < webhookStartedAt) continue
      for (const hook of webhooks) {
        if (hook.events && !hook.events.includes(notification.kind)) continue
        void deliverWebhook(hook, notification)
      }
    }
  }

  function boardSnapshot({ summary = false } = {}) {
    const snapshot = store.snapshot()
    if (summary) {
      snapshot.tickets = snapshot.tickets.map(summarize)
      snapshot.board.archivedCount = snapshot.tickets.filter(ticket => ticket.archivedAt).length
    }
    snapshot.queue = runs.queued()
    snapshot.board.workspace = runs.workspace
    snapshot.board.maxWorkers = runs.maxWorkers
    snapshot.board.autonomy = autonomy
    snapshot.board.insights = store.insights()
    if (!summary) snapshot.board.webhookLog = webhookLog.slice(-20)
    snapshot.board.pullRequest = config.pullRequest && config.pullRequest.repository && config.pullRequest.token
      ? {
          enabled: true,
          repository: String(config.pullRequest.repository),
          base: String(config.pullRequest.base || 'main'),
          provider: String(config.pullRequest.provider || 'github'),
          autoSync: config.pullRequest.autoSync === true,
        }
      : { enabled: false }
    snapshot.board.unreadNotifications = store.notifications({ unreadOnly: true }).length
    if (!summary) snapshot.notifications = store.notifications().slice(-30)
    snapshot.revision = revision
    return snapshot
  }

  /** An error the action route turns into a 409 instead of a 400. */
  function conflict(message) {
    const error = new Error(message)
    error.status = 409
    return error
  }

  const plannerPreset = config.plannerPreset ?? 'standard'
  const planHandles = new Map()
  ctx.effect(
    () => () => {
      for (const timer of reviewTimers) clearInterval(timer)
      reviewTimers.clear()
      for (const handle of [...planHandles.values(), ...reviewHandles.values()]) {
        try {
          void handle.dispose()
        } catch {
          /* best effort */
        }
      }
      planHandles.clear()
    },
    'dsh-board: dispose planning sessions',
  )

  async function ensurePlanSession(ticket) {
    if (ticket.plan?.sessionId) return ticket.plan.sessionId
    const agents = ctx.get('agents')
    if (!agents || typeof agents.create !== 'function') throw new Error('the agents service is unavailable; cannot open a planning session')
    const presets = ctx.get('agentPresets')
    let presetId = null
    let setup
    if (presets) {
      try {
        const resolved = await presets.resolve(plannerPreset)
        presetId = resolved?.id ?? plannerPreset
        setup = async agentCtx => presets.mount(agentCtx, presetId)
      } catch (error) {
        console.log(`[board] planner preset "${plannerPreset}" unavailable: ${String(error)}`)
      }
    }
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    const handle = await agents.create({
      sessionId: `session-${randomUUID()}`,
      meta: { cwd: runs.workspace, ...(presetId ? { agentPreset: presetId } : {}) },
      ...(selection ? { agentOptions: { provider: selection.provider, model: selection.model } } : {}),
      ...(setup ? { setup } : {}),
    })
    planHandles.set(handle.agent.id, handle)
    return handle.agent.id
  }

  function approvePlanWithDefaults(ticketId) {
    const ticket = store.find(ticketId)
    if (autonomy.defaultAssignee && !ticket.assignee) {
      store.updateTicket({ id: ticket.id, assignee: autonomy.defaultAssignee, by: 'board' })
    }
    return store.approvePlan(ticket.id, 'human')
  }

  async function recordReview(ticket, verdict, notes, reviewer) {
    store.setReview(ticket.id, { verdict, notes, reviewer }, reviewer ?? 'reviewer')
    if (verdict !== 'approved') {
      if (!autonomy.autoRejectOnChanges) return { merged: false, note: 'recorded; the human decides whether to reject' }
      try {
        await runs.reject(ticket.id, notes || 'reviewer requested changes', reviewer ?? 'reviewer')
        return { merged: false, note: 'rejected automatically; the worker session resumes with the notes' }
      } catch (error) {
        return { merged: false, note: `recorded; auto-reject skipped: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    if (!autonomy.autoMerge) {
      return { merged: false, note: 'recorded (auto-merge is off)' }
    }
    if (!(ticket.checks?.length)) return { merged: false, note: 'recorded; auto-merge skipped because the ticket has no trusted checks' }
    const untrusted = ticket.checks.filter(check => check.source === 'agent')
    if (untrusted.length) return { merged: false, note: 'recorded; auto-merge skipped because some checks are not trusted' }
    try {
      await runs.approve(ticket.id, reviewer ?? 'reviewer')
      return { merged: true, note: 'approved and merged automatically (trusted checks + reviewer verdict)' }
    } catch (error) {
      return { merged: false, note: `recorded; auto-merge skipped: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  async function spawnReviewerSession(ticket, run) {
    if (!reviewerPreset) return null
    const agents = ctx.get('agents')
    if (!agents || typeof agents.create !== 'function') return null
    const presets = ctx.get('agentPresets')
    let presetId = null
    let setup
    if (presets) {
      try {
        const resolved = await presets.resolve(reviewerPreset)
        presetId = resolved?.id ?? reviewerPreset
        setup = async agentCtx => presets.mount(agentCtx, presetId)
      } catch (error) {
        console.log(`[board] reviewer preset "${reviewerPreset}" unavailable: ${String(error)}`)
      }
    }
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    const handle = await agents.create({
      sessionId: `session-${randomUUID()}`,
      meta: { cwd: runs.workspace, ...(presetId ? { agentPreset: presetId } : {}) },
      ...(selection ? { agentOptions: { provider: selection.provider, model: selection.model } } : {}),
      ...(setup ? { setup } : {}),
    })
    reviewHandles.set(handle.agent.id, handle)
    if (autonomy.reviewerTokenBudget > 0) {
      const timer = setInterval(() => {
        try {
          const tokens = Number(ctx.get('tokenMeter')?.measure(handle.agent.session)?.totalTokens ?? 0)
          if (tokens <= autonomy.reviewerTokenBudget) return
          clearInterval(timer)
          reviewTimers.delete(timer)
          try {
            handle.agent.cancel?.('reviewer token budget exceeded')
          } catch {
            /* the session may already be gone */
          }
          store.addNotification(
            'reviewer_budget',
            ticket,
            `${ticket.key} reviewer stopped after ${tokens} tokens (budget ${autonomy.reviewerTokenBudget})`,
          )
        } catch {
          /* measurement is best-effort */
        }
      }, autonomy.reviewerBudgetCheckMs)
      timer.unref?.()
      reviewTimers.add(timer)
    }
    const checks = (ticket.checks ?? []).map(check => `- ${check.name}: ${check.command}`).join('\n') || '- (none configured)'
    const acceptance = (ticket.acceptance ?? []).map(item => `- ${item}`).join('\n') || '- (none recorded)'
    const worktree = run?.worktree?.path ?? run?.worktree ?? null
    try {
      handle.agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              `You are the independent reviewer for board ticket ${ticket.key} — "${ticket.title}".`,
              worktree ? `The worker's checkout is ${worktree} (run ${run.id}).` : `The worker's run is ${run?.id ?? 'unknown'}.`,
              `Acceptance criteria:\n${acceptance}`,
              `Checks:\n${checks}`,
              `Inspect the diff and the check results for yourself (for example git -C <checkout> diff against the base branch). Do not modify code.`,
              `Then call board_review with verdict "approved" or "changes_requested" and notes describing what you checked and any required changes. Auto-merge only happens when the board explicitly allows it.`,
            ].join('\n'),
          },
        ],
        source: { kind: 'user' },
      })
    } catch (error) {
      console.log(`[board] could not send reviewer brief for ${ticket.key}: ${String(error)}`)
    }
    return handle.agent.id
  }

  async function maybeAutoReview() {
    if (!reviewerPreset) return
    for (const ticket of store.list()) {
      if (ticket.status !== store.workflow.gate || ticket.review || ticket.reviewSessionId) continue
      const run = store.currentRun(ticket) ?? ticket.runs[ticket.runs.length - 1]
      const key = `${ticket.id}:${run?.id ?? 'none'}`
      if (reviewSpawned.has(key)) continue
      reviewSpawned.add(key)
      try {
        const sessionId = await spawnReviewerSession(ticket, run)
        if (sessionId) store.setReviewSession(ticket.id, sessionId)
      } catch (error) {
        console.log(`[board] could not open a reviewer for ${ticket.key}: ${String(error)}`)
      }
    }
  }

  /** `/board [text]` — create a ticket from the chat and brainstorm it here. */
  function ticketSummaryLine(ticket) {
    const bits = [`${ticket.key} [${ticket.status}] ${ticket.title}`]
    if (ticket.assignee) bits.push(`@${ticket.assignee}`)
    if (ticket.plan?.status) bits.push(`plan ${ticket.plan.status}`)
    if (ticket.needsInput) bits.push('needs input')
    return bits.join(' · ')
  }

  async function runBoardCommand(invocation) {
    const text = String(invocation?.rawInput ?? '').trim()
    const [head, ...tail] = text.split(/\s+/)
    const verb = (head || '').toLowerCase()
    const rest = text.slice(head ? head.length : 0).trim()
    try {
      if (verb === 'list') {
        const tickets = store.list().filter(ticket => !ticket.archivedAt)
        if (!tickets.length) return { kind: 'success', text: 'The board is empty. Type /board <what you want to build> to create work.' }
        return { kind: 'success', text: tickets.map(ticketSummaryLine).join('\n') }
      }
      if (verb === 'show') {
        const key = rest.split(/\s+/)[0]
        if (!key) return { kind: 'error', text: 'Usage: /board show <ticket>' }
        const ticket = store.find(key)
        const run = store.currentRun(ticket) ?? (ticket.runs || [])[ticket.runs.length - 1]
        const lines = [
          `${ticket.key} — ${ticket.title}`,
          `status: ${ticket.status}${ticket.assignee ? ` · assignee @${ticket.assignee}` : ' · unassigned'}`,
          `plan: ${ticket.plan ? `v${ticket.plan.version} ${ticket.plan.status}` : 'none'}`,
        ]
        if ((ticket.subtaskIds || []).length) lines.push(`subtasks: ${ticket.subtaskIds.length}`)
        if (ticket.needsInput) lines.push(`waiting for an answer: ${ticket.needsInput.question}`)
        if (run) lines.push(`last run: ${run.status}${typeof run.tokens === 'number' ? ` · ${run.tokens} tokens` : ''}`)
        if (ticket.plan?.markdown) lines.push('', ticket.plan.markdown.split('\n').slice(0, 12).join('\n'))
        return { kind: 'success', text: lines.join('\n') }
      }
      if (verb === 'approve') {
        const key = rest.split(/\s+/)[0]
        if (!key) return { kind: 'error', text: 'Usage: /board approve <ticket>' }
        const ticket = approvePlanWithDefaults(key)
        dispatch()
        const assigned = ticket.assignee ? ` Assigned to @${ticket.assignee}.` : ' Assign an agent to dispatch it.'
        return { kind: 'success', text: `Approved ${ticket.key}'s plan (v${ticket.plan.version}).${assigned}` }
      }
      if (verb === 'export') {
        const target = join(dataDir, 'board.export.json')
        store.exportJson(target)
        return { kind: 'success', text: `Board exported to ${target}` }
      }
      if (verb === 'gc') {
        const report = await runs.gc({ apply: rest.trim() === 'apply' })
        const lines = [
          report.dryRun ? 'GC dry run — nothing was removed.' : 'GC applied.',
          `orphan worktrees: ${report.worktrees.length}, orphan branches: ${report.branches.length}`,
        ]
        for (const item of report.worktrees.slice(0, 5)) lines.push(`  worktree ${item.path} (${item.branch})`)
        for (const branch of report.branches.slice(0, 5)) lines.push(`  branch ${branch}`)
        for (const error of report.errors.slice(0, 3)) lines.push(`  error: ${error.target}: ${error.error}`)
        if (report.dryRun && (report.worktrees.length || report.branches.length)) lines.push('Run /board gc apply to remove them.')
        return { kind: 'success', text: lines.join('\n') }
      }
      if (verb === 'notifications' || verb === 'inbox') {
        const unread = store.notifications({ unreadOnly: true })
        if (!unread.length) return { kind: 'success', text: 'Inbox empty.' }
        store.markNotificationsRead(unread.map(item => item.id))
        return {
          kind: 'success',
          text: unread
            .slice(-10)
            .map(item => `${item.ticketKey ? `${item.ticketKey} ` : ''}${item.kind}: ${item.text}`)
            .join('\n'),
        }
      }
      if (verb === 'review') {
        const [key, rawVerdict, ...noteParts] = rest.split(/\s+/)
        if (!key || !rawVerdict) return { kind: 'error', text: 'Usage: /board review <ticket> <approved|changes> [notes]' }
        const verdict = /^change/i.test(rawVerdict) ? 'changes_requested' : 'approved'
        const ticket = store.find(key)
        const outcome = await recordReview(ticket, verdict, noteParts.join(' '), 'human')
        return { kind: 'success', text: `Review on ${ticket.key}: ${verdict}; ${outcome.note}` }
      }
      if (verb === 'answer') {
        const [key, ...answer] = rest.split(/\s+/)
        if (!key || !answer.length) return { kind: 'error', text: 'Usage: /board answer <ticket> <answer>' }
        const ticket = store.find(key)
        store.answerInput(ticket.id, answer.join(' '), 'human')
        dispatch()
        return { kind: 'success', text: `Answered ${ticket.key}; the worker resumes with your reply.` }
      }
    } catch (error) {
      return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    }
    const firstLine = text.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? ''
    const title = (firstLine || 'Untitled board work').replace(/\s+/g, ' ').slice(0, 120)
    let ticket
    try {
      ticket = store.createTicket({ title, description: text, by: 'human' })
    } catch (error) {
      return { kind: 'error', text: `Could not create a board ticket: ${error instanceof Error ? error.message : String(error)}` }
    }
    const agent = invocation?.agent
    const sessionId = agent?.session?.id ? String(agent.session.id) : null
    if (sessionId) {
      try {
        store.startPlanning(ticket.id, sessionId, 'human')
      } catch (error) {
        console.log(`[board] could not bind /board planning session: ${String(error)}`)
      }
    }
    let woke = false
    try {
      if (typeof agent?.followup === 'function') {
        agent.followup({
          id: randomUUID(),
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                `You are the board planner for ticket ${ticket.key} — "${ticket.title}".`,
                `The human created this from /board. Collaborate with them like plan mode: ask clarifying questions, explore if useful, and decide what work is actually needed.`,
                `Update the ticket as the scope settles with board_update (title, description).`,
                `When the plan is actionable, call board_submit_plan with the approach, acceptance criteria, proposed checks and optional subtask decomposition. A human approves the plan and the board dispatches a worker; do not implement code in this session.`,
              ].join('\n'),
            },
          ],
          source: { kind: 'user' },
        })
        woke = true
      }
    } catch (error) {
      console.log(`[board] could not start planning turn for ${ticket.key}: ${String(error)}`)
    }
    return {
      kind: 'success',
      text: `Created ${ticket.key} — let's brainstorm it here.${woke ? '' : ' Describe the work in your next message and I will plan it.'} When the scope is clear I will submit the plan for your approval.`,
    }
  }

  function registerBoardCommand(hostCtx) {
    const commands = hostCtx.get('commands')
    if (!commands || typeof commands.register !== 'function') {
      console.log('[board] commands service unavailable; /board is not registered')
      return
    }
    hostCtx.effect(
      () => commands.register({
        name: 'board',
        description: 'Create a board ticket and brainstorm the work with the agent',
        input: { hint: 'Describe the work to plan (optional)' },
        handler: invocation => runBoardCommand(invocation),
      }),
      'dsh-board: /board command',
    )
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], scoped => registerBoardCommand(scoped && typeof scoped.get === 'function' ? scoped : ctx))
  } else {
    registerBoardCommand(ctx)
  }

  // ── model-facing tools ─────────────────────────────────────────────────────
  ctx.tools.register(
    tool({
      name: 'board_list',
      description: 'List tickets on the team board. Filter by status and/or assignee. Returns one line per ticket.',
      properties: {
        status: str('Optional status filter: backlog, ready, in_progress, in_review, done, blocked'),
        assignee: str('Optional assignee filter (agent id); "unassigned" matches tickets without an owner'),
      },
      run: args => {
        let tickets = store.list()
        if (args.status) tickets = tickets.filter(ticket => ticket.status === args.status)
        if (args.assignee === 'unassigned') tickets = tickets.filter(ticket => !ticket.assignee)
        else if (args.assignee) tickets = tickets.filter(ticket => ticket.assignee === args.assignee)
        if (!tickets.length) return 'No tickets match.'
        return tickets
          .map(ticket => {
            const run = store.currentRun(ticket)
            const suffix = run ? `  run=${run.status}${run.tokens ? ` ${run.tokens}tok` : ''}` : ''
            const priority = ticket.priority ? `  p${ticket.priority}` : ''
            const waiting = ticket.blockedBy?.length ? `  blockedBy=${ticket.blockedBy.length}` : ''
            const archived = ticket.archivedAt ? '  archived' : ''
            return `${ticket.key}  [${ticket.status}]  ${ticket.title}${ticket.assignee ? `  @${ticket.assignee}` : ''}${priority}${waiting}${suffix}${archived}`
          })
          .join('\n')
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'board_get',
      description: 'Read one ticket in full: description, acceptance criteria, assignee, budget, artifacts, runs and activity.',
      properties: { id: str('Ticket key (e.g. B-3) or ticket id') },
      required: ['id'],
      run: args => {
        const ticket = store.find(args.id)
        const lines = [
          `${ticket.key}  [${ticket.status}]  ${ticket.title}`,
          `assignee: ${ticket.assignee ?? 'unassigned'}`,
          `token budget: ${ticket.budget?.tokens ?? 'none'}   wall-clock budget: ${ticket.budget?.minutes ? ticket.budget.minutes + 'm' : 'none'}`,
          `created: ${ticket.createdAt}   updated: ${ticket.updatedAt}`,
          '',
          ticket.description || '(no description)',
        ]
        if (ticket.acceptance.length) {
          lines.push('', 'acceptance:')
          for (const item of ticket.acceptance) lines.push(`- ${item}`)
        }
        if (ticket.checks.length) {
          lines.push('', 'checks:')
          for (const check of ticket.checks) lines.push(`- ${check.name}: ${check.command}${check.timeoutMs ? ` (timeout ${check.timeoutMs}ms)` : ''}`)
        }
        if (ticket.artifacts.length) {
          lines.push('', 'artifacts:')
          for (const artifact of ticket.artifacts) lines.push(`- ${artifact.kind}: ${artifact.label} <${artifact.uri}>`)
        }
        if (ticket.blockedBy?.length) {
          lines.push('', 'blocked by:')
          for (const id of ticket.blockedBy) {
            const dependency = store.list().find(item => item.id === id)
            lines.push(`- ${dependency ? `${dependency.key} [${dependency.status}] ${dependency.title}` : id}`)
          }
        }
        if (ticket.priority) lines.push('', `priority: ${ticket.priority}`)
        if (ticket.archivedAt) lines.push('', `archived: ${ticket.archivedAt}`)
        const run = store.currentRun(ticket)
        if (run) {
          lines.push('', 'current run:', `- ${run.id} [${run.status}] session=${run.sessionId ?? 'pending'} tokens=${run.tokens}${run.reason ? ` reason=${run.reason}` : ''}`)
        }
        if (ticket.runs.length > 1) {
          lines.push('', 'run history:')
          for (const item of ticket.runs.slice(0, -1)) lines.push(`- ${item.id} [${item.status}] tokens=${item.tokens}${item.reason ? ` reason=${item.reason}` : ''}`)
        }
        if (ticket.activity.length) {
          lines.push('', 'activity:')
          for (const event of ticket.activity) lines.push(`- ${event.at} ${event.by} [${event.kind}] ${event.text}`)
        }
        return lines.join('\n')
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'board_create',
      description: 'Create a ticket on the team board (defaults to the backlog). Humans assign and start runs.',
      properties: {
        title: str('Short ticket title'),
        description: str('What needs to be done'),
        acceptance: str('Acceptance criteria, one per line'),
        checks: str('Optional verification commands, one per line as "name :: command"'),
        blockedBy: str('Optional comma or space separated ticket keys this ticket waits for'),
        priority: str('Optional integer priority; higher runs first'),
        budgetMinutes: str('Optional wall-clock budget in minutes for the run'),
        status: str('Ignored for agents: a new ticket always starts in the board\'s initial state'),
      },
      required: ['title'],
      run: args => {
        const ticket = store.createTicket({ ...args, status: store.workflow.initial, by: 'agent' })
        return `Created ${ticket.key}: ${ticket.title} [${ticket.status}]`
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'board_claim',
      description: 'Claim an unassigned ticket and move it to in_progress. Workers started by the board are already assigned.',
      properties: {
        id: str('Ticket key or id'),
        assignee: str('Optional assignee id (defaults to the calling agent)'),
      },
      required: ['id'],
      run: (args, exec) => {
        const actor = exec?.agent?.id ? String(exec.agent.id) : 'agent'
        const requested = args.assignee === undefined || args.assignee === null || String(args.assignee) === '' ? null : String(args.assignee)
        if (requested && requested !== actor) {
          throw new Error(`board_claim assigns the calling agent; it cannot claim ${args.id} for "${requested}"`)
        }
        const ticket = store.find(args.id)
        if (ticket.assignee) throw new Error(`${ticket.key} is already assigned to ${ticket.assignee}`)
        if (ticket.status !== store.workflow.initial && ticket.status !== store.workflow.dispatch) {
          throw new Error(
            `${ticket.key} is ${store.stateLabel(ticket.status)}; only unassigned ${store.stateLabel(store.workflow.initial)} or ${store.stateLabel(store.workflow.dispatch)} tickets can be claimed`,
          )
        }
        const claimed = store.claimTicket({ id: args.id }, actor)
        dispatch()
        return `Claimed ${claimed.key} as ${claimed.assignee} [${claimed.status}]`
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'board_update',
      description:
        'Update a ticket: move its status, rename it, edit the description, or triage it when the autonomy policy allows. A worker may only move its own in-progress ticket to the review gate or blocked; agents cannot reopen or mark tickets done — a human approves in review.',
      properties: {
        id: str('Ticket key or id'),
        status: str('New workflow status; without autonomy agents may only set the gate or blocked state'),
        title: str('New title'),
        description: str('New description'),
        assignee: str('Assignee agent id (requires autonomy.agentsCanAssign)'),
      },
      required: ['id'],
      run: (args, exec) => {
        const actor = exec?.agent?.id ? String(exec.agent.id) : null
        const current = store.find(args.id)
        if (args.status !== undefined) {
          const target = String(args.status)
          if (target === store.workflow.done) {
            throw new Error(`agents cannot mark a ticket ${store.stateLabel(store.workflow.done)}; a human approves it from ${store.stateLabel(store.workflow.gate)}`)
          }
          if (target === store.workflow.dispatch) {
            if (!autonomy.agentsCanReady) {
              throw new Error(
                `agents cannot move tickets to ${store.stateLabel(store.workflow.dispatch)}; set autonomy.agentsCanReady to allow agent triage`,
              )
            }
            if (current.status !== store.workflow.initial) {
              throw new Error(`${current.key} is ${store.stateLabel(current.status)}; an agent can only triage an initial ticket to ${store.stateLabel(target)}`)
            }
            if (autonomy.wipLimit > 0) {
              const active = store.list().filter(ticket => ticket.status === store.workflow.active).length
              if (active >= autonomy.wipLimit) {
                throw new Error(`WIP limit reached: ${active}/${autonomy.wipLimit} tickets already in progress`)
              }
            }
          } else if (target !== store.workflow.gate && target !== store.workflow.blocked) {
            throw new Error(
              `agents may only move a ticket to ${store.stateLabel(store.workflow.gate)} or ${store.stateLabel(store.workflow.blocked)} (requested "${target}")`,
            )
          } else {
            if (current.status !== store.workflow.active && current.status !== target) {
              throw new Error(`${current.key} is ${store.stateLabel(current.status)}; a worker can only move its own in-progress ticket`)
            }
            if (!actor) {
              throw new Error('board_update needs a calling agent to verify ticket ownership')
            }
            if (current.assignee && current.assignee !== actor) {
              throw new Error(`${current.key} is assigned to ${current.assignee}; a worker cannot update another agent's ticket`)
            }
          }
        }
        if (args.assignee !== undefined) {
          if (!autonomy.agentsCanAssign) {
            throw new Error('agents cannot assign tickets; set autonomy.agentsCanAssign to allow agent triage')
          }
          const value = String(args.assignee).trim()
          if (!value) throw new Error('assignee cannot be empty when an agent assigns a ticket')
          if (value.length > 100) throw new Error('assignee must be 100 characters or fewer')
        }
        const ticket = store.updateTicket({
          id: args.id,
          status: args.status,
          title: args.title,
          description: args.description,
          assignee: args.assignee,
          by: actor ?? 'agent',
        })
        dispatch()
        return `${ticket.key} is now [${ticket.status}]${ticket.assignee ? ` @${ticket.assignee}` : ''}`
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'board_comment',
      description: 'Add a comment to a ticket. Humans read these in the ticket drawer; other agents can too.',
      properties: {
        id: str('Ticket key or id'),
        text: str('Comment body'),
      },
      required: ['id', 'text'],
      run: args => {
        const ticket = store.commentTicket({ ...args, by: 'agent' })
        return `Commented on ${ticket.key}`
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'board_artifact',
      description: 'Attach an artifact to a ticket: a PR, branch, diff, test report, or URL.',
      properties: {
        id: str('Ticket key or id'),
        kind: str('Artifact kind: pr, branch, diff, report, link'),
        uri: str('Location (URL, branch name, or path)'),
        label: str('Human-readable label'),
      },
      required: ['id', 'uri'],
      run: args => {
        const ticket = store.artifactTicket({ ...args, by: 'agent' })
        return `Attached ${args.kind ?? 'link'} to ${ticket.key}`
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'board_submit_plan',
      description:
        'Submit (or revise) the implementation plan for a ticket you are planning. Only the planning session bound to that ticket may submit. Include the approach, acceptance criteria, proposed subtasks and checks; a human approves it before any implementation starts.',
      properties: {
        id: str('Ticket key or id'),
        markdown: str('The plan as markdown: approach, files, risks, test strategy'),
        acceptance: str('Acceptance criteria, one per line'),
        checks: str('Proposed verification commands, one per line as "name :: command"'),
        decomposition: str('Optional JSON array of subtasks: [{"title","description","acceptance","checks","blockedBy":[earlier 1-based subtask indexes]}]'),
      },
      required: ['id', 'markdown'],
      run: (args, exec) => {
        const ticket = store.find(args.id)
        if (!ticket.plan?.sessionId) throw new Error(`${ticket.key} has no planning session; ask a human to open one`)
        const actorId = exec?.agent?.id ? String(exec.agent.id) : null
        const actorSession = exec?.agent?.session?.id ? String(exec.agent.session.id) : null
        const bound = ticket.plan.sessionId
        const authorized = (actorId && actorId === bound) || (actorSession && actorSession === bound)
        if ((actorId || actorSession) && !authorized) throw new Error(`only the planning session for ${ticket.key} can submit its plan`)
        let decomposition = args.decomposition ?? []
        if (typeof decomposition === 'string') {
          decomposition = decomposition.trim() ? JSON.parse(decomposition) : []
        }
        if (!Array.isArray(decomposition)) throw new Error('decomposition must be an array')
        const plan = store.submitPlan(
          ticket.id,
          { markdown: args.markdown, acceptance: args.acceptance, checks: args.checks, decomposition },
          actorId ?? actorSession ?? 'planner',
        )
        return `Plan v${plan.version} submitted for review (${plan.decomposition.length} proposed subtask(s))`
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'board_ask',
      description:
        'Ask the human a blocking question. The run stops and the ticket waits for an answer; the same session resumes with it. Use only when you cannot proceed without a human decision.',
      properties: { id: str('Ticket key or id'), question: str('The question, with the options you see') },
      required: ['id', 'question'],
      run: (args, exec) => {
        const ticket = store.find(args.id)
        const run = store.currentRun(ticket)
        if (!run) throw new Error(`${ticket.key} has no active run to pause`)
        const actor = exec?.agent?.id ? String(exec.agent.id) : null
        if (actor && run.sessionId && actor !== run.sessionId) throw new Error(`only the run's own worker can ask on ${ticket.key}`)
        store.setNeedsInput(ticket.id, { question: args.question, sessionId: run.sessionId, runId: run.id }, actor ?? 'agent')
        store.closeRun(ticket, run, 'needs_input', String(args.question).slice(0, 300))
        ticket.status = store.workflow.blocked
        store.touch(ticket, 'system', 'run', `run ${run.id} paused for a human answer`)
        store.save()
        return `Asked on ${ticket.key}; the ticket waits for an answer and ${run.sessionId ?? 'the session'} will resume.`
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'board_team_task',
      description:
        'Publish a board ticket as a shared Agent Team task so teammates can see and claim it alongside the team board. Requires Agent Teams in this profile.',
      properties: {
        id: str('Ticket key or id'),
        subject: str('Task subject (defaults to the ticket title)'),
        description: str('Task description (defaults to the ticket description and acceptance criteria)'),
      },
      required: ['id'],
      run: async (args, exec) => {
        const teams = ctx.get('agentTeams')
        if (!teams || typeof teams.createTask !== 'function') throw new Error('Agent Teams is not available in this profile')
        const ticket = store.find(args.id)
        const caller = exec?.agent
        if (!caller) throw new Error('board_team_task needs a calling agent')
        const acceptance = (ticket.acceptance ?? []).map(item => `- ${item}`).join('\n')
        const task = await teams.createTask(caller, {
          subject: args.subject ? String(args.subject) : `${ticket.key}: ${ticket.title}`,
          description: args.description
            ? String(args.description)
            : [ticket.description || '(no description)', acceptance ? `Acceptance criteria:\n${acceptance}` : ''].filter(Boolean).join('\n\n'),
        })
        store.setTeamTask(ticket.id, task)
        return `Published ${ticket.key} as team task ${task.id} (revision ${task.revision})`
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'board_team_sync',
      description:
        'Refresh a published board ticket from its Agent Team task: pulls the current task state and mirrors the team owner onto the ticket assignee. Use board_team_task first.',
      properties: { id: str('Ticket key or id') },
      required: ['id'],
      run: async (args, exec) => {
        const teams = ctx.get('agentTeams')
        if (!teams || typeof teams.getTask !== 'function') throw new Error('Agent Teams is not available in this profile')
        const ticket = store.find(args.id)
        if (!ticket.teamTaskId) throw new Error(`${ticket.key} has no team task; publish it with board_team_task first`)
        const caller = exec?.agent
        if (!caller) throw new Error('board_team_sync needs a calling agent')
        let task = teams.getTask(caller, ticket.teamTaskId)
        const changes = []
        // Board -> team: a done ticket completes the shared task.
        if (ticket.status === store.workflow.done && task.status !== 'completed' && typeof teams.updateTask === 'function') {
          task = await teams.updateTask(caller, { taskId: task.id, expectedRevision: task.revision, action: 'complete' })
          changes.push('team task completed')
        } else if (task.status === 'completed' && ticket.status !== store.workflow.done) {
          store.addNotification('team_task_done', ticket, `${ticket.key}: team task ${task.id} is completed; finish the board review/merge`)
          changes.push('team task completed (board still open)')
        }
        // Team -> board: the current team owner becomes the assignee.
        if (task.ownerName && task.ownerName !== ticket.assignee) {
          store.updateTicket({ id: ticket.id, assignee: task.ownerName, by: 'agent-team' })
          changes.push('assignee → ' + task.ownerName)
        }
        store.setTeamTask(ticket.id, task)
        return `Synced ${ticket.key} with team task ${task.id} (${task.status})` + (changes.length ? ': ' + changes.join(', ') : ' — nothing to change')
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'board_review',
      description:
        'Record an independent review verdict for a ticket parked at the review gate. A reviewer agent reads the diff and checks and either approves or requests changes; auto-merge is attempted only when autonomy.autoMerge is on and the checks are trusted.',
      properties: {
        id: str('Ticket key or id'),
        verdict: str('approved or changes_requested'),
        notes: str('Review notes: what was checked, concerns, required changes'),
      },
      required: ['id', 'verdict'],
      run: async (args, exec) => {
        const actor = exec?.agent?.id ? String(exec.agent.id) : 'reviewer'
        const ticket = store.find(args.id)
        const verdict = /^change/i.test(String(args.verdict)) ? 'changes_requested' : 'approved'
        const outcome = await recordReview(ticket, verdict, args.notes, actor)
        return `Review on ${ticket.key}: ${verdict}; ${outcome.note}`
      },
    }),
  )

  const sessionsDir = config.sessionsDir ? String(config.sessionsDir) : join(dirname(dataDir), 'sessions')

  function findSessionLog(sessionId) {
    if (!sessionId || !fileExists(sessionsDir)) return null
    for (const group of listDir(sessionsDir)) {
      const candidate = join(sessionsDir, group, sessionId)
      for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
        const file = join(candidate, name)
        if (!fileExists(file)) continue
        try {
          const raw = readFile(file)
          let text
          if (name.endsWith('.zstd')) {
            try {
              text = zstdDecompressSync(raw).toString('utf8')
            } catch (error) {
              // Older runtimes without zstd support can fall back to the CLI.
              text = execFileSync('zstd', ['-dc', file], { maxBuffer: 32 * 1024 * 1024 }).toString('utf8')
            }
          } else {
            text = raw.toString('utf8')
          }
          return { file, text }
        } catch (error) {
          return { file, text: null, error: String(error) }
        }
      }
    }
    return null
  }

  function sessionBelongsToBoard(sessionId) {
    return store.list().some(
      ticket =>
        ticket.plan?.sessionId === sessionId ||
        ticket.reviewSessionId === sessionId ||
        ticket.needsInput?.sessionId === sessionId ||
        (ticket.runs ?? []).some(
          run => run.sessionId === sessionId || (run.subagents ?? []).some(item => item.sessionId === sessionId),
        ),
    )
  }

  function parseTranscript(text) {
    const messages = []
    for (const line of String(text ?? '').split('\n')) {
      if (!line.trim()) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      const blocks = content =>
        (Array.isArray(content) ? content : [])
          .filter(block => block && typeof block.text === 'string')
          .map(block => ({ type: block.type, text: block.text }))
      const at = event.time ?? null
      if (event.type === 'user/message') {
        const content = blocks(event.data?.content ?? event.data?.message?.content)
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .filter(part => !/^(<system-reminder|Current runtime context|Time sampled|# Long-term Memory|<hindsight_knowledge>|<hindsight_memory>)/.test(part.trim()))
          .join('\n')
        if (content.trim()) messages.push({ role: 'user', at, text: content.slice(0, 4000) })
      } else if (event.type === 'assistant/message') {
        const content = blocks(event.data?.message?.content ?? event.data?.content)
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('\n')
        if (content.trim()) messages.push({ role: 'assistant', at, text: content.slice(0, 4000) })
      } else if (event.type === 'tool/call') {
        const name = event.data?.name ?? event.data?.tool
        if (name) messages.push({ role: 'tool', at, text: String(name) })
      }
    }
    const truncated = messages.length > 60
    if (truncated) messages.splice(0, messages.length - 60)
    return { messages, truncated }
  }

  // ── client-facing routes ───────────────────────────────────────────────────
  ctx.connection.fetch.register({
    path: '/api/board/transcript',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => {
      const url = new URL(request.url)
      const sessionId = String(url.searchParams.get('sessionId') ?? '').trim()
      if (!sessionId) return Promise.resolve(Response.json({ error: 'sessionId is required' }, { status: 400 }))
      if (!sessionBelongsToBoard(sessionId)) return Promise.resolve(Response.json({ error: 'this session is not part of the board' }, { status: 404 }))
      const log = findSessionLog(sessionId)
      if (!log) return Promise.resolve(Response.json({ error: 'session transcript is not available on disk' }, { status: 404 }))
      if (log.error || !log.text) {
        return Promise.resolve(Response.json({ error: `could not read the session log: ${log.error ?? 'empty'}` }, { status: 500 }))
      }
      return Promise.resolve(Response.json({ sessionId, ...parseTranscript(log.text) }, { headers: { 'cache-control': 'no-store' } }))
    },
  })
  ctx.connection.fetch.register({
    path: '/api/board/state',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => {
      const summary = new URL(request.url).searchParams.get('summary') === '1'
      return Promise.resolve(Response.json(boardSnapshot({ summary }), { headers: { 'cache-control': 'no-store' } }))
    },
  })

  ctx.connection.fetch.register({
    path: '/api/board/ticket',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => {
      try {
        const id = new URL(request.url).searchParams.get('id')
        if (!id) return Response.json({ error: 'id is required' }, { status: 400 })
        return Response.json({ ticket: store.find(id), revision }, { headers: { 'cache-control': 'no-store' } })
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 404 })
      }
    },
  })

  ctx.connection.fetch.register({
    path: '/api/board/diff',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async request => {
      try {
        const id = new URL(request.url).searchParams.get('id')
        if (!id) return Response.json({ error: 'id is required' }, { status: 400 })
        return Response.json(await runs.diff(id), { headers: { 'cache-control': 'no-store' } })
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
      }
    },
  })

  ctx.connection.fetch.register({
    path: '/api/board/presets',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const presets = ctx.get('agentPresets')
      if (!presets || typeof presets.list !== 'function') return Response.json({ presets: [] })
      try {
        const list = await presets.list()
        return Response.json({
          presets: (Array.isArray(list) ? list : []).map(preset => ({
            id: preset.id,
            name: preset.name ?? preset.id,
            description: preset.description ?? null,
            broken: Boolean(preset.broken),
          })),
        })
      } catch (error) {
        return Response.json({ presets: [], error: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  // Server-sent events: a signed-in browser is admitted through the same trust
  // check the /api routes use, then every successful save pushes a revision.
  function registerEvents(hostCtx) {
    const webServer = hostCtx.get('webServer')
    if (!webServer || typeof webServer.register !== 'function') return
    hostCtx.effect(() => {
      const disposeRoute = webServer.register({
        kind: 'exact',
        path: '/board/events',
        handler: (req, res) => {
          if (req.method !== 'GET') {
            res.writeHead(405)
            res.end()
            return
          }
          const reject = ctx.connection && typeof ctx.connection.requestRejection === 'function'
          const rejection = reject ? ctx.connection.requestRejection({ headers: req.headers }) : 401
          if (rejection) {
            res.writeHead(rejection)
            res.end()
            return
          }
          if (sseClients.size >= 20) {
            res.writeHead(503, { 'content-type': 'text/plain' })
            res.end('too many board listeners\n')
            return
          }
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          })
          res.write(': connected\n\n')
          res.write(`data: ${JSON.stringify({ revision, at: Date.now() })}\n\n`)
          sseClients.add(res)
          res.on('close', () => sseClients.delete(res))
        },
      })
      const heartbeat = setInterval(() => {
        for (const client of [...sseClients]) {
          if (client.destroyed || client.writableEnded) {
            sseClients.delete(client)
            continue
          }
          try {
            client.write(': ping\n\n')
          } catch {
            sseClients.delete(client)
          }
        }
      }, 25000)
      heartbeat.unref?.()
      return () => {
        clearInterval(heartbeat)
        disposeRoute?.()
        for (const client of sseClients) {
          try {
            client.destroy?.()
          } catch {
            /* already gone */
          }
        }
        sseClients.clear()
      }
    }, 'dsh-board: /board/events channel')
  }
  if (typeof ctx.inject === 'function') {
    // Optional dependency: mount the channel whenever the web server exists,
    // including after a restart of that service.
    ctx.inject(['webServer'], scoped => registerEvents(scoped && typeof scoped.get === 'function' ? scoped : ctx))
  } else {
    registerEvents(ctx)
  }

  ctx.connection.fetch.register({
    path: '/api/board/action',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => {
      let body
      try {
        body = await request.json()
      } catch {
        return Response.json({ error: 'invalid JSON body' }, { status: 400 })
      }
      try {
        switch (body?.action) {
          case 'create':
            store.createTicket({
              title: body.title,
              description: body.description,
              acceptance: body.acceptance,
              checks: body.checks,
              status: body.status,
              assignee: body.assignee,
              blockedBy: body.blockedBy,
              priority: body.priority,
              budgetTokens: body.budgetTokens,
              budgetMinutes: body.budgetMinutes,
              by: 'human',
            })
            break
          case 'update': {
            const target = store.find(body.id)
            const activeRun = store.currentRun(target)
            if (body.status !== undefined) {
              if (body.status === store.workflow.done) {
                throw conflict(
                  `approve a ticket from ${store.stateLabel(store.workflow.gate)} instead of setting ${store.stateLabel(store.workflow.done)} directly`,
                )
              }
              // A gate ticket with a live run or an unmerged worktree has only two
              // exits (Approve/Reject). One parked by hand with no work behind it can
              // be moved back, so a mis-click is not a dead end.
              const openWork = Boolean(activeRun) || target.runs.some(run => run.worktree && !run.merge && !run.prunedAt && !run.worktree.superseded)
              if (target.status === store.workflow.gate && body.status !== store.workflow.gate && openWork) {
                throw conflict(
                  `a ticket in ${store.stateLabel(store.workflow.gate)} with an open run or an unmerged branch leaves the gate only through Approve or Reject`,
                )
              }
              if (activeRun && body.status === store.workflow.gate) {
                throw conflict('the worker is still running; it parks the ticket at the gate when it settles')
              }
            }
            store.updateTicket({
              id: body.id,
              status: body.status,
              title: body.title,
              description: body.description,
              acceptance: body.acceptance,
              assignee: body.assignee,
              blockedBy: body.blockedBy,
              priority: body.priority,
              budgetTokens: body.budgetTokens,
              budgetMinutes: body.budgetMinutes,
              checks: body.checks,
              by: 'human',
            })
            dispatch()
            break
          }
          case 'assign':
            store.updateTicket({ id: body.id, assignee: body.assignee ?? null, by: 'human' })
            dispatch()
            break
          case 'comment': {
            const text = String(body.text ?? '').trim()
            if (!text) throw new Error('text is required')
            const target = store.find(body.id)
            // Persist the comment first: if that write fails nothing has been
            // delivered, so the human can retry without double-sending. The
            // delivery marker is best-effort and never fails the request.
            const ticket = store.commentTicket({ id: target.id, text, by: 'human' })
            const delivery = runs.steer(ticket.id, text)
            if (delivery.delivered) {
              try {
                store.annotateComment(ticket.id, delivery.runId)
              } catch (error) {
                console.log(`[board] comment delivered to ${delivery.runId} but the marker was not saved: ${String(error)}`)
              }
            }
            return Response.json({ ...boardSnapshot(), delivery }, { headers: { 'cache-control': 'no-store' } })
          }
          case 'budget':
            store.updateTicket({ id: body.id, budgetTokens: body.tokens, by: 'human' })
            break
          case 'start':
            await runs.start(body.id)
            break
          case 'open-pr': {
            const result = await runs.openPullRequest(body.id, 'human')
            return Response.json({ ...boardSnapshot(), pullRequest: result }, { headers: { 'cache-control': 'no-store' } })
          }
          case 'pr-merged':
            await runs.markPullRequestMerged(body.id, 'human')
            break
          case 'approve':
            await runs.approve(body.id, 'human', { overrideChecks: body.overrideChecks === true, reason: body.reason })
            break
          case 'reject':
            await runs.reject(body.id, body.reason, 'human')
            break
          case 'cancel':
            await runs.cancel(body.id, 'human')
            break
          case 'retry':
            await runs.retry(body.id, 'human')
            break
          case 'export-json': {
            const target = body.path ? String(body.path) : join(dataDir, 'board.export.json')
            if (!/\.json$/i.test(target)) throw new Error('export path must end with .json')
            const written = store.exportJson(target)
            return Response.json({ ...boardSnapshot(), exportPath: written }, { headers: { 'cache-control': 'no-store' } })
          }
          case 'notifications-read': {
            store.markNotificationsRead(body.ids)
            break
          }
          case 'answer': {
            store.answerInput(body.id, body.answer, 'human')
            dispatch()
            break
          }
          case 'plan-start': {
            const ticket = store.find(body.id)
            const sessionId = await ensurePlanSession(ticket)
            store.startPlanning(ticket.id, sessionId, 'human')
            return Response.json({ ...boardSnapshot(), planSessionId: sessionId }, { headers: { 'cache-control': 'no-store' } })
          }
          case 'plan-changes': {
            const ticket = store.find(body.id)
            const plan = store.requestPlanChanges(ticket.id, body.feedback, 'human')
            const handle = planHandles.get(plan.sessionId)
            if (handle?.agent) {
              try {
                handle.agent.followup({
                  id: randomUUID(),
                  role: 'user',
                  content: [{ type: 'text', text: `[Board review] The human asked to refine the plan: ${String(body.feedback)}` }],
                  source: { kind: 'user' },
                })
              } catch (error) {
                console.log(`[board] could not send plan feedback to ${plan.sessionId}: ${String(error)}`)
              }
            }
            break
          }
          case 'plan-approve': {
            approvePlanWithDefaults(body.id)
            dispatch()
            break
          }
          case 'gc': {
            const report = await runs.gc({ apply: body.apply === true })
            return Response.json({ ...boardSnapshot(), gc: report }, { headers: { 'cache-control': 'no-store' } })
          }
          case 'batch': {
            const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 50) : []
            const op = String(body.op ?? '')
            const results = []
            for (const id of ids) {
              try {
                if (op === 'approve') {
                  await runs.approve(id, 'human')
                } else if (op === 'archive') {
                  store.setArchived(id, true, 'human', { force: body.force === true })
                } else if (op === 'assign') {
                  const assignee = String(body.assignee ?? '').trim()
                  if (!assignee) throw new Error('assignee is required')
                  store.updateTicket({ id, assignee, by: 'human' })
                } else {
                  throw new Error(`unknown batch op "${op}"`)
                }
                results.push({ id, ok: true })
              } catch (error) {
                results.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
              }
            }
            dispatch()
            return Response.json({ ...boardSnapshot(), batch: results }, { headers: { 'cache-control': 'no-store' } })
          }
          case 'archive':
            store.setArchived(body.id, true, 'human', { force: body.force === true })
            break
          case 'unarchive':
            store.setArchived(body.id, false, 'human')
            dispatch()
            break
          case 'prune': {
            const report = await runs.prune({
              includeArchived: body.includeArchived === true,
              force: body.force === true,
            })
            return Response.json({ ...boardSnapshot(), prune: report }, { headers: { 'cache-control': 'no-store' } })
          }
          default:
            return Response.json({ error: `unknown action: ${String(body?.action)}` }, { status: 400 })
        }
        return Response.json(boardSnapshot(), { headers: { 'cache-control': 'no-store' } })
      } catch (error) {
        const status = typeof error?.status === 'number' ? error.status : 400
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status })
      }
    },
  })

  return {
    storePath,
    workspace: runs.workspace,
    maxWorkers: runs.maxWorkers,
    agentPreset: runs.agentPreset,
    worktrees: runs.worktreesEnabled,
    loadWarning: store.loadWarning,
  }
}
