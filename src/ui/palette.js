'use strict'
const api = window.drift
const q = document.getElementById('q')
const resEl = document.getElementById('results')
let O = null; let results = []; let sel = 0; let sugg = []; let suggSeq = 0

const host = (u) => { try { return new URL(u).host.replace(/^www\./, '') } catch { return u } }
const looksUrl = (t) => /^(https?:\/\/|localhost|\d+\.\d+\.\d+\.\d+)/i.test(t) || (!/\s/.test(t) && /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(t))

function score (text, query) {
  text = (text || '').toLowerCase()
  const i = text.indexOf(query)
  if (i >= 0) return 100 - Math.min(i, 50)
  let p = 0; for (const c of query) { p = text.indexOf(c, p); if (p < 0) return 0; p++ }
  return 10
}
function rank (list, query, fields, n) {
  if (!query) return list.slice(0, n)
  return list.map(x => [Math.max(...fields.map(f => score(x[f], query))), x]).filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0]).slice(0, n).map(([, x]) => x)
}

function compute () {
  const text = q.value.trim(); const ql = text.toLowerCase(); const s = O.snapshot
  const out = []
  if (O.mode === 'find' || O.mode === 'prompt') return []
  if (O.mode === 'pick') return rank(O.items, ql, ['title'], 50).map(i => ({ type: 'pick', value: i.value, title: i.title, color: i.color }))
  if (O.mode === 'archive') return rank(s.archive, ql, ['title', 'url'], 60).map(a => ({ type: 'archive', i: a.i, title: a.title, url: a.url, favicon: a.favicon, k: ago(a.archivedAt) }))
  if (text) {
    if (looksUrl(text)) out.push({ type: 'go', text, title: text, k: 'Open' })
    else out.push({ type: 'go', text, title: text, k: `Search ${s.engine}`, icon: '⌕' })
    for (const g of sugg) if (g.toLowerCase() !== ql) out.push({ type: 'go', text: g, title: g, icon: '⌕' })
  }
  if (O.mode !== 'split') for (const c of rank(s.commands, ql, ['title'], text ? 4 : 0)) out.push({ type: 'command', id: c.id, title: c.title, k: c.keys, icon: '⌘' })
  for (const t of rank(s.tabs, ql, ['title', 'url'], text ? 5 : 6)) out.push({ type: 'tab', id: t.id, title: t.title, url: t.url, favicon: t.favicon, k: O.mode === 'split' ? 'Split' : 'Switch to Tab' })
  const seen = new Set(out.map(o => o.url))
  for (const h of rank(s.history, ql, ['title', 'url'], 30)) {
    if (seen.has(h.url)) continue; seen.add(h.url)
    out.push({ type: 'go', url: h.url, title: h.title, sub: h.url, favicon: null, icon: '◷' })
    if (out.length > 14) break
  }
  if (text) for (const a of rank(s.archive, ql, ['title', 'url'], 3)) out.push({ type: 'archive', i: a.i, title: a.title, url: a.url, favicon: a.favicon, k: 'Archived' })
  return out
}
function ago (t) { const m = (Date.now() - t) / 60e3; return m < 60 ? `${Math.round(m)}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago` }

function render () {
  results = compute(); sel = Math.min(sel, Math.max(0, results.length - 1))
  resEl.replaceChildren(...results.map((r, i) => {
    const el = document.createElement('div'); el.className = 'r' + (i === sel ? ' sel' : '')
    if (r.color) { const c = document.createElement('span'); c.className = 'sw'; c.style.background = r.color; el.append(c) } else if (r.favicon && /^(https:|data:image)/.test(r.favicon)) { const im = document.createElement('img'); im.src = r.favicon; im.onerror = () => { const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = '○'; im.replaceWith(ic) }; el.append(im) } else { const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = r.icon || '○'; el.append(ic) }
    const t = document.createElement('span'); t.className = 't'; t.textContent = r.title || r.url; el.append(t)
    const u = document.createElement('span'); u.className = 'u'; u.textContent = r.url ? host(r.url) : (r.sub || ''); el.append(u)
    if (r.k) { const k = document.createElement('span'); k.className = 'k'; k.textContent = r.k; el.append(k) }
    el.onmousemove = () => { if (sel !== i) { sel = i; mark() } }
    el.onclick = () => { sel = i; submit() }
    return el
  }))
}
function mark () { [...resEl.children].forEach((c, i) => c.classList.toggle('sel', i === sel)); resEl.children[sel]?.scrollIntoView({ block: 'nearest' }) }

function submit (shift) {
  if (O.mode === 'find') return api.send('find', q.value, { forward: !shift, findNext: true })
  if (O.mode === 'prompt') return api.send('prompt-result', O.key, q.value.trim())
  const r = results[sel]
  if (O.mode === 'pick') return r && api.send('prompt-result', O.key, r.value)
  if (!r) { if (q.value.trim()) api.send('palette-submit', { type: 'go', text: q.value }); else close(); return }
  api.send('palette-submit', r)
}
function close () { if (O?.mode === 'prompt' || O?.mode === 'pick') api.send('prompt-result', O.key, null); else api.send('overlay-close') }

q.addEventListener('input', () => {
  sel = 0
  if (O.mode === 'find') { api.send('find', q.value, { findNext: false }); return }
  render()
  const text = q.value.trim()
  if ((O.mode === 'new' || O.mode === 'edit' || O.mode === 'split') && O.snapshot.suggestions && text && !looksUrl(text)) {
    const seq = ++suggSeq
    api.suggest(text).then(list => { if (seq === suggSeq) { sugg = list; render() } })
  } else sugg = []
})
q.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); close() } else if (e.key === 'Enter') { e.preventDefault(); submit(e.shiftKey) } else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); sel = Math.min(sel + 1, results.length - 1); mark() } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); sel = Math.max(sel - 1, 0); mark() }
})
document.getElementById('backdrop').onmousedown = close

const TITLES = { split: 'Open in split view', archive: 'Archived tabs', edit: '' , new: '' }
api.on('open', (o) => {
  O = o; sel = 0; sugg = []
  document.documentElement.style.setProperty('--space', o.snapshot.color)
  document.body.className = o.mode === 'find' ? 'find' : ''
  document.getElementById('title').textContent = o.title || TITLES[o.mode] || ''
  document.getElementById('glyph').textContent = o.mode === 'find' ? '⌕' : o.mode === 'prompt' ? '✎' : o.mode === 'split' ? '◫' : '⌕'
  document.getElementById('count').textContent = ''
  q.placeholder = { find: 'Find in page', prompt: '', pick: 'Filter…', archive: 'Search archived tabs…', split: 'Search or enter URL for the right pane…' }[o.mode] ?? 'Search, enter URL or run a command…'
  q.type = o.secret ? 'password' : 'text'
  q.value = o.query || ''
  render(); q.focus(); q.select()
})
api.on('find-result', (r) => { if (r.finalUpdate) document.getElementById('count').textContent = r.matches ? `${r.activeMatchOrdinal}/${r.matches}` : 'No matches' })
