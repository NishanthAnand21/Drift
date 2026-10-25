'use strict'
const {
  app, BrowserWindow, WebContentsView, Menu, ipcMain, session, dialog, shell,
  clipboard, net, nativeTheme, desktopCapturer, Notification
} = require('electron')
const path = require('path')
const fs = require('fs')
const { Store } = require('./store')
const { isBlockedHost } = require('./blocker')

const isMac = process.platform === 'darwin'
const UI_DIR = path.join(__dirname, '..', 'ui')
const PRELOAD = path.join(__dirname, '..', 'preload', 'ui.js')
const ERROR_PAGE = path.join(__dirname, '..', 'web', 'error.html')

// Sandbox every renderer (skipped only when running as root, e.g. Linux CI containers)
if (process.getuid?.() !== 0) app.enableSandbox()
// Hardening switches
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling')
app.commandLine.appendSwitch('enable-features', 'StrictOriginIsolation')

if (!app.requestSingleInstanceLock()) app.quit()

// ---------------------------------------------------------------- state
const HOUR = 3600e3
const COLORS = ['#7c5cff', '#ff6b8b', '#2bb3a3', '#f5a524', '#3b82f6', '#e5484d', '#8e9196', '#16a34a']
const ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s', suggest: 'https://suggestqueries.google.com/complete/search?client=firefox&q=%s' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s', suggest: 'https://duckduckgo.com/ac/?type=list&q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s', suggest: 'https://api.bing.com/osjson.aspx?query=%s' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s', suggest: 'https://search.brave.com/api/suggest?q=%s' }
}

const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)

const DEFAULTS = {
  version: 1,
  settings: {
    searchEngine: 'google',
    archiveAfterMs: 12 * HOUR,
    blocker: true,
    httpsOnly: true,
    suggestions: true,
    sidebarWidth: 260
  },
  profiles: [{ id: 'default', name: 'Personal', favorites: [] }],
  spaces: [{ id: 'home', name: 'Home', color: COLORS[0], profileId: 'default', pinned: [], today: [], activeTabId: null, split: null }],
  tabs: {},
  archive: [],
  history: [],
  permissions: {},
  activeSpaceId: 'home',
  sidebarVisible: true
}

let store, S
let win = null
let overlay = null // command bar / find bar / prompts
let overlayOpen = null // { mode, ... }
let sidebarPeek = false
let htmlFullscreen = null // tabId in HTML fullscreen
const views = new Map() // tabId -> WebContentsView
const wcToTab = new Map() // webContents.id -> tabId
const live = new Map() // tabId -> { loading, canBack, canFwd, blocked, audible, muted }
const recentlyClosed = []
const downloads = []
const httpFallbackHosts = new Set()
const upgradedHosts = new Set()
const configuredSessions = new Set()
const pending = {} // prompt/pick callbacks

const space = (id = S.activeSpaceId) => S.spaces.find(s => s.id === id)
const profile = (id) => S.profiles.find(p => p.id === id)
const activeTabId = () => space()?.activeTabId || null
const tab = (id) => S.tabs[id]

function locate (tabId) {
  for (const sp of S.spaces) {
    if (sp.pinned.includes(tabId)) return { type: 'pinned', space: sp, list: sp.pinned }
    if (sp.today.includes(tabId)) return { type: 'today', space: sp, list: sp.today }
  }
  for (const p of S.profiles) if (p.favorites.includes(tabId)) return { type: 'favorite', profile: p, list: p.favorites }
  return null
}
function profileIdOfTab (tabId) {
  const loc = locate(tabId)
  if (!loc) return space().profileId
  return loc.space ? loc.space.profileId : loc.profile.id
}
const partitionFor = (profileId) => `persist:profile-${profileId}`

// ---------------------------------------------------------------- url helpers
function normalizeInput (text) {
  const t = text.trim()
  if (!t) return null
  if (/^(https?|about|data|view-source):/i.test(t)) return t
  if (/^localhost(:\d+)?(\/|$)/i.test(t) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(t)) return 'http://' + t
  if (!/\s/.test(t) && /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(t)) return 'https://' + t
  return ENGINES[S.settings.searchEngine].url.replace('%s', encodeURIComponent(t))
}
const isSafeWebUrl = (u) => /^(https?:|about:blank)/i.test(u)

// ---------------------------------------------------------------- sessions & security
const CHROME_UA = () => {
  const v = process.versions.chrome
  const os = isMac ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v.split('.')[0]}.0.0.0 Safari/537.36`
}

const ASK_PERMS = new Set(['media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'clipboard-read', 'display-capture', 'idle-detection', 'serial', 'hid', 'usb', 'window-management', 'storage-access', 'top-level-storage-access', 'speaker-selection', 'keyboardLock'])
const AUTO_ALLOW = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'persistent-storage'])

function originOf (u) { try { return new URL(u).origin } catch { return '' } }

async function askPermission (wc, permission, origin, details) {
  const saved = S.permissions[origin]?.[permission]
  if (saved) return saved === 'allow'
  const what = permission === 'media'
    ? (details?.mediaTypes || []).join(' & ') || 'camera/microphone'
    : permission
  const owner = BrowserWindow.fromWebContents(wc) || win
  const { response, checkboxChecked } = await dialog.showMessageBox(owner, {
    type: 'question',
    buttons: ['Allow', 'Block'],
    defaultId: 1,
    cancelId: 1,
    message: `${new URL(origin).host} wants to use: ${what}`,
    checkboxLabel: 'Remember my decision for this site',
    checkboxChecked: true
  })
  const allow = response === 0
  if (checkboxChecked) {
    S.permissions[origin] = { ...(S.permissions[origin] || {}), [permission]: allow ? 'allow' : 'block' }
    store.save()
  }
  return allow
}

function setupSession (ses) {
  if (configuredSessions.has(ses)) return
  configuredSessions.add(ses)
  ses.setUserAgent(CHROME_UA())

  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    if (AUTO_ALLOW.has(permission)) return cb(true)
    if (permission === 'openExternal') return cb(false) // handled by navigation guard
    if (!ASK_PERMS.has(permission)) return cb(false)
    const origin = originOf(details.requestingUrl || wc.getURL())
    if (!origin.startsWith('https:') && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(origin)) return cb(false)
    askPermission(wc, permission, origin, details).then(cb, () => cb(false))
  })
  ses.setPermissionCheckHandler((wc, permission, origin) => {
    if (AUTO_ALLOW.has(permission)) return true
    return S.permissions[originOf(origin)]?.[permission] === 'allow'
  })
  ses.setDisplayMediaRequestHandler((req, cb) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] })
      .then(sources => cb(sources[0] ? { video: sources[0] } : {}))
      .catch(() => cb({}))
  }, { useSystemPicker: true })

  // Tracker blocking + HTTPS-Only upgrade
  ses.webRequest.onBeforeRequest((details, cb) => {
    let u
    try { u = new URL(details.url) } catch { return cb({}) }
    if (details.resourceType === 'mainFrame') {
      if (S.settings.httpsOnly && u.protocol === 'http:' && !httpFallbackHosts.has(u.host) &&
          !/^(localhost|127\.|10\.|192\.168\.|\[::1\])/.test(u.hostname) && !u.hostname.endsWith('.local')) {
        upgradedHosts.add(u.host)
        u.protocol = 'https:'
        return cb({ redirectURL: u.toString() })
      }
      return cb({})
    }
    if (S.settings.blocker && isBlockedHost(u.hostname)) {
      const tabId = wcToTab.get(details.webContentsId)
      if (tabId && live.get(tabId)) { live.get(tabId).blocked++; pushStateSoon() }
      return cb({ cancel: true })
    }
    cb({})
  })
  // Strip a few tracking headers
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders
    delete h['X-Client-Data']
    cb({ requestHeaders: h })
  })

  ses.on('will-download', (_e, item) => {
    const dir = app.getPath('downloads')
    let name = item.getFilename().replace(/[/\\]/g, '_')
    let target = path.join(dir, name)
    const ext = path.extname(name); const base = path.basename(name, ext)
    for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${base} (${i})${ext}`)
    item.setSavePath(target)
    const d = { id: uid('d'), name: path.basename(target), path: target, received: 0, total: item.getTotalBytes(), state: 'progressing' }
    downloads.unshift(d); downloads.length = Math.min(downloads.length, 30)
    toast(`Downloading ${d.name}`)
    item.on('updated', (_e2, state) => { d.received = item.getReceivedBytes(); d.state = state; pushStateSoon() })
    item.once('done', (_e2, state) => {
      d.state = state; d.received = item.getReceivedBytes()
      if (state === 'completed') {
        toast(`Downloaded ${d.name}`)
        if (isMac) app.dock?.downloadFinished(target)
      } else toast(`Download ${state}: ${d.name}`)
      pushState()
    })
  })
  ses.setSpellCheckerEnabled(true)
}

