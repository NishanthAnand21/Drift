'use strict'
const api = window.drift
const url = document.getElementById('url')
const mini = (a, v) => api.send('mini-action', a, v)
api.on('mini', (s) => { if (document.activeElement !== url) url.value = s.url && !s.url.startsWith('about:') ? s.url : ''; document.title = s.title || 'Drift'; document.getElementById('back').disabled = !s.canBack })
api.on('mini-focus', () => url.focus())
url.addEventListener('keydown', (e) => { if (e.key === 'Enter') { mini('go', url.value); url.blur() } })
url.addEventListener('focus', () => url.select())
document.getElementById('back').onclick = () => mini('back')
document.getElementById('reload').onclick = () => mini('reload')
document.getElementById('copy').onclick = () => mini('copy')
document.getElementById('open').onclick = () => mini('open-in-drift')
