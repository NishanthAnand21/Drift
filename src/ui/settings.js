'use strict'
const api = window.drift
const $ = (s) => document.querySelector(s)
let D = null; let current = 'general'

const PAGES = [
  ['general', '⚙', 'General'], ['profiles', '◉', 'Profiles'], ['tidy', '✦', 'Tidy'], ['links', '⧉', 'Links'],
  ['privacy', '⛨', 'Privacy & Security'], ['integrations', '⌬', 'Integrations'], ['shortcuts', '⌘', 'Shortcuts'], ['icon', '◎', 'Icon'], ['advanced', '☰', 'Advanced']
]
const HOUR = 3600e3; const MIN = 60e3

function el (tag, attrs = {}, ...kids) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) { if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'class') e.className = v; else e.setAttribute(k, v) }
  for (const k of kids.flat()) if (k != null) e.append(k)
  return e
}
const set = (key, value) => api.send('settings-set', key, value)
const act = (name, ...a) => api.send('settings-action', name, ...a)
function label (t, sub) { return el('div', { class: 'lbl' }, t, sub ? el('small', {}, sub) : null) }
function toggle (key, t, sub) {
  const i = el('input', { type: 'checkbox' }); i.checked = !!D.settings[key]
  i.onchange = () => set(key, i.checked)
  return el('div', { class: 'row' }, label(t, sub), el('label', { class: 'sw' }, i, el('span')))
}
function select (key, t, options, sub) {
  const s = el('select')
  for (const [v, txt] of options) { const o = el('option', { value: JSON.stringify(v) }, txt); if (JSON.stringify(D.settings[key]) === JSON.stringify(v)) o.selected = true; s.append(o) }
  s.onchange = () => set(key, JSON.parse(s.value))
  return el('div', { class: 'row' }, label(t, sub), s)
}
function button (t, sub, btn, fn, cls = '') { return el('div', { class: 'row' }, label(t, sub), el('button', { class: 'b ' + cls, onclick: fn }, btn)) }
const card = (...rows) => el('div', { class: 'card' }, ...rows)
const sec = (t) => el('div', { class: 'sec' }, t)
const note = (t) => el('p', { class: 'note' }, t)