function getSession (profileId) {
  const ses = session.fromPartition(partitionFor(profileId))
  setupSession(ses)
  return ses
}

// ---------------------------------------------------------------- tab views
function ensureView (tabId) {
  if (views.has(tabId)) return views.get(tabId)
  const t = tab(tabId)
  const ses = getSession(profileIdOfTab(tabId))
  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      safeDialogs: true,
      navigateOnDragDrop: false,
      spellcheck: true
    }
  })
  view.setBackgroundColor('#ffffff')
  if (view.setBorderRadius) view.setBorderRadius(10)
  views.set(tabId, view)
  const wc = view.webContents
  wcToTab.set(wc.id, tabId)
  live.set(tabId, { loading: false, canBack: false, canFwd: false, blocked: 0, audible: false, muted: false, zoom: 0 })
  wireWebContents(tabId, wc)
  const url = t.url && isSafeWebUrl(t.url) ? t.url : 'about:blank'
  wc.loadURL(url).catch(() => {})
  return view
}

function destroyView (tabId) {
  const view = views.get(tabId)
  if (!view) return
  try { win.contentView.removeChildView(view) } catch {}
  wcToTab.delete(view.webContents.id)
  if (!view.webContents.isDestroyed()) view.webContents.close()
  views.delete(tabId)
  live.delete(tabId)
}

function wireWebContents (tabId, wc) {
  const st = () => live.get(tabId)
  const t = () => tab(tabId)
  const updateNav = () => {
    if (!st() || wc.isDestroyed()) return
    st().canBack = wc.navigationHistory.canGoBack()
    st().canFwd = wc.navigationHistory.canGoForward()
    pushStateSoon()
  }
  wc.on('did-start-loading', () => { if (st()) st().loading = true; pushStateSoon() })
  wc.on('did-stop-loading', () => { if (st()) st().loading = false; updateNav() })
  wc.on('did-navigate', (_e, url) => {
    if (url.startsWith('file:')) return updateNav() // our error page
    if (t()) { t().url = url; store.save() }
    if (st()) st().blocked = 0
    addHistory(url, wc.getTitle())
    updateNav()
  })
  wc.on('did-navigate-in-page', (_e, url, isMain) => {
    if (!isMain || !t()) return
    t().url = url; store.save(); addHistory(url, wc.getTitle()); updateNav()
  })
  wc.on('page-title-updated', (_e, title) => {
    if (!t() || wc.getURL().startsWith('file:')) return
    t().title = title; store.save()
    const h = S.history[0]; if (h && h.url === wc.getURL()) h.title = title
    pushStateSoon()
  })
  wc.on('page-favicon-updated', (_e, favs) => {
    if (!t() || !favs[0]) return
    t().favicon = favs.find(f => /^https:|^data:image/.test(f)) || favs[0]; store.save(); pushStateSoon()
  })
  wc.on('media-started-playing', () => { if (st()) { st().audible = true; pushStateSoon() } })
  wc.on('media-paused', () => { if (st()) { st().audible = false; pushStateSoon() } })
  wc.on('focus', () => {
    const sp = space()
    if (sp.split && (sp.split.a === tabId || sp.split.b === tabId) && sp.activeTabId !== tabId) {
      sp.activeTabId = tabId; pushStateSoon()
    }
  })
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return // aborted
    try {
      const u = new URL(url)
      // HTTPS-Only fallback: if an auto-upgraded site has no HTTPS, offer HTTP
      if (u.protocol === 'https:' && S.settings.httpsOnly && upgradedHosts.has(u.host)) {
        return wc.loadFile(ERROR_PAGE, { query: { kind: 'https', url: url.replace(/^https:/, 'http:'), code: String(code), desc } })
      }
    } catch {}
    wc.loadFile(ERROR_PAGE, { query: { kind: 'error', url, code: String(code), desc } })
  })
  wc.on('will-navigate', (e) => guardNavigation(e, e.url, wc))
  wc.on('will-redirect', (e) => {
    if (!/^(https?|about|data):/i.test(e.url)) e.preventDefault()
  })
  wc.on('enter-html-full-screen', () => { htmlFullscreen = tabId; win.setFullScreen(true); layout() })
  wc.on('leave-html-full-screen', () => { htmlFullscreen = null; win.setFullScreen(false); layout() })
  wc.on('found-in-page', (_e, r) => overlay?.webContents.send('find-result', r))
  wc.on('context-menu', (_e, p) => pageContextMenu(tabId, wc, p))
  wc.on('render-process-gone', (_e, d) => {
    if (d.reason !== 'clean-exit') wc.loadFile(ERROR_PAGE, { query: { kind: 'crash', url: t()?.url || '', code: d.reason, desc: '' } })
  })
  wc.on('before-input-event', (e, input) => {
    // Error-page "Continue over HTTP" button signals via title change; nothing else needed here.
    if (input.type === 'keyDown' && input.key === 'Escape' && overlayOpen) { e.preventDefault(); closeOverlay() }
  })
  wc.setWindowOpenHandler(({ url, disposition, features }) => {
    if (!isSafeWebUrl(url)) return { action: 'deny' }
    if (disposition === 'new-window' && features) {
      // Real popups (OAuth, payments) keep window.opener; they run sandboxed in the same profile.
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520, height: 680, parent: win, autoHideMenuBar: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, safeDialogs: true }
        }
      }
    }
    const loc = locate(tabId)
    newTab(url, { spaceId: loc?.space?.id, activate: disposition !== 'background-tab' })
    return { action: 'deny' }
  })
  wc.on('did-create-window', (child) => {
    child.webContents.on('will-navigate', (e) => guardNavigation(e, e.url, child.webContents))
    child.webContents.setWindowOpenHandler(({ url }) => { if (isSafeWebUrl(url)) newTab(url); return { action: 'deny' } })
  })
}

