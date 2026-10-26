'use strict'
// Bridge for Drift's own UI pages only (never loaded into websites).
const { contextBridge, ipcRenderer } = require('electron')
const CHANNELS = new Set(['state', 'toast', 'layout', 'open', 'find-result', 'settings', 'chat', 'mini', 'mini-focus', 'peek-title', 'dl-thumb', 'popover', 'preview', 'sidebar-peek', 'notice'])
contextBridge.exposeInMainWorld('drift', {
  send: (action, ...args) => ipcRenderer.send('ui', action, ...args),
  suggest: (q) => ipcRenderer.invoke('suggest', q),
  normalize: (q) => ipcRenderer.invoke('normalize', q),
  on: (ch, fn) => { if (CHANNELS.has(ch)) ipcRenderer.on(ch, (_e, ...a) => fn(...a)) }
})
