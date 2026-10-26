'use strict'
// Toasts while the sidebar is hidden (the docked sidebar shows its own); main sizes this view to fit.
const box = document.getElementById('toasts')
window.drift.on('toast', (msg) => {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg
  box.append(t)
  setTimeout(() => t.classList.add('leaving'), 2420) // 160ms exit, then it goes at the usual 2600
  setTimeout(() => t.remove(), 2600)
})
