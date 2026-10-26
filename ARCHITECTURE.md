# Drift architecture

Drift is an Arc-style browser built on Chromium through Electron 45. This document describes how its processes are laid out, where the trust boundaries are, and which rules (invariants) every change must keep.

## 1. Process model

| Process | Code | Runs | Trust |
|---|---|---|---|
| **Browser (main)** | `src/main/*.js` | app lifecycle, windows, tabs, sessions, IPC, storage, network filtering, updates | trusted |
| **Drift UI renderers** | `src/ui/*` via `drift-ui://app/…` | sidebar, floating sidebar, command bar, popovers, previews, toasts, settings, Claude panel chrome | trusted code, but treats every string it displays as untrusted data |
| **Web renderers** | any site | one sandboxed renderer per tab, Peek and Little Window | **untrusted** |
| **Internal pages** | `src/web/error.html`, visuals | error, warning and visual pages loaded into tabs as `data:` URLs | untrusted context with no privileges |
| **Private window** | same code with `--drift-private` | a separate app instance; in-memory partitions only | as above |

### Views in a window (bottom → top)

Each window is a `BrowserWindow` whose own webContents is the docked sidebar UI. Every other surface is a `WebContentsView` stacked above it in one fixed order, which `restack()` in `main.js` enforces:

1. tab pages (a tab that is popping its video out stays attached underneath the new tab until the pop-out finishes)
2. Claude panel (`chatView` or `claudeBar`/`claudeWeb`)
3. floating sidebar (an 8 px edge strip while the sidebar is hidden; full width while it peeks)
4. toast view (shown only while the sidebar is hidden)
5. favourite hover preview
6. popovers (+ menu, site controls)
7. overlay (command bar, find, prompts)
8. Peek
9. drag shield (only while dragging a split divider or the sidebar edge)

Views are attached or moved only when the order is wrong, because re-adding a view moves it, flickers the page and can drop focus.

### Sessions

| Session | Used by |
|---|---|
| `persist:profile-<id>` | tabs of each profile, with that profile's extensions |
| `private-<id>` | tabs in a private window |
| default session | Drift UI only; it is the only session where `drift-ui://` is registered |
| its own partition | claude.ai in the Claude panel |

## 2. State and data flow

