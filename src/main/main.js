'use strict'
const {
  app, BrowserWindow, WebContentsView, Menu, ipcMain, session, dialog, shell,
  clipboard, ClipboardItem, protocol, net, nativeTheme, desktopCapturer, globalShortcut, nativeImage, webContents, screen
} = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn, execFile } = require('child_process')
const { Store } = require('./store')
const { isBlockedHost } = require('./blocker')
const { createPasswords } = require('./passwords')
const sync = require('./sync')
const adblock = require('./adblock')
const inspector = require('./inspector')
const { startMcp } = require('./mcp')
const finder = require('./find')
const safebrowsing = require('./safebrowsing')
const visuals = require('./visuals')
const { createClaudeChat, MODELS: CLAUDE_MODELS } = require('./claude')

const isMac = process.platform === 'darwin'
const UI_DIR = path.resolve(__dirname, '..', 'ui')
// Drift's own UI is served from a private, secure scheme (drift-ui://app/…) instead of file://,
// so the GrantFileProtocolExtraPrivileges fuse can stay off. Only Drift's UI session can load it.
protocol.registerSchemesAsPrivileged([{ scheme: 'drift-ui', privileges: { standard: true, secure: true } }])
const UI_MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' }
function uiURL (file, query) {
  const u = new URL('drift-ui://app/' + file)
  for (const [k, v] of Object.entries(query || {})) u.searchParams.set(k, String(v))
  return u.toString()
}
function serveUI () {
  protocol.handle('drift-ui', async (req) => {
    let u; try { u = new URL(req.url) } catch { return new Response('Bad request', { status: 400 }) }
    const file = path.resolve(UI_DIR, decodeURIComponent(u.pathname).replace(/^\/+/, ''))
    const type = UI_MIME[path.extname(file)]
    if (u.host !== 'app' || !file.startsWith(UI_DIR + path.sep) || !type) return new Response('Not found', { status: 404 })
    try {
      return new Response(await fs.promises.readFile(file), { headers: { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' } })
    } catch { return new Response('Not found', { status: 404 }) }
  })
}
const PRELOAD = path.join(__dirname, '..', 'preload', 'ui.js')
const MAIN_PRELOAD = path.join(__dirname, '..', 'preload', 'ui-main.js')
const WEB_PRELOAD = path.join(__dirname, '..', 'preload', 'web.js')
const ERROR_PAGE = path.join(__dirname, '..', 'web', 'error.html')
let errorHtml = null
// Error / warning pages open inside website tabs as self-contained data: pages (strict CSP inside),
// with their parameters in the URL fragment.
function showErrorPage (wc, params) {
  if (!wc || wc.isDestroyed()) return
  errorHtml = errorHtml || fs.readFileSync(ERROR_PAGE)
  wc.loadURL('data:text/html;charset=utf-8;base64,' + errorHtml.toString('base64') + '#' + new URLSearchParams(params).toString()).catch(() => {})
}
const isInternalPage = (u) => typeof u === 'string' && u.startsWith('data:text/html')
// The address an error / warning page stands in for (it's in the page's #fragment)
const failedUrlOf = (u) => { try { return new URLSearchParams(new URL(u).hash.slice(1)).get('url') } catch { return null } }

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

// Space themes (Arc-style): 1–3 colour gradient, light / dark / auto, grain, intensity
const THEME_PRESETS = [
  ['Lavender', ['#b9a7ff', '#f2b6d8']], ['Lagoon', ['#9fb3cc', '#79c3c0']], ['Sunset', ['#ffb48a', '#ff7aa2']],
  ['Mint', ['#9fe3c1', '#c9f0a6']], ['Sky', ['#9cc9ff', '#c4b5ff']], ['Peach', ['#ffd3b0', '#ffb3c4']],
  ['Lemon', ['#fff0a3', '#ffcf7a']], ['Rose', ['#ff9fb4']], ['Aurora', ['#7c5cff', '#2bb3a3', '#ff6b8b']],
  ['Forest', ['#4f8a68', '#a9cc8f']], ['Midnight', ['#2d2f7a', '#7041a8']], ['Graphite', ['#8e9196']]
]
const defaultTheme = (color) => ({ colors: [color || COLORS[0]], mode: 'auto', grain: true, intensity: 0.6 })
function cleanTheme (t, fallback) {
  const colors = Array.isArray(t?.colors) ? t.colors.filter(c => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 3) : []
  return {
    colors: colors.length ? colors : [fallback || COLORS[0]],
    mode: ['auto', 'light', 'dark'].includes(t?.mode) ? t.mode : 'auto',
    grain: t?.grain !== false,
    intensity: Math.max(0.2, Math.min(1, Number(t?.intensity) || 0.6))
  }
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
    sidebarWidth: 285,
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
    favPreviews: true,
    dimUnloaded: true,
    safeBrowsing: true,
    pinnedResetButton: true,
    findHighlightAll: true,
    findMatchCase: false,
    findDiacritics: false,
    findWholeWords: false,
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
  spaces: [{ id: 'home', name: 'Home', icon: '', color: COLORS[0], theme: defaultTheme(COLORS[0]), profileId: 'default', pinned: [], today: [], activeTabId: null, split: null }],
  tabs: {},
  folders: {},
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
let extSync = false // true while Drift tells the extension library about its own tab changes, so its selectTab callback doesn't echo them back
let win = null
let overlay = null // command bar / find bar / prompts
let overlayOpen = null // { mode, ... }
let sidebarPeek = false
let htmlFullscreen = null // tabId in HTML fullscreen
const views = new Map() // tabId -> WebContentsView
const wcToTab = new Map() // webContents.id -> tabId
const live = new Map() // tabId -> { loading, canBack, canFwd, blocked, audible, muted }
const recentlyClosed = []
const downloads = [] // persisted as S.downloads (newest first)
const activeDownloads = new Map() // id -> DownloadItem
const downloadThumbs = new Map() // id -> data URL (Quick Look thumbnail or file icon)
const httpFallbackHosts = new Set()
const upgradedHosts = new Set()
const safeBypass = new Set() // hosts you chose to visit despite a warning (this session only)
const dangerPending = new Map() // webContentsId -> warning to show once the blocked load fails
const configuredSessions = new Set()
const pending = {} // prompt/pick callbacks

const space = (id = S.activeSpaceId) => S.spaces.find(s => s.id === id)
const profile = (id) => S.profiles.find(p => p.id === id)
const activeTabId = () => space()?.activeTabId || null
const tab = (id) => S.tabs[id]
// Split view: up to 4 tabs side by side ('row') or stacked ('col'); sizes are fractions summing to 1
const MAX_SPLIT = 4
const inSplit = (sp, id) => !!sp?.split && sp.split.ids.includes(id)

// Folders: sp.pinned and sp.today hold tab ids and folder ids; S.folders[fid] = { id, name, open, items: [tabIds], tidyHost? }
// (a Today folder is made by Tidy and disappears when its last tab does)
const pinnedTabs = (sp) => sp.pinned.flatMap(id => S.folders[id] ? S.folders[id].items : [id])
const todayTabs = (sp) => sp.today.flatMap(id => S.folders[id] ? S.folders[id].items : [id])
const todayListOf = (sp, id) => [sp.today, ...sp.today.map(f => S.folders[f]?.items)].find(l => l?.includes(id))
function dropToday (sp, id) { const l = todayListOf(sp, id); if (l) l.splice(l.indexOf(id), 1) }
function pruneToday (sp) {
  for (let i = sp.today.length - 1; i >= 0; i--) { const f = S.folders[sp.today[i]]; if (f && !f.items.length) { delete S.folders[sp.today[i]]; sp.today.splice(i, 1) } }
}
function locate (tabId) {
  for (const sp of S.spaces) {
    for (const fid of sp.pinned) if (S.folders[fid]?.items.includes(tabId)) return { type: 'pinned', space: sp, list: S.folders[fid].items, folder: fid }
    if (sp.pinned.includes(tabId)) return { type: 'pinned', space: sp, list: sp.pinned }
    for (const fid of sp.today) if (S.folders[fid]?.items.includes(tabId)) return { type: 'today', space: sp, list: S.folders[fid].items, folder: fid }
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
    const threat = S.settings.safeBrowsing && !safeBypass.has(u.hostname) ? safebrowsing.check(details.url) : null
    if (details.resourceType === 'mainFrame') {
      if (threat) {
        // Tabs show the warning from their did-fail-load (no race with the generic error page);
        // other views (Peek, Little Window, Claude panel) get it directly.
        const params = { kind: 'danger', url: details.url, threat }
        if (wcToTab.has(details.webContentsId)) {
          const id = details.webContentsId; dangerPending.set(id, params)
          setTimeout(() => { if (dangerPending.get(id) === params) { dangerPending.delete(id); showErrorPage(webContents.fromId(id), params) } }, 1500)
        }
        else { const wc = webContents.fromId(details.webContentsId); setImmediate(() => showErrorPage(wc, params)) }
        return cb({ cancel: true })
      }
      if (S.settings.httpsOnly && u.protocol === 'http:' && !httpFallbackHosts.has(u.host) &&
          !/^(localhost|127\.|10\.|192\.168\.|\[::1\])/.test(u.hostname) && !u.hostname.endsWith('.local')) {
        upgradedHosts.add(u.host)
        u.protocol = 'https:'
        return cb({ redirectURL: u.toString() })
      }
      return cb({})
    }
    if (threat) return cb({ cancel: true }) // malware / phishing resources inside other pages
    if (S.settings.blocker && !siteFlag(wcToTab.get(details.webContentsId), 'noBlock')) {
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
    const dir = downloadDir()
    let name = item.getFilename().replace(/[/\\]/g, '_')
    const tidied = S.settings.tidyDownloads ? tidyDownloadName(name, wc && !wc.isDestroyed() ? (tab(wcToTab.get(wc.id))?.title || wc.getTitle()) : '') : null
    if (tidied) { toast(`Download renamed to ${tidied}`); name = tidied }
    const d = { id: uid('d'), name, path: '', received: 0, total: item.getTotalBytes(), state: 'progressing', startedAt: Date.now() }
    if (S.settings.downloadMode === 'ask') item.setSaveDialogOptions({ defaultPath: path.join(dir, name) })
    else {
      let target = path.join(dir, name)
      const ext = path.extname(name); const base = path.basename(name, ext)
      for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${base} (${i})${ext}`)
      item.setSavePath(target); d.path = target; d.name = path.basename(target)
    }
    downloads.unshift(d); if (downloads.length > 60) downloads.length = 60
    activeDownloads.set(d.id, item)
    toast(`Downloading ${d.name}`); pushState()
    item.on('updated', (_e2, state) => {
      d.received = item.getReceivedBytes(); d.total = item.getTotalBytes(); d.state = item.isPaused() ? 'paused' : state
      if (!d.path && item.getSavePath()) { d.path = item.getSavePath(); d.name = path.basename(d.path) }
      pushStateSoon()
    })
    item.once('done', (_e2, state) => {
      activeDownloads.delete(d.id)
      d.state = state; d.received = item.getReceivedBytes(); d.doneAt = Date.now()
      if (item.getSavePath()) { d.path = item.getSavePath(); d.name = path.basename(d.path) }
      if (state === 'completed') {
        toast(`Downloaded ${d.name}`)
        if (isMac) app.dock?.downloadFinished(d.path)
        downloadThumb(d)
      } else toast(`Download ${state}: ${d.name}`)
      store.save(); pushState()
    })
  })
  ses.setSpellCheckerEnabled(true)
  if (!PRIVATE && extensions) setupExtensions(ses)
}

function siteFlag (tabId, flag) {
  const t = tab(tabId); if (!t || !S.siteFlags) return false
  try { return !!S.siteFlags[new URL(t.url).hostname]?.[flag] } catch { return false }
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
const tabHost = (id) => { try { return new URL(tab(id).url).hostname.replace(/^www\./, '') } catch { return '' } }
const SITE_NAMES = {
  'docs.google.com': 'Google Docs', 'sheets.google.com': 'Google Sheets', 'drive.google.com': 'Google Drive', 'mail.google.com': 'Gmail', 'github.com': 'GitHub',
  'youtube.com': 'YouTube', 'x.com': 'X', 'twitter.com': 'X', 'reddit.com': 'Reddit', 'stackoverflow.com': 'Stack Overflow', 'wikipedia.org': 'Wikipedia',
  'notion.so': 'Notion', 'figma.com': 'Figma', 'linear.app': 'Linear', 'slack.com': 'Slack', 'chatgpt.com': 'ChatGPT', 'openai.com': 'OpenAI', 'claude.ai': 'Claude'
}
function siteName (host) {
  for (const [k, v] of Object.entries(SITE_NAMES)) if (host === k || host.endsWith('.' + k)) return v
  const parts = host.split('.')
  if (parts.length < 2 || /^[\d.]+$/.test(host)) return host
  const label = parts.length > 2 && /^(co|com|org|net|gov|edu|ac)$/.test(parts[parts.length - 2]) ? parts[parts.length - 3] : parts[parts.length - 2]
  return label.charAt(0).toUpperCase() + label.slice(1)
}
// A group is named after what its tabs' titles share at the end ("… - YouTube", "… · GitHub"), else after the site
function groupName (host, ids) {
  const tails = ids.map(id => (tab(id).title || '').trim().split(/\s+[|\-–—·•:]\s+/)).map(p => (p.length > 1 ? p[p.length - 1].trim() : ''))
  const shared = tails[0] && tails.every(x => x.toLowerCase() === tails[0].toLowerCase()) ? tails[0].slice(0, 30) : ''
  return shared || siteName(host)
}
// Exact-duplicate URLs (never the active tab or a split tab) and the loose Today tabs of each site
function dupeTabs (sp) {
  const seen = new Set()
  return todayTabs(sp).filter(id => { const u = tab(id)?.url; if (u === undefined) return false; if (seen.has(u) && id !== sp.activeTabId && !inSplit(sp, id)) return true; seen.add(u); return false })
}
function looseByHost (sp) {
  const m = new Map()
  for (const id of sp.today) { const h = tab(id) && !inSplit(sp, id) ? tabHost(id) : ''; if (h) m.set(h, [...(m.get(h) || []), id]) }
  return m
}
const canTidy = (sp) => !!S.settings.tidyTabs && (dupeTabs(sp).length > 0 || [...looseByHost(sp).values()].some(ids => ids.length > 1))
function tidyTabs () {
  const sp = space()
  let dupes = 0
  for (const id of dupeTabs(sp)) { const t = tab(id); dropToday(sp, id); destroyView(id); archiveEntry(t, sp.id); delete S.tabs[id]; dupes++ }
  let groups = 0; let grouped = 0
  for (const [host, ids] of looseByHost(sp)) {
    if (ids.length < 2) continue
    let f = sp.today.map(id => S.folders[id]).find(x => x?.tidyHost === host)
    if (!f) { const fid = uid('f'); f = S.folders[fid] = { id: fid, name: groupName(host, ids), open: true, items: [], tidyHost: host }; sp.today.splice(sp.today.indexOf(ids[0]), 0, fid) }
    for (const id of ids) { sp.today.splice(sp.today.indexOf(id), 1); f.items.push(id) }
    f.open = true; groups++; grouped += ids.length
  }
  pruneToday(sp)
  store.save(); pushState()
  const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`
  toast(groups || dupes ? [groups && `Tidied ${plural(grouped, 'tab')} into ${plural(groups, 'group')}`, dupes && `${groups ? 'archived' : 'Archived'} ${plural(dupes, 'duplicate')}`].filter(Boolean).join(', ') : 'Nothing to tidy')
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
      selectTab: (wc) => { if (extSync) return; const id = wcToTab.get(wc.id); if (id) activateTab(id) },
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
  extSync = true
  try { extFor(tabId)?.addTab(wc, win) } finally { extSync = false }
  const vis = visualFile(t.url)
  // re-checked here too: it comes back from the state file
  const saved = t.nav?.entries?.[t.nav.index]?.url === t.url && t.nav.entries.every(e => isSafeWebUrl(e?.url)) ? t.nav : null
  if (vis) showVisual(wc, vis)
  // bring back the tab's back/forward list (after a restart, or when Memory Saver unloaded it)
  else if (saved && saved.entries.length > 1) wc.navigationHistory.restore({ entries: saved.entries, index: saved.index }).catch(() => {})
  else wc.loadURL(t.url && isSafeWebUrl(t.url) ? t.url : 'about:blank').catch(() => {})
  return view
}
// The tab's back/forward list (web pages only, at most 50 around the current one) so it survives
// unloading and restarts
function saveNav (t, wc) {
  if (PRIVATE || !t || wc.isDestroyed()) return
  const nh = wc.navigationHistory; const all = nh.getAllEntries(); const at = nh.getActiveIndex()
  const keep = all.map((e, i) => ({ url: e.url, title: String(e.title || '').slice(0, 200), i })).filter(e => e.url.length <= 2048 && isSafeWebUrl(e.url) && !isInternalPage(e.url))
  const cur = keep.findIndex(e => e.i === at)
  if (cur < 0) return
  const from = Math.max(0, Math.min(cur - 40, keep.length - 50))
  const entries = keep.slice(from, from + 50)
  t.nav = { entries: entries.map(({ url, title }) => ({ url, title })), index: cur - from }
}
// A failed load leaves two entries — the failed address and our error page for it. Keep one, so Back
// goes to the page before (it used to land on the failed address, fail again and trap you); a
// successful retry replaces the error page the same way.
function tidyHistory (wc, url) {
  const nh = wc.navigationHistory; const failed = isInternalPage(url) ? failedUrlOf(url) : null
  // also drops an earlier error page for the same address, so a retry that fails again doesn't pile up
  for (let i = nh.getActiveIndex() - 1; i >= 0; i = nh.getActiveIndex() - 1) {
    const prev = nh.getEntryAtIndex(i)?.url
    const same = isInternalPage(prev) ? failedUrlOf(prev) === (failed || url) : !!failed && prev === failed
    if (!same || !nh.removeEntryAtIndex(i)) break
  }
}

function destroyView (tabId) {
  if (!locate(tabId)) snapshots.delete(tabId)
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
    saveNav(t(), wc)
    pushStateSoon()
  }
  wc.on('did-start-loading', () => { if (st()) st().loading = true; pushStateSoon() })
  wc.on('dom-ready', () => {
    const url = wc.getURL()
    if (S.settings.blocker) { const css = adblock.cosmeticCss(url); if (css) wc.insertCSS(css).catch(() => {}) }
    const boost = boostFor(url); if (boost) wc.insertCSS(boost, { cssOrigin: 'user' }).catch(() => {})
  })
  wc.once('destroyed', () => inspector.forget(wc.id))
  wc.on('did-stop-loading', () => { if (st()) st().loading = false; updateNav(); setTimeout(() => snapshotTab(tabId), 1200) })
  wc.on('did-navigate', (_e, url) => {
    try { tidyHistory(wc, url) } catch {}
    if (isInternalPage(url)) return updateNav() // our error / warning / visual page
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
    if (!t() || (isInternalPage(wc.getURL()) && !visualFile(t().url))) return
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
    if (isMain && dangerPending.has(wc.id)) { const p = dangerPending.get(wc.id); dangerPending.delete(wc.id); return showErrorPage(wc, p) }
    if (!isMain || code === -3) return // aborted
    try {
      const u = new URL(url)
      // HTTPS-Only fallback: if an auto-upgraded site has no HTTPS, offer HTTP
      if (u.protocol === 'https:' && S.settings.httpsOnly && upgradedHosts.has(u.host)) {
        return showErrorPage(wc, { kind: 'https', url: url.replace(/^https:/, 'http:'), code: String(code), desc })
      }
    } catch {}
    showErrorPage(wc, { kind: 'error', url, code: String(code), desc })
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
    if (d.reason !== 'clean-exit') showErrorPage(wc, { kind: 'crash', url: t()?.url || '', code: d.reason, desc: '' })
  })
  wc.on('before-input-event', (e, input) => {
    // Error-page "Continue over HTTP" button signals via title change; nothing else needed here.
    if (input.type === 'keyDown' && input.key === 'Escape' && overlayOpen) { e.preventDefault(); closeOverlay() }
  })
  wc.setWindowOpenHandler(({ url, disposition, features }) => {
    if (!isSafeWebUrl(url)) return { action: 'deny' }
    if (disposition === 'new-window' && features && siteFlag(tabId, 'noPopups')) { toast('Pop-up blocked'); return { action: 'deny' } }
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
    newTab(url, { spaceId: loc?.space?.id, activate: disposition !== 'background-tab', notify: true })
    return { action: 'deny' }
  })
  wc.on('did-create-window', (child) => {
    child.webContents.on('will-navigate', (e) => guardNavigation(e, e.url, child.webContents))
    child.webContents.setWindowOpenHandler(({ url }) => { if (isSafeWebUrl(url)) newTab(url); return { action: 'deny' } })
  })
}

function guardNavigation (e, url, wc) {
  // Dangerous-site warning page: “Back to safety” / “Continue anyway”
  const cur = wc.getURL()
  if (isInternalPage(cur) && cur.includes('kind=danger')) {
    if (url.startsWith('https://back-to-safety.drift.invalid')) {
      e.preventDefault()
      // Step back to the last *safe* page: the blocked address itself is also in history (as a failed load)
      const nh = wc.navigationHistory
      const danger = new URLSearchParams(cur.split('#')[1] || '').get('url')
      let target = -1
      for (let i = nh.getActiveIndex() - 1; i >= 0; i--) {
        const u = nh.getEntryAtIndex(i)?.url
        if (u && /^https?:/.test(u) && u !== danger && !safebrowsing.check(u)) { target = i; break }
      }
      if (target >= 0) nh.goToIndex(target); else wc.loadURL('about:blank').catch(() => {})
      return
    }
    if (/^https?:/.test(url)) { try { safeBypass.add(new URL(url).hostname) } catch {} return }
  }
  if (url.startsWith('chrome-extension:')) return
  // "Continue to HTTP site" from the HTTPS-Only error page
  if (url.startsWith('http:') && isInternalPage(wc.getURL()) && wc.getURL().includes('kind=https')) {
    try { httpFallbackHosts.add(new URL(url).host) } catch {}
    return
  }
  if (/^(https?|about|data):/i.test(url)) return
  e.preventDefault()
  let scheme = ''
  try { scheme = new URL(url).protocol } catch { return }
  // never hand these to the OS: script/file access, and network shares that macOS would mount
  if (['javascript:', 'file:', 'chrome:', 'devtools:', 'smb:', 'afp:', 'nfs:', 'cifs:', 'vnc:', 'ssh:', 'x-apple.systempreferences:'].includes(scheme)) return
  dialog.showMessageBox(win, {
    type: 'question', buttons: ['Open', 'Cancel'], defaultId: 1, cancelId: 1,
    message: `Open “${scheme}” link in another application?`, detail: url.slice(0, 300)
  }).then(({ response }) => { if (response === 0) shell.openExternal(url) })
}

function pageContextMenu (tabId, wc, p) {
  const items = []
  if (p.linkURL) {
    items.push(
      { label: 'Open Link in New Tab', click: () => newTab(p.linkURL, { activate: false, notify: true }) },
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
    { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => goBack(wc) },
    { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => goForward(wc) },
    { label: 'Reload', click: () => reloadPage(wc) },
    { type: 'separator' },
    { label: 'Copy Page URL', click: () => copyUrl(tabId) },
    { label: 'Inspect Element', click: () => wc.inspectElement(p.x, p.y) })
  const extItems = (() => { try { return extFor(tabId)?.getContextMenuItems(wc, p) || [] } catch { return [] } })()
  if (extItems.length) items.push({ type: 'separator' }, ...extItems)
  Menu.buildFromTemplate(items).popup(menuOpts())
}

// ---------------------------------------------------------------- tab ops
function newTab (url, { spaceId = S.activeSpaceId, activate = true, notify = false } = {}) {
  const id = uid('t')
  S.tabs[id] = { id, url, title: url, favicon: null, createdAt: Date.now(), lastActiveAt: Date.now() }
  const sp = space(spaceId)
  sp.today.unshift(id)
  if (activate) activateTab(id)
  else { ensureView(id); pushState(); if (notify) showTabNotice(id) }
  store.save()
  return id
}

function activateTab (tabId, { from } = {}) {
  if (!tab(tabId)) return
  const shown = from !== undefined ? from : activeTabId() // the tab on screen, even in the space we're leaving
  const loc = locate(tabId)
  if (loc?.space && loc.space.id !== S.activeSpaceId) S.activeSpaceId = loc.space.id
  const sp = space()
  const prev = sp.activeTabId
  if (prev && prev !== tabId) snapshotTab(prev)
  hideFavPreview()
  if (popoverOpen) closePopover()
  popOutOnLeave(shown, tabId)
  if (pip?.auto && pip.tabId === tabId) returnVideo(tabId)

  sp.activeTabId = tabId
  tab(tabId).lastActiveAt = Date.now()
  ensureView(tabId)
  extSync = true
  try { extFor(tabId)?.selectTab(views.get(tabId).webContents) } catch {} finally { extSync = false }
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
    const idx = todayTabs(sp).indexOf(tabId)
    dropToday(sp, tabId)
    destroyView(tabId)
    recentlyClosed.push({ url: t.url, title: t.title, spaceId: sp.id })
    if (archive) archiveEntry(t, sp.id)
    delete S.tabs[tabId]
    pruneToday(sp)
    const rest = todayTabs(sp)
    if (sp.activeTabId === tabId) sp.activeTabId = rest[Math.min(idx, rest.length - 1)] || pinnedTabs(sp)[0] || null
  }
  const now = space().activeTabId
  if (now) activateTab(now); else { layout(); pushState() }
  store.save()
}

function pickNeighbor (sp, tabId) {
  const all = [...profile(sp.profileId).favorites, ...pinnedTabs(sp), ...todayTabs(sp)].filter(id => id !== tabId && views.has(id))
  return all[0] || todayTabs(sp)[0] || null
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
    for (const id of todayTabs(sp)) {
      const t = tab(id)
      if (!t || id === sp.activeTabId) continue
      if (inSplit(sp, id) || pip?.tabId === id) continue
      if (live.get(id)?.audible) continue
      if (now - (t.lastActiveAt || 0) > limit) {
        dropToday(sp, id)
        destroyView(id)
        archiveEntry(t, sp.id)
        delete S.tabs[id]
        changed = true
      }
    }
    pruneToday(sp)
  }
  if (changed) { store.save(); layout(); pushState() }
}

function clearToday () {
  const sp = space()
  for (const id of todayTabs(sp)) {
    if (inSplit(sp, id)) continue
    const t = tab(id); dropToday(sp, id); destroyView(id); archiveEntry(t, sp.id); delete S.tabs[id]
  }
  pruneToday(sp)
  if (!tab(sp.activeTabId) || !locate(sp.activeTabId)) sp.activeTabId = pickNeighbor(sp, null)
  if (sp.activeTabId) activateTab(sp.activeTabId); else { layout(); pushState() }
  store.save()
}

function moveTab (tabId, to, { index = -1, spaceId = S.activeSpaceId, folderId = null } = {}) {
  const t = tab(tabId)
  const loc = locate(tabId)
  if (!t || !loc) return
  const sp = space(spaceId)
  const oldProfile = profileIdOfTab(tabId)
  loc.list.splice(loc.list.indexOf(tabId), 1)
  let list
  if (to === 'folder') { if (!S.folders[folderId] || !(sp.pinned.includes(folderId) || sp.today.includes(folderId))) { loc.list.push(tabId); return } list = S.folders[folderId].items; S.folders[folderId].open = true }
  else if (to === 'favorite') list = profile(sp.profileId).favorites
  else if (to === 'pinned') list = sp.pinned
  else list = sp.today
  if (index < 0 || index > list.length) index = to === 'today' && loc.type !== 'today' ? 0 : list.length
  list.splice(index, 0, tabId)
  if (to === 'folder') to = sp.pinned.includes(folderId) ? 'pinned' : 'today' // a tab dropped into a Today folder stays unpinned
  if (loc.space) pruneToday(loc.space)
  t.pinnedUrl = to === 'today' ? undefined : (t.pinnedUrl || t.url)
  if (to !== 'today' && loc.type === 'today' && S.settings.tidyTitles && !t.customTitle) t.customTitle = tidyTitle(t.title, t.url)
  if (to === 'today') delete t.customTitle
  if (loc.space && loc.space.id !== sp.id && loc.space.activeTabId === tabId) loc.space.activeTabId = pickNeighbor(loc.space, tabId)
  if (inSplit(loc.space, tabId) && loc.space.id !== sp.id) removeFromSplit(loc.space, tabId)
  // crossing profiles requires a fresh view in the new session
  if (oldProfile !== sp.profileId && views.has(tabId)) { destroyView(tabId); if (sp.activeTabId === tabId || S.activeSpaceId === sp.id) ensureView(tabId) }
  store.save(); layout(); pushState()
}

function newFolder () {
  const sp = space(); const fid = uid('f')
  S.folders[fid] = { id: fid, name: 'New Folder', open: true, items: [] }
  sp.pinned.unshift(fid); store.save(); pushState()
  prompt('Name this folder', 'New Folder', (n) => { if (n && S.folders[fid]) { S.folders[fid].name = n.slice(0, 60); store.save(); pushState() } })
  return fid
}
function deleteFolder (fid) {
  const f = S.folders[fid]; if (!f) return
  for (const sp of S.spaces) for (const list of [sp.pinned, sp.today]) { const i = list.indexOf(fid); if (i >= 0) list.splice(i, 1, ...f.items) }
  delete S.folders[fid]; store.save(); pushState()
}
function folderMenu (fid) {
  const f = S.folders[fid]; if (!f) return
  const today = S.spaces.some(sp => sp.today.includes(fid))
  Menu.buildFromTemplate([
    { label: 'Rename Folder…', click: () => prompt('Rename folder', f.name, (n) => { if (n) { f.name = n.slice(0, 60); store.save(); pushState() } }) },
    { label: f.open === false ? 'Expand' : 'Collapse', click: () => { f.open = f.open === false; store.save(); pushState() } },
    today
      ? { label: 'Close All Tabs in Folder', enabled: f.items.length > 0, click: () => { for (const id of [...f.items]) closeTab(id) } }
      : { label: 'Unload All Tabs in Folder', enabled: f.items.some(id => views.has(id)), click: () => { for (const id of f.items) closeTab(id) } },
    { type: 'separator' },
    { label: today ? 'Ungroup (keep its tabs)' : 'Delete Folder (keep its tabs)', click: () => deleteFolder(fid) }
  ]).popup(menuOpts())
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
    const bl = todayListOf(sp, base) || sp.today
    bl.splice(Math.max(0, bl.indexOf(base) + 1), 0, other)
  }
  if (other === base) return
  // keep a split's tabs next to each other: the sidebar shows them as one row (like Arc)
  const list = [sp.today, sp.pinned].find(l => l.includes(base) && l.includes(other))
  if (list) { list.splice(list.indexOf(other), 1); list.splice(list.indexOf(base) + 1, 0, other) }
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
// The split button in a pane's toolbar
function splitMenu (id) {
  const sp = space(); if (!sp.split) return
  const row = sp.split.dir !== 'col'
  Menu.buildFromTemplate([
    { label: row ? 'Stack Panes Vertically' : 'Place Panes Side by Side', click: () => setSplitDir(row ? 'col' : 'row') },
    { label: 'Make Panes Equal', click: () => ACTIONS['split-equalize']() },
    { label: 'Add Tab to Split View…', enabled: sp.split.ids.length < MAX_SPLIT, click: () => runCommand('split') },
    { type: 'separator' },
    { label: 'Remove This Tab from Split View', click: () => ACTIONS['pane-close'](id) },
    { label: 'Separate All Tabs', click: () => unsplit() }
  ]).popup(menuOpts())
}

// ---------------------------------------------------------------- spaces & profiles
function createSpace (name, { newProfile = false } = {}) {
  let profileId = space().profileId
  if (newProfile) {
    profileId = uid('p')
    S.profiles.push({ id: profileId, name, favorites: [] })
  }
  const id = uid('s')
  const preset = THEME_PRESETS[S.spaces.length % THEME_PRESETS.length][1]
  S.spaces.push({ id, name, icon: '', color: preset[0], theme: { ...defaultTheme(), colors: [...preset] }, profileId, pinned: [], today: [], activeTabId: null, split: null })
  switchSpace(id)
}

// The space's most recently used tab (loaded or not) — what you expect to see when you return to it
function mostRecentTab (sp) {
  const ids = [...todayTabs(sp), ...pinnedTabs(sp), ...(profile(sp.profileId)?.favorites || [])].filter(id => tab(id))
  return ids.sort((x, y) => (tab(y).lastActiveAt || 0) - (tab(x).lastActiveAt || 0))[0] || null
}
function switchSpace (id) {
  const sp = space(id); if (!sp) return
  const leaving = activeTabId()
  S.activeSpaceId = id
  const target = sp.activeTabId && tab(sp.activeTabId) ? sp.activeTabId : mostRecentTab(sp)
  if (target) activateTab(target, { from: leaving })
  else { popOutOnLeave(leaving, null); sp.activeTabId = null; layout(); pushState(); win.webContents.focus() }
  store.save()
}

function deleteSpace (id = S.activeSpaceId) {
  if (S.spaces.length <= 1) return toast('You need at least one space')
  const sp = space(id)
  for (const tid of [...pinnedTabs(sp), ...todayTabs(sp)]) { destroyView(tid); archiveEntry(tab(tid), id); delete S.tabs[tid] }
  for (const fid of [...sp.pinned, ...sp.today]) delete S.folders[fid]
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
const PANE_BAR = 36 // each split-view pane has its own toolbar (drawn by the sidebar UI, above the page)

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

  for (const [id, v] of views) if (!needed.includes(id) && !pipLinger.has(id)) { try { win.contentView.removeChildView(v) } catch {} }
  // only the docked sidebar takes room; the peeked one floats over the page (placeSidebarFloat)
  const sw = S.sidebarVisible ? S.settings.sidebarWidth : 0
  const x0 = sw || PAD
  const chatW = chatOpen && !htmlFullscreen ? CHAT_W + 6 : 0
  const area = { x: x0, y: PAD, width: Math.max(100, w - x0 - PAD - chatW), height: Math.max(100, h - PAD * 2) }
  shownPanels = []
  if (chatOpen && !htmlFullscreen) {
    const px = w - PAD - CHAT_W
    if (accountMode() && claudeBar && claudeWeb) {
      claudeBar.setBounds({ x: px, y: PAD, width: CHAT_W, height: 40 })
      claudeWeb.setBounds({ x: px, y: PAD + 44, width: CHAT_W, height: h - PAD * 2 - 44 })
      shownPanels = [claudeBar, claudeWeb]
    } else if (chatView) { chatView.setBounds({ x: px, y: PAD, width: CHAT_W, height: h - PAD * 2 }); shownPanels = [chatView] }
  }
  const rects = needed.length > 1 ? splitRects(area, sp.split) : [area]
  shownTabs = needed.map((id, i) => {
    const v = ensureView(id)
    if (htmlFullscreen) { v.setBounds({ x: 0, y: 0, width: w, height: h }); v.setBorderRadius?.(0); return v }
    v.setBorderRadius?.(10)
    const r = rects[i]
    v.setBounds(needed.length > 1 ? { x: r.x, y: r.y + PANE_BAR, width: r.width, height: r.height - PANE_BAR } : r)
    return v
  })
  placeSidebarFloat()
  restack()
  lastLayout = { area, rects, dir: sp.split?.dir || 'row' }
  if (noticeShown && noticeView) noticeView.setBounds(noticeBounds())
  win.webContents.send('layout', { area, panes: needed.length > 1 && !htmlFullscreen ? needed.map((id, i) => ({ id, ...rects[i], active: id === act })) : null, dir: sp.split?.dir || 'row' })
}

// ---------------------------------------------------------------- view stacking
// One fixed order, bottom to top: tabs, Claude panel, floating sidebar, favourite preview, popovers,
// command bar / find, Peek, drag shield. Views are only attached or moved when the order is actually
// wrong: re-adding an attached view moves it, which can flicker the page or drop keyboard focus, and
// used to bury the command bar, popovers and the split-drag shield under the tabs.
let shownTabs = []; let shownPanels = []
function restack () {
  if (!win || win.isDestroyed()) return
  const open = new Set(views.values()); const alive = (v) => v && !v.webContents.isDestroyed()
  const lingering = [...pipLinger].map(id => views.get(id)).filter(v => v && !shownTabs.includes(v))
  const want = [...lingering, ...shownTabs.filter(v => open.has(v)), ...shownPanels.filter(alive), floatAttached && sidebarFloat, toastShown && toastView, noticeShown && noticeView, previewFor && previewView, popoverOpen && popView,
    overlayOpen && overlay, peekView, dragMode && dragShield].filter(Boolean)
  const kids = win.contentView.children
  let prev = -1; let i = 0
  for (; i < want.length; i++) {
    const at = kids.indexOf(want[i])
    if (at > prev) { prev = at; continue }
    if (at >= 0) break // attached but below a view it should be above: re-add the rest on top, in order
    win.contentView.addChildView(want[i], prev + 1); prev++; kids.splice(prev, 0, want[i])
  }
  for (; i < want.length; i++) win.contentView.addChildView(want[i])
}

// ---------------------------------------------------------------- floating sidebar
// Hovering the left edge while the sidebar is hidden floats it over the page instead of pushing the
// page aside, like Arc. It's a second copy of the sidebar UI in its own view stacked above the tabs;
// only the sidebar button (⌘S) docks it and resizes the page.
const FLOAT_INSET = 6; const FLOAT_SHADOW = 28; const EDGE = PAD
let sidebarFloat = null; let floatAttached = false; let peekTimer = null; let floatShrinkTimer = null; let menuOpen = 0
function ensureSidebarFloat () {
  if (sidebarFloat) return sidebarFloat
  sidebarFloat = new WebContentsView({ webPreferences: { preload: fs.existsSync(MAIN_PRELOAD) ? MAIN_PRELOAD : PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false } })
  sidebarFloat.setBackgroundColor('#00000000')
  sidebarFloat.webContents.loadURL(uiURL('index.html', { float: 1 }))
  sidebarFloat.webContents.on('will-navigate', e => e.preventDefault())
  sidebarFloat.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return sidebarFloat
}
// While the sidebar is hidden the floating copy stays loaded and attached as a thin strip along the
// left edge (over the window margin, not the page). Hovering the strip slides the sidebar out at once
// in that view, and main only has to widen it — no page load, no layout, no full state push.
function placeSidebarFloat () {
  if (!win) return
  const hidden = !S.sidebarVisible && !htmlFullscreen
  if (!hidden) {
    clearTimeout(floatShrinkTimer); floatShrinkTimer = null
    if (sidebarFloat && floatAttached) { try { win.contentView.removeChildView(sidebarFloat) } catch {} }
    floatAttached = false
  } else {
    ensureSidebarFloat()
    floatAttached = true
    const [, h] = win.getContentSize()
    const full = { x: 0, y: 0, width: S.settings.sidebarWidth + FLOAT_INSET + FLOAT_SHADOW, height: h }
    if (sidebarPeek) { clearTimeout(floatShrinkTimer); floatShrinkTimer = null; sidebarFloat.setBounds(full) } else if (!floatShrinkTimer) {
      // let the card slide out before the view shrinks back to the edge strip
      const shrink = () => { floatShrinkTimer = null; if (!sidebarPeek && floatAttached) { const [, hh] = win.getContentSize(); sidebarFloat.setBounds({ x: 0, y: 0, width: EDGE, height: hh }) } }
      if (sidebarFloat.getBounds().width > EDGE) floatShrinkTimer = setTimeout(shrink, 170); else shrink()
    }
    restack()
  }
  // traffic lights belong to the sidebar: hidden with it, back when it peeks (like Arc)
  if (isMac && !win.isFullScreen()) win.setWindowButtonVisibility?.(!htmlFullscreen && (S.sidebarVisible || sidebarPeek))
}
function setPeek (on) {
  clearTimeout(peekTimer); peekTimer = null
  if (S.sidebarVisible || on === sidebarPeek) return
  sidebarPeek = on
  if (sidebarFloat && !sidebarFloat.webContents.isDestroyed()) sidebarFloat.webContents.send('sidebar-peek', on)
  placeSidebarFloat()
}
// The pointer left the floating sidebar (or crossed into a drag region / another view): hide it only
// once it's really outside, and not while a menu, popover or the command bar opened from it is up
// (those call this again when they close)
function peekCheck () {
  if (!sidebarPeek || S.sidebarVisible) return
  clearTimeout(peekTimer)
  peekTimer = setTimeout(() => {
    peekTimer = null
    // the find bar and link Peek aren't opened from the sidebar, so they don't keep it out
    const fromSidebar = overlayOpen && !['find', 'peek'].includes(overlayOpen.mode)
    if (!win || win.isDestroyed() || menuOpen || popoverOpen || fromSidebar || previewFor) return
    const p = screen.getCursorScreenPoint(); const c = win.getContentBounds()
    const x = p.x - c.x; const y = p.y - c.y
    if (x >= 0 && y >= 0 && y < c.height && x < S.settings.sidebarWidth + FLOAT_INSET) return
    setPeek(false)
  }, 120)
}
// Options for every native menu: counts open menus so the floating sidebar stays while one is up
function menuOpts () { menuOpen++; return { window: win, callback: () => { menuOpen = Math.max(0, menuOpen - 1); peekCheck() } } }
// The sidebar UI (docked, and the floating copy when it exists)
function sendSidebar (ch, ...a) {
  win?.webContents.send(ch, ...a)
  if (sidebarFloat && !sidebarFloat.webContents.isDestroyed()) sidebarFloat.webContents.send(ch, ...a)
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
// Dragging a split divider or the sidebar edge. The sidebar UI where the drag started follows the
// mouse itself (on macOS it keeps receiving the drag even over the pages); a transparent full-window
// shield above the pages catches it too where it doesn't, and shows the resize cursor.
let dragShield = null; let dragIndex = -1; let dragMode = null
function startShieldDrag (mode, dir) {
  dragMode = mode
  if (!dragShield) {
    dragShield = new WebContentsView({ webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false } })
    dragShield.setBackgroundColor('#00000000')
    dragShield.webContents.on('will-navigate', e => e.preventDefault())
  }
  const url = uiURL('drag-shield.html', { dir })
  if (dragShield.webContents.getURL() !== url) dragShield.webContents.loadURL(url)
  const [w, h] = win.getContentSize()
  dragShield.setBounds({ x: 0, y: 0, width: w, height: h })
  restack()
}
function startSplitDrag (index) {
  const sp = space(); if (!sp.split || index < 0 || index >= sp.split.ids.length - 1) return
  dragIndex = index
  startShieldDrag('split', sp.split.dir)
}
function setSidebarWidth (x) { S.settings.sidebarWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(x))); layout(); pushStateSoon() }
function shieldDrag (x, y) { if (dragMode === 'sidebar') setSidebarWidth(x); else splitDrag(x, y) }
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
  if (!dragMode && dragIndex < 0) return
  dragIndex = -1; dragMode = null
  if (dragShield) { try { win.contentView.removeChildView(dragShield) } catch {} }
  store.save()
}

function overlayBounds () {
  const [w, h] = win.getContentSize()
  if (overlayOpen?.mode === 'find') {
    const a = lastLayout?.area || { x: 8, y: 8, width: w - 16 }
    const fw = Math.min(760, a.width - 40)
    return { x: Math.round(a.x + (a.width - fw) / 2), y: a.y + 14, width: fw, height: 108 }
  }
  if (peekView && overlayOpen?.mode === 'peek') { const pb = peekBounds(); peekView.setBounds(pb) }
  return { x: 0, y: 0, width: w, height: h }
}

function ensureOverlay () {
  if (overlay) return overlay
  overlay = new WebContentsView({
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  overlay.setBackgroundColor('#00000000')
  overlay.webContents.loadURL(uiURL('palette.html'))
  overlay.webContents.on('will-navigate', e => e.preventDefault())
  overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return overlay
}

function openOverlay (opts) {
  ensureOverlay()
  overlayOpen = opts
  overlay.setBounds(overlayBounds())
  restack()
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
  if (wasFind && wc) { wc.stopFindInPage('clearSelection'); finder.clear(wc) }
  if (wc) wc.focus(); else win.webContents.focus()
  peekCheck()
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
    for (const id of [...pinnedTabs(s), ...todayTabs(s)]) { const t = tab(id); if (t) tabs.push({ id, title: t.title, url: t.url, favicon: iconFor(t), space: s.name }) }
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
    themeMode: space().theme.mode,
    find: { highlightAll: S.settings.findHighlightAll, matchCase: S.settings.findMatchCase, diacritics: S.settings.findDiacritics, wholeWords: S.settings.findWholeWords },
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
  { id: 'new-folder', title: 'New Folder (pinned tabs)', run: () => newFolder() },
  { id: 'task-manager', title: 'Task Manager — memory used by each tab', run: () => setTimeout(taskManager) },
  { id: 'visual', title: 'Create Visual from This Page… (slide deck, poster, infographic, dashboard)', run: () => setTimeout(chooseVisual) },
  { id: 'visual-pdf', title: 'Export Visual as PDF', run: () => exportVisualPdf() },
  { id: 'downloads-panel', title: 'Show Downloads', run: () => { downloadsOpen = true; pushState(); LATE_ACTIONS['dl-thumbs']() } },
  { id: 'new-space', title: 'New Space…', run: () => setTimeout(() => prompt('Name your new space', '', (n) => n && createSpace(n))) },
  { id: 'new-profile-space', title: 'New Space with New Profile…', run: () => setTimeout(() => prompt('Name the new profile & space', '', (n) => n && createSpace(n, { newProfile: true }))) },
  { id: 'rename-space', title: 'Rename Space…', run: () => setTimeout(() => renameSpace()) },
  { id: 'space-color', title: 'Edit Space Theme & Icon…', run: () => openSettings('spaces', S.activeSpaceId) },
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
      for (const sp of S.spaces) if (sp.activeTabId && !S.tabs[sp.activeTabId]) sp.activeTabId = pickNeighbor(sp, null) || mostRecentTab(sp)
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
  const vids = [...document.querySelectorAll('video')].filter(v => !v.paused && !v.ended && v.readyState >= 2 && !v.disablePictureInPicture)
  if (!vids.length) return false
  const v = vids.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]
  if (document.pictureInPictureElement === v) return true
  try { await v.requestPictureInPicture(); return true } catch { return false }
})()`
const PIP_OUT = `(async () => { if (!document.pictureInPictureElement) return false; await document.exitPictureInPicture().catch(() => {}); return true })()`
// Run in the page (where the video usually is) first, then in its frames all at once. Each frame gets a
// time limit: going one by one, a slow ad frame on YouTube could hold the pop-out up until it was too late.
const within = (p, ms) => Promise.race([Promise.resolve(p).catch(() => false), new Promise(r => setTimeout(() => r(false), ms))])
async function inFrames (wc, code) {
  const main = wc.mainFrame
  if (await within(main.executeJavaScript(code, true), 1500)) return true
  const subs = main.framesInSubtree.filter(f => f !== main)
  return (await Promise.all(subs.map(f => within(f.executeJavaScript(code, true), 1500)))).some(Boolean)
}
async function popOutVideo (tabId, { auto = false } = {}) {
  const v = views.get(tabId); if (!v || v.webContents.isDestroyed()) return false
  if (auto && (siteFlag(tabId, 'noPip') || !live.get(tabId)?.audible)) return false // only something that's playing
  const ok = await inFrames(v.webContents, PIP_IN)
  if (ok) pip = { tabId, auto }
  return ok
}
// Leaving a tab with a video playing: pop it out while that tab is still on screen (under the new
// one). Detached first, Chromium treats it as hidden and can stop drawing the video, so the pop-out
// failed or came up black.
const pipLinger = new Set() // tabIds kept attached under the new tab until their pop-out is done
function popOutOnLeave (prev, next) {
  if (!S.settings.pipOnLeave || !prev || prev === next || !views.has(prev) || !live.get(prev)?.audible) return
  const sp = space(); if (inSplit(sp, prev) && inSplit(sp, next)) return
  pipLinger.add(prev)
  popOutVideo(prev, { auto: true }).finally(() => { pipLinger.delete(prev); layout() })
}
async function returnVideo (tabId) {
  const v = views.get(tabId)
  if (v && !v.webContents.isDestroyed()) await inFrames(v.webContents, PIP_OUT)
  if (pip?.tabId === tabId) pip = null
}

// ---------------------------------------------------------------- Favourite hover previews
// Hover a Favorite tile: Gmail shows your latest emails (+ compose); other sites show a snapshot.
// Everything is read locally from the tab you're already signed into.
let previewView = null; let previewFor = null; let previewTimer = null
const snapshots = new Map() // tabId -> data URL of how the page last looked
const PREVIEW_W = 340; const PREVIEW_H = 420
function ensurePreviewView () {
  if (previewView) return previewView
  previewView = new WebContentsView({ webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  previewView.setBackgroundColor('#00000000')
  previewView.setBorderRadius?.(14)
  previewView.webContents.loadURL(uiURL('fav-preview.html'))
  previewView.webContents.on('will-navigate', e => e.preventDefault())
  previewView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return previewView
}
function sendPreview (data) {
  const wc = previewView.webContents
  if (wc.isLoading()) wc.once('did-finish-load', () => wc.send('preview', data)); else wc.send('preview', data)
}
const hostOf = (u) => { try { return new URL(u).hostname } catch { return '' } }
async function snapshotTab (tabId) {
  const v = views.get(tabId); const loc = locate(tabId)
  if (!v || !loc || loc.type !== 'favorite' || v.webContents.isDestroyed() || !win.contentView.children.includes(v)) return
  try {
    const img = await v.webContents.capturePage()
    if (!img.isEmpty()) {
      snapshots.delete(tabId); snapshots.set(tabId, img.resize({ width: PREVIEW_W * 2 }).toDataURL())
      while (snapshots.size > 24) snapshots.delete(snapshots.keys().next().value) // keep memory bounded
    }
  } catch {}
}
const GMAIL_SCRAPE = `(() => [...document.querySelectorAll('tr.zA')].slice(0, 10).map((r, i) => ({
  i,
  from: ((r.querySelector('.yW [email]') || r.querySelector('.yW')) || {}).innerText?.trim() || '',
  subject: (r.querySelector('.bog') || {}).innerText?.trim() || '',
  snippet: ((r.querySelector('.y2') || {}).innerText || '').replace(/^\\s*[-–]\\s*/, '').trim(),
  date: ((r.querySelector('.xW [title]') || r.querySelector('.xW')) || {}).innerText?.trim() || '',
  unread: r.classList.contains('zE')
})))()`
async function scrapeGmail (wc) {
  try { return await wc.executeJavaScriptInIsolatedWorld(997, [{ code: GMAIL_SCRAPE }]) } catch { return [] }
}
async function previewData (tabId) {
  const t = tab(tabId); if (!t) return null
  const base = { id: tabId, title: t.customTitle || t.title, url: t.url, favicon: iconFor(t) }
  const v = views.get(tabId)
  if (v && hostOf(t.url) === 'mail.google.com') {
    const items = await scrapeGmail(v.webContents)
    if (items?.length) return { ...base, kind: 'list', items, compose: true }
  }
  if (snapshots.has(tabId)) return { ...base, kind: 'snapshot', image: snapshots.get(tabId) }
  return { ...base, kind: 'info', compose: hostOf(t.url) === 'mail.google.com' }
}
async function showFavPreview (tabId, rect) {
  if (!S.settings.favPreviews || overlayOpen || !tab(tabId) || !rect) return
  clearTimeout(previewTimer)
  previewFor = tabId
  ensurePreviewView()
  const [w, h] = win.getContentSize()
  const x = Math.max(8, Math.min(Math.round(rect.x + rect.width * 0.45), w - PREVIEW_W - 8))
  const y = Math.max(8, Math.min(Math.round(rect.y + rect.height + 4), h - PREVIEW_H - 8))
  previewView.setBounds({ x, y, width: PREVIEW_W, height: PREVIEW_H }); restack()
  const t = tab(tabId)
  // Gmail favourites that aren't loaded yet are loaded in the background so the inbox can be shown
  if (!views.has(tabId) && hostOf(t.url) === 'mail.google.com') {
    sendPreview({ id: tabId, title: t.title, url: t.url, favicon: iconFor(t), kind: 'info', loading: true })
    const wc = ensureView(tabId).webContents
    await new Promise(r => { const done = () => setTimeout(r, 1500); if (wc.isLoading()) wc.once('did-stop-loading', done); else done(); setTimeout(r, 12000) })
  }
  const data = await previewData(tabId)
  if (previewFor === tabId && data) sendPreview(data)
}
function hideFavPreview (delay = 0) {
  clearTimeout(previewTimer)
  previewTimer = setTimeout(() => {
    previewFor = null
    if (previewView) { try { win.contentView.removeChildView(previewView) } catch {} }
    peekCheck()
  }, delay)
}
Object.assign(LATE_ACTIONS, {
  'fav-hover': (id, rect) => { preconnect(tab(id)?.url); showFavPreview(id, rect && { x: +rect.x, y: +rect.y, width: +rect.width, height: +rect.height }) },
  'fav-hover-end': () => hideFavPreview(280),
  'preview-hold': () => clearTimeout(previewTimer),
  'preview-release': () => hideFavPreview(200),
  'preview-open': async (id, i) => {
    hideFavPreview(); if (!tab(id)) return
    activateTab(id)
    if (Number.isInteger(i) && i >= 0) views.get(id)?.webContents.executeJavaScriptInIsolatedWorld(997, [{ code: `document.querySelectorAll('tr.zA')[${i}]?.click()` }]).catch(() => {})
  },
  'preview-compose': () => {
    const id = previewFor; hideFavPreview(); if (!id || !tab(id)) return
    activateTab(id)
    views.get(id)?.webContents.loadURL('https://mail.google.com/mail/u/0/#inbox?compose=new').catch(() => {})
  }
})

// ---------------------------------------------------------------- Downloads panel
function downloadDir () {
  return S.settings.downloadMode === 'custom' && S.settings.downloadDir && fs.existsSync(S.settings.downloadDir) ? S.settings.downloadDir : app.getPath('downloads')
}
async function downloadThumb (d) {
  if (downloadThumbs.has(d.id) || d.state !== 'completed' || !d.path || !fs.existsSync(d.path)) return
  let img = null
  try { if (isMac || process.platform === 'win32') img = await nativeImage.createThumbnailFromPath(d.path, { width: 128, height: 128 }) } catch {}
  try { if ((!img || img.isEmpty()) && /\.(png|jpe?g|gif|webp|bmp)$/i.test(d.path)) img = nativeImage.createFromPath(d.path).resize({ width: 128 }) } catch {}
  try { if (!img || img.isEmpty()) img = await app.getFileIcon(d.path, { size: 'large' }) } catch {}
  if (img && !img.isEmpty()) { downloadThumbs.set(d.id, img.toDataURL()); sendSidebar('dl-thumb', d.id, downloadThumbs.get(d.id)) }
}
const findDownload = (id) => downloads.find(d => d.id === id)
function downloadMenu (id) {
  const d = findDownload(id); if (!d) return
  const item = activeDownloads.get(id); const exists = !!d.path && fs.existsSync(d.path)
  Menu.buildFromTemplate([
    ...(item ? [
      { label: item.isPaused() ? 'Resume' : 'Pause', click: () => { item.isPaused() ? item.resume() : item.pause(); d.state = item.isPaused() ? 'paused' : 'progressing'; pushState() } },
      { label: 'Cancel Download', click: () => item.cancel() },
      { type: 'separator' }] : []),
    { label: 'Open', enabled: d.state === 'completed' && exists, click: () => shell.openPath(d.path) },
    { label: isMac ? 'Show in Finder' : 'Show in Folder', enabled: exists, click: () => shell.showItemInFolder(d.path) },
    { label: 'Copy Path', enabled: !!d.path, click: () => clipboard.writeText(d.path) },
    { type: 'separator' },
    { label: 'Remove from List', enabled: !item, click: () => { downloads.splice(downloads.indexOf(d), 1); store.save(); pushState() } },
    { label: 'Move to Trash', enabled: !item && exists, click: async () => { await shell.trashItem(d.path).catch(() => {}); downloads.splice(downloads.indexOf(d), 1); store.save(); pushState() } }
  ]).popup(menuOpts())
}
Object.assign(LATE_ACTIONS, {
  'dl-open': (id) => {
    const d = findDownload(id); if (!d) return
    if (d.state === 'completed' && d.path && fs.existsSync(d.path)) shell.openPath(d.path)
    else if (d.path && fs.existsSync(d.path)) shell.showItemInFolder(d.path)
    else toast('That file was moved or deleted')
  },
  'dl-menu': (id) => downloadMenu(id),
  'dl-drag': (id) => {
    const d = findDownload(id); if (!d || d.state !== 'completed' || !d.path || !fs.existsSync(d.path) || !uiSender) return
    const thumb = downloadThumbs.get(id)
    const icon = thumb ? nativeImage.createFromDataURL(thumb).resize({ width: 64 }) : nativeImage.createFromPath(path.join(UI_DIR, 'icons', 'aurora.png')).resize({ width: 48 })
    uiSender.startDrag({ file: d.path, icon })
  },
  'dl-thumbs': () => { for (const d of downloads.slice(0, 40)) { if (downloadThumbs.has(d.id)) sendSidebar('dl-thumb', d.id, downloadThumbs.get(d.id)); else downloadThumb(d) } },
  'dl-clear': () => { for (let i = downloads.length - 1; i >= 0; i--) if (!activeDownloads.has(downloads[i].id)) downloads.splice(i, 1); store.save(); pushState() },
  'dl-folder': () => shell.openPath(downloadDir()),
  'dl-toggle': () => { downloadsOpen = !downloadsOpen; pushState() }
})
let downloadsOpen = false

// ---------------------------------------------------------------- Popovers: + menu and site controls
let popView = null; let popItems = null
function ensurePopView () {
  if (popView) return popView
  popView = new WebContentsView({ webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  popView.setBackgroundColor('#00000000')
  popView.webContents.loadURL(uiURL('popover.html'))
  popView.webContents.on('will-navigate', e => e.preventDefault())
  popView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return popView
}
// Popovers follow the space's light/dark mode, like the sidebar
function popoverDark () { const m = space().theme?.mode; return PRIVATE || m === 'dark' || (m !== 'light' && nativeTheme.shouldUseDarkColors) }
function openPopover (data) {
  data = { ...data, dark: popoverDark() }
  ensurePopView()
  const [w, h] = win.getContentSize()
  popoverOpen = data.kind
  popView.setBounds({ x: 0, y: 0, width: w, height: h }); restack()
  const wc = popView.webContents
  const send = () => { wc.send('popover', data); wc.focus() }
  if (wc.isLoading()) wc.once('did-finish-load', send); else send()
  pushState()
}
let popoverOpen = null
function closePopover () {
  if (popView) { try { win.contentView.removeChildView(popView) } catch {} }
  popoverOpen = null; popItems = null; pushState(); peekCheck()
}
const PLUS_ITEMS = [
  { id: 'new-space', label: 'New Space', icon: 'spaces' },
  { id: 'new-folder', label: 'New Folder', icon: 'folder' },
  '-',
  { id: 'boost', label: 'New Boost', icon: 'boost' },
  { id: 'visual', label: 'New Visual', icon: 'visual' },
  '-',
  { id: 'split', label: 'New Split', icon: 'split', keys: '⌃⇧=' },
  { id: 'new-tab', label: 'New Tab', icon: 'newtab', keys: '⌘T' }
]
function plusMenu (anchor) {
  if (popoverOpen) return closePopover()
  popItems = PLUS_ITEMS
  openPopover({ kind: 'menu', anchor, place: 'above', items: PLUS_ITEMS })
}
// Per-site permissions shown in the site-controls popover (key → label)
const SITE_PERMS = [
  ['media', 'Camera & Microphone'], ['geolocation', 'Location'], ['notifications', 'Notifications'],
  ['display-capture', 'Screen Sharing'], ['clipboard-read', 'Clipboard'], ['midi', 'MIDI Devices']
]
function siteControlsData () {
  const id = activeTabId(); const t = tab(id); if (!t) return null
  let u; try { u = new URL(t.url) } catch { return null }
  const o = u.origin; const host = u.hostname; const saved = S.permissions[o] || {}
  const ses = getSession(profileIdOfTab(id))
  const exts = PRIVATE ? [] : (ses.extensions || ses).getAllExtensions().map(e => ({ id: e.id, name: e.name, icon: extIcon(e) }))
  return {
    kind: 'site', host, secure: u.protocol === 'https:', blocked: live.get(id)?.blocked || 0,
    extensions: exts,
    settings: [
      ...SITE_PERMS.map(([k, label]) => ({ key: k, label, value: saved[k] || 'ask' })),
      { key: 'pip', label: 'Automatic Picture-in-Picture', value: S.siteFlags?.[host]?.noPip ? 'block' : 'allow' },
      { key: 'popups', label: 'Pop-ups', value: S.siteFlags?.[host]?.noPopups ? 'block' : 'allow' },
      { key: 'adblock', label: 'Ad & Tracker Blocking', value: !S.settings.blocker ? 'off' : S.siteFlags?.[host]?.noBlock ? 'off' : 'on' }
    ]
  }
}
function extIcon (e) {
  try {
    const icons = e.manifest?.icons || e.manifest?.action?.default_icon || {}
    const file = typeof icons === 'string' ? icons : icons[Object.keys(icons).sort((a, b) => b - a)[0]]
    if (!file) return null
    const img = nativeImage.createFromPath(path.join(e.path, file))
    return img.isEmpty() ? null : img.resize({ width: 32 }).toDataURL()
  } catch { return null }
}
function siteControls (anchor) {
  if (popoverOpen) return closePopover()
  const data = siteControlsData(); if (!data) return toast('Open a page first')
  openPopover({ ...data, anchor, place: 'below' })
}
function setSiteSetting (key, value) {
  const t = tab(activeTabId()); if (!t) return
  let u; try { u = new URL(t.url) } catch { return }
  const host = u.hostname; S.siteFlags = S.siteFlags || {}
  if (SITE_PERMS.some(([k]) => k === key)) {
    const m = { ...(S.permissions[u.origin] || {}) }
    if (value === 'ask') delete m[key]; else if (value === 'allow' || value === 'block') m[key] = value
    if (Object.keys(m).length) S.permissions[u.origin] = m; else delete S.permissions[u.origin]
  } else {
    const f = { ...(S.siteFlags[host] || {}) }
    if (key === 'pip') f.noPip = value === 'block'
    if (key === 'popups') f.noPopups = value === 'block'
    if (key === 'adblock') { f.noBlock = value === 'off'; if (!S.settings.blocker && value === 'on') S.settings.blocker = true }
    S.siteFlags[host] = f
    if (key === 'adblock') views.get(activeTabId())?.webContents.reload()
  }
  store.save()
  popView?.webContents.send('popover', { ...siteControlsData(), anchor: null, refresh: true, dark: popoverDark() })
}
async function screenshotPage () {
  const v = views.get(activeTabId()); if (!v) return
  const img = await v.webContents.capturePage()
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([img.toPNG()], { type: 'image/png' }) })]) // Electron 45+ async clipboard
  const file = path.join(downloadDir(), `Screenshot ${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.png`)
  fs.writeFileSync(file, img.toPNG())
  const d = { id: uid('d'), name: path.basename(file), path: file, received: 1, total: 1, state: 'completed', startedAt: Date.now(), doneAt: Date.now() }
  downloads.unshift(d); downloadThumb(d); store.save(); pushState()
  toast('Screenshot copied and saved to Downloads')
  return file
}
function shareUrl () {
  const t = tab(activeTabId()); if (!t) return
  if (isMac) { try { const { ShareMenu } = require('electron'); new ShareMenu({ urls: [t.url] }).popup(menuOpts()); return } catch {} }
  copyUrl()
}
function siteMoreMenu () {
  const id = activeTabId(); const t = tab(id); const wc = views.get(id)?.webContents
  Menu.buildFromTemplate([
    { label: 'Zoom In', click: () => zoom(1) }, { label: 'Zoom Out', click: () => zoom(-1) }, { label: 'Actual Size', click: () => zoom(0) },
    { type: 'separator' },
    { label: 'Copy URL', click: () => copyUrl() },
    { label: 'Pop Out Video', click: () => runCommand('pip') },
    { label: 'Clear Cookies for This Site', enabled: !!wc, click: async () => { const cs = await wc.session.cookies.get({ url: t.url }); for (const c of cs) await wc.session.cookies.remove(t.url, c.name); toast(`Removed ${cs.length} cookies`) } },
    { label: 'Reset All Settings for This Site', click: () => { try { const u = new URL(t.url); delete S.permissions[u.origin]; delete S.siteFlags?.[u.hostname]; store.save(); toast('Site settings reset') } catch {} } }
  ]).popup(menuOpts())
}
// ---------------------------------------------------------------- speed: warm up connections, task manager
const preconnected = new Map()
function preconnect (url) {
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) return
  let origin; try { origin = new URL(url).origin } catch { return }
  if (Date.now() - (preconnected.get(origin) || 0) < 30e3) return
  preconnected.set(origin, Date.now()); if (preconnected.size > 200) preconnected.delete(preconnected.keys().next().value)
  try { getSession(space().profileId).preconnect({ url: origin, numSockets: 1 }) } catch {}
}
function tabMemory () {
  const byPid = new Map(app.getAppMetrics().map(m => [m.pid, m.memory?.workingSetSize || 0]))
  const rows = []
  for (const [id, v] of views) {
    if (v.webContents.isDestroyed() || !tab(id)) continue
    rows.push({ id, title: tab(id).customTitle || tab(id).title, kb: byPid.get(v.webContents.getOSProcessId()) || 0 })
  }
  const totalKb = [...byPid.values()].reduce((a, b) => a + b, 0)
  return { rows: rows.sort((a, b) => b.kb - a.kb), totalKb }
}
function taskManager () {
  const { rows, totalKb } = tabMemory()
  const mb = (kb) => (kb / 1024).toFixed(0) + ' MB'
  pick(`Task Manager — Drift is using ${mb(totalKb)} · ${rows.length} loaded tab${rows.length === 1 ? '' : 's'} (pick one to unload it)`,
    rows.map(r => ({ value: r.id, title: `${mb(r.kb).padStart(7)}   ${r.title}` })), (id) => {
      const loc = locate(id); if (!loc) return
      if (id === activeTabId()) return toast('That tab is open — switch away first, or close it')
      destroyView(id); pushState(); toast('Tab unloaded — it reloads when you open it')
    })
}
Object.assign(LATE_ACTIONS, {
  preconnect: (url) => preconnect(url),
  'plus-menu': (rect) => plusMenu(rect),
  'site-controls': (rect) => siteControls(rect),
  'popover-close': () => closePopover(),
  'popover-pick': (id) => {
    const kind = popoverOpen; closePopover()
    if (kind === 'menu') {
      if (id === 'new-space') return runCommand('new-space')
      if (id === 'new-folder') return newFolder()
      if (id === 'boost') return boostSite()
      if (id === 'visual') return chooseVisual()
      if (id === 'split') return runCommand('split')
      if (id === 'new-tab') return commandBar('new')
    }
    if (kind === 'site') {
      if (id === 'share') return shareUrl()
      if (id === 'boost') return boostSite()
      if (id === 'screenshot') return screenshotPage()
      if (id === 'inspect' || id === 'secure') return openInspector()
      if (id === 'more') return siteMoreMenu()
      if (id === 'add-ext') return runCommand('ext-store')
      if (typeof id === 'string' && id.startsWith('ext:')) return manageExtensions()
    }
  },
  'site-setting': (key, value) => setSiteSetting(String(key), String(value))
})

// ---------------------------------------------------------------- Create Visual (slide deck / poster / infographic / dashboard)
const VISUAL_PREFIX = 'drift://visual/'
function showVisual (wc, file) {
  if (!wc || wc.isDestroyed()) return
  let html; try { html = fs.readFileSync(file) } catch { return showErrorPage(wc, { kind: 'error', url: 'Visual', code: 'missing', desc: 'This visual was deleted' }) }
  wc.loadURL('data:text/html;charset=utf-8;base64,' + html.toString('base64')).catch(() => {})
}
function visualFile (url) {
  if (typeof url !== 'string' || !url.startsWith(VISUAL_PREFIX)) return null
  const id = url.slice(VISUAL_PREFIX.length).replace(/[^\w-]/g, '')
  return id ? path.join(visuals.visualDir(app.getPath('userData')), id + '.html') : null
}
function chooseVisual () {
  if (!activeTabId()) return toast('Open the page you want to turn into a visual')
  pick('Create a visual from this page', Object.entries(visuals.KINDS).map(([k, v]) => ({ value: k, title: v.label })), (kind) => {
    setTimeout(() => prompt(`${visuals.KINDS[kind].label}: anything specific? (audience, tone, brand colours) — optional`, '', (notes) => { if (notes != null) createVisual(kind, notes) }))
  })
}
async function createVisual (kind, notes = '', { generate } = {}) {
  if (!visuals.KINDS[kind]) return
  const page = await pageForChat()
  if (!page || !page.text.trim()) return toast('Open a page with content first')
  const label = visuals.KINDS[kind].label
  // No API key: hand the request to Claude on claude.ai (your Pro / Max / Team plan) instead
  if (!generate && !claudeKey() && !process.env.ANTHROPIC_API_KEY) {
    if (!accountMode()) setClaudeMode('account')
    toggleChat(true)
    const body = page.text.length > MAX_SHARED_CHARS ? page.text.slice(0, MAX_SHARED_CHARS) : page.text
    const ask = `Create ${visuals.KINDS[kind].brief} Build it as an HTML artifact from the web page below.${notes ? ' ' + notes : ''}\nTitle: ${page.title}\nURL: ${page.url}\n\n${body}`
    if (!(await typeIntoClaude(ask))) { clipboard.writeText(ask); toast('Copied the request — paste it into Claude (⌘V)') } else toast(`Press Enter in Claude to create your ${label.toLowerCase()}`)
    return 'account'
  }
  const id = uid('v'); const userData = app.getPath('userData')
  visuals.write(userData, id, visuals.placeholder(kind, page.title))
  const tid = newTab(VISUAL_PREFIX + id)
  try {
    const html = await (generate || visuals.generate)({ kind, page, notes, colors: space().theme.colors, apiKey: claudeKey(), model: S.settings.claudeModel })
    visuals.write(userData, id, visuals.harden(html))
    toast(`${label} ready — “Export Visual as PDF” is in the command bar`)
  } catch (e) {
    const msg = visuals.describe(e)
    visuals.write(userData, id, visuals.harden(`<title>Couldn’t create ${label}</title><body style="font:16px system-ui;display:grid;place-items:center;height:90vh"><p>${msg.replace(/[<>&]/g, '')}</p></body>`))
    toast(msg)
  }
  showVisual(views.get(tid)?.webContents, visualFile(VISUAL_PREFIX + id))
  return tid
}
async function exportVisualPdf (tabId = activeTabId()) {
  const t = tab(tabId); const wc = views.get(tabId)?.webContents
  if (!t || !wc || !visualFile(t.url)) return toast('Open a visual created by Drift first')
  const pdf = await wc.printToPDF({ printBackground: true, preferCSSPageSize: true })
  const name = (t.title || 'Visual').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'Visual'
  let file = path.join(downloadDir(), name + '.pdf')
  for (let i = 1; fs.existsSync(file); i++) file = path.join(downloadDir(), `${name} (${i}).pdf`)
  fs.writeFileSync(file, pdf)
  const d = { id: uid('d'), name: path.basename(file), path: file, received: pdf.length, total: pdf.length, state: 'completed', startedAt: Date.now(), doneAt: Date.now() }
  downloads.unshift(d); downloadThumb(d); store.save(); pushState()
  toast(`Saved ${d.name} to Downloads`)
  return file
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
  peekView.setBounds(peekBounds()); restack()
  peekView.webContents.focus()
}
function destroyPeek () {
  if (!peekView) return
  try { win.contentView.removeChildView(peekView) } catch {}
  if (!peekView.webContents.isDestroyed()) peekView.webContents.close()
  peekView = null
}
// Two-finger swipe and the mouse's back/forward buttons, reported by the page preload (Electron has
// no history swipe of its own on macOS). Only from tabs, Peek and Little Windows.
ipcMain.on('web-nav', (e, dir) => {
  const wc = e.sender
  if (!wcToTab.has(wc.id) && wc !== peekView?.webContents && ![...miniWindows].some(m => m.view?.webContents === wc)) return
  if (dir === 'back') goBack(wc); else if (dir === 'forward') goForward(wc)
})
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
  m.loadURL(uiURL('mini.html'))
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
  chatView.webContents.loadURL(uiURL('chat.html'))
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
    claudeBar.webContents.loadURL(uiURL('claude-bar.html'))
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
      if (isMain && code !== -3) showErrorPage(wc, { kind: 'error', url, code: String(code), desc })
    })
    wc.on('context-menu', (_e, p) => {
      const items = []
      if (p.linkURL) items.push({ label: 'Open Link in New Tab', click: () => newTab(p.linkURL) }, { label: 'Copy Link', click: () => clipboard.writeText(p.linkURL) }, { type: 'separator' })
      if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' })
      else if (p.selectionText) items.push({ role: 'copy' })
      items.push({ type: 'separator' }, { label: 'Reload', click: () => wc.reload() })
      Menu.buildFromTemplate(items).popup(menuOpts())
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
  ]).popup(menuOpts())
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
let settingsSpace = null
function openSettings (page, spaceId) {
  settingsPage = page || null
  settingsSpace = spaceId || null
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); sendSettings(); return }
  settingsWin = new BrowserWindow({
    // a compact preferences window like Arc's: centred title, icon tabs, cards
    width: 640, height: 600, minWidth: 600, minHeight: 440, title: 'Settings', show: false, maximizable: false, fullscreenable: false,
    titleBarStyle: isMac ? 'hidden' : 'default', backgroundColor: nativeTheme.shouldUseDarkColors ? '#2b2927' : '#ececee',
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  settingsWin.loadURL(uiURL('settings.html'))
  settingsWin.webContents.on('will-navigate', e => e.preventDefault())
  settingsWin.once('ready-to-show', () => settingsWin.show())
}
// Packaged: the bridge is unpacked from app.asar so a plain `node` can run it (Drift's RunAsNode fuse is off)
function mcpBridgePath () { return path.join(__dirname, '..', 'mcp', 'bridge.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1') }
function mcpConfigFile () { return path.join(app.getPath('userData'), 'drift-mcp.json') }
function settingsData () {
  const spacesPer = (pid) => S.spaces.filter(s => s.profileId === pid).length
  const perms = Object.entries(S.permissions).map(([origin, m]) => ({ origin, list: Object.entries(m).map(([k, v]) => `${k}: ${v}`).join(', ') }))
  const env = { DRIFT_MCP_CONFIG: mcpConfigFile() }
  const cfg = { mcpServers: { drift: { command: 'node', args: [mcpBridgePath()], env } } }
  return {
    page: settingsPage,
    focusSpace: settingsSpace,
    spaces: S.spaces.map(s => ({ id: s.id, name: s.name, icon: s.icon || '', theme: s.theme, profile: profile(s.profileId)?.name, active: s.id === S.activeSpaceId })),
    themePresets: THEME_PRESETS,
    settings: S.settings,
    version: app.getVersion(),
    chrome: process.versions.chrome,
    engines: Object.entries(ENGINES).map(([k, e]) => [k, e.name]),
    profiles: S.profiles.map(p => ({ id: p.id, name: p.name, spaces: spacesPer(p.id) })),
    permissions: perms,
    passwordCount: passwords.count,
    threatFeed: safebrowsing.size ? `${safebrowsing.size.toLocaleString()} known malware & phishing sites (abuse.ch URLhaus, OpenPhish), checked on your Mac` : 'Threat lists download on first run',
    adblock: adblock.ready ? `Filter lists active (EasyList, EasyPrivacy${S.settings.strictBlocking ? ', annoyances' : ''}) + built-in list` : 'Built-in list active — filter lists download on first run',
    mcpConfig: JSON.stringify(cfg, null, 2),
    mcpCli: `claude mcp add drift --env DRIFT_MCP_CONFIG="${mcpConfigFile()}" -- node "${mcpBridgePath()}"`,
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
function sendSettings () {
  if (!settingsWin || settingsWin.isDestroyed()) return
  settingsWin.webContents.send('settings', settingsData())
  // a requested page / space applies once, when Settings is opened — not on every later refresh
  if (!settingsWin.webContents.isLoading()) { settingsPage = null; settingsSpace = null }
}
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
  'space-update': (id, patch) => updateSpace(id, patch),
  'space-switch': (id) => switchSpace(id),
  'space-new': () => { win.focus(); prompt('Name your new space', '', (n) => { if (n) { createSpace(n); sendSettings() } }) },
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
    spaces: S.spaces.map(s => ({ name: s.name, color: s.color, profile: profile(s.profileId)?.name, pinned: tabsOf(pinnedTabs(s)), folders: s.pinned.filter(id => S.folders[id]).map(id => ({ name: S.folders[id].name, tabs: tabsOf(S.folders[id].items) })), today: tabsOf(todayTabs(s)) })),
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
      for (const sp of S.spaces) { for (const id of pinnedTabs(sp)) out.push(tabInfo(id, sp.name, 'pinned')); for (const id of todayTabs(sp)) out.push(tabInfo(id, sp.name, 'today')) }
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
function pickColor (id = S.activeSpaceId) { openSettings('spaces', id) }
// Apply a theme / icon / name change to a space (from Settings → Spaces)
function updateSpace (id, patch) {
  const sp = space(id); if (!sp || !patch || typeof patch !== 'object') return
  if (patch.theme) { sp.theme = cleanTheme({ ...sp.theme, ...patch.theme }, sp.color); sp.color = sp.theme.colors[0] }
  if (typeof patch.icon === 'string') sp.icon = [...patch.icon.trim()].slice(0, 2).join('')
  if (typeof patch.name === 'string' && patch.name.trim()) sp.name = patch.name.trim().slice(0, 40)
  store.save(); pushState(); sendSettings()
}
function pickProfile (id = S.activeSpaceId) {
  const items = [...S.profiles.map(p => ({ value: p.id, title: p.name })), { value: '__new', title: '+ New Profile…' }]
  pick('Profile for this space (separate cookies, logins & favourites)', items, (v) => {
    const set = (pid) => {
      const sp = space(id)
      for (const tid of [...pinnedTabs(sp), ...todayTabs(sp)]) destroyView(tid)
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
  for (const t of Object.values(S.tabs)) delete t.nav
  S.history = []; S.archive = []; S.permissions = {}; store.save(); toast('Browsing data cleared')
}

function zoom (dir) {
  const wc = views.get(activeTabId())?.webContents; if (!wc) return
  const z = dir === 0 ? 0 : Math.max(-5, Math.min(5, wc.getZoomLevel() + dir * 0.5))
  wc.setZoomLevel(z); toast(`Zoom ${Math.round(Math.pow(1.2, z) * 100)}%`)
}
function findInPage () { if (activeTabId()) openOverlay({ mode: 'find', query: '' }) }
function toggleSidebar () { S.sidebarVisible = !S.sidebarVisible; sidebarPeek = false; clearTimeout(peekTimer); sidebarFloat?.webContents.send('sidebar-peek', false); store.save(); layout(); pushState() }

function navActive (fn) { const wc = views.get(activeTabId())?.webContents; if (wc) fn(wc) }
// Reload; on one of our error pages that means trying the address that failed again
function reloadPage (wc, { toggle = false } = {}) {
  if (toggle && wc.isLoading()) return wc.stop()
  const failed = isInternalPage(wc.getURL()) && failedUrlOf(wc.getURL())
  if (failed && isSafeWebUrl(failed)) wc.loadURL(failed).catch(() => {}); else wc.reload()
}
function goBack (wc) { if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack() }
function goForward (wc) { if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward() }

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
  if (tab(tabId).pinnedUrl && loc.type !== 'today') tmpl.push({ label: 'Back to Pinned Page', enabled: drifted(tab(tabId)), click: () => resetPinned(tabId) })
  if (others.length) tmpl.push({ label: 'Move to Space', submenu: others.map(s => ({ label: s.name, click: () => moveTab(tabId, loc.type === 'favorite' ? 'today' : loc.type, { spaceId: s.id }) })) })
  tmpl.push({ type: 'separator' }, { label: loc.type === 'today' ? 'Close Tab' : 'Unload Tab', click: () => closeTab(tabId) })
  if (loc.type === 'today') tmpl.push({ label: 'Close Tabs Below', click: () => { const l = locate(tabId)?.list || []; for (const id of l.slice(l.indexOf(tabId) + 1).flatMap(i => S.folders[i] ? S.folders[i].items : [i])) closeTab(id) } })
  Menu.buildFromTemplate(tmpl).popup(menuOpts())
}
function spaceContextMenu (id) {
  Menu.buildFromTemplate([
    { label: 'Rename…', click: () => renameSpace(id) },
    { label: 'Edit Theme & Icon…', click: () => openSettings('spaces', id) },
    { label: 'Change Profile…', click: () => pickProfile(id) },
    { type: 'separator' },
    { label: 'Delete Space', enabled: S.spaces.length > 1, click: () => confirmDeleteSpace(id) }
  ]).popup(menuOpts())
}
function toggleMute (tabId) {
  const wc = views.get(tabId)?.webContents; const lv = live.get(tabId); if (!wc || !lv) return
  lv.muted = !lv.muted; wc.setAudioMuted(lv.muted); pushState()
}

// ---------------------------------------------------------------- UI state push
let pushTimer = null
function pushStateSoon () { if (!pushTimer) pushTimer = setTimeout(() => { pushTimer = null; pushState() }, 60) }
// A pinned tab that has navigated away from its pinned page (Arc shows “/ title” and a ↑ back button)
function drifted (t) {
  if (!t.pinnedUrl || !t.url) return false
  try { const a = new URL(t.url); const b = new URL(t.pinnedUrl); return a.origin !== b.origin || a.pathname.replace(/\/$/, '') !== b.pathname.replace(/\/$/, '') } catch { return false }
}
function resetPinned (tabId) {
  const t = tab(tabId); if (!t?.pinnedUrl) return
  t.url = t.pinnedUrl; views.get(tabId)?.webContents.loadURL(t.pinnedUrl).catch(() => {}); store.save(); pushState()
}
function siteMenu () {
  const id = activeTabId(); const t = tab(id); if (!t) return toast('Open a page first')
  const wc = views.get(id)?.webContents; const o = originOf(t.url); let host = ''; try { host = new URL(t.url).hostname } catch {}
  const blocked = live.get(id)?.blocked || 0
  Menu.buildFromTemplate([
    { label: host || 'This page', enabled: false },
    { label: `${blocked} ads & trackers blocked`, enabled: false },
    { type: 'separator' },
    { label: 'Site Inspector — certificate, headers, cookies, tech stack', click: () => openInspector() },
    { label: S.boosts[host] ? 'Edit Boost…' : 'Boost This Site…', click: () => boostSite() },
    { label: 'Reset Site Permissions', enabled: !!S.permissions[o], click: () => { delete S.permissions[o]; store.save(); toast('Permissions reset') } },
    { type: 'separator' },
    { label: 'Zoom In', click: () => zoom(1) }, { label: 'Zoom Out', click: () => zoom(-1) }, { label: 'Actual Size', click: () => zoom(0) },
    { type: 'separator' },
    { label: 'Pop Out Video', click: () => runCommand('pip') },
    { label: 'Open in Split View…', click: () => runCommand('split') },
    { label: 'Clear Cookies for This Site', enabled: !!wc, click: async () => { const cs = await wc.session.cookies.get({ url: t.url }); for (const c of cs) await wc.session.cookies.remove(t.url, c.name); toast(`Removed ${cs.length} cookies`) } }
  ]).popup(menuOpts())
}

function pushState () {
  if (!win || win.isDestroyed()) return
  const sp = space()
  const t = (id) => {
    const x = tab(id); if (!x) return null
    const l = live.get(id)
    return { id, title: x.customTitle || x.title, url: x.url, favicon: iconFor(x), loaded: !!l, loading: l?.loading, audible: l?.audible, muted: l?.muted, drifted: drifted(x) }
  }
  const entry = (id) => (S.folders[id] ? { folder: true, id, name: S.folders[id].name, open: S.folders[id].open !== false, items: S.folders[id].items.map(t).filter(Boolean) } : t(id))
  const act = sp.activeTabId; const l = live.get(act)
  sendSidebar('state', {
    spaces: S.spaces.map(s => ({ id: s.id, name: s.name, icon: s.icon || '', color: s.color, theme: s.theme, profile: profile(s.profileId)?.name })),
    activeSpaceId: S.activeSpaceId,
    favorites: profile(sp.profileId).favorites.map(t).filter(Boolean),
    pinned: sp.pinned.map(entry).filter(Boolean),
    today: sp.today.map(entry).filter(Boolean),
    activeTabId: act,
    split: sp.split,
    panes: sp.split && sp.split.ids.every(id => tab(id)) ? sp.split.ids.map(id => { const x = tab(id); const l = live.get(id); return { id, url: x.url, title: x.customTitle || x.title, canBack: !!l?.canBack, canFwd: !!l?.canFwd, loading: !!l?.loading } }) : null,
    sidebarVisible: S.sidebarVisible,
    sidebarPeek,
    chatOpen,
    tidyTabs: S.settings.tidyTabs,
    canTidy: canTidy(sp),
    dimUnloaded: S.settings.dimUnloaded,
    pinnedResetButton: S.settings.pinnedResetButton,
    sidebarWidth: S.settings.sidebarWidth,
    nav: { canBack: l?.canBack, canFwd: l?.canFwd, loading: l?.loading, url: tab(act)?.url || '', blocked: l?.blocked || 0 },
    settings: { blocker: S.settings.blocker, httpsOnly: S.settings.httpsOnly },
    downloads: downloads.slice(0, 40).map(d => ({ id: d.id, name: d.name, state: d.state, received: d.received, total: d.total, startedAt: d.startedAt, doneAt: d.doneAt })),
    downloadsOpen,
    popoverOpen,
    isMac,
    fullscreen: win.isFullScreen(),
    private: PRIVATE,
    partition: partitionFor(sp.profileId),
    extensions: PRIVATE ? 0 : allExtensions().length,
    activeWcId: views.get(act)?.webContents.id || null
  })
}
// Toasts appear at the bottom of the docked sidebar; while it's hidden they get a small view of their
// own above the page (the sidebar UI would be underneath it)
let toastView = null; let toastShown = false; let toastTimer = null
function toast (msg) {
  if (!win || win.isDestroyed()) return
  if (S.sidebarVisible || sidebarPeek) { sendSidebar('toast', msg); return }
  if (!toastView) {
    toastView = new WebContentsView({ webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false } })
    toastView.setBackgroundColor('#00000000')
    toastView.webContents.loadURL(uiURL('toast.html'))
    toastView.webContents.on('will-navigate', e => e.preventDefault())
  }
  const [, h] = win.getContentSize()
  toastView.setBounds({ x: PAD + 10, y: h - PAD - 10 - 44, width: 340, height: 44 })
  toastShown = true; restack()
  const send = () => toastView.webContents.send('toast', msg)
  if (toastView.webContents.isLoading()) toastView.webContents.once('did-finish-load', send); else send()
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastShown = false; try { win?.contentView.removeChildView(toastView) } catch {} }, 2800)
}

// Arc's “New Tab Created” pill: a small view at the top-right of the page after a link opens in the
// background; clicking it goes to that tab. The page plays its exit animation before the view is detached.
let noticeView = null; let noticeShown = false; let noticeTab = null; let noticeTimer = null; let noticeDetachTimer = null
const NOTICE_W = 240; const NOTICE_H = 56
function noticeBounds () {
  const sp = space(); const L = lastLayout; const [w] = win.getContentSize()
  const pane = L && L.rects.length > 1 ? Math.max(0, sp.split?.ids.indexOf(sp.activeTabId) ?? 0) : -1
  const r = (pane >= 0 && L.rects[pane]) || L?.area || { x: PAD, y: PAD, width: w - PAD * 2 }
  return { x: r.x + r.width - NOTICE_W - 6, y: r.y + (pane >= 0 ? PANE_BAR : 0) + 6, width: NOTICE_W, height: NOTICE_H }
}
function showTabNotice (id) {
  if (!win || win.isDestroyed()) return
  if (!noticeView) {
    noticeView = new WebContentsView({ webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false } })
    noticeView.setBackgroundColor('#00000000')
    noticeView.webContents.loadURL(uiURL('notice.html'))
    noticeView.webContents.on('will-navigate', e => e.preventDefault())
    noticeView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  }
  clearTimeout(noticeDetachTimer)
  noticeTab = id; noticeShown = true
  noticeView.setBounds(noticeBounds()); restack()
  const send = () => noticeView?.webContents.send('notice', { text: 'New Tab Created', color: space().theme.colors[0], dark: popoverDark() })
  if (noticeView.webContents.isLoading()) noticeView.webContents.once('did-finish-load', send); else send()
  armNotice(3500)
}
const armNotice = (ms) => { clearTimeout(noticeTimer); noticeTimer = setTimeout(hideTabNotice, ms) }
function hideTabNotice ({ now = false } = {}) {
  clearTimeout(noticeTimer); clearTimeout(noticeDetachTimer)
  if (!noticeShown || !noticeView) return
  const detach = () => { noticeShown = false; noticeTab = null; try { win?.contentView.removeChildView(noticeView) } catch {} }
  if (now) return detach()
  noticeView.webContents.send('notice', null)
  noticeDetachTimer = setTimeout(detach, 180)
}

// ---------------------------------------------------------------- IPC (only from our own UI views)
const isOurUI = (e) => e.sender === win?.webContents || e.sender === overlay?.webContents || (noticeView && e.sender === noticeView.webContents) || (settingsWin && !settingsWin.isDestroyed() && e.sender === settingsWin.webContents) || [...miniWindows].some(m => e.sender === m.ui) || (chatView && e.sender === chatView.webContents) || (claudeBar && e.sender === claudeBar.webContents) || (dragShield && e.sender === dragShield.webContents) || (previewView && e.sender === previewView.webContents) || (popView && e.sender === popView.webContents) || (sidebarFloat && e.sender === sidebarFloat.webContents)
const ACTIONS = {
  ready: () => { pushState(); layout() },
  activate: (id) => activateTab(id),
  close: (id) => closeTab(id),
  'tab-menu': (id) => tabContextMenu(id),
  'space-menu': (id) => spaceContextMenu(id),
  'space-edit': (id) => openSettings('spaces', id),
  'reset-pinned': (id) => resetPinned(id),
  'site-menu': () => siteMenu(),
  'copy-url': () => copyUrl(),
  'switch-space': (id) => switchSpace(id),
  'new-space': () => prompt('Name your new space', '', (n) => n && createSpace(n)),
  move: (id, to, index, spaceId, folderId) => moveTab(id, to, { index, spaceId: spaceId || S.activeSpaceId, folderId }),
  'move-folder': (fid, index) => { const sp = space(); const l = [sp.pinned, sp.today].find(x => x.includes(fid)); if (!l || !S.folders[fid]) return; l.splice(l.indexOf(fid), 1); l.splice(Math.max(0, Math.min(index, l.length)), 0, fid); store.save(); pushState() },
  'toggle-folder': (fid) => { const f = S.folders[fid]; if (f) { f.open = f.open === false; store.save(); pushState() } },
  'folder-menu': (fid) => folderMenu(fid),
  'new-folder': () => newFolder(),
  'command-bar': (mode) => commandBar(mode),
  back: () => navActive(goBack),
  forward: () => navActive(goForward),
  reload: () => navActive(wc => reloadPage(wc, { toggle: true })),
  'toggle-sidebar': toggleSidebar,
  'sidebar-width': (w) => { setSidebarWidth(Number(w)); store.save() },
  'sidebar-resize-start': () => { if (S.sidebarVisible) startShieldDrag('sidebar', 'row') },
  peek: (on) => { if (on) setPeek(true); else peekCheck() },
  'clear-today': clearToday,
  'notice-open': () => { const id = noticeTab; hideTabNotice({ now: true }); if (id) activateTab(id) },
  'notice-hover': (on) => { if (!noticeShown) return; if (on) clearTimeout(noticeTimer); else armNotice(1500) },
  'split-drag-start': (i) => startSplitDrag(Number(i)),
  'split-drag': (x, y) => shieldDrag(Number(x), Number(y)),
  'split-drag-end': () => endSplitDrag(),
  'split-equalize': () => { const sp = space(); if (sp.split) { sp.split.sizes = sp.split.ids.map(() => 1 / sp.split.ids.length); layout(); store.save() } },
  'split-focus': (id) => { if (inSplit(space(), id)) activateTab(id) },
  'pane-nav': (id, what) => {
    const wc = inSplit(space(), id) && views.get(id)?.webContents; if (!wc) return
    if (what === 'back') goBack(wc); else if (what === 'forward') goForward(wc); else if (what === 'reload') reloadPage(wc, { toggle: true })
  },
  'pane-url': (id) => { if (inSplit(space(), id)) { activateTab(id); commandBar('edit') } },
  'pane-site': (id, rect) => { if (inSplit(space(), id)) { activateTab(id); siteControls(rect && { x: +rect.x, y: +rect.y, width: +rect.width, height: +rect.height }) } },
  'pane-menu': (id) => { if (inSplit(space(), id)) { activateTab(id); splitMenu(id) } },
  'pane-close': (id) => { const sp = space(); if (!inSplit(sp, id)) return; removeFromSplit(sp, id); layout(); pushState(); store.save() },
  // two-finger swipe across the sidebar: next / previous space (stops at the ends, like Arc)
  'step-space': (dir) => {
    const i = S.spaces.findIndex(s => s.id === S.activeSpaceId); const j = i + (Number(dir) > 0 ? 1 : -1)
    if (j >= 0 && j < S.spaces.length) switchSpace(S.spaces[j].id)
  },
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
  find: async (text, dir, opts) => {
    const wc = views.get(activeTabId())?.webContents; if (!wc) return
    if (opts && typeof opts === 'object') {
      for (const [k, key] of [['highlightAll', 'findHighlightAll'], ['matchCase', 'findMatchCase'], ['diacritics', 'findDiacritics'], ['wholeWords', 'findWholeWords']]) if (typeof opts[k] === 'boolean') S.settings[key] = opts[k]
      store.save()
    }
    const o = { highlightAll: S.settings.findHighlightAll, matchCase: S.settings.findMatchCase, diacritics: S.settings.findDiacritics, wholeWords: S.settings.findWholeWords }
    const r = await finder.find(wc, text, o, ['next', 'prev'].includes(dir) ? dir : 'new', space().theme.colors[0])
    overlay?.webContents.send('find-result', { matches: r.matches, activeMatchOrdinal: r.active, finalUpdate: true })
  },
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
      const sp = space(); const list = [...profile(sp.profileId).favorites, ...pinnedTabs(sp), ...todayTabs(sp)]
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
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => navActive(reloadPage) },
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
  const sp = space(); const list = [...profile(sp.profileId).favorites, ...pinnedTabs(sp), ...todayTabs(sp)]
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
  win.loadURL(uiURL('index.html'))
  win.webContents.on('will-navigate', e => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.once('ready-to-show', () => win.show())
  win.on('resize', layout)
  win.on('swipe', (_e, dir) => { if (dir === 'right') navActive(goBack); else if (dir === 'left') navActive(goForward) })
  win.on('app-command', (_e, cmd) => { if (cmd === 'browser-backward') navActive(goBack); else if (cmd === 'browser-forward') navActive(goForward) })
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
  win.on('closed', () => { win = null; overlay = null; sidebarFloat = null; floatAttached = false; toastView = null; toastShown = false; views.clear(); wcToTab.clear(); live.clear() })
  // restore the active tab
  const sp = space()
  if (sp.activeTabId && tab(sp.activeTabId)) ensureView(sp.activeTabId)
  ensureOverlay()
}

function sanitizeState () {
  // drop dangling tab references from older/corrupted state
  const seen = new Set()
  S.folders = S.folders && typeof S.folders === 'object' ? S.folders : {}
  const clean = (list) => list.filter(id => S.tabs[id] && !seen.has(id) && seen.add(id))
  for (const p of S.profiles) p.favorites = clean(p.favorites || [])
  for (const sp of S.spaces) {
    sp.pinned = (sp.pinned || []).filter(id => {
      const f = S.folders[id]
      if (!f) return S.tabs[id] && !seen.has(id) && seen.add(id)
      if (seen.has(id)) return false
      seen.add(id); f.items = clean(f.items || []); return true
    })
    sp.today = clean(sp.today || [])
    if (!profile(sp.profileId)) sp.profileId = 'default'
    sp.theme = cleanTheme(sp.theme || defaultTheme(sp.color), sp.color); sp.color = sp.theme.colors[0]
    if (typeof sp.icon !== 'string') sp.icon = ''
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
  // Arc-sized sidebar: move the old default width to the new one once (a width you dragged is kept)
  if (!S.layoutV2) { if (S.settings.sidebarWidth === 260) S.settings.sidebarWidth = DEFAULTS.settings.sidebarWidth; S.layoutV2 = true }
  // downloads list survives restarts; anything that was mid-download is now interrupted
  for (const d of (Array.isArray(S.downloads) ? S.downloads : []).slice(0, 60)) { if (d.state === 'progressing' || d.state === 'paused') d.state = 'interrupted'; downloads.push(d) }
  S.downloads = downloads
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
  safebrowsing.start(app.getPath('userData')).then(() => console.log('threat feeds:', safebrowsing.size))
  if (S.settings.blocker) adblock.load(app.getPath('userData'), { strictMode: S.settings.strictBlocking }).then(r => console.log('adblock:', r))
  serveUI()
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
if (process.env.DRIFT_SELFTEST) require('./selftest')({ app, get win () { return win }, get S () { return S }, newTab, activateTab, openSplit, togglePin, toggleFavorite, createSpace, switchSpace, closeTab, autoArchive, views, live, layout, commandBar, closeOverlay, runCommand, ACTIONS, get passwords () { return passwords }, get peekView () { return peekView }, miniWindows, get settingsWin () { return settingsWin }, get chatView () { return chatView }, get claudeWeb () { return claudeWeb }, get claudeBar () { return claudeBar }, setClaudeMode, addPageToClaude, chatMenu, popOutVideo, returnVideo, get pip () { return pip }, showFavPreview, get previewView () { return previewView }, scrapeGmail, snapshots, updateSpace, safebrowsing, preconnect, tabMemory, createVisual, exportVisualPdf, visualFile, finder, plusMenu, siteControls, newFolder, deleteFolder, pinnedTabs, get popView () { return popView }, get popoverOpen () { return popoverOpen }, setSiteSetting, siteControlsData, screenshotPage, downloads, get downloadThumbs () { return downloadThumbs }, startSplitDrag, splitDrag, endSplitDrag, setSplitDir, removeFromSplit, get lastLayout () { return lastLayout }, get chatOpen () { return chatOpen }, inspector, adblock, setSetting, mcpConfigFile, mcpBridgePath, tidyTitle, tidyTabs, memorySaver, openInspector, openPeek, openMini, openSettings, toggleChat, tidyDownloadName, runSync, tab, space, get overlayOpen () { return overlayOpen }, get overlay () { return overlay }, get sidebarFloat () { return sidebarFloat }, setPeek, get dragShield () { return dragShield }, get dragMode () { return dragMode }, restack, toast, get toastView () { return toastView }, destroyView, pipLinger })
