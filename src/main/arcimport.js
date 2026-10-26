'use strict'
// Arc sidebar importer (macOS). Reads Arc's StorableSidebar.json (and, when present, StorableWindows.json)
// and turns it into plain data Drift can apply. format notes: NotArc docs/arc-data-format.md, MIT
//
// The files are untrusted input: nothing in them is ever executed, sizes are capped, only http(s) URLs
// survive, and the pure parsers never throw on odd shapes (they skip what they cannot read).
//
// API
//   arcSidebarPath(home?)          -> path of StorableSidebar.json
//   parseArcSidebar(json, win?)    -> { spaces: [{ name, color, icon, profile, focused, pinned, today }], favorites }   (pure)
//   parseArcWindows(json)          -> { expanded: Set<folderId>, focusedSpaceId, sidebarWidth }                        (pure)
//   planImport(parsed, existing)   -> parsed with unique space names, empty spaces dropped, plus stats                  (pure)
//   readArcSidebar(file?)          -> parseArcSidebar() of the file on disk (+ StorableWindows.json), or null if missing
//
//   Node   = Tab | Folder
//   Tab    = { title, url, lastActiveAt }                        lastActiveAt: Unix ms, 0 when unknown
//   Folder = { folder: true, id, name, open, items: Node[] }     id: Arc's id (informational, never reuse it as a Drift id)
//   favorites = { [profileName]: Tab[] }                         profileName: 'Default' or Arc's Chromium directoryBasename

const fs = require('fs')
const os = require('os')
const path = require('path')

const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_WINDOWS_BYTES = 10 * 1024 * 1024
const MAX_SPACES = 50
const MAX_TABS = 5000
const MAX_FOLDERS = 2000
const MAX_FOLDER_LEVELS = 4
const MAX_HOPS = 64 // hard recursion limit, also bounds chains of folders that are being flattened
const MAX_CHILDREN = 10000
const MAX_EXPANDED = 10000
const MAX_TITLE = 300
const MAX_NAME = 100
const MAX_URL = 8192
const MAX_EMOJI = 32
const APPLE_EPOCH_S = 978307200 // 2001-01-01T00:00:00Z in Unix seconds (Apple NSDate reference date)
const MAX_UNIX_MS = 253402300799000 // 9999-12-31
const DEFAULT_PROFILE = 'Default'

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)

function arcSidebarPath (home = os.homedir()) {
  return path.join(home, 'Library', 'Application Support', 'Arc', 'StorableSidebar.json')
}

// ---------------------------------------------------------------- small helpers

// Untrusted text -> single-line string of at most `max` UTF-16 units ('' when not a string).
function cleanText (v, max) {
  if (typeof v !== 'string') return ''
  const s = v.slice(0, 4096)
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    out += (c < 32 || (c >= 127 && c < 160) || c === 0x2028 || c === 0x2029) ? ' ' : s[i]
  }
  out = out.replace(/ {2,}/g, ' ').trim().slice(0, max)
  const last = out.charCodeAt(out.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1) // do not leave half a surrogate pair
  return out.trim()
}

function cleanUrl (v) {
  if (typeof v !== 'string' || v.length > MAX_URL) return null
  try {
    const u = new URL(v.trim())
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.href.length > MAX_URL) return null
    return u.href
  } catch {
    return null
  }
}

// Arc stores times as seconds since 2001-01-01 UTC. Returns Unix ms, or 0 when unknown/unusable.
function appleToUnixMs (s) {
  if (typeof s !== 'number' || !Number.isFinite(s)) return 0
  const ms = Math.round((s + APPLE_EPOCH_S) * 1000)
  return ms > 0 && ms <= MAX_UNIX_MS ? ms : 0
}

// Defines an own, enumerable property even for keys like '__proto__' (plain assignment would change the prototype).
function setOwn (obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true })
}

