'use strict'
const {
  app, BrowserWindow, WebContentsView, Menu, ipcMain, session, dialog, shell,
  clipboard, net, nativeTheme, desktopCapturer, globalShortcut, nativeImage
} = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')
const { Store } = require('./store')
const { isBlockedHost } = require('./blocker')
const { createPasswords } = require('./passwords')
const sync = require('./sync')
const adblock = require('./adblock')
const inspector = require('./inspector')
const { startMcp } = require('./mcp')
const { createClaudeChat, MODELS: CLAUDE_MODELS } = require('./claude')

const isMac = process.platform === 'darwin'
const UI_DIR = path.join(__dirname, '..', 'ui')
const PRELOAD = path.join(__dirname, '..', 'preload', 'ui.js')
const MAIN_PRELOAD = path.join(__dirname, '..', 'preload', 'ui-main.js')
const WEB_PRELOAD = path.join(__dirname, '..', 'preload', 'web.js')
const ERROR_PAGE = path.join(__dirname, '..', 'web', 'error.html')

// Sandbox every renderer (skipped only when running as root, e.g. Linux CI containers)
if (process.getuid?.() !== 0) app.enableSandbox()
// Hardening switches
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling')
app.commandLine.appendSwitch('enable-features', 'StrictOriginIsolation')

// Private windows run as a separate process with throw-away, in-memory storage
const PRIVATE = process.argv.includes('--drift-private')
const LATE_ACTIONS = {} // UI actions declared next to their feature; merged into ACTIONS below
let privateDir = null
if (PRIVATE) {
  privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-private-'))
  app.setPath('userData', privateDir)
  app.setName('Drift Private')
} else if (!app.requestSingleInstanceLock()) app.quit()

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
    sidebarWidth: 260,
    autoUpdate: true,
    warnBeforeQuit: true,
    restoreSession: true,
    strictBlocking: false,
    proxyMode: 'system',
    proxyRules: '',
    proxyBypass: '',
    proxyPac: '',
    downloadMode: 'downloads',
    downloadDir: null,
    memorySaverMs: 30 * 60e3,
    tidyTabs: true,
    instantLinks: true,
    tidyTitles: true,
    tidyDownloads: true,
    aiInCommandBar: true,
    aiProvider: 'claude',
    miniHotkey: true,
    miniForExternal: false,
    peekShift: true,
    peekFromPinned: true,
    pipOnLeave: true,
    pipOnAppSwitch: true,
    boostsEnabled: true,
    icon: 'aurora',
    mcpEnabled: false,
    claudeMode: 'account',
    claudeModel: 'claude-opus-5-5',
    claudeEffort: 'medium',
    mcpReadPages: false
  },
  boosts: {},
  profiles: [{ id: 'default', name: 'Personal', favorites: [] }],
  spaces: [{ id: 'home', name: 'Home', color: COLORS[0], profileId: 'default', pinned: [], today: [], activeTabId: null, split: null }],
  tabs: {},
  archive: [],
  history: [],
  permissions: {},
  activeSpaceId: 'home',
  sidebarVisible: true,
  sync: { enabled: false, folder: null, deviceId: null, keyEnc: null, tombstones: {}, lastSyncAt: 0 }
}
if (PRIVATE) Object.assign(DEFAULTS.spaces[0], { name: 'Private', color: '#55525e' })

let store, S, passwords
const extensionsBySession = new Map() // session -> ElectronChromeExtensions
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
// Split view: up to 4 tabs side by side ('row') or stacked ('col'); sizes are fractions summing to 1
const MAX_SPLIT = 4
const inSplit = (sp, id) => !!sp?.split && sp.split.ids.includes(id)

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
const partitionFor = (profileId) => (PRIVATE ? `private-${profileId}` : `persist:profile-${profileId}`)

// ---------------------------------------------------------------- url helpers
function normalizeInput (text) {
  const t = text.trim()
  if (!t) return null
  if (/^(https?|about|data|view-source):/i.test(t)) return t
  if (/^localhost(:\d+)?(\/|$)/i.test(t) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(t)) return 'http://' + t
  if (!/\s/.test(t) && /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(t)) return 'https://' + t
  return ENGINES[S.settings.searchEngine].url.replace('%s', encodeURIComponent(t))
}
const isSafeWebUrl = (u) => /^(https?:|about:blank|chrome-extension:)/i.test(u)

