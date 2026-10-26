'use strict'
const $ = (s) => document.querySelector(s)
const api = window.drift
let S = null
let dragId = null
let pendingRender = false
// The same page also runs as the floating sidebar shown when you hover the left edge while it's hidden
const FLOAT = new URLSearchParams(location.search).has('float')
let floatSynced = false
if (FLOAT) document.documentElement.classList.add('float')

const host = (u) => { try { return new URL(u).host.replace(/^www\./, '') } catch { return u } }

// ---- line icons (24×24, stroked)
const ICONS = {
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M9.5 4.5v15"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  forward: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  reload: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.5H15"/>',
  stop: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  sliders: '<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="M7.5 9.5h9M7.5 14.5h9"/><circle cx="10.5" cy="9.5" r="1.7"/><circle cx="13.5" cy="14.5" r="1.7"/>',
  split: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M12 4.5v15"/>',
  claude: Array.from({ length: 12 }, (_, i) => { const a = i * Math.PI / 6; const r = i % 2 ? 6 : 8.5; return `<path d="M${(12 + Math.cos(a) * 2).toFixed(2)} ${(12 + Math.sin(a) * 2).toFixed(2)}L${(12 + Math.cos(a) * r).toFixed(2)} ${(12 + Math.sin(a) * r).toFixed(2)}"/>` }).join(''),
  broom: '<path d="M15.5 3.5l-4 8"/><path d="M7 12h8.5l1 8.5h-10.5z"/><path d="M9.5 16.5v4M12.5 16.5v4"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  archive: '<rect x="3.5" y="4.5" width="17" height="5" rx="1.5"/><path d="M5 9.5v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8M10 13.5h4"/>',
  close: '<path d="M7 7l10 10M17 7L7 17"/>',
  minus: '<path d="M6.5 12h11"/>',
  sound: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  muted: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M16 10l4 4M20 10l-4 4"/>',
  library: '<path d="M5 10h14v8.5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z"/><path d="M4 7.5h16v2.5H4z"/><path d="M10 13.5h4"/><path d="M9 4.5l1.5 3M15 4.5l-1.5 3"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  folderOpen: '<path d="M3.5 17V7.5a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2V10"/><path d="M3.5 17l2.3-6a1.5 1.5 0 0 1 1.4-1h13l-2.6 7a1.5 1.5 0 0 1-1.4 1H5a1.5 1.5 0 0 1-1.5-1z"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>'
}
function svg (name) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  el.setAttribute('viewBox', '0 0 24 24'); el.setAttribute('class', 'i')
  el.innerHTML = ICONS[name] || ''
  return el
}
function setIcon (el, name) { if (el.dataset.cur !== name) { el.dataset.cur = name; el.querySelector('svg.i')?.remove(); el.prepend(svg(name)) } }
document.querySelectorAll('[data-icon]').forEach(el => setIcon(el, el.dataset.icon))

// ---- space themes: 1–3 colour gradient, light/dark/auto, grain, intensity
const darkMQ = matchMedia('(prefers-color-scheme: dark)')
function applyTheme (th, priv) {
  if (priv) th = { colors: ['#55525e'], mode: 'dark', grain: true, intensity: 0.5 }
  const dark = th.mode === 'dark' || (th.mode !== 'light' && darkMQ.matches)
  const k = Math.round(22 + 58 * (th.intensity ?? 0.6))
  const base = dark ? '#15131a' : '#ffffff'
  const mix = (c, p) => `color-mix(in srgb, ${c} ${p}%, ${base})`
  const pct = dark ? Math.round(k * 0.75) : k
  const cols = th.colors.length ? th.colors : ['#7c5cff']
  const bg = cols.length === 1
    ? `linear-gradient(172deg, ${mix(cols[0], pct)}, ${mix(cols[0], Math.round(pct * 0.6))})`
    : `linear-gradient(172deg, ${cols.map(c => mix(c, pct)).join(', ')})`
  const root = document.documentElement
  root.style.setProperty('--bg', bg)
  root.style.setProperty('--space', cols[0])
  root.dataset.mode = dark ? 'dark' : 'light'
  document.body.classList.toggle('grain', th.grain !== false)
}
darkMQ.addEventListener('change', () => render())
function icon (t, size) {
  if (t.favicon && /^(https:|data:image)/.test(t.favicon)) {
    const img = document.createElement('img'); img.src = t.favicon; img.draggable = false
    img.onerror = () => img.replaceWith(ph(t)); return img
  }
  return ph(t)
}
function ph (t) { const d = document.createElement('span'); d.className = 'ph'; d.textContent = (host(t.url)[0] || '•').toUpperCase(); return d }

