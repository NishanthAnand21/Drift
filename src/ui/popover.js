'use strict'
// Arc-style popovers drawn over the whole window: the sidebar “+” menu and the site-controls card.
const api = window.drift
const card = document.getElementById('card'); const arrow = document.getElementById('arrow')
const I = {
  spaces: '<rect x="7.5" y="7.5" width="12" height="12" rx="2.5"/><path d="M4.5 15.5v-9a2 2 0 0 1 2-2h9"/><path d="M13.5 10.5v6M10.5 13.5h6"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  boost: '<path d="M14 4l6 6-8.5 8.5a3 3 0 0 1-4.2 0l-1.8-1.8a3 3 0 0 1 0-4.2z"/><path d="M11 7l6 6M7 17l-3 3"/><path d="M19 3.5v2M20 4.5h-2"/>',
  split: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M10 4.5v15M14 12h4.5M16.25 9.75v4.5"/>',
  visual: '<rect x="3.5" y="5" width="13" height="9" rx="1.5"/><rect x="7.5" y="9" width="13" height="10" rx="1.5"/><path d="M10.5 16l2.5-2.5 2 2 3-3"/>',
  newtab: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8.5v7M8.5 12h7"/>',
  share: '<path d="M12 3.5v11M8 7.5l4-4 4 4"/><path d="M7 10.5H6a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 6 20.5h12a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 18 10.5h-1"/>',
  camera: '<path d="M4 8.5a2 2 0 0 1 2-2h2l1.5-2h5l1.5 2h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/>',
  scan: '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M8.5 10h7M8.5 14h5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
  dots: '<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>',
  plus: '<path d="M12 6v12M6 12h12"/>',
  // one icon per site setting
  media: '<rect x="3.5" y="6.5" width="12" height="11" rx="2.5"/><path d="M15.5 10.5l5-3v9l-5-3"/>',
  geolocation: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  notifications: '<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  'display-capture': '<rect x="3.5" y="4.5" width="17" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>',
  'clipboard-read': '<rect x="5.5" y="5" width="13" height="16" rx="2"/><path d="M9 5V3.8h6V5M9 11h6M9 15h4"/>',
  midi: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M7.5 5.5v8h3v-8M13.5 5.5v8h3v-8M12 13.5v5"/>',
  pip: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><rect x="11.5" y="11.5" width="6.5" height="4.5" rx="1"/>',
  popups: '<rect x="3.5" y="7.5" width="13" height="12" rx="2"/><path d="M7.5 7.5v-2a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2"/>',
  adblock: '<path d="M12 3.5l7 2.5v5.5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>'
}
function svg (n) { const e = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); e.setAttribute('viewBox', '0 0 24 24'); e.setAttribute('class', 'i'); e.innerHTML = I[n] || ''; return e }
const mk = (tag, cls, ...kids) => { const e = document.createElement(tag); if (cls) e.className = cls; for (const k of kids) if (k != null) e.append(k); return e }
const pick = (id) => api.send('popover-pick', id)
let last = null

function menu (d) {
  return d.items.map(it => {
    if (it === '-') return mk('div', 'sep')
    const row = mk('div', 'mi', svg(it.icon), it.label, it.keys ? mk('span', 'k', it.keys) : null)
    row.onclick = () => pick(it.id)
    return row
  })
}
const VALUE = { ask: 'Ask', allow: 'Allowed', block: 'Blocked', on: 'On', off: 'Off' }
const NEXT = { ask: 'allow', allow: 'block', block: 'ask' }
function site (d) {
  const btn = (icon, id, title) => { const b = mk('div', 'act', svg(icon)); b.title = title; b.onclick = () => pick(id); return b }
  const out = [mk('div', 'acts', btn('share', 'share', 'Share'), btn('boost', 'boost', 'Boost this site'), btn('camera', 'screenshot', 'Screenshot (copied + saved to Downloads)'), btn('scan', 'inspect', 'Site Inspector'))]
  out.push(mk('h4', null, 'Extensions'))
  const exts = mk('div', 'exts', ...d.extensions.map(e => {
    const t = mk('div', 'ext'); t.title = e.name
    if (e.icon) { const im = document.createElement('img'); im.src = e.icon; t.append(im) } else t.textContent = e.name.slice(0, 2)
    t.onclick = () => pick('ext:' + e.id); return t
  }))
  const add = mk('div', 'ext', svg('plus')); add.title = 'Get extensions'; add.onclick = () => pick('add-ext'); exts.append(add)
  out.push(exts, mk('h4', null, 'Settings'))
  for (const s of d.settings) {
    const off = s.value === 'block' || s.value === 'off'
    const row = mk('div', 'set' + (off ? ' off' : ''), mk('div', 'ic', svg(I[s.key] ? s.key : 'gear')), mk('div', 'txt', mk('b', null, s.label), mk('span', null, VALUE[s.value] || s.value)))
    row.onclick = () => {
      const next = s.key === 'adblock' ? (s.value === 'on' ? 'off' : 'on') : ['pip', 'popups'].includes(s.key) ? (s.value === 'allow' ? 'block' : 'allow') : NEXT[s.value] || 'allow'
      api.send('site-setting', s.key, next)
    }
    out.push(row)
  }
  const sec = mk('div', 'pill' + (d.secure ? '' : ' bad'), svg(d.secure ? 'lock' : 'warn'), d.secure ? 'Secure' : 'Not Secure'); sec.title = 'Connection & certificate details'; sec.onclick = () => pick('secure')
  const dots = mk('div', 'dots', svg('dots')); dots.onclick = () => pick('more')
  out.push(mk('div', 'foot', sec, d.blocked ? mk('span', 'blk', `${d.blocked} blocked`) : null, dots))
  return out
}

function place (d) {
  const W = d.kind === 'site' ? 296 : 248
  card.style.width = W + 'px'
  const a = d.anchor; const vw = innerWidth; const vh = innerHeight
  if (!a) return
  if (d.place === 'above') {
    const left = Math.max(8, Math.min(a.x + a.width - W + 22, vw - W - 8))
    card.style.left = left + 'px'; card.style.top = 'auto'; card.style.bottom = (vh - a.y + 12) + 'px'
    arrow.style.left = (a.x + a.width / 2 - 6) + 'px'; arrow.style.top = (a.y - 18) + 'px'
  } else {
    const left = Math.max(8, Math.min(a.x + a.width / 2 - W * 0.75, vw - W - 8))
    card.style.left = left + 'px'; card.style.bottom = 'auto'; card.style.top = (a.y + a.height + 12) + 'px'
    arrow.style.left = (a.x + a.width / 2 - 6) + 'px'; arrow.style.top = (a.y + a.height + 7) + 'px'
  }
}
api.on('popover', (d) => {
  if (!d) return
  if (d.refresh && last) d = { ...d, anchor: last.anchor, place: last.place }
  last = d
  document.documentElement.classList.toggle('light', d.dark === false)
  card.replaceChildren(...(d.kind === 'menu' ? menu(d) : site(d)))
  place(d)
})
addEventListener('mousedown', (e) => { if (!card.contains(e.target)) api.send('popover-close') })
addEventListener('keydown', (e) => { if (e.key === 'Escape') api.send('popover-close') })