// Swift encodes a Dictionary as a flat [key, value, key, value, ...] array; a plain object map is accepted too.
// Returns Map<string, object>. The first entry wins when a key repeats.
function dictEntries (x) {
  const out = new Map()
  if (Array.isArray(x)) {
    for (let i = 0; i + 1 < x.length; i++) {
      if (typeof x[i] === 'string' && isObj(x[i + 1])) {
        if (!out.has(x[i])) out.set(x[i], x[i + 1])
        i++
      }
    }
  } else if (isObj(x)) {
    for (const k of Object.keys(x)) if (isObj(x[k])) out.set(k, x[k])
  }
  return out
}

function childIds (item) {
  return Array.isArray(item.childrenIds) ? item.childrenIds.slice(0, MAX_CHILDREN).filter(id => typeof id === 'string') : []
}

// ---------------------------------------------------------------- profiles, colours, icons

// Accepts a Space's `profile` ({ default: true } | { custom: { _0: { directoryBasename } } }) and a topApps
// payload ({ _0: <profile> }, or { custom: { directoryBasename } }). Anything unreadable is the Default profile.
function profileName (p) {
  if (!isObj(p)) return DEFAULT_PROFILE
  let o = p
  if (isObj(o._0) && !isObj(o.custom) && o.default === undefined) o = o._0
  if (isObj(o.custom)) {
    const c = isObj(o.custom._0) ? o.custom._0 : o.custom
    const name = cleanText(c.directoryBasename, MAX_NAME)
    if (name) return name
  }
  return DEFAULT_PROFILE
}

function readColor (space) {
  const ci = isObj(space.customInfo) ? space.customInfo : {}
  const wt = isObj(ci.windowTheme) ? ci.windowTheme : {}
  const pal = isObj(wt.primaryColorPalette) ? wt.primaryColorPalette : {}
  const mid = pal.midTone
  if (!isObj(mid)) return null
  const rgb = [mid.red, mid.green, mid.blue]
  if (!rgb.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) return null
  // Components are 0-1 floats, or 0-255 when any of them is above 1 (decided per colour, not per component).
  const scale = rgb.some(n => n > 1) ? 1 : 255
  return '#' + rgb.map(n => Math.min(255, Math.round(n * scale)).toString(16).padStart(2, '0')).join('')
}

function emojiFrom (v) {
  if (typeof v === 'string' && /^\d{1,7}$/.test(v.trim())) v = Number(v.trim())
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0xa0 || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) return ''
    return String.fromCodePoint(v)
  }
  if (typeof v !== 'string') return ''
  const s = v.trim()
  return s.length <= MAX_EMOJI ? cleanText(s, MAX_EMOJI) : '' // too long to be an emoji: ignore
}

function readIcon (space) {
  const ci = isObj(space.customInfo) ? space.customInfo : {}
  const it = isObj(ci.iconType) ? ci.iconType : {}
  return emojiFrom(it.emoji_v2) || emojiFrom(it.emoji)
}

// ---------------------------------------------------------------- tree walking

// A section root's alternating list: ['pinned', id, 'unpinned', id] in either order, or the newer
// [{ pinned: {} }, id, { unpinned: {...} }, id]. Fills `into` without overwriting (so containerIDs wins).
function sectionIds (arr, into) {
  if (!Array.isArray(arr)) return
  const keyOf = (k) => {
    if (k === 'pinned' || k === 'unpinned') return k
    if (isObj(k)) { if (has(k, 'pinned')) return 'pinned'; if (has(k, 'unpinned')) return 'unpinned' }
    return null
  }
  for (let i = 0; i + 1 < arr.length; i++) {
    const key = keyOf(arr[i])
    if (key && typeof arr[i + 1] === 'string') {
      if (!into[key]) into[key] = arr[i + 1]
      i++
    }
  }
}

function isFolder (item) {
  const d = isObj(item.data) ? item.data : {}
  if (isObj(d.tab)) return false
  if (isObj(d.list)) return true
  return Array.isArray(item.childrenIds) && item.childrenIds.some(id => typeof id === 'string')
}

function readTab (item, t) {
  const url = cleanUrl(t.savedURL)
  if (!url) return null
  const title = cleanText(item.title, MAX_TITLE) || cleanText(t.savedTitle, MAX_TITLE) || cleanText(new URL(url).host, MAX_TITLE)
  return { title, url, lastActiveAt: appleToUnixMs(t.timeLastActiveAt) }
}