- **Persistent state:** `S`, kept by `store.js` and saved as debounced JSON. It holds spaces, profiles, tabs (including each tab's back/forward list, `t.nav`), folders, settings, history, archive, permissions and downloads.
- **Runtime state:** `live` (tab id → loading, back/forward availability, blocked count, playing, muted), `views` (tab id → view) and `wcToTab`.
- **Main → UI:**
  - `pushState()` sends one `state` snapshot to the docked sidebar and to the floating sidebar. The sidebar redraws with keys: an unchanged entry keeps its element, so clicks aren't lost and favicons don't blink.
  - `layout()` places the views, then sends `layout` (pane rectangles) to the docked sidebar for the split-view rings, dividers and pane toolbars.
- **UI → main:** `drift.send(action, …args)` over `ipcMain.on('ui')`. The action must be in the `ACTIONS` table and the sender must be one of Drift's UI webContents (`isOurUI`).

## 3. Security invariants

Every change must keep these. Each one names where it is enforced.

1. **Only Drift UI can drive the browser.** Every `ui` IPC is dropped unless `isOurUI(e)` is true and the action is an own property of `ACTIONS` (`ipcMain.on('ui')`). Web pages can't reach `ui`.
2. **Web pages get no Node and no bridge.**
   - Tabs run with `sandbox`, `contextIsolation`, no `nodeIntegration`, `webSecurity` on, and no insecure content.
   - The page preload (`src/preload/web.js`) runs in an isolated world and sends only `pw:*`, `peek-link` and `web-nav`.
   - Main re-checks every one of those:
     - `pw:*`: the sender must be a tab, and the frame origin must be https (or localhost) and match the saved entry.
     - `web-nav`: the sender must be a tab, Peek or a Little Window.
     - `peek-link`: the URL must pass `isSafeWebUrl`.
   - Only trusted input counts: `isTrusted` events.
3. **No XSS in the UI layer.** UI pages show page-controlled strings (titles, URLs, favicons, download names, Gmail snippets) with `textContent` only.
   - `innerHTML` is used only for constant SVG icon markup.
   - Favicons are `<img>` limited to `https:` or `data:image`.
   - Every UI page has a CSP of `default-src 'none'; script-src 'self'; base-uri 'none'; form-action 'none'`. Styles are self-hosted, plus `'unsafe-inline'` in the sidebar only.
4. **`drift-ui://` is private.**
   - The scheme is registered on the default session only, so tab sessions can't load it.
   - `serveUI()` serves only files inside `src/ui`, with a MIME allowlist and `nosniff`.
   - UI views refuse `will-navigate` and deny `window.open`.
5. **Navigation is guarded** (`guardNavigation`).
   - Blocked schemes: `javascript:`, `file:`, `chrome:`, `devtools:`, `smb:`, `afp:`, `nfs:`, `cifs:`, `vnc:`, `ssh:` and `x-apple.systempreferences:`.
   - Tabs load only `http(s)` URLs (`isSafeWebUrl`).
   - Pages flagged dangerous are cancelled before the request goes out, and a warning is shown instead.
6. **Internal pages have no privileges.**
   - Error, warning and visual pages are `data:` URLs with a strict CSP, and the error page's script is pinned by a sha256 hash.
   - Their parameters travel in the `#fragment`, so they never reach the network.
   - Visuals that Claude generates are stripped of `<script>`, `on*` attributes and meta refresh, then given a CSP that allows no scripts.
7. **Back/forward history holds web pages only.** `saveNav()` keeps only `http(s)` entries (at most 50) and nothing in private mode. `tidyHistory()` swaps a failed address for its error page instead of keeping both. Clearing browsing data clears these lists.
8. **Secrets are protected.**
   - Passwords are encrypted with the Keychain (`safeStorage`). They are revealed only after Touch ID or a confirmation, and a copied password is cleared from the clipboard after 30 s.
   - Sync files are encrypted with AES-256-GCM, using a key derived from the passphrase with scrypt.
   - The MCP endpoint listens on localhost only and requires a bearer token.
9. **The binary is hardened** with Electron fuses:
   - `RunAsNode` off, `NODE_OPTIONS` off and `--inspect` off
   - cookie encryption on, asar integrity on, and load from asar only
   - no extra `file://` privileges

   Release CI verifies these fuses and the code signature.
10. **Pages can't draw over Drift's prompts.** The command bar, popovers, prompts and Peek always sit above the page views (see `restack()`), so a page can't cover or fake them.
11. **Permissions are per site.** They default to Ask, and are granted only to secure origins.

## 4. Lifecycle and memory

- **Creating a tab view:** `ensureView(tabId)` creates the view and wires its events. If the tab has a saved back/forward list whose current entry matches `t.url`, it restores that list; otherwise it loads `t.url`.
- **Unloading a tab:** `destroyView(tabId)` detaches the view, deletes it from `views` and `wcToTab`, unregisters it from extensions and closes its webContents. Memory Saver calls this for background tabs; it never unloads a tab that is playing, popped out, in a split or on screen.
- **Bounded caches:**
  - favourite snapshots: at most 24 (LRU)
  - downloads list: at most 60 kept
  - history: at most 3,000 entries
  - per-tab back/forward list: at most 50 entries
- **Short-lived holds:**
  - `pipLinger` is emptied in a `finally`, so it can't leak.
  - The UI's `WeakMap` of row signatures doesn't keep removed rows alive.
- **Lightweight singletons:** the overlay, popover, preview, toast and floating-sidebar views are each created once per window, and the window's `closed` handler drops all references to them.

## 5. Milestones for the current batch (builder)

Main-process support for all of these is already in `main.js`: per-pane state, pane actions, the 36 px pane strip, and `step-space`.

| # | Milestone | Done when |
|---|---|---|
| M1 | **Split-pane toolbars.** Every split pane gets a 36 px bar: ← → ⟳, a centred URL, site controls and a split menu (on the active pane or on hover), and × to remove the tab from the split. The sidebar button appears on the first pane while the sidebar is hidden. | Each pane's page starts 36 px below its rectangle. The buttons are updated in place (not rebuilt on every state push), so clicks during a page load aren't lost. |
| M2 | **Combined split row.** Split tabs in the same list appear in the sidebar as one row with a half per tab. | Clicking a half focuses that pane. Drag and drop indexes count every tab in the group. |
| M3 | **Swipe between spaces.** A two-finger swipe across the sidebar moves to the next or previous space, with the content following your fingers. | One switch per gesture; it springs back if released early; no wrap-around at either end. |
| M4 | **End-to-end checks.** Selftest checks for M1–M3 and for this batch's main-process fixes: back/forward history surviving an unload, failed loads, retry on reload, two-finger swipe back, and ⌘L opening what you typed. | All selftest checks pass on the development build and on the packaged, fused build. |

## 6. Verification

- **Development build:** `DRIFT_SELFTEST=<dir> npx electron --no-sandbox .` runs the end-to-end selftest (`src/main/selftest.js`) and writes `results.txt` and screenshots.
- **Packaged build:** `npx electron-builder --linux dir`, then run `dist/linux-unpacked/drift-browser` with the same variable. This checks the fused, asar-packed app.
- **Security:** `npm run security` runs `npm audit` and Electronegativity.
- **Release:** pushing `release` makes CI build, verify and publish. A release happens only after the owner approves it.
