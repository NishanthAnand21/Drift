'use strict'
// Tests for src/main/arcimport.js: plain Node, no dependencies. Run: node scripts/test-arcimport.js
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const arc = require('../src/main/arcimport')

let checks = 0
function eq (actual, expected, label) { assert.deepStrictEqual(actual, expected, label); checks++ }
function ok (cond, label) { assert.ok(cond, label); checks++ }
function rejects (promise, re, label) {
  return promise.then(() => assert.fail(`${label}: expected a rejection`), (e) => { assert.match(e.message, re, label); checks++ })
}

// ---------------------------------------------------------------- fixture helpers
const T0 = 767836800 // 2025-05-02T00:00:00Z as seconds since 2001-01-01 (Apple NSDate)
const MS0 = 1746144000000 // the same instant in Unix ms
const MACHINE = '9F1C2B3D-0000-4000-8000-00000000AAAA'
const DEVICE = '7E6D5C4B-0000-4000-8000-00000000BBBB'

function mkIds (seed, names) {
  const out = {}
  names.split(' ').forEach((n, i) => { out[n] = `${seed}${String(i).padStart(4, '0')}-5E7A-4B1C-9D2E-0123456789AB` })
  return out
}
const entry = (id, o) => [id, { id, parentID: null, childrenIds: [], title: null, isUnread: false, createdAt: T0 - 86400, originatingDevice: DEVICE, ...o }]
const tabE = (id, parent, url, savedTitle, t, title = null) => entry(id, {
  parentID: parent,
  title,
  data: { tab: { savedURL: url, savedTitle, savedMuteStatus: 'allowed', timeLastActiveAt: t, activeTabBeforeCreationID: null } }
})
const listE = (id, parent, title, kids) => entry(id, { parentID: parent, title, childrenIds: kids, data: { list: {} } })
const bareFolderE = (id, parent, title, kids) => entry(id, { parentID: parent, title, childrenIds: kids }) // no data.list
const containerE = (id, kids, type) => entry(id, { childrenIds: kids, data: { itemContainer: { containerType: type } } })
const spaceE = (id, title, o) => [id, { id, title, profile: { default: true }, containerIDs: [], newContainerIDs: [], customInfo: {}, ...o }]
const spaceItems = (spaceId) => ({ spaceItems: { _0: spaceId } })
const customProfile = (dir) => ({ custom: { _0: { directoryBasename: dir, machineID: MACHINE } } })

const tabN = (title, url, lastActiveAt) => ({ title, url, lastActiveAt })
const folderN = (id, name, open, items) => ({ folder: true, id, name, open, items })

// ---------------------------------------------------------------- fixture A: Swift-style alternating arrays
const A = mkIds('AA00', 'work home workPinned workToday homePinned homeToday gmail docs spec specs rfc1 rfc2 file js hn example bad ' +
  'bank photos reading art1 art2 taDefault taP4 taP9 fav1 favJs fav2 favNotion favOld xSpace xPinned xToday xTab')

