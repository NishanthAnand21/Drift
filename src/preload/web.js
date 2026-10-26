'use strict'
// Runs (isolated) in every web page: password autofill, save-on-submit and the
// strong-password generator. Page scripts cannot reach this code or the IPC bridge.
const { ipcRenderer } = require('electron')

// Shift+click a link → Peek (preview without opening a tab)
document.addEventListener('click', (e) => {
  if (!e.isTrusted || !e.shiftKey || e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey) return
  const a = e.target.closest?.('a[href]')
  if (!a || !/^https?:/.test(a.href)) return
  e.preventDefault(); e.stopImmediatePropagation()
  ipcRenderer.send('peek-link', a.href)
}, true)

// Two-finger swipe left/right → back/forward (Electron has no history swipe of its own on macOS), and
// the mouse's back/forward buttons. Only real input counts; a swipe the page scrolls or handles itself
// (carousels, maps) is left to the page. An arrow slides in from the edge as you swipe, like Chrome.
;(() => {
  const NEED = 140 // px of horizontal travel
  let acc = 0; let idle = null; let done = false; let skip = false; let dot = null; let host = null
  const scrollsX = (start, dx) => {
    for (let n = start; n && n.nodeType === 1; n = n.parentElement) {
      if (n.scrollWidth > n.clientWidth + 1 && /(auto|scroll|overlay)/.test(getComputedStyle(n).overflowX)) {
        if (dx < 0 ? n.scrollLeft > 0 : n.scrollLeft + n.clientWidth < n.scrollWidth - 1) return true
      }
    }
    const se = document.scrollingElement
    return !!se && se.scrollWidth > se.clientWidth + 1 && (dx < 0 ? se.scrollLeft > 0 : se.scrollLeft + se.clientWidth < se.scrollWidth - 1)
  }
  function arrow (p, back) {
    if (!p) { if (host) host.style.display = 'none'; return }
    if (!host) {
      // styled through the CSSOM only, so a page's Content-Security-Policy can't strip it
      host = document.createElement('drift-swipe')
      Object.assign(host.style, { position: 'fixed', left: '0', top: '0', width: '0', height: '0', zIndex: '2147483647', pointerEvents: 'none' })
      const sh = host.attachShadow({ mode: 'closed' })
      dot = document.createElement('div')
      Object.assign(dot.style, { position: 'fixed', top: '50%', width: '42px', height: '42px', marginTop: '-21px', borderRadius: '50%', display: 'grid', placeItems: 'center', color: '#fff', font: '600 20px -apple-system,system-ui,sans-serif', boxShadow: '0 4px 14px rgba(0,0,0,.25)', transition: 'background .12s' })
      sh.append(dot); document.documentElement.appendChild(host)
    }
    host.style.display = 'block'
    dot.textContent = back ? '←' : '→'
    const x = (-46 + p * 64) + 'px'
    dot.style.left = back ? x : ''; dot.style.right = back ? '' : x
    dot.style.opacity = String(Math.min(1, p * 1.5))
    dot.style.background = p >= 1 ? '#7c5cff' : 'rgba(29,26,36,.85)'
  }
  addEventListener('wheel', (e) => {
    if (!e.isTrusted || e.ctrlKey) return
    clearTimeout(idle); idle = setTimeout(() => { acc = 0; done = false; skip = false; arrow(0) }, 180)
    if (done || skip) return
    if (!acc) {
      if (Math.abs(e.deltaX) < 3 || Math.abs(e.deltaX) < Math.abs(e.deltaY) * 1.5) return // vertical scrolling
      if (e.defaultPrevented || scrollsX(e.target, e.deltaX)) { skip = true; return } // the page uses it
    }
    acc += e.deltaX
    const back = acc < 0; const p = Math.min(1, Math.abs(acc) / NEED)
    arrow(p, back)
    if (p >= 1) { done = true; setTimeout(() => arrow(0), 160); ipcRenderer.send('web-nav', back ? 'back' : 'forward') }
  }, { passive: true })
  addEventListener('mouseup', (e) => {
    if (!e.isTrusted) return
    if (e.button === 3) ipcRenderer.send('web-nav', 'back'); else if (e.button === 4) ipcRenderer.send('web-nav', 'forward')
  }, true)
})()

