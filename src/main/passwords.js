'use strict'
// Password manager: entries are encrypted at rest with the OS keychain (safeStorage),
// only ever handed to a frame whose origin matches the saved entry, and only after
// a trusted user gesture in the page (checked in the web preload).
const { safeStorage, ipcMain, dialog, clipboard, systemPreferences } = require('electron')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

function createPasswords ({ file, getWin, isPrivate, isTab, toast }) {
  let db = { entries: [], never: [], tombstones: {} }
  try { db = { ...db, ...JSON.parse(fs.readFileSync(file, 'utf8')) } } catch {}
  let timer = null
  const save = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file + '.tmp', JSON.stringify(db), { mode: 0o600 })
      fs.renameSync(file + '.tmp', file)
    }, 200)
  }
  const canEncrypt = () => safeStorage.isEncryptionAvailable()
  const enc = (s) => (canEncrypt() ? 'k:' + safeStorage.encryptString(s).toString('base64') : 'p:' + Buffer.from(s).toString('base64'))
  const dec = (s) => (s.startsWith('k:') ? safeStorage.decryptString(Buffer.from(s.slice(2), 'base64')) : Buffer.from(s.slice(2), 'base64').toString())
  const norm = (o) => { try { return new URL(o).origin } catch { return null } }
  const host = (o) => { try { return new URL(o).host } catch { return o } }

  function upsert (origin, username, password, { updatedAt = Date.now(), silent = false } = {}) {
    origin = norm(origin); if (!origin || !password) return
    const e = db.entries.find(x => x.origin === origin && x.username === username)
    if (e) { if (updatedAt < e.updatedAt) return; e.password = enc(password); e.updatedAt = updatedAt } else db.entries.push({ id: crypto.randomUUID(), origin, username, password: enc(password), createdAt: updatedAt, updatedAt })
    delete db.tombstones[origin + '\n' + username]
    save(); if (!silent) toast?.(`Password saved for ${host(origin)}`)
  }
  function remove (id) {
    const e = db.entries.find(x => x.id === id); if (!e) return
    db.tombstones[e.origin + '\n' + e.username] = Date.now()
    db.entries = db.entries.filter(x => x !== e); save()
  }
  const forOrigin = (origin) => db.entries.filter(e => e.origin === origin)

  // Biometric / system confirmation before revealing secrets in the manager
  async function authenticate (reason) {
    if (process.platform === 'darwin' && systemPreferences.canPromptTouchID?.()) {
      try { await systemPreferences.promptTouchID(reason); return true } catch { return false }
    }
    const { response } = await dialog.showMessageBox(getWin(), { type: 'warning', buttons: ['Continue', 'Cancel'], defaultId: 1, cancelId: 1, message: reason })
    return response === 0
  }

  // ---- IPC from web pages (via src/preload/web.js) -----------------------------
  const frameOrigin = (e) => {
    if (!isTab(e.sender)) return null
    const o = e.senderFrame?.origin
    if (!o || !(o.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o))) return null
    return o
  }
  ipcMain.handle('pw:query', (e) => {
    const o = frameOrigin(e); if (!o) return { entries: [], enabled: false }
    return { enabled: !isPrivate, entries: forOrigin(o).map(x => ({ id: x.id, username: x.username })) }
  })
  ipcMain.handle('pw:fill', (e, id) => {
    const o = frameOrigin(e); if (!o) return null
    const x = db.entries.find(y => y.id === id && y.origin === o)
    if (!x) return null
    try { return { username: x.username, password: dec(x.password) } } catch { return null }
  })
  const asked = new Set()
  ipcMain.on('pw:submitted', async (e, username, password) => {
    const o = frameOrigin(e)
    if (!o || isPrivate || typeof password !== 'string' || !password || password.length > 512 || typeof username !== 'string' || username.length > 256) return
    if (db.never.includes(o)) return
    const existing = db.entries.find(x => x.origin === o && x.username === username)
    if (existing) { try { if (dec(existing.password) === password) return } catch {} }
    const key = o + username + password; if (asked.has(key)) return; asked.add(key)
    const { response } = await dialog.showMessageBox(getWin(), {
      type: 'question',
      buttons: [existing ? 'Update Password' : 'Save Password', 'Not Now', 'Never for This Site'],
      defaultId: 0, cancelId: 1,
      message: `${existing ? 'Update' : 'Save'} password for ${host(o)}?`,
      detail: username ? `Username: ${username}` : 'No username detected'
    })
    if (response === 0) upsert(o, username, password)
    if (response === 2) { db.never.push(o); save() }
  })

  // ---- manager actions -------------------------------------------------------------
  // Wipe the clipboard after a delay — but only if it still holds the password (you may have copied something else)
  function clearClipboardLater (secret, ms = 30e3) {
    setTimeout(async () => { try { if ((await clipboard.readText()) === secret) clipboard.clear() } catch {} }, ms)
  }
  function list () { return db.entries.map(e => ({ id: e.id, origin: e.origin, host: host(e.origin), username: e.username, updatedAt: e.updatedAt })).sort((a, b) => a.host.localeCompare(b.host)) }
  async function copySecret (id) {
    const e = db.entries.find(x => x.id === id); if (!e) return
    if (!(await authenticate(`reveal the password for ${host(e.origin)}`))) return
    const pw = dec(e.password)
    await clipboard.writeText(pw); toast?.('Password copied — clipboard clears in 30 s')
    clearClipboardLater(pw)
  }
  function parseCsv (text) {
    const rows = []; let row = []; let f = ''; let q = false
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (q) { if (c === '"' && text[i + 1] === '"') { f += '"'; i++ } else if (c === '"') q = false; else f += c } else if (c === '"') q = true
      else if (c === ',') { row.push(f); f = '' } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = '' } else f += c
    }
    if (f || row.length) { row.push(f); rows.push(row) }
    return rows.filter(r => r.some(Boolean))
  }
  // Chrome / Arc / 1Password style CSV: name,url,username,password[,note]
  function importCsv (csvPath) {
    const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'))
    const head = rows.shift().map(h => h.trim().toLowerCase())
    const iu = head.findIndex(h => h === 'url' || h === 'website' || h === 'login_uri'); const iuser = head.findIndex(h => h === 'username' || h === 'login_username'); const ipw = head.findIndex(h => h === 'password' || h === 'login_password')
    if (iu < 0 || ipw < 0) throw new Error('CSV needs url and password columns')
    let n = 0
    for (const r of rows) { if (norm(r[iu]) && r[ipw]) { upsert(r[iu], iuser >= 0 ? r[iuser] : '', r[ipw], { silent: true }); n++ } }
    return n
  }
  async function exportCsv (target) {
    if (!(await authenticate('export your saved passwords'))) return false
    const esc = (s) => '"' + String(s).replace(/"/g, '""') + '"'
    const lines = ['name,url,username,password', ...db.entries.map(e => [host(e.origin), e.origin, e.username, dec(e.password)].map(esc).join(','))]
    fs.writeFileSync(target, lines.join('\n'), { mode: 0o600 })
    return true
  }

  // ---- sync ------------------------------------------------------------------------
  function exportForSync () {
    return { entries: db.entries.map(e => ({ origin: e.origin, username: e.username, password: dec(e.password), updatedAt: e.updatedAt })), tombstones: db.tombstones }
  }
  function mergeFromSync (remote) {
    if (!remote) return
    for (const [k, t] of Object.entries(remote.tombstones || {})) {
      const [o, u] = k.split('\n'); const e = db.entries.find(x => x.origin === o && x.username === u)
      if (e && e.updatedAt <= t) db.entries = db.entries.filter(x => x !== e)
      db.tombstones[k] = Math.max(db.tombstones[k] || 0, t)
    }
    for (const r of remote.entries || []) {
      const tomb = db.tombstones[r.origin + '\n' + r.username]
      if (tomb && tomb >= r.updatedAt) continue
      const e = db.entries.find(x => x.origin === r.origin && x.username === r.username)
      if (!e || e.updatedAt < r.updatedAt) upsert(r.origin, r.username, r.password, { updatedAt: r.updatedAt, silent: true })
    }
    save()
  }

  return { list, remove, copySecret, clearClipboardLater, importCsv, exportCsv, exportForSync, mergeFromSync, authenticate, upsert, canEncrypt, get count () { return db.entries.length } }
}

module.exports = { createPasswords }
