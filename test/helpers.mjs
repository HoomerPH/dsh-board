/**
 * Test helpers for dsh-board.
 *
 * The run controller is exercised without any model or network: a fake Harness
 * context supplies `agents`, `worktrees`, `approval` and `tokenMeter`, and the
 * Git paths run against real throwaway repositories.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBoardStore } from '../lib/store.js'
import { createRunController } from '../lib/runs.js'

export const tempDir = (prefix = 'dsh-board-test-') => mkdtempSync(join(tmpdir(), prefix))

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function waitFor(predicate, { timeout = 4000, interval = 10 } = {}) {
  const start = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - start > timeout) throw new Error('waitFor timed out')
    await delay(interval)
  }
}

export function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * A repository shaped like the one the worktree plugin produces: worktrees live
 * under `.agents/worktrees`, whose `.gitignore` keeps the base checkout clean.
 */
export function gitRepo() {
  const dir = tempDir('board-repo-')
  const git = (args, cwd = dir) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git(['init', '-q', '.'])
  git(['config', 'user.email', 'board-test@dsh.local'])
  git(['config', 'user.name', 'Board Test'])
  writeFileSync(join(dir, 'README.md'), '# board test repo\n')
  mkdirSync(join(dir, '.agents', 'worktrees'), { recursive: true })
  writeFileSync(join(dir, '.agents', 'worktrees', '.gitignore'), '*\n')
  git(['add', '-A'])
  git(['commit', '-qm', 'base'])
  return { dir, git }
}

export function addWorktree(repo, name) {
  const baseBranch = repo.git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const baseCommit = repo.git(['rev-parse', 'HEAD'])
  const path = join(repo.dir, '.agents', 'worktrees', name.replaceAll('/', '-'))
  repo.git(['worktree', 'add', '-q', '-b', name, path, 'HEAD'])
  return { path, branch: name, baseCommit, repositoryRoot: repo.dir, baseBranch }
}

export function commitIn(repo, worktreePath, files, message = 'work') {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(worktreePath, name), content)
  repo.git(['add', '-A'], worktreePath)
  repo.git(['commit', '-qm', message], worktreePath)
  return repo.git(['rev-parse', 'HEAD'], worktreePath)
}

/** Agent service whose turns resolve immediately unless a deferred idle is supplied. */
export function defaultAgents({ idle, idleFactory } = {}) {
  const handles = []
  const make = options => {
    const agent = {
      id: options?.sessionId ?? `agent-${handles.length + 1}`,
      session: { id: options?.sessionId ?? `session-${handles.length + 1}` },
      followups: [],
      cancels: [],
      followup(message) {
        this.followups.push(message)
      },
      whenIdle() {
        if (idleFactory) return idleFactory()
        return idle ?? Promise.resolve()
      },
      cancel(reason) {
        this.cancels.push(reason)
      },
    }
    const handle = {
      agent,
      disposed: false,
      async dispose() {
        handle.disposed = true
      },
    }
    handles.push(handle)
    return handle
  }
  return {
    handles,
    created: [],
    async create(options) {
      this.created.push(options)
      return make(options)
    },
    async resume(options) {
      this.created.push({ resumed: options })
      return make(options)
    },
  }
}

export function fakeShell({ failures = [], kills = [], gate } = {}) {
  const calls = []
  return {
    calls,
    resolve(request) {
      return {
        ...request,
        workdir: request.workdir ?? '/tmp',
        timeoutMs: request.timeoutMs ?? 1000,
        onExpiry: 'kill',
        stdoutMaxBytes: 1 << 20,
        sandboxPolicy: undefined,
      }
    },
    async execute(spec) {
      calls.push(spec)
      if (gate) await gate.promise
      const killed = kills.some(pattern => String(spec.command).includes(pattern))
      const exitCode = killed ? null : failures.some(pattern => String(spec.command).includes(pattern)) ? 1 : 0
      return {
        result: async () => ({
          exitCode,
          signal: killed ? 'SIGKILL' : null,
          timedOut: false,
          aborted: false,
          timeoutMs: spec.timeoutMs,
          stdout: { text: 'fake check output', truncated: false },
          stderr: { text: '', truncated: false },
        }),
      }
    },
  }
}

export function fakeWebServer() {
  const routes = []
  return {
    routes,
    register(definition) {
      routes.push(definition)
      return () => {}
    },
  }
}

