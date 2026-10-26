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
  if (O.mode === 'find' || O.mode === 'prompt' || O.mode === 'peek' || O.mode === 'report') return []
  if (O.mode === 'pick') return rank(O.items, ql, ['title'], 200).map(i => ({ type: 'pick', value: i.value, title: i.title, color: i.color, group: i.group }))
  if (O.mode === 'archive') return rank(s.archive, ql, ['title', 'url'], 60).map(a => ({ type: 'archive', i: a.i, title: a.title, url: a.url, favicon: a.favicon, k: ago(a.archivedAt) }))
  if (text) {
    if (looksUrl(text)) out.push({ type: 'go', text, title: text, k: 'Open' })
    else out.push({ type: 'go', text, title: text, k: `Search ${s.engine}`, icon: '⌕' })
    if (aiMode || (s.ai && O.mode !== 'split' && !looksUrl(text))) out.splice(aiMode ? 0 : 1, 0, aiResult(text, s.ai || 'claude'))
    if (aiMode) return out.slice(0, 1)
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
const AI = { claude: ['Claude', null], chatgpt: ['ChatGPT', 'https://chatgpt.com/?q='], perplexity: ['Perplexity', 'https://www.perplexity.ai/search?q='] }
let aiMode = null
function aiResult (text, provider) {
  const [name, url] = AI[provider] || AI.claude
  return url ? { type: 'go', url: url + encodeURIComponent(text), title: `Ask ${name}: ${text}`, icon: '✳', k: 'Tab' } : { type: 'claude', text, title: `Ask Claude: ${text}`, icon: '✳', k: 'In Drift' }
}
function ago (t) { const m = (Date.now() - t) / 60e3; return m < 60 ? `${Math.round(m)}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago` }

function render () {
  results = compute(); sel = Math.min(sel, Math.max(0, results.length - 1))
  let lastGroup = null; const nodes = []
  results.forEach((r, i) => {
    if (r.group && r.group !== lastGroup) { lastGroup = r.group; const h = document.createElement('div'); h.className = 'grp'; h.textContent = r.group; nodes.push(h) }
    nodes.push(row(r, i))
  })
  resEl.replaceChildren(...nodes)
  warm()
}
function row (r, i) {
  {
    const el = document.createElement('div'); el.className = 'r' + (i === sel ? ' sel' : '')
    if (r.color) { const c = document.createElement('span'); c.className = 'sw'; c.style.background = r.color; el.append(c) } else if (r.favicon && /^(https:|data:image)/.test(r.favicon)) { const im = document.createElement('img'); im.src = r.favicon; im.onerror = () => { const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = '○'; im.replaceWith(ic) }; el.append(im) } else { const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = r.icon || '○'; el.append(ic) }
    const t = document.createElement('span'); t.className = 't'; t.textContent = r.title || r.url; el.append(t)
    const u = document.createElement('span'); u.className = 'u'; u.textContent = r.url ? host(r.url) : (r.sub || ''); el.append(u)
    if (r.k) { const k = document.createElement('span'); k.className = 'k'; k.textContent = r.k; el.append(k) }
    el.onmousemove = (e) => { if (pointerMoved(e) && sel !== i) { sel = i; mark() } }
    el.onclick = () => { sel = i; submit() }
    return el
  }
}
// Only a real mouse movement picks the row under the pointer. Chromium also fires mousemove when the
// list redraws under a still pointer (every keystroke), which used to move the selection off what you
// typed, so Enter after ⌘L opened a hovered tab or history entry instead
let lastPointer = null
function pointerMoved (e) {
  const p = e.screenX + ',' + e.screenY
  if (lastPointer === null) { lastPointer = p; return false }
  if (p === lastPointer) return false
  lastPointer = p; return true
}
function mark () { warm(); const rows = [...resEl.querySelectorAll('.r')]; rows.forEach((c, i) => c.classList.toggle('sel', i === sel)); rows[sel]?.scrollIntoView({ block: 'nearest' }) }
let warmTimer = null
function warm () { clearTimeout(warmTimer); warmTimer = setTimeout(() => { const r = results[sel]; const u = r?.url || (r?.type === 'go' && /^https:\/\//.test(r.text || '') ? r.text : null); if (u) api.send('preconnect', u) }, 120) }

function submit (shift) {
  if (closeTimer) return
  if (O.mode === 'find') return api.send('find', q.value, shift ? 'prev' : 'next')
  if (O.mode === 'prompt') return api.send('prompt-result', O.key, q.value.trim())
  const r = results[sel]
  if (O.mode === 'pick') return r && api.send('prompt-result', O.key, r.value)
  const text = q.value.trim()
  if (shift && O.snapshot.instant && text && !looksUrl(text) && ['new', 'edit'].includes(O.mode) && !aiMode) return api.send('instant', text)
  if (!r) { if (text) api.send('palette-submit', { type: 'go', text: q.value }); else close(); return }
  api.send('palette-submit', r)
}
// Closing without a result plays a short exit (.closing) and only then tells main; submits never wait.
// A re-open (or a second close) while the timer runs cancels/ignores it, so a stale close can't hit the next overlay.
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')
let closeTimer = null
function close () {
  if (closeTimer) return
  const o = O
  const send = () => { closeTimer = null; if (o?.mode === 'prompt' || o?.mode === 'pick') api.send('prompt-result', o.key, null); else api.send('overlay-close') }
  if (!o || o.mode === 'peek' || reduceMotion.matches) return send()
  document.body.classList.remove('opening'); document.body.classList.add('closing')
  closeTimer = setTimeout(send, 110)
}

q.addEventListener('input', () => {
  sel = 0
  if (O.mode === 'find') { api.send('find', q.value, 'new'); return }
  render()
  const text = q.value.trim()
  if ((O.mode === 'new' || O.mode === 'edit' || O.mode === 'split') && O.snapshot.suggestions && text && !looksUrl(text)) {
    const seq = ++suggSeq
    api.suggest(text).then(list => { if (seq === suggSeq) { sugg = list; render() } })
  } else sugg = []
})
q.addEventListener('keydown', (e) => {
  if (closeTimer) { e.preventDefault(); return }
  if (e.key === 'Tab' && O.snapshot.ai && !aiMode && ['new', 'edit'].includes(O.mode)) {
    const name = (AI[O.snapshot.ai] || AI.claude)[0].toLowerCase()
    if (q.value.trim().toLowerCase() === name || q.value.trim().toLowerCase() === 'claude') {
      e.preventDefault(); aiMode = q.value.trim().toLowerCase() === 'claude' ? 'claude' : O.snapshot.ai; O.snapshot.ai = aiMode
      document.getElementById('title').textContent = 'Ask ' + AI[aiMode][0]; document.getElementById('glyph').textContent = '✳'; q.value = ''; q.placeholder = 'Ask anything…'; render(); return
    }
  }
  if (e.key === 'Escape') { e.preventDefault(); close() } else if (e.key === 'Enter') { e.preventDefault(); submit(e.shiftKey) } else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); sel = Math.min(sel + 1, results.length - 1); mark() } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); sel = Math.max(sel - 1, 0); mark() }
})
document.getElementById('backdrop').onmousedown = close

const TITLES = { split: 'Open in split view', archive: 'Archived tabs', edit: '' , new: '' }
api.on('open', (o) => {
  clearTimeout(closeTimer); closeTimer = null
  O = o; sel = 0; sugg = []; aiMode = null; lastPointer = null
  document.documentElement.style.setProperty('--space', o.snapshot.color)
  document.body.className = ['find', 'peek', 'report'].includes(o.mode) ? o.mode : ''
  void document.body.offsetWidth // flush so adding .opening restarts the entrance even if it was already there
  document.body.classList.add('opening')
  if (o.mode === 'peek') { document.getElementById('peekurl').textContent = o.query; document.getElementById('peektitle').textContent = '' }
  if (o.mode === 'report') renderReport(o.report)
  const tm = o.snapshot.themeMode
  document.documentElement.dataset.mode = tm === 'dark' || (tm !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'
  if (o.mode === 'find') for (const k of FIND_OPTS) document.getElementById('o-' + k).checked = !!o.snapshot.find?.[k]
  document.getElementById('title').textContent = o.title || TITLES[o.mode] || ''
  document.getElementById('glyph').textContent = o.mode === 'find' ? '⌕' : o.mode === 'prompt' ? '✎' : o.mode === 'split' ? '◫' : '⌕'
  document.getElementById('count').textContent = ''
  q.placeholder = { find: 'Find in page', prompt: '', pick: 'Filter…', archive: 'Search archived tabs…', split: 'Search or enter URL for the right pane…' }[o.mode] ?? 'Search, enter URL or run a command…'
  q.type = o.secret ? 'password' : 'text'
  q.value = o.query || ''
  render(); q.focus(); q.select()
})
api.on('find-result', (r) => {
  if (!r.finalUpdate) return
  document.getElementById('count').textContent = !q.value ? '' : r.matches ? `${r.activeMatchOrdinal} of ${r.matches} match${r.matches === 1 ? '' : 'es'}` : 'No matches'
})
const FIND_OPTS = ['highlightAll', 'matchCase', 'diacritics', 'wholeWords']
for (const k of FIND_OPTS) {
  document.getElementById('o-' + k).onchange = (e) => { api.send('find', q.value, 'new', { [k]: e.target.checked }); q.focus() }
}
document.getElementById('f-prev').onclick = () => { api.send('find', q.value, 'prev'); q.focus() }
document.getElementById('f-next').onclick = () => { api.send('find', q.value, 'next'); q.focus() }
document.getElementById('f-close').onclick = close

api.on('peek-title', (t) => { document.getElementById('peektitle').textContent = t })
document.getElementById('peek-open').onclick = () => api.send('peek-open-tab')
document.getElementById('peek-split').onclick = () => api.send('peek-split')
document.getElementById('peek-close').onclick = close
document.getElementById('report-close').onclick = close
addEventListener('keydown', (e) => { if (e.key === 'Escape' && O && (O.mode === 'peek' || O.mode === 'report')) close() })

function renderReport (r) {
  const box = document.getElementById('report-body')
  document.getElementById('report-title').textContent = 'Site Inspector — ' + r.title
  box.replaceChildren(...r.sections.map(sec => {
    const s = document.createElement('section')
    const h = document.createElement('h3'); h.textContent = sec.title
    if (sec.grade) { const g = document.createElement('span'); g.className = 'grade g' + sec.grade[0]; g.textContent = sec.grade; h.prepend(g) }
    s.append(h)
    for (const [k, v, st] of sec.rows) {
      const row = document.createElement('div'); row.className = 'kv ' + (st || '')
      const a = document.createElement('span'); a.className = 'k'; a.textContent = k
      const b = document.createElement('span'); b.className = 'v'; b.textContent = v
      row.append(a, b); s.append(row)
    }
    return s
  }))
}