const fixtureA = {
  version: 1,
  sidebar: {
    containers: [
      { global: {} },
      {
        spaces: [
          spaceE(A.work, 'Work', {
            profile: customProfile('Profile 4'),
            containerIDs: ['pinned', A.workPinned, 'unpinned', A.workToday],
            newContainerIDs: [{ pinned: {} }, A.workPinned, { unpinned: { _0: { shared: {} } } }, A.workToday],
            customInfo: {
              iconType: { emoji_v2: '\u{1F4BC}', emoji: 128188 },
              windowTheme: {
                primaryColorPalette: {
                  midTone: { red: 0.2, green: 0.4, blue: 0.8, alpha: 1, colorSpace: 'extendedSRGB' },
                  shaded: { red: 0.1, green: 0.2, blue: 0.4, alpha: 1, colorSpace: 'extendedSRGB' }
                },
                semanticColorPalette: { appearanceBased: { light: { background: { red: 1, green: 1, blue: 1, alpha: 1 } } } }
              }
            }
          }),
          spaceE(A.home, 'Home', {
            profile: { default: true },
            containerIDs: ['unpinned', A.homeToday, 'pinned', A.homePinned], // opposite order on purpose
            customInfo: {
              iconType: { emoji: 127968 }, // numeric code point only
              windowTheme: { primaryColorPalette: { midTone: { red: 255, green: 128, blue: 0, alpha: 1, colorSpace: 'sRGB' } } }
            }
          })
        ].flat(),
        topAppsContainerIDs: [{ default: true }, A.taDefault, { custom: { _0: { machineID: MACHINE, directoryBasename: 'Profile 4' } } }, A.taP4],
        items: [
          containerE(A.workPinned, [A.gmail, A.docs, A.js], spaceItems(A.work)),
          tabE(A.gmail, A.workPinned, 'https://mail.google.com/mail/u/0/#inbox', 'Inbox (3) - Gmail', T0, 'My Inbox'), // renamed
          listE(A.docs, A.workPinned, 'Docs', [A.spec, A.specs, A.file]),
          tabE(A.spec, A.docs, 'https://docs.example.com/spec', 'Design spec', T0 + 60),
          bareFolderE(A.specs, A.docs, 'Specs', [A.rfc1, A.docs, A.rfc2]), // folder without data.list; A.docs is a cycle
          tabE(A.rfc1, A.specs, 'https://www.rfc-editor.org/rfc/rfc9110', 'RFC 9110: HTTP Semantics', T0 + 120),
          tabE(A.rfc2, A.specs, 'https://www.rfc-editor.org/rfc/rfc9111', 'RFC 9111: HTTP Caching', T0 + 180),
          tabE(A.file, A.docs, 'file:///Users/me/Documents/secret.txt', 'secret', T0),
          tabE(A.js, A.workPinned, 'javascript:alert(1)', 'xss', T0),

          containerE(A.workToday, [A.hn, A.example, A.hn, 'NO-SUCH-ITEM', A.bad], spaceItems(A.work)),
          tabE(A.hn, A.workToday, 'https://news.ycombinator.com/', 'Hacker News', T0 + 3600),
          tabE(A.example, A.workToday, 'https://example.org/path?q=1', null, T0 + 7200), // no title at all
          tabE(A.bad, A.workToday, 'not a url', 'broken', T0),

          containerE(A.homePinned, [A.bank, A.photos], spaceItems(A.home)),
          tabE(A.bank, A.homePinned, 'https://bank.example.com/', 'Bank', T0 + 10),
          tabE(A.photos, A.homePinned, 'https://photos.example.com/library', 'Photos', undefined), // never active
          containerE(A.homeToday, [A.reading], spaceItems(A.home)),
          listE(A.reading, A.homeToday, 'Reading list', [A.art1, A.art2]),
          tabE(A.art1, A.reading, 'https://blog.example.net/post-1', 'Post 1', T0 + 300),
          tabE(A.art2, A.reading, 'http://old.example.net/post-2', 'Post 2', T0 + 360),

          containerE(A.taDefault, [A.fav1, A.favJs, A.fav2], { topApps: { _0: { default: true } } }),
          tabE(A.fav1, A.taDefault, 'https://calendar.google.com/', 'Google Calendar', T0 + 5),
          tabE(A.favJs, A.taDefault, 'javascript:void(0)', 'nope', T0),
          tabE(A.fav2, A.taDefault, 'https://github.com/', 'GitHub', T0 + 6),
          containerE(A.taP4, [A.favNotion], { topApps: { _0: { custom: { _0: { machineID: MACHINE, directoryBasename: 'Profile 4' } } } } }),
          tabE(A.favNotion, A.taP4, 'https://www.notion.so/', 'Notion', T0 + 7),
          // a favourites set no Space uses and topAppsContainerIDs does not list: found by container type
          containerE(A.taP9, [A.favOld], { topApps: { _0: { custom: { _0: { machineID: MACHINE, directoryBasename: 'Profile 9' } } } } }),
          tabE(A.favOld, A.taP9, 'https://old.example.com/', 'Old', T0 + 8)
        ].flat()
      },
      { littleBrowser: {} },
      { // Little Arc container: same shape, one untitled Space. Must not be picked.
        spaces: [spaceE(A.xSpace, null, { containerIDs: ['pinned', A.xPinned, 'unpinned', A.xToday] })].flat(),
        topAppsContainerIDs: [],
        items: [
          containerE(A.xPinned, [], spaceItems(A.xSpace)),
          containerE(A.xToday, [A.xTab], spaceItems(A.xSpace)),
          tabE(A.xTab, A.xToday, 'https://little.example.com/', 'Little Arc', T0)
        ].flat()
      }
    ]
  },
  sidebarSyncState: { serverChangeToken: 'AAAA', encodedCKRecordFields: 'BBBB' },
  firebaseSyncState: { syncData: { items: [], spaceModels: [], orderedSpaceIDs: [A.work, A.home] }, unacknowledgedItemDeletions: [], syncHealthStatus: 'healthy' }
}

const windowsA = {
  windows: [{
    id: 'WINDOW-1',
    sidebarWidth: 248.5,
    sidebarMode: 'anchored',
    stayOnTop: false,
    focusedSpaceID: A.home,
    expandedItems: [A.docs, 'SOME-OTHER-ID', 42],
    spacesWithCollapsedPinnedSection: [],
    itemLastActiveDates: [A.gmail, T0],
    contents: { windowContents: [], splitViewState: { windowContentIDs: [], focusedContentID: null }, windowContentSidebarItemMap: { keysToValues: [] } },
    style: { standard: { sidebarContext: { global: {} } } }
  }]
}

const gmailN = tabN('My Inbox', 'https://mail.google.com/mail/u/0/#inbox', MS0)
const specN = tabN('Design spec', 'https://docs.example.com/spec', MS0 + 60000)
const rfc1N = tabN('RFC 9110: HTTP Semantics', 'https://www.rfc-editor.org/rfc/rfc9110', MS0 + 120000)
const rfc2N = tabN('RFC 9111: HTTP Caching', 'https://www.rfc-editor.org/rfc/rfc9111', MS0 + 180000)
const hnN = tabN('Hacker News', 'https://news.ycombinator.com/', MS0 + 3600000)
const exampleN = tabN('example.org', 'https://example.org/path?q=1', MS0 + 7200000)
const bankN = tabN('Bank', 'https://bank.example.com/', MS0 + 10000)
const photosN = tabN('Photos', 'https://photos.example.com/library', 0)
const art1N = tabN('Post 1', 'https://blog.example.net/post-1', MS0 + 300000)
const art2N = tabN('Post 2', 'http://old.example.net/post-2', MS0 + 360000)