// Resolves child ids into Nodes. `level` is the number of folders already enclosing these ids; folders past
// MAX_FOLDER_LEVELS (or past MAX_FOLDERS in total) are flattened into their parent. ctx.seen drops cycles/repeats.
function walkItems (ids, level, hops, ctx) {
  const out = []
  if (hops > MAX_HOPS) return out
  for (const id of ids) {
    if (ctx.tabs >= MAX_TABS) break
    if (ctx.seen.has(id)) continue
    ctx.seen.add(id)
    const item = ctx.items.get(id)
    if (!item) continue
    const d = isObj(item.data) ? item.data : {}
    if (isObj(d.tab)) {
      const tab = readTab(item, d.tab)
      if (tab) { out.push(tab); ctx.tabs++ }
    } else if (isFolder(item)) {
      const kids = childIds(item)
      if (level < MAX_FOLDER_LEVELS && ctx.folders < MAX_FOLDERS) {
        ctx.folders++
        const list = isObj(d.list) ? d.list : {}
        out.push({
          folder: true,
          id: id.slice(0, 100),
          name: cleanText(item.title, MAX_TITLE) || cleanText(list.title, MAX_TITLE) || 'Folder',
          open: ctx.expanded ? ctx.expanded.has(id) : true,
          items: walkItems(kids, level + 1, hops + 1, ctx)
        })
      } else {
        for (const n of walkItems(kids, level, hops + 1, ctx)) out.push(n)
      }
    }
  }
  return out
}

// The main sidebar container is the one whose `spaces` holds the most titled Spaces (extra containers
// for Little Arc / standalone windows have a single untitled Space).
function pickMainContainer (json) {
  const list = isObj(json) && isObj(json.sidebar) && Array.isArray(json.sidebar.containers) ? json.sidebar.containers : []
  let best = null
  for (const c of list.slice(0, 20)) {
    if (!isObj(c) || (c.spaces === undefined && c.items === undefined)) continue
    const spaces = dictEntries(c.spaces)
    let titled = 0
    for (const sp of spaces.values()) if (cleanText(sp.title, MAX_NAME)) titled++
    if (!best || titled > best.titled || (titled === best.titled && spaces.size > best.spaces.size)) best = { container: c, spaces, titled }
  }
  return best
}

// Best-effort UI order of Spaces (Swift dictionary order is arbitrary). Unlisted Spaces keep file order, after the listed ones.
function orderedSpaceIds (json) {
  const fb = isObj(json.firebaseSyncState) ? json.firebaseSyncState : {}
  const sd = isObj(fb.syncData) ? fb.syncData : {}
  return Array.isArray(sd.orderedSpaceIDs) ? sd.orderedSpaceIDs.filter(id => typeof id === 'string') : []
}

function readFavorites (container, ctx) {
  const byProfile = new Map()
  const keyed = new Map() // containerId -> profile named by the key in topAppsContainerIDs
  const ids = []
  const arr = Array.isArray(container.topAppsContainerIDs) ? container.topAppsContainerIDs : []
  for (let i = 0; i < arr.length; i++) {
    if (typeof arr[i] !== 'string') continue
    ids.push(arr[i])
    if (i > 0 && isObj(arr[i - 1])) keyed.set(arr[i], profileName(arr[i - 1]))
  }
  const listed = new Set(ids)
  // Favourite sets that no Space uses may be missing from topAppsContainerIDs; find them by container type.
  for (const [id, item] of ctx.items) {
    const ct = isObj(item.data) && isObj(item.data.itemContainer) ? item.data.itemContainer.containerType : null
    if (!listed.has(id) && isObj(ct) && isObj(ct.topApps)) ids.push(id)
  }
  for (const id of ids) {
    const item = ctx.items.get(id)
    if (!item || ctx.seen.has(id)) continue
    ctx.seen.add(id)
    const ct = isObj(item.data) && isObj(item.data.itemContainer) ? item.data.itemContainer.containerType : null
    const t = isObj(ct) && isObj(ct.topApps) ? ct.topApps : null
    const hasProfile = t && (isObj(t._0) || isObj(t.custom) || t.default !== undefined)
    const name = hasProfile ? profileName(t) : (keyed.get(id) || DEFAULT_PROFILE)
    // level = MAX flattens any folder inside favourites: favourites are a flat list of tabs
    const tabs = walkItems(childIds(item), MAX_FOLDER_LEVELS, 0, ctx)
    if (!tabs.length) continue
    if (!byProfile.has(name)) byProfile.set(name, [])
    for (const tab of tabs) byProfile.get(name).push(tab)
  }
  return byProfile
}

