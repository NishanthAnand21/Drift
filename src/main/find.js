'use strict'
// Find in page with Highlight All / Match Case / Match Diacritics / Whole Words.
// Runs in an isolated world (page scripts can't see or tamper with it) and paints
// matches with the CSS Custom Highlight API, so the page's DOM is never modified.

const WORLD = 996

// The engine is defined once per page in the isolated world, then called with a JSON command.
const ENGINE = `
window.__driftFind = window.__driftFind || (() => {
  const st = { key: '', ranges: [], i: -1 }
  const clear = () => { CSS.highlights.delete('drift-find'); CSS.highlights.delete('drift-find-active') }
  function search (q, o) {
    const fold = (s) => { let r = o.diacritics ? s : s.normalize('NFD').replace(/\\p{M}/gu, ''); return o.matchCase ? r : r.toLowerCase() }
    const needle = fold(q).replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&')
    const re = new RegExp(o.wholeWords ? '(?<![\\\\p{L}\\\\p{N}_])' + needle + '(?![\\\\p{L}\\\\p{N}_])' : needle, 'gu')
    const ranges = []
    const skip = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (!n.parentElement || skip.test(n.parentElement.tagName) || !n.data.trim()) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    })
    for (let n; (n = walker.nextNode()) && ranges.length < 5000;) {
      const src = n.data; let folded = ''; const map = []
      for (let k = 0; k < src.length; k++) { const f = fold(src[k]); for (let j = 0; j < f.length; j++) map.push(k); folded += f }
      re.lastIndex = 0
      for (let m; (m = re.exec(folded)) && ranges.length < 5000;) {
        if (!m[0].length) { re.lastIndex++; continue }
        const r = new Range(); r.setStart(n, map[m.index]); r.setEnd(n, map[m.index + m[0].length - 1] + 1)
        if (r.getClientRects().length) ranges.push(r)
      }
    }
    return ranges
  }
  return (cmd) => {
    if (cmd.clear || !cmd.q) { clear(); st.key = ''; st.ranges = []; st.i = -1; return { matches: 0, active: 0 } }
    const key = JSON.stringify([cmd.q, !!cmd.o.matchCase, !!cmd.o.diacritics, !!cmd.o.wholeWords])
    if (key !== st.key || cmd.dir === 'new') {
      st.ranges = search(cmd.q, cmd.o); st.key = key
      // start at the first match below the top of the viewport, like Chrome
      const firstVisible = st.ranges.findIndex(r => r.getBoundingClientRect().top >= 0)
      st.i = st.ranges.length ? Math.max(0, firstVisible) : -1
    } else if (st.ranges.length) {
      st.i = (st.i + (cmd.dir === 'prev' ? -1 : 1) + st.ranges.length) % st.ranges.length
    }
    clear()
    if (!st.ranges.length) return { matches: 0, active: 0 }
    if (cmd.o.highlightAll) CSS.highlights.set('drift-find', new Highlight(...st.ranges))
    const cur = st.ranges[st.i]
    CSS.highlights.set('drift-find-active', new Highlight(cur))
    const el = cur.startContainer.parentElement
    const rect = cur.getBoundingClientRect()
    if (el && (rect.top < 60 || rect.bottom > innerHeight - 20)) el.scrollIntoView({ block: 'center', behavior: 'instant' })
    return { matches: st.ranges.length, active: st.i + 1 }
  }
})()
`

const styled = new WeakSet() // webContents that already have the highlight styles for the current page

async function find (wc, q, opts, dir = 'new', accent = '#7c5cff') {
  if (!wc || wc.isDestroyed()) return { matches: 0, active: 0 }
  if (!styled.has(wc)) {
    styled.add(wc)
    wc.once('did-navigate', () => styled.delete(wc))
    wc.insertCSS(`::highlight(drift-find){background-color:#ffd54acc;color:#111}::highlight(drift-find-active){background-color:${/^#[0-9a-f]{6}$/i.test(accent) ? accent : '#7c5cff'};color:#fff}`).catch(() => {})
  }
  const cmd = JSON.stringify({ q: String(q || '').slice(0, 500), o: opts || {}, dir, clear: !q })
  try {
    return await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: ENGINE + `;window.__driftFind(${cmd})` }])
  } catch { return { matches: 0, active: 0 } }
}

function clear (wc) {
  if (!wc || wc.isDestroyed()) return
  wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: ENGINE + ';window.__driftFind({ clear: true })' }]).catch(() => {})
}

module.exports = { find, clear }
