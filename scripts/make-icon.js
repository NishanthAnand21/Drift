// Renders Drift's app icons with Electron's Chromium:
//   build/icon.png (1024px, packaging) and src/ui/icons/<variant>.png (512px, Settings → Icon).
const { app, BrowserWindow } = require('electron')
const fs = require('fs'); const path = require('path')
const root = path.join(__dirname, '..')
const wave = (stroke, a = 'ffffffa0') => `
<path d="M260 610c90-170 190-170 260-80s170 90 250-80" fill="none" stroke="${stroke}" stroke-width="78" stroke-linecap="round"/>
<path d="M260 440c90-170 190-170 260-80s170 90 250-80" fill="none" stroke="#${a}" stroke-width="54" stroke-linecap="round"/>`
const VARIANTS = {
  aurora: `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9b7bff"/><stop offset="1" stop-color="#ff7aa2"/></linearGradient></defs>
    <rect x="100" y="100" width="824" height="824" rx="190" fill="url(#g)"/>${wave('#fff')}`,
  midnight: `<defs><radialGradient id="g" cx=".3" cy=".2" r="1"><stop offset="0" stop-color="#3b2a7a"/><stop offset="1" stop-color="#0b0a1f"/></radialGradient>
    <filter id="f"><feGaussianBlur stdDeviation="14"/></filter></defs>
    <rect x="100" y="100" width="824" height="824" rx="190" fill="url(#g)"/>
    <g filter="url(#f)" opacity=".9">${wave('#ff5fd2', 'b48bff')}</g>${wave('#ffd6f5', 'e6d6ff')}`,
  sunrise: `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe7a3"/><stop offset="1" stop-color="#ffb38a"/></linearGradient></defs>
    <rect x="100" y="100" width="824" height="824" rx="190" fill="url(#g)"/>${wave('#e2553f', 'f39a3d')}`,
  mono: `<rect x="100" y="100" width="824" height="824" rx="190" fill="#2a2a2e"/>
    <rect x="100" y="100" width="824" height="824" rx="190" fill="none" stroke="#ffffff22" stroke-width="6"/>${wave('#f2f2f2', '9a9aa2')}`
}
async function render (w, svg, size, out) {
  const doc = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">${svg}</svg>`
  await w.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0;background:transparent">${doc}</body>`))
  await new Promise(r => setTimeout(r, 250))
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, img.resize({ width: size, height: size, quality: 'best' }).toPNG())
}
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 1024, height: 1024, transparent: true, frame: false, webPreferences: { offscreen: true } })
  fs.writeFileSync(path.join(root, 'build', 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${VARIANTS.aurora}</svg>\n`)
  await render(w, VARIANTS.aurora, 1024, path.join(root, 'build', 'icon.png'))
  for (const [name, svg] of Object.entries(VARIANTS)) await render(w, svg, 512, path.join(root, 'src', 'ui', 'icons', name + '.png'))
  app.quit()
})