// ---------------------------------------------------------------- sessions & security
const CHROME_UA = () => {
  const v = process.versions.chrome
  const os = isMac ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v.split('.')[0]}.0.0.0 Safari/537.36`
}

const ASK_PERMS = new Set(['media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'clipboard-read', 'display-capture', 'idle-detection', 'serial', 'hid', 'usb', 'window-management', 'storage-access', 'top-level-storage-access', 'speaker-selection', 'keyboardLock'])
const AUTO_ALLOW = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'persistent-storage'])

// Icon for tabs that haven't loaded yet: the site's standard /favicon.ico (HTTPS only)
function iconFor (t) {
  if (t.favicon) return t.favicon
  try { const u = new URL(t.url); return u.protocol === 'https:' ? u.origin + '/favicon.ico' : null } catch { return null }
}
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

function setupSession (ses, { extensions = true } = {}) {
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
    if (S.settings.blocker) {
      const tabId = wcToTab.get(details.webContentsId)
      const verdict = adblock.match(details, tab(tabId)?.url) || (isBlockedHost(u.hostname) ? { cancel: true } : null)
      if (verdict) {
        if (tabId && live.get(tabId)) { live.get(tabId).blocked++; pushStateSoon() }
        return cb(verdict)
      }
    }
    cb({})
  })
  ses.webRequest.onHeadersReceived((details, cb) => { inspector.recordResponse(details); cb({}) })
  ses.webRequest.onCompleted((details) => inspector.recordIp(details))
  ses.setCertificateVerifyProc((req, cb) => { inspector.recordCert(req); cb(-3) })
  applyProxy(ses)
  // Strip a few tracking headers
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders
    delete h['X-Client-Data']
    cb({ requestHeaders: h })
  })

  ses.on('will-download', (_e, item, wc) => {
    const dir = S.settings.downloadMode === 'custom' && S.settings.downloadDir && fs.existsSync(S.settings.downloadDir) ? S.settings.downloadDir : app.getPath('downloads')
    let name = item.getFilename().replace(/[/\\]/g, '_')
    const tidied = S.settings.tidyDownloads ? tidyDownloadName(name, wc && !wc.isDestroyed() ? (tab(wcToTab.get(wc.id))?.title || wc.getTitle()) : '') : null
    if (tidied) { toast(`Download renamed to ${tidied}`); name = tidied }
    if (S.settings.downloadMode === 'ask') {
      item.setSaveDialogOptions({ defaultPath: path.join(dir, name) })
      const d = { id: uid('d'), name, path: '', received: 0, total: item.getTotalBytes(), state: 'progressing' }
      downloads.unshift(d)
      item.on('updated', (_e2, state) => { d.received = item.getReceivedBytes(); d.state = state; d.path = item.getSavePath(); d.name = path.basename(d.path || name); pushStateSoon() })
      item.once('done', (_e2, state) => { d.state = state; d.path = item.getSavePath(); pushState(); if (state === 'completed') toast(`Downloaded ${d.name}`) })
      return
    }
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
  if (!PRIVATE && extensions) setupExtensions(ses)
}

function applyProxy (ses) {
  const st = S.settings
  const cfg = { mode: st.proxyMode || 'system' }
  if (cfg.mode === 'fixed_servers') { cfg.proxyRules = st.proxyRules || ''; cfg.proxyBypassRules = st.proxyBypass || '<local>' }
  if (cfg.mode === 'pac_script') cfg.pacScript = st.proxyPac || ''
  if ((cfg.mode === 'fixed_servers' && !cfg.proxyRules) || (cfg.mode === 'pac_script' && !cfg.pacScript)) cfg.mode = 'system'
  // command-line --proxy-server (used for testing/managed setups) wins over UI settings
  if (app.commandLine.hasSwitch('proxy-server')) return
  ses.setProxy(cfg).catch(() => {})
}

// ---------------------------------------------------------------- tidy helpers
function tidyDownloadName (name, pageTitle) {
  const ext = path.extname(name); const base = path.basename(name, ext)
  const meaningless = /^[\d_-]{5,}$|^[a-f0-9-]{16,}$|^(download|file|document|untitled|image|attachment|export)(\s*\(\d+\))?$/i.test(base)
  if (!meaningless || !pageTitle) return null
  const clean = tidyTitle(pageTitle).replace(/[\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
  return clean ? clean + ext : null
}
function tidyTitle (title, url) {
  if (!title) return title
  let t = title.replace(/^\(\d+\+?\)\s*/, '').replace(/\s+/g, ' ').trim()
  let host = ''; try { host = new URL(url).hostname.replace(/^www\./, '').split('.')[0].toLowerCase() } catch {}
  const parts = t.split(/\s+[|\-–—·•:]\s+/)
  if (parts.length > 1) {
    const last = parts[parts.length - 1]
    if (parts.length > 2 || last.length <= 30 || (host && last.toLowerCase().replace(/\s/g, '').includes(host))) parts.pop()
    t = parts.join(' – ')
  }
  return t.length > 48 ? t.slice(0, 46).trim() + '…' : t
}
function tidyTabs () {
  const sp = space()
  const seen = new Set(); let dupes = 0
  for (const id of [...sp.today]) {
    const t = tab(id); if (!t) continue
    if (seen.has(t.url) && id !== sp.activeTabId) { sp.today.splice(sp.today.indexOf(id), 1); destroyView(id); archiveEntry(t, sp.id); delete S.tabs[id]; dupes++ } else seen.add(t.url)
  }
  const hostOf = (id) => { try { return new URL(tab(id).url).hostname.replace(/^www\./, '') } catch { return '' } }
  const order = []; for (const id of sp.today) { const h = hostOf(id); if (!order.includes(h)) order.push(h) }
  sp.today.sort((a, b) => order.indexOf(hostOf(a)) - order.indexOf(hostOf(b)))
  store.save(); pushState(); toast(`Tidied: grouped by site${dupes ? `, archived ${dupes} duplicate${dupes > 1 ? 's' : ''}` : ''}`)
}

// ---------------------------------------------------------------- Chrome extensions
const EXT_DIR = () => path.join(app.getPath('userData'), 'Extensions')
function setupExtensions (ses) {
  try {
    const { ElectronChromeExtensions } = require('electron-chrome-extensions')
    const { installChromeWebStore } = require('electron-chrome-web-store')
    const ext = new ElectronChromeExtensions({
      license: 'GPL-3.0',
      session: ses,
      createTab: async (details) => {
        const id = newTab(details.url || 'about:blank', { activate: details.active !== false })
        return [ensureView(id).webContents, win]
      },
      selectTab: (wc) => { const id = wcToTab.get(wc.id); if (id) activateTab(id) },
      removeTab: (wc) => { const id = wcToTab.get(wc.id); if (id) closeTab(id) },
      createWindow: async (details) => {
        const url = [].concat(details.url || [])[0]
        if (url) newTab(url)
        return win
      }
    })
    extensionsBySession.set(ses, ext)
    ext.on('browser-action-popup-created', (popup) => popup.browserWindow?.on?.('closed', () => pushStateSoon()))
    installChromeWebStore({
      session: ses,
      extensionsPath: EXT_DIR(),
      allowUnpackedExtensions: true,
      beforeInstall: async (details) => {
        const { response } = await dialog.showMessageBox(win, {
          type: 'question', buttons: ['Add Extension', 'Cancel'], defaultId: 1, cancelId: 1,
          message: `Add “${details.localizedName}”?`,
          detail: (details.manifest?.permissions || []).length ? 'It can: ' + [...(details.manifest.permissions || []), ...(details.manifest.host_permissions || [])].join(', ') : '',
          icon: details.icon
        })
        if (response === 0) setTimeout(() => { toast(`Added ${details.localizedName}`); pushState() }, 1500)
        return { action: response === 0 ? 'allow' : 'deny' }
      }
    }).then(() => pushStateSoon()).catch(e => console.error('web store', e))
  } catch (e) { console.error('extensions unavailable', e) }
}
const extFor = (tabId) => extensionsBySession.get(getSession(profileIdOfTab(tabId)))
function allExtensions () {
  const ses = getSession(space().profileId)
  return (ses.extensions || ses).getAllExtensions()
}
async function loadUnpacked () {
  const r = await dialog.showOpenDialog(win, { title: 'Choose an unpacked extension folder', properties: ['openDirectory'] })
  if (r.canceled || !r.filePaths[0]) return
  const src = r.filePaths[0]
  if (!fs.existsSync(path.join(src, 'manifest.json'))) return toast('That folder has no manifest.json')
  for (const p of S.profiles) {
    const ses = getSession(p.id)
    try { await (ses.extensions || ses).loadExtension(src, { allowFileAccess: false }) } catch (e) { return toast('Could not load: ' + e.message) }
  }
  S.unpackedExtensions = [...new Set([...(S.unpackedExtensions || []), src])]
  store.save(); toast('Extension loaded'); pushState()
}
async function removeExtension (id) {
  const { uninstallExtension } = require('electron-chrome-web-store')
  for (const p of S.profiles) {
    const ses = getSession(p.id); const ex = (ses.extensions || ses).getExtension(id)
    if (ex) {
      S.unpackedExtensions = (S.unpackedExtensions || []).filter(x => x !== ex.path)
      try { await uninstallExtension(id, { session: ses, extensionsPath: EXT_DIR() }) } catch { (ses.extensions || ses).removeExtension(id) }
    }
  }
  store.save(); toast('Extension removed'); pushState()
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
      spellcheck: true,
      preload: WEB_PRELOAD
    }
  })
  view.setBackgroundColor('#ffffff')
  if (view.setBorderRadius) view.setBorderRadius(10)
  views.set(tabId, view)
  const wc = view.webContents
  wcToTab.set(wc.id, tabId)
  live.set(tabId, { loading: false, canBack: false, canFwd: false, blocked: 0, audible: false, muted: false, zoom: 0 })
  wireWebContents(tabId, wc)
  extFor(tabId)?.addTab(wc, win)
  const url = t.url && isSafeWebUrl(t.url) ? t.url : 'about:blank'
  wc.loadURL(url).catch(() => {})
  return view
}

function destroyView (tabId) {
  const view = views.get(tabId)
  if (!view) return
  try { win.contentView.removeChildView(view) } catch {}
  wcToTab.delete(view.webContents.id)
  try { extFor(tabId)?.removeTab(view.webContents) } catch {}
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
  wc.on('dom-ready', () => {
    const url = wc.getURL()
    if (S.settings.blocker) { const css = adblock.cosmeticCss(url); if (css) wc.insertCSS(css).catch(() => {}) }
    const boost = boostFor(url); if (boost) wc.insertCSS(boost, { cssOrigin: 'user' }).catch(() => {})
  })
  wc.once('destroyed', () => inspector.forget(wc.id))
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
    if (inSplit(sp, tabId) && sp.activeTabId !== tabId) {
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
  wc.on('will-navigate', (e) => {
    guardNavigation(e, e.url, wc)
    if (e.defaultPrevented || !S.settings.peekFromPinned || !e.isMainFrame) return
    const loc = locate(tabId)
    if (!loc || loc.type === 'today' || !/^https?:/.test(e.url)) return
    try {
      const { getDomain } = require('tldts-experimental')
      const from = getDomain(wc.getURL()); const to = getDomain(e.url)
      if (from && to && from !== to) { e.preventDefault(); openPeek(e.url) }
    } catch {}
  })
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
  if (url.startsWith('chrome-extension:')) return
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
      { label: 'Open Link in Peek', click: () => openPeek(p.linkURL) },
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
  const extItems = (() => { try { return extFor(tabId)?.getContextMenuItems(wc, p) || [] } catch { return [] } })()
  if (extItems.length) items.push({ type: 'separator' }, ...extItems)
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
  const prev = sp.activeTabId
  if (S.settings.pipOnLeave && prev && prev !== tabId && views.has(prev) && !(inSplit(sp, prev) && inSplit(sp, tabId))) popOutVideo(prev, { auto: true })
  if (pip?.auto && pip.tabId === tabId) returnVideo(tabId)

  sp.activeTabId = tabId
  tab(tabId).lastActiveAt = Date.now()
  ensureView(tabId)
  try { extFor(tabId)?.selectTab(views.get(tabId).webContents) } catch {}
  if (chatOpen) chatView?.webContents.send('chat', 'page', tab(tabId).customTitle || tab(tabId).title)
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
  if (inSplit(sp, tabId)) {
    const rest = removeFromSplit(sp, tabId)
    if (sp.activeTabId === tabId && rest) sp.activeTabId = rest
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

function memorySaver () {
  const limit = S.settings.memorySaverMs
  if (!limit) return
  const now = Date.now()
  const visible = new Set(win ? win.contentView.children : [])
  for (const [id, v] of [...views]) {
    const t = tab(id); const l = live.get(id)
    if (!t || visible.has(v) || l?.audible || pip?.tabId === id || now - (t.lastActiveAt || 0) < limit) continue
    if (v.webContents.isCurrentlyAudible?.() || v.webContents.isDevToolsOpened()) continue
    destroyView(id)
  }
  pushStateSoon()
}

function autoArchive () {
  memorySaver()
  const limit = S.settings.archiveAfterMs
  if (!limit) return
  const now = Date.now()
  let changed = false
  for (const sp of S.spaces) {
    for (const id of [...sp.today]) {
      const t = tab(id)
      if (!t || id === sp.activeTabId) continue
      if (inSplit(sp, id) || pip?.tabId === id) continue
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
    if (inSplit(sp, id)) continue
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
  if (to !== 'today' && loc.type === 'today' && S.settings.tidyTitles && !t.customTitle) t.customTitle = tidyTitle(t.title, t.url)
  if (to === 'today') delete t.customTitle
  if (loc.space && loc.space.id !== sp.id && loc.space.activeTabId === tabId) loc.space.activeTabId = pickNeighbor(loc.space, tabId)
  if (inSplit(loc.space, tabId) && loc.space.id !== sp.id) removeFromSplit(loc.space, tabId)
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
  if (sp.split && !inSplit(sp, base)) sp.split = null // starting a new split from a tab outside the old one
  if (sp.split && sp.split.ids.length >= MAX_SPLIT) return toast(`Split view holds up to ${MAX_SPLIT} tabs`)
  let other = tab(urlOrTabId) ? urlOrTabId : null
  if (other && inSplit(sp, other)) return activateTab(other)
  if (!other) {
    other = uid('t')
    S.tabs[other] = { id: other, url: urlOrTabId, title: urlOrTabId, favicon: null, createdAt: Date.now(), lastActiveAt: Date.now() }
    sp.today.splice(Math.max(0, sp.today.indexOf(base) + 1), 0, other)
  }
  if (other === base) return
  const ids = sp.split ? [...sp.split.ids] : [base]
  ids.splice(ids.indexOf(base) + 1, 0, other)
  sp.split = { ids, dir: sp.split?.dir || 'row', sizes: ids.map(() => 1 / ids.length) }
  activateTab(other)
}
// Remove one tab from its space's split (the tab stays open). Returns a tab to focus, or null.
function removeFromSplit (sp, tabId) {
  if (!inSplit(sp, tabId)) return null
  const i = sp.split.ids.indexOf(tabId)
  const ids = sp.split.ids.filter(id => id !== tabId)
  if (ids.length < 2) { sp.split = null; return ids[0] || null }
  const sizes = sp.split.sizes.filter((_, k) => k !== i); const sum = sizes.reduce((a, b) => a + b, 0)
  sp.split = { ...sp.split, ids, sizes: sizes.map(x => x / sum) }
  return ids[Math.min(i, ids.length - 1)]
}
function setSplitDir (dir) {
  const sp = space(); if (!sp.split) return toast('No split view in this space')
  sp.split.dir = dir; layout(); store.save()
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
  S.sync.tombstones[id] = Date.now()
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
  if (PRIVATE) return
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
  const splitActive = inSplit(sp, act) && sp.split.ids.every(id => tab(id))
  if (splitActive) needed.push(...sp.split.ids)
  else if (act) needed.push(act)
  if (htmlFullscreen && views.has(htmlFullscreen)) needed.splice(0, needed.length, htmlFullscreen)

  for (const [id, v] of views) if (!needed.includes(id)) { try { win.contentView.removeChildView(v) } catch {} }
  const sw = sidebarShown() ? S.settings.sidebarWidth : 0
  const x0 = sw || PAD
  const chatW = chatOpen && !htmlFullscreen ? CHAT_W + 6 : 0
  const area = { x: x0, y: PAD, width: Math.max(100, w - x0 - PAD - chatW), height: Math.max(100, h - PAD * 2) }
  if (chatOpen && !htmlFullscreen) {
    const px = w - PAD - CHAT_W
    if (accountMode() && claudeBar && claudeWeb) {
      win.contentView.addChildView(claudeBar); claudeBar.setBounds({ x: px, y: PAD, width: CHAT_W, height: 40 })
      win.contentView.addChildView(claudeWeb); claudeWeb.setBounds({ x: px, y: PAD + 44, width: CHAT_W, height: h - PAD * 2 - 44 })
    } else if (chatView) { win.contentView.addChildView(chatView); chatView.setBounds({ x: px, y: PAD, width: CHAT_W, height: h - PAD * 2 }) }
  }
  const rects = needed.length > 1 ? splitRects(area, sp.split) : [area]
  needed.forEach((id, i) => {
    const v = ensureView(id)
    win.contentView.addChildView(v)
    if (htmlFullscreen) { v.setBounds({ x: 0, y: 0, width: w, height: h }); v.setBorderRadius?.(0); return }
    v.setBorderRadius?.(10)
    v.setBounds(rects[i])
  })
  lastLayout = { area, rects, dir: sp.split?.dir || 'row' }
  win.webContents.send('layout', { area, panes: needed.length > 1 && !htmlFullscreen ? needed.map((id, i) => ({ id, ...rects[i], active: id === act })) : null, dir: sp.split?.dir || 'row' })
}

// ---------------------------------------------------------------- overlay (command bar, find, prompts)
let lastLayout = null
const SPLIT_GAP = 6
function splitRects (area, split) {
  const n = split.ids.length; const row = split.dir !== 'col'
  const total = (row ? area.width : area.height) - SPLIT_GAP * (n - 1)
  const rects = []; let off = 0
  split.sizes.forEach((f, i) => {
    const len = i === n - 1 ? total - off : Math.round(total * f)
    rects.push(row ? { x: area.x + off + i * SPLIT_GAP, y: area.y, width: len, height: area.height } : { x: area.x, y: area.y + off + i * SPLIT_GAP, width: area.width, height: len })
    off += len
  })
  return rects
}
// Divider dragging: a transparent full-window shield captures the mouse while you drag
let dragShield = null; let dragIndex = -1
function startSplitDrag (index) {
  const sp = space(); if (!sp.split || index < 0 || index >= sp.split.ids.length - 1) return
  dragIndex = index
  if (!dragShield) {
    dragShield = new WebContentsView({ webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false } })
    dragShield.setBackgroundColor('#00000000')
    dragShield.webContents.on('will-navigate', e => e.preventDefault())
  }
  dragShield.webContents.loadFile(path.join(UI_DIR, 'drag-shield.html'), { query: { dir: sp.split.dir } })
  const [w, h] = win.getContentSize()
  win.contentView.addChildView(dragShield); dragShield.setBounds({ x: 0, y: 0, width: w, height: h })
}
function splitDrag (x, y) {
  const sp = space(); if (!sp.split || dragIndex < 0 || !lastLayout) return
  const { area } = lastLayout; const row = sp.split.dir !== 'col'
  const p = row ? (x - area.x) / area.width : (y - area.y) / area.height
  const sizes = sp.split.sizes; const i = dragIndex
  const before = sizes.slice(0, i).reduce((a, b) => a + b, 0); const pair = sizes[i] + sizes[i + 1]
  const MIN = 0.1
  const at = Math.max(before + MIN, Math.min(before + pair - MIN, p))
  sizes[i] = at - before; sizes[i + 1] = pair - sizes[i]
  layout()
}
function endSplitDrag () {
  dragIndex = -1
  if (dragShield) { try { win.contentView.removeChildView(dragShield) } catch {} }
  store.save()
}

function overlayBounds () {
  const [w, h] = win.getContentSize()
  if (overlayOpen?.mode === 'find') return { x: w - 380, y: 14, width: 360, height: 64 }
  if (peekView && overlayOpen?.mode === 'peek') { const pb = peekBounds(); peekView.setBounds(pb) }
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
  if (overlayOpen.mode === 'peek') destroyPeek()
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

function prompt (title, value, cb, { secret = false } = {}) {
  const key = uid('k'); pending[key] = cb
  openOverlay({ mode: 'prompt', title, query: value || '', key, secret })
}
function pick (title, items, cb) {
  const key = uid('k'); pending[key] = cb
  openOverlay({ mode: 'pick', title, items, key })
}

function paletteSnapshot () {
  const sp = space()
  const tabs = []
  for (const s of S.spaces) {
    for (const id of [...s.pinned, ...s.today]) { const t = tab(id); if (t) tabs.push({ id, title: t.title, url: t.url, favicon: iconFor(t), space: s.name }) }
  }
  for (const id of profile(sp.profileId).favorites) { const t = tab(id); if (t) tabs.push({ id, title: t.title, url: t.url, favicon: iconFor(t), space: 'Favorites' }) }
  return {
    tabs,
    history: S.history.slice(0, 1500),
    archive: S.archive.map((a, i) => ({ i, title: a.title, url: a.url, favicon: iconFor(a), archivedAt: a.archivedAt })),
    commands: COMMANDS.map(c => ({ id: c.id, title: typeof c.title === 'function' ? c.title() : c.title, keys: c.keys || '' })),
    color: sp.color,
    engine: ENGINES[S.settings.searchEngine].name,
    ai: S.settings.aiInCommandBar ? S.settings.aiProvider : null,
    instant: S.settings.instantLinks,
    suggestions: S.settings.suggestions
  }
}

// ---------------------------------------------------------------- commands
const onOff = (b) => (b ? 'On' : 'Off')
const COMMANDS = [
  { id: 'new-tab', title: 'New Tab', keys: '⌘T', run: () => commandBar('new') },
  { id: 'split', title: 'Add Split View', keys: '⌃⇧=', run: () => setTimeout(() => openOverlay({ mode: 'split', query: '' })) },
  { id: 'unsplit', title: 'Separate Split View', keys: '⌃⇧-', run: unsplit },
  { id: 'split-row', title: 'Split View: Side by Side', run: () => setSplitDir('row') },
  { id: 'split-col', title: 'Split View: Stacked', run: () => setSplitDir('col') },
  { id: 'split-remove', title: 'Remove Tab from Split View', run: () => { const sp = space(); const id = sp.activeTabId; if (!inSplit(sp, id)) return; removeFromSplit(sp, id); layout(); pushState(); store.save() } },
  { id: 'pip', title: 'Pop Out Video (floating window)', keys: '⌥⌘P', run: () => popOutVideo(activeTabId()).then(ok => { if (!ok) toast('No playing video on this page') }) },
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
  { id: 'updates', title: 'Check for Updates', run: () => checkForUpdates(true) },
  { id: 'private', title: 'New Private Window', keys: '⌘⇧N', run: openPrivateWindow },
  { id: 'passwords', title: 'Passwords…', run: () => setTimeout(showPasswords) },
  { id: 'pw-import', title: 'Import Passwords from CSV (Chrome / Arc / 1Password)…', run: importPasswords },
  { id: 'pw-export', title: 'Export Passwords to CSV…', run: exportPasswords },
  { id: 'ext-store', title: 'Get Extensions (Chrome Web Store)', run: () => PRIVATE ? toast('Extensions are off in private windows') : newTab('https://chromewebstore.google.com/') },
  { id: 'ext-manage', title: 'Manage Extensions…', run: () => setTimeout(manageExtensions) },
  { id: 'ext-unpacked', title: 'Load Unpacked Extension…', run: loadUnpacked },
  { id: 'sync-setup', title: () => S.sync.enabled ? `Sync: On (${path.basename(S.sync.folder || '')}) — Turn Off` : 'Set Up Sync…', run: () => S.sync.enabled ? disableSync() : setTimeout(setupSync) },
  { id: 'sync-now', title: 'Sync Now', run: () => runSync(true) },
  { id: 'settings', title: 'Settings…', keys: '⌘,', run: () => openSettings() },
  { id: 'inspect', title: 'Site Inspector — certificate, security headers, cookies, tech stack', keys: '⌘⇧I', run: () => setTimeout(openInspector) },
  { id: 'library', title: 'Library — downloads, media, archive, spaces, boosts', run: () => setTimeout(openLibrary) },
  { id: 'tidy', title: 'Tidy Tabs', run: tidyTabs },
  { id: 'mini', title: 'New Little Window', keys: '⌥⌘N', run: () => openMini() },
  { id: 'boost', title: 'Boost This Site…', run: () => setTimeout(boostSite) },
  { id: 'export-data', title: 'Export Data…', run: () => exportData() },
  { id: 'claude', title: 'Ask Claude (chat panel)', keys: '⌘E', run: () => toggleChat(true) },
  { id: 'claude-key', title: 'Set Claude API Key…', run: () => setTimeout(promptClaudeKey) }
]
function promptClaudeKey () {
  win.focus()
  prompt('Claude API key (from console.anthropic.com) — stored encrypted in your Keychain; leave empty to remove', '', (k) => {
    if (k == null) return
    k = k.trim()
    if (k && !/^sk-ant-[\w-]{20,}$/.test(k)) return toast('That doesn’t look like a Claude API key (sk-ant-…)')
    setClaudeKey(k || null); toast(k ? 'Claude API key saved' : 'Claude API key removed'); sendSettings()
    chatView?.webContents.send('chat', 'init', chatInit())
  }, { secret: true })
}
function archiveLabel (ms) {
  if (!ms) return 'Never'
  const h = ms / HOUR
  return h < 24 ? `${h} hours` : h === 24 ? '24 hours' : `${h / 24} days`
}
// ---------------------------------------------------------------- passwords UI
function showPasswords () {
  const list = passwords.list()
  if (!list.length) return toast('No saved passwords yet — sign in to a site, or import a CSV')
  pick(`Saved passwords (${list.length})`, list.map(e => ({ value: e.id, title: `${e.host} — ${e.username || '(no username)'}` })), (id) => {
    const e = list.find(x => x.id === id)
    setTimeout(() => pick(`${e.host} — ${e.username}`, [
      { value: 'copy', title: 'Copy Password' }, { value: 'user', title: 'Copy Username' },
      { value: 'open', title: 'Open Site' }, { value: 'del', title: 'Delete' }
    ], async (a) => {
      if (a === 'copy') passwords.copySecret(id)
      if (a === 'user') { clipboard.writeText(e.username); toast('Username copied') }
      if (a === 'open') newTab(e.origin)
      if (a === 'del') {
        const { response } = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1, message: `Delete the password for ${e.host}?` })
        if (response === 0) { passwords.remove(id); toast('Password deleted') }
      }
    }))
  })
}
async function importPasswords () {
  const r = await dialog.showOpenDialog(win, { title: 'Import passwords CSV', filters: [{ name: 'CSV', extensions: ['csv'] }], properties: ['openFile'] })
  if (r.canceled) return
  try { toast(`Imported ${passwords.importCsv(r.filePaths[0])} passwords`) } catch (e) { toast('Import failed: ' + e.message) }
}
async function exportPasswords () {
  const r = await dialog.showSaveDialog(win, { title: 'Export passwords', defaultPath: 'Drift Passwords.csv' })
  if (r.canceled || !r.filePath) return
  if (await passwords.exportCsv(r.filePath)) toast('Exported — this file is NOT encrypted, delete it after use')
}

// ---------------------------------------------------------------- extensions UI
function manageExtensions () {
  const exts = allExtensions()
  if (!exts.length) return toast('No extensions yet — run “Get Extensions”')
  pick('Extensions', exts.map(e => ({ value: e.id, title: `${e.name} ${e.version || ''}` })), (id) => {
    const e = exts.find(x => x.id === id)
    setTimeout(() => pick(e.name, [
      ...(e.manifest?.options_page || e.manifest?.options_ui ? [{ value: 'opt', title: 'Options' }] : []),
      { value: 'rm', title: 'Remove Extension' }
    ], (a) => {
      if (a === 'opt') newTab(`chrome-extension://${id}/${e.manifest.options_page || e.manifest.options_ui.page}`)
      if (a === 'rm') removeExtension(id)
    }))
  })
}