function expectedA (windows) {
  const open = (id) => !windows || id === A.docs
  return {
    spaces: [
      {
        name: 'Work',
        color: '#3366cc',
        icon: '\u{1F4BC}',
        profile: 'Profile 4',
        focused: false,
        pinned: [
          gmailN,
          folderN(A.docs, 'Docs', open(A.docs), [specN, folderN(A.specs, 'Specs', open(A.specs), [rfc1N, rfc2N])])
        ],
        today: [hnN, exampleN]
      },
      {
        name: 'Home',
        color: '#ff8000',
        icon: '\u{1F3E0}',
        profile: 'Default',
        focused: !!windows,
        pinned: [bankN, photosN],
        today: [folderN(A.reading, 'Reading list', open(A.reading), [art1N, art2N])]
      }
    ],
    favorites: {
      Default: [tabN('Google Calendar', 'https://calendar.google.com/', MS0 + 5000), tabN('GitHub', 'https://github.com/', MS0 + 6000)],
      'Profile 4': [tabN('Notion', 'https://www.notion.so/', MS0 + 7000)],
      'Profile 9': [tabN('Old', 'https://old.example.com/', MS0 + 8000)]
    }
  }
}

// ---------------------------------------------------------------- fixture B: plain object maps
const B = mkIds('BB00', 'work reading workPinned workToday readPinned readToday decoyP decoyU decoyTab ' +
  'tab1 dev tools deep deeper tooDeep beyond tDev tTools tDeep tDeeper tTooDeep tBeyond up loop inLoop weird ' +
  'rEssay rVb rLong rCtl rAbout rChrome rNull rHttp rData rFrac ' +
  'taDefault taFolder taP7 taP8 fb1 fb2 fb3')
const LONG = 'A'.repeat(400)

const fixtureB = {
  version: 1,
  sidebar: {
    containers: [
      { global: {} },
      {
        spaces: {
          [B.reading]: {
            id: B.reading,
            title: 'Reading',
            profile: customProfile('Profile 2'),
            containerIDs: ['pinned', B.readPinned, 'unpinned', B.readToday],
            // decoy: containerIDs must win over newContainerIDs
            newContainerIDs: [{ pinned: {} }, B.decoyP, { unpinned: {} }, B.decoyU],
            customInfo: { iconType: { emoji_v2: '', emoji: '128214' }, windowTheme: {} }
          },
          [B.work]: {
            id: B.work,
            title: 'Work',
            profile: { default: true },
            // no containerIDs: only the newer form
            newContainerIDs: [{ unpinned: { _0: { shared: {} } } }, B.workToday, { pinned: {} }, B.workPinned],
            customInfo: {
              iconType: { symbol: 'briefcase' },
              windowTheme: { primaryColorPalette: { midTone: { red: 1, green: 0, blue: 200, alpha: 1 } } } // 0-255 although two components are <= 1
            }
          }
        },
        items: Object.fromEntries([
          containerE(B.workPinned, [B.tab1, B.dev, B.up], spaceItems(B.work)),
          tabE(B.tab1, B.workPinned, 'https://github.com/org/repo', 'repo', T0 + 1000, 'Renamed repo'),
          // five folder levels plus a sixth: levels 5 and 6 are flattened into level 4
          listE(B.dev, B.workPinned, 'Dev', [B.tDev, B.tools]),
          tabE(B.tDev, B.dev, 'https://dev.example.com/1', 'Dev 1', T0 + 1),
          listE(B.tools, B.dev, 'Tools', [B.tTools, B.deep]),
          tabE(B.tTools, B.tools, 'https://dev.example.com/2', 'Dev 2', T0 + 2),
          listE(B.deep, B.tools, 'Deep', [B.tDeep, B.deeper]),
          tabE(B.tDeep, B.deep, 'https://dev.example.com/3', 'Dev 3', T0 + 3),
          listE(B.deeper, B.deep, 'Deeper', [B.tDeeper, B.tooDeep]),
          tabE(B.tDeeper, B.deeper, 'https://dev.example.com/4', 'Dev 4', T0 + 4),
          listE(B.tooDeep, B.deeper, 'TooDeep', [B.tTooDeep, B.beyond]),
          tabE(B.tTooDeep, B.tooDeep, 'https://dev.example.com/5', 'Dev 5', T0 + 5),
          listE(B.beyond, B.tooDeep, 'Beyond', [B.tBeyond]),
          tabE(B.tBeyond, B.beyond, 'https://dev.example.com/6', 'Dev 6', T0 + 6),
          // a folder pointing back at its own section container and at an already placed tab
          listE(B.up, B.workPinned, 'Up', [B.workPinned, B.tab1]),

          containerE(B.workToday, [B.loop, B.weird], spaceItems(B.work)),
          listE(B.loop, B.workToday, 'Loop', [B.loop, B.inLoop]), // folder containing itself
          tabE(B.inLoop, B.loop, 'https://loop.example.com/', 'In loop', T0 + 7),
          tabE(B.weird, B.workToday, 'HTTPS://Example.COM:443/A b', '', null), // URL gets normalised; null time -> 0

          containerE(B.readPinned, [B.rEssay, B.rVb], spaceItems(B.reading)),
          tabE(B.rEssay, B.readPinned, 'https://longform.example.com/essay', 'An essay', T0 + 0.5),
          tabE(B.rVb, B.readPinned, 'vbscript:msgbox(1)', 'bad', T0),
          containerE(B.readToday, [B.rLong, B.rCtl, B.rAbout, B.rChrome, B.rNull, B.rHttp, B.rData, B.rFrac], spaceItems(B.reading)),
          tabE(B.rLong, B.readToday, 'https://long.example.com/', LONG, T0),
          tabE(B.rCtl, B.readToday, 'https://ctl.example.com/', 'Line1\nLine2\u0000\u0007 end', 'not a number'),
          tabE(B.rAbout, B.readToday, 'about:blank', 'blank', T0),
          tabE(B.rChrome, B.readToday, 'chrome://settings', 'settings', T0),
          tabE(B.rNull, B.readToday, null, 'no url', T0),
          tabE(B.rHttp, B.readToday, 'http://', 'empty host', T0),
          tabE(B.rData, B.readToday, 'data:text/html,<script>alert(1)</script>', 'data', T0),
          tabE(B.rFrac, B.readToday, 'https://frac.example.com/', 'Fractional', T0 + 0.25),

          // decoys (newContainerIDs of Reading): must stay unreferenced
          containerE(B.decoyP, [B.decoyTab], spaceItems(B.reading)),
          containerE(B.decoyU, [], spaceItems(B.reading)),
          tabE(B.decoyTab, B.decoyP, 'https://decoy.example.com/', 'Decoy', T0),

          // no topAppsContainerIDs at all: favourites are found by container type
          containerE(B.taDefault, [B.fb1, B.taFolder], { topApps: { _0: { default: true } } }),
          tabE(B.fb1, B.taDefault, 'https://fav1.example.com/', 'Fav 1', T0 + 11),
          listE(B.taFolder, B.taDefault, 'Fav folder', [B.fb2]), // folders are flattened in favourites
          tabE(B.fb2, B.taFolder, 'https://fav2.example.com/', 'Fav 2', T0 + 12),
          containerE(B.taP7, [B.fb3], { topApps: { custom: { machineID: MACHINE, directoryBasename: 'Profile 7' } } }), // shorthand without _0
          tabE(B.fb3, B.taP7, 'https://fav3.example.com/', 'Fav 3', T0 + 13),
          containerE(B.taP8, [], { topApps: { _0: { custom: { _0: { directoryBasename: 'Profile 8' } } } } }) // empty set: omitted
        ])
      }
    ]
  },
  // Swift dictionary order is arbitrary; this is the order the sidebar shows
  firebaseSyncState: { syncData: { orderedSpaceIDs: [B.work, B.reading] } }
}

