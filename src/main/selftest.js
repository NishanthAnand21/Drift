'use strict'
// Scripted end-to-end smoke test: DRIFT_SELFTEST=<outdir> electron .
const fs = require('fs'); const path = require('path'); const os = require('os')
module.exports = (D) => {
  const out = process.env.DRIFT_SELFTEST
  D.app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-')))
  const log = []; const ok = (name, cond, extra = '') => { log.push(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`); console.log(log[log.length - 1]) }
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const loaded = (id) => new Promise(r => { const wc = D.views.get(id).webContents; if (!wc.isLoading()) return r(); wc.once('did-stop-loading', r); setTimeout(r, 20000) })
  const shot = async (n) => { await wait(300); require('child_process').execSync(`import -window root ${path.join(out, n + '.png')}`) }
  D.app.whenReady().then(async () => {
    await wait(2500)
    const sp = () => D.space()
    try {
      // an unloaded favourite should still show its real site icon
      const fav0 = D.S.profiles[0].favorites[0]; D.S.tabs[fav0].url = 'https://nodejs.org/'; D.S.tabs[fav0].favicon = null
      const a = D.newTab('https://nodejs.org/en'); await loaded(a); await wait(1500)
      ok('browse real site', /Node/.test(D.tab(a).title), D.tab(a).title)
      const b = D.newTab('http://neverssl.com'); await loaded(b); await wait(800)
      ok('https-only upgrade/fallback page', D.views.get(b).webContents.getURL().length > 0, D.views.get(b).webContents.getURL().slice(0, 90))
      D.togglePin(a); ok('pin tab', sp().pinned.includes(a))
      D.toggleFavorite(a); ok('favorite tab', D.S.profiles[0].favorites.includes(a))
      D.activateTab(a)
      const c = D.newTab('https://github.com/electron/electron'); await loaded(c)
      D.openSplit(a); await wait(1500)
      ok('split view', sp().split && D.win.contentView.children.length >= 2)
      await shot('1-split')
      const icon = await D.win.webContents.executeJavaScript(`(() => { const i = document.querySelector('#favorites .fav img'); return i && i.complete && i.naturalWidth > 0 ? i.src : '' })()`)
      ok('unloaded favourite shows site icon', !D.views.has(fav0) && /nodejs\.org\/favicon\.ico/.test(icon), icon)
      D.ACTIONS.unsplit()
      D.commandBar('new'); await wait(800); await shot('2-command-bar')
      ok('command bar opens', D.overlayOpen?.mode === 'new'); D.closeOverlay()
      D.commandBar('edit'); await wait(300); ok('cmd+L edit mode', D.overlayOpen?.mode === 'edit'); D.closeOverlay()
      D.createSpace('Work'); await wait(300)
      ok('new space', D.S.spaces.length === 2 && D.S.activeSpaceId !== 'home')
      D.space().color = '#2bb3a3'
      const w = D.newTab('https://github.com'); await loaded(w); await wait(1000); await shot('3-work-space')
      D.tab(w).lastActiveAt = 0; D.activateTab(D.newTab('about:blank'))
      D.autoArchive(); ok('auto-archive', !D.tab(w) && D.S.archive.some(x => x.url.includes('github')))
      D.createSpace('Private', { newProfile: true }); ok('space with separate profile', D.S.profiles.length === 2)
      D.switchSpace('home'); await wait(500)
      D.ACTIONS['toggle-sidebar'](); await wait(400); await shot('4-sidebar-hidden'); D.ACTIONS['toggle-sidebar']()
    } catch (e) { ok('exception', false, e.stack) }
    fs.writeFileSync(path.join(out, 'results.txt'), log.join('\n'))
    D.app.exit(0)
  })
}