// ---------------------------------------------------------------- sync
const { safeStorage } = require('electron')
function syncKey () {
  if (!S.sync.keyEnc) return null
  try { return S.sync.keyEnc.startsWith('k:') ? safeStorage.decryptString(Buffer.from(S.sync.keyEnc.slice(2), 'base64')) : Buffer.from(S.sync.keyEnc.slice(2), 'base64').toString() } catch { return null }
}
async function setupSync () {
  const icloud = path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs')
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a sync folder (iCloud Drive, Dropbox, …) shared by your Macs',
    defaultPath: fs.existsSync(icloud) ? icloud : os.homedir(),
    properties: ['openDirectory', 'createDirectory']
  })
  if (r.canceled || !r.filePaths[0]) return
  const folder = r.filePaths[0]
  prompt('Sync passphrase — use the same one on every device (min 8 characters)', '', (pass) => {
    if (!pass || pass.length < 8) return toast('Passphrase must be at least 8 characters')
    S.sync.folder = folder
    S.sync.deviceId = S.sync.deviceId || uid('dev')
    S.sync.keyEnc = safeStorage.isEncryptionAvailable() ? 'k:' + safeStorage.encryptString(pass).toString('base64') : 'p:' + Buffer.from(pass).toString('base64')
    S.sync.enabled = true
    store.save(); runSync(true)
  }, { secret: true })
}
function disableSync () { S.sync.enabled = false; S.sync.keyEnc = null; store.save(); toast('Sync turned off') }
let syncing = false
function runSync (manual = false) {
  if (PRIVATE || syncing) return
  if (!S.sync.enabled) { if (manual) toast('Sync is off — run “Set Up Sync…”'); return }
  const pass = syncKey(); if (!pass) return manual && toast('Sync passphrase unavailable — set up sync again')
  syncing = true
  try {
    const r = sync.syncNow({ S, passphrase: pass, passwords, newTabId: () => uid('t') })
    store.save()
    if (r.changed) {
      sanitizeState()
      // tabs removed by another device: unload their pages too
      for (const id of [...views.keys()]) if (!S.tabs[id]) destroyView(id)
      for (const sp of S.spaces) if (sp.activeTabId && !S.tabs[sp.activeTabId]) sp.activeTabId = pickNeighbor(sp, null)
      layout(); pushState()
    }
    if (r.errors.length) toast('Sync problem: ' + r.errors[0])
    else if (manual) toast(`Synced with ${r.devices} other device${r.devices === 1 ? '' : 's'}`)
  } catch (e) { if (manual) toast('Sync failed: ' + e.message) } finally { syncing = false }
}