function tabRow (t, zone) {
  const el = document.createElement('div')
  const drifted = zone === 'pinned' && t.drifted
  el.className = 'row' + (t.id === S.activeTabId ? ' active' : '') + (t.loaded ? '' : ' unloaded') + (t.loading ? ' loading' : '') +
    (S.split && S.split.ids.includes(t.id) ? ' split' : '') + (drifted ? ' drifted' : '')
  el.draggable = true; el.dataset.id = t.id; el.dataset.zone = zone
  el.title = `${t.title}\n${t.url}`
  el.append(icon(t))
  if (drifted) { const sl = document.createElement('span'); sl.className = 'slash'; sl.textContent = '/'; el.append(sl) }
  const title = document.createElement('span'); title.className = 't'; title.textContent = t.title || host(t.url); el.append(title)
  if (t.audible || t.muted) {
    const s = document.createElement('button'); s.className = 'snd'; s.append(svg(t.muted ? 'muted' : 'sound')); s.title = t.muted ? 'Unmute' : 'Mute'
    s.onclick = (e) => { e.stopPropagation(); api.send('mute', t.id) }; el.append(s)
  }
  if (drifted) {
    const h = document.createElement('button'); h.className = 'home'; h.title = 'Back to pinned page'; h.append(svg('up'))
    h.onclick = (e) => { e.stopPropagation(); api.send('reset-pinned', t.id) }; el.append(h)
  }
  const x = document.createElement('button'); x.className = 'x'; x.append(svg(zone === 'today' ? 'close' : 'minus'))
  x.title = zone === 'today' ? 'Close tab' : 'Unload tab'
  x.onclick = (e) => { e.stopPropagation(); api.send('close', t.id) }
  el.append(x)
  bindTab(el, t)
  return el
}
// Tabs of the split that share a list become one entry ({ group }), in place of the first of them (Arc)
function groupSplit (list) {
  const group = (S.split?.ids || []).map(id => list.find(t => !t.folder && t.id === id)).filter(Boolean)
  if (group.length < 2) return list
  const first = list.find(t => group.includes(t))
  return list.flatMap(t => t === first ? [{ group }] : group.includes(t) ? [] : [t])
}
function splitRow (tabs, zone) {
  const el = document.createElement('div')
  el.className = 'row splitrow' + (tabs.some(t => t.id === S.activeTabId) ? ' active' : '')
  el.dataset.ids = tabs.map(t => t.id).join(',')
  for (const t of tabs) {
    const h = document.createElement('div'); h.className = 'half' + (t.id === S.activeTabId ? ' on' : '') + (t.loading ? ' loading' : '')
    h.draggable = true; h.dataset.id = t.id; h.dataset.zone = zone
    h.title = `${t.title}\n${t.url}`
    const title = document.createElement('span'); title.className = 't'; title.textContent = t.title || host(t.url)
    const x = document.createElement('button'); x.className = 'x'; x.append(svg(zone === 'today' ? 'close' : 'minus'))
    x.title = zone === 'today' ? 'Close tab' : 'Unload tab'
    x.onclick = (e) => { e.stopPropagation(); api.send('close', t.id) }
    h.append(icon(t), title, x)
    bindTab(h, t)
    el.append(h)
  }
  return el
}
function favTile (t) {
  const el = document.createElement('div')
  el.className = 'fav' + (t.id === S.activeTabId ? ' active' : '') + (t.loaded ? '' : ' unloaded')
  el.draggable = true; el.dataset.id = t.id; el.dataset.zone = 'favorite'; el.title = t.title
  el.append(icon(t)); bindTab(el, t)
  let hoverT = null
  el.onmouseenter = () => { hoverT = setTimeout(() => { const r = el.getBoundingClientRect(); api.send('fav-hover', t.id, { x: r.x, y: r.y, width: r.width, height: r.height }) }, 450) }
  el.onmouseleave = () => { clearTimeout(hoverT); api.send('fav-hover-end') }
  el.addEventListener('mousedown', () => { clearTimeout(hoverT); api.send('fav-hover-end') })
  return el
}
function bindTab (el, t) {
  el.onclick = () => api.send('activate', t.id)
  el.ondblclick = (e) => { e.preventDefault(); api.send('rename', t.id) }
  el.onauxclick = (e) => { if (e.button === 1) api.send('close', t.id) }
  el.oncontextmenu = (e) => { e.preventDefault(); api.send('tab-menu', t.id) }
  el.ondragstart = (e) => { dragId = t.id; el.classList.add('dragging'); e.dataTransfer.setData('text/plain', t.url); e.dataTransfer.effectAllowed = 'move' }
  el.ondragend = () => { dragId = null; el.classList.remove('dragging'); clearDrop(); if (pendingRender) render() }
}

