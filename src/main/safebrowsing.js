'use strict'
// Dangerous-site protection from public threat feeds, checked entirely on your Mac:
//   • abuse.ch URLhaus — hosts currently distributing malware
//   • OpenPhish community feed — live phishing pages (matched by host + path, so shared hosts aren't blocked wholesale)
// Feeds are downloaded (no browsing data is ever sent), cached on disk and refreshed every 6 hours.
const fs = require('fs')
const path = require('path')
const { net } = require('electron')

const FEEDS = {
  malware: { url: 'https://urlhaus.abuse.ch/downloads/hostfile/', file: 'threats-malware.txt' },
  phishing: { url: 'https://openphish.com/feed.txt', file: 'threats-phishing.txt' }
}
const REFRESH = 6 * 3600e3

const malwareHosts = new Set()
const phishing = new Map() // host -> [path prefixes]
let dir = null
let timer = null

function parseMalware (text) {
  malwareHosts.clear()
  for (const line of text.split('\n')) {
    const l = line.trim(); if (!l || l.startsWith('#')) continue
    const host = l.split(/\s+/).pop().toLowerCase()
    if (host && host !== 'localhost') malwareHosts.add(host)
  }
}
function parsePhishing (text) {
  phishing.clear()
  for (const line of text.split('\n')) {
    try {
      const u = new URL(line.trim())
      const host = u.hostname.toLowerCase(); const p = u.pathname.replace(/\/+$/, '') || '/'
      if (!phishing.has(host)) phishing.set(host, [])
      phishing.get(host).push(p)
    } catch {}
  }
}

async function refresh (kind) {
  const f = FEEDS[kind]; const file = path.join(dir, f.file)
  try {
    const fresh = fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < REFRESH
    let text
    if (fresh) text = fs.readFileSync(file, 'utf8')
    else {
      const res = await net.fetch(f.url, { signal: AbortSignal.timeout(20000) })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      text = await res.text()
      fs.writeFileSync(file + '.tmp', text); fs.renameSync(file + '.tmp', file)
    }
    kind === 'malware' ? parseMalware(text) : parsePhishing(text)
  } catch {
    if (fs.existsSync(file)) { const t = fs.readFileSync(file, 'utf8'); kind === 'malware' ? parseMalware(t) : parsePhishing(t) }
  }
}

function start (userData) {
  dir = userData
  fs.mkdirSync(dir, { recursive: true })
  const run = () => Promise.all([refresh('malware'), refresh('phishing')])
  clearInterval(timer); timer = setInterval(run, REFRESH)
  return run()
}

// Returns 'malware' | 'phishing' | null for a URL
function check (url) {
  let u; try { u = new URL(url) } catch { return null }
  if (!/^https?:$/.test(u.protocol)) return null
  const host = u.hostname.toLowerCase()
  if (malwareHosts.has(host)) return 'malware'
  const paths = phishing.get(host)
  if (paths) {
    const p = u.pathname.replace(/\/+$/, '') || '/'
    if (paths.some(x => x === '/' || p === x || p.startsWith(x + '/'))) return 'phishing'
  }
  return null
}

// Test hooks
function addTestEntry (kind, value) { if (kind === 'malware') malwareHosts.add(value); else parsePhishing(value) }
function clearTestEntries () { malwareHosts.clear(); phishing.clear() }

module.exports = { start, check, addTestEntry, clearTestEntries, get size () { return malwareHosts.size + phishing.size } }