// ---------------------------------------------------------------- private window
function openPrivateWindow () {
  const flags = process.argv.slice(1).filter(a => /^--(no-sandbox|proxy-server|disable-gpu|ozone)/.test(a))
  const args = app.isPackaged ? [...flags, '--drift-private'] : [...flags, app.getAppPath(), '--drift-private']
  const env = { ...process.env }; delete env.DRIFT_SELFTEST
  spawn(process.execPath, args, { detached: true, stdio: 'ignore', env }).unref()
}

// ---------------------------------------------------------------- Picture-in-Picture (floating video)
// Uses Chromium's native PiP window: movable, resizable, and on macOS it floats above every app.
let pip = null // { tabId, auto } — auto: Drift popped it out and will bring it back
const PIP_IN = `(async () => {
  const vids = [...document.querySelectorAll('video')].filter(v => !v.paused && !v.ended && v.readyState > 2 && !v.disablePictureInPicture)
  if (!vids.length) return false
  const v = vids.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]
  if (document.pictureInPictureElement === v) return true
  try { await v.requestPictureInPicture(); return true } catch { return false }
})()`
const PIP_OUT = `(async () => { if (!document.pictureInPictureElement) return false; await document.exitPictureInPicture().catch(() => {}); return true })()`
async function inFrames (wc, code) {
  for (const f of wc.mainFrame.framesInSubtree) { try { if (await f.executeJavaScript(code, true)) return true } catch {} }
  return false
}
async function popOutVideo (tabId, { auto = false } = {}) {
  const v = views.get(tabId); if (!v || v.webContents.isDestroyed()) return false
  const ok = await inFrames(v.webContents, PIP_IN)
  if (ok) pip = { tabId, auto }
  return ok
}
async function returnVideo (tabId) {
  const v = views.get(tabId)
  if (v && !v.webContents.isDestroyed()) await inFrames(v.webContents, PIP_OUT)
  if (pip?.tabId === tabId) pip = null
}

// ---------------------------------------------------------------- Peek
let peekView = null
function peekBounds () {
  const [w, h] = win.getContentSize()
  const pw = Math.min(1100, Math.round(w * 0.78)); const ph = Math.round(h * 0.82)
  return { x: Math.round((w - pw) / 2), y: Math.round((h - ph) / 2) + 34, width: pw, height: ph - 34 }
}
function openPeek (url) {
  if (!isSafeWebUrl(url)) return
  destroyPeek()
  const pid = space().profileId
  peekView = new WebContentsView({ webPreferences: { session: getSession(pid), sandbox: true, contextIsolation: true, nodeIntegration: false, safeDialogs: true, preload: WEB_PRELOAD } })
  peekView.setBorderRadius?.(12)
  peekView.webContents.setWindowOpenHandler(({ url: u }) => { if (isSafeWebUrl(u)) newTab(u); return { action: 'deny' } })
  peekView.webContents.on('will-navigate', (e) => guardNavigation(e, e.url, peekView.webContents))
  peekView.webContents.on('before-input-event', (e, i) => { if (i.type === 'keyDown' && i.key === 'Escape') { e.preventDefault(); closeOverlay() } })
  peekView.webContents.on('page-title-updated', (_e, t) => overlay?.webContents.send('peek-title', t))
  peekView.webContents.loadURL(url).catch(() => {})
  openOverlay({ mode: 'peek', query: url })
  win.contentView.addChildView(peekView)
  peekView.setBounds(peekBounds())
  peekView.webContents.focus()
}
function destroyPeek () {
  if (!peekView) return
  try { win.contentView.removeChildView(peekView) } catch {}
  if (!peekView.webContents.isDestroyed()) peekView.webContents.close()
  peekView = null
}
ipcMain.on('peek-link', (e, url) => {
  if (!wcToTab.has(e.sender.id) || !S.settings.peekShift || typeof url !== 'string') return
  openPeek(url)
})