const secureCtx = location.protocol === 'https:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
if (secureCtx) {
  let host = null; let shadow = null; let menuFor = null
  const seen = new WeakSet()

  const visible = (el) => el.offsetWidth > 0 && el.offsetHeight > 0 && getComputedStyle(el).visibility !== 'hidden'
  const isUserField = (el) => el.tagName === 'INPUT' && /^(text|email|tel|)$/i.test(el.type) && !el.readOnly && visible(el)
  const pwFields = (root = document) => [...root.querySelectorAll('input[type=password]')].filter(visible)

  function usernameFor (pw) {
    const scope = pw.form || document
    const inputs = [...scope.querySelectorAll('input')]
    const idx = inputs.indexOf(pw)
    for (let i = idx - 1; i >= 0; i--) if (isUserField(inputs[i])) return inputs[i]
    return scope.querySelector('input[autocomplete~=username],input[type=email]') || null
  }
  function setValue (el, v) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  function genPassword () {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
    const r = crypto.getRandomValues(new Uint32Array(18))
    const s = [...r].map(x => chars[x % chars.length]).join('')
    return `${s.slice(0, 6)}-${s.slice(6, 12)}-${s.slice(12)}`
  }

  function ensureMenu () {
    if (host) return
    host = document.createElement('drift-autofill')
    host.style.cssText = 'position:fixed;z-index:2147483647;inset:auto;display:none'
    shadow = host.attachShadow({ mode: 'closed' })
    shadow.innerHTML = `<style>
      .m{font:13px -apple-system,system-ui,sans-serif;background:#fff;color:#222;border-radius:9px;box-shadow:0 8px 30px #0003,0 0 0 1px #0002;padding:4px;min-width:220px}
      @media (prefers-color-scheme:dark){.m{background:#2a2730;color:#eee}}
      .i{padding:7px 10px;border-radius:6px;cursor:default;display:flex;gap:8px;align-items:center}
      .i:hover{background:#7c5cff22}.s{opacity:.55;font-size:11px;padding:4px 10px}</style><div class="m"></div>`
    document.documentElement.appendChild(host)
    document.addEventListener('mousedown', (e) => { if (!e.composedPath().includes(host)) hide() }, true)
    addEventListener('scroll', hide, true); addEventListener('resize', hide)
  }
  function hide () { if (host) host.style.display = 'none'; menuFor = null }

  function show (field, items) {
    ensureMenu()
    const box = shadow.querySelector('.m')
    box.replaceChildren()
    const head = document.createElement('div'); head.className = 's'; head.textContent = 'Drift Passwords'; box.append(head)
    for (const it of items) {
      const d = document.createElement('div'); d.className = 'i'; d.textContent = it.label
      d.addEventListener('mousedown', (e) => { e.preventDefault(); if (e.isTrusted) { hide(); it.run() } })
      box.append(d)
    }
    const r = field.getBoundingClientRect()
    host.style.left = Math.max(4, r.left) + 'px'
    host.style.top = Math.min(innerHeight - 40, r.bottom + 4) + 'px'
    host.style.display = 'block'
    menuFor = field
  }

  async function onFocus (e) {
    const field = e.target
    if (!e.isTrusted || menuFor === field) return
    const pw = field.type === 'password' ? field : pwFields(field.form || document)[0]
    if (!pw) return
    const isNew = /new-password/.test(pw.autocomplete) || pwFields(pw.form || document).length >= 2
    let res
    try { res = await ipcRenderer.invoke('pw:query') } catch { return }
    if (!res.enabled && !res.entries.length) return
    const items = res.entries.map(en => ({
      label: '🔑 ' + (en.username || '(no username)'),
      run: async () => {
        const cred = await ipcRenderer.invoke('pw:fill', en.id); if (!cred) return
        const u = usernameFor(pw); if (u && cred.username) setValue(u, cred.username)
        setValue(pw, cred.password)
      }
    }))
    if (isNew && field.type === 'password') {
      items.push({
        label: '✦ Use a strong password',
        run: () => { const p = genPassword(); for (const f of pwFields(pw.form || document)) setValue(f, p) }
      })
    }
    if (items.length) show(field, items)
  }

  // Capture credentials when a login/sign-up form is submitted
  let lastSent = ''
  function capture (form) {
    const pws = pwFields(form || document).filter(f => f.value)
    if (!pws.length) return
    const pw = pws[pws.length - 1]
    const u = usernameFor(pws[0])
    const key = (u?.value || '') + '\n' + pw.value
    if (key === lastSent) return
    lastSent = key
    ipcRenderer.send('pw:submitted', (u?.value || '').trim(), pw.value)
  }
  document.addEventListener('submit', (e) => capture(e.target), true)
  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return
    const b = e.target.closest?.('button,input[type=submit],[role=button]')
    if (b && (b.type === 'submit' || b.form || pwFields(document).some(p => p.value))) setTimeout(() => capture(b.form), 0)
  }, true)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide()
    if (e.key === 'Enter' && e.isTrusted && e.target.tagName === 'INPUT') capture(e.target.form)
  }, true)
  addEventListener('pagehide', () => capture())

  function scan () {
    for (const f of document.querySelectorAll('input')) {
      if (seen.has(f)) continue
      if (f.type === 'password' || f.autocomplete?.includes('username') || f.type === 'email') {
        seen.add(f); f.addEventListener('focus', onFocus); f.addEventListener('click', onFocus)
      }
    }
    for (const pw of pwFields()) { const u = usernameFor(pw); if (u && !seen.has(u)) { seen.add(u); u.addEventListener('focus', onFocus); u.addEventListener('click', onFocus) } }
  }
  let pending = false
  const schedule = () => { if (!pending) { pending = true; setTimeout(() => { pending = false; scan() }, 300) } }
  addEventListener('DOMContentLoaded', () => { scan(); new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true }) })
}