function guardNavigation (e, url, wc) {
  // "Continue to HTTP site" from the HTTPS-Only error page
  if (url.startsWith('http:') && wc.getURL().startsWith('file:') && wc.getURL().includes('kind=https')) {
    try { httpFallbackHosts.add(new URL(url).host) } catch {}
    return
  }
  if (/^(https?|about|data):/i.test(url)) return
  if (url.startsWith('file:') && url.includes('/web/error.html')) return
  e.preventDefault()
  let scheme = ''
  try { scheme = new URL(url).protocol } catch { return }
  if (['javascript:', 'file:', 'chrome:', 'devtools:'].includes(scheme)) return
  dialog.showMessageBox(win, {
    type: 'question', buttons: ['Open', 'Cancel'], defaultId: 1, cancelId: 1,
    message: `Open “${scheme}” link in another application?`, detail: url.slice(0, 300)
  }).then(({ response }) => { if (response === 0) shell.openExternal(url) })
}

function pageContextMenu (tabId, wc, p) {
  const items = []
  if (p.linkURL) {
    items.push(
      { label: 'Open Link in New Tab', click: () => newTab(p.linkURL, { activate: false }) },
      { label: 'Open Link in Split View', click: () => openSplit(p.linkURL) },
      { label: 'Copy Link', click: () => clipboard.writeText(p.linkURL) },
      { type: 'separator' })
  }
  if (p.hasImageContents || p.mediaType === 'image') {
    items.push(
      { label: 'Open Image in New Tab', click: () => newTab(p.srcURL) },
      { label: 'Save Image As…', click: () => wc.downloadURL(p.srcURL) },
      { label: 'Copy Image', click: () => wc.copyImageAt(p.x, p.y) },
      { type: 'separator' })
  }
  if (p.isEditable) {
    for (const s of (p.dictionarySuggestions || []).slice(0, 4)) items.push({ label: s, click: () => wc.replaceMisspelling(s) })
    if (p.misspelledWord) items.push({ type: 'separator' })
    items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' })
  } else if (p.selectionText) {
    const q = p.selectionText.trim().slice(0, 60)
    items.push({ role: 'copy' }, { label: `Search for “${q}”`, click: () => newTab(normalizeInput(q.includes(' ') ? q : q + ' ')) }, { type: 'separator' })
  }
  items.push(
    { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
    { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
    { label: 'Reload', click: () => wc.reload() },
    { type: 'separator' },
    { label: 'Copy Page URL', click: () => copyUrl(tabId) },
    { label: 'Inspect Element', click: () => wc.inspectElement(p.x, p.y) })
  Menu.buildFromTemplate(items).popup({ window: win })
}

// ---------------------------------------------------------------- tab ops
function newTab (url, { spaceId = S.activeSpaceId, activate = true } = {}) {
  const id = uid('t')
  S.tabs[id] = { id, url, title: url, favicon: null, createdAt: Date.now(), lastActiveAt: Date.now() }
  const sp = space(spaceId)
  sp.today.unshift(id)
  if (activate) activateTab(id)
  else { ensureView(id); pushState() }
  store.save()
  return id
}

function activateTab (tabId) {
  if (!tab(tabId)) return
  const loc = locate(tabId)
  if (loc?.space && loc.space.id !== S.activeSpaceId) S.activeSpaceId = loc.space.id
  const sp = space()
  if (sp.split && sp.split.a !== tabId && sp.split.b !== tabId && sp.activeTabId && (sp.activeTabId === sp.split.a || sp.activeTabId === sp.split.b)) {
    // leaving a split keeps it intact; it reappears when either side is activated
  }
  sp.activeTabId = tabId
  tab(tabId).lastActiveAt = Date.now()
  ensureView(tabId)
  layout()
  if (!overlayOpen) views.get(tabId)?.webContents.focus()
  store.save()
  pushState()
}

function closeTab (tabId, { archive = true } = {}) {
  const t = tab(tabId)
  if (!t) return
  const loc = locate(tabId)
  const sp = loc?.space || space()
  if (sp.split && (sp.split.a === tabId || sp.split.b === tabId)) {
    const other = sp.split.a === tabId ? sp.split.b : sp.split.a
    sp.split = null
    if (sp.activeTabId === tabId) sp.activeTabId = other
  }
  if (loc && loc.type !== 'today') {
    // Pinned & favourite tabs are never closed – just unloaded (and reset)
    destroyView(tabId)
    if (t.pinnedUrl) { t.url = t.pinnedUrl }
    for (const s of S.spaces) if (s.activeTabId === tabId) s.activeTabId = pickNeighbor(s, tabId)
  } else {
    const idx = sp.today.indexOf(tabId)
    if (idx >= 0) sp.today.splice(idx, 1)
    destroyView(tabId)
    recentlyClosed.push({ url: t.url, title: t.title, spaceId: sp.id })
    if (archive) archiveEntry(t, sp.id)
    delete S.tabs[tabId]
    if (sp.activeTabId === tabId) sp.activeTabId = sp.today[Math.min(idx, sp.today.length - 1)] || sp.pinned[0] || null
  }
  const now = space().activeTabId
  if (now) activateTab(now); else { layout(); pushState() }
  store.save()
}

function pickNeighbor (sp, tabId) {
  const all = [...profile(sp.profileId).favorites, ...sp.pinned, ...sp.today].filter(id => id !== tabId && views.has(id))
  return all[0] || sp.today[0] || null
}

function archiveEntry (t, spaceId) {
  if (!t.url || t.url === 'about:blank') return
  S.archive.unshift({ url: t.url, title: t.title, favicon: t.favicon, spaceId, archivedAt: Date.now() })
  S.archive.length = Math.min(S.archive.length, 500)
}

function autoArchive () {
  const limit = S.settings.archiveAfterMs
  if (!limit) return
  const now = Date.now()
  let changed = false
  for (const sp of S.spaces) {
    for (const id of [...sp.today]) {
      const t = tab(id)
      if (!t || id === sp.activeTabId) continue
      if (sp.split && (sp.split.a === id || sp.split.b === id)) continue
      if (live.get(id)?.audible) continue
      if (now - (t.lastActiveAt || 0) > limit) {
        sp.today.splice(sp.today.indexOf(id), 1)
        destroyView(id)
        archiveEntry(t, sp.id)
        delete S.tabs[id]
        changed = true
      }
    }
  }
  if (changed) { store.save(); layout(); pushState() }
}

function clearToday () {
  const sp = space()
  for (const id of [...sp.today]) {
    if (sp.split && (sp.split.a === id || sp.split.b === id)) continue
    const t = tab(id); sp.today.splice(sp.today.indexOf(id), 1); destroyView(id); archiveEntry(t, sp.id); delete S.tabs[id]
  }
  if (!tab(sp.activeTabId) || !locate(sp.activeTabId)) sp.activeTabId = pickNeighbor(sp, null)
  if (sp.activeTabId) activateTab(sp.activeTabId); else { layout(); pushState() }
  store.save()
}

function moveTab (tabId, to, { index = -1, spaceId = S.activeSpaceId } = {}) {
  const t = tab(tabId)
  const loc = locate(tabId)
  if (!t || !loc) return
  const sp = space(spaceId)
  const oldProfile = profileIdOfTab(tabId)
  loc.list.splice(loc.list.indexOf(tabId), 1)
  let list
  if (to === 'favorite') list = profile(sp.profileId).favorites
  else if (to === 'pinned') list = sp.pinned
  else list = sp.today
  if (index < 0 || index > list.length) index = to === 'today' && loc.type !== 'today' ? 0 : list.length
  list.splice(index, 0, tabId)
  t.pinnedUrl = to === 'today' ? undefined : (t.pinnedUrl || t.url)
  if (loc.space && loc.space.id !== sp.id && loc.space.activeTabId === tabId) loc.space.activeTabId = pickNeighbor(loc.space, tabId)
  if (loc.space?.split && (loc.space.split.a === tabId || loc.space.split.b === tabId) && loc.space.id !== sp.id) loc.space.split = null
  // crossing profiles requires a fresh view in the new session
  if (oldProfile !== sp.profileId && views.has(tabId)) { destroyView(tabId); if (sp.activeTabId === tabId || S.activeSpaceId === sp.id) ensureView(tabId) }
  store.save(); layout(); pushState()
}

function togglePin (tabId = activeTabId()) {
  const loc = locate(tabId); if (!loc) return
  moveTab(tabId, loc.type === 'pinned' ? 'today' : 'pinned')
}
function toggleFavorite (tabId = activeTabId()) {
  const loc = locate(tabId); if (!loc) return
  moveTab(tabId, loc.type === 'favorite' ? 'today' : 'favorite')
}

function duplicateTab (tabId) { const t = tab(tabId); if (t) newTab(t.url) }

function copyUrl (tabId = activeTabId()) {
  const t = tab(tabId); if (!t) return
  clipboard.writeText(t.url); toast('Copied URL to clipboard')
}

function reopenClosed () {
  const r = recentlyClosed.pop(); if (!r) return
  const ai = S.archive.findIndex(a => a.url === r.url); if (ai >= 0) S.archive.splice(ai, 1)
  newTab(r.url, { spaceId: space(r.spaceId) ? r.spaceId : S.activeSpaceId })
}

function restoreArchived (i) {
  const a = S.archive[i]; if (!a) return
  S.archive.splice(i, 1)
  newTab(a.url)
}

// ---------------------------------------------------------------- split view
function openSplit (urlOrTabId) {
  const sp = space()
  const base = sp.activeTabId
  if (!base) { if (typeof urlOrTabId === 'string' && !tab(urlOrTabId)) newTab(urlOrTabId); return }
  let other = tab(urlOrTabId) ? urlOrTabId : null
  if (!other) {
    other = uid('t')
    S.tabs[other] = { id: other, url: urlOrTabId, title: urlOrTabId, favicon: null, createdAt: Date.now(), lastActiveAt: Date.now() }
    sp.today.splice(Math.max(0, sp.today.indexOf(base) + 1), 0, other)
  }
  if (other === base) return
  sp.split = { a: base, b: other, ratio: 0.5 }
  activateTab(other)
}

function unsplit () {
  const sp = space(); if (!sp.split) return
  sp.split = null; layout(); pushState(); store.save()
}

// ---------------------------------------------------------------- spaces & profiles
function createSpace (name, { newProfile = false } = {}) {
  let profileId = space().profileId
  if (newProfile) {
    profileId = uid('p')
    S.profiles.push({ id: profileId, name, favorites: [] })
  }
  const id = uid('s')
  S.spaces.push({ id, name, color: COLORS[S.spaces.length % COLORS.length], profileId, pinned: [], today: [], activeTabId: null, split: null })
  switchSpace(id)
}

function switchSpace (id) {
  const sp = space(id); if (!sp) return
  S.activeSpaceId = id
  if (sp.activeTabId && tab(sp.activeTabId)) activateTab(sp.activeTabId)
  else { layout(); pushState(); win.webContents.focus() }
  store.save()
}

function deleteSpace (id = S.activeSpaceId) {
  if (S.spaces.length <= 1) return toast('You need at least one space')
  const sp = space(id)
  for (const tid of [...sp.pinned, ...sp.today]) { destroyView(tid); archiveEntry(tab(tid), id); delete S.tabs[tid] }
  S.spaces = S.spaces.filter(s => s.id !== id)
  // drop profiles no space uses any more (keep its data on disk)
  S.profiles = S.profiles.filter(p => p.id === 'default' || S.spaces.some(s => s.profileId === p.id))
  switchSpace(S.spaces[0].id)
}

function stepSpace (dir) {
  const i = S.spaces.findIndex(s => s.id === S.activeSpaceId)
  switchSpace(S.spaces[(i + dir + S.spaces.length) % S.spaces.length].id)
}

// ---------------------------------------------------------------- history
function addHistory (url, title) {
  if (!/^https?:/.test(url)) return
  if (S.history[0]?.url === url) return
  S.history.unshift({ url, title: title || url, t: Date.now() })
  if (S.history.length > 3000) S.history.length = 3000
  store.save()
}

// ---------------------------------------------------------------- layout
const SIDEBAR_MIN = 200; const SIDEBAR_MAX = 420; const PAD = 8
function sidebarShown () { return S.sidebarVisible || sidebarPeek }

function layout () {
  if (!win) return
  const [w, h] = win.getContentSize()
  const sp = space()
  const needed = []
  const act = sp.activeTabId && tab(sp.activeTabId) ? sp.activeTabId : null
  const splitActive = sp.split && act && (sp.split.a === act || sp.split.b === act) && tab(sp.split.a) && tab(sp.split.b)
  if (splitActive) needed.push(sp.split.a, sp.split.b)
  else if (act) needed.push(act)
  if (htmlFullscreen && views.has(htmlFullscreen)) needed.splice(0, needed.length, htmlFullscreen)

  for (const [id, v] of views) if (!needed.includes(id)) { try { win.contentView.removeChildView(v) } catch {} }
  const sw = sidebarShown() ? S.settings.sidebarWidth : 0
  const x0 = sw || PAD
  const area = { x: x0, y: PAD, width: Math.max(100, w - x0 - PAD), height: Math.max(100, h - PAD * 2) }
  needed.forEach((id, i) => {
    const v = ensureView(id)
    win.contentView.addChildView(v)
    if (htmlFullscreen) { v.setBounds({ x: 0, y: 0, width: w, height: h }); v.setBorderRadius?.(0); return }
    v.setBorderRadius?.(10)
    if (needed.length === 2) {
      const gap = 6; const lw = Math.round((area.width - gap) * sp.split.ratio)
      v.setBounds(i === 0 ? { ...area, width: lw } : { ...area, x: area.x + lw + gap, width: area.width - lw - gap })
    } else v.setBounds(area)
  })
  if (overlayOpen) { win.contentView.addChildView(overlay); overlay.setBounds(overlayBounds()) }
  win.webContents.send('layout', { area, splitIds: needed.length === 2 ? needed : null })
}

// ---------------------------------------------------------------- overlay (command bar, find, prompts)
function overlayBounds () {
  const [w, h] = win.getContentSize()
  if (overlayOpen?.mode === 'find') return { x: w - 380, y: 14, width: 360, height: 64 }
  return { x: 0, y: 0, width: w, height: h }
}

function ensureOverlay () {
  if (overlay) return overlay
  overlay = new WebContentsView({
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  overlay.setBackgroundColor('#00000000')
  overlay.webContents.loadFile(path.join(UI_DIR, 'palette.html'))
  overlay.webContents.on('will-navigate', e => e.preventDefault())
  overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return overlay
}

function openOverlay (opts) {
  ensureOverlay()
  overlayOpen = opts
  win.contentView.addChildView(overlay)
  overlay.setBounds(overlayBounds())
  const payload = { ...opts, snapshot: paletteSnapshot() }
  const send = () => { overlay.webContents.send('open', payload); overlay.webContents.focus() }
  if (overlay.webContents.isLoading()) overlay.webContents.once('did-finish-load', send); else send()
}

function closeOverlay () {
  if (!overlayOpen) return
  const wasFind = overlayOpen.mode === 'find'
  overlayOpen = null
  try { win.contentView.removeChildView(overlay) } catch {}
  const wc = views.get(activeTabId())?.webContents
  if (wasFind && wc) wc.stopFindInPage('clearSelection')
  if (wc) wc.focus(); else win.webContents.focus()
}

function commandBar (mode = 'new') {
  const t = tab(activeTabId())
  if (mode === 'edit' && !t) mode = 'new'
  openOverlay({ mode, query: mode === 'edit' ? t.url : '' })
}

function prompt (title, value, cb) {
  const key = uid('k'); pending[key] = cb
  openOverlay({ mode: 'prompt', title, query: value || '', key })
}
function pick (title, items, cb) {
  const key = uid('k'); pending[key] = cb
  openOverlay({ mode: 'pick', title, items, key })
}

function paletteSnapshot () {
  const sp = space()
  const tabs = []
  for (const s of S.spaces) {
    for (const id of [...s.pinned, ...s.today]) { const t = tab(id); if (t) tabs.push({ id, title: t.title, url: t.url, favicon: t.favicon, space: s.name }) }
  }
  for (const id of profile(sp.profileId).favorites) { const t = tab(id); if (t) tabs.push({ id, title: t.title, url: t.url, favicon: t.favicon, space: 'Favorites' }) }
  return {
    tabs,
    history: S.history.slice(0, 1500),
    archive: S.archive.map((a, i) => ({ i, title: a.title, url: a.url, favicon: a.favicon, archivedAt: a.archivedAt })),
    commands: COMMANDS.map(c => ({ id: c.id, title: typeof c.title === 'function' ? c.title() : c.title, keys: c.keys || '' })),
    color: sp.color,
    engine: ENGINES[S.settings.searchEngine].name,
    suggestions: S.settings.suggestions
  }
}

// ---------------------------------------------------------------- commands
const onOff = (b) => (b ? 'On' : 'Off')
const COMMANDS = [
  { id: 'new-tab', title: 'New Tab', keys: '⌘T', run: () => commandBar('new') },
  { id: 'split', title: 'Add Split View', keys: '⌃⇧=', run: () => setTimeout(() => openOverlay({ mode: 'split', query: '' })) },
  { id: 'unsplit', title: 'Separate Split View', keys: '⌃⇧-', run: unsplit },
  { id: 'pin', title: 'Pin / Unpin Tab', keys: '⌘D', run: () => togglePin() },
  { id: 'fav', title: 'Add to / Remove from Favorites', run: () => toggleFavorite() },
  { id: 'copy-url', title: 'Copy URL', keys: '⌘⇧C', run: () => copyUrl() },
  { id: 'reopen', title: 'Reopen Closed Tab', keys: '⌘⇧T', run: reopenClosed },
  { id: 'clear-today', title: 'Archive All Unpinned Tabs', run: clearToday },
  { id: 'archive', title: 'Show Archived Tabs', run: () => setTimeout(() => openOverlay({ mode: 'archive', query: '' })) },
  { id: 'find', title: 'Find in Page', keys: '⌘F', run: () => setTimeout(findInPage) },
  { id: 'sidebar', title: 'Toggle Sidebar', keys: '⌘S', run: toggleSidebar },
  { id: 'new-space', title: 'New Space…', run: () => setTimeout(() => prompt('Name your new space', '', (n) => n && createSpace(n))) },
  { id: 'new-profile-space', title: 'New Space with New Profile…', run: () => setTimeout(() => prompt('Name the new profile & space', '', (n) => n && createSpace(n, { newProfile: true }))) },
  { id: 'rename-space', title: 'Rename Space…', run: () => setTimeout(() => renameSpace()) },
  { id: 'space-color', title: 'Change Space Colour…', run: () => setTimeout(() => pickColor()) },
  { id: 'space-profile', title: 'Change Space Profile…', run: () => setTimeout(() => pickProfile()) },
  { id: 'delete-space', title: 'Delete Space', run: () => confirmDeleteSpace() },
  { id: 'next-space', title: 'Next Space', keys: '⌘⌥→', run: () => stepSpace(1) },
  { id: 'prev-space', title: 'Previous Space', keys: '⌘⌥←', run: () => stepSpace(-1) },
  { id: 'blocker', title: () => `Tracker & Ad Blocking: ${onOff(S.settings.blocker)}`, run: () => { S.settings.blocker = !S.settings.blocker; toast(`Tracker blocking ${onOff(S.settings.blocker)}`); store.save() } },
  { id: 'https', title: () => `HTTPS-Only Mode: ${onOff(S.settings.httpsOnly)}`, run: () => { S.settings.httpsOnly = !S.settings.httpsOnly; toast(`HTTPS-Only ${onOff(S.settings.httpsOnly)}`); store.save() } },
  { id: 'suggest', title: () => `Search Suggestions: ${onOff(S.settings.suggestions)}`, run: () => { S.settings.suggestions = !S.settings.suggestions; store.save() } },
  { id: 'engine', title: () => `Search Engine: ${ENGINES[S.settings.searchEngine].name}…`, run: () => setTimeout(() => pick('Search engine', Object.entries(ENGINES).map(([k, e]) => ({ value: k, title: e.name })), (v) => { S.settings.searchEngine = v; store.save() })) },
  { id: 'archive-time', title: () => `Auto-archive Tabs After: ${archiveLabel(S.settings.archiveAfterMs)}…`, run: () => setTimeout(() => pick('Archive unpinned tabs after', [12, 24, 24 * 7, 24 * 30, 0].map(hrs => ({ value: hrs * HOUR, title: archiveLabel(hrs * HOUR) })), (v) => { S.settings.archiveAfterMs = v; store.save(); autoArchive() })) },
  { id: 'clear-data', title: 'Clear Browsing Data…', run: () => clearBrowsingData() },
  { id: 'reset-perms', title: 'Reset Site Permissions for Current Site', run: () => { const o = originOf(tab(activeTabId())?.url || ''); delete S.permissions[o]; store.save(); toast('Permissions reset') } },
  { id: 'downloads', title: 'Open Downloads Folder', run: () => shell.openPath(app.getPath('downloads')) },
  { id: 'zoom-in', title: 'Zoom In', keys: '⌘+', run: () => zoom(1) },
  { id: 'zoom-out', title: 'Zoom Out', keys: '⌘-', run: () => zoom(-1) },
  { id: 'zoom-reset', title: 'Actual Size', keys: '⌘0', run: () => zoom(0) },
  { id: 'print', title: 'Print…', keys: '⌘P', run: () => views.get(activeTabId())?.webContents.print() },
  { id: 'devtools', title: 'Developer Tools', keys: '⌘⌥I', run: () => views.get(activeTabId())?.webContents.toggleDevTools() },
  { id: 'default-browser', title: 'Make Drift the Default Browser', run: () => { app.setAsDefaultProtocolClient('http'); app.setAsDefaultProtocolClient('https'); toast('Requested default browser') } },
  { id: 'updates', title: 'Check for Updates', run: () => checkForUpdates(true) }
]
function archiveLabel (ms) {
  if (!ms) return 'Never'
  const h = ms / HOUR
  return h < 24 ? `${h} hours` : h === 24 ? '24 hours' : `${h / 24} days`
}
function runCommand (id) { COMMANDS.find(c => c.id === id)?.run() }

function renameSpace (id = S.activeSpaceId) {
  prompt('Rename space', space(id).name, (n) => { if (n) { space(id).name = n; store.save(); pushState() } })
}
function pickColor (id = S.activeSpaceId) {
  pick('Space colour', COLORS.map(c => ({ value: c, title: c, color: c })), (c) => { space(id).color = c; store.save(); pushState() })
}
function pickProfile (id = S.activeSpaceId) {
  const items = [...S.profiles.map(p => ({ value: p.id, title: p.name })), { value: '__new', title: '+ New Profile…' }]
  pick('Profile for this space (separate cookies, logins & favourites)', items, (v) => {
    const set = (pid) => {
      const sp = space(id)
      for (const tid of [...sp.pinned, ...sp.today]) destroyView(tid)
      sp.profileId = pid; store.save(); layout(); if (sp.activeTabId) activateTab(sp.activeTabId); pushState()
    }
    if (v === '__new') setTimeout(() => prompt('Profile name', '', (n) => { if (!n) return; const pid = uid('p'); S.profiles.push({ id: pid, name: n, favorites: [] }); set(pid) }))
    else set(v)
  })
}
async function confirmDeleteSpace (id = S.activeSpaceId) {
  const { response } = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1, message: `Delete space “${space(id).name}”?`, detail: 'Its tabs will be moved to the archive.' })
  if (response === 0) deleteSpace(id)
}
async function clearBrowsingData () {
  const { response } = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Clear', 'Cancel'], defaultId: 1, cancelId: 1, message: 'Clear browsing data for all profiles?', detail: 'This removes history, archive, cookies, cache and site storage. You will be signed out of websites.' })
  if (response !== 0) return
  for (const p of S.profiles) {
    const ses = getSession(p.id)
    await ses.clearStorageData(); await ses.clearCache(); await ses.clearAuthCache()
  }
  S.history = []; S.archive = []; S.permissions = {}; store.save(); toast('Browsing data cleared')
}

function zoom (dir) {
  const wc = views.get(activeTabId())?.webContents; if (!wc) return
  const z = dir === 0 ? 0 : Math.max(-5, Math.min(5, wc.getZoomLevel() + dir * 0.5))
  wc.setZoomLevel(z); toast(`Zoom ${Math.round(Math.pow(1.2, z) * 100)}%`)
}
function findInPage () { if (activeTabId()) openOverlay({ mode: 'find', query: '' }) }
function toggleSidebar () { S.sidebarVisible = !S.sidebarVisible; sidebarPeek = false; store.save(); layout(); pushState() }

function navActive (fn) { const wc = views.get(activeTabId())?.webContents; if (wc) fn(wc) }

function tabContextMenu (tabId) {
  const loc = locate(tabId); if (!loc) return
  const sp = space()
  const others = S.spaces.filter(s => s.id !== S.activeSpaceId)
  const lv = live.get(tabId)
  const tmpl = [
    { label: loc.type === 'favorite' ? 'Remove from Favorites' : 'Add to Favorites', click: () => toggleFavorite(tabId) },
    { label: loc.type === 'pinned' ? 'Unpin Tab' : 'Pin Tab', click: () => moveTab(tabId, loc.type === 'pinned' ? 'today' : 'pinned') },
    { label: 'Open in Split View', enabled: !!sp.activeTabId && sp.activeTabId !== tabId, click: () => openSplit(tabId) },
    { label: 'Duplicate', click: () => duplicateTab(tabId) },
    { label: 'Copy Link', click: () => copyUrl(tabId) },
    { label: lv?.muted ? 'Unmute' : 'Mute', enabled: !!lv, click: () => toggleMute(tabId) }
  ]
  if (tab(tabId).pinnedUrl && loc.type !== 'today') tmpl.push({ label: 'Reset to Pinned URL', click: () => { tab(tabId).url = tab(tabId).pinnedUrl; views.get(tabId)?.webContents.loadURL(tab(tabId).pinnedUrl) } })
  if (others.length) tmpl.push({ label: 'Move to Space', submenu: others.map(s => ({ label: s.name, click: () => moveTab(tabId, loc.type === 'favorite' ? 'today' : loc.type, { spaceId: s.id }) })) })
  tmpl.push({ type: 'separator' }, { label: loc.type === 'today' ? 'Close Tab' : 'Unload Tab', click: () => closeTab(tabId) })
  if (loc.type === 'today') tmpl.push({ label: 'Close Tabs Below', click: () => { const l = sp.today; for (const id of l.slice(l.indexOf(tabId) + 1)) closeTab(id) } })
  Menu.buildFromTemplate(tmpl).popup({ window: win })
}
function spaceContextMenu (id) {
  Menu.buildFromTemplate([
    { label: 'Rename…', click: () => renameSpace(id) },
    { label: 'Change Colour…', click: () => pickColor(id) },
    { label: 'Change Profile…', click: () => pickProfile(id) },
    { type: 'separator' },
    { label: 'Delete Space', enabled: S.spaces.length > 1, click: () => confirmDeleteSpace(id) }
  ]).popup({ window: win })
}
function toggleMute (tabId) {
  const wc = views.get(tabId)?.webContents; const lv = live.get(tabId); if (!wc || !lv) return
  lv.muted = !lv.muted; wc.setAudioMuted(lv.muted); pushState()
}

// ---------------------------------------------------------------- UI state push
let pushTimer = null
function pushStateSoon () { if (!pushTimer) pushTimer = setTimeout(() => { pushTimer = null; pushState() }, 60) }
function pushState () {
  if (!win || win.isDestroyed()) return
  const sp = space()
  const t = (id) => {
    const x = tab(id); if (!x) return null
    const l = live.get(id)
    return { id, title: x.title, url: x.url, favicon: x.favicon, loaded: !!l, loading: l?.loading, audible: l?.audible, muted: l?.muted }
  }
  const act = sp.activeTabId; const l = live.get(act)
  win.webContents.send('state', {
    spaces: S.spaces.map(s => ({ id: s.id, name: s.name, color: s.color, profile: profile(s.profileId)?.name })),
    activeSpaceId: S.activeSpaceId,
    favorites: profile(sp.profileId).favorites.map(t).filter(Boolean),
    pinned: sp.pinned.map(t).filter(Boolean),
    today: sp.today.map(t).filter(Boolean),
    activeTabId: act,
    split: sp.split,
    sidebarVisible: S.sidebarVisible,
    sidebarPeek,
    sidebarWidth: S.settings.sidebarWidth,
    nav: { canBack: l?.canBack, canFwd: l?.canFwd, loading: l?.loading, url: tab(act)?.url || '', blocked: l?.blocked || 0 },
    settings: { blocker: S.settings.blocker, httpsOnly: S.settings.httpsOnly },
    downloads: downloads.slice(0, 5),
    isMac,
    fullscreen: win.isFullScreen()
  })
}
function toast (msg) { win?.webContents.send('toast', msg) }

// ---------------------------------------------------------------- IPC (only from our own UI views)
const isOurUI = (e) => e.sender === win?.webContents || e.sender === overlay?.webContents
const ACTIONS = {
  ready: () => { pushState(); layout() },
  activate: (id) => activateTab(id),
  close: (id) => closeTab(id),
  'tab-menu': (id) => tabContextMenu(id),
  'space-menu': (id) => spaceContextMenu(id),
  'switch-space': (id) => switchSpace(id),
  'new-space': () => prompt('Name your new space', '', (n) => n && createSpace(n)),
  move: (id, to, index, spaceId) => moveTab(id, to, { index, spaceId: spaceId || S.activeSpaceId }),
  'command-bar': (mode) => commandBar(mode),
  back: () => navActive(wc => wc.navigationHistory.goBack()),
  forward: () => navActive(wc => wc.navigationHistory.goForward()),
  reload: () => navActive(wc => wc.isLoading() ? wc.stop() : wc.reload()),
  'toggle-sidebar': toggleSidebar,
  'sidebar-width': (w) => { S.settings.sidebarWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(w))); layout(); pushStateSoon(); store.save() },
  peek: (on) => { if (S.sidebarVisible) return; sidebarPeek = !!on; layout(); pushState() },
  'clear-today': clearToday,
  'split-ratio': (r) => { const sp = space(); if (sp.split) { sp.split.ratio = Math.max(0.2, Math.min(0.8, r)); layout(); store.save() } },
  unsplit,
  mute: (id) => toggleMute(id),
  'open-download': (p) => { if (downloads.some(d => d.path === p)) shell.showItemInFolder(p) },
  'show-archive': () => openOverlay({ mode: 'archive', query: '' }),
  // overlay → main
  'overlay-close': closeOverlay,
  'palette-submit': (r) => {
    const mode = overlayOpen?.mode
    closeOverlay()
    if (!r) return
    if (r.type === 'command') return runCommand(r.id)
    if (r.type === 'archive') return restoreArchived(r.i)
    if (r.type === 'tab' && mode !== 'split') return activateTab(r.id)
    const url = r.type === 'tab' ? r.id : (r.url || normalizeInput(r.text || ''))
    if (!url || (!isSafeWebUrl(url) && !tab(url))) return
    if (mode === 'split') return openSplit(url)
    if (mode === 'edit' && activeTabId()) {
      tab(activeTabId()).url = url
      return views.get(activeTabId()) ? views.get(activeTabId()).webContents.loadURL(url).catch(() => {}) : activateTab(activeTabId())
    }
    newTab(url)
  },
  'prompt-result': (key, value) => { closeOverlay(); const cb = pending[key]; delete pending[key]; if (cb && value != null) cb(value) },
  find: (text, opts) => { const wc = views.get(activeTabId())?.webContents; if (!wc) return; if (!text) wc.stopFindInPage('clearSelection'); else wc.findInPage(text, opts) }
}
ipcMain.on('ui', (e, action, ...args) => {
  if (!isOurUI(e) || !Object.hasOwn(ACTIONS, action)) return
  try { ACTIONS[action](...args) } catch (err) { console.error(action, err) }
})
ipcMain.handle('suggest', async (e, q) => {
  if (!isOurUI(e) || !S.settings.suggestions || typeof q !== 'string' || !q.trim() || q.length > 200) return []
  try {
    const res = await net.fetch(ENGINES[S.settings.searchEngine].suggest.replace('%s', encodeURIComponent(q)), { signal: AbortSignal.timeout(1500) })
    const j = await res.json()
    const list = Array.isArray(j) ? (Array.isArray(j[1]) ? j[1] : j.map(x => x.phrase || x)) : []
    return list.filter(x => typeof x === 'string').slice(0, 5)
  } catch { return [] }
})
ipcMain.handle('normalize', (e, q) => (isOurUI(e) ? normalizeInput(q) : null))

