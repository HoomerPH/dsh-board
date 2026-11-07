#!/usr/bin/env node
/**
 * Generate a b-roll clip with the Higgsfield REST API.
 *
 * The API key file holds `API_KEY_ID:API_KEY_SECRET` (Authorization: Key …).
 * This is the REST API, not the MCP endpoint (which requires OAuth).
 *
 * Usage:
 *   node scripts/higgsfield-gen.mjs --prompt "..." --out media/higgsfield/intro.mp4 \
 *     [--model bytedance/seedance-2.0/text-to-video] [--duration 5] [--resolution 720p]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const API = process.env.HIGGSFIELD_API_BASE ?? 'https://api.higgsfield.ai'
const KEY_FILE = process.env.HIGGSFIELD_KEY_FILE ?? join(homedir(), '.config', 'higgsfield', 'api-key')

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const key = readFileSync(KEY_FILE, 'utf8').trim()
if (!key.includes(':')) throw new Error('the key file must contain API_KEY_ID:API_KEY_SECRET')
const prompt = arg('prompt')
if (!prompt) throw new Error('--prompt is required')
const model = arg('model', 'bytedance/seedance-2.0/text-to-video')
const out = arg('out', join('media', 'higgsfield', `clip-${Date.now()}.mp4`))
const duration = Number(arg('duration', '5'))
const resolution = arg('resolution', '720p')
const aspect = arg('aspect_ratio', '16:9')
const headers = { Authorization: `Key ${key}`, 'Content-Type': 'application/json' }

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function requestJson(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  if (!response.ok) throw new Error(`${url} -> ${response.status} ${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`)
  return body
}

const created = await requestJson(`${API}/${model}`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ prompt, duration, resolution, aspect_ratio: aspect, generate_audio: false }),
})
const id = created.request_id ?? created.id ?? created.requestId
console.log('created:', JSON.stringify(created).slice(0, 300))
if (!id) throw new Error('no request id in the create response')

let result = null
for (let attempt = 0; attempt < 100; attempt += 1) {
  await sleep(3000)
  const status = await requestJson(`${API}/requests/${id}/status`, { headers })
  const state = status.status ?? status.state
  console.log(`[${attempt + 1}] ${state ?? JSON.stringify(status).slice(0, 160)}`)
  if (['completed', 'succeeded', 'success', 'done'].includes(String(state).toLowerCase())) {
    result = status
    break
  }
  if (['failed', 'error', 'cancelled', 'canceled'].includes(String(state).toLowerCase())) {
    throw new Error(`generation failed: ${JSON.stringify(status).slice(0, 400)}`)
  }
}
if (!result) throw new Error('generation timed out')
const url =
  result.result?.video?.url ??
  result.result?.url ??
  result.result?.video_url ??
  result.video_url ??
  result.output?.url ??
  (Array.isArray(result.result?.videos) ? result.result.videos[0]?.url : null)
console.log('result keys:', Object.keys(result), '| result.result keys:', result.result && Object.keys(result.result))
if (!url) {
  console.log(JSON.stringify(result, null, 2).slice(0, 1500))
  throw new Error('no video url in the status response')
}
mkdirSync(dirname(out), { recursive: true })
const video = await fetch(url)
if (!video.ok) throw new Error(`download failed: ${video.status}`)
writeFileSync(out, Buffer.from(await video.arrayBuffer()))
writeFileSync(out + '.json', JSON.stringify(result, null, 2))
console.log('saved:', out, existsSync(out))
