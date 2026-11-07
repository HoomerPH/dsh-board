#!/usr/bin/env node
/**
 * End-to-end smoke test for dsh-board against a real Harness install.
 *
 * Boots a throwaway profile on a random port, authenticates with the startup
 * token, and exercises the routes the panel uses (auth, summary state, ticket
 * detail, create, archive, prune, the SSE channel) plus the client bundle
 * reference. No model calls are made.
 *
 * Usage: node scripts/e2e.mjs        (set DSH_BIN if `dsh` is not on PATH)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PLUGIN_ROOT = resolve(new URL('..', import.meta.url).pathname)
const DSH_BIN = process.env.DSH_BIN ?? 'dsh'
const PORT = 3200 + Math.floor(Math.random() * 300)
const home = mkdtempSync(join(tmpdir(), 'dsh-board-e2e-home-'))
const repo = mkdtempSync(join(tmpdir(), 'dsh-board-e2e-repo-'))
let child = null
const checks = []
const check = (name, run) => {
  try {
    run()
    checks.push({ name, ok: true })
    console.log(`ok   ${name}`)
  } catch (error) {
    checks.push({ name, ok: false, error: error.message })
    console.log(`FAIL ${name}: ${error.message}`)
  }
}
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))

function setupProfile() {
  const profileDir = join(home, 'profiles', 'board')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-board-e2e',
        private: true,
        dependencies: { 'dsh-board': `link:${PLUGIN_ROOT}` },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-board'] } },
      },
      null,
      2,
    ),
  )
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
  writeFileSync(
    join(profileDir, 'cordis.patch.yml'),
    [
      '- id: board',
      '  config:',
      '    workspace: !!js process.env.DSH_BOARD_WORKSPACE || process.cwd()',
      '    maxWorkers: 1',
      '    archiveAfterDays: 1',
      '- insert:',
      '    - id: worktrees',
      "      name: '@deepseek-ai/dsh-experimental-worktree'",
      '',
    ].join('\n'),
  )
  symlinkSync(PLUGIN_ROOT, join(profileDir, 'node_modules', 'dsh-board'), 'dir')
  mkdirSync(join(home, 'board'), { recursive: true })
  writeFileSync(
    join(home, 'board', 'board.json'),
    JSON.stringify({ version: 2, board: { name: 'E2E Board' }, nextKey: 1, tickets: [], metrics: [] }),
  )
  mkdirSync(join(repo, '.agents', 'worktrees'), { recursive: true })
  writeFileSync(join(repo, 'README.md'), '# e2e\n')
  writeFileSync(join(repo, '.agents', 'worktrees', '.gitignore'), '*\n')
  return profileDir
}

async function waitForUrl(timeoutMs = 30000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const text = child.log.join('')
    const match = text.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/)
    if (match) return match[0]
    await delay(200)
  }
  throw new Error(`the board did not start; log:\n${child.log.join('')}`)
}

async function main() {
  const profileDir = setupProfile()
  child = spawn(DSH_BIN, ['--profile', 'board', '--no-open', '--port', String(PORT)], {
    cwd: repo,
    env: { ...process.env, DSH_HOME: home, DSH_BOARD_WORKSPACE: repo, DSH_BIN },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.log = []
  child.stdout.on('data', chunk => child.log.push(String(chunk)))
  child.stderr.on('data', chunk => child.log.push(String(chunk)))

  const startupUrl = await waitForUrl()
  const cookie = await login(startupUrl)
  const api = (path, init = {}) =>
    fetch(`http://127.0.0.1:${PORT}${path}`, {
      ...init,
      headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
    })

  const state = await api('/api/board/state?summary=1').then(response => response.json())
  check('summary state is served to an authenticated browser', () => {
    assert(state.board.name === 'E2E Board', `unexpected board name ${state.board.name}`)
    assert(Array.isArray(state.tickets), 'tickets must be an array')
    assert(typeof state.health === 'object', 'health is included')
    assert(typeof state.revision === 'number', 'revision is included')
  })

  const unauthorised = await fetch(`http://127.0.0.1:${PORT}/api/board/state?summary=1`)
  check('unauthenticated state is refused', () => assert(unauthorised.status === 401, `got ${unauthorised.status}`))

  const created = await api('/api/board/action', {
    method: 'POST',
    body: JSON.stringify({ action: 'create', title: 'e2e ticket', acceptance: 'works', priority: 2 }),
  }).then(response => response.json())
  const ticketId = created.tickets.find(ticket => ticket.key === 'B-1')?.id
  check('a ticket can be created with acceptance criteria and priority', () => {
    assert(Boolean(ticketId), 'created ticket missing')
    assert(created.tickets.find(ticket => ticket.key === 'B-1').priority === 2, 'priority not stored')
  })

  const summary = await api('/api/board/state?summary=1').then(response => response.json())
  const card = summary.tickets.find(ticket => ticket.key === 'B-1')
  check('summary tickets carry card data but not activity', () => {
    assert(card.activityCount === 1, `activityCount ${card.activityCount}`)
    assert(card.activity === undefined, 'summary must not include activity')
    assert(card.runs === undefined, 'summary must not include runs')
  })

  const detail = await api(`/api/board/ticket?id=${encodeURIComponent(ticketId)}`).then(response => response.json())
  check('the ticket detail route returns the full record', () => {
    assert(detail.ticket.acceptance[0] === 'works', 'acceptance missing')
    assert(detail.ticket.activity.length === 1, 'activity missing')
  })

  const archived = await api('/api/board/action', {
    method: 'POST',
    body: JSON.stringify({ action: 'archive', id: 'B-1' }),
  }).then(response => response.json())
  check('archive marks the ticket archived', () => {
    assert(Boolean(archived.tickets.find(ticket => ticket.key === 'B-1').archivedAt), 'archivedAt missing')
  })

  const pruned = await api('/api/board/action', { method: 'POST', body: JSON.stringify({ action: 'prune' }) }).then(response =>
    response.json(),
  )
  check('prune reports its outcome', () => {
    assert(Array.isArray(pruned.prune.removed), 'removed report missing')
    assert(Array.isArray(pruned.prune.skipped), 'skipped report missing')
  })

  const page = await fetch(`http://127.0.0.1:${PORT}/`, { headers: { cookie } }).then(response => response.text())
  check('the panel page references the board client bundle', () => {
    assert(page.includes('dsh-board/client.js'), 'client bundle reference missing from the page')
  })

  const sse = await fetch(`http://127.0.0.1:${PORT}/board/events`, { headers: { cookie, accept: 'text/event-stream' } })
  const reader = sse.body.getReader()
  const decoder = new TextDecoder()
  let stream = ''
  while (!stream.includes('"revision"')) {
    const chunk = await reader.read()
    if (chunk.done) break
    stream += decoder.decode(chunk.value, { stream: true })
  }
  await reader.cancel()
  check('the SSE channel streams a revision', () => {
    assert(stream.includes('"revision"'), 'no revision frame')
  })

  const deniedSse = await fetch(`http://127.0.0.1:${PORT}/board/events`)
  check('the SSE channel refuses an unauthenticated client', () => assert(deniedSse.status === 401, `got ${deniedSse.status}`))
}

async function login(startupUrl) {
  const response = await fetch(startupUrl, { redirect: 'manual' })
  const setCookie = response.headers.getSetCookie?.() ?? []
  const cookie = setCookie.map(value => value.split(';')[0]).join('; ')
  if (!cookie) throw new Error(`no session cookie from ${startupUrl}`)
  return cookie
}

try {
  await main()
} catch (error) {
  console.error(`\nE2E failed: ${error.message}`)
} finally {
  if (child) {
    child.kill('SIGTERM')
    await delay(500)
    if (!child.killed) child.kill('SIGKILL')
  }
  rmSync(home, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
  const failed = checks.filter(entry => !entry.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} e2e checks passed`)
  process.exit(failed.length ? 1 : 0)
}