const windowsB = { windows: [{ focusedSpaceID: B.reading, expandedItems: [B.dev, B.deeper], sidebarWidth: 300 }] }

function expectedB (windows) {
  const open = (id) => !windows || [B.dev, B.deeper].includes(id)
  return {
    spaces: [
      {
        name: 'Work',
        color: '#0100c8',
        icon: '',
        profile: 'Default',
        focused: false,
        pinned: [
          tabN('Renamed repo', 'https://github.com/org/repo', MS0 + 1000000),
          folderN(B.dev, 'Dev', open(B.dev), [
            tabN('Dev 1', 'https://dev.example.com/1', MS0 + 1000),
            folderN(B.tools, 'Tools', open(B.tools), [
              tabN('Dev 2', 'https://dev.example.com/2', MS0 + 2000),
              folderN(B.deep, 'Deep', open(B.deep), [
                tabN('Dev 3', 'https://dev.example.com/3', MS0 + 3000),
                folderN(B.deeper, 'Deeper', open(B.deeper), [
                  tabN('Dev 4', 'https://dev.example.com/4', MS0 + 4000),
                  tabN('Dev 5', 'https://dev.example.com/5', MS0 + 5000),
                  tabN('Dev 6', 'https://dev.example.com/6', MS0 + 6000)
                ])
              ])
            ])
          ]),
          folderN(B.up, 'Up', open(B.up), [])
        ],
        today: [
          folderN(B.loop, 'Loop', open(B.loop), [tabN('In loop', 'https://loop.example.com/', MS0 + 7000)]),
          tabN('example.com', 'https://example.com/A%20b', 0)
        ]
      },
      {
        name: 'Reading',
        color: null,
        icon: '\u{1F4D6}',
        profile: 'Profile 2',
        focused: !!windows,
        pinned: [tabN('An essay', 'https://longform.example.com/essay', MS0 + 500)],
        today: [
          tabN('A'.repeat(300), 'https://long.example.com/', MS0),
          tabN('Line1 Line2 end', 'https://ctl.example.com/', 0),
          tabN('Fractional', 'https://frac.example.com/', MS0 + 250)
        ]
      }
    ],
    favorites: {
      Default: [tabN('Fav 1', 'https://fav1.example.com/', MS0 + 11000), tabN('Fav 2', 'https://fav2.example.com/', MS0 + 12000)],
      'Profile 7': [tabN('Fav 3', 'https://fav3.example.com/', MS0 + 13000)]
    }
  }
}

// ---------------------------------------------------------------- stress / odd-shape helpers
const sid = (prefix, n) => `${prefix}-${String(n).padStart(6, '0')}`
const wrap = (spaces, items, extra = {}) => ({ sidebar: { containers: [{ global: {} }, { spaces: spaces.flat(), items: items.flat(), ...extra }] } })
const flatTabs = (nodes) => nodes.flatMap(n => n.folder ? flatTabs(n.items) : [n])
const depthOf = (nodes) => Math.max(0, ...nodes.map(n => n.folder ? 1 + depthOf(n.items) : 0))

function manySpaces (n) {
  const spaces = []
  const items = []
  for (let i = 1; i <= n; i++) {
    spaces.push(spaceE(sid('sp', i), `S${i}`, { containerIDs: ['pinned', sid('pin', i), 'unpinned', sid('tod', i)] }))
    items.push(containerE(sid('pin', i), [sid('tab', i)], spaceItems(sid('sp', i))), containerE(sid('tod', i), [], spaceItems(sid('sp', i))),
      tabE(sid('tab', i), sid('pin', i), `https://s${i}.example.com/`, `Tab ${i}`, T0))
  }
  return wrap(spaces, items)
}