function readSpace (sp, n, ctx, focusedId, sid) {
  const roots = {}
  sectionIds(sp.containerIDs, roots)
  sectionIds(sp.newContainerIDs, roots)
  const section = (cid) => {
    if (!cid) return []
    ctx.seen.add(cid)
    const root = ctx.items.get(cid)
    return root ? walkItems(childIds(root), 0, 0, ctx) : []
  }
  return {
    name: cleanText(sp.title, MAX_NAME) || `Space ${n}`,
    color: readColor(sp),
    icon: readIcon(sp),
    profile: profileName(sp.profile),
    focused: focusedId !== null && focusedId === sid,
    pinned: section(roots.pinned),
    today: section(roots.unpinned)
  }
}

// ---------------------------------------------------------------- public: pure parsers

function parseArcWindows (json) {
  const out = { expanded: new Set(), focusedSpaceId: null, sidebarWidth: null }
  try {
    const w = isObj(json) && Array.isArray(json.windows) ? json.windows[0] : null
    if (!isObj(w)) return out
    if (Array.isArray(w.expandedItems)) {
      for (const id of w.expandedItems.slice(0, MAX_EXPANDED)) if (typeof id === 'string') out.expanded.add(id)
    }
    if (typeof w.focusedSpaceID === 'string') out.focusedSpaceId = w.focusedSpaceID
    if (typeof w.sidebarWidth === 'number' && Number.isFinite(w.sidebarWidth) && w.sidebarWidth > 0 && w.sidebarWidth < 10000) out.sidebarWidth = w.sidebarWidth
  } catch {}
  return out
}

// `windows` is optional: the result of parseArcWindows() (a raw StorableWindows.json object is accepted too).
// Without it every folder is open and no Space is focused.
function normalizeWindows (w) {
  if (!isObj(w)) return null
  if (Array.isArray(w.windows)) w = parseArcWindows(w)
  const expanded = w.expanded instanceof Set
    ? w.expanded
    : new Set(Array.isArray(w.expanded) ? w.expanded.filter(id => typeof id === 'string') : [])
  return { expanded, focusedSpaceId: typeof w.focusedSpaceId === 'string' ? w.focusedSpaceId : null }
}

function parseArcSidebar (json, windows) {
  const result = { spaces: [], favorites: {} }
  try {
    const main = pickMainContainer(json)
    if (!main) return result
    const win = normalizeWindows(windows)
    const ctx = {
      items: dictEntries(main.container.items),
      seen: new Set(),
      tabs: 0,
      folders: 0,
      expanded: win ? win.expanded : null
    }

    // Favourites first: they are few, and should survive the tab cap.
    for (const [name, tabs] of readFavorites(main.container, ctx)) setOwn(result.favorites, name, tabs)

    const rank = new Map(orderedSpaceIds(json).map((id, i) => [id, i]))
    const entries = [...main.spaces].sort((a, b) => (rank.has(a[0]) ? rank.get(a[0]) : 1e9) - (rank.has(b[0]) ? rank.get(b[0]) : 1e9))
    for (const [sid, sp] of entries) {
      if (result.spaces.length >= MAX_SPACES) break
      try {
        result.spaces.push(readSpace(sp, result.spaces.length + 1, ctx, win ? win.focusedSpaceId : null, sid))
      } catch {} // one broken Space must not lose the others
    }
  } catch {} // never throw on odd shapes: return what was read
  return result
}

