'use strict'
const $ = (s) => document.querySelector(s)
const api = window.drift
let S = null
let dragId = null
let pendingRender = false

const host = (u) => { try { return new URL(u).host.replace(/^www\./, '') } catch { return u } }
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
  el.className = 'row' + (t.id === S.activeTabId ? ' active' : '') + (t.loaded ? '' : ' unloaded') + (t.loading ? ' loading' : '') +
    (S.split && S.split.ids.includes(t.id) ? ' split' : '')
  el.draggable = true; el.dataset.id = t.id; el.dataset.zone = zone
  el.title = `${t.title}\n${t.url}`
  el.append(icon(t))
  const title = document.createElement('span'); title.className = 't'; title.textContent = t.title || host(t.url); el.append(title)
  if (t.audible || t.muted) {
    const s = document.createElement('button'); s.className = 'snd'; s.textContent = t.muted ? '🔇' : '🔊'
    s.onclick = (e) => { e.stopPropagation(); api.send('mute', t.id) }; el.append(s)
  }
  const x = document.createElement('button'); x.className = 'x'; x.textContent = zone === 'today' ? '✕' : '—'
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

function clearDrop () { document.querySelectorAll('.over,.drop-before,.sp.drop').forEach(e => e.classList.remove('over', 'drop-before', 'drop')) }

function setupDropzones () {
  document.querySelectorAll('.dropzone').forEach(z => {
    z.ondragover = (e) => {
      if (!dragId) return
      e.preventDefault(); clearDrop(); z.classList.add('over')
      const target = e.target.closest('[data-id]'); if (target && target.dataset.id !== dragId) target.classList.add('drop-before')
    }
    z.ondragleave = (e) => { if (!z.contains(e.relatedTarget)) z.classList.remove('over') }
    z.ondrop = (e) => {
      e.preventDefault()
      if (!dragId) return
      const items = [...z.querySelectorAll('[data-id]')].map(n => n.dataset.id).filter(id => id !== dragId)
      const target = e.target.closest('[data-id]')
      const index = target && target.dataset.id !== dragId ? items.indexOf(target.dataset.id) : items.length
      api.send('move', dragId, z.dataset.zone, index)
      dragId = null; clearDrop()
    }
  })
}

function render () {
  if (!S) return
  if (dragId) { pendingRender = true; return }
  pendingRender = false
  const sp = S.spaces.find(s => s.id === S.activeSpaceId)
  document.documentElement.style.setProperty('--space', sp.color)
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
  $('#b-reload').textContent = S.nav.loading ? '✕' : '↻'
  $('#url-text').textContent = S.nav.url ? host(S.nav.url) : 'Search or enter URL…'
  $('#blocked').textContent = S.nav.blocked ? String(S.nav.blocked) : ''
  document.body.classList.toggle('tidy', !!S.tidyTabs && S.today.length > 6)
  document.body.classList.toggle('chat', !!S.chatOpen)

  $('#favorites').replaceChildren(...S.favorites.map(favTile))
  const nm = $('#space-name'); nm.textContent = sp.name
  if (sp.profile && S.spaces.some(s => s.profile !== sp.profile)) { const p = document.createElement('span'); p.textContent = sp.profile; nm.append(p) }
  nm.oncontextmenu = (e) => { e.preventDefault(); api.send('space-menu', sp.id) }
  $('#pinned').replaceChildren(...S.pinned.map(t => tabRow(t, 'pinned')))
  $('#today').replaceChildren(...S.today.map(t => tabRow(t, 'today')))

  $('#spaces').replaceChildren(...S.spaces.map(s => {
    const b = document.createElement('button'); b.className = 'sp' + (s.id === S.activeSpaceId ? ' active' : '')
    b.style.setProperty('--c', s.color); b.title = s.name + (s.profile ? ` · ${s.profile}` : '')
    b.append(document.createElement('i'))
    b.onclick = () => api.send('switch-space', s.id)
    b.oncontextmenu = (e) => { e.preventDefault(); api.send('space-menu', s.id) }
    b.ondragover = (e) => { if (dragId) { e.preventDefault(); clearDrop(); b.classList.add('drop') } }
    b.ondrop = (e) => { e.preventDefault(); if (dragId) api.send('move', dragId, 'today', 0, s.id); dragId = null; clearDrop() }
    return b
  }))

  $('#downloads').replaceChildren(...S.downloads.slice(0, 3).map(d => {
    const el = document.createElement('div'); el.className = 'dl'
    const pct = d.total ? Math.round(d.received / d.total * 100) + '%' : ''
    el.textContent = `⤓ ${d.name} ${d.state === 'progressing' ? pct : d.state === 'completed' ? '' : '· ' + d.state}`
    el.onclick = () => api.send('open-download', d.path)
    return el
  }))
}

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
$('#b-archive').onclick = () => api.send('library')
$('#b-tidy').onclick = () => api.send('tidy-tabs')
$('#b-claude').onclick = () => api.send('toggle-chat')
$('#shield').onclick = (e) => { e.stopPropagation(); api.send('inspect') }
$('#b-newspace').onclick = () => api.send('new-space')
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
