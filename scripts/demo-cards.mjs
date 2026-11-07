#!/usr/bin/env node
/** Records the animated intro/outro cards for the demo (1920x1080, ~7 s each). */
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'

const OUT = resolve(new URL('..', import.meta.url).pathname, 'media', 'anim')
mkdirSync(OUT, { recursive: true })
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

const base = `
  html,body{margin:0;height:100%;overflow:hidden;background:#060a12;font-family:"Helvetica Neue",Arial,sans-serif;color:#e8eef8}
  .stage{position:relative;width:1920px;height:1080px;overflow:hidden}
  .blob{position:absolute;border-radius:50%;filter:blur(90px);opacity:.55;animation:drift 12s ease-in-out infinite alternate}
  .b1{width:900px;height:900px;left:-160px;top:-260px;background:#0e4a3a}
  .b2{width:760px;height:760px;right:-120px;bottom:-220px;background:#123058;animation-duration:15s}
  .grid{position:absolute;inset:0;background-image:linear-gradient(#ffffff08 1px,transparent 1px),linear-gradient(90deg,#ffffff08 1px,transparent 1px);background-size:64px 64px;mask-image:radial-gradient(circle at 50% 45%,#000 30%,transparent 78%)}
  @keyframes drift{from{transform:translate3d(0,0,0) scale(1)}to{transform:translate3d(60px,40px,0) scale(1.12)}}
  @keyframes rise{from{opacity:0;transform:translateY(28px)}to{opacity:1;transform:translateY(0)}}
  @keyframes grow{from{width:0;opacity:0}to{width:132px;opacity:1}}
  .content{position:absolute;left:150px;top:330px}
  .eyebrow{font-size:26px;letter-spacing:7px;text-transform:uppercase;color:#6ee7b7;opacity:0;animation:rise .9s .25s ease forwards}
  .title{font-size:150px;font-weight:800;letter-spacing:-5px;margin-top:26px;opacity:0;animation:rise 1s .45s ease forwards}
  .sub{font-size:46px;line-height:1.4;color:#a9b7cc;margin-top:34px;max-width:1250px;opacity:0;animation:rise 1s .75s ease forwards}
  .url{font-size:28px;color:#7c8ba1;margin-top:70px;opacity:0;animation:rise 1s 1.05s ease forwards}
  .line{height:5px;border-radius:4px;background:linear-gradient(90deg,#34d399,#3b82f6);margin-top:38px;opacity:0;animation:grow 1.1s .9s ease forwards}
  .code{margin-top:64px;font-family:"SFMono-Regular",Consolas,monospace;font-size:32px;color:#6ee7b7;background:#0a1320;border:1px solid #1d2b3f;border-radius:16px;padding:24px 32px;width:fit-content;opacity:0;animation:rise 1s 1.1s ease forwards}
  .foot{position:absolute;left:150px;bottom:96px;font-size:26px;color:#6b7a90;opacity:0;animation:rise 1s 1.4s ease forwards}
`

const style = `<style>${base}</style>`
const intro = `<!doctype html><html><head>${style}</head><body><div class="stage">
  <div class="blob b1"></div><div class="blob b2"></div><div class="grid"></div>
  <div class="content">
    <div class="eyebrow">DeepSeek Harness plugin</div>
    <div class="title">dsh-board</div>
    <div class="line"></div>
    <div class="sub">A ticket-first board where agents do the work<br/>and humans keep the gates.</div>
    <div class="url">github.com/HoomerPH/dsh-board</div>
  </div>
  <div class="foot">Plan · Isolate · Review · Merge</div>
</div></body></html>`

const outro = `<!doctype html><html><head>${style}</head><body><div class="stage">
  <div class="blob b1"></div><div class="blob b2"></div><div class="grid"></div>
  <div class="content" style="top:300px">
    <div class="eyebrow">Open source · MIT</div>
    <div class="title" style="font-size:104px;letter-spacing:-3px">Plan. Isolate.<br/>Review. Merge.</div>
    <div class="line" style="animation-delay:1s"></div>
    <div class="sub" style="font-size:38px">Every ticket is an audited run in its own Git worktree.<br/>Approvals stay human.</div>
    <div class="code">git clone https://github.com/HoomerPH/dsh-board.git</div>
  </div>
  <div class="foot">146 offline tests · 10 route e2e · 10 browser UI checks</div>
</div></body></html>`

const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable(), args: ['--no-sandbox'] })
try {
  for (const [name, html] of [['intro', intro], ['outro', outro]]) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } } })
    const page = await context.newPage()
    await page.setContent(html)
    await delay(6800)
    const video = page.video()
    await context.close()
    console.log(name, '->', await video.path())
  }
} finally {
  await browser.close()
}
