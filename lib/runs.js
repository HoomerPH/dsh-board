/**
 * Run controller: binds board tickets to real harness agent sessions.
 *
 * The board is the scheduler. When a Ready ticket has an assignee and capacity
 * exists, this controller creates a worker Agent on its own durable session,
 * feeds it the ticket contract, and parks the ticket at the review gate when the
 * worker settles. Approval closes the run; rejection resumes the same session
 * with the reviewer's reason.
 *
 * Safety rules (Slice 0):
 *   - gate actions are serialized per ticket, and merges per repository, so two
 *     tabs cannot interleave store writes or one Git index;
 *   - a run records the branch it started from; approval refuses when the base
 *     checkout is on another branch or the base moved since the run started;
 *   - a failed squash never hard-resets a shared checkout: the index is rolled
 *     back to the pre-merge commit and any residue is reported;
 *   - a worker that is still running cannot be approved/rejected, and a gate
 *     ticket releases its agent (the session id is enough to resume it);
 *   - cleanup runs in `finally`, so a failed save or a failed turn never leaks a
 *     worker slot.
 */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const CANCEL = { kind: 'user' }

function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    source: { kind: 'user' },
  }
}

/** FIFO async mutex keyed by `key`; the returned promise rejects with the task's error. */
function serialize(map, key, task) {
  const previous = map.get(key) ?? Promise.resolve()
  const current = previous.then(() => task())
  const guarded = current.then(
    () => {},
    () => {},
  )
  map.set(key, guarded)
  guarded.then(() => {
    if (map.get(key) === guarded) map.delete(key)
  })
  return current
}