// ---------------------------------------------------------------- Little Window
const miniWindows = new Set()
function openMini (url) {
  const m = new BrowserWindow({
    width: 860, height: 640, minWidth: 420, minHeight: 300, title: 'Drift', show: false,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden', trafficLightPosition: { x: 12, y: 12 }, vibrancy: isMac ? 'sidebar' : undefined,
    backgroundColor: isMac ? '#00000000' : '#efeaf9',
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  const view = new WebContentsView({ webPreferences: { session: getSession(space().profileId), sandbox: true, contextIsolation: true, nodeIntegration: false, safeDialogs: true, preload: WEB_PRELOAD } })
  view.setBorderRadius?.(10)
  const rec = { win: m, view, ui: m.webContents }
  miniWindows.add(rec)
  m.contentView.addChildView(view)
  const lay = () => { const [w, h] = m.getContentSize(); view.setBounds({ x: 6, y: 38, width: w - 12, height: h - 44 }) }
  lay(); m.on('resize', lay)
  m.loadFile(path.join(UI_DIR, 'mini.html'))
  const wc = view.webContents
  wc.setWindowOpenHandler(({ url: u }) => { if (isSafeWebUrl(u)) wc.loadURL(u); return { action: 'deny' } })
  wc.on('will-navigate', (e) => guardNavigation(e, e.url, wc))
  const send = () => { if (!m.isDestroyed()) m.webContents.send('mini', { url: wc.getURL(), title: wc.getTitle(), canBack: wc.navigationHistory.canGoBack(), loading: wc.isLoading() }) }
  for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-stop-loading', 'did-start-loading']) wc.on(ev, send)
  wc.on('did-navigate', (_e, u) => addHistory(u, wc.getTitle()))
  m.webContents.on('did-finish-load', send)
  m.once('ready-to-show', () => m.show())
  m.on('closed', () => { miniWindows.delete(rec); if (!wc.isDestroyed()) wc.close() })
  if (url) wc.loadURL(url).catch(() => {}); else m.webContents.once('did-finish-load', () => m.webContents.send('mini-focus'))
  return rec
}
LATE_ACTIONS['mini-action'] = (action, arg) => {
  const rec = [...miniWindows].find(m => m.ui === uiSender); if (!rec) return
  const wc = rec.view.webContents
  if (action === 'go') { const u = normalizeInput(String(arg || '')); if (u && isSafeWebUrl(u)) wc.loadURL(u).catch(() => {}) }
  if (action === 'back') wc.navigationHistory.goBack()
  if (action === 'reload') wc.reload()
  if (action === 'open-in-drift') { const u = wc.getURL(); rec.win.close(); if (u && isSafeWebUrl(u)) { newTab(u); win?.show(); win?.focus() } }
  if (action === 'copy') { clipboard.writeText(wc.getURL()) }
}

// ---------------------------------------------------------------- Claude chat panel
let chatView = null
let chatOpen = false
const CHAT_W = 380
const claudeChat = createClaudeChat({
  getApiKey: () => claudeKey(),
  send: (type, data) => { if (chatView && !chatView.webContents.isDestroyed()) chatView.webContents.send('chat', type, data) }
})
function claudeKey () {
  const enc = S.claudeKeyEnc; if (!enc) return null
  try { return enc.startsWith('k:') ? safeStorage.decryptString(Buffer.from(enc.slice(2), 'base64')) : Buffer.from(enc.slice(2), 'base64').toString() } catch { return null }
}
function setClaudeKey (key) {
  S.claudeKeyEnc = key ? (safeStorage.isEncryptionAvailable() ? 'k:' + safeStorage.encryptString(key).toString('base64') : 'p:' + Buffer.from(key).toString('base64')) : null
  store.save()
}
function ensureChatView () {
  if (chatView) return chatView
  chatView = new WebContentsView({ webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  chatView.setBorderRadius?.(10)
  chatView.webContents.loadFile(path.join(UI_DIR, 'chat.html'))
  chatView.webContents.on('will-navigate', e => e.preventDefault())
  chatView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return chatView
}
function chatInit () {
  return { models: CLAUDE_MODELS, model: S.settings.claudeModel, hasKey: !!claudeKey() || !!process.env.ANTHROPIC_API_KEY, pageTitle: tab(activeTabId())?.title || '' }
}
const accountMode = () => S.settings.claudeMode !== 'api'
function detachChatViews () {
  for (const v of [chatView, claudeBar, claudeWeb]) if (v) { try { win.contentView.removeChildView(v) } catch {} }
}
function toggleChat (force) {
  chatOpen = typeof force === 'boolean' ? force : !chatOpen
  detachChatViews()
  if (chatOpen) { if (accountMode()) ensureClaudeAccountViews(); else ensureChatView() }
  layout(); pushState()
  if (!chatOpen) return views.get(activeTabId())?.webContents.focus()
  if (accountMode()) claudeWeb.webContents.focus(); else chatView.webContents.send('chat', 'focus')
}
function setClaudeMode (mode) {
  if (!['account', 'api'].includes(mode)) return
  S.settings.claudeMode = mode; store.save(); sendSettings()
  if (chatOpen) toggleChat(true)
}

// ---- Claude account mode: the official claude.ai, signed in with your Pro / Max / Team plan.
// Runs in its own isolated, sandboxed session; Drift never sees your Claude credentials.
let claudeBar = null
let claudeWeb = null
const CLAUDE_HOME = 'https://claude.ai/new'
const claudeSession = () => session.fromPartition(PRIVATE ? 'claude-account' : 'persist:claude-account')
function ensureClaudeAccountViews () {
  if (!claudeBar) {
    claudeBar = new WebContentsView({ webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false } })
    claudeBar.setBorderRadius?.(10)
    claudeBar.webContents.loadFile(path.join(UI_DIR, 'claude-bar.html'))
    claudeBar.webContents.on('will-navigate', e => e.preventDefault())
    claudeBar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  }
  if (!claudeWeb) {
    const ses = claudeSession()
    setupSession(ses, { extensions: false })
    claudeWeb = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, safeDialogs: true, spellcheck: true, preload: WEB_PRELOAD } })
    claudeWeb.setBorderRadius?.(10)
    claudeWeb.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#262624' : '#faf9f5')
    const wc = claudeWeb.webContents
    // Sign-in popups (Google, Apple, company SSO) stay attached to the panel; other links open as Drift tabs.
    wc.setWindowOpenHandler(({ url, disposition, features }) => {
      if (!isSafeWebUrl(url)) return { action: 'deny' }
      if (disposition === 'new-window' && features) {
        return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 680, parent: win, autoHideMenuBar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, safeDialogs: true } } }
      }
      newTab(url); return { action: 'deny' }
    })
    wc.on('will-navigate', (e) => guardNavigation(e, e.url, wc))
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (isMain && code !== -3) wc.loadFile(ERROR_PAGE, { query: { kind: 'error', url, code: String(code), desc } })
    })
    wc.on('context-menu', (_e, p) => {
      const items = []
      if (p.linkURL) items.push({ label: 'Open Link in New Tab', click: () => newTab(p.linkURL) }, { label: 'Copy Link', click: () => clipboard.writeText(p.linkURL) }, { type: 'separator' })
      if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' })
      else if (p.selectionText) items.push({ role: 'copy' })
      items.push({ type: 'separator' }, { label: 'Reload', click: () => wc.reload() })
      Menu.buildFromTemplate(items).popup({ window: win })
    })
    wc.loadURL(CLAUDE_HOME).catch(() => {})
  }
}
// Focus Claude's message box (re-trying while the claude.ai app starts up), type text into it,
// and confirm it actually landed there. Returns false when there is no message box (e.g. signed out).
async function typeIntoClaude (text) {
  const wc = claudeWeb.webContents
  const focusComposer = `(() => {
    const e = document.querySelector('div.ProseMirror[contenteditable="true"], [data-testid="chat-input"] [contenteditable="true"], div[contenteditable="true"][role="textbox"], div[contenteditable="true"]')
    if (!e || !e.offsetParent) return false
    e.focus(); return document.activeElement === e || e.contains(document.activeElement)
  })()`
  const marker = text.slice(0, 40)
  const landed = `(() => { const e = document.activeElement; return !!e && (e.innerText || e.value || '').includes(${JSON.stringify(marker)}) })()`
  for (let i = 0; i < 20; i++) {
    if (!wc.isLoading() && await wc.executeJavaScript(focusComposer, true).catch(() => false)) {
      wc.focus(); wc.insertText(text)
      await new Promise(r => setTimeout(r, 150))
      return await wc.executeJavaScript(landed).catch(() => false)
    }
    await new Promise(r => setTimeout(r, 300))
  }
  return false
}
const MAX_SHARED_CHARS = 100000
async function addPageToClaude () {
  const page = await pageForChat()
  if (!page || !page.text.trim()) { toast('Open a page with text first'); return 'no-page' }
  let body = page.text
  if (body.length > MAX_SHARED_CHARS) { toast(`Long page: shared the first ${MAX_SHARED_CHARS.toLocaleString()} of ${body.length.toLocaleString()} characters`); body = body.slice(0, MAX_SHARED_CHARS) }
  const text = `Here is a web page I'm reading.\nTitle: ${page.title}\nURL: ${page.url}\n\n${body}\n\nMy question: `
  if (await typeIntoClaude(text)) return 'typed'
  clipboard.writeText(text)
  toast('Copied the page — click Claude’s message box and press ⌘V (sign in first if needed)')
  return 'copied'
}
async function askClaudeAccount (question) {
  toggleChat(true)
  const wc = claudeWeb.webContents
  if (!wc.getURL().startsWith(CLAUDE_HOME)) { wc.loadURL(CLAUDE_HOME).catch(() => {}); await new Promise(r => setTimeout(r, 600)) }
  if (!(await typeIntoClaude(question))) { clipboard.writeText(question); toast('Copied your question — paste it into Claude (⌘V)') }
}
function chatMenu () {
  const acct = accountMode()
  Menu.buildFromTemplate([
    { label: 'Use my Claude account (Pro, Max, Team)', type: 'radio', checked: acct, click: () => setClaudeMode('account') },
    { label: 'Use an API key', type: 'radio', checked: !acct, click: () => setClaudeMode('api') },
    { type: 'separator' },
    ...(acct ? [{ label: 'Sign Out of Claude in Drift…', click: () => signOutClaude() }] : [{ label: claudeKey() ? 'Change API Key…' : 'Add API Key…', click: () => promptClaudeKey() }]),
    { label: 'Claude Settings…', click: () => openSettings('integrations') }
  ]).popup({ window: win })
}
async function signOutClaude () {
  const { response } = await dialog.showMessageBox(win, { type: 'question', buttons: ['Sign Out', 'Cancel'], defaultId: 1, cancelId: 1, message: 'Sign out of your Claude account in Drift?', detail: 'This clears claude.ai cookies and data stored by Drift. Your chats stay in your Claude account.' })
  if (response !== 0) return
  await claudeSession().clearStorageData(); await claudeSession().clearCache()
  claudeWeb?.webContents.loadURL(CLAUDE_HOME).catch(() => {})
  toast('Signed out of Claude'); sendSettings()
}
async function pageForChat () {
  const v = views.get(activeTabId()); if (!v) return null
  const wc = v.webContents
  const text = await Promise.race([
    wc.executeJavaScriptInIsolatedWorld(998, [{ code: 'document.body ? document.body.innerText : ""' }]).catch(() => ''),
    new Promise(resolve => setTimeout(() => resolve(''), 5000))
  ])
  return { url: wc.getURL(), title: wc.getTitle(), text: String(text || '') }
}
Object.assign(LATE_ACTIONS, {
  'chat-ready': () => chatView?.webContents.send('chat', 'init', chatInit()),
  'chat-send': async (text, usePage) => {
    if (typeof text !== 'string' || !text.trim() || uiSender !== chatView?.webContents) return
    const page = usePage ? await pageForChat() : null
    claudeChat.ask({ text: text.slice(0, 100000), page, model: S.settings.claudeModel, effort: S.settings.claudeEffort })
  },
  'chat-stop': () => claudeChat.stop(),
  'chat-reset': () => { claudeChat.reset(); chatView?.webContents.send('chat', 'reset') },
  'chat-close': () => toggleChat(false),
  'chat-menu': () => chatMenu(),
  'chat-mode': (m) => setClaudeMode(m),
  'claude-add-page': () => addPageToClaude(),
  'claude-reload': () => claudeWeb?.webContents.reload(),
  'claude-open-tab': () => { const u = claudeWeb?.webContents.getURL(); newTab(u && u.startsWith('https://claude.ai') ? u : CLAUDE_HOME) },
  'chat-model': (m) => { if (CLAUDE_MODELS.some(([id]) => id === m)) { S.settings.claudeModel = m; store.save(); sendSettings() } },
  'chat-open-link': (u) => { if (typeof u === 'string' && /^https?:\/\//.test(u)) newTab(u) },
  'toggle-chat': () => toggleChat()
})

// ---------------------------------------------------------------- Boosts
function boostFor (url) {
  if (!S.settings.boostsEnabled) return ''
  try { return S.boosts[new URL(url).hostname] || '' } catch { return '' }
}
const BOOST_PRESETS = {
  dark: 'html{filter:invert(.92) hue-rotate(180deg)!important;background:#fff!important}img,video,picture,canvas,iframe,svg image{filter:invert(1) hue-rotate(180deg)!important}',
  read: 'body{max-width:760px!important;margin:0 auto!important;font-size:19px!important;line-height:1.65!important}aside,nav,footer,[class*=sidebar],[class*=banner],[id*=ad-],[class*=promo]{display:none!important}',
  bigger: 'html{zoom:1.15}',
  noimg: 'img,picture,video{visibility:hidden!important}',
  font: '*:not(code):not(pre):not([class*=icon]){font-family:-apple-system,BlinkMacSystemFont,"Inter",system-ui,sans-serif!important}'
}
function boostSite () {
  const t = tab(activeTabId()); if (!t) return
  let host; try { host = new URL(t.url).hostname } catch { return }
  pick(`Boost ${host}`, [
    { value: 'dark', title: 'Dark mode' }, { value: 'read', title: 'Reading layout' }, { value: 'bigger', title: 'Bigger text' },
    { value: 'font', title: 'System font everywhere' }, { value: 'noimg', title: 'Hide images & video' },
    { value: 'custom', title: 'Custom CSS…' }, ...(S.boosts[host] ? [{ value: 'off', title: 'Remove Boost' }] : [])
  ], (v) => {
    const apply = (css) => { if (css) S.boosts[host] = (S.boosts[host] ? S.boosts[host] + '\n' : '') + css; else delete S.boosts[host]; store.save(); views.get(activeTabId())?.webContents.reload(); toast(css ? `Boost applied to ${host}` : 'Boost removed') }
    if (v === 'off') return apply('')
    if (v === 'custom') return setTimeout(() => prompt(`Custom CSS for ${host}`, '', (css) => css && apply(css)))
    apply(BOOST_PRESETS[v])
  })
}

// ---------------------------------------------------------------- Library & Inspector
function openLibrary () {
  const items = []
  const media = Object.keys(S.tabs).filter(id => live.get(id)?.audible)
  for (const id of media) items.push({ group: 'Media', value: 'tab:' + id, title: '♪ ' + (tab(id).customTitle || tab(id).title) })
  for (const d of downloads.slice(0, 12)) items.push({ group: 'Downloads', value: 'dl:' + d.path, title: `${d.name}${d.state === 'progressing' ? ' — ' + (d.total ? Math.round(d.received / d.total * 100) + '%' : '…') : d.state === 'completed' ? '' : ' — ' + d.state}` })
  items.push({ group: 'Downloads', value: 'dldir', title: 'Open Downloads folder' })
  for (const sp of S.spaces) items.push({ group: 'Spaces', value: 'space:' + sp.id, title: sp.name, color: sp.color })
  for (const [host] of Object.entries(S.boosts)) items.push({ group: 'Boosts', value: 'boost:' + host, title: host })
  S.archive.slice(0, 25).forEach((a, i) => items.push({ group: 'Archived Tabs', value: 'arch:' + i, title: a.title || a.url }))
  pick('Library', items, (v) => {
    const [k, ...rest] = v.split(':'); const arg = rest.join(':')
    if (k === 'tab') activateTab(arg)
    if (k === 'dl' && downloads.some(d => d.path === arg)) shell.showItemInFolder(arg)
    if (k === 'dldir') shell.openPath(S.settings.downloadMode === 'custom' && S.settings.downloadDir ? S.settings.downloadDir : app.getPath('downloads'))
    if (k === 'space') switchSpace(arg)
    if (k === 'boost') newTab('https://' + arg)
    if (k === 'arch') restoreArchived(+arg)
  })
}
async function openInspector () {
  const id = activeTabId(); const view = views.get(id)
  if (!view) return toast('Open a page to inspect it')
  const url = view.webContents.getURL()
  const r = await inspector.report({ wc: view.webContents, url, ses: view.webContents.session, blocked: live.get(id)?.blocked || 0, permissions: S.permissions[originOf(url)] })
  openOverlay({ mode: 'report', report: r })
}

// ---------------------------------------------------------------- Settings window
let settingsWin = null
let settingsPage = null
const ICONS = [['aurora', 'Aurora'], ['midnight', 'Midnight'], ['sunrise', 'Sunrise'], ['mono', 'Graphite']]
function openSettings (page) {
  settingsPage = page || null
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); sendSettings(); return }
  settingsWin = new BrowserWindow({
    width: 820, height: 720, minWidth: 640, minHeight: 480, title: 'Settings', show: false,
    titleBarStyle: isMac ? 'hiddenInset' : 'default', backgroundColor: nativeTheme.shouldUseDarkColors ? '#2b2826' : '#f4f2f7',
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  settingsWin.loadFile(path.join(UI_DIR, 'settings.html'))
  settingsWin.webContents.on('will-navigate', e => e.preventDefault())
  settingsWin.once('ready-to-show', () => settingsWin.show())
}
function mcpBridgePath () { return path.join(__dirname, '..', 'mcp', 'bridge.js') }
function mcpConfigFile () { return path.join(app.getPath('userData'), 'drift-mcp.json') }
function settingsData () {
  const spacesPer = (pid) => S.spaces.filter(s => s.profileId === pid).length
  const perms = Object.entries(S.permissions).map(([origin, m]) => ({ origin, list: Object.entries(m).map(([k, v]) => `${k}: ${v}`).join(', ') }))
  const env = { ELECTRON_RUN_AS_NODE: '1', DRIFT_MCP_CONFIG: mcpConfigFile() }
  const cfg = { mcpServers: { drift: { command: process.execPath, args: [mcpBridgePath()], env } } }
  return {
    page: settingsPage,
    settings: S.settings,
    version: app.getVersion(),
    chrome: process.versions.chrome,
    engines: Object.entries(ENGINES).map(([k, e]) => [k, e.name]),
    profiles: S.profiles.map(p => ({ id: p.id, name: p.name, spaces: spacesPer(p.id) })),
    permissions: perms,
    passwordCount: passwords.count,
    adblock: adblock.ready ? `Filter lists active (EasyList, EasyPrivacy${S.settings.strictBlocking ? ', annoyances' : ''}) + built-in list` : 'Built-in list active — filter lists download on first run',
    mcpConfig: JSON.stringify(cfg, null, 2),
    mcpCli: `claude mcp add drift --env ELECTRON_RUN_AS_NODE=1 --env DRIFT_MCP_CONFIG="${mcpConfigFile()}" -- "${process.execPath}" "${mcpBridgePath()}"`,
    claudeModels: CLAUDE_MODELS,
    hasClaudeKey: !!claudeKey(),
    claudeMode: S.settings.claudeMode,
    syncOn: S.sync.enabled,
    syncStatus: S.sync.enabled ? `On · ${S.sync.folder} · last sync ${S.sync.lastSyncAt ? new Date(S.sync.lastSyncAt).toLocaleTimeString() : 'never'}` : 'Off — encrypted sync through iCloud Drive or any folder',
    extensions: PRIVATE ? 0 : allExtensions().length,
    icons: ICONS.map(([id, name]) => ({ id, name, src: `icons/${id}.png` })),
    shortcuts: [
      ['⌘T', 'New tab / command bar'], ['⌘L', 'Edit URL'], ['⌘W', 'Close tab'], ['⌘⇧T', 'Reopen closed tab'], ['⌘D', 'Pin / unpin tab'],
      ['⌘S', 'Toggle sidebar'], ['⌃⇧=', 'Add split view'], ['⌃⇧-', 'Separate split view'], ['⌃1…9', 'Switch space'], ['⌘1…9', 'Jump to tab'],
      ['⌘⌥←/→', 'Previous / next space'], ['⌃Tab', 'Next tab'], ['⌘F', 'Find in page'], ['⌘⇧C', 'Copy URL'], ['⌘⇧A', 'Archived tabs'],
      ['⌘⇧N', 'New private window'], ['⌥⌘P', 'Pop out video (floating window)'], ['⌘E', 'Claude panel'], ['⌥⌘N', 'Little Window (any app)'], ['⇧-click', 'Peek a link'], ['⌘⇧I', 'Site Inspector'], ['⌘,', 'Settings'], ['⌘⌥I', 'Developer tools']
    ]
  }
}
function sendSettings () { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings', settingsData()) }
const SETTING_TYPES = { searchEngine: 'string', aiProvider: 'string', proxyMode: 'string', proxyRules: 'string', proxyBypass: 'string', proxyPac: 'string', downloadMode: 'string', icon: 'string', claudeMode: 'string', claudeModel: 'string', claudeEffort: 'string', archiveAfterMs: 'number', memorySaverMs: 'number' }
async function setSetting (key, value) {
  if (!(key in DEFAULTS.settings)) return
  const type = SETTING_TYPES[key] || 'boolean'
  if (typeof value !== type) return
  if (key === 'downloadMode' && value === 'custom') {
    const r = await dialog.showOpenDialog(settingsWin || win, { properties: ['openDirectory', 'createDirectory'] })
    if (r.canceled || !r.filePaths[0]) return sendSettings()
    S.settings.downloadDir = r.filePaths[0]
  }
  S.settings[key] = value
  store.save()
  if (key.startsWith('proxy')) for (const ses of configuredSessions) applyProxy(ses)
  if (key === 'strictBlocking' || (key === 'blocker' && value)) adblock.load(app.getPath('userData'), { strictMode: S.settings.strictBlocking }).then(sendSettings)
  if (key === 'icon') applyIcon()
  if (key === 'miniHotkey') registerHotkeys()
  if (key === 'mcpEnabled') setupMcp()
  if (key === 'claudeModel') chatView?.webContents.send('chat', 'init', chatInit())
  if (key === 'claudeMode' && chatOpen) toggleChat(true)
  if (key === 'archiveAfterMs' || key === 'memorySaverMs') autoArchive()
  sendSettings(); pushState()
}
const SETTINGS_ACTIONS = {
  'default-browser': () => runCommand('default-browser'),
  'check-updates': () => checkForUpdates(true),
  'profile-add': () => { win.focus(); prompt('New profile name', '', (n) => { if (n) { S.profiles.push({ id: uid('p'), name: n, favorites: [] }); store.save(); sendSettings() } }) },
  'profile-rename': (id) => { const p = profile(id); if (!p) return; win.focus(); prompt('Rename profile', p.name, (n) => { if (n) { p.name = n; store.save(); sendSettings(); pushState() } }) },
  'profile-delete': async (id) => {
    if (id === 'default' || S.spaces.some(s => s.profileId === id)) return dialog.showMessageBox(settingsWin, { message: 'Move this profile’s spaces to another profile first.' })
    const { response } = await dialog.showMessageBox(settingsWin, { type: 'warning', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1, message: 'Delete this profile and all its data (cookies, logins, history)?' })
    if (response !== 0) return
    await getSession(id).clearStorageData()
    S.profiles = S.profiles.filter(p => p.id !== id); store.save(); sendSettings()
  },
  passwords: () => { win.focus(); showPasswords() },
  'pw-import': () => importPasswords(),
  'clear-data': () => clearBrowsingData().then(sendSettings),
  'perm-reset': (origin) => { delete S.permissions[origin]; store.save(); sendSettings() },
  'reset-perms': () => { S.permissions = {}; store.save(); sendSettings() },
  copy: (text) => { if (typeof text === 'string') { clipboard.writeText(text); toast('Copied') } },
  sync: () => { win.focus(); S.sync.enabled ? disableSync() : setupSync(); setTimeout(sendSettings, 500) },
  extensions: () => { win.focus(); manageExtensions() },
  webstore: () => { win.focus(); runCommand('ext-store') },
  'export-data': () => exportData(),
  'claude-key': () => promptClaudeKey(),
  'claude-open': () => { win.focus(); toggleChat(true) },
  'claude-signout': () => { win.focus(); signOutClaude() }
}
Object.assign(LATE_ACTIONS, {
  'settings-set': (k, v) => setSetting(k, v),
  'settings-action': (name, ...a) => { if (Object.hasOwn(SETTINGS_ACTIONS, name)) SETTINGS_ACTIONS[name](...a) },
  'settings-ready': () => sendSettings()
})

async function exportData () {
  const r = await dialog.showSaveDialog(win, { title: 'Export Drift data', defaultPath: 'Drift Export.json' })
  if (r.canceled || !r.filePath) return
  const tabsOf = (ids) => ids.map(id => S.tabs[id]).filter(Boolean).map(t => ({ title: t.customTitle || t.title, url: t.pinnedUrl || t.url }))
  const data = {
    exportedAt: new Date().toISOString(),
    profiles: S.profiles.map(p => ({ name: p.name, favorites: tabsOf(p.favorites) })),
    spaces: S.spaces.map(s => ({ name: s.name, color: s.color, profile: profile(s.profileId)?.name, pinned: tabsOf(s.pinned), today: tabsOf(s.today) })),
    archive: S.archive, history: S.history, boosts: S.boosts, settings: S.settings
  }
  fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2)); toast('Data exported (passwords not included)')
}

// ---------------------------------------------------------------- icon, hotkeys, quit
function applyIcon () {
  const f = path.join(UI_DIR, 'icons', (S.settings.icon || 'aurora') + '.png')
  if (!fs.existsSync(f)) return
  if (isMac && app.dock) app.dock.setIcon(nativeImage.createFromPath(f))
  else win?.setIcon(nativeImage.createFromPath(f))
}
function registerHotkeys () {
  globalShortcut.unregisterAll()
  if (S.settings.miniHotkey && !PRIVATE) { try { globalShortcut.register('Alt+CommandOrControl+N', () => openMini()) } catch {} }
}
let quitArmed = 0
function requestQuit () {
  if (!S.settings.warnBeforeQuit || Date.now() - quitArmed < 2500) return app.quit()
  quitArmed = Date.now(); toast('Press ⌘Q again to quit')
}

// ---------------------------------------------------------------- MCP (Claude & other MCP clients)
let mcp = null
const MCP_TOOLS = [
  { name: 'list_tabs', description: 'List open tabs in every space (id, title, url, space, section, active).', inputSchema: { type: 'object', properties: {} } },
  { name: 'open_url', description: 'Open a URL (or a search query) in a new tab and switch to it.', inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL or search terms' } }, required: ['url'] } },
  { name: 'switch_tab', description: 'Switch to a tab by id.', inputSchema: { type: 'object', properties: { tab_id: { type: 'string' } }, required: ['tab_id'] } },
  { name: 'close_tab', description: 'Close a tab by id (it goes to the archive).', inputSchema: { type: 'object', properties: { tab_id: { type: 'string' } }, required: ['tab_id'] } },
  { name: 'get_page_text', description: 'Read the visible text, title and URL of a tab (the active tab if no id). Requires “Allow reading page content”.', inputSchema: { type: 'object', properties: { tab_id: { type: 'string' }, max_chars: { type: 'number' } } } },
  { name: 'search_history', description: 'Search browsing history by title or URL.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'list_spaces', description: 'List spaces with their profile and colour.', inputSchema: { type: 'object', properties: {} } },
  { name: 'switch_space', description: 'Switch to a space by id or name.', inputSchema: { type: 'object', properties: { space: { type: 'string' } }, required: ['space'] } },
  { name: 'search_archive', description: 'Search archived (auto-closed) tabs.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'inspect_site', description: 'Security report for a tab: certificate, security headers grade, cookies, tech stack.', inputSchema: { type: 'object', properties: { tab_id: { type: 'string' } } } }
]
const mcpMatch = (q, ...f) => f.some(x => (x || '').toLowerCase().includes(String(q || '').toLowerCase()))
async function mcpCall (name, a) {
  const tabInfo = (id, sp, section) => ({ id, title: tab(id).customTitle || tab(id).title, url: tab(id).url, space: sp, section, active: id === activeTabId() })
  switch (name) {
    case 'list_tabs': {
      const out = []
      for (const sp of S.spaces) { for (const id of sp.pinned) out.push(tabInfo(id, sp.name, 'pinned')); for (const id of sp.today) out.push(tabInfo(id, sp.name, 'today')) }
      for (const p of S.profiles) for (const id of p.favorites) out.push(tabInfo(id, `favorites (${p.name})`, 'favorite'))
      return out
    }
    case 'open_url': { const u = normalizeInput(String(a.url || '')); if (!u || !isSafeWebUrl(u)) throw new Error('Invalid URL'); const id = newTab(u); return { tab_id: id, url: u } }
    case 'switch_tab': if (!tab(a.tab_id)) throw new Error('No such tab'); activateTab(a.tab_id); return 'ok'
    case 'close_tab': if (!tab(a.tab_id)) throw new Error('No such tab'); closeTab(a.tab_id); return 'ok'
    case 'get_page_text': {
      if (!S.settings.mcpReadPages) throw new Error('Reading page content is turned off in Drift → Settings → Integrations.')
      const id = a.tab_id || activeTabId(); if (!tab(id)) throw new Error('No such tab')
      const v = ensureView(id)
      if (v.webContents.isLoading()) await new Promise(r => { v.webContents.once('did-stop-loading', r); setTimeout(r, 15000) })
      const max = Math.min(Number(a.max_chars) || 40000, 200000)
      const text = await v.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: 'document.body ? document.body.innerText : ""' }])
      return { title: v.webContents.getTitle(), url: v.webContents.getURL(), text: String(text).slice(0, max) }
    }
    case 'search_history': return S.history.filter(h => mcpMatch(a.query, h.title, h.url)).slice(0, Math.min(a.limit || 25, 200)).map(h => ({ title: h.title, url: h.url, visited: new Date(h.t).toISOString() }))
    case 'list_spaces': return S.spaces.map(s => ({ id: s.id, name: s.name, color: s.color, profile: profile(s.profileId)?.name, active: s.id === S.activeSpaceId }))
    case 'switch_space': { const sp = S.spaces.find(s => s.id === a.space || s.name.toLowerCase() === String(a.space).toLowerCase()); if (!sp) throw new Error('No such space'); switchSpace(sp.id); return 'ok' }
    case 'search_archive': return S.archive.filter(x => mcpMatch(a.query, x.title, x.url)).slice(0, 50).map(x => ({ title: x.title, url: x.url, archived: new Date(x.archivedAt).toISOString() }))
    case 'inspect_site': {
      const id = a.tab_id || activeTabId(); const v = views.get(id); if (!v) throw new Error('Tab is not loaded')
      return inspector.report({ wc: v.webContents, url: v.webContents.getURL(), ses: v.webContents.session, blocked: live.get(id)?.blocked || 0, permissions: S.permissions[originOf(v.webContents.getURL())] })
    }
  }
  throw new Error('Unknown tool ' + name)
}
function setupMcp () {
  if (mcp) { mcp.stop(); mcp = null }
  if (S.settings.mcpEnabled && !PRIVATE) mcp = startMcp({ configFile: mcpConfigFile(), tools: () => MCP_TOOLS, onCall: mcpCall })
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
    { label: 'Open in Split View', enabled: !!sp.activeTabId && sp.activeTabId !== tabId && !inSplit(sp, tabId), click: () => openSplit(tabId) },
    ...(inSplit(sp, tabId) ? [{ label: 'Remove from Split View', click: () => { removeFromSplit(sp, tabId); layout(); pushState(); store.save() } }] : []),
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
    return { id, title: x.customTitle || x.title, url: x.url, favicon: iconFor(x), loaded: !!l, loading: l?.loading, audible: l?.audible, muted: l?.muted }
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
    chatOpen,
    tidyTabs: S.settings.tidyTabs,
    sidebarWidth: S.settings.sidebarWidth,
    nav: { canBack: l?.canBack, canFwd: l?.canFwd, loading: l?.loading, url: tab(act)?.url || '', blocked: l?.blocked || 0 },
    settings: { blocker: S.settings.blocker, httpsOnly: S.settings.httpsOnly },
    downloads: downloads.slice(0, 5),
    isMac,
    fullscreen: win.isFullScreen(),
    private: PRIVATE,
    partition: partitionFor(sp.profileId),
    extensions: PRIVATE ? 0 : allExtensions().length,
    activeWcId: views.get(act)?.webContents.id || null
  })
}
function toast (msg) { win?.webContents.send('toast', msg) }