// ---------------------------------------------------------------- menu & shortcuts
function buildMenu () {
  const tabNums = Array.from({ length: 9 }, (_, i) => ({
    label: `Tab ${i + 1}`, accelerator: `CmdOrCtrl+${i + 1}`, visible: false,
    click: () => {
      const sp = space(); const list = [...profile(sp.profileId).favorites, ...sp.pinned, ...sp.today]
      const id = i === 8 ? list[list.length - 1] : list[i]; if (id) activateTab(id)
    }
  }))
  const spaceNums = Array.from({ length: 9 }, (_, i) => ({ label: `Space ${i + 1}`, accelerator: `Ctrl+${i + 1}`, visible: false, click: () => S.spaces[i] && switchSpace(S.spaces[i].id) }))
  const tmpl = [
    ...(isMac ? [{ label: 'Drift', submenu: [{ role: 'about' }, { label: 'Check for Updates…', click: () => checkForUpdates(true) }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => commandBar('new') },
        { label: 'Open Location', accelerator: 'CmdOrCtrl+L', click: () => commandBar('edit') },
        { label: 'Command Bar', accelerator: 'CmdOrCtrl+K', click: () => commandBar('new'), visible: false },
        { label: 'New Space…', accelerator: 'CmdOrCtrl+Shift+N', click: () => runCommand('new-space') },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: reopenClosed },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => { if (overlayOpen) return closeOverlay(); activeTabId() ? closeTab(activeTabId()) : null } },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => runCommand('print') },
        ...(isMac ? [] : [{ role: 'quit' }])
      ]
    },
    {
      label: 'Edit',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'selectAll' }, { type: 'separator' },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: findInPage },
        { label: 'Copy URL', accelerator: 'CmdOrCtrl+Shift+C', click: () => copyUrl() }]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+S', click: toggleSidebar },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => navActive(wc => wc.reload()) },
        { label: 'Hard Reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => navActive(wc => wc.reloadIgnoringCache()) },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => zoom(1) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => zoom(-1) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => zoom(0) },
        { type: 'separator' },
        { label: 'Add Split View', accelerator: 'Ctrl+Shift+=', click: () => runCommand('split') },
        { label: 'Separate Split View', accelerator: 'Ctrl+Shift+-', click: unsplit },
        { type: 'separator' },
        { label: 'Developer Tools', accelerator: isMac ? 'Cmd+Alt+I' : 'Ctrl+Shift+I', click: () => runCommand('devtools') },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Tabs',
      submenu: [
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => ACTIONS.back() },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => ACTIONS.forward() },
        { label: 'Pin / Unpin Tab', accelerator: 'CmdOrCtrl+D', click: () => togglePin() },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => stepTab(1) },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => stepTab(-1) },
        { label: 'Next Space', accelerator: 'CmdOrCtrl+Alt+Right', click: () => stepSpace(1) },
        { label: 'Previous Space', accelerator: 'CmdOrCtrl+Alt+Left', click: () => stepSpace(-1) },
        { label: 'Show Archive', accelerator: 'CmdOrCtrl+Shift+A', click: () => runCommand('archive') },
        ...tabNums, ...spaceNums
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(tmpl))
}
function stepTab (dir) {
  const sp = space(); const list = [...profile(sp.profileId).favorites, ...sp.pinned, ...sp.today]
  if (!list.length) return
  const i = list.indexOf(sp.activeTabId)
  activateTab(list[(i + dir + list.length) % list.length])
}

