'use strict'
// Transparent full-window layer shown only while a split-view divider is being dragged.
const api = window.drift
if (new URLSearchParams(location.search).get('dir') === 'col') document.body.className = 'col'
let last = 0
addEventListener('mousemove', (e) => { const now = performance.now(); if (now - last > 12) { last = now; api.send('split-drag', e.clientX, e.clientY) } })
addEventListener('mouseup', () => api.send('split-drag-end'))
addEventListener('blur', () => api.send('split-drag-end'))
addEventListener('keydown', (e) => { if (e.key === 'Escape') api.send('split-drag-end') })