// ---------------------------------------------------------------- public: planning

function countNodes (nodes) {
  let tabs = 0
  let folders = 0
  const stack = Array.isArray(nodes) ? [...nodes] : []
  while (stack.length) {
    const n = stack.pop()
    if (!isObj(n)) continue
    if (n.folder === true) {
      folders++
      if (Array.isArray(n.items)) for (const x of n.items) stack.push(x)
    } else {
      tabs++
    }
  }
  return { tabs, folders }
}

// "Work" -> "Work (Arc)" -> "Work (Arc 2)" ... against `taken` (lower-cased); the chosen name is added to `taken`.
function uniqueName (name, taken) {
  let out = name
  if (taken.has(out.toLowerCase())) {
    out = `${name} (Arc)`
    for (let n = 2; taken.has(out.toLowerCase()); n++) out = `${name} (Arc ${n})`
  }
  taken.add(out.toLowerCase())
  return out
}

// Pure: returns a new structure (parsed is not modified). existing = { spaceNames: string[] }.
function planImport (parsed, existing) {
  const src = isObj(parsed) ? parsed : {}
  const names = isObj(existing) && Array.isArray(existing.spaceNames) ? existing.spaceNames : []
  const taken = new Set(names.filter(n => typeof n === 'string').map(n => n.toLowerCase()))
  const stats = { spaces: 0, tabs: 0, folders: 0, favorites: 0 }
  const plan = { spaces: [], favorites: {}, stats }
  let focusUsed = false

  for (const sp of Array.isArray(src.spaces) ? src.spaces : []) {
    if (!isObj(sp)) continue
    const a = countNodes(sp.pinned)
    const b = countNodes(sp.today)
    if (a.tabs + b.tabs === 0) continue // empty Space: nothing to import
    const copy = structuredClone(sp)
    copy.name = uniqueName(typeof sp.name === 'string' && sp.name ? sp.name : 'Space', taken)
    copy.focused = sp.focused === true && !focusUsed
    focusUsed = focusUsed || copy.focused
    copy.pinned = Array.isArray(copy.pinned) ? copy.pinned : []
    copy.today = Array.isArray(copy.today) ? copy.today : []
    plan.spaces.push(copy)
    stats.tabs += a.tabs + b.tabs
    stats.folders += a.folders + b.folders
  }
  stats.spaces = plan.spaces.length

  const favs = isObj(src.favorites) ? src.favorites : {}
  for (const name of Object.keys(favs)) {
    if (!Array.isArray(favs[name]) || !favs[name].length) continue
    setOwn(plan.favorites, name, structuredClone(favs[name]))
    stats.favorites += favs[name].length
  }
  return plan
}

// ---------------------------------------------------------------- public: file access

// undefined when the file does not exist; throws for too-large or invalid files.
async function readJsonFile (file, maxBytes) {
  let st
  try {
    st = await fs.promises.stat(file)
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return undefined
    throw e
  }
  if (!st.isFile()) throw new Error(`${path.basename(file)} is not a regular file`)
  if (st.size > maxBytes) throw new Error(`${path.basename(file)} is too large (${st.size} bytes; limit ${maxBytes})`)
  let text = await fs.promises.readFile(file, 'utf8')
  if (text.length > maxBytes) throw new Error(`${path.basename(file)} is too large`)
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${path.basename(file)} is not valid JSON`)
  }
}

async function readArcSidebar (file = arcSidebarPath()) {
  const json = await readJsonFile(file, MAX_FILE_BYTES)
  if (json === undefined) return null
  let windows = null
  try {
    const wj = await readJsonFile(path.join(path.dirname(file), 'StorableWindows.json'), MAX_WINDOWS_BYTES)
    if (isObj(wj) && Array.isArray(wj.windows) && wj.windows.length) windows = parseArcWindows(wj)
  } catch {} // optional file: ignore anything wrong with it
  return parseArcSidebar(json, windows)
}

module.exports = { arcSidebarPath, parseArcSidebar, parseArcWindows, planImport, readArcSidebar }