function manyTabs (nPinned, nToday, nFav) {
  const items = [
    containerE('pin', Array.from({ length: nPinned }, (_, i) => sid('p', i)), spaceItems('sp')),
    containerE('tod', Array.from({ length: nToday }, (_, i) => sid('t', i)), spaceItems('sp')),
    containerE('fav', Array.from({ length: nFav }, (_, i) => sid('f', i)), { topApps: { _0: { default: true } } })
  ]
  for (let i = 0; i < nPinned; i++) items.push(tabE(sid('p', i), 'pin', `https://p${i}.example.com/`, `P${i}`, T0))
  for (let i = 0; i < nToday; i++) items.push(tabE(sid('t', i), 'tod', `https://t${i}.example.com/`, `T${i}`, T0))
  for (let i = 0; i < nFav; i++) items.push(tabE(sid('f', i), 'fav', `https://f${i}.example.com/`, `F${i}`, T0))
  return wrap([spaceE('sp', 'Big', { containerIDs: ['pinned', 'pin', 'unpinned', 'tod'] })], items, { topAppsContainerIDs: [{ default: true }, 'fav'] })
}

function folderChain (n) {
  const items = [containerE('pin', [sid('f', 0)], spaceItems('sp')), containerE('tod', [], spaceItems('sp'))]
  for (let i = 0; i < n; i++) {
    items.push(listE(sid('f', i), i ? sid('f', i - 1) : 'pin', `F${i}`, i + 1 < n ? [sid('t', i), sid('f', i + 1)] : [sid('t', i)]))
    items.push(tabE(sid('t', i), sid('f', i), `https://t${i}.example.com/`, `T${i}`, T0))
  }
  return wrap([spaceE('sp', 'Chain', { containerIDs: ['pinned', 'pin', 'unpinned', 'tod'] })], items)
}

