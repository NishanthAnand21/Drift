'use strict'
const $ = (s) => document.querySelector(s)
const api = window.drift
let S = null
let dragId = null
let pendingRender = false

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

function folderRow (f) {
  const wrap = document.createElement('div'); wrap.className = 'folder' + (f.open ? ' open' : '')
  const head = document.createElement('div'); head.className = 'row frow'; head.dataset.folder = f.id; head.draggable = true
  const chev = document.createElement('span'); chev.className = 'chev'; chev.append(svg('chevron'))
  head.append(chev, svg(f.open ? 'folderOpen' : 'folder'))
  const name = document.createElement('span'); name.className = 't'; name.textContent = f.name; head.append(name)
  head.onclick = () => api.send('toggle-folder', f.id)
  head.oncontextmenu = (e) => { e.preventDefault(); api.send('folder-menu', f.id) }
  head.ondragstart = (e) => { dragFolder = f.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', f.name) }
  head.ondragend = () => { dragFolder = null; clearDrop(); if (pendingRender) render() }
  // dropping a tab on the folder header puts it inside
  head.ondragover = (e) => { if (dragId) { e.preventDefault(); e.stopPropagation(); clearDrop(); head.classList.add('over') } }
  head.ondrop = (e) => { e.preventDefault(); e.stopPropagation(); if (dragId) api.send('move', dragId, 'folder', -1, null, f.id); dragId = null; clearDrop() }
  const kids = document.createElement('div'); kids.className = 'kids dropzone'; kids.dataset.zone = 'folder'; kids.dataset.folder = f.id
  if (f.open) kids.append(...f.items.map(t => tabRow(t, 'pinned')))
  bindZone(kids)
  wrap.append(head, kids)
  return wrap
}
let dragFolder = null

function clearDrop () { document.querySelectorAll('.over,.drop-before,.sp.drop').forEach(e => e.classList.remove('over', 'drop-before', 'drop')) }

function bindZone (z) {
    z.ondragover = (e) => {
      if (dragFolder && z.dataset.zone === 'pinned') { e.preventDefault(); clearDrop(); z.classList.add('over'); return }
      if (!dragId) return
      e.preventDefault(); clearDrop(); z.classList.add('over')
      const target = e.target.closest('[data-id]'); if (target && target.dataset.id !== dragId) target.classList.add('drop-before')
    }
    z.ondragleave = (e) => { if (!z.contains(e.relatedTarget)) z.classList.remove('over') }
    z.ondrop = (e) => {
      e.preventDefault(); e.stopPropagation()
      // only this zone's own entries count (tabs, and folders in the pinned list) — not tabs inside nested folders
      const own = [...z.children].map(n => n.matches('.folder') ? n.firstChild : n).filter(n => n.dataset.id || n.dataset.folder)
      const key = (n) => n.dataset.id || n.dataset.folder
      const target = [...own].find(n => n.contains(e.target))
      if (dragFolder) {
        const ids = own.map(key).filter(k => k !== dragFolder)
        api.send('move-folder', dragFolder, target ? Math.max(0, ids.indexOf(key(target))) : ids.length)
        dragFolder = null; clearDrop(); return
      }
      if (!dragId) return
      const ids = own.map(key).filter(k => k !== dragId)
      const index = target && key(target) !== dragId ? ids.indexOf(key(target)) : ids.length
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
  document.body.classList.toggle('peek', !!S.sidebarPeek)
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
  document.body.classList.toggle('tidy', !!S.tidyTabs && S.today.length > 6)
  document.body.classList.toggle('chat', !!S.chatOpen)

  $('#favorites').replaceChildren(...S.favorites.map(favTile))
  $('#space-icon').textContent = sp.icon || ''
  $('#space-name').textContent = sp.name
  $('#space-profile').textContent = sp.profile && S.spaces.some(s => s.profile !== sp.profile) ? sp.profile : ''
  $('#space-head').oncontextmenu = (e) => { e.preventDefault(); api.send('space-menu', sp.id) }
  $('#space-head').ondblclick = () => api.send('space-edit', sp.id)
  $('#pinned').replaceChildren(...S.pinned.map(t => t.folder ? folderRow(t) : tabRow(t, 'pinned')))
  $('#today').replaceChildren(...S.today.map(t => tabRow(t, 'today')))

  $('#spaces').replaceChildren(...S.spaces.map(s => {
    const b = document.createElement('button'); b.className = 'sp' + (s.id === S.activeSpaceId ? ' active' : '')
    b.title = s.name + (s.profile ? ` · ${s.profile}` : '')
    if (s.icon) b.textContent = s.icon; else b.append(document.createElement('i'))
    b.onclick = () => api.send('switch-space', s.id)
    b.oncontextmenu = (e) => { e.preventDefault(); api.send('space-menu', s.id) }
    b.ondragover = (e) => { if (dragId) { e.preventDefault(); clearDrop(); b.classList.add('drop') } }
    b.ondrop = (e) => { e.preventDefault(); if (dragId) api.send('move', dragId, 'today', 0, s.id); dragId = null; clearDrop() }
    return b
  }))

  const running = S.downloads.filter(d => d.state === 'progressing' || d.state === 'paused').length
  $('#dl-badge').textContent = running ? String(running) : ''
  document.body.classList.toggle('dl-open', !!S.downloadsOpen)
  setIcon($('#b-newspace'), S.popoverOpen === 'menu' ? 'close' : 'plus')
  if (S.downloadsOpen) renderDownloads()
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

// Split view: outline the focused pane and put draggable dividers in the gaps between panes
api.on('layout', ({ panes, dir }) => {
  const box = $('#panes'); box.replaceChildren()
  if (!panes) return
  const px = (n) => n + 'px'
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
    d.onmousedown = (e) => { e.preventDefault(); api.send('split-drag-start', i) }
    d.ondblclick = () => api.send('split-equalize')
    box.append(d)
  })
})

api.on('state', (s) => { S = s; render() })
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

// sidebar peek when collapsed
$('#peek-edge').onmouseenter = () => api.send('peek', true)
$('#sidebar').onmouseleave = () => { if (S && !S.sidebarVisible) api.send('peek', false) }

// sidebar resizing
$('#resizer').onmousedown = (e) => {
  e.preventDefault()
  const move = (ev) => api.send('sidebar-width', ev.clientX)
  const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up) }
  addEventListener('mousemove', move); addEventListener('mouseup', up)
}

setupDropzones()
api.send('ready')
