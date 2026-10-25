'use strict'
const api = window.drift
const on = (id, action) => { document.getElementById(id).onclick = () => api.send(action) }
on('add', 'claude-add-page')
on('reload', 'claude-reload')
on('open', 'claude-open-tab')
on('menu', 'chat-menu')
on('close', 'chat-close')