// A folder in Pinned or in Today (made by Tidy); zone says how its tabs behave (× closes in Today, unloads in Pinned)
function folderRow (f, zone) {
  const wrap = document.createElement('div'); wrap.className = 'folder' + (f.open ? ' open' : '')
  const head = document.createElement('div'); head.className = 'row frow'; head.dataset.folder = f.id; head.draggable = true
  const chev = document.createElement('span'); chev.className = 'chev'; chev.append(svg('chevron'))
  head.append(chev, svg(f.open ? 'folderOpen' : 'folder'))
  const name = document.createElement('span'); name.className = 't'; name.textContent = f.name; head.append(name)
  head.onclick = () => api.send('toggle-folder', f.id)
  head.oncontextmenu = (e) => { e.preventDefault(); api.send('folder-menu', f.id) }
  head.ondragstart = (e) => { dragFolder = f.id; dragFolderZone = zone; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', f.name) }
  head.ondragend = () => { dragFolder = null; clearDrop(); if (pendingRender) render() }
  // dropping a tab on the folder header puts it inside
  head.ondragover = (e) => { if (dragId) { e.preventDefault(); e.stopPropagation(); clearDrop(); head.classList.add('over') } }
  head.ondrop = (e) => { e.preventDefault(); e.stopPropagation(); if (dragId) api.send('move', dragId, 'folder', -1, null, f.id); dragId = null; clearDrop() }
  const kids = document.createElement('div'); kids.className = 'kids dropzone'; kids.dataset.zone = 'folder'; kids.dataset.folder = f.id
  if (f.open) kids.append(...f.items.map(t => tabRow(t, zone)))
  bindZone(kids)
  wrap.append(head, kids)
  return wrap
}
let dragFolder = null; let dragFolderZone = null // a folder only reorders within its own list

// Keyed redraw: an entry whose data didn't change keeps its element, so favicons don't blink, hover
// controls stay put and a click that lands in the middle of an update isn't lost (the row under the
// mouse used to be replaced between mousedown and mouseup while pages were loading)
const sigs = new WeakMap()
function patch (box, items, keyOf, sigOf, make) {
  const old = new Map([...box.children].map(n => [n.dataset.key, n]))
  const next = items.map(it => {
    const k = keyOf(it); const sig = sigOf(it); const n = old.get(k)
    if (n && sigs.get(n) === sig) return n
    const e = make(it); e.dataset.key = k; sigs.set(e, sig); return e
  })
  next.forEach((n, i) => { if (box.children[i] !== n) box.insertBefore(n, box.children[i] || null) })
  while (box.children.length > next.length) box.lastChild.remove()
}
const inSplit = (id) => !!(S.split && S.split.ids.includes(id))
const tabSig = (t, zone) => JSON.stringify(t.group ? [t.group, zone, t.group.find(x => x.id === S.activeTabId)?.id] : [t, zone, t.id === S.activeTabId, inSplit(t.id)])
const rowKey = (t) => t.group ? 'split:' + t.group.map(x => x.id).join(',') : (t.folder ? 'f:' : '') + t.id
const rowEl = (t, zone) => t.group ? splitRow(t.group, zone) : tabRow(t, zone)

function clearDrop () { document.querySelectorAll('.over,.drop-before,.sp.drop').forEach(e => e.classList.remove('over', 'drop-before', 'drop')) }

// The tab ids a list entry stands for: a split row counts as all of its tabs, so drop indexes match main's list
const keysOf = (n) => n.dataset.ids ? n.dataset.ids.split(',') : [n.dataset.id || n.dataset.folder]

function bindZone (z) {
    z.ondragover = (e) => {
      if (dragFolder && z.dataset.zone === dragFolderZone) { e.preventDefault(); clearDrop(); z.classList.add('over'); return }
      if (!dragId) return
      e.preventDefault(); clearDrop(); z.classList.add('over')
      const target = e.target.closest('.splitrow') || e.target.closest('[data-id]'); if (target && !keysOf(target).includes(dragId)) target.classList.add('drop-before')
    }
    z.ondragleave = (e) => { if (!z.contains(e.relatedTarget)) z.classList.remove('over') }
    z.ondrop = (e) => {
      e.preventDefault(); e.stopPropagation()
      // only this zone's own entries count (tabs, and folders in the pinned list) — not tabs inside nested folders
      const own = [...z.children].map(n => n.matches('.folder') ? n.firstChild : n).filter(n => n.dataset.id || n.dataset.ids || n.dataset.folder)
      const target = [...own].find(n => n.contains(e.target))
      if (dragFolder) {
        const ids = own.flatMap(keysOf).filter(k => k !== dragFolder)
        if (z.dataset.zone === dragFolderZone) api.send('move-folder', dragFolder, target ? Math.max(0, ids.indexOf(keysOf(target)[0])) : ids.length)
        dragFolder = null; clearDrop(); return
      }
      if (!dragId) return
      const ids = own.flatMap(keysOf).filter(k => k !== dragId)
      // dropping on a split row means before its first tab (or its other tab, when you drag one of its own)
      const before = target && keysOf(target).find(k => k !== dragId)
      const index = before ? ids.indexOf(before) : ids.length
      api.send('move', dragId, z.dataset.zone, index, null, z.dataset.folder || null)
      dragId = null; clearDrop()
    }
}
function setupDropzones () { document.querySelectorAll('.dropzone').forEach(bindZone) }

function render () {
  if (!S) return
  if (dragId) { pendingRender = true; return }
  pendingRender = false
  const sp = S.spaces.find(s => s.id === S.activeSpaceId)
  applyTheme(sp.theme, S.private)
  document.documentElement.style.setProperty('--sw', S.sidebarWidth + 'px')
  document.body.classList.toggle('collapsed', !S.sidebarVisible)
  if (!FLOAT) document.body.classList.toggle('peek', !!S.sidebarPeek)
  else if (!floatSynced) { floatSynced = true; document.body.classList.toggle('peek', !!S.sidebarPeek) } // a hover that came before this page loaded
  document.body.classList.toggle('mac', S.isMac)
  document.body.classList.toggle('fullscreen', S.fullscreen)
  document.body.classList.toggle('has-tab', !!S.activeTabId)
  document.body.classList.toggle('private', !!S.private)
  const ex = $('#exts')
  if (ex) {
    ex.style.display = S.extensions ? '' : 'none'
    if (ex.getAttribute('partition') !== S.partition) ex.setAttribute('partition', S.partition)
    if (S.activeWcId && ex.getAttribute('tab') !== String(S.activeWcId)) ex.setAttribute('tab', String(S.activeWcId))
  }
  $('#b-back').disabled = !S.nav.canBack
  $('#b-fwd').disabled = !S.nav.canFwd
  setIcon($('#b-reload'), S.nav.loading ? 'stop' : 'reload')
  $('#url-text').textContent = S.nav.url ? host(S.nav.url) : 'Search or enter URL…'
  $('#blocked').textContent = S.nav.blocked ? String(S.nav.blocked) : ''
  document.body.classList.toggle('tidy', !!S.canTidy)
  document.body.classList.toggle('chat', !!S.chatOpen)
  document.body.classList.toggle('dim-unloaded', S.dimUnloaded !== false)
  document.body.classList.toggle('no-pin-reset', S.pinnedResetButton === false)

  patch($('#favorites'), S.favorites, t => t.id, t => tabSig(t, 'favorite'), favTile)
  $('#space-icon').textContent = sp.icon || ''
  $('#space-name').textContent = sp.name
  $('#space-profile').textContent = sp.profile && S.spaces.some(s => s.profile !== sp.profile) ? sp.profile : ''
  $('#space-head').oncontextmenu = (e) => { e.preventDefault(); api.send('space-menu', sp.id) }
  $('#space-head').ondblclick = () => api.send('space-edit', sp.id)
  patch($('#pinned'), groupSplit(S.pinned), rowKey,
    t => t.folder ? JSON.stringify([t, S.activeTabId, S.split?.ids, S.pinnedResetButton]) : tabSig(t, 'pinned'),
    t => t.folder ? folderRow(t, 'pinned') : rowEl(t, 'pinned'))
  patch($('#today'), groupSplit(S.today), rowKey,
    t => t.folder ? JSON.stringify([t, S.activeTabId, S.split?.ids]) : tabSig(t, 'today'),
    t => t.folder ? folderRow(t, 'today') : rowEl(t, 'today'))

  patch($('#spaces'), S.spaces, s => s.id, s => JSON.stringify([s.id, s.name, s.icon, s.profile, s.id === S.activeSpaceId]), s => {
    const b = document.createElement('button'); b.className = 'sp' + (s.id === S.activeSpaceId ? ' active' : '')
    b.title = s.name + (s.profile ? ` · ${s.profile}` : '')
    if (s.icon) b.textContent = s.icon; else b.append(document.createElement('i'))
    b.onclick = () => api.send('switch-space', s.id)
    b.oncontextmenu = (e) => { e.preventDefault(); api.send('space-menu', s.id) }
    b.ondragover = (e) => { if (dragId) { e.preventDefault(); clearDrop(); b.classList.add('drop') } }
    b.ondrop = (e) => { e.preventDefault(); if (dragId) api.send('move', dragId, 'today', 0, s.id); dragId = null; clearDrop() }
    return b
  })

  const running = S.downloads.filter(d => d.state === 'progressing' || d.state === 'paused').length
  $('#dl-badge').textContent = running ? String(running) : ''
  document.body.classList.toggle('dl-open', !!S.downloadsOpen)
  setIcon($('#b-newspace'), S.popoverOpen === 'menu' ? 'close' : 'plus')
  if (S.downloadsOpen) renderDownloads()
  syncPanes()
}

// ---- downloads panel (Arc-style: thumbnail, name, “15 hours ago”; click to open, drag to Finder)
const thumbs = new Map()
function ago (t) {
  if (!t) return ''
  const m = Math.round((Date.now() - t) / 60e3)
  if (m < 1) return 'Just now'; if (m < 60) return `${m} minute${m > 1 ? 's' : ''} ago`
  const h = Math.round(m / 60); if (h < 24) return `${h} hour${h > 1 ? 's' : ''} ago`
  const d = Math.round(h / 24); return d < 30 ? `${d} day${d > 1 ? 's' : ''} ago` : new Date(t).toLocaleDateString()
}
const fmtBytes = (n) => n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB'
function renderDownloads () {
  const list = $('#dl-list')
  if (!S.downloads.length) { const e = document.createElement('div'); e.className = 'dl-empty'; e.textContent = 'No downloads yet'; list.replaceChildren(e); return }
  list.replaceChildren(...S.downloads.map(d => {
    const el = document.createElement('div'); el.className = 'dl-item ' + d.state; el.draggable = d.state === 'completed'
    const th = document.createElement('div'); th.className = 'dl-thumb'
    if (thumbs.has(d.id)) { const img = document.createElement('img'); img.src = thumbs.get(d.id); th.append(img) } else th.textContent = (d.name.split('.').pop() || '').slice(0, 4).toUpperCase()
    const info = document.createElement('div'); info.className = 'dl-info'
    const n = document.createElement('div'); n.className = 'dl-name'; n.textContent = d.name
    const sub = document.createElement('div'); sub.className = 'dl-sub'
    if (d.state === 'progressing' || d.state === 'paused') {
      const pct = d.total ? Math.round(d.received / d.total * 100) : 0
      sub.textContent = `${d.state === 'paused' ? 'Paused · ' : ''}${d.total ? pct + '% · ' + fmtBytes(d.received) + ' of ' + fmtBytes(d.total) : fmtBytes(d.received)}`
      const bar = document.createElement('div'); bar.className = 'dl-bar'; const fill = document.createElement('i'); fill.style.width = pct + '%'; bar.append(fill); info.append(n, sub, bar)
    } else {
      sub.textContent = d.state === 'completed' ? ago(d.doneAt || d.startedAt) : d.state === 'cancelled' ? 'Cancelled' : d.state === 'interrupted' ? 'Failed — interrupted' : d.state
      info.append(n, sub)
    }
    el.append(th, info)
    el.onclick = () => api.send('dl-open', d.id)
    el.oncontextmenu = (e) => { e.preventDefault(); api.send('dl-menu', d.id) }
    el.ondragstart = (e) => { e.preventDefault(); api.send('dl-drag', d.id) }
    return el
  }))
}
api.on('dl-thumb', (id, url) => { thumbs.set(id, url); if (S?.downloadsOpen) renderDownloads() })
setInterval(() => { if (S?.downloadsOpen) renderDownloads() }, 60e3)

// Split view: every pane gets a toolbar in the strip main leaves above its page. Rebuilt only when the
// panes or the sidebar change, updated in place otherwise (a button replaced mid-click loses the click)
const px = (n) => n + 'px'
const bare = (u) => u.replace(/^https?:\/\//, '').replace(/^www\./, '')
let paneRects = null
let paneKey = ''
const paneEls = new Map()
function paneBar (id, first) {
  const el = document.createElement('div'); el.className = 'pane' + (first ? ' first' : ''); el.dataset.id = id
  const btn = (cls, ic, title, fn) => {
    const b = document.createElement('button'); b.className = 'pb ' + cls; b.title = title; setIcon(b, ic)
    b.onclick = (e) => { e.stopPropagation(); fn(b) }
    return b
  }
  const url = document.createElement('button'); url.className = 'purl'; url.append(svg('link'), document.createElement('span'))
  url.onclick = (e) => { e.stopPropagation(); api.send('pane-url', id) }
  const left = document.createElement('div'); left.className = 'grp'
  if (first && !S.sidebarVisible) left.append(btn('side', 'sidebar', 'Show sidebar (⌘S)', () => api.send('toggle-sidebar')))
  left.append(btn('back', 'back', 'Back', () => api.send('pane-nav', id, 'back')), btn('fwd', 'forward', 'Forward', () => api.send('pane-nav', id, 'forward')),
    btn('reload', 'reload', 'Reload', () => api.send('pane-nav', id, 'reload')))
  const right = document.createElement('div'); right.className = 'grp r'
  right.append(btn('site', 'sliders', 'Site controls', (b) => api.send('pane-site', id, rectOf(b))), btn('split', 'split', 'Split view options', () => api.send('pane-menu', id)),
    btn('x', 'close', 'Remove from split view', () => api.send('pane-close', id)))
  const bar = document.createElement('div'); bar.className = 'pbar'; bar.onclick = () => api.send('split-focus', id)
  bar.append(left, url, right); el.append(bar)
  return el
}
function syncPanes () {
  if (FLOAT) return
  const rs = paneRects; const ps = S?.panes
  const on = !!rs && !!ps && ps.length === rs.length && ps.every((p, i) => p.id === rs[i].id)
  const key = on ? ps.map(p => p.id).join(',') + (S.sidebarVisible ? '' : '!') : ''
  if (key !== paneKey) {
    paneKey = key; paneEls.forEach(el => el.remove()); paneEls.clear()
    if (on) { rs.forEach((r, i) => paneEls.set(r.id, paneBar(r.id, i === 0))); $('#panes').prepend(...paneEls.values()) }
  }
  if (!on) return
  ps.forEach((p, i) => {
    const el = paneEls.get(p.id); const r = rs[i]; const at = (c) => el.querySelector(c)
    Object.assign(el.style, { left: px(r.x), top: px(r.y), width: px(r.width), height: px(r.height) })
    el.classList.toggle('active', p.id === S.activeTabId)
    at('.back').disabled = !p.canBack; at('.fwd').disabled = !p.canFwd
    setIcon(at('.reload'), p.loading ? 'stop' : 'reload'); at('.reload').title = p.loading ? 'Stop' : 'Reload'
    at('.purl span').textContent = p.url ? bare(p.url) : 'Search or enter URL…'
    at('.purl').title = `${p.title}\n${p.url}`
  })
}

// Outline the focused pane and put draggable dividers in the gaps between panes
api.on('layout', ({ panes, dir }) => {
  const box = $('#panes'); box.querySelectorAll('.pane-ring,.divider-h').forEach(e => e.remove())
  paneRects = panes; syncPanes()
  if (!panes) return
  panes.forEach((p, i) => {
    const ring = document.createElement('div'); ring.className = 'pane-ring' + (p.active ? ' active' : '')
    Object.assign(ring.style, { left: px(p.x - 2), top: px(p.y - 2), width: px(p.width + 4), height: px(p.height + 4) })
    box.append(ring)
    if (i === panes.length - 1) return
    const d = document.createElement('div'); d.className = 'divider-h ' + dir
    const n = panes[i + 1]
    if (dir === 'col') Object.assign(d.style, { left: px(p.x), width: px(p.width), top: px(p.y + p.height), height: px(n.y - p.y - p.height) })
    else Object.assign(d.style, { left: px(p.x + p.width), width: px(n.x - p.x - p.width), top: px(p.y), height: px(p.height) })
    d.title = 'Drag to resize · double-click to make equal'
    d.onmousedown = (e) => { e.preventDefault(); api.send('split-drag-start', i); follow((ev) => api.send('split-drag', ev.clientX, ev.clientY)) }
    d.ondblclick = () => api.send('split-equalize')
    box.append(d)
  })
})

let lastStateJson = ''
api.on('state', (s) => { const j = JSON.stringify(s); if (j === lastStateJson) return; lastStateJson = j; S = s; render() })
api.on('toast', (msg) => {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg
  $('#toasts').append(t); setTimeout(() => t.remove(), 2600)
})

$('#b-sidebar').onclick = () => api.send('toggle-sidebar')
$('#b-back').onclick = () => api.send('back')
$('#b-fwd').onclick = () => api.send('forward')
$('#b-reload').onclick = () => api.send('reload')
$('#urlbar').onclick = () => api.send('command-bar', 'edit')
$('#b-newtab').onclick = () => api.send('command-bar', 'new')
$('#b-clear').onclick = () => api.send('clear-today')
$('#b-archive').onclick = () => { api.send('dl-toggle'); api.send('dl-thumbs') }
$('#dl-archive').onclick = () => api.send('library')
$('#dl-folder').onclick = () => api.send('dl-folder')
$('#dl-clear').onclick = () => api.send('dl-clear')
$('#b-tidy').onclick = () => api.send('tidy-tabs')
const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
$('#b-site').onclick = (e) => { e.stopPropagation(); api.send('site-controls', rectOf($('#b-site'))) }
$('#b-copy').onclick = (e) => { e.stopPropagation(); api.send('copy-url') }
$('#b-claude').onclick = (e) => { e.stopPropagation(); api.send('toggle-chat') }
$('#b-newspace').onclick = () => api.send('plus-menu', rectOf($('#b-newspace')))
$('#content').ondblclick = () => api.send('command-bar', 'new')

// hidden sidebar: the left edge opens the floating copy over the page; leaving it closes it.
// The floating copy slides out the moment the edge is hovered — main just widens its view.
const peekOn = () => { document.body.classList.add('peek'); api.send('peek', true) }
if (FLOAT) {
  $('#peek-edge').onmouseenter = peekOn
  $('#sidebar').onmouseenter = () => { if (document.body.classList.contains('peek')) api.send('peek', true) }
  $('#sidebar').onmouseleave = () => api.send('peek', false)
  document.documentElement.onmouseleave = () => api.send('peek', false)
  api.on('sidebar-peek', (on) => document.body.classList.toggle('peek', !!on))
} else $('#peek-edge').onmouseenter = () => api.send('peek', true)

// Drags that start here (sidebar edge, split dividers) follow the mouse from this page until release;
// main also lays a shield over the pages so the drag isn't lost when the pointer crosses them
function follow (move) {
  let last = 0
  const mv = (ev) => { const now = performance.now(); if (now - last > 12) { last = now; move(ev) } }
  const up = (ev) => { move(ev); removeEventListener('mousemove', mv); removeEventListener('mouseup', up); api.send('split-drag-end') }
  addEventListener('mousemove', mv); addEventListener('mouseup', up)
}
$('#resizer').onmousedown = (e) => {
  e.preventDefault(); api.send('sidebar-resize-start')
  follow((ev) => api.send('sidebar-width', ev.clientX))
}

// Two-finger swipe across the sidebar steps through the spaces (Arc): the lists follow your fingers, slide
// out past the threshold and come back in from the other side; let go early and they spring back
let swipeX = 0; let swipeDone = false; let swipeIdle = 0
function swipeShift (x, ms) {
  for (const el of [$('#favorites'), $('#scroll')]) {
    el.style.transition = ms ? `transform ${ms}ms ease-out, opacity ${ms}ms ease-out` : 'none'
    el.style.transform = x ? `translateX(${x}px)` : ''
    el.style.opacity = x ? String(Math.max(0, 1 - Math.abs(x) / 160)) : ''
  }
}
$('#sidebar').addEventListener('wheel', (e) => {
  if (!S || S.spaces.length < 2 || e.ctrlKey || !e.deltaX || Math.abs(e.deltaX) < Math.abs(e.deltaY) * 2) return
  clearTimeout(swipeIdle)
  swipeIdle = setTimeout(() => { if (!swipeDone) swipeShift(0, 200); swipeX = 0; swipeDone = false }, 160)
  if (swipeDone) return // one switch per gesture, momentum included
  swipeX += e.deltaX
  const dir = Math.sign(swipeX); const room = !!S.spaces[S.spaces.findIndex(s => s.id === S.activeSpaceId) + dir]
  // no wrap-around: at either end the lists only stretch a little
  if (!room || Math.abs(swipeX) < 90) return swipeShift(-(room ? swipeX * 0.6 : dir * Math.min(40, Math.abs(swipeX) * 0.15)), 0)
  swipeDone = true; api.send('step-space', dir)
  swipeShift(-dir * 130, 180)
  setTimeout(() => { swipeShift(dir * 60, 0); $('#scroll').getBoundingClientRect(); swipeShift(0, 220) }, 180)
}, { passive: true })

setupDropzones()
api.send('ready')