export function createRunController({ ctx, store, config = {}, log = () => {} }) {
  const maxWorkers = Math.max(1, Number(config.maxWorkers) || 2)
  const agentPreset = config.agentPreset ?? 'standard'
  const worktreesEnabled = config.worktrees !== false
  const gitTimeoutMs = Math.max(5000, Number(config.gitTimeoutMs) || 120000)
  const maxSubagents = Math.max(1, Number(config.maxSubagents) || 4)
  const approvalTtlHours = Math.max(0, Number(config.approvalTtlHours) || 0)
  const checkPolicy = {
    allow: Array.isArray(config.checks?.allow) ? config.checks.allow.map(String) : [],
    deny: Array.isArray(config.checks?.deny) ? config.checks.deny.map(String) : [],
  }

  /** Deny-list first, then an optional allow-list; returns a reason or null. */
  function checkBlocked(command) {
    const matches = pattern => {
      try {
        return new RegExp(pattern).test(command)
      } catch {
        return command.includes(pattern)
      }
    }
    const denied = checkPolicy.deny.find(matches)
    if (denied) return `blocked by the board checks policy (deny: ${denied})`
    if (checkPolicy.allow.length && !checkPolicy.allow.some(matches)) {
      return 'blocked by the board checks policy (does not match any allow pattern)'
    }
    return null
  }
  const pullRequest =
    config.pullRequest && config.pullRequest.repository && config.pullRequest.token
      ? {
          repository: String(config.pullRequest.repository),
          token: String(config.pullRequest.token),
          base: String(config.pullRequest.base || 'main'),
          remote: String(config.pullRequest.remote || 'origin'),
          provider: String(config.pullRequest.provider || 'github'),
          autoSync: config.pullRequest.autoSync === true,
          pollMs: Math.max(1000, Number(config.pullRequest.pollMs) || 60000),
          apiBase: String(
            config.pullRequest.apiBase ||
              (String(config.pullRequest.provider || 'github') === 'gitlab' ? 'https://gitlab.com/api/v4' : 'https://api.github.com'),
          ).replace(/\/$/, ''),
        }
      : null
  const workflow = store.workflow
  const workspace = resolve(config.workspace ?? process.cwd())
  const active = new Map()
  const workerSessions = new Map()
  const childSessions = new Map()
  const subscriptions = []
  const queue = new Set()
  const ticketLocks = new Map()
  const repoLocks = new Map()
  let pumping = false
  let disposed = false

  const withTicketLock = (ticketId, task) => serialize(ticketLocks, ticketId, task)
  const withRepoLock = (repo, task) => serialize(repoLocks, repo, task)
  const fire = promise => {
    promise.catch(error => log(`[board] background task failed: ${String(error)}`))
  }

  /** Resolve the ticket first so a key and an id for the same ticket share one lock. */
  const lockTicket = (ticketId, task) => withTicketLock(store.find(ticketId).id, task)

  /** In-memory rollback for a ticket mutation whose write failed. */
  function captureTicket(ticket) {
    return {
      status: ticket.status,
      title: ticket.title,
      description: ticket.description,
      assignee: ticket.assignee,
      updatedAt: ticket.updatedAt,
      activityLength: ticket.activity.length,
      activity: ticket.activity.map(event => ({ ...event })),
      currentRunId: ticket.currentRunId,
      runs: ticket.runs.map(run => ({ ...run })),
    }
  }

  function restoreTicket(ticket, snapshot) {
    ticket.status = snapshot.status
    ticket.title = snapshot.title
    ticket.description = snapshot.description
    ticket.assignee = snapshot.assignee
    ticket.updatedAt = snapshot.updatedAt
    if (Array.isArray(snapshot.activity)) ticket.activity = snapshot.activity.map(event => ({ ...event }))
    else ticket.activity.length = snapshot.activityLength
    ticket.currentRunId = snapshot.currentRunId
    for (let index = 0; index < snapshot.runs.length; index += 1) {
      const target = ticket.runs[index]
      const source = snapshot.runs[index]
      if (!target) continue
      // Fields added after the capture (`merge`, `cleanupError`, …) must go too,
      // otherwise memory keeps a marker the disk does not have.
      for (const key of Object.keys(target)) {
        if (!(key in source)) delete target[key]
      }
      Object.assign(target, source)
    }
    ticket.runs.length = snapshot.runs.length
  }

  try {
    mkdirSync(workspace, { recursive: true })
  } catch {
    /* the worker will surface an unusable cwd instead */
  }

  function selection() {
    const configured = ctx.get('agentDefaultModel')
    const current = configured?.currentSelection?.()
    return current ? { provider: current.provider, model: current.model } : undefined
  }

  function measureTokens(agent) {
    if (!agent) return 0
    try {
      return Number(ctx.get('tokenMeter')?.measure(agent.session)?.totalTokens ?? 0)
    } catch {
      return 0
    }
  }

  function measureSubtree(entry) {
    let total = 0
    try {
      total += Number(ctx.get('tokenMeter')?.measure(entry.agent.session)?.totalTokens ?? 0)
    } catch {
      /* measurement is best-effort */
    }
    for (const session of entry.subagents?.values() ?? []) {
      try {
        total += Number(ctx.get('tokenMeter')?.measure(session)?.totalTokens ?? 0)
      } catch {
        /* a child that vanished mid-measure simply stops counting */
      }
    }
    return total
  }

  function syncSubagents(entry) {
    const ticket = store.list().find(item => item.id === entry.ticketId)
    const run = ticket && (store.currentRun(ticket) ?? ticket.runs[ticket.runs.length - 1])
    if (!run) return
    const list = [...(entry.subagents?.keys() ?? [])].map(sessionId => ({ sessionId, at: new Date().toISOString() }))
    store.patchRun(run, { subagents: list })
    try {
      store.save()
    } catch (error) {
      log(`[board] could not persist subagents for run ${run.id}: ${String(error)}`)
    }
  }

  function trackSession(session) {
    const parent = session?.header?.parentSession
    if (!parent) return
    const entry = workerSessions.get(parent) ?? childSessions.get(parent)
    if (!entry) return
    entry.subagents = entry.subagents ?? new Map()
    entry.subagents.set(session.id, session)
    childSessions.set(session.id, entry)
    syncSubagents(entry)
    if (entry.subagents.size > maxSubagents && !entry.subagentOverflow) {
      entry.subagentOverflow = true
      log(`[board] run ${entry.runId} exceeded ${maxSubagents} subagents; cancelling`)
      try {
        entry.agent?.cancel(CANCEL)
      } catch {
        /* already stopping */
      }
    }
  }

  function untrackSession(session) {
    const entry = session?.id ? childSessions.get(session.id) : null
    if (!entry) return
    childSessions.delete(session.id)
    entry.subagents?.delete(session.id)
    syncSubagents(entry)
  }

  if (typeof ctx.on === 'function') {
    subscriptions.push(ctx.on('session/created', trackSession))
    subscriptions.push(ctx.on('session/disposed', untrackSession))
  }

  function registerWorkerSession(entry) {
    if (!entry?.agent) return
    workerSessions.set(entry.agent.id, entry)
    if (entry.agent.session?.id) workerSessions.set(entry.agent.session.id, entry)
  }

  function forgetSessions(entry) {
    for (const [id, owner] of workerSessions) if (owner === entry) workerSessions.delete(id)
    for (const [id, owner] of childSessions) if (owner === entry) childSessions.delete(id)
  }

  function runningCount() {
    let count = 0
    for (const entry of active.values()) {
      if (entry.phase === 'starting' || entry.phase === 'running') count += 1
    }
    return count
  }

  function dependenciesMet(ticket) {
    const deps = Array.isArray(ticket.blockedBy) ? ticket.blockedBy : []
    if (!deps.length) return true
    return deps.every(id => {
      const dependency = store.list().find(item => item.id === id)
      return Boolean(dependency) && dependency.status === workflow.done
    })
  }

  function isDispatchable(ticket) {
    return (
      ticket.status === workflow.dispatch &&
      Boolean(ticket.assignee) &&
      !ticket.archivedAt &&
      (ticket.subtaskIds?.length ?? 0) === 0 &&
      !ticket.currentRunId &&
      !active.has(ticket.id) &&
      dependenciesMet(ticket)
    )
  }

  function brief(ticket) {
    const lines = [
      `You are the assigned agent for board ticket ${ticket.key} — "${ticket.title}".`,
      `Workspace: ${workspace}`,
      '',
      ticket.description || '(no description)',
    ]
    if (ticket.acceptance.length) {
      lines.push('', 'Acceptance criteria:')
      for (const item of ticket.acceptance) lines.push(`- ${item}`)
    }
    if (Array.isArray(ticket.checks) && ticket.checks.length) {
      lines.push('', 'Verification checks the board runs when you move the ticket to review:')
      for (const check of ticket.checks) lines.push(`- ${check.name}: ${check.command}`)
    }
    const notes = ticket.activity.filter(event => event.kind === 'comment').slice(-5)
    if (notes.length) {
      lines.push('', 'Recent human notes:')
      for (const note of notes) lines.push(`- ${note.by}: ${note.text}`)
    }
    lines.push(
      '',
      `Work autonomously in the workspace. You may delegate to subagents, but keep the total at or below ${maxSubagents} child sessions. If a human decision genuinely blocks you, use board_ask with a concrete question; otherwise record blockers on the ticket instead.`,
      'Do not call board_claim: this ticket is already assigned to you.',
      '',
      'When the work is finished:',
      '1. Commit everything you changed on your branch: git add -A && git commit -m "<ticket key>: <summary>".',
      '   A run whose branch has no commits cannot be merged.',
      '2. Attach artifacts with board_artifact (PR URL, branch, changed files, test output).',
      '3. Add a short summary with board_comment.',
      `4. Move the ticket to status "${workflow.gate}" (${store.stateLabel(workflow.gate)}) with board_update.`,
      '',
      `If you cannot proceed, move the ticket to status "${workflow.blocked}" (${store.stateLabel(workflow.blocked)}) with board_update and explain why in a comment.`,
    )
    return lines.join('\n')
  }

  function rejectionBrief(ticket, reason) {
    return [
      `Review rejected board ticket ${ticket.key} — "${ticket.title}".`,
      `Reviewer reason: ${reason}`,
      '',
      `Continue the work in the same workspace, address the reason, then re-attach artifacts, comment, and move the ticket back to status "${workflow.gate}" (${store.stateLabel(workflow.gate)}).`,
    ].join('\n')
  }

  /** Put the worker session in the board's workspace group instead of "Ungrouped". */
  async function attachWorkerToWorkspace(agent) {
    try {
      const registry = ctx.get('workspaceRegistry')
      if (!registry || typeof registry.resolveByPath !== 'function') return
      const entity = await registry.resolveByPath(workspace)
      if (entity && typeof entity.attachSession === 'function') await entity.attachSession(agent.id)
    } catch (error) {
      log(`[board] could not attach the worker session to the workspace: ${String(error)}`)
    }
  }

  /**
   * Give every run its own retained Git checkout, so two tickets never share a
   * tree. Best effort: a non-Git workspace keeps the run in the shared checkout
   * and records why on the run.
   */
  async function isolateWorktree(ticket, run, entry) {
    if (!worktreesEnabled) return
    const worktrees = ctx.get('worktrees')
    if (!worktrees || !entry.agent) return
    const name = `board/${String(ticket.key).toLowerCase()}-${String(run.id).slice(-4)}`
    try {
      const created = await worktrees.create(entry.agent, { name })
      const repositoryRoot = created.repositoryRoot ?? (await resolveRepositoryRoot({ path: created.path }))
      let baseBranch = created.baseBranch ?? null
      if (!baseBranch && repositoryRoot) {
        try {
          baseBranch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repositoryRoot)
        } catch {
          baseBranch = null
        }
      }
      if (!baseBranch) {
        log(`[board] run ${run.id}: could not determine the base branch; approval will refuse until the run is repeated`)
      }
      store.patchRun(run, {
        worktree: {
          path: created.path,
          branch: created.branch,
          baseCommit: created.baseCommit,
          repositoryRoot,
          baseBranch,
        },
      })
      store.touch(ticket, 'system', 'worktree', `isolated on ${created.branch} at ${created.path}`)
      store.save()
      log(`[board] run ${run.id} isolated on ${created.branch}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      store.patchRun(run, { worktreeError: message })
      store.touch(ticket, 'system', 'worktree', `worktree unavailable: ${message}`)
      store.save()
      log(`[board] run ${run.id} stays in the shared checkout: ${message}`)
    }
  }

  function outputTail(output, limit = 800) {
    const text = String(output ?? '')
    return text.length > limit ? `…${text.slice(-limit)}` : text
  }

  function checkoutDir(run) {
    return run?.worktree?.path && existsSync(run.worktree.path) ? run.worktree.path : workspace
  }

  /** HEAD and tracked-file dirtiness of a checkout, or null when it is not a Git repo. */
  async function readCheckoutMeta(workdir) {
    try {
      const head = await git(['rev-parse', 'HEAD'], workdir)
      const dirty = await git(['status', '--porcelain', '--untracked-files=no'], workdir)
      return { workdir, head, dirty: Boolean(dirty), at: new Date().toISOString() }
    } catch {
      return null
    }
  }

  function formatBudget(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000))
    if (seconds < 90) return `${seconds}s`
    return `${Math.round(seconds / 60)}m`
  }

  function checksSignature(checks) {
    return JSON.stringify(
      (Array.isArray(checks) ? checks : []).map(check => ({
        name: String(check.name ?? ''),
        command: String(check.command ?? ''),
        timeoutMs: check.timeoutMs ?? null,
      })),
    )
  }

  /** A check fails unless it exited exactly zero without timeout, abort or signal. */
  function isFailedCheck(check) {
    if (!check || check.skipped) return false
    return !(check.exitCode === 0 && !check.timedOut && !check.aborted && !check.signal)
  }

  /**
   * Run the ticket's configured checks in the run's checkout and record the
   * result on the run. Without a shell service the checks are marked skipped
   * (non-blocking); any execution error is a failed check that needs an override.
   */
  async function runChecks(ticket, run) {
    const checks = Array.isArray(ticket.checks) ? ticket.checks : []
    if (!checks.length) return []
    const shell = ctx.get('shell')
    const workdir = checkoutDir(run)
    const results = []
    for (const check of checks) {
      const startedAt = Date.now()
      const result = {
        name: check.name,
        command: check.command,
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: false,
        durationMs: 0,
        stdout: '',
        stderr: '',
        at: new Date().toISOString(),
      }
      const blocked = checkBlocked(check.command)
      if (blocked) {
        result.blocked = true
        result.error = blocked
        result.durationMs = Date.now() - startedAt
        results.push(result)
        continue
      }
      if (!shell || typeof shell.resolve !== 'function' || typeof shell.execute !== 'function') {
        result.skipped = true
        result.skippedReason = 'no-shell'
        result.error = 'shell service unavailable; check was not run'
        results.push(result)
        continue
      }
      try {
        const spec = shell.resolve({
          command: check.command,
          workdir,
          timeoutMs: Number(check.timeoutMs) > 0 ? Number(check.timeoutMs) : 120000,
        })
        const execution = await shell.execute(spec)
        const outcome = await execution.result()
        result.exitCode = outcome.exitCode
        result.signal = outcome.signal
        result.timedOut = Boolean(outcome.timedOut)
        result.aborted = Boolean(outcome.aborted)
        result.stdout = outputTail(outcome.stdout?.text)
        result.stderr = outputTail(outcome.stderr?.text)
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error)
      }
      result.durationMs = Date.now() - startedAt
      results.push(result)
    }
    // Record what the checks actually saw: approval merges commits, so tracked
    // edits (or a newer commit) left in the checkout mean the tested code is not
    // what would merge.
    const checksMeta = (await readCheckoutMeta(workdir)) ?? { workdir, head: null, dirty: null, at: new Date().toISOString() }
    store.patchRun(run, { checks: results, checksAt: new Date().toISOString(), checksKey: checksSignature(checks), checksMeta })
    const failed = results.filter(isFailedCheck)
    store.touch(
      ticket,
      'system',
      'checks',
      failed.length
        ? `checks failed: ${failed.map(check => check.name).join(', ')}`
        : `checks passed: ${results.filter(check => !check.skipped).map(check => check.name).join(', ') || 'none ran'}`,
    )
    try {
      store.save()
    } catch (error) {
      log(`[board] could not persist check results for run ${run.id}: ${String(error)}`)
    }
    return results
  }

  /** Park a settled run at the gate after its checks ran. */
  async function parkAtGate(ticket, run, entry) {
    if (Array.isArray(ticket.checks) && ticket.checks.length) {
      entry.phase = 'checking'
      store.patchRun(run, { status: 'checking' })
      try {
        store.save()
      } catch (error) {
        log(`[board] could not persist run ${run.id} checking: ${String(error)}`)
      }
      try {
        await runChecks(ticket, run)
      } catch (error) {
        log(`[board] checks for run ${run.id} crashed: ${String(error)}`)
      }
    }
    if (run.endedAt) {
      // A gate action closed this run while its checks were still running.
      await release(ticket.id, entry)
      pump()
      return
    }
    entry.phase = 'awaiting_review'
    store.patchRun(run, { status: 'awaiting_review' })
    store.addNotification('review_ready', ticket, `${ticket.key} is ready for review`)
    try {
      store.save()
    } catch (error) {
      log(`[board] could not persist run ${run.id} awaiting review: ${String(error)}`)
    }
    await release(ticket.id, entry)
    pump()
  }

  function stopBudgetWatch(entry) {
    if (entry?.timer) {
      clearInterval(entry.timer)
      entry.timer = null
    }
  }

  let presetBinding
  async function presetSetup() {
    const presets = ctx.get('agentPresets')
    if (!presets) return { id: undefined, setup: undefined }
    if (!presetBinding) {
      presetBinding = (async () => {
        try {
          const resolved = await presets.resolve(agentPreset)
          const id = resolved?.id ?? agentPreset
          return {
            id,
            setup: async agentCtx => {
              await presets.mount(agentCtx, id)
            },
          }
        } catch (error) {
          log(`[board] agent preset "${agentPreset}" unavailable: ${String(error)}`)
          return { id: undefined, setup: undefined }
        }
      })()
    }
    return presetBinding
  }

  function beginBudgetWatch(ticket, run, entry) {
    stopBudgetWatch(entry)
    entry.budgetStartedAt = entry.budgetStartedAt ?? Date.now()
    const startedAt = entry.budgetStartedAt
    entry.timer = setInterval(() => {
      if (entry.cancelled || !entry.agent) return
      const tokenBudget = Number(ticket.budget?.tokens ?? 0)
      const hasTokenBudget = Number.isFinite(tokenBudget) && tokenBudget > 0
      if (hasTokenBudget) {
        const tokens = measureSubtree(entry)
        if (tokens > run.tokens) {
          run.tokens = tokens
          try {
            store.save()
          } catch {
            /* a failed snapshot must not stop the worker */
          }
        }
        if (tokens > tokenBudget) {
          entry.overBudget = true
          log(`[board] run ${run.id} exceeded its token budget (${tokens} > ${tokenBudget}); cancelling`)
          try {
            entry.agent.cancel(CANCEL)
          } catch {
            /* already stopping */
          }
        }
      }
      const minutes = Number(ticket.budget?.minutes ?? 0)
      const deadline = minutes > 0 ? startedAt + minutes * 60000 : null
      if (deadline && Date.now() > deadline) {
        entry.overTime = true
        log(`[board] run ${run.id} exceeded its wall-clock budget (${formatBudget(Date.now() - startedAt)} > ${minutes}m); cancelling`)
        try {
          entry.agent.cancel(CANCEL)
        } catch {
          /* already stopping */
        }
      }
    }, 4000)
    entry.timer.unref?.()
  }

  function pump() {
    if (disposed || pumping) return
    pumping = true
    try {
      while (runningCount() < maxWorkers) {
        const ticket = nextDispatchable()
        if (!ticket) break
        try {
          startRun(ticket)
        } catch (error) {
          // A disk or state error while dispatching must not escape a worker's
          // cleanup path; the ticket stays dispatchable and the next pump retries.
          log(`[board] could not dispatch ${ticket.key}: ${String(error)}`)
          break
        }
      }
      // Everything still dispatchable has no slot: track it durably.
      if (runningCount() >= maxWorkers) {
        for (const ticket of store.list()) {
          if (isDispatchable(ticket)) queueTicket(ticket, `${maxWorkers} workers busy`)
        }
      }
    } finally {
      pumping = false
    }
  }

  function nextDispatchable() {
    const candidates = []
    for (const id of [...queue]) {
      queue.delete(id)
      const ticket = store.list().find(item => item.id === id)
      if (ticket && isDispatchable(ticket)) candidates.push(ticket)
    }
    for (const ticket of store.list()) {
      if (isDispatchable(ticket) && !candidates.includes(ticket)) candidates.push(ticket)
    }
    candidates.sort((a, b) => {
      const priority = (Number(b.priority) || 0) - (Number(a.priority) || 0)
      if (priority) return priority
      const aQueued = a.queuedAt ? Date.parse(a.queuedAt) : Number.MAX_SAFE_INTEGER
      const bQueued = b.queuedAt ? Date.parse(b.queuedAt) : Number.MAX_SAFE_INTEGER
      if (aQueued !== bQueued) return aQueued - bQueued
      return String(a.key).localeCompare(String(b.key))
    })
    return candidates[0] ?? null
  }

  /** Track a waiting ticket durably so the queue survives a restart. */
  function queueTicket(ticket, reason) {
    const first = !queue.has(ticket.id)
    queue.add(ticket.id)
    const stamped = Boolean(ticket.queuedAt)
    ticket.queuedAt = ticket.queuedAt ?? new Date().toISOString()
    if (!first && stamped) return
    store.touch(ticket, 'system', 'queue', `queued: ${reason}`)
    try {
      store.save()
    } catch (error) {
      log(`[board] could not persist the queue state for ${ticket.key}: ${String(error)}`)
    }
  }

  function startRun(ticket) {
    if (disposed || !isDispatchable(ticket)) return
    const snapshot = {
      status: ticket.status,
      updatedAt: ticket.updatedAt,
      activityLength: ticket.activity.length,
      runsLength: ticket.runs.length,
      currentRunId: ticket.currentRunId,
      queuedAt: ticket.queuedAt,
    }
    const run = store.addRun(ticket, { status: 'starting' })
    queue.delete(ticket.id)
    ticket.queuedAt = null
    ticket.status = workflow.active
    store.touch(ticket, 'system', 'run', `run ${run.id} started for @${ticket.assignee}`)
    try {
      store.save()
    } catch (error) {
      ticket.status = snapshot.status
      ticket.updatedAt = snapshot.updatedAt
      ticket.activity.length = snapshot.activityLength
      ticket.runs.length = snapshot.runsLength
      ticket.currentRunId = snapshot.currentRunId
      ticket.queuedAt = snapshot.queuedAt
      throw error
    }
    const pendingAnswer = ticket.pendingAnswer
    if (pendingAnswer) store.clearPendingAnswer(ticket)
    const entry = {
      ticketId: ticket.id,
      runId: run.id,
      budgetStartedAt: Date.now(),
      phase: 'starting',
      handle: null,
      agent: null,
      cancelled: false,
      overBudget: false,
      timer: null,
    }
    active.set(ticket.id, entry)
    if (pendingAnswer?.sessionId) {
      run.sessionId = pendingAnswer.sessionId
      fire(resumeAndDrive(ticket, run, entry, `A human answered your question: ${pendingAnswer.text}\n\nContinue the work, then attach artifacts, comment, and move the ticket to ${store.stateLabel(workflow.gate)}.`))
    } else {
      fire(driveTicket(ticket, run, entry, brief(ticket)))
    }
  }

  async function driveTicket(ticket, run, entry, text) {
    try {
      if (!entry.agent) {
        const preset = await presetSetup()
        const handle = await ctx.get('agents').create({
          sessionId: `session-${randomUUID()}`,
          meta: { cwd: workspace, ...(preset.id ? { agentPreset: preset.id } : {}) },
          agentOptions: selection(),
          ...(preset.setup ? { setup: preset.setup } : {}),
        })
        // A cancel (or a host shutdown) can land while the session is being created.
        if (disposed || entry.cancelled || run.endedAt) {
          try {
            await handle.dispose()
          } catch {
            /* the handle is already being torn down */
          }
          await release(ticket.id, entry)
          return
        }
        entry.handle = handle
        entry.agent = handle.agent
        registerWorkerSession(entry)
        try {
          ctx.get('approval')?.setPolicy(handle.agent, 'never')
        } catch (error) {
          log(`[board] could not set approval policy on worker: ${String(error)}`)
        }
        await attachWorkerToWorkspace(handle.agent)
        await isolateWorktree(ticket, run, entry)
        if (disposed || entry.cancelled || run.endedAt) {
          await release(ticket.id, entry)
          return
        }
      }
      if (entry.cancelled || run.endedAt || disposed) {
        await release(ticket.id, entry)
        return
      }
      entry.phase = 'running'
      entry.runId = run.id
      entry.overBudget = false
      store.patchRun(run, { status: 'running', sessionId: entry.agent.id })
      store.save()
      beginBudgetWatch(ticket, run, entry)
      entry.pendingSteers = 0
      entry.agent.followup(userMessage(text))
      await entry.agent.whenIdle()
      // Keep the run's turn open while human comments keep arriving, then close
      // steering before settling so no comment can land after cleanup started.
      for (;;) {
        entry.phase = 'draining'
        if (!entry.pendingSteers) break
        entry.pendingSteers = 0
        entry.phase = 'running'
        await entry.agent.whenIdle()
      }
      await settle(ticket, run, entry)
    } catch (error) {
      await fail(ticket, run, entry, error)
    }
  }

  async function settle(ticket, run, entry) {
    stopBudgetWatch(entry)
    if (entry.cancelled || disposed) {
      await release(ticket.id, entry)
      return
    }
    if (run.endedAt) {
      // A gate action closed this run while the worker's last turn was finishing.
      await release(ticket.id, entry)
      pump()
      return
    }
    const tokens = measureSubtree(entry)
    store.patchRun(run, { tokens })
    if (entry.subagentOverflow) {
      store.closeRun(ticket, run, 'blocked', `subagent fan-out exceeded: more than ${maxSubagents} subagents`)
      ticket.status = workflow.blocked
      store.touch(ticket, 'system', 'run', `run ${run.id} stopped: more than ${maxSubagents} subagents were started`)
      try {
        store.save()
      } catch (error) {
        log(`[board] could not persist run ${run.id} fan-out stop: ${String(error)}`)
      }
      await release(ticket.id, entry)
      pump()
      return
    }
    const minutes = Number(ticket.budget?.minutes ?? 0)
    const budgetStartedAt = entry.budgetStartedAt ?? (run.startedAt ? Date.parse(run.startedAt) : Date.now())
    const measured = formatBudget(Date.now() - budgetStartedAt)
    if (entry.overTime || (minutes > 0 && Date.now() > budgetStartedAt + minutes * 60000)) {
      store.closeRun(ticket, run, 'blocked', `wall-clock budget exceeded: ${measured} > ${minutes}m`)
      ticket.status = workflow.blocked
      store.touch(ticket, 'system', 'run', `run ${run.id} stopped: wall-clock budget exceeded (${measured} > ${minutes}m)`)
      try {
        store.save()
      } catch (error) {
        log(`[board] could not persist run ${run.id} time stop: ${String(error)}`)
      }
      await release(ticket.id, entry)
      pump()
      return
    }
    const budget = Number(ticket.budget?.tokens ?? 0)
    if (entry.overBudget || (budget > 0 && tokens > budget)) {
      store.closeRun(ticket, run, 'blocked', `token budget exceeded: ${tokens} > ${budget}`)
      ticket.status = workflow.blocked
      store.touch(ticket, 'system', 'run', `run ${run.id} stopped: token budget exceeded (${tokens} > ${budget})`)
      try {
        store.save()
      } catch (error) {
        log(`[board] could not persist run ${run.id} budget stop: ${String(error)}`)
      }
      await release(ticket.id, entry)
      pump()
      return
    }
    if (ticket.status === workflow.gate) {
      // The session id is enough to resume on rejection; a parked ticket must
      // not pin a live agent (and checks must not consume a worker slot).
      await parkAtGate(ticket, run, entry)
      return
    }
    if (ticket.status === workflow.blocked || ticket.status === workflow.done) {
      const outcome = ticket.status === workflow.done ? 'done' : ticket.needsInput ? 'needs_input' : 'blocked'
      store.patchRun(run, { status: outcome, tokens })
      // Closing the run clears currentRunId, so a blocked ticket can be retried
      // (the worker moved it to blocked and ended its turn).
      store.closeRun(ticket, run, outcome, outcome === 'blocked' ? 'worker moved the ticket to blocked' : null)
      try {
        store.save()
      } catch (error) {
        log(`[board] could not persist run ${run.id} settle: ${String(error)}`)
      }
      await release(ticket.id, entry)
      pump()
      return
    }
    ticket.status = workflow.gate
    store.touch(ticket, 'system', 'run', `run ${run.id} settled without moving the ticket; parked in review`)
    try {
      store.save()
    } catch (error) {
      log(`[board] could not persist run ${run.id} parking: ${String(error)}`)
    }
    await parkAtGate(ticket, run, entry)
  }

  async function fail(ticket, run, entry, error) {
    stopBudgetWatch(entry)
    try {
      if (run.endedAt) return
      const message = error instanceof Error ? error.message : String(error)
      log(`[board] run ${run.id} failed: ${message}`)
      if (disposed) return
      store.patchRun(run, { tokens: measureSubtree(entry), status: 'failed', reason: message })
      store.closeRun(ticket, run, 'failed', message)
      if (ticket.status === workflow.active) ticket.status = workflow.blocked
      store.touch(ticket, 'system', 'run', `run ${run.id} failed: ${message}`)
      store.addNotification('run_failed', ticket, `${ticket.key} run failed: ${message.slice(0, 160)}`)
      try {
        store.save()
      } catch (saveError) {
        // A failed save must never escape as an unhandled rejection.
        log(`[board] could not persist failed run ${run.id}: ${String(saveError)}`)
      }
    } catch (recordingError) {
      log(`[board] could not record run failure: ${String(recordingError)}`)
    } finally {
      await release(ticket.id, entry)
      if (!disposed) pump()
    }
  }

  async function release(ticketId, entry) {
    if (!entry) return
    stopBudgetWatch(entry)
    forgetSessions(entry)
    if (active.get(ticketId) === entry) active.delete(ticketId)
    const handle = entry.handle
    entry.handle = null
    entry.agent = null
    entry.phase = 'done'
    if (handle) {
      try {
        await handle.dispose()
      } catch (error) {
        log(`[board] worker dispose failed: ${String(error)}`)
      }
    }
  }

  function recover() {
    let changed = false
    for (const ticket of store.list()) {
      if (!ticket.currentRunId) continue
      const run = store.currentRun(ticket)
      if (!run) {
        ticket.currentRunId = null
        changed = true
        continue
      }
      if (run.status === 'starting' || run.status === 'running') {
        store.closeRun(ticket, run, 'interrupted', 'host restarted while the run was active')
        if (ticket.status === workflow.active) ticket.status = workflow.blocked
        store.touch(ticket, 'system', 'run', 'run interrupted by host restart; move the ticket back to Ready to retry')
        changed = true
      }
    }
    for (const ticket of store.list()) {
      if (ticket.queuedAt && ticket.status !== workflow.dispatch) {
        ticket.queuedAt = null
        changed = true
      } else if (ticket.queuedAt && ticket.status === workflow.dispatch && !ticket.currentRunId) {
        queue.add(ticket.id)
      }
    }
    if (changed) store.save()
  }

  function git(args, cwd) {
    return new Promise((resolvePromise, rejectPromise) => {
      execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: gitTimeoutMs, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
        if (error) {
          rejectPromise(new Error(String(stderr || stdout || error.message).trim() || `git ${args[0]} failed`))
          return
        }
        resolvePromise(String(stdout).trim())
      })
    })
  }

  /** Like git(), but keeps stdout byte-for-byte (patches must not be trimmed). */
  function gitRaw(args, cwd) {
    return new Promise((resolvePromise, rejectPromise) => {
      execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: gitTimeoutMs, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
        if (error) {
          rejectPromise(new Error(String(stderr || stdout || error.message).trim() || `git ${args[0]} failed`))
          return
        }
        resolvePromise(String(stdout))
      })
    })
  }

  function gitOk(args, cwd) {
    return git(args, cwd).then(
      () => true,
      () => false,
    )
  }

  /** Locate the base checkout for a run's worktree, including older runs that predate `repositoryRoot`. */
  async function resolveRepositoryRoot(worktree) {
    if (worktree?.repositoryRoot) return worktree.repositoryRoot
    if (!worktree?.path) return null
    try {
      const listing = await git(['worktree', 'list', '--porcelain'], worktree.path)
      const first = listing.split('\n').find(line => line.startsWith('worktree '))
      if (first) return first.slice('worktree '.length).trim()
    } catch {
      /* fall through to the top-level of the checkout */
    }
    try {
      return await git(['rev-parse', '--show-toplevel'], worktree.path)
    } catch {
      return null
    }
  }

  const DIFF_MAX_BYTES = 200_000
  const DIFF_MAX_FILES = 200

  /** The run whose branch should be reviewed for this ticket (mirrors approval). */
  function reviewableRun(ticket) {
    const currentRun = store.currentRun(ticket)
    return (
      (currentRun?.worktree ? currentRun : null) ??
      [...ticket.runs].reverse().find(candidate => candidate.worktree && !candidate.merge && !candidate.prunedAt) ??
      null
    )
  }

  /**
   * Read-only view of the change a run produced, for the review drawer: file
   * counts, `--stat`, and a capped unified patch. Never mutates the repo.
   */
  async function diff(ticketId) {
    const ticket = store.find(ticketId)
    const run = reviewableRun(ticket)
    if (!run?.worktree?.branch) return { available: false, reason: 'this ticket has no unmerged run branch' }
    const repo = await resolveRepositoryRoot(run.worktree)
    if (!repo) return { available: false, reason: 'cannot locate the base checkout for this run' }
    if (!(await gitOk(['rev-parse', '--verify', `refs/heads/${run.worktree.branch}`], repo))) {
      return { available: false, reason: `branch ${run.worktree.branch} no longer exists` }
    }
    try {
      const base = run.worktree.baseCommit || (await git(['merge-base', 'HEAD', run.worktree.branch], repo))
      const numstat = await git(['diff', '--numstat', '--no-renames', `${base}...${run.worktree.branch}`], repo)
      const files = numstat
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const [added, removed, ...pathParts] = line.split('\t')
          return {
            path: pathParts.join('\t'),
            added: added === '-' ? null : Number(added),
            removed: removed === '-' ? null : Number(removed),
          }
        })
      const stat = await git(['diff', '--stat', '--no-renames', `${base}...${run.worktree.branch}`], repo)
      const fullPatch = await gitRaw(['diff', '--no-color', '--no-ext-diff', '--no-renames', '-U3', `${base}...${run.worktree.branch}`], repo)
      const fullBytes = Buffer.from(fullPatch)
      const truncated = fullBytes.length > DIFF_MAX_BYTES || files.length > DIFF_MAX_FILES
      return {
        available: true,
        runId: run.id,
        branch: run.worktree.branch,
        baseBranch: run.worktree.baseBranch ?? null,
        baseCommit: base,
        files: files.slice(0, DIFF_MAX_FILES),
        stat,
        patch: truncated ? fullBytes.subarray(0, DIFF_MAX_BYTES).toString('utf8') : fullPatch,
        truncated,
        bytes: fullBytes.length,
        at: new Date().toISOString(),
      }
    } catch (error) {
      return { available: false, reason: `could not read the diff: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /**
   * Undo a partially applied squash without ever discarding local work.
   * `git reset --merge` keeps modifications that are not part of our squash; if
   * even that fails the board stops and reports, rather than forcing a reset.
   */
  async function rollbackMerge(repo, preHead) {
    try {
      await git(['reset', '--merge', preHead], repo)
      return null
    } catch (error) {
      const message = `could not roll back ${repo} to ${preHead}: ${error.message}`
      log(`[board] ${message}`)
      return message
    }
  }

  async function worktreeDirtyHint(worktree) {
    try {
      const dirty = await git(['status', '--porcelain'], worktree.path)
      if (dirty) return `; the checkout ${worktree.path} has uncommitted changes — commit them on ${worktree.branch} first`
    } catch {
      /* checkout may already be gone */
    }
    return ''
  }

  /**
   * Approve = squash-merge the run's branch into the branch the run started from,
   * then remove the checkout and branch. Refuses on a dirty base, the wrong
   * base branch, or a base that moved since the run started; a failed merge is
   * rolled back to the pre-merge commit.
   */
  /**
   * Find the squash commit an earlier, interrupted approval of THIS run created.
   * The commit message carries both the ticket key and `(run <id>)`, so a merge of
   * an older run of the same ticket is never adopted by mistake.
   */
  async function findMergedCommit(repo, ticket, run) {
    try {
      const listing = await git(
        ['log', '--format=%H', '-F', '-n', '5', `--grep=${ticket.key}: `, `--grep=(run ${run.id})`, '--all-match'],
        repo,
      )
      return listing.split('\n')[0] || null
    } catch {
      return null
    }
  }

  async function branchBlobHashes(repo, branch) {
    try {
      const listing = await git(['ls-tree', '-r', branch], repo)
      return new Set(
        listing
          .split('\n')
          .map(line => line.split(/\s+/)[2])
          .filter(Boolean),
      )
    } catch {
      return new Set()
    }
  }

  async function stagedBlobHash(repo, path) {
    try {
      const entry = await git(['ls-files', '-s', '--', path], repo)
      return entry.split(/\s+/)[1] ?? null
    } catch {
      return null
    }
  }

  /** Remove the worktree and branch after a merge; failures are recorded, not thrown. */
  async function finishCleanup(repo, worktree, run, ticket) {
    const cleanupErrors = []
    const branchExists = await gitOk(['rev-parse', '--verify', `refs/heads/${worktree.branch}`], repo)
    if (existsSync(worktree.path)) {
      try {
        await git(['worktree', 'remove', '--force', worktree.path], repo)
      } catch (error) {
        cleanupErrors.push(`worktree remove: ${error.message}`)
      }
    }
    if (branchExists) {
      try {
        await git(['branch', '-D', worktree.branch], repo)
      } catch (error) {
        cleanupErrors.push(`branch delete: ${error.message}`)
      }
    }
    if (cleanupErrors.length) {
      store.patchRun(run, { cleanupError: cleanupErrors.join('; ') })
      store.touch(ticket, 'system', 'merge', `merged, but cleanup was incomplete: ${cleanupErrors.join('; ')}`)
    }
  }

  /**
   * Approve = squash-merge the run's branch into the branch the run started from,
   * then remove the checkout and branch. Refuses on a dirty base, the wrong base
   * branch, or a rewritten base; a failed merge is rolled back to the pre-merge
   * commit. If an earlier attempt already committed the merge but could not
   * record it, the existing commit is adopted instead of merged twice.
   */
  async function squashMerge(ticket, run, repo) {
    const worktree = run.worktree
    if (!worktree?.branch) return null
    const branch = worktree.branch
    const expectedBranch = worktree.baseBranch
    if (!expectedBranch) {
      throw new Error(
        `run ${run.id} does not record which branch it started from; refusing to merge ${branch} into an unknown base — reject the ticket and re-run it`,
      )
    }
    const dirty = await git(['status', '--porcelain'], repo)
    if (dirty) {
      throw new Error(`${repo} has uncommitted changes; commit or stash them before approving`)
    }
    const headBranch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repo)
    if (headBranch !== expectedBranch) {
      throw new Error(
        `the base checkout ${repo} is on "${headBranch}" but this run started from "${expectedBranch}"; check out ${expectedBranch} before approving`,
      )
    }
    const branchExists = await gitOk(['rev-parse', '--verify', `refs/heads/${branch}`], repo)
    if (!branchExists) {
      const recovered = await findMergedCommit(repo, ticket, run)
      if (!recovered) throw new Error(`branch ${branch} no longer exists; the run cannot be merged`)
      await finishCleanup(repo, worktree, run, ticket)
      return { branch, baseBranch: expectedBranch, commit: recovered, short: recovered.slice(0, 7), recovered: true }
    }
    if (worktree.baseCommit) {
      const ancestor = await gitOk(['merge-base', '--is-ancestor', worktree.baseCommit, 'HEAD'], repo)
      if (!ancestor) {
        throw new Error(
          `the base branch "${expectedBranch}" no longer contains ${String(worktree.baseCommit).slice(0, 7)}, the commit run ${run.id} started from (its history was rewritten); rebase ${branch} onto "${expectedBranch}", or reject the ticket and re-run it`,
        )
      }
    }
    const preHead = await git(['rev-parse', 'HEAD'], repo)
    const branchPaths = (await git(['diff', '--name-only', '--no-renames', '-z', `${worktree.baseCommit}...${branch}`], repo))
      .split('\0')
      .map(path => path.trim())
      .filter(Boolean)
    try {
      await git(['merge', '--squash', branch], repo)
    } catch (error) {
      const cleanup = await rollbackMerge(repo, preHead)
      throw new Error(`merge of ${branch} failed: ${error.message}${cleanup ? `; ${cleanup}` : ''}`)
    }
    const staged = (await git(['diff', '--cached', '--name-only', '--no-renames', '-z'], repo))
      .split('\0')
      .map(path => path.trim())
      .filter(Boolean)
    if (!staged.length) {
      const recovered = await findMergedCommit(repo, ticket, run)
      if (recovered) {
        await finishCleanup(repo, worktree, run, ticket)
        return { branch, baseBranch: expectedBranch, commit: recovered, short: recovered.slice(0, 7), recovered: true }
      }
      throw new Error(`branch ${branch} has no committed changes to merge${await worktreeDirtyHint(worktree)}`)
    }
    const branchPathSet = new Set(branchPaths)
    const unexpected = staged.filter(path => !branchPathSet.has(path))
    if (unexpected.length) {
      // A rename on the base after the run started changes the path a branch
      // change lands on; accept an unexpected path only when its staged blob is
      // byte-identical to a blob in the branch's tree, and refuse otherwise.
      const branchBlobs = await branchBlobHashes(repo, branch)
      const foreign = []
      for (const path of unexpected) {
        const blob = await stagedBlobHash(repo, path)
        if (!blob || !branchBlobs.has(blob)) foreign.push(path)
      }
      if (foreign.length) {
        const cleanup = await rollbackMerge(repo, preHead)
        throw new Error(
          `refusing to commit: the index contains paths this run did not change (${foreign.slice(0, 5).join(', ')})${cleanup ? `; ${cleanup}` : ''} — another approval may be in flight`,
        )
      }
    }
    const message = `${ticket.key}: ${ticket.title}\n\nSquash-merged ${branch} (run ${run.id}).`
    try {
      await git(['commit', '-m', message], repo)
    } catch (error) {
      if (/tell me who you are|user\.email|user\.name/i.test(error.message)) {
        try {
          await git(['-c', 'user.name=dsh-board', '-c', 'user.email=board@dsh.local', 'commit', '-m', message], repo)
        } catch (retryError) {
          const cleanup = await rollbackMerge(repo, preHead)
          throw new Error(`squash commit failed: ${retryError.message}${cleanup ? `; ${cleanup}` : ''}`)
        }
      } else {
        const cleanup = await rollbackMerge(repo, preHead)
        throw new Error(`squash commit failed: ${error.message}${cleanup ? `; ${cleanup}` : ''}`)
      }
    }
    const sha = await git(['rev-parse', 'HEAD'], repo)
    await finishCleanup(repo, worktree, run, ticket)
    return { branch, baseBranch: expectedBranch, commit: sha, short: sha.slice(0, 7) }
  }

  function start(ticketId) {
    return lockTicket(ticketId, () => {
      const ticket = store.find(ticketId)
      if (ticket.currentRunId) throw new Error('a run is already active for this ticket')
      if (ticket.status !== workflow.dispatch) {
        throw new Error(`only ${store.stateLabel(workflow.dispatch)} tickets can start a run (current: ${store.stateLabel(ticket.status)})`)
      }
      if (!ticket.assignee) throw new Error('assign an agent before starting a run')
      if (!dependenciesMet(ticket)) throw new Error(`${ticket.key} waits for another ticket; dependencies are not done yet`)
      if (ticket.archivedAt) throw new Error(`${ticket.key} is archived; restore it before starting a run`)
      if (runningCount() >= maxWorkers) {
        queueTicket(ticket, `${maxWorkers} workers busy`)
        return
      }
      startRun(ticket)
    })
  }

  /** Deliver a human comment to the live worker session, when one is running. */
  function steer(ticketId, text) {
    const body = String(text ?? '').trim()
    if (!body) return { delivered: false, reason: 'empty comment' }
    const ticket = store.find(ticketId)
    const entry = active.get(ticket.id)
    if (!entry?.agent) return { delivered: false, reason: 'no live worker for this ticket' }
    if (entry.phase !== 'running') return { delivered: false, reason: `the worker is ${entry.phase}` }
    // No await between the phase check and the delivery, so the drive loop either
    // sees pendingSteers and keeps the turn alive, or closes steering first.
    try {
      entry.pendingSteers = (entry.pendingSteers || 0) + 1
      entry.agent.followup(userMessage(body))
      log(`[board] comment delivered to run ${entry.runId} for ${ticket.key}`)
      return { delivered: true, runId: entry.runId }
    } catch (error) {
      entry.pendingSteers = Math.max(0, (entry.pendingSteers || 1) - 1)
      return { delivered: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  function pullRequestRun(ticket) {
    const current = store.currentRun(ticket)
    return (
      (current?.worktree ? current : null) ??
      [...ticket.runs].reverse().find(run => run.worktree && !run.merge && !run.prunedAt && !run.worktree.superseded) ??
      null
    )
  }

  async function openPullRequest(ticketId, by = 'human') {
    if (!pullRequest) throw new Error('pull requests are not configured (pullRequest.repository and .token)')
    return lockTicket(ticketId, async () => {
      const ticket = store.find(ticketId)
      if (ticket.status !== workflow.gate) {
        throw new Error(`only tickets in ${store.stateLabel(workflow.gate)} can open a pull request (current: ${store.stateLabel(ticket.status)})`)
      }
      const run = pullRequestRun(ticket)
      if (!run?.worktree?.branch) throw new Error(`${ticket.key} has no run branch to push`)
      const repositoryRoot = run.worktree.repositoryRoot
      if (!existsSync(repositoryRoot)) throw new Error(`base checkout not found: ${repositoryRoot}`)
      await git(['push', pullRequest.remote, run.worktree.branch], repositoryRoot)
      const title = `${ticket.key}: ${ticket.title}`
      const description = (ticket.plan?.markdown || ticket.description || '').slice(0, 60000)
      const gitlab = pullRequest.provider === 'gitlab'
      const endpoint = gitlab
        ? `${pullRequest.apiBase}/projects/${encodeURIComponent(pullRequest.repository)}/merge_requests`
        : `${pullRequest.apiBase}/repos/${pullRequest.repository}/pulls`
      const headers = gitlab
        ? { 'PRIVATE-TOKEN': pullRequest.token, accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'dsh-board' }
        : {
            authorization: `Bearer ${pullRequest.token}`,
            accept: 'application/vnd.github+json',
            'content-type': 'application/json',
            'user-agent': 'dsh-board',
          }
      const body = gitlab
        ? JSON.stringify({ title, source_branch: run.worktree.branch, target_branch: pullRequest.base, description })
        : JSON.stringify({ title, head: run.worktree.branch, base: pullRequest.base, body: description })
      let response
      try {
        response = await fetch(endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) })
      } catch (error) {
        throw new Error(`could not reach the pull-request API: ${String(error)}`)
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`pull-request API returned ${response.status}: ${text.slice(0, 300)}`)
      }
      const data = await response.json().catch(() => ({}))
      const url = data.html_url || data.web_url || null
      const number = data.number ?? data.iid ?? null
      store.patchRun(run, { pullRequest: { url, number, base: pullRequest.base, at: new Date().toISOString() } })
      if (url) store.artifactTicket({ id: ticket.id, kind: 'pr', uri: url, label: `PR #${number ?? '?'}`, by })
      store.touch(ticket, by, 'pull_request', `${url ?? 'pull request'} opened against ${pullRequest.base}`)
      try {
        store.save()
      } catch (error) {
        log(`[board] could not persist pull request for ${ticket.key}: ${String(error)}`)
      }
      return { url, number }
    })
  }

  async function markPullRequestMerged(ticketId, by = 'human') {
    return lockTicket(ticketId, async () => {
      const ticket = store.find(ticketId)
      const run = [...ticket.runs].reverse().find(entry => entry.pullRequest)
      if (!run?.pullRequest) throw new Error(`${ticket.key} has no pull request recorded`)
      if (ticket.status !== workflow.gate) throw new Error(`${ticket.key} is ${store.stateLabel(ticket.status)}; only a ticket in ${store.stateLabel(workflow.gate)} can be completed this way`)
      store.patchRun(run, {
        status: 'merged',
        merge: { pr: run.pullRequest.url, baseBranch: pullRequest?.base ?? run.pullRequest.base, short: run.pullRequest.number ? `PR #${run.pullRequest.number}` : 'pull request' },
      })
      if (run.worktree && !run.worktree.pruned) {
        try {
          if (run.worktree.repositoryRoot && run.worktree.path) {
            await git(['worktree', 'remove', '--force', run.worktree.path], run.worktree.repositoryRoot)
          }
          if (run.worktree.repositoryRoot && run.worktree.branch) {
            await git(['branch', '-D', run.worktree.branch], run.worktree.repositoryRoot)
          }
          store.patchRun(run, { worktree: { ...run.worktree, pruned: true } })
        } catch (error) {
          log(`[board] could not prune ${ticket.key}'s worktree after the pull request merged: ${String(error)}`)
        }
      }
      ticket.status = workflow.done
      ticket.doneAt = new Date().toISOString()
      store.recordCompletion(ticket)
      store.completeParentIfReady(ticket.id)
      store.clearReview(ticket.id)
      store.touch(ticket, by, 'pull_request', `pull request merged; ${ticket.key} done`)
      try {
        store.save()
      } catch (error) {
        log(`[board] could not persist merged pull request for ${ticket.key}: ${String(error)}`)
      }
      return ticket
    })
  }

  /** Poll open pull requests and complete tickets whose PR merged. */
  async function syncPullRequests() {
    if (!pullRequest || !pullRequest.autoSync) return []
    const report = []
    for (const ticket of store.list()) {
      if (ticket.status !== workflow.gate) continue
      const run = [...ticket.runs].reverse().find(entry => entry.pullRequest && !entry.merge)
      if (!run?.pullRequest) continue
      const gitlab = pullRequest.provider === 'gitlab'
      const number = run.pullRequest.number
      if (!number) {
        report.push({ ticket: ticket.key, status: 'error', error: 'pull request has no number' })
        continue
      }
      const endpoint = gitlab
        ? `${pullRequest.apiBase}/projects/${encodeURIComponent(pullRequest.repository)}/merge_requests/${number}`
        : `${pullRequest.apiBase}/repos/${pullRequest.repository}/pulls/${number}`
      const headers = gitlab
        ? { 'PRIVATE-TOKEN': pullRequest.token, accept: 'application/json', 'user-agent': 'dsh-board' }
        : { authorization: `Bearer ${pullRequest.token}`, accept: 'application/vnd.github+json', 'user-agent': 'dsh-board' }
      try {
        const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(10000) })
        if (!response.ok) {
          report.push({ ticket: ticket.key, status: 'error', code: response.status })
          continue
        }
        const data = await response.json().catch(() => ({}))
        const merged = gitlab ? data.state === 'merged' : Boolean(data.merged || data.merged_at)
        const closed = String(data.state ?? '').toLowerCase() === 'closed'
        if (merged) {
          await markPullRequestMerged(ticket.id, 'pr-sync')
          report.push({ ticket: ticket.key, status: 'merged' })
        } else if (closed) {
          store.addNotification('pr_closed', ticket, `${ticket.key}: the pull request was closed without merging`)
          report.push({ ticket: ticket.key, status: 'closed' })
        } else {
          report.push({ ticket: ticket.key, status: 'open' })
        }
      } catch (error) {
        report.push({ ticket: ticket.key, status: 'error', error: String(error) })
      }
    }
    return report
  }

  async function approve(ticketId, by = 'human', options = {}) {
    return lockTicket(ticketId, async () => {
      const ticket = store.find(ticketId)
      const entry = active.get(ticket.id)
      if (entry && (entry.phase === 'starting' || entry.phase === 'running')) {
        throw new Error('the worker is still running; wait for it to settle before approving')
      }
      if (entry && entry.phase === 'checking') {
        throw new Error('the checks for this run are still running; wait for them to finish before approving')
      }
      if (ticket.status !== workflow.gate) {
        throw new Error(`only tickets in ${store.stateLabel(workflow.gate)} can be approved (current: ${store.stateLabel(ticket.status)})`)
      }
      if (approvalTtlHours > 0 && ticket.plan?.approvedAt) {
        const ageMs = Date.now() - Date.parse(ticket.plan.approvedAt)
        if (Number.isFinite(ageMs) && ageMs > approvalTtlHours * 3600000) {
          throw new Error('the plan approval expired; re-approve the plan before merging')
        }
      }
      // The run that owns a worktree is not always the current run (a rejection
      // opens a new run on the same session); merge whichever unmerged worktree
      // run exists, preferring the current one.
      const currentRun = store.currentRun(ticket)
      const mergeRun =
        (currentRun?.worktree ? currentRun : null) ??
        [...ticket.runs].reverse().find(candidate => candidate.worktree && !candidate.merge && !candidate.prunedAt) ??
        null
      const snapshot = captureTicket(ticket)
      const checkRun = mergeRun ?? currentRun
      const signature = checksSignature(ticket.checks)
      const freshMeta = checkRun ? await readCheckoutMeta(checkoutDir(checkRun)) : null
      const checksOutdated =
        Boolean(checkRun) &&
        (ticket.checks?.length ?? 0) > 0 &&
        (!checkRun.checks ||
          checkRun.checksKey !== signature ||
          (freshMeta !== null &&
            (checkRun.checksMeta?.dirty === true ||
              (checkRun.checksMeta?.head && checkRun.checksMeta.head !== freshMeta.head))))
      if (checksOutdated) await runChecks(ticket, checkRun)
      const failedChecks = (checkRun?.checks ?? []).filter(isFailedCheck)
      let overrideRecord = null
      if (failedChecks.length) {
        if (options.overrideChecks !== true) {
          throw new Error(
            `checks failed (${failedChecks.map(check => check.name).join(', ')}); approve with overrideChecks and a reason to merge anyway`,
          )
        }
        const reason = String(options.reason ?? '').trim()
        if (!reason) throw new Error('an override reason is required to approve over failing checks')
        overrideRecord = { by, at: new Date().toISOString(), reason }
      }
      if (checkRun?.checksMeta?.dirty === true) {
        throw new Error(
          `the run checkout ${checkRun.checksMeta.workdir} has uncommitted tracked changes; the checks tested code that would not be merged — reject the ticket and ask the worker to commit`,
        )
      }
      let merge = null
      if (mergeRun?.worktree) {
        const repo = await resolveRepositoryRoot(mergeRun.worktree)
        if (!repo) {
          throw new Error(`cannot locate the base checkout for ${mergeRun.worktree.branch}; refusing to mark the run merged`)
        }
        merge = await withRepoLock(repo, () => squashMerge(ticket, mergeRun, repo))
      }
      try {
        if (merge) {
          store.patchRun(mergeRun, { merge })
          store.touch(ticket, by, 'merge', `squash-merged ${merge.branch} as ${merge.short} on ${merge.baseBranch}`)
        } else if (currentRun) {
          store.touch(ticket, 'system', 'merge', 'approved without a merge (the run used the shared checkout)')
        }
        if (checkRun && overrideRecord) {
          store.patchRun(checkRun, { checksOverridden: overrideRecord })
          store.touch(
            ticket,
            by,
            'checks-override',
            `approved over failing checks (${failedChecks.map(check => check.name).join(', ')}): ${overrideRecord.reason}`,
          )
        } else if (checkRun) {
          delete checkRun.checksOverridden
        }
        if (currentRun) store.closeRun(ticket, currentRun, 'approved', null)
        ticket.status = workflow.done
        ticket.doneAt = new Date().toISOString()
        store.recordCompletion(ticket)
        store.completeParentIfReady(ticket.id)
        store.touch(ticket, by, 'gate', `approved → ${store.stateLabel(workflow.done)}`)
        store.save()
      } catch (error) {
        // The commit may already be in the repository; restoring the ticket to the
        // gate lets a retry adopt it (squashMerge recognises the commit by subject).
        restoreTicket(ticket, snapshot)
        log(`[board] approval of ${ticket.key} merged but could not be recorded: ${String(error)}`)
        if (merge) {
          throw new Error(
            `merged ${merge.short} but could not record it (${error instanceof Error ? error.message : String(error)}); approve again — the board recognises the existing squash commit`,
          )
        }
        throw error
      }
      if (entry) await release(ticket.id, entry)
      pump()
    })
  }

  async function reject(ticketId, reason, by = 'human') {
    return lockTicket(ticketId, async () => {
      const text = String(reason ?? '').trim()
      if (!text) throw new Error('a rejection reason is required')
      const ticket = store.find(ticketId)
      const existing = active.get(ticket.id)
      if (existing && (existing.phase === 'starting' || existing.phase === 'running')) {
        throw new Error('the worker is still running; wait for it to settle before rejecting')
      }
      if (existing && existing.phase === 'checking') {
        throw new Error('the checks for this run are still running; wait for them to finish before rejecting')
      }
      if (ticket.status !== workflow.gate) {
        throw new Error(`only tickets in ${store.stateLabel(workflow.gate)} can be rejected (current: ${store.stateLabel(ticket.status)})`)
      }
      if (runningCount() >= maxWorkers) {
        throw new Error(`no worker slot is free (${maxWorkers} busy); reject again when a run finishes — the ticket stays in review`)
      }
      // A gate ticket should have no live entry (settle releases it); clean up a
      // cancelled leftover rather than reviving it.
      if (existing) await release(ticket.id, existing)
      const snapshot = captureTicket(ticket)
      const previous = store.currentRun(ticket)
      const sessionId = previous?.sessionId ?? null
      let run
      try {
        if (previous) store.closeRun(ticket, previous, 'rejected', text)
        ticket.status = workflow.active
        store.clearReview(ticket.id)
        run = store.addRun(ticket, {
          status: 'running',
          sessionId,
          ...(previous?.worktree && !previous.worktree.prunedAt && !previous.worktree.pruned ? { worktree: previous.worktree } : {}),
        })
        if (previous?.worktree) {
          // The new run owns this checkout now; the superseded run must not look
          // like unmerged work when archiving or pruning later.
          store.patchRun(previous, { supersededBy: run.id, worktree: { ...previous.worktree, superseded: true } })
        }
        store.touch(ticket, by, 'gate', `rejected: ${text}`)
        store.save()
      } catch (error) {
        restoreTicket(ticket, snapshot)
        throw error
      }
      const liveEntry = active.get(ticket.id)
      if (liveEntry?.agent) {
        liveEntry.runId = run.id
        liveEntry.phase = 'running'
        fire(driveTicket(ticket, run, liveEntry, rejectionBrief(ticket, text)))
      } else {
        const nextEntry = {
          ticketId: ticket.id,
          runId: run.id,
          phase: 'running',
          handle: null,
          agent: null,
          cancelled: false,
          overBudget: false,
          timer: null,
        }
        active.set(ticket.id, nextEntry)
        if (sessionId) fire(resumeAndDrive(ticket, run, nextEntry, rejectionBrief(ticket, text)))
        else fire(driveTicket(ticket, run, nextEntry, brief(ticket)))
      }
    })
  }

  async function resumeAndDrive(ticket, run, entry, reason) {
    try {
      const preset = await presetSetup()
      const handle = await ctx.get('agents').resume({
        resumeSessionId: run.sessionId,
        agentOptions: selection(),
        ...(preset.setup ? { setup: preset.setup } : {}),
      })
      if (disposed || entry.cancelled || run.endedAt) {
        try {
          await handle.dispose()
        } catch {
          /* already torn down */
        }
        await release(ticket.id, entry)
        return
      }
      entry.handle = handle
      entry.agent = handle.agent
      registerWorkerSession(entry)
      try {
        ctx.get('approval')?.setPolicy(handle.agent, 'never')
      } catch {
        /* policy is best-effort on resume */
      }
      await attachWorkerToWorkspace(handle.agent)
      await driveTicket(ticket, run, entry, reason)
    } catch (error) {
      await fail(ticket, run, entry, error)
    }
  }

  async function cancel(ticketId, by = 'human') {
    return lockTicket(ticketId, async () => {
      const ticket = store.find(ticketId)
      queue.delete(ticket.id)
      if (ticket.status === workflow.gate) {
        throw new Error(`a ticket in ${store.stateLabel(workflow.gate)} is closed with Reject (or approved), not cancelled`)
      }
      const run = store.currentRun(ticket)
      if (!run) throw new Error('no active run to cancel')
      const entry = active.get(ticket.id)
      const snapshot = captureTicket(ticket)
      if (entry) {
        entry.cancelled = true
        stopBudgetWatch(entry)
        try {
          entry.agent?.cancel(CANCEL)
        } catch {
          /* already stopping */
        }
      }
      try {
        store.closeRun(ticket, run, 'cancelled', `cancelled by ${by}`)
        if (ticket.status === workflow.active) ticket.status = workflow.blocked
        store.touch(ticket, by, 'gate', `run ${run.id} cancelled`)
        store.save()
      } catch (error) {
        // Keep memory identical to disk when the write failed; the slot is still freed.
        restoreTicket(ticket, snapshot)
        log(`[board] could not persist the cancel of run ${run.id}: ${String(error)}`)
        throw error
      } finally {
        await release(ticket.id, entry)
        pump()
      }
    })
  }

  /** Ticket ids waiting for a worker slot, pruning entries that are no longer dispatchable. */
  function queued() {
    const waiting = []
    for (const id of queue) {
      const ticket = store.list().find(item => item.id === id)
      if (!ticket || !isDispatchable(ticket)) {
        queue.delete(id)
        continue
      }
      waiting.push(ticket)
    }
    waiting.sort(
      (a, b) =>
        (Number(b.priority) || 0) - (Number(a.priority) || 0) ||
        (a.queuedAt ? Date.parse(a.queuedAt) : Number.MAX_SAFE_INTEGER) -
          (b.queuedAt ? Date.parse(b.queuedAt) : Number.MAX_SAFE_INTEGER),
    )
    return waiting.map(ticket => ticket.id)
  }

  /** Move a blocked ticket back to the dispatch state and hand it to a worker when a slot exists. */
  function retry(ticketId, by = 'human') {
    return lockTicket(ticketId, () => {
      const ticket = store.find(ticketId)
      if (ticket.status !== workflow.blocked) {
        throw new Error(`only ${store.stateLabel(workflow.blocked)} tickets can be retried (current: ${store.stateLabel(ticket.status)})`)
      }
      if (ticket.currentRunId) throw new Error('the ticket still has an active run; cancel it before retrying')
      if (!dependenciesMet(ticket)) throw new Error(`${ticket.key} waits for another ticket; dependencies are not done yet`)
      if (ticket.archivedAt) throw new Error(`${ticket.key} is archived; restore it before starting a run`)
      store.updateTicket({ id: ticket.id, status: workflow.dispatch, by })
      store.touch(ticket, 'system', 'retry', `retry requested by ${by}`)
      store.save()
      if (runningCount() >= maxWorkers) {
        queueTicket(ticket, `${maxWorkers} workers busy`)
        return { queued: true }
      }
      startRun(ticket)
      return { queued: false }
    })
  }

  /**
   * Retire checkouts and branches that no longer need to exist: merged runs of
   * done tickets, and everything owned by archived tickets. Unmerged runs of
   * live tickets are kept and reported.
   */
  /**
   * Garbage-collect orphaned board worktrees/branches: only the `board/`
   * namespace, never a path or branch some run still references, and only a
   * worktree that is not the workspace checkout itself.
   */
  async function gc({ apply = false } = {}) {
    const report = { dryRun: !apply, worktrees: [], branches: [], removed: { worktrees: 0, branches: 0 }, errors: [] }
    if (!workspace || !existsSync(workspace)) {
      report.errors.push({ target: String(workspace), error: 'workspace checkout not found' })
      return report
    }
    const referencedPaths = new Set()
    const referencedBranches = new Set()
    for (const ticket of store.list()) {
      for (const run of ticket.runs ?? []) {
        const worktree = run.worktree
        if (!worktree) continue
        if (worktree.path) referencedPaths.add(worktree.path)
        if (worktree.branch) referencedBranches.add(worktree.branch)
      }
    }
    let listing
    try {
      listing = await git(['worktree', 'list', '--porcelain'], workspace)
    } catch (error) {
      report.errors.push({ target: workspace, error: String(error.message) })
      return report
    }
    const worktreeCandidates = []
    for (const block of String(listing).split('\n\n')) {
      if (!block.trim()) continue
      let path = null
      let branch = null
      for (const line of block.split('\n')) {
        if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim()
        else if (line.startsWith('branch refs/heads/')) branch = line.slice('branch refs/heads/'.length).trim()
      }
      if (!path || !branch || !branch.startsWith('board/')) continue
      if (path === workspace || referencedPaths.has(path) || referencedBranches.has(branch)) continue
      worktreeCandidates.push({ path, branch })
    }
    let branchList = []
    try {
      const out = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/board/'], workspace)
      branchList = String(out).split('\n').map(line => line.trim()).filter(Boolean)
    } catch (error) {
      report.errors.push({ target: 'refs/heads/board/', error: String(error.message) })
    }
    const worktreeBranches = new Set(worktreeCandidates.map(item => item.branch))
    const branchCandidates = branchList.filter(
      branch =>
        !referencedBranches.has(branch) &&
        !worktreeBranches.has(branch) &&
        !worktreeCandidates.some(item => item.branch === branch),
    )
    report.worktrees = worktreeCandidates
    report.branches = branchCandidates
    if (!apply) return report
    for (const candidate of worktreeCandidates) {
      try {
        await git(['worktree', 'remove', '--force', candidate.path], workspace)
        report.removed.worktrees += 1
        try {
          await git(['branch', '-D', candidate.branch], workspace)
          report.removed.branches += 1
        } catch (error) {
          report.errors.push({ target: candidate.branch, error: String(error.message) })
        }
      } catch (error) {
        report.errors.push({ target: candidate.path, error: String(error.message) })
      }
    }
    try {
      await git(['worktree', 'prune'], workspace)
    } catch (error) {
      report.errors.push({ target: 'worktree prune', error: String(error.message) })
    }
    for (const branch of branchCandidates) {
      try {
        await git(['branch', '-D', branch], workspace)
        report.removed.branches += 1
      } catch (error) {
        report.errors.push({ target: branch, error: String(error.message) })
      }
    }
    return report
  }

  async function prune({ includeArchived = false, force = false } = {}) {
    const report = { removed: [], kept: [], skipped: [], errors: [] }
    for (const ticket of store.list()) {
      if (ticket.archivedAt && !includeArchived) {
        report.skipped.push({ ticket: ticket.key, reason: 'archived tickets are pruned only when asked' })
        continue
      }
      if (active.has(ticket.id) || ticket.currentRunId) {
        report.skipped.push({ ticket: ticket.key, reason: 'run is active' })
        continue
      }
      if (ticket.archivedAt && !force) {
        report.skipped.push({ ticket: ticket.key, reason: 'archived tickets need force' })
        continue
      }
      for (const run of ticket.runs) {
        const worktree = run.worktree
        if (!worktree || run.prunedAt) continue
        const repositoryRoot = await resolveRepositoryRoot(worktree)
        if (!repositoryRoot) {
          report.errors.push({ ticket: ticket.key, target: worktree.path ?? worktree.branch ?? run.id, error: 'base checkout not found' })
          continue
        }
        const dirExists = Boolean(worktree.path && existsSync(worktree.path))
        const branchExists = Boolean(
          worktree.branch && (await gitOk(['rev-parse', '--verify', `refs/heads/${worktree.branch}`], repositoryRoot)),
        )
        if (!dirExists && !branchExists) {
          store.patchRun(run, { prunedAt: new Date().toISOString() })
          continue
        }
        const discardable = Boolean(run.merge) || Boolean(ticket.archivedAt)
        if (!discardable) {
          report.kept.push({ ticket: ticket.key, branch: worktree.branch ?? null, reason: 'unmerged run' })
          continue
        }
        const outcome = await withRepoLock(repositoryRoot, async () => {
          const removed = { ticket: ticket.key, branch: worktree.branch ?? null, path: worktree.path ?? null }
          let touched = false
          if (dirExists) {
            try {
              await git(['worktree', 'remove', '--force', worktree.path], repositoryRoot)
              touched = true
            } catch (error) {
              report.errors.push({ ticket: ticket.key, target: worktree.path, error: error.message })
            }
          }
          if (branchExists) {
            try {
              await git(['branch', '-D', worktree.branch], repositoryRoot)
              touched = true
            } catch (error) {
              report.errors.push({ ticket: ticket.key, target: worktree.branch, error: error.message })
            }
          }
          return touched ? removed : null
        })
        if (outcome) {
          store.patchRun(run, {
            prunedAt: new Date().toISOString(),
            ...(run.merge ? {} : { abandonedAt: new Date().toISOString() }),
            worktree: { ...worktree, pruned: true },
          })
          store.touch(ticket, 'system', 'prune', `pruned checkout ${worktree.path ?? worktree.branch ?? run.id}`)
          report.removed.push(outcome)
        }
      }
    }
    try {
      store.save()
    } catch (error) {
      log(`[board] could not persist the prune report: ${String(error)}`)
    }
    return report
  }

  const pullRequestTimer =
    pullRequest?.autoSync && pullRequest.pollMs > 0
      ? setInterval(() => {
          syncPullRequests().catch(error => log(`[board] pull-request sync failed: ${String(error)}`))
        }, pullRequest.pollMs)
      : null
  if (pullRequestTimer) pullRequestTimer.unref?.()

  async function dispose() {
    disposed = true
    if (pullRequestTimer) clearInterval(pullRequestTimer)
    for (const unsubscribe of subscriptions.splice(0)) {
      try {
        unsubscribe?.()
      } catch {
        /* listeners may already be gone */
      }
    }
    workerSessions.clear()
    childSessions.clear()
    for (const [ticketId, entry] of [...active]) {
      stopBudgetWatch(entry)
      entry.cancelled = true
      try {
        entry.agent?.cancel(CANCEL)
      } catch {
        /* best effort */
      }
      try {
        await entry.handle?.dispose()
      } catch {
        /* best effort */
      }
      active.delete(ticketId)
    }
    queue.clear()
  }

  return {
    workspace,
    maxWorkers,
    agentPreset,
    worktreesEnabled,
    recover,
    pump,
    start,
    approve,
    reject,
    cancel,
    retry,
    queued,
    dispose,
    runningCount,
    steer,
    diff,
    prune,
    gc,
    openPullRequest,
    markPullRequestMerged,
    syncPullRequests,
    reviewableRun,
    active,
    queue,
  }
}