// ---------------------------------------------------------------- tests
async function main () {
  // fixture sanity: the constants used above are what they claim to be
  eq(new Date(MS0).toISOString(), '2025-05-02T00:00:00.000Z', 'MS0 is T0 in Unix ms')
  eq(Date.UTC(2001, 0, 1) / 1000 + T0, MS0 / 1000, 'T0 is seconds since 2001-01-01')

  // arcSidebarPath
  eq(arc.arcSidebarPath('/Users/me'), path.join('/Users/me', 'Library', 'Application Support', 'Arc', 'StorableSidebar.json'), 'arcSidebarPath(home)')
  eq(arc.arcSidebarPath(), path.join(os.homedir(), 'Library', 'Application Support', 'Arc', 'StorableSidebar.json'), 'arcSidebarPath() defaults to the home dir')

  // parseArcWindows
  const win = arc.parseArcWindows(windowsA)
  eq(win, { expanded: new Set([A.docs, 'SOME-OTHER-ID']), focusedSpaceId: A.home, sidebarWidth: 248.5 }, 'parseArcWindows reads windows[0]')
  for (const bad of [undefined, null, 5, 'x', [], {}, { windows: [] }, { windows: [null] }, { windows: 'x' }]) {
    eq(arc.parseArcWindows(bad), { expanded: new Set(), focusedSpaceId: null, sidebarWidth: null }, `parseArcWindows(${JSON.stringify(bad)}) is empty`)
  }
  eq(arc.parseArcWindows({ windows: [{ expandedItems: 'x', focusedSpaceID: 7, sidebarWidth: -3 }] }), { expanded: new Set(), focusedSpaceId: null, sidebarWidth: null }, 'parseArcWindows ignores bad fields')

  // fixture A: Swift-style alternating arrays
  eq(arc.parseArcSidebar(fixtureA), expectedA(null), 'fixture A without windows: all folders open, nothing focused')
  eq(arc.parseArcSidebar(fixtureA, win), expectedA(win), 'fixture A with windows: expanded folders and focused space')
  eq(arc.parseArcSidebar(fixtureA, windowsA), expectedA(win), 'raw StorableWindows.json is accepted too')
  eq(arc.parseArcSidebar(fixtureA, { expanded: [A.docs], focusedSpaceId: A.home }), expectedA(win), 'expanded as an array is accepted')
  const reversed = structuredClone(fixtureA)
  reversed.sidebar.containers.reverse()
  eq(arc.parseArcSidebar(reversed), expectedA(null), 'the container with the most titled Spaces wins, whatever its position')
  const asMaps = structuredClone(fixtureA)
  for (const c of asMaps.sidebar.containers) {
    for (const key of ['spaces', 'items']) {
      if (!Array.isArray(c[key])) continue
      const o = {}
      for (let i = 0; i < c[key].length; i += 2) o[c[key][i]] = c[key][i + 1]
      c[key] = o
    }
  }
  eq(arc.parseArcSidebar(asMaps), expectedA(null), 'plain-map encoding of fixture A parses identically')
  const untouched = JSON.stringify(fixtureA)
  arc.parseArcSidebar(fixtureA, win)
  eq(JSON.stringify(fixtureA), untouched, 'parseArcSidebar does not modify its input')

  // fixture B: plain maps, newContainerIDs, depth limit, cycles, odd URLs and titles
  eq(arc.parseArcSidebar(fixtureB), expectedB(null), 'fixture B without windows')
  eq(arc.parseArcSidebar(fixtureB, arc.parseArcWindows(windowsB)), expectedB(true), 'fixture B with windows')
  const bResult = arc.parseArcSidebar(fixtureB)
  eq(depthOf(bResult.spaces[0].pinned), 4, 'folders nest at most 4 levels')
  ok(!JSON.stringify(bResult).includes('decoy'), 'containerIDs wins over newContainerIDs')
  ok(!/javascript|file:|vbscript|chrome:|about:|data:/.test(JSON.stringify(bResult)), 'only http(s) URLs survive')
  ok(flatTabs(bResult.spaces[1].today).every(t => t.title.length <= 300), 'titles are at most 300 characters')

  // odd shapes never throw
  const empty = { spaces: [], favorites: {} }
  const oddInputs = [
    undefined, null, 0, 42, 'x', true, [], {}, { sidebar: null }, { sidebar: 'x' }, { sidebar: {} }, { sidebar: { containers: 'x' } },
    { sidebar: { containers: [null, 5, 'a', [], { global: {} }, { littleBrowser: {} }] } },
    { sidebar: { containers: [{ spaces: 5, items: 'x' }] } },
    { sidebar: { containers: [{ spaces: [1, 2, 3], items: [null, undefined, 'a'] }] } }
  ]
  for (const bad of oddInputs) {
    let out
    assert.doesNotThrow(() => { out = arc.parseArcSidebar(bad) }, `parseArcSidebar(${JSON.stringify(bad)}) must not throw`)
    eq(out, empty, `parseArcSidebar(${JSON.stringify(bad)}) is empty`)
  }
  eq(arc.parseArcSidebar(fixtureA, 'garbage'), expectedA(null), 'junk windows argument is ignored')
  eq(arc.parseArcSidebar(wrap([['S', { id: 'S', title: 42, containerIDs: 'pinned', newContainerIDs: {}, customInfo: 'x', profile: 7 }]].flat(), ['T', 5, 'U', null])),
    { spaces: [{ name: 'Space 1', color: null, icon: '', profile: 'Default', focused: false, pinned: [], today: [] }], favorites: {} },
    'a Space with unreadable fields still imports (empty) under a fallback name')
  eq(arc.parseArcSidebar(wrap(
    [spaceE('S', 'Odd', { containerIDs: ['pinned', 'P', 'unpinned', 'U'], customInfo: { iconType: { emoji: -4, emoji_v2: 'x'.repeat(40) }, windowTheme: { primaryColorPalette: { midTone: { red: 'a', green: 1, blue: 1 } } } } })],
    [containerE('P', [null, 5, {}, 'T', 'MISSING', 'T'], spaceItems('S')), containerE('U', 'not an array', spaceItems('S')),
      entry('T', { data: { tab: { savedURL: 'https://ok.example.com/', savedTitle: ['no'], timeLastActiveAt: 'soon' } } })])).spaces,
  [{ name: 'Odd', color: null, icon: '', profile: 'Default', focused: false, pinned: [tabN('ok.example.com', 'https://ok.example.com/', 0)], today: [] }],
  'odd children, titles, colour, icon and time fields are skipped, not fatal')

  // a profile named __proto__ cannot touch prototypes, and an item id of __proto__ is just an id
  const protoJson = JSON.parse(`{"sidebar":{"containers":[{
    "spaces":{"S":{"id":"S","title":"P","profile":{"custom":{"_0":{"directoryBasename":"__proto__"}}},"containerIDs":["pinned","__proto__"]}},
    "items":{
      "__proto__":{"id":"__proto__","childrenIds":["T"],"data":{"itemContainer":{"containerType":{"spaceItems":{"_0":"S"}}}}},
      "T":{"id":"T","title":null,"childrenIds":[],"data":{"tab":{"savedURL":"https://p.example.com/","savedTitle":"P"}}},
      "F":{"id":"F","childrenIds":["T2"],"data":{"itemContainer":{"containerType":{"topApps":{"_0":{"custom":{"_0":{"directoryBasename":"__proto__"}}}}}}}},
      "T2":{"id":"T2","title":null,"childrenIds":[],"data":{"tab":{"savedURL":"https://q.example.com/","savedTitle":"Q"}}}
    }}]}}`)
  const protoOut = arc.parseArcSidebar(protoJson)
  eq(protoOut.spaces.map(s => [s.name, s.profile, s.pinned.length]), [['P', '__proto__', 1]], 'an item id of __proto__ resolves like any other id')
  eq(Object.getPrototypeOf(protoOut.favorites), Object.prototype, 'favorites keeps Object.prototype')
  eq(Object.keys(protoOut.favorites), ['__proto__'], 'a profile called __proto__ becomes an ordinary own key')
  eq(Object.getOwnPropertyDescriptor(protoOut.favorites, '__proto__').value, [tabN('Q', 'https://q.example.com/', 0)], 'the own __proto__ key holds its tabs')
  eq(Object.keys(arc.planImport(protoOut, null).favorites), ['__proto__'], 'planImport keeps a __proto__ key as an own key too')
  eq([({}).title, ({}).length, Object.prototype.title], [undefined, undefined, undefined], 'Object.prototype is not polluted')

  // caps
  const many = arc.parseArcSidebar(manySpaces(60))
  eq(many.spaces.length, 50, 'at most 50 spaces')
  eq(many.spaces.map(s => s.name), Array.from({ length: 50 }, (_, i) => `S${i + 1}`), 'the first 50 spaces are kept, in order')
  const big = arc.parseArcSidebar(manyTabs(3000, 2200, 0))
  eq([big.spaces[0].pinned.length, big.spaces[0].today.length], [3000, 2000], 'at most 5000 tabs')
  const bigFav = arc.parseArcSidebar(manyTabs(5200, 0, 10))
  eq([bigFav.favorites.Default.length, bigFav.spaces[0].pinned.length], [10, 4990], 'the 5000 tab cap counts favourites too')

  // very deep or long folder chains: no throw, nesting bounded
  let chain
  assert.doesNotThrow(() => { chain = arc.parseArcSidebar(folderChain(20000)) }, 'a 20000-deep folder chain must not throw')
  checks++
  eq(depthOf(chain.spaces[0].pinned), 4, 'deep chain: nesting is still at most 4')
  const chainTabs = flatTabs(chain.spaces[0].pinned).length
  ok(chainTabs >= 5 && chainTabs <= 70, `deep chain: recursion is cut off (kept ${chainTabs} tabs)`)

  // timestamps
  const ts = (v) => arc.parseArcSidebar(wrap([spaceE('S', 'T', { containerIDs: ['pinned', 'P'] })], [containerE('P', ['T1'], spaceItems('S')), entry('T1', { data: { tab: { savedURL: 'https://t.example.com/', savedTitle: 't', timeLastActiveAt: v } } })])).spaces[0].pinned[0].lastActiveAt
  eq([ts(0), ts(T0), ts(T0 + 0.5), ts(-1e12), ts(1e300), ts(Infinity), ts(NaN), ts('5'), ts(null), ts(undefined)], [978307200000, MS0, MS0 + 500, 0, 0, 0, 0, 0, 0, 0], 'timestamps: Apple seconds to Unix ms, junk to 0')

  // colours and icons
  const style = (customInfo) => arc.parseArcSidebar(wrap([spaceE('S', 'C', { customInfo })], [])).spaces[0]
  const rgb = (red, green, blue) => ({ windowTheme: { primaryColorPalette: { midTone: { red, green, blue } } } })
  eq([style(rgb(0, 0, 0)).color, style(rgb(1, 1, 1)).color, style(rgb(0.5, 0.25, 1)).color, style(rgb(255, 255, 255)).color, style(rgb(200, 1, 0)).color, style(rgb(300, 0, 0)).color],
    ['#000000', '#ffffff', '#8040ff', '#ffffff', '#c80100', '#ff0000'], 'colours: 0-1 or 0-255 per colour, clamped')
  eq([style(rgb(-1, 0, 0)).color, style(rgb(NaN, 0, 0)).color, style(rgb('1', 0, 0)).color, style({}).color, style({ windowTheme: { primaryColorPalette: { midTone: { red: 1, green: 1 } } } }).color], [null, null, null, null, null], 'colours: unreadable gives null')
  eq([style({ iconType: { emoji_v2: '\u{1F680}' } }).icon, style({ iconType: { emoji: 128640 } }).icon, style({ iconType: { emoji: '128640' } }).icon, style({ iconType: { emoji_v2: '  ' + '\u{1F680}' + ' ', emoji: 1 } }).icon, style({ iconType: { emoji: 0x110000 } }).icon, style({ iconType: { emoji: 0xd800 } }).icon, style({ iconType: { emoji: 1.5 } }).icon, style({ iconType: { emoji: 65 } }).icon, style({}).icon],
    ['\u{1F680}', '\u{1F680}', '\u{1F680}', '\u{1F680}', '', '', '', '', ''], 'icons: emoji_v2 string or numeric code point')

  // profiles
  const prof = (profile) => arc.parseArcSidebar(wrap([spaceE('S', 'P', { profile })], [])).spaces[0].profile
  eq([prof({ default: true }), prof(customProfile('Profile 12')), prof({ custom: {} }), prof({ custom: { _0: { directoryBasename: '' } } }), prof(undefined), prof('x'), prof(null)],
    ['Default', 'Profile 12', 'Default', 'Default', 'Default', 'Default', 'Default'], 'profile: Default or the directoryBasename')

  // planImport
  const parsedA = arc.parseArcSidebar(fixtureA, win)
  const snapshot = JSON.stringify(parsedA)
  const withEmpty = structuredClone(parsedA)
  withEmpty.spaces.push({ name: 'Blank', color: null, icon: '', profile: 'Default', focused: false, pinned: [], today: [] })
  withEmpty.spaces.push({ name: 'OnlyEmptyFolder', color: null, icon: '', profile: 'Default', focused: false, pinned: [folderN('x', 'Nothing', true, [])], today: [] })
  withEmpty.favorites.Nothing = []
  const emptySnapshot = JSON.stringify(withEmpty)
  const plan = arc.planImport(withEmpty, { spaceNames: ['work', 'Home', 'Home (Arc)', 'Unrelated'] })
  eq(plan.spaces.map(s => s.name), ['Work (Arc)', 'Home (Arc 2)'], 'planImport: existing names get " (Arc)", then " (Arc 2)"; empty Spaces are dropped')
  eq(plan.stats, { spaces: 2, tabs: 10, folders: 3, favorites: 4 }, 'planImport stats')
  eq(plan.favorites, parsedA.favorites, 'planImport keeps favourite sets (empty ones are dropped)')
  eq(plan.spaces.map(s => s.focused), [false, true], 'planImport keeps the focused Space')
  eq(JSON.stringify(withEmpty), emptySnapshot, 'planImport does not modify its input')
  eq(JSON.stringify(parsedA), snapshot, 'parsed result is untouched by planning')
  ok(plan.spaces[0] !== withEmpty.spaces[0] && plan.spaces[0].pinned !== withEmpty.spaces[0].pinned, 'planImport returns copies')
  eq(arc.planImport(parsedA, { spaceNames: [] }).spaces.map(s => s.name), ['Work', 'Home'], 'planImport: no clash, no rename')
  eq(arc.planImport(parsedA, undefined).spaces.map(s => s.name), ['Work', 'Home'], 'planImport: missing existing')
  eq(arc.planImport(parsedA, { spaceNames: 'Work' }).spaces.map(s => s.name), ['Work', 'Home'], 'planImport: malformed existing')
  eq(arc.planImport(parsedA, { spaceNames: [null, 7, 'WORK'] }).spaces.map(s => s.name), ['Work (Arc)', 'Home'], 'planImport: names compare case-insensitively, junk entries ignored')
  const twins = arc.planImport({ spaces: [parsedA.spaces[0], parsedA.spaces[0], parsedA.spaces[0]], favorites: {} }, { spaceNames: [] })
  eq(twins.spaces.map(s => s.name), ['Work', 'Work (Arc)', 'Work (Arc 2)'], 'planImport: duplicate names inside the import are separated too')
  eq(twins.stats, { spaces: 3, tabs: 18, folders: 6, favorites: 0 }, 'planImport stats count every imported copy')
  const twoFocus = arc.planImport({ spaces: [{ ...parsedA.spaces[1], focused: true }, { ...parsedA.spaces[1], name: 'Home 2', focused: true }], favorites: {} }, null)
  eq(twoFocus.spaces.map(s => s.focused), [true, false], 'planImport keeps at most one focused Space')
  eq(arc.planImport(null, null), { spaces: [], favorites: {}, stats: { spaces: 0, tabs: 0, folders: 0, favorites: 0 } }, 'planImport(null, null)')
  eq(arc.planImport({ spaces: [null, 5, 'x', { name: 'N', pinned: 'x', today: [{ title: 't', url: 'https://t.example.com/', lastActiveAt: 1 }] }], favorites: { A: 'x', B: [] } }, {}),
    { spaces: [{ name: 'N', pinned: [], today: [{ title: 't', url: 'https://t.example.com/', lastActiveAt: 1 }], focused: false }], favorites: {}, stats: { spaces: 1, tabs: 1, folders: 0, favorites: 0 } },
    'planImport tolerates malformed input')
  const planB = arc.planImport(arc.parseArcSidebar(fixtureB), { spaceNames: ['Reading'] })
  eq(planB.spaces.map(s => s.name), ['Work', 'Reading (Arc)'], 'planImport on fixture B')
  eq(planB.stats, { spaces: 2, tabs: 13, folders: 6, favorites: 3 }, 'planImport stats on fixture B')
  eq(Object.keys(planB.favorites).sort(), ['Default', 'Profile 7'], 'planImport keeps unused-profile favourite sets')

  // readArcSidebar (real files in a temp dir)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-arcimport-'))
  try {
    const sidebarFile = path.join(dir, 'StorableSidebar.json')
    const windowsFile = path.join(dir, 'StorableWindows.json')
    eq(await arc.readArcSidebar(sidebarFile), null, 'readArcSidebar: missing file gives null')
    eq(await arc.readArcSidebar(path.join(dir, 'nope', 'StorableSidebar.json')), null, 'readArcSidebar: missing directory gives null')
    fs.writeFileSync(sidebarFile, JSON.stringify(fixtureA))
    eq(await arc.readArcSidebar(sidebarFile), expectedA(null), 'readArcSidebar without StorableWindows.json')
    fs.writeFileSync(windowsFile, JSON.stringify(windowsA))
    eq(await arc.readArcSidebar(sidebarFile), expectedA(win), 'readArcSidebar also reads StorableWindows.json')
    fs.writeFileSync(windowsFile, '{ not json')
    eq(await arc.readArcSidebar(sidebarFile), expectedA(null), 'readArcSidebar ignores an unreadable StorableWindows.json')
    fs.writeFileSync(windowsFile, JSON.stringify({ windows: [] }))
    eq(await arc.readArcSidebar(sidebarFile), expectedA(null), 'readArcSidebar ignores a StorableWindows.json without windows')
    fs.writeFileSync(sidebarFile, '﻿' + JSON.stringify(fixtureB))
    fs.rmSync(windowsFile)
    eq(await arc.readArcSidebar(sidebarFile), expectedB(null), 'readArcSidebar accepts a BOM')
    fs.writeFileSync(sidebarFile, '{ not json')
    await rejects(arc.readArcSidebar(sidebarFile), /not valid JSON/, 'readArcSidebar: invalid JSON')
    fs.writeFileSync(sidebarFile, 'null')
    eq(await arc.readArcSidebar(sidebarFile), { spaces: [], favorites: {} }, 'readArcSidebar: JSON null is an empty import, not a missing file')
    fs.truncateSync(sidebarFile, 50 * 1024 * 1024 + 1) // sparse file: over the limit, never read
    await rejects(arc.readArcSidebar(sidebarFile), /too large/, 'readArcSidebar: refuses files over 50 MB')
    fs.rmSync(sidebarFile)
    fs.mkdirSync(sidebarFile)
    await rejects(arc.readArcSidebar(sidebarFile), /not a regular file/, 'readArcSidebar: a directory is not a sidebar file')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

main().then(() => {
  console.log(`arcimport: ${checks} checks passed`)
  process.exit(0)
}, (e) => {
  console.error(`arcimport: FAILED after ${checks} passing checks`)
  console.error(e && e.stack ? e.stack : e)
  process.exit(1)
})
