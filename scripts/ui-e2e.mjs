#!/usr/bin/env node
/**
 * Browser-driven UI smoke test for dsh-board.
 *
 * Boots a throwaway profile with seeded tickets, opens the board in a real
 * Chromium (Playwright core + the cached browser), and exercises the
 * interactive paths that have no DOM-level unit tests: search, keyboard
 * navigation, saved views, batch assign, CSV export, hash deep links, the
 * transcript picker, the GC button and the PR action's presence.
 *
 * Usage: node scripts/ui-e2e.mjs   (needs `npm install` + a cached Chromium)
 */
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createBoardStore } from '../lib/store.js'

const PLUGIN_ROOT = resolve(new URL('..', import.meta.url).pathname)
const DSH_BIN = process.env.DSH_BIN ?? 'dsh'
const PORT = 3500 + Math.floor(Math.random() * 300)
const home = mkdtempSync(join(tmpdir(), 'dsh-board-ui-home-'))
const repo = mkdtempSync(join(tmpdir(), 'dsh-board-ui-repo-'))
const checks = []
const check = async (name, run) => {
  try {
    await run()
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
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function chromiumExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  const cache = join(homedir(), '.cache', 'ms-playwright')
  const candidates = existsSync(cache) ? readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).sort().reverse() : []
  for (const name of candidates) {
    for (const binary of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const candidate = join(cache, name, binary)
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error('no cached Chromium found (set PLAYWRIGHT_CHROMIUM_EXECUTABLE)')
}

function setup() {
  const profileDir = join(home, 'profiles', 'board')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-board-ui',
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
      `    sessionsDir: ${join(home, 'sessions')}`,
      '    pullRequest:',
      '      repository: acme/repo',
      '      token: test-token',
      '      base: main',
      '- insert:',
      '    - id: worktrees',
      "      name: '@deepseek-ai/dsh-experimental-worktree'",
      '',
    ].join('\n'),
  )
  symlinkSync(PLUGIN_ROOT, join(profileDir, 'node_modules', 'dsh-board'), 'dir')

  mkdirSync(join(home, 'board'), { recursive: true })
  const store = createBoardStore({ file: join(home, 'board', 'board.json') })
  store.createTicket({ title: 'Alpha work', assignee: 'coder' })
  const beta = store.createTicket({ title: 'Beta review', assignee: 'coder' })
  store.createTicket({ title: 'Gamma chore' })
  store.startPlanning(beta.id, 'session-ui-plan')
  store.submitPlan(beta.id, { markdown: '# beta plan' }, 'session-ui-plan')
  store.setReviewSession(beta.id, 'session-ui-review')
  store.updateTicket({ id: beta.id, status: 'ready' })
  store.updateTicket({ id: beta.id, status: 'in_progress' })
  const run = store.addRun(beta, { status: 'awaiting_review', sessionId: 'session-ui-worker' })
  store.patchRun(run, {})
  store.updateTicket({ id: beta.id, status: 'in_review' })
  store.save()

  const sessionsDir = join(home, 'sessions', '--ui--')
  const writeSession = (id, text) => {
    mkdirSync(join(sessionsDir, id), { recursive: true })
    writeFileSync(
      join(sessionsDir, id, 'session.v4.jsonl'),
      JSON.stringify({ type: 'assistant/message', time: 1, data: { message: { content: [{ type: 'text', text }] } } }) + '\n',
    )
  }
  writeSession('session-ui-plan', 'planning transcript line')
  writeSession('session-ui-review', 'reviewer transcript line')
  writeSession('session-ui-worker', 'worker transcript line')

  mkdirSync(join(repo, '.agents', 'worktrees'), { recursive: true })
  writeFileSync(join(repo, 'README.md'), '# ui e2e\n')
  writeFileSync(join(repo, '.agents', 'worktrees', '.gitignore'), '*\n')
  const git = args => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  git(['init', '-q', '.'])
  git(['config', 'user.email', 'e2e@example.com'])
  git(['config', 'user.name', 'e2e'])
  git(['add', '-A'])
  git(['commit', '-qm', 'base'])
  git(['branch', 'board/ui-orphan'])
  return profileDir
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    page.on('dialog', async dialog => {
      if (dialog.type() === 'prompt') await dialog.accept('ui view')
      else await dialog.accept()
    })
    await page.goto(url)
    await delay(1200)
    await page.evaluate(() => {
      for (const dialog of document.querySelectorAll('[role=dialog]')) {
        for (const button of dialog.querySelectorAll('button')) {
          if (['Close', 'Continue', 'Got it'].includes(button.textContent.trim())) button.click()
        }
      }
    })
    await delay(300)

    const openBoard = async () => {
      await page.locator('button[aria-label^="Board"]').first().click()
      await page.waitForSelector('.dshb-root', { timeout: 10000 })
      await delay(500)
    }
    const cardCount = () => page.locator('.dshb-card').count()

    await check('the board panel renders the seeded cards', async () => {
      await openBoard()
      assert((await cardCount()) === 3, `expected 3 cards, saw ${await cardCount()}`)
    })

    await check('search narrows the board and clearing restores it', async () => {
      const input = page.locator('.dshb-filterinput').first()
      await input.fill('Beta')
      await delay(400)
      assert((await cardCount()) === 1, 'search did not narrow to one card')
      await input.fill('')
      await delay(400)
      assert((await cardCount()) === 3, 'clearing the search did not restore the cards')
    })

    await check('keyboard: "/" focuses search, j/Enter opens a ticket, Escape closes', async () => {
      await page.locator('body').click({ position: { x: 4, y: 4 } })
      await page.keyboard.press('/')
      await delay(200)
      const focused = await page.evaluate(() => document.activeElement?.classList.contains('dshb-filterinput'))
      assert(focused, '"/" did not focus the search input')
      await page.evaluate(() => document.querySelector('.dshb-filterinput')?.blur())
      await page.locator('body').click({ position: { x: 4, y: 4 } })
      await page.keyboard.press('j')
      await delay(250)
      assert((await page.locator('.dshb-card-focused').count()) === 1, 'j did not focus a card')
      await page.keyboard.press('Enter')
      await delay(700)
      assert((await page.locator('.dshb-drawer .dshb-dtitle').count()) === 1, 'Enter did not open the drawer')
      await page.keyboard.press('Escape')
      await delay(400)
      assert((await page.locator('.dshb-drawer').count()) === 0, 'Escape did not close the drawer')
    })

    await check('saved views can be saved, applied and deleted', async () => {
      const input = page.locator('.dshb-filterinput').first()
      await input.fill('Alpha')
      await delay(300)
      await page.getByRole('button', { name: 'Save view' }).click()
      await delay(400)
      await input.fill('')
      await delay(300)
      await page.locator('select[aria-label="Saved views"]').selectOption('ui view')
      await delay(500)
      assert((await cardCount()) === 1, 'applying the saved view did not filter')
      await page.getByRole('button', { name: 'Delete view' }).click()
      await delay(400)
      const options = await page.locator('select[aria-label="Saved views"] option').allTextContents()
      assert(!options.includes('ui view'), 'the saved view was not deleted')
      await page.getByRole('button', { name: 'Clear' }).click()
      await delay(300)
    })

    await check('batch select + assign updates both cards', async () => {
      await page.getByRole('button', { name: 'Select', exact: true }).click()
      await delay(300)
      const cards = page.locator('.dshb-card')
      await cards.nth(0).click()
      await cards.nth(1).click()
      await delay(200)
      const assignee = page.locator('.dshb-filterinput[placeholder="assignee"]')
      await assignee.fill('qa-bot')
      await page.getByRole('button', { name: 'Assign', exact: true }).click()
      await delay(1200)
      const text = await page.locator('.dshb-root').innerText()
      assert(/2 ok/.test(text), 'batch assignment did not report success')
      assert((await page.locator('.dshb-card', { hasText: '@qa-bot' }).count()) >= 1, 'cards did not show the new assignee')
      await page.getByRole('button', { name: 'Done selecting' }).click()
      await delay(300)
    })

    await check('CSV export contains the filtered tickets', async () => {
      const csv = await page.evaluate(async () => {
        const blobs = []
        const originalCreate = URL.createObjectURL
        const originalClick = HTMLAnchorElement.prototype.click
        URL.createObjectURL = blob => {
          blobs.push(blob)
          return 'blob:ui-test'
        }
        HTMLAnchorElement.prototype.click = function () {}
        try {
          const button = [...document.querySelectorAll('button')].find(candidate => candidate.textContent.trim() === 'Export CSV')
          button.click()
          await new Promise(resolve => setTimeout(resolve, 300))
          return blobs.length ? await blobs[0].text() : null
        } finally {
          URL.createObjectURL = originalCreate
          HTMLAnchorElement.prototype.click = originalClick
        }
      })
      assert(csv && csv.startsWith('key,title,status,assignee,plan,priority,blocked_by,updated'), 'CSV header missing')
      assert(/Alpha work/.test(csv), 'CSV did not contain the seeded ticket')
    })

    await check('deep link #B-1 opens the ticket drawer', async () => {
      await page.goto(url + '#B-1')
      await page.waitForSelector('.dshb-root', { timeout: 10000 })
      await delay(1200)
      const title = await page.locator('.dshb-drawer .dshb-dtitle').first().innerText()
      assert(title === 'Alpha work', `deep link opened "${title}"`)
      await page.keyboard.press('Escape')
      await delay(300)
    })

    await check('transcript picker loads the reviewer session', async () => {
      const cards = page.locator('.dshb-card')
      const beta = cards.filter({ hasText: 'Beta review' })
      await beta.click()
      await page.waitForSelector('.dshb-drawer', { timeout: 5000 })
      await page.locator('select[aria-label="Transcript session"]').selectOption('session-ui-review')
      await page.getByRole('button', { name: /Show transcript/ }).click()
      await delay(1000)
      const text = await page.locator('.dshb-drawer').innerText()
      assert(/reviewer transcript line/.test(text), 'the reviewer transcript was not rendered')
      await page.keyboard.press('Escape')
      await delay(300)
    })

    await check('the GC button removes the orphan board branch', async () => {
      await page.getByRole('button', { name: 'GC', exact: true }).click()
      await delay(1200)
      const text = await page.locator('.dshb-root').innerText()
      assert(/GC removed/.test(text), 'GC did not report a result')
      const branches = execFileSync('git', ['branch', '--list', 'board/*'], { cwd: repo }).toString().trim()
      assert(branches === '', `orphan branch still present: ${branches}`)
    })

    await check('the PR action appears on a gate ticket when PR mode is configured', async () => {
      const beta = page.locator('.dshb-card').filter({ hasText: 'Beta review' })
      await beta.click()
      await page.waitForSelector('.dshb-drawer', { timeout: 5000 })
      const panel = await page.locator('.dshb-drawer').innerText()
      assert(/Open pull request/.test(panel), 'the PR action is missing from the gate drawer')
      await page.keyboard.press('Escape')
    })
  } finally {
    if (browser) await browser.close().catch(() => {})
    child.kill('SIGTERM')
    await delay(300)
    rmSync(home, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }

  const failed = checks.filter(item => !item.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} ui checks passed`)
  if (failed.length) process.exitCode = 1
}

main().catch(error => {
  console.error('UI e2e failed:', error.message)
  process.exitCode = 1
})
