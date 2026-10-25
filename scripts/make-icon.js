// Renders build/icon.svg to build/icon.png (1024px) using Electron's Chromium.
const { app, BrowserWindow } = require('electron')
const fs = require('fs'); const path = require('path')
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 1024, height: 1024, transparent: true, frame: false, webPreferences: { offscreen: true } })
  const svg = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.svg'), 'utf8')
  await w.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="1024" height="1024" ')}</body>`))
  await new Promise(r => setTimeout(r, 300))
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), img.resize({ width: 1024, height: 1024 }).toPNG())
  app.quit()
})
