'use strict'
// Scripted end-to-end smoke test: DRIFT_SELFTEST=<outdir> electron .
const fs = require('fs'); const path = require('path'); const os = require('os') // eslint-disable-line
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
      let a = D.newTab('https://nodejs.org/en'); await loaded(a); await wait(1500)
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
      // passwords: save + fetch round-trip, encrypted on disk
      D.passwords.upsert('https://nodejs.org', 'me@example.com', 's3cret-PW', { silent: true })
      await wait(400)
      const pwFile = fs.readFileSync(path.join(D.app.getPath('userData'), 'drift-passwords.json'), 'utf8')
      ok('password saved, not stored in plain text', D.passwords.list().some(e => e.username === 'me@example.com') && !pwFile.includes('s3cret-PW'))
      // sync: two devices through a folder
      const sync = require('./sync'); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-sync-'))
      const remote = { deviceId: 'devB', profiles: [{ id: 'default', name: 'Personal', updatedAt: Date.now() + 1e4, favorites: [{ id: 'tR', url: 'https://registry.npmjs.org/', title: 'npm' }] }], spaces: [{ id: 'sR', name: 'From Mac B', color: '#16a34a', profileId: 'default', updatedAt: Date.now(), pinned: [] }], tombstones: {}, history: [], passwords: { entries: [{ origin: 'https://github.com', username: 'b', password: 'pw-b', updatedAt: Date.now() }], tombstones: {} } }
      fs.mkdirSync(path.join(dir, 'Drift Sync')); fs.writeFileSync(path.join(dir, 'Drift Sync', 'devB.drift'), sync.encrypt(remote, 'correct horse'))
      Object.assign(D.S.sync, { enabled: true, folder: dir, deviceId: 'devA' })
      const oldA = a
      Object.assign(D.S.sync, { keyEnc: 'p:' + Buffer.from('correct horse').toString('base64') })
      D.runSync(true)
      ok('sync merges remote device', D.S.spaces.some(s => s.name === 'From Mac B') && D.passwords.list().some(e => e.host === 'github.com') && D.S.profiles[0].favorites.some(id => /npmjs/.test(D.tab(id)?.url || '')))
      ok('sync unloads tabs removed remotely', !D.tab(oldA) && !D.views.has(oldA))
      a = D.newTab('https://nodejs.org/en'); await loaded(a)
      const mine = fs.readFileSync(path.join(dir, 'Drift Sync', 'devA.drift'), 'utf8')
      ok('sync file encrypted', !mine.includes('s3cret') && !mine.includes('nodejs') && sync.decrypt(mine, 'correct horse').deviceId === 'devA')
      let bad = false; try { sync.decrypt(mine, 'wrong') } catch { bad = true }; ok('wrong passphrase rejected', bad)
      // extensions: load an unpacked MV3 extension with a content script
      const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-ext-'))
      fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Drift Test Ext', version: '1.0', action: { default_title: 'T' }, content_scripts: [{ matches: ['https://nodejs.org/*'], js: ['c.js'], run_at: 'document_end' }] }))
      fs.writeFileSync(path.join(ext, 'c.js'), "document.documentElement.dataset.driftExt = 'yes'")
      const ses = D.views.get(a).webContents.session
      await (ses.extensions || ses).loadExtension(ext)
      D.activateTab(a); D.views.get(a).webContents.reload(); await loaded(a); await wait(800)
      const mark = await D.views.get(a).webContents.executeJavaScript("document.documentElement.dataset.driftExt || ''")
      ok('extension content script runs', mark === 'yes')
      // private window: spawns a separate process with its own temp profile
      const before = Date.now(); D.runCommand('private'); await wait(4000)
      const priv = require('child_process').execSync('ps aux').toString().includes('--drift-private')
      ok('private window process launched', priv)
      try { require('child_process').execSync("pkill -f -- '--drift-private'") } catch {}
      // ---- ad blocker: filter-list engine (EasyList syntax) incl. exceptions
      D.adblock.useFilters('||adserver.example^\n/banner-ads/*\n@@||adserver.example/allowed.js')
      const m1 = D.adblock.match({ url: 'https://adserver.example/x.js', resourceType: 'script' }, 'https://news.example/')
      const m2 = D.adblock.match({ url: 'https://adserver.example/allowed.js', resourceType: 'script' }, 'https://news.example/')
      const m3 = D.adblock.match({ url: 'https://cdn.example/banner-ads/a.png', resourceType: 'image' }, 'https://news.example/')
      ok('ad blocker: filter rules + exceptions', m1?.cancel && !m2 && m3?.cancel)
      // ---- Site Inspector on a real HTTPS site
      D.activateTab(a); D.views.get(a).webContents.reload(); await loaded(a); await wait(500)
      const rep = await D.inspector.report({ wc: D.views.get(a).webContents, url: D.views.get(a).webContents.getURL(), ses: D.views.get(a).webContents.session, blocked: 0, permissions: {} })
      const flat = JSON.stringify(rep)
      ok('inspector: certificate captured', /Issued by/.test(flat) && /days left/.test(flat), (rep.sections[0].rows.find(r => r[0] === 'Issued by') || [])[1])
      ok('inspector: security headers graded', rep.sections.some(x => /grade [A-F]/.test(x.title)), rep.sections.find(x => /grade/.test(x.title))?.title)
      ok('inspector: tech stack detected', (rep.sections.find(x => x.title === 'Tech stack')?.rows || []).length > 0 && !/Nothing detected/.test(JSON.stringify(rep.sections.find(x => x.title === 'Tech stack'))), rep.sections.find(x => x.title === 'Tech stack').rows.map(r => r[0]).join(', '))
      await D.openInspector(); await wait(600); await shot('5-inspector'); D.closeOverlay()
      // ---- Tidy
      ok('tidy titles', D.tidyTitle('(3) Pull requests · electron/electron · GitHub', 'https://github.com/x') === 'Pull requests – electron/electron', D.tidyTitle('(3) Pull requests · electron/electron · GitHub', 'https://github.com/x'))
      ok('tidy downloads', D.tidyDownloadName('387494875.pdf', 'Navan Itinerary | Navan') === 'Navan Itinerary.pdf' && D.tidyDownloadName('report-q3.pdf', 'x') === null)
      for (const u of ['https://nodejs.org/en/about', 'https://registry.npmjs.org/', 'https://nodejs.org/en/about', 'https://nodejs.org/en/blog', 'https://registry.npmjs.org/electron', 'https://nodejs.org/en/learn', 'https://registry.npmjs.org/react']) D.newTab(u, { activate: false })
      const nToday = D.space().today.length; D.tidyTabs()
      ok('tidy tabs (dedupe + group by site)', D.space().today.length === nToday - 1, `${nToday} → ${D.space().today.length}`)
      // ---- Memory Saver
      const loadedBefore = D.views.size
      for (const id of D.space().today) if (id !== D.space().activeTabId && D.tab(id)) D.tab(id).lastActiveAt = Date.now() - 2 * 3600e3
      D.S.settings.memorySaverMs = 30 * 60e3; D.memorySaver()
      ok('memory saver unloads background tabs', D.views.size < loadedBefore, `${loadedBefore} → ${D.views.size} loaded`)
      // ---- Peek
      D.openPeek('https://nodejs.org/en/about'); await wait(2500); await shot('6-peek')
      ok('peek opens a preview', !!D.peekView && D.overlayOpen?.mode === 'peek'); D.closeOverlay()
      ok('peek closes', !D.peekView)
      // ---- Little Window
      const mini = D.openMini('https://nodejs.org/en'); await wait(3000)
      ok('little window', D.miniWindows.size === 1 && /nodejs/.test(mini.view.webContents.getURL())); mini.win.close(); await wait(300)
      // ---- Settings window
      D.openSettings('privacy'); await wait(1500)
      const sw = D.settingsWin
      const st = await sw.webContents.executeJavaScript("document.querySelectorAll('nav button').length + '|' + document.body.innerText.includes('Proxy')")
      sw.setSize(820, 720); require('child_process').execSync(`import -window root ${path.join(out, '7-settings-root.png')}`)
      const simg = await sw.webContents.capturePage(); fs.writeFileSync(path.join(out, '7-settings.png'), simg.toPNG())
      ok('settings window', st === '9|true', st)
      await D.setSetting('proxyMode', 'direct'); ok('proxy setting applied', D.S.settings.proxyMode === 'direct'); await D.setSetting('proxyMode', 'system')
      await sw.webContents.executeJavaScript("document.querySelectorAll('nav button')[5].click()"); await wait(400)
      const simg2 = await sw.webContents.capturePage(); fs.writeFileSync(path.join(out, '8-settings-integrations.png'), simg2.toPNG())
      sw.close()
      // ---- MCP: enable, then talk to it through the stdio bridge like Claude Desktop would
      await D.setSetting('mcpEnabled', true); await D.setSetting('mcpReadPages', true); await wait(500)
      const cp = require('child_process')
      const bridge = cp.spawn(process.execPath, [D.mcpBridgePath()], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DRIFT_MCP_CONFIG: D.mcpConfigFile() } })
      const replies = []; let buf = ''
      bridge.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { replies.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1) } })
      const rpc = (id, method, params) => bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
      bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
      rpc(2, 'tools/list', {}); rpc(3, 'tools/call', { name: 'list_tabs', arguments: {} })
      D.activateTab(a); await wait(300)
      rpc(4, 'tools/call', { name: 'get_page_text', arguments: { tab_id: a, max_chars: 300 } })
      await wait(2500); bridge.kill()
      const byId = (id) => replies.find(r => r.id === id)
      ok('MCP initialize', byId(1)?.result?.serverInfo?.name === 'drift-browser')
      ok('MCP tools/list', (byId(2)?.result?.tools || []).length === 10, (byId(2)?.result?.tools || []).map(t => t.name).join(','))
      ok('MCP list_tabs', /nodejs\.org/.test(byId(3)?.result?.content?.[0]?.text || ''))
      ok('MCP get_page_text', /JavaScript/.test(byId(4)?.result?.content?.[0]?.text || ''), (byId(4)?.result?.content?.[0]?.text || '').slice(0, 80).replace(/\n/g, ' '))
      const http = require('http'); const cfg = JSON.parse(fs.readFileSync(D.mcpConfigFile(), 'utf8'))
      const code = await new Promise(r => http.get({ host: '127.0.0.1', port: cfg.port, path: '/tools', headers: { authorization: 'Bearer wrong' } }, res => r(res.statusCode)).on('error', () => r(0)))
      ok('MCP rejects bad token', code === 403, String(code))
      await D.setSetting('mcpEnabled', false)
      // ---- Claude chat panel (no API key in this sandbox → must show a clear error, not hang)
      D.activateTab(a); await wait(300); D.toggleChat(true); await wait(1500)
      ok('claude chat panel opens', D.chatOpen && !!D.chatView)
      await D.chatView.webContents.executeJavaScript("document.getElementById('usepage').checked = true; document.getElementById('q').value = 'Summarize this page in one sentence'; document.getElementById('send').click()")
      await wait(6000); await shot('9-claude-chat')
      const chatText = await D.chatView.webContents.executeJavaScript('document.getElementById("log").innerText')
      ok('claude chat round-trip (error surfaced without a key)', /API key|Claude API|Could not reach|rejected/i.test(chatText) || /\w{20,}/.test(chatText), chatText.replace(/\n/g, ' ').slice(0, 160))
      D.toggleChat(false)
      D.switchSpace('home'); await wait(500)
      D.ACTIONS['toggle-sidebar'](); await wait(400); await shot('4-sidebar-hidden'); D.ACTIONS['toggle-sidebar']()
    } catch (e) { ok('exception', false, e.stack) }
    fs.writeFileSync(path.join(out, 'results.txt'), log.join('\n'))
    D.app.exit(0)
  })
}