// ---------------------------------------------------------------- updates
let autoUpdater = null
function checkForUpdates (manual = false) {
  if (!app.isPackaged) { if (manual) toast('Updates are checked in packaged builds only'); return }
  try {
    if (!autoUpdater) {
      autoUpdater = require('electron-updater').autoUpdater
      autoUpdater.autoDownload = true
      autoUpdater.autoInstallOnAppQuit = true
      autoUpdater.on('update-downloaded', (info) => {
        dialog.showMessageBox(win, { type: 'info', buttons: ['Restart Now', 'Later'], message: `Drift ${info.version} is ready`, detail: 'Restart to apply the update (includes the latest Chromium security fixes).' })
          .then(({ response }) => { if (response === 0) { store.saveNow(); autoUpdater.quitAndInstall() } })
      })
      autoUpdater.on('update-not-available', () => manual && toast('Drift is up to date'))
      autoUpdater.on('error', (e) => manual && toast('Update check failed: ' + e.message))
    }
    autoUpdater.checkForUpdates()
  } catch (e) { if (manual) toast('Update check failed') }
}

// ---------------------------------------------------------------- window
function createWindow () {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 640,
    minHeight: 420,
    show: false,
    title: 'Drift',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 18 },
    vibrancy: isMac ? 'sidebar' : undefined,
    visualEffectState: 'followWindow',
    backgroundColor: isMac ? '#00000000' : (nativeTheme.shouldUseDarkColors ? '#1c1b22' : '#efeaf9'),
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false }
  })
  win.loadFile(path.join(UI_DIR, 'index.html'))
  win.webContents.on('will-navigate', e => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.once('ready-to-show', () => win.show())
  win.on('resize', layout)
  win.on('enter-full-screen', pushState)
  win.on('leave-full-screen', () => { if (htmlFullscreen) navActive(wc => wc.executeJavaScript('document.fullscreenElement && document.exitFullscreen()').catch(() => {})); pushState() })
  win.on('close', () => store.saveNow())
  win.on('closed', () => { win = null; overlay = null; views.clear(); wcToTab.clear(); live.clear() })
  // restore the active tab
  const sp = space()
  if (sp.activeTabId && tab(sp.activeTabId)) ensureView(sp.activeTabId)
  ensureOverlay()
}