export function connectSse(route, { headers = {} } = {}) {
  const chunks = []
  const handlers = {}
  const res = {
    status: null,
    headers: null,
    ended: false,
    writeHead(status, responseHeaders) {
      this.status = status
      this.headers = responseHeaders
    },
    write(chunk) {
      chunks.push(String(chunk))
      return true
    },
    end() {
      this.ended = true
    },
    on(event, handler) {
      handlers[event] = handler
    },
    destroy() {
      this.ended = true
    },
  }
  const req = { method: 'GET', headers }
  return { req, res, chunks, handlers, run: () => route.handler(req, res) }
}

export function fakeContext({ worktrees, agents, tokenMeter, shell, webServer, trust, agentPresets, agentTeams } = {}) {
  const services = new Map()
  const tools = []
  const routes = []
  const cleanups = []
  const listeners = new Map()
  const ctx = {
    get: name => services.get(name),
    on(name, handler) {
      const set = listeners.get(name) ?? new Set()
      set.add(handler)
      listeners.set(name, set)
      return () => set.delete(handler)
    },
    effect(fn) {
      const cleanup = fn()
      cleanups.push(cleanup)
      return cleanup
    },
    inject(deps, callback) {
      // Mirrors cordis: run the callback once every declared service exists.
      const ready = (Array.isArray(deps) ? deps : [deps]).every(name => services.has(name))
      if (ready) callback(ctx)
      return { dispose() {} }
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    connection: {
      fetch: {
        register(definition) {
          routes.push(definition)
          return () => {}
        },
      },
      ...(trust ? { requestRejection: ({ headers }) => trust(headers) } : {}),
    },
  }
  const commands = []
  services.set('commands', {
    register(definition) {
      commands.push(definition)
      return () => {}
    },
  })
  services.set('agents', agents ?? defaultAgents())
  services.set('approval', { setPolicy() {} })
  if (worktrees) services.set('worktrees', worktrees)
  if (tokenMeter) services.set('tokenMeter', tokenMeter)
  if (shell) services.set('shell', shell)
  if (webServer) services.set('webServer', webServer)
  if (agentPresets) services.set('agentPresets', agentPresets)
  if (agentTeams) services.set('agentTeams', agentTeams)
  const emit = (name, payload) => {
    for (const handler of [...(listeners.get(name) ?? [])]) handler(payload)
  }
  return { ctx, tools, routes, cleanups, services, commands, emit }
}

export async function makeBoard({ repo, config = {}, services = {} } = {}) {
  const dir = tempDir()
  const store = createBoardStore({ file: join(dir, 'board.json') })
  const harness = fakeContext(services)
  const runs = createRunController({
    ctx: harness.ctx,
    store,
    config: { workspace: repo?.dir ?? dir, maxWorkers: 2, ...config },
    log: () => {},
  })
  return { dir, store, runs, harness }
}

export async function loadPlugin({ workspace, config = {}, services = {}, dataDir } = {}) {
  const { apply } = await import('../lib/index.js')
  const directory = dataDir ?? tempDir()
  const harness = fakeContext(services)
  const plugin = apply(harness.ctx, { dataDir: directory, workspace, ...config })
  return { ...harness, plugin, dataDir: directory }
}

export async function callAction(routes, body) {
  const route = routes.find(candidate => candidate.path === '/api/board/action')
  const request = new Request('http://board.test/api/board/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const response = await route.fetch(request)
  return { status: response.status, body: await response.json() }
}

export async function getPresets(routes) {
  const route = routes.find(candidate => candidate.path === '/api/board/presets')
  const response = await route.fetch()
  return { status: response.status, body: await response.json() }
}

export async function getDiff(routes, id) {
  const route = routes.find(candidate => candidate.path === '/api/board/diff')
  const request = new Request('http://board.test/api/board/diff?id=' + encodeURIComponent(id))
  const response = await route.fetch(request)
  return { status: response.status, body: await response.json() }
}

export async function getState(routes, { summary = false } = {}) {
  const route = routes.find(candidate => candidate.path === '/api/board/state')
  const request = new Request('http://board.test/api/board/state' + (summary ? '?summary=1' : ''))
  const response = await route.fetch(request)
  return { status: response.status, body: await response.json() }
}

export async function getTicket(routes, id) {
  const route = routes.find(candidate => candidate.path === '/api/board/ticket')
  const request = new Request('http://board.test/api/board/ticket?id=' + encodeURIComponent(id))
  const response = await route.fetch(request)
  return { status: response.status, body: await response.json() }
}

export function findTool(tools, name) {
  const definition = tools.find(candidate => candidate.name === name)
  if (!definition) throw new Error(`tool ${name} is not registered`)
  return definition
}
