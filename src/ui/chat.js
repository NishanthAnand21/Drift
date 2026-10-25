'use strict'
const api = window.drift
const $ = (s) => document.querySelector(s)
const log = $('#log'); const q = $('#q'); const sendBtn = $('#send')
let busy = false; let current = null; let raw = ''

// ---- safe Markdown → DOM (no innerHTML) --------------------------------------------
function inline (text, parent) {
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g
  let last = 0; let m
  while ((m = re.exec(text))) {
    if (m.index > last) parent.append(text.slice(last, m.index))
    if (m[1]) { const c = document.createElement('code'); c.textContent = m[1].slice(1, -1); parent.append(c) } else if (m[2]) { const b = document.createElement('strong'); inline(m[2].slice(2, -2), b); parent.append(b) } else if (m[3]) { const i = document.createElement('em'); inline(m[3].slice(1, -1), i); parent.append(i) } else if (m[4]) parent.append(link(m[4].slice(1, m[4].indexOf('](')), m[5]))
    else if (m[6]) parent.append(link(m[6], m[6]))
    last = re.lastIndex
  }
  if (last < text.length) parent.append(text.slice(last))
}
function link (label, href) {
  const a = document.createElement('a'); a.textContent = label; a.title = href
  a.onclick = (e) => { e.preventDefault(); api.send('chat-open-link', href) }
  return a
}
function render (md, el) {
  el.replaceChildren()
  const lines = md.split('\n'); let i = 0; let list = null; let para = []
  const flushPara = () => { if (para.length) { const p = document.createElement('p'); inline(para.join(' '), p); el.append(p); para = [] } }
  const flushList = () => { list = null }
  while (i < lines.length) {
    const line = lines[i]
    if (/^```/.test(line)) {
      flushPara(); flushList()
      const code = []; i++
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++])
      const pre = document.createElement('pre'); const c = document.createElement('code'); c.textContent = code.join('\n'); pre.append(c); el.append(pre); i++; continue
    }
    const h = line.match(/^(#{1,3})\s+(.*)/)
    const li = line.match(/^\s*([-*]|\d+\.)\s+(.*)/)
    if (h) { flushPara(); flushList(); const e = document.createElement('h' + h[1].length); inline(h[2], e); el.append(e) } else if (li) {
      flushPara()
      const ordered = /\d/.test(li[1])
      if (!list || list.tagName !== (ordered ? 'OL' : 'UL')) { list = document.createElement(ordered ? 'ol' : 'ul'); el.append(list) }
      const item = document.createElement('li'); inline(li[2], item); list.append(item)
    } else if (!line.trim()) { flushPara(); flushList() } else { flushList(); para.push(line) }
    i++
  }
  flushPara()
}

// ---- conversation ----------------------------------------------------------------------
function add (cls, text) {
  $('#empty')?.remove()
  const d = document.createElement('div'); d.className = cls
  if (text != null) d.textContent = text
  log.append(d); log.scrollTop = log.scrollHeight
  return d
}
function setBusy (b) { busy = b; sendBtn.textContent = b ? '■' : '↑'; sendBtn.classList.toggle('stop', b); sendBtn.title = b ? 'Stop' : 'Send (Enter)' }

function submit () {
  if (busy) return api.send('chat-stop')
  const text = q.value.trim(); if (!text) return
  const me = add('msg me')
  if ($('#usepage').checked) { const c = document.createElement('span'); c.className = 'ctx'; c.textContent = '📄 ' + ($('#pagename').textContent || 'this page'); me.append(c) }
  me.append(text)
  q.value = ''; grow()
  api.send('chat-send', text, $('#usepage').checked)
}
function grow () { q.style.height = 'auto'; q.style.height = Math.min(160, q.scrollHeight) + 'px' }

api.on('chat', (type, data) => {
  if (type === 'init') {
    const sel = $('#model'); sel.replaceChildren(...data.models.map(([id, name]) => { const o = document.createElement('option'); o.value = id; o.textContent = name.replace('Claude ', ''); o.selected = id === data.model; return o }))
    $('#keyhint').textContent = data.hasKey ? '' : 'Add your Claude API key in Settings → Integrations (or set ANTHROPIC_API_KEY).'
    $('#pagename').textContent = data.pageTitle || ''
  }
  if (type === 'page') $('#pagename').textContent = data || ''
  if (type === 'focus') q.focus()
  if (type === 'ask' && !busy) { q.value = data; submit() }
  if (type === 'start') { setBusy(true); raw = ''; current = add('msg ai typing') }
  if (type === 'delta') { raw += data; render(raw, current); log.scrollTop = log.scrollHeight }
  if (type === 'notice') add('note', data)
  if (type === 'done') { setBusy(false); current?.classList.remove('typing'); if (data?.servedBy) add('note', `Answered by ${data.servedBy}`); current = null }
  if (type === 'error') { setBusy(false); if (current && !raw) current.remove(); else current?.classList.remove('typing'); add('err', data); current = null }
  if (type === 'reset') { log.replaceChildren(); const e = document.createElement('div'); e.className = 'empty'; e.id = 'empty'; e.textContent = 'New chat — ask Claude anything.'; log.append(e) }
})

q.addEventListener('input', grow)
q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit() } if (e.key === 'Escape') api.send('chat-close') })
sendBtn.onclick = submit
$('#new').onclick = () => api.send('chat-reset')
$('#close').onclick = () => api.send('chat-close')
$('#model').onchange = (e) => api.send('chat-model', e.target.value)
api.send('chat-ready')