function sanitizeState () {
  // drop dangling tab references from older/corrupted state
  const seen = new Set()
  const clean = (list) => list.filter(id => S.tabs[id] && !seen.has(id) && seen.add(id))
  for (const p of S.profiles) p.favorites = clean(p.favorites || [])
  for (const sp of S.spaces) {
    sp.pinned = clean(sp.pinned || []); sp.today = clean(sp.today || [])
    if (!profile(sp.profileId)) sp.profileId = 'default'
    if (sp.split && !(seen.has(sp.split.a) && seen.has(sp.split.b))) sp.split = null
  }
  for (const id of Object.keys(S.tabs)) if (!seen.has(id)) delete S.tabs[id]
  if (!space()) S.activeSpaceId = S.spaces[0].id
  for (const sp of S.spaces) if (sp.activeTabId && !seen.has(sp.activeTabId)) sp.activeTabId = null
}

let pendingOpenUrls = []
app.on('open-url', (e, url) => { e.preventDefault(); if (win && S) newTab(url); else pendingOpenUrls.push(url) })
app.on('second-instance', (_e, argv) => {
  const url = argv.find(a => /^https?:\/\//.test(a)); if (url && S) newTab(url)
  if (win) { if (win.isMinimized()) win.restore(); win.focus() }
})

// Never allow any webContents to create a <webview> or get node access
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault())
})

