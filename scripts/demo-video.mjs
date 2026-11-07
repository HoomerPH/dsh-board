#!/usr/bin/env node
/**
 * Records the raw material for the dsh-board demo video.
 *
 * Boots a throwaway profile seeded with a realistic board (plan review, an
 * isolated review run with a real diff, a running worker, a done ticket),
 * records a scripted browser session with Playwright, and writes title/outro
 * cards plus scene timings for scripts/build-demo-video.sh.
 *
 * Usage: node scripts/demo-video.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createBoardStore } from '../lib/store.js'

const PLUGIN_ROOT = resolve(new URL('..', import.meta.url).pathname)
const DSH_BIN = process.env.DSH_BIN ?? 'dsh'
const PORT = 3600 + Math.floor(Math.random() * 200)
const home = mkdtempSync(join(tmpdir(), 'dsh-board-demo-home-'))
const repo = mkdtempSync(join(tmpdir(), 'dsh-board-demo-repo-'))
const out = join(PLUGIN_ROOT, 'media', 'raw')
mkdirSync(out, { recursive: true })

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))

function chromiumExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  const cache = join(homedir(), '.cache', 'ms-playwright')
  const candidates = existsSync(cache) ? readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).sort().reverse() : []
  for (const name of candidates) {
    for (const binary of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const candidate = join(cache, name, binary)
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error('no cached Chromium found; set PLAYWRIGHT_CHROMIUM_EXECUTABLE')
}

function setup() {
  const profileDir = join(home, 'profiles', 'board')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-board-demo',
    private: true,
    dependencies: { 'dsh-board': `link:${PLUGIN_ROOT}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-board'] } },
  }, null, 2))
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), [
    '- id: board',
    '  config:',
    '    workspace: !!js process.env.DSH_BOARD_WORKSPACE || process.cwd()',
    '    maxWorkers: 2',
    '    boardName: Agent Sprint',
    `    sessionsDir: ${join(home, 'sessions')}`,
    '- insert:',
    '    - id: worktrees',
    "      name: '@deepseek-ai/dsh-experimental-worktree'",
    '',
  ].join('\n'))
  symlinkSync(PLUGIN_ROOT, join(profileDir, 'node_modules', 'dsh-board'), 'dir')

  // A real repository so the review panel can show an actual diff.
  mkdirSync(join(repo, '.agents', 'worktrees'), { recursive: true })
  writeFileSync(join(repo, 'README.md'), '# demo project\n\nA small API used by the dsh-board demo.\n')
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo-project', version: '1.0.0' }, null, 2))
  writeFileSync(join(repo, '.agents', 'worktrees', '.gitignore'), '*\n')
  const git = args => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim()
  git(['init', '-q', '.'])
  git(['config', 'user.email', 'demo@example.com'])
  git(['config', 'user.name', 'demo'])
  git(['add', '-A'])
  git(['commit', '-qm', 'base'])
  const baseCommit = git(['rev-parse', 'HEAD'])
  const baseBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'])

  // Worktree for the "in review" ticket, with a committed diff.
  const worktreePath = join(repo, '.agents', 'worktrees', 'B-7-review')
  git(['worktree', 'add', '-q', '-b', 'board/B-7-auth-review', worktreePath, 'HEAD'])
  writeFileSync(join(worktreePath, 'auth.js'), 'export function verify(token) {\n  return token.length > 0\n}\n')
  execFileSync('git', ['add', '-A'], { cwd: worktreePath })
  execFileSync('git', ['commit', '-qm', 'harden the auth middleware'], { cwd: worktreePath })

  mkdirSync(join(home, 'board'), { recursive: true })
  const store = createBoardStore({ file: join(home, 'board', 'board.json') })
  const writeSession = (id, lines) => {
    const dir = join(home, 'sessions', '--demo--', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl'), lines.map((text, index) =>
      JSON.stringify({ type: 'assistant/message', time: index + 1, data: { message: { content: [{ type: 'text', text }] } } }),
    ).join('\n') + '\n')
  }

  const exportTicket = store.createTicket({ title: 'Add CSV export to reports', assignee: 'coder' })
  store.updateTicket({ id: exportTicket.id, priority: 2 })
  store.commentTicket({ id: exportTicket.id, text: 'Sales wants a per-month breakdown.', by: 'human' })

  const planTicket = store.createTicket({ title: 'Harden the auth middleware' })
  store.startPlanning(planTicket.id, 'session-demo-plan')
  store.submitPlan(planTicket.id, {
    markdown: [
      '## Approach',
      '',
      '1. Validate the JWT signature before decoding claims.',
      '2. Reject tokens without an `exp` claim.',
      '3. Add table-driven tests for expired, malformed and valid tokens.',
      '',
      '## Risks',
      '- Sessions issued before the change have no `exp`; keep a one-week grace window.',
      '',
      '## Files',
      '- `auth.js`, `auth.test.js`',
    ].join('\n'),
    acceptance: 'Expired tokens are rejected\nValid tokens still authenticate\nTests cover malformed input',
    checks: 'unit :: node --test auth.test.js\ntypecheck :: npx tsc --noEmit',
  }, 'session-demo-plan')
  writeSession('session-demo-plan', ['Let us plan the auth middleware hardening.'])

  const runningTicket = store.createTicket({ title: 'Fix flaky checkout test', assignee: 'coder' })
  store.updateTicket({ id: runningTicket.id, status: 'ready' })
  store.updateTicket({ id: runningTicket.id, status: 'in_progress' })
  store.commentTicket({ id: runningTicket.id, text: 'Flaky checkout test reproduced; adding a deterministic clock.', by: 'agent' })

  const reviewTicket = store.createTicket({ title: 'Revamp auth middleware', assignee: 'coder' })
  store.updateTicket({ id: reviewTicket.id, status: 'ready' })
  store.updateTicket({ id: reviewTicket.id, status: 'in_progress' })
  store.updateTicket({ id: reviewTicket.id, checks: 'unit tests :: node --test auth.test.js\ntypecheck :: npx tsc --noEmit' })
  store.updateTicket({
    id: reviewTicket.id,
    acceptance: 'Expired tokens are rejected\nValid tokens still authenticate\nTests cover malformed input',
  })
  reviewTicket.plan = {
    status: 'approved',
    version: 2,
    markdown: '## Approach\n\nValidate the JWT signature before decoding claims, reject tokens without `exp`, and add table-driven tests.\n\n## Risks\n\nSessions issued before the change have no `exp`; a one-week grace window applies.',
    acceptance: ['Expired tokens are rejected', 'Valid tokens still authenticate'],
    decomposition: [],
    checks: [],
    sessionId: 'session-demo-plan',
    feedback: [],
    submittedAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
  }
  const reviewRun = store.addRun(reviewTicket, { status: 'awaiting_review', sessionId: 'session-demo-review' })
  store.patchRun(reviewRun, {
    worktree: { path: worktreePath, branch: 'board/B-7-auth-review', baseCommit, repositoryRoot: repo, baseBranch },
    checks: [
      { name: 'unit tests', command: 'node --test auth.test.js', exitCode: 0, durationMs: 1240, stdout: 'pass 7\nfail 0\n', stderr: '', at: new Date().toISOString() },
      { name: 'typecheck', command: 'npx tsc --noEmit', exitCode: 0, durationMs: 840, stdout: '', stderr: '', at: new Date().toISOString() },
    ],
    checksRan: 2,
    checksFailed: 0,
    checksAt: new Date().toISOString(),
    tokens: 18400,
  })
  store.updateTicket({ id: reviewTicket.id, status: 'in_review' })
  writeSession('session-demo-review', [
    'Harden the auth middleware: signature first, then claims.',
    'Added table-driven tests; unit tests and typecheck pass. Moving the ticket to review.',
  ])

  const doneTicket = store.createTicket({ title: 'Document the scheduling queue', assignee: 'coder' })
  store.updateTicket({ id: doneTicket.id, status: 'ready' })
  store.updateTicket({ id: doneTicket.id, status: 'in_progress' })
  store.updateTicket({ id: doneTicket.id, status: 'in_review' })
  store.updateTicket({ id: doneTicket.id, status: 'done' })

  store.createTicket({ title: 'Rate-limit the public API', priority: 1 })
  store.createTicket({ title: 'Upgrade the CI cache', description: 'Cut CI time with a pnpm store cache.' })
  store.save()
  return { url: `http://127.0.0.1:${PORT}/?token=`, profile: true }
}

async function waitForUrl(child, timeoutMs = 40000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const match = child.log.join('').match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/)
    if (match) return match[0]
    await delay(150)
  }
  throw new Error(`the board did not start; log:\n${child.log.join('')}`)
}

function card(page, text) {
  return page.locator('.dshb-card').filter({ hasText: text }).first()
}

async function main() {
  setup()
  const child = spawn(DSH_BIN, ['--profile', 'board', '--no-open', '--port', String(PORT)], {
    cwd: repo,
    env: { ...process.env, DSH_HOME: home, DSH_BOARD_WORKSPACE: repo, DSH_BIN },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.log = []
  child.stdout.on('data', chunk => child.log.push(String(chunk)))
  child.stderr.on('data', chunk => child.log.push(String(chunk)))

  let browser
  try {
    const url = await waitForUrl(child)
    browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable(), args: ['--no-sandbox'] })
    const target = join(out, 'demo.webm')
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: out, size: { width: 1280, height: 720 } },
      colorScheme: 'dark',
    })
    const page = await context.newPage()
    const start = Date.now()
    const mark = name => ({ name, at: (Date.now() - start) / 1000 })
    const timeline = []
    const stash = (name) => timeline.push(mark(name))

    await page.goto(url)
    await delay(1200)
    await page.evaluate(() => {
      for (const dialog of document.querySelectorAll('[role=dialog]')) {
        for (const button of dialog.querySelectorAll('button')) {
          if (['Close', 'Continue', 'Got it'].includes(button.textContent.trim())) button.click()
        }
      }
    })
    await page.locator('button[aria-label^="Board"]').first().click()
    await page.waitForSelector('.dshb-root', { timeout: 15000 })
    await delay(2600)
    stash('overview')

    // Search + filter.
    const search = page.locator('.dshb-filterinput').first()
    await search.click()
    await search.type('auth', { delay: 90 })
    await delay(1200)
    await search.fill('')
    await delay(700)
    stash('search')

    // Plan review ticket.
    await card(page, 'Harden the auth middleware').click()
    await page.waitForSelector('.dshb-drawer', { timeout: 8000 })
    await delay(2800)
    stash('plan')
    await page.keyboard.press('Escape')
    await delay(500)

    // Review ticket: diff, checks, transcript.
    await card(page, 'Revamp auth middleware').click()
    await page.waitForSelector('.dshb-drawer', { timeout: 8000 })
    await delay(1400)
    const reviewPanel = page.locator('.dshb-review').first()
    if (await reviewPanel.count()) await reviewPanel.scrollIntoViewIfNeeded()
    await delay(3000)
    const drawerBody = page.locator('.dshb-drawer .dshb-dbody')
    await drawerBody.evaluate(element => { element.scrollTop = element.scrollHeight })
    await delay(1800)
    const transcriptSelect = page.locator('select[aria-label="Transcript session"]')
    if (await transcriptSelect.count()) {
      await transcriptSelect.selectOption('session-demo-review')
      await page.getByRole('button', { name: /Show transcript/ }).click()
      await delay(2000)
    }
    stash('review')
    await page.keyboard.press('Escape')
    await delay(500)

    // Batch selection.
    await page.getByRole('button', { name: 'Select', exact: true }).click()
    await delay(300)
    const cards = page.locator('.dshb-card')
    await cards.nth(0).click()
    await cards.nth(1).click()
    await delay(500)
    const assignee = page.locator('.dshb-filterinput[placeholder="assignee"]')
    await assignee.fill('coder')
    await delay(400)
    await page.getByRole('button', { name: 'Assign', exact: true }).click()
    await delay(1500)
    await page.getByRole('button', { name: 'Done selecting' }).click()
    await delay(900)
    stash('batch')

    // Insights.
    await page.getByRole('button', { name: 'Insights' }).click()
    await delay(2600)
    stash('insights')
    await page.locator('.dshb-drawer').getByRole('button', { name: 'Close' }).click()
    await delay(700)

    // Return to the board.
    await page.evaluate(() => window.scrollTo({ top: 0 }))
    await delay(2400)
    stash('outro')

    const video = page.video()
    await context.close()
    await browser.close()
    browser = null
    const saved = await video.path()
    writeFileSync(join(out, 'timeline.json'), JSON.stringify(timeline, null, 2))

    // Title / outro cards.
    const cardBrowser = await chromium.launch({ headless: true, executablePath: chromiumExecutable(), args: ['--no-sandbox'] })
    const cardPage = await cardBrowser.newPage({ viewport: { width: 1280, height: 720 } })
    const title = `<!doctype html><html><body style="margin:0;height:720px;background:radial-gradient(circle at 20% 20%, #16213a, #070b14 65%);font-family:'Helvetica Neue',Arial,sans-serif;color:#e6edf7;display:flex;flex-direction:column;justify-content:center;padding:0 96px">
      <div style="color:#6ee7b7;font-size:20px;letter-spacing:4px;text-transform:uppercase;margin-bottom:18px">DeepSeek Harness plugin</div>
      <div style="font-size:88px;font-weight:800;letter-spacing:-2px">dsh-board</div>
      <div style="font-size:32px;line-height:1.35;color:#a9b7cc;margin-top:22px;max-width:900px">A ticket-first board where agents do the work<br/>and humans keep the gates.</div>
      <div style="margin-top:44px;font-size:20px;color:#7c8ba1">github.com/HoomerPH/dsh-board</div>
    </body></html>`
    const outro = `<!doctype html><html><body style="margin:0;height:720px;background:radial-gradient(circle at 80% 10%, #12332a, #070b14 60%);font-family:'Helvetica Neue',Arial,sans-serif;color:#e6edf7;display:flex;flex-direction:column;justify-content:center;padding:0 96px">
      <div style="font-size:54px;font-weight:800;letter-spacing:-1px">Plan. Isolate. Review. Merge.</div>
      <div style="font-size:26px;line-height:1.4;color:#a9b7cc;margin-top:18px;max-width:940px">Every ticket is an audited run in its own Git worktree.<br/>Approvals stay human.</div>
      <div style="margin-top:56px;font-family:'SFMono-Regular',Consolas,monospace;font-size:24px;color:#6ee7b7;background:#0b1320;border:1px solid #1f2b3d;border-radius:12px;padding:18px 24px;width:fit-content">git clone https://github.com/HoomerPH/dsh-board.git</div>
      <div style="margin-top:44px;font-size:20px;color:#7c8ba1">MIT licensed · 146 offline tests · 10 browser UI checks</div>
    </body></html>`
    await cardPage.setContent(title)
    await cardPage.screenshot({ path: join(out, 'title.png') })
    await cardPage.setContent(outro)
    await cardPage.screenshot({ path: join(out, 'outro.png') })
    await cardPage.close()
    await cardBrowser.close()

    writeFileSync(join(out, 'video-path.txt'), saved)
    console.log(JSON.stringify({ video: saved, timeline }, null, 2))
  } finally {
    if (browser) await browser.close().catch(() => {})
    child.kill('SIGTERM')
    await delay(300)
    rmSync(home, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error('demo recording failed:', error.message)
  process.exitCode = 1
})
