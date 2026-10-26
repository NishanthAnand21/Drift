'use strict'
// Arc's “New Tab Created” pill: main shows this view for a few seconds after a link opens in the background.
// Clicking jumps to that tab; hovering keeps it up. A null payload means “leave” (main detaches us right after).
const api = window.drift
const pill = document.getElementById('pill')
api.on('notice', (d) => {
  if (!d) { pill.classList.remove('in'); pill.classList.add('out'); return }
  pill.textContent = String(d.text || '')
  if (/^#[0-9a-f]{6}$/i.test(d.color)) document.documentElement.style.setProperty('--c', d.color)
  pill.classList.toggle('dark', !!d.dark)
  if (pill.classList.contains('in')) return // a newer tab while it's still up: it just retargets
  pill.classList.remove('out'); void pill.offsetWidth
  pill.classList.add('in')
})
pill.onclick = () => api.send('notice-open')
pill.onmouseenter = () => api.send('notice-hover', true)
pill.onmouseleave = () => api.send('notice-hover', false)