app.whenReady().then(() => {
  store = new Store(path.join(app.getPath('userData'), 'drift-state.json'), DEFAULTS)
  S = store.state
  sanitizeState()
  if (!Object.keys(S.tabs).length && !S.history.length) {
    // first run: a couple of sensible favourites
    for (const u of ['https://www.google.com', 'https://www.youtube.com', 'https://github.com']) {
      const id = uid('t'); S.tabs[id] = { id, url: u, pinnedUrl: u, title: new URL(u).host, favicon: null, lastActiveAt: Date.now() }
      S.profiles[0].favorites.push(id)
    }
  }
  buildMenu()
  createWindow()
  const cli = process.argv.slice(1).filter(a => /^https?:\/\//.test(a))
  for (const u of [...pendingOpenUrls, ...cli]) newTab(u)
  setInterval(autoArchive, 60e3)
  autoArchive()
  setTimeout(() => checkForUpdates(false), 10e3)
  setInterval(() => checkForUpdates(false), 4 * HOUR)
  app.on('activate', () => { if (!win) createWindow() })
})

app.on('window-all-closed', () => { if (!isMac) app.quit() })
app.on('before-quit', () => store?.saveNow())

// test hook: DRIFT_SELFTEST=1 runs a scripted smoke test then exits
if (process.env.DRIFT_SELFTEST) require('./selftest')({ app, get win () { return win }, get S () { return S }, newTab, activateTab, openSplit, togglePin, toggleFavorite, createSpace, switchSpace, closeTab, autoArchive, views, live, layout, commandBar, closeOverlay, runCommand, ACTIONS, tab, space, get overlayOpen () { return overlayOpen }, get overlay () { return overlay } })
