'use strict'
const api = window.drift
const $ = (s) => document.querySelector(s)
let D = null; let current = 'general'

const PAGES = [
  ['general', '⚙', 'General'], ['profiles', '◉', 'Profiles'], ['spaces', '◐', 'Spaces'], ['tidy', '✦', 'Tidy'], ['links', '⧉', 'Links'],
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
  spaces: () => [
    note('Each space has its own colours and icon. Pick a preset or mix up to three colours, choose light, dark or automatic, and add grain for that Arc-style texture.'),
    ...D.spaces.map(spaceCard),
    el('div', { class: 'row plain' }, el('button', { class: 'b', onclick: () => act('space-new') }, '＋ New Space'))
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
      toggle('peekFromPinned', 'Open Peek for links to other sites', 'Only affects Favorites and Pinned tabs')),
    card(toggle('favPreviews', 'Preview Favorites on hover', 'Gmail shows your latest emails with a compose button; other sites show how the page last looked'))
  ],
  privacy: () => [
    sec('Blocking'),
    card(toggle('blocker', 'Block ads & trackers', D.adblock),
      toggle('strictBlocking', 'Strict mode', 'Also hides cookie banners and other annoyances (may break some sites)'),
      toggle('httpsOnly', 'HTTPS-Only mode', 'Upgrade every site to a secure connection, warn before HTTP'),
      toggle('safeBrowsing', 'Dangerous site protection', D.threatFeed)),
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
    card(select('claudeMode', 'Chat with Claude using', [['account', 'My Claude account (Pro, Max, Team)'], ['api', 'An API key']],
      D.claudeMode === 'api' ? 'Pay-per-use through the Claude API' : 'Sign in on claude.ai inside the panel — uses your plan, no API key needed'),
      ...(D.claudeMode === 'api'
        ? [button('Claude API key', D.hasClaudeKey ? 'Saved · encrypted in your Keychain' : 'Not set — get one at console.anthropic.com (or set ANTHROPIC_API_KEY)', D.hasClaudeKey ? 'Change…' : 'Add Key…', () => act('claude-key')),
            select('claudeModel', 'Model', D.claudeModels),
            select('claudeEffort', 'Effort', [['low', 'Low — fastest'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max — most thorough']], 'How hard Claude thinks before answering')]
        : [button('Claude account', 'Your login stays in Drift’s isolated claude.ai session', 'Sign Out…', () => act('claude-signout'), 'danger'),
            button('API key (optional)', D.hasClaudeKey ? 'Saved — switch to “An API key” above to use it' : 'Only needed if you prefer pay-per-use', D.hasClaudeKey ? 'Change…' : 'Add Key…', () => act('claude-key'))]),
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
    card(toggle('dimUnloaded', 'Better unloaded tabs', 'Show tabs that aren’t loaded in greyscale and faded, so it’s obvious what’s using memory'),
      toggle('pinnedResetButton', 'Show “back to pinned page” button', 'The ↑ button on pinned tabs that have navigated away from their pinned page')),
    card(toggle('pipOnLeave', 'Picture in Picture when you leave a video tab', 'The video keeps playing in a small floating window you can move and resize'),
      toggle('pipOnAppSwitch', 'Picture in Picture when you switch to another app', 'The floating video stays on top of other apps; it returns to the page when you come back'),
      toggle('boostsEnabled', 'Enable Boosts on websites you visit', 'Per-site styles — run “Boost This Site” from the command bar'),
      select('memorySaverMs', 'Memory Saver: unload inactive tabs after', [[15 * MIN, '15 minutes'], [30 * MIN, '30 minutes'], [HOUR, '1 hour'], [4 * HOUR, '4 hours'], [0, 'Never']], 'Frees memory from background tabs; they reload when you return')),
    el('div', { class: 'row' }, el('button', { class: 'b', onclick: () => act('export-data') }, 'Export Data…'), el('span', { class: 'flex' }), el('button', { class: 'b danger', onclick: () => act('reset-perms') }, 'Reset All Site Permissions'))
  ]
}
const EMOJI = ['💼', '🏠', '⭐', '📚', '💻', '🎮', '🎵', '🎨', '🧪', '🛒', '✈️', '🔒', '🌱', '🔥', '💡', '📈']
const upd = (id, patch) => act('space-update', id, patch)
function gradientCss (th) {
  const c = th.colors
  return c.length === 1 ? `linear-gradient(135deg, ${c[0]}, color-mix(in srgb, ${c[0]} 55%, #fff))` : `linear-gradient(135deg, ${c.join(', ')})`
}
function spaceCard (sp) {
  const th = sp.theme
  const preview = el('div', { class: 'preview' }, el('span', { class: 'pv-icon' }, sp.icon || '•'), el('b', {}, sp.name), sp.profile ? el('small', {}, sp.profile) : null)
  preview.style.background = gradientCss(th)
  if (th.mode === 'dark') preview.classList.add('dark')
  const name = el('input', { type: 'text', value: sp.name, maxlength: '40' }); name.onchange = () => upd(sp.id, { name: name.value })
  const icon = el('input', { type: 'text', value: sp.icon, class: 'emoji', placeholder: '🙂', maxlength: '8' }); icon.onchange = () => upd(sp.id, { icon: icon.value })
  const picks = el('div', { class: 'emojis' }, ...EMOJI.map(e => el('button', { class: 'em' + (sp.icon === e ? ' on' : ''), onclick: () => upd(sp.id, { icon: e }) }, e)),
    el('button', { class: 'em', title: 'No icon', onclick: () => upd(sp.id, { icon: '' }) }, '∅'))
  const presets = el('div', { class: 'swatches' }, ...D.themePresets.map(([n, cols]) => {
    const b = el('button', { class: 'sw-btn' + (JSON.stringify(cols) === JSON.stringify(th.colors) ? ' on' : ''), title: n, onclick: () => upd(sp.id, { theme: { colors: cols } }) })
    b.style.background = gradientCss({ colors: cols }); return b
  }))
  const colourInputs = el('div', { class: 'colours' }, ...th.colors.map((c, i) => {
    const inp = el('input', { type: 'color', value: c, title: 'Colour ' + (i + 1) })
    inp.oninput = () => { const colors = [...th.colors]; colors[i] = inp.value; preview.style.background = gradientCss({ colors }) }
    inp.onchange = () => { const colors = [...th.colors]; colors[i] = inp.value; upd(sp.id, { theme: { colors } }) }
    return inp
  }),
  th.colors.length < 3 ? el('button', { class: 'b small', onclick: () => upd(sp.id, { theme: { colors: [...th.colors, th.colors[th.colors.length - 1]] } }) }, '＋ Colour') : null,
  th.colors.length > 1 ? el('button', { class: 'b small', onclick: () => upd(sp.id, { theme: { colors: th.colors.slice(0, -1) } }) }, '− Colour') : null)
  const mode = el('div', { class: 'seg' }, ...[['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([v, t]) => el('button', { class: th.mode === v ? 'on' : '', onclick: () => upd(sp.id, { theme: { mode: v } }) }, t)))
  const grain = el('input', { type: 'checkbox' }); grain.checked = th.grain; grain.onchange = () => upd(sp.id, { theme: { grain: grain.checked } })
  const inten = el('input', { type: 'range', min: '20', max: '100', value: String(Math.round(th.intensity * 100)) })
  inten.onchange = () => upd(sp.id, { theme: { intensity: Number(inten.value) / 100 } })
  const c = card(
    el('div', { class: 'row' }, preview),
    el('div', { class: 'row' }, label('Name'), name, sp.active ? null : el('button', { class: 'b', onclick: () => act('space-switch', sp.id) }, 'Switch To')),
    el('div', { class: 'row col' }, el('div', { class: 'row-head' }, label('Icon'), icon), picks),
    el('div', { class: 'row col' }, label('Theme presets'), presets),
    el('div', { class: 'row' }, label('Colours', 'Up to three — they blend into a gradient'), colourInputs),
    el('div', { class: 'row' }, label('Appearance'), mode),
    el('div', { class: 'row' }, label('Colour intensity'), inten),
    el('div', { class: 'row' }, label('Grain', 'Subtle paper-like texture'), el('label', { class: 'sw' }, grain, el('span')))
  )
  c.id = 'space-' + sp.id
  return c
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
api.on('settings', (d) => {
  D = d; if (d.page) current = d.page
  draw()
  if (d.focusSpace) document.getElementById('space-' + d.focusSpace)?.scrollIntoView({ block: 'start' })
})
api.send('settings-ready')