// ---------------------------------------------------------------- IPC (only from our own UI views)
const isOurUI = (e) => e.sender === win?.webContents || e.sender === overlay?.webContents || (settingsWin && !settingsWin.isDestroyed() && e.sender === settingsWin.webContents) || [...miniWindows].some(m => e.sender === m.ui) || (chatView && e.sender === chatView.webContents) || (claudeBar && e.sender === claudeBar.webContents) || (dragShield && e.sender === dragShield.webContents)
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
  'split-drag-start': (i) => startSplitDrag(Number(i)),
  'split-drag': (x, y) => splitDrag(Number(x), Number(y)),
  'split-drag-end': () => endSplitDrag(),
  'split-equalize': () => { const sp = space(); if (sp.split) { sp.split.sizes = sp.split.ids.map(() => 1 / sp.split.ids.length); layout(); store.save() } },
  'split-focus': (id) => { if (inSplit(space(), id)) activateTab(id) },
  unsplit,
  mute: (id) => toggleMute(id),
  'open-download': (p) => { if (downloads.some(d => d.path === p)) shell.showItemInFolder(p) },
  'show-archive': () => openOverlay({ mode: 'archive', query: '' }),
  // overlay → main
  'overlay-close': closeOverlay,
  'tidy-tabs': tidyTabs,
  rename: (id) => { const t = tab(id); if (t) prompt('Rename tab', t.customTitle || t.title, (v) => { if (v != null) { if (v) t.customTitle = v; else delete t.customTitle; store.save(); pushState() } }) },
  library: () => openLibrary(),
  inspect: () => openInspector(),
  settings: (page) => openSettings(page),
  'peek-open-tab': () => { const u = peekView?.webContents.getURL(); closeOverlay(); if (u) newTab(u) },
  'peek-split': () => { const u = peekView?.webContents.getURL(); closeOverlay(); if (u) openSplit(u) },
  instant: (text) => { closeOverlay(); for (const q of String(text).split(',').map(x => x.trim()).filter(Boolean).slice(0, 6)) newTab('https://duckduckgo.com/?q=' + encodeURIComponent('\\ ' + q)) },
  'palette-submit': (r) => {
    const mode = overlayOpen?.mode
    closeOverlay()
    if (!r) return
    if (r.type === 'command') return runCommand(r.id)
    if (r.type === 'claude' && accountMode()) return askClaudeAccount(String(r.text || ''))
    if (r.type === 'claude') {
      const wasOpen = chatOpen; toggleChat(true)
      const askIt = () => chatView.webContents.send('chat', 'ask', String(r.text || ''))
      if (!wasOpen && chatView.webContents.isLoading()) chatView.webContents.once('did-finish-load', () => setTimeout(askIt, 200)); else askIt()
      return
    }
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
Object.assign(ACTIONS, LATE_ACTIONS)
let uiSender = null // webContents that sent the IPC action being handled
ipcMain.on('ui', (e, action, ...args) => {
  if (!isOurUI(e) || !Object.hasOwn(ACTIONS, action)) return
  uiSender = e.sender
  try { ACTIONS[action](...args) } catch (err) { console.error(action, err) } finally { uiSender = null }
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
    ...(isMac ? [{ label: 'Drift', submenu: [{ role: 'about' }, { label: 'Check for Updates…', click: () => checkForUpdates(true) }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { label: 'Settings…', accelerator: 'Cmd+,', click: () => openSettings() }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { label: 'Quit Drift', accelerator: 'Cmd+Q', click: requestQuit }] }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => commandBar('new') },
        { label: 'Open Location', accelerator: 'CmdOrCtrl+L', click: () => commandBar('edit') },
        { label: 'Command Bar', accelerator: 'CmdOrCtrl+K', click: () => commandBar('new'), visible: false },
        { label: 'New Private Window', accelerator: 'CmdOrCtrl+Shift+N', click: openPrivateWindow },
        { label: 'New Little Window', click: () => openMini() },
        { label: 'New Space…', click: () => runCommand('new-space') },
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
        { label: 'Copy URL', accelerator: 'CmdOrCtrl+Shift+C', click: () => copyUrl() },
        { type: 'separator' },
        { label: 'Passwords…', click: () => showPasswords() },
        { label: 'Extensions…', click: () => manageExtensions() },
        { label: 'Site Inspector', accelerator: isMac ? 'Cmd+Shift+I' : 'Ctrl+Shift+U', click: () => openInspector() },
        { label: 'Ask Claude', accelerator: 'CmdOrCtrl+E', click: () => toggleChat() },
        { label: 'Boost This Site…', click: () => boostSite() },
        ...(isMac ? [] : [{ label: 'Settings…', accelerator: 'Ctrl+,', click: () => openSettings() }])]
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
        { label: 'Split Side by Side', click: () => setSplitDir('row') },
        { label: 'Split Stacked', click: () => setSplitDir('col') },
        { type: 'separator' },
        { label: 'Pop Out Video', accelerator: 'Alt+CmdOrCtrl+P', click: () => runCommand('pip') },
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
    title: PRIVATE ? 'Drift — Private' : 'Drift',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 18 },
    vibrancy: isMac ? 'sidebar' : undefined,
    visualEffectState: 'followWindow',
    backgroundColor: isMac ? '#00000000' : (nativeTheme.shouldUseDarkColors ? '#1c1b22' : '#efeaf9'),
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: { preload: fs.existsSync(MAIN_PRELOAD) ? MAIN_PRELOAD : PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false }
  })
  win.loadFile(path.join(UI_DIR, 'index.html'))
  win.webContents.on('will-navigate', e => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.once('ready-to-show', () => win.show())
  win.on('resize', layout)
  win.on('enter-full-screen', pushState)
  win.on('leave-full-screen', () => { if (htmlFullscreen) navActive(wc => wc.executeJavaScript('document.fullscreenElement && document.exitFullscreen()').catch(() => {})); pushState() })
  win.on('close', () => store.saveNow())
  // Switching to another app: pop the playing video out so it keeps playing on top; bring it back on return
  win.on('blur', () => setTimeout(() => {
    if (!S.settings.pipOnAppSwitch || !win || win.isDestroyed() || BrowserWindow.getFocusedWindow()) return
    const id = activeTabId(); if (id) popOutVideo(id, { auto: true })
  }, 250))
  win.on('focus', () => { if (pip?.auto && pip.tabId === activeTabId()) returnVideo(pip.tabId) })
  win.on('closed', () => { for (const m of miniWindows) m.win.close() })
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
    if (sp.split && sp.split.a) sp.split = { ids: [sp.split.a, sp.split.b], dir: 'row', sizes: [sp.split.ratio || 0.5, 1 - (sp.split.ratio || 0.5)] }
    if (sp.split) {
      const keep = sp.split.ids.map((id, i) => [id, sp.split.sizes?.[i] || 1]).filter(([id]) => seen.has(id)).slice(0, MAX_SPLIT)
      const sum = keep.reduce((a, [, f]) => a + f, 0)
      sp.split = keep.length >= 2 ? { ids: keep.map(([id]) => id), dir: sp.split.dir === 'col' ? 'col' : 'row', sizes: keep.map(([, f]) => f / sum) } : null
    }
  }
  for (const id of Object.keys(S.tabs)) if (!seen.has(id)) delete S.tabs[id]
  if (!space()) S.activeSpaceId = S.spaces[0].id
  for (const sp of S.spaces) if (sp.activeTabId && !seen.has(sp.activeTabId)) sp.activeTabId = null
}

