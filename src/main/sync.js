'use strict'
// End-to-end encrypted sync through a shared folder (iCloud Drive, Dropbox, a NAS…).
// Each device writes only its own file: <folder>/Drift Sync/<deviceId>.drift
// and merges every other device's file. Contents are AES-256-GCM encrypted with a
// key derived (scrypt) from a passphrase that never leaves the device.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

function encrypt (obj, passphrase) {
  const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12)
  const key = crypto.scryptSync(passphrase, salt, 32, SCRYPT)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()])
  return JSON.stringify({ v: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') })
}
function decrypt (text, passphrase) {
  const f = JSON.parse(text)
  const key = crypto.scryptSync(passphrase, Buffer.from(f.salt, 'base64'), 32, SCRYPT)
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(f.iv, 'base64'))
  d.setAuthTag(Buffer.from(f.tag, 'base64'))
  return JSON.parse(Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]).toString('utf8'))
}

// Pure merge of browser structure. `local` is the live state (mutated), `remote` a device payload.
const flatPinned = (S, sp) => sp.pinned.flatMap(id => S.folders?.[id] ? S.folders[id].items : [id])
function mergeState (S, remote, newTabId) {
  let changed = false
  S.sync.tombstones = S.sync.tombstones || {}
  for (const [id, t] of Object.entries(remote.tombstones || {})) {
    S.sync.tombstones[id] = Math.max(S.sync.tombstones[id] || 0, t)
    const sp = S.spaces.find(s => s.id === id)
    if (sp && (sp.updatedAt || 0) <= t && S.spaces.length > 1) {
      for (const tid of [...flatPinned(S, sp), ...sp.today]) delete S.tabs[tid]
      S.spaces = S.spaces.filter(s => s !== sp); changed = true
      if (S.activeSpaceId === id) S.activeSpaceId = S.spaces[0].id
    }
  }
  const adoptTabs = (list, existingIds) => list.map(rt => {
    const local = existingIds.find(id => S.tabs[id] && (id === rt.id || S.tabs[id].pinnedUrl === rt.url))
    if (local) { if (S.tabs[local].title !== rt.title && !S.tabs[local].title) S.tabs[local].title = rt.title; return local }
    const id = S.tabs[rt.id] ? newTabId() : rt.id
    S.tabs[id] = { id, url: rt.url, pinnedUrl: rt.url, title: rt.title, favicon: rt.favicon || null, lastActiveAt: Date.now() }
    return id
  })
  for (const rp of remote.profiles || []) {
    let p = S.profiles.find(x => x.id === rp.id)
    if (!p) { p = { id: rp.id, name: rp.name, favorites: [], updatedAt: 0 }; S.profiles.push(p); changed = true }
    if ((rp.updatedAt || 0) > (p.updatedAt || 0)) {
      const keep = adoptTabs(rp.favorites, p.favorites)
      for (const id of p.favorites) if (!keep.includes(id)) delete S.tabs[id]
      p.favorites = keep; p.name = rp.name; p.updatedAt = rp.updatedAt; changed = true
    }
  }
  for (const rs of remote.spaces || []) {
    if ((S.sync.tombstones[rs.id] || 0) >= (rs.updatedAt || 0)) continue
    let sp = S.spaces.find(x => x.id === rs.id)
    if (!sp) {
      if (!S.profiles.some(p => p.id === rs.profileId)) continue
      sp = { id: rs.id, name: rs.name, color: rs.color, icon: '', profileId: rs.profileId, pinned: [], today: [], activeTabId: null, split: null, updatedAt: 0 }
      S.spaces.push(sp); changed = true
    }
    if ((rs.updatedAt || 0) > (sp.updatedAt || 0)) {
      const local = flatPinned(S, sp)
      const keep = adoptTabs(rs.pinned, local)
      for (const id of local) if (!keep.includes(id)) { delete S.tabs[id]; if (sp.activeTabId === id) sp.activeTabId = null }
      // folders are per-device: keep them, drop tabs removed elsewhere, put new tabs at the top level
      const folders = sp.pinned.filter(id => S.folders?.[id])
      const inFolders = new Set()
      for (const fid of folders) { S.folders[fid].items = S.folders[fid].items.filter(id => keep.includes(id)); S.folders[fid].items.forEach(id => inFolders.add(id)) }
      const pinned = [...folders, ...keep.filter(id => !inFolders.has(id))]
      Object.assign(sp, { name: rs.name, color: rs.color, pinned, updatedAt: rs.updatedAt })
      if (rs.theme) sp.theme = rs.theme // validated by sanitizeState() after every merge
      if (typeof rs.icon === 'string') sp.icon = rs.icon
      changed = true
    }
  }
  // history: union, newest first
  if (remote.history?.length) {
    const seen = new Set(S.history.map(h => h.url + '|' + h.t))
    let added = 0
    for (const h of remote.history) if (!seen.has(h.url + '|' + h.t)) { S.history.push(h); added++ }
    if (added) { S.history.sort((a, b) => b.t - a.t); S.history.length = Math.min(S.history.length, 3000) }
  }
  return changed
}

