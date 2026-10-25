'use strict'
// Hover card for Favorite tiles: recent emails for Gmail, otherwise a snapshot of the page.
const api = window.drift
const card = document.getElementById('card')
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
function favicon (src) { const i = document.createElement('img'); if (src && /^(https:|data:image)/.test(src)) i.src = src; i.onerror = () => i.remove(); return i }

api.on('preview', (d) => {
  document.body.classList.toggle('compose', !!d.compose)
  card.replaceChildren()
  if (d.kind === 'list') {
    const list = mk('div', 'list')
    for (const it of d.items) {
      const row = mk('div', 'it' + (it.unread ? '' : ' read'))
      const top = mk('div', 'top'); top.append(mk('span', 'from', it.from), mk('span', 'dt', it.date))
      row.append(top, mk('div', 'sub', it.subject || '(no subject)'))
      if (it.snippet) row.append(mk('div', 'sn', it.snippet))
      row.onclick = () => api.send('preview-open', d.id, it.i)
      list.append(row)
    }
    card.append(list)
  } else if (d.kind === 'snapshot') {
    const s = mk('div', 'snap'); const img = document.createElement('img'); img.src = d.image; s.append(img)
    const meta = mk('div', 'meta'); meta.append(favicon(d.favicon), mk('b', null, d.title || d.url)); s.append(meta)
    s.onclick = () => api.send('preview-open', d.id, -1)
    card.append(s)
  } else {
    const c = mk('div', 'center'); c.append(favicon(d.favicon), mk('div', null, d.loading ? 'Loading preview…' : (d.title || d.url)))
    if (!d.loading) c.append(mk('div', null, 'Click to open'))
    c.onclick = () => api.send('preview-open', d.id, -1)
    card.append(c)
  }
})
document.getElementById('fab').onclick = () => api.send('preview-compose')
addEventListener('mouseenter', () => api.send('preview-hold'))
addEventListener('mouseleave', () => api.send('preview-release'))
