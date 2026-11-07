#!/usr/bin/env node
/**
 * Fetches CC0/public-domain b-roll stills and an audio bed from Openverse
 * (keyless API) for demo-v3, and writes media/free/CREDITS.md.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const OUT = resolve(new URL('..', import.meta.url).pathname, 'media', 'free')
mkdirSync(`${OUT}/images`, { recursive: true })
const API = 'https://api.openverse.org/v1'
const queries = [
  ['network', 'abstract network technology dark'],
  ['circuit', 'circuit board macro'],
  ['server', 'server room technology dark'],
  ['flow', 'abstract light particles'],
  ['code', 'code screen programming'],
]
const credits = []

async function json(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'dsh-board-demo/1.0 (github.com/HoomerPH/dsh-board)' } })
  if (!response.ok) throw new Error(`${url} -> ${response.status}`)
  return response.json()
}

for (const [name, query] of queries) {
  const data = await json(`${API}/images/?q=${encodeURIComponent(query)}&license=cc0,pdm&page_size=10&orientation=landscape`)
  const candidates = (data.results ?? [])
    .filter(item => item.url && (!item.width || item.width >= 900) && (!item.height || item.width / item.height >= 1.5))
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))
  const pick = candidates[0]
  if (!pick) {
    console.log('no candidate for', name)
    continue
  }
  const image = await fetch(pick.url)
  if (!image.ok) {
    console.log('download failed', name, image.status)
    continue
  }
  const extension = (pick.url.match(/\.(jpe?g|png|webp)(\?|$)/i)?.[1] ?? 'jpg').toLowerCase()
  const file = `${OUT}/images/${name}.${extension}`
  writeFileSync(file, Buffer.from(await image.arrayBuffer()))
  credits.push({ type: 'image', name, title: pick.title, creator: pick.creator, license: pick.license, licenseUrl: pick.license_url, source: pick.foreign_landing_url ?? pick.url, file })
  console.log('image', name, '->', file, pick.width + 'x' + pick.height, pick.license, '|', pick.title, '|', pick.creator)
}

const lines = [
  '# Demo v3 media credits',
  '',
  'All assets below are CC0 / public domain, fetched from the [Openverse](https://openverse.org) API.',
  '',
  '| File | Title | Creator | License | Source |',
  '|---|---|---|---|---|',
  ...credits.map(item => `| \`${item.file.split('/').slice(-2).join('/')}\` | ${item.title ?? ''} | ${item.creator ?? 'unknown'} | ${item.license} | ${item.source ?? ''} |`),
  '',
]
writeFileSync(`${OUT}/CREDITS.md`, lines.join('\n'))
writeFileSync(`${OUT}/credits.json`, JSON.stringify(credits, null, 2))
console.log('credited', credits.length, 'images')