const render = {
  general: () => [
    card(toggle('autoUpdate', 'Automatically update Drift', 'Includes Chromium security fixes'), toggle('warnBeforeQuit', 'Warn before quitting', 'Press ⌘Q twice to quit')),
    card(toggle('restoreSession', 'Restore tabs from the previous session'),
      button('Default browser', 'Open links from other apps in Drift', 'Make Default', () => act('default-browser')),
      button('Updates', `Drift ${D.version} · Chromium ${D.chrome}`, 'Check Now', () => act('check-updates')))
  ],
  profiles: () => [
    note('Profiles keep data separate across Spaces — history, logins, cookies and extensions. A profile can be used by one or more Spaces.'),
    sec('Your profiles'),
    card(...D.profiles.map(p => el('div', { class: 'row' }, label(p.name, p.spaces ? `${p.spaces} space${p.spaces > 1 ? 's' : ''}` : 'Not used'),
      el('button', { class: 'b', onclick: () => act('profile-rename', p.id) }, 'Rename'),
      p.id !== 'default' ? el('button', { class: 'b danger', onclick: () => act('profile-delete', p.id) }, 'Delete') : null)),
    el('div', { class: 'row' }, label('New profile'), el('button', { class: 'b', onclick: () => act('profile-add') }, '＋ Add'))),
    sec('Search & tabs'),
    card(select('searchEngine', 'Search engine', D.engines),
      toggle('suggestions', 'Include search engine suggestions'),
      select('archiveAfterMs', 'Archive tabs after', [[12 * HOUR, '12 hours'], [24 * HOUR, '24 hours'], [7 * 24 * HOUR, '7 days'], [30 * 24 * HOUR, '30 days'], [0, 'Never']], 'Unpinned tabs you haven’t used move to the Archive'),
      select('downloadMode', 'Download location', [['downloads', 'Downloads folder'], ['ask', 'Ask every time'], ['custom', D.settings.downloadDir ? 'Custom: ' + D.settings.downloadDir : 'Custom folder…']])),
    sec('Your data and settings'),
    card(button('Passwords', `${D.passwordCount} saved · encrypted with your Keychain`, 'Open', () => act('passwords')),
      button('Import passwords', 'CSV from Chrome, Arc or 1Password', 'Import…', () => act('pw-import')),
      button('Site permissions & notifications', 'Camera, microphone, location, notifications…', 'Show', () => go('privacy')),
      button('Clear browsing data', 'History, cookies, cache and site data', 'Clear…', () => act('clear-data'), 'danger'))
  ],
  tidy: () => [
    note('Tidy features run entirely on your Mac — nothing is sent to an AI service.'),
    card(toggle('tidyTabs', 'Tidy Tabs', 'Shows a ✧ Tidy button when you have more than six Today tabs: groups them by site and archives duplicates'),
      toggle('instantLinks', 'Instant Links', 'Press Shift+Enter on a search to open the top result directly. Separate queries with commas to open several'),
      toggle('tidyTitles', 'Tidy Tab Titles', 'Shorter, cleaner titles when you pin a tab (double-click a tab to rename it)'),
      toggle('tidyDownloads', 'Tidy Downloads', 'Renames downloads with meaningless names (e.g. 387494875.pdf) after the page they came from'),
      toggle('aiInCommandBar', 'AI in the Command Bar', 'Adds an “Ask …” result; type the assistant’s name and press Tab to ask it directly'),
      select('aiProvider', 'Assistant', [['claude', 'Claude'], ['chatgpt', 'ChatGPT'], ['perplexity', 'Perplexity']]))
  ],
  links: () => [
    note('Little Window is a small, simple Drift window for quick lookups. Peek previews a link without opening a new tab.'),
    card(toggle('miniHotkey', 'Open a Little Window when I press ⌥⌘N in any app'),
      toggle('miniForExternal', 'Links from other apps open in a Little Window')),
    card(toggle('peekShift', 'Open Peek when clicking links with Shift held'),
      toggle('peekFromPinned', 'Open Peek for links to other sites', 'Only affects Favorites and Pinned tabs'))
  ],
  privacy: () => [
    sec('Blocking'),
    card(toggle('blocker', 'Block ads & trackers', D.adblock),
      toggle('strictBlocking', 'Strict mode', 'Also hides cookie banners and other annoyances (may break some sites)'),
      toggle('httpsOnly', 'HTTPS-Only mode', 'Upgrade every site to a secure connection, warn before HTTP')),
    sec('Connection'),
    card(select('proxyMode', 'Proxy', [['system', 'Use system settings'], ['direct', 'No proxy'], ['fixed_servers', 'Manual'], ['pac_script', 'Automatic (PAC URL)']]),
      ...(D.settings.proxyMode === 'fixed_servers' ? [textRow('proxyRules', 'Proxy server', 'e.g. http=proxy:8080;https=proxy:8080 or socks5://host:1080'), textRow('proxyBypass', 'Bypass for', 'e.g. localhost,*.corp.example.com')] : []),
      ...(D.settings.proxyMode === 'pac_script' ? [textRow('proxyPac', 'PAC URL', 'https://example.com/proxy.pac')] : []),
      el('div', { class: 'row' }, label('Encryption', 'TLS 1.3 and 1.2 with certificate verification and Certificate Transparency. TLS 1.0/1.1 are disabled in Chromium because they are insecure.'))),
    sec('Site permissions'),
    D.permissions.length
      ? card(...D.permissions.map(p => el('div', { class: 'row' }, label(p.origin, p.list), el('button', { class: 'b', onclick: () => act('perm-reset', p.origin) }, 'Reset'))))
      : note('No sites have asked for permissions yet.')
  ],
  integrations: () => [
    sec('Claude'),
    card(button('Claude API key', D.hasClaudeKey ? 'Saved · encrypted in your Keychain' : 'Not set — get one at console.anthropic.com (or set ANTHROPIC_API_KEY)', D.hasClaudeKey ? 'Change…' : 'Add Key…', () => act('claude-key')),
      select('claudeModel', 'Model', D.claudeModels),
      select('claudeEffort', 'Effort', [['low', 'Low — fastest'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max — most thorough']], 'How hard Claude thinks before answering'),
      button('Chat panel', 'Ask about the page you’re on, or anything else', 'Open (⌘E)', () => act('claude-open'))),
    sec('MCP'),
    note('MCP (Model Context Protocol) lets Claude Desktop, Claude Code and other MCP clients control Drift: list and open tabs, read the page you’re on, search your history and switch spaces.'),
    card(toggle('mcpEnabled', 'Allow MCP clients', 'Local only (127.0.0.1) with a secret token'),
      toggle('mcpReadPages', 'Allow reading page content', 'Lets the assistant read the text of your tabs, including signed-in pages')),
    ...(D.settings.mcpEnabled ? [sec('Add to Claude Desktop (claude_desktop_config.json) or any MCP client'),
      card(el('div', { class: 'row' }, (() => { const t = el('textarea', { readonly: 'true' }); t.value = D.mcpConfig; return t })()),
        button('Claude Code', 'Run in a terminal', 'Copy Command', () => act('copy', D.mcpCli)),
        button('Config', 'JSON shown above', 'Copy JSON', () => act('copy', D.mcpConfig)))] : []),
    sec('Sync & extensions'),
    card(button('Sync', D.syncStatus, D.syncOn ? 'Turn Off' : 'Set Up…', () => act('sync')),
      button('Extensions', `${D.extensions} installed`, 'Manage…', () => act('extensions')),
      button('Chrome Web Store', 'Install extensions', 'Open', () => act('webstore')))
  ],
  shortcuts: () => [card(...D.shortcuts.map(([k, t]) => el('div', { class: 'row' }, label(t), el('kbd', {}, k))))],
  icon: () => [el('div', { class: 'card icons' }, ...D.icons.map(ic => {
    const r = el('input', { type: 'radio', name: 'icon' }); r.checked = D.settings.icon === ic.id; r.onchange = () => set('icon', ic.id)
    return el('label', { class: 'row' }, r, el('img', { src: ic.src }), label(ic.name), D.settings.icon === ic.id ? el('span', { class: 'pill' }, 'CURRENT ICON') : null)
  }))],
  advanced: () => [
    card(toggle('pipOnLeave', 'Picture in Picture when you leave a video tab'),
      toggle('boostsEnabled', 'Enable Boosts on websites you visit', 'Per-site styles — run “Boost This Site” from the command bar'),
      select('memorySaverMs', 'Memory Saver: unload inactive tabs after', [[15 * MIN, '15 minutes'], [30 * MIN, '30 minutes'], [HOUR, '1 hour'], [4 * HOUR, '4 hours'], [0, 'Never']], 'Frees memory from background tabs; they reload when you return')),
    el('div', { class: 'row' }, el('button', { class: 'b', onclick: () => act('export-data') }, 'Export Data…'), el('span', { style: 'flex:1' }), el('button', { class: 'b danger', onclick: () => act('reset-perms') }, 'Reset All Site Permissions'))
  ]
}
function textRow (key, t, ph) {
  const i = el('input', { type: 'text', placeholder: ph }); i.value = D.settings[key] || ''
  i.onchange = () => set(key, i.value.trim())
  return el('div', { class: 'row' }, label(t), i)
}

function go (p) { current = p; draw() }
function draw () {
  if (!D) return
  $('#tabs').replaceChildren(...PAGES.map(([id, ic, name]) => el('button', { class: id === current ? 'on' : '', onclick: () => go(id) }, el('span', { class: 'ic' }, ic), name)))
  $('#title').textContent = PAGES.find(p => p[0] === current)[2]
  const y = scrollY
  $('#page').replaceChildren(...render[current]())
  scrollTo(0, y)
}
api.on('settings', (d) => { D = d; if (d.page) current = d.page; draw() })
api.send('settings-ready')