// Fingerprint of the synced structure so we know when to bump updatedAt
const tabSig = (S, ids) => ids.map(id => S.tabs[id]?.pinnedUrl || S.tabs[id]?.url).join('|')
function stampChanges (S) {
  S.sync.sigs = S.sync.sigs || {}
  const now = Date.now()
  for (const sp of S.spaces) {
    const sig = [sp.name, sp.color, sp.icon || '', JSON.stringify(sp.theme || null), sp.profileId, tabSig(S, flatPinned(S, sp))].join('#')
    if (S.sync.sigs[sp.id] !== sig) { S.sync.sigs[sp.id] = sig; sp.updatedAt = now }
  }
  for (const p of S.profiles) {
    const sig = [p.name, tabSig(S, p.favorites)].join('#')
    if (S.sync.sigs['p:' + p.id] !== sig) { S.sync.sigs['p:' + p.id] = sig; p.updatedAt = now }
  }
}

function buildPayload (S, passwords) {
  stampChanges(S)
  const tabs = (ids) => ids.map(id => S.tabs[id]).filter(Boolean).map(t => ({ id: t.id, url: t.pinnedUrl || t.url, title: t.title, favicon: /^https:/.test(t.favicon || '') ? t.favicon : null }))
  return {
    deviceId: S.sync.deviceId,
    writtenAt: Date.now(),
    profiles: S.profiles.map(p => ({ id: p.id, name: p.name, updatedAt: p.updatedAt || 0, favorites: tabs(p.favorites) })),
    spaces: S.spaces.map(s => ({ id: s.id, name: s.name, color: s.color, icon: s.icon || '', theme: s.theme, profileId: s.profileId, updatedAt: s.updatedAt || 0, pinned: tabs(flatPinned(S, s)) })),
    tombstones: S.sync.tombstones || {},
    history: S.history.slice(0, 1000),
    passwords: passwords.exportForSync()
  }
}

function syncNow ({ S, passphrase, passwords, newTabId }) {
  const dir = path.join(S.sync.folder, 'Drift Sync')
  fs.mkdirSync(dir, { recursive: true })
  let changed = false; let devices = 0; const errors = []
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.drift') || f === S.sync.deviceId + '.drift') continue
    try {
      const remote = decrypt(fs.readFileSync(path.join(dir, f), 'utf8'), passphrase)
      if (mergeState(S, remote, newTabId)) changed = true
      passwords.mergeFromSync(remote.passwords)
      devices++
    } catch (e) { errors.push(`${f}: ${/auth|unsupported state/i.test(e.message) ? 'wrong passphrase' : e.message}`) }
  }
  const out = path.join(dir, S.sync.deviceId + '.drift')
  fs.writeFileSync(out + '.tmp', encrypt(buildPayload(S, passwords), passphrase), { mode: 0o600 })
  fs.renameSync(out + '.tmp', out)
  S.sync.lastSyncAt = Date.now()
  return { changed, devices, errors }
}

module.exports = { syncNow, encrypt, decrypt, mergeState, buildPayload }