let pendingOpenUrls = []
const openExternalLink = (url) => (S.settings.miniForExternal ? openMini(url) : newTab(url))
app.on('open-url', (e, url) => { e.preventDefault(); if (win && S) openExternalLink(url); else pendingOpenUrls.push(url) })
app.on('second-instance', (_e, argv) => {
  const url = argv.find(a => /^https?:\/\//.test(a)); if (url && S) openExternalLink(url)
  if (win) { if (win.isMinimized()) win.restore(); win.focus() }
})

// Never allow any webContents to create a <webview> or get node access
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault())
})

app.whenReady().then(() => {
  store = new Store(path.join(app.getPath('userData'), 'drift-state.json'), DEFAULTS)
  S = store.state
  S.sync = { ...DEFAULTS.sync, ...(S.sync || {}) }
  passwords = createPasswords({
    file: path.join(app.getPath('userData'), 'drift-passwords.json'),
    getWin: () => win,
    isPrivate: PRIVATE,
    isTab: (wc) => wcToTab.has(wc.id),
    toast
  })
  if (!PRIVATE) {
    try { require('electron-chrome-extensions').ElectronChromeExtensions.handleCRXProtocol(session.defaultSession) } catch {}
  }
  sanitizeState()
  if (!PRIVATE && !Object.keys(S.tabs).length && !S.history.length) {
    // first run: a couple of sensible favourites
    for (const u of ['https://www.google.com', 'https://www.youtube.com', 'https://github.com']) {
      const id = uid('t'); S.tabs[id] = { id, url: u, pinnedUrl: u, title: new URL(u).host, favicon: null, lastActiveAt: Date.now() }
      S.profiles[0].favorites.push(id)
    }
  }
  if (!S.settings.restoreSession && !PRIVATE) {
    for (const sp of S.spaces) { for (const id of sp.today) { archiveEntry(S.tabs[id], sp.id); delete S.tabs[id] } sp.today = []; sp.split = null }
    sanitizeState()
  }
  if (S.settings.blocker) adblock.load(app.getPath('userData'), { strictMode: S.settings.strictBlocking }).then(r => console.log('adblock:', r))
  buildMenu()
  createWindow()
  applyIcon()
  registerHotkeys()
  setupMcp()
  const cli = process.argv.slice(1).filter(a => /^https?:\/\//.test(a))
  for (const u of [...pendingOpenUrls, ...cli]) openExternalLink(u)
  if (!PRIVATE) {
    for (const p of S.profiles) {
      const ses = getSession(p.id)
      for (const dir of S.unpackedExtensions || []) (ses.extensions || ses).loadExtension(dir).catch(() => {})
    }
    setTimeout(() => runSync(false), 3000)
    setInterval(() => runSync(false), 2 * 60e3)
  }
  setInterval(autoArchive, 60e3)
  autoArchive()
  if (!PRIVATE && S.settings.autoUpdate) setTimeout(() => checkForUpdates(false), 10e3)
  setInterval(() => checkForUpdates(false), 4 * HOUR)
  app.on('activate', () => { if (!win) createWindow() })
})

app.on('window-all-closed', () => { if (!isMac) app.quit() })
app.on('before-quit', () => { if (!PRIVATE) { store?.saveNow(); runSync(false) } })
app.on('will-quit', () => {
  globalShortcut.unregisterAll(); mcp?.stop()
  if (privateDir) try { fs.rmSync(privateDir, { recursive: true, force: true }) } catch {} })

// test hook: DRIFT_SELFTEST=1 runs a scripted smoke test then exits
if (process.env.DRIFT_SELFTEST) require('./selftest')({ app, get win () { return win }, get S () { return S }, newTab, activateTab, openSplit, togglePin, toggleFavorite, createSpace, switchSpace, closeTab, autoArchive, views, live, layout, commandBar, closeOverlay, runCommand, ACTIONS, get passwords () { return passwords }, get peekView () { return peekView }, miniWindows, get settingsWin () { return settingsWin }, get chatView () { return chatView }, get claudeWeb () { return claudeWeb }, get claudeBar () { return claudeBar }, setClaudeMode, addPageToClaude, chatMenu, popOutVideo, returnVideo, get pip () { return pip }, startSplitDrag, splitDrag, endSplitDrag, setSplitDir, removeFromSplit, get lastLayout () { return lastLayout }, get chatOpen () { return chatOpen }, inspector, adblock, setSetting, mcpConfigFile, mcpBridgePath, tidyTitle, tidyTabs, memorySaver, openInspector, openPeek, openMini, openSettings, toggleChat, tidyDownloadName, runSync, tab, space, get overlayOpen () { return overlayOpen }, get overlay () { return overlay } })
