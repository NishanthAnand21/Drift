# Drift

A calm, sidebar-first web browser for macOS, built on **Chromium** (via Electron 38). It has
vertical tabs, spaces with colour themes, separate profiles, favourites, pinned tabs, a
keyboard command bar, split view, a window with no toolbar, and tabs that archive themselves.

## Run (development)

Requirements: macOS 12+, Node.js 20+ (22 recommended).

```bash
npm install
npm start
```

## Build a macOS app

```bash
npm run build            # → dist/Drift-1.0.0-arm64.dmg, …-x64.dmg and .zip files
```

Open the `.dmg` and drag **Drift** into Applications. Unsigned builds need a right-click →
**Open** the first time. To sign and notarise, set `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` before you build.

Regenerate the icon from `build/icon.svg` with `npm run icon`.

## Features

| Feature | How |
|---|---|
| Vertical tab sidebar | Favourites grid → space name → pinned tabs → **New Tab** → today's tabs. Drag to reorder, or drag between sections or onto a space dot. Drag the sidebar's edge to resize it. |
| No-toolbar window | Inset traffic lights. The sidebar holds back/forward/reload and the URL pill. ⌘S hides the sidebar; hover the left edge to peek at it. |
| Command bar | **⌘T** opens a new tab. **⌘L** edits the current URL. It searches open tabs, history, archived tabs and commands, shows live search suggestions, and is used for every setting. |
| Spaces | Ctrl+1…9 or ⌘⌥←/→ to switch. Click **＋** at the bottom or press ⌘⇧N to create one. Right-click a space dot to rename it, change its colour (the whole window is tinted) or change its profile. |
| Profiles | Pick “New Space with New Profile” for separate cookies, logins, storage and favourites. Spaces can share a profile. |
| Favourites & pinned | ⌘D pins or unpins. Use right-click or drag to favourite. ⌘W on a pinned or favourite tab only unloads it, and the tab goes back to its pinned URL. |
| Split view | **Ctrl+⇧=** picks a page for the right pane. You can also right-click a tab → Open in Split View, or right-click a link. **Ctrl+⇧-** separates the panes. |
| Auto-archive | Unpinned tabs not used for 12 h (you can choose 24 h, 7 d, 30 d or never) move to the archive. ⌘⇧A or ⌂ shows the archive, and the command bar searches it. **↓ Clear** archives today's tabs now. |
| Other | ⌘F find in page, ⌘⇧T reopen a closed tab, ⌘⇧C copy the URL, ⌘1…9 jump to a tab, Ctrl+Tab cycle tabs, ⌘± zoom, ⌘⌥I DevTools, per-tab mute, downloads in the sidebar, crash and error pages, opens links when set as the default browser. |

## Extensions, passwords, sync, private windows

- **Extensions:** run **Get Extensions** in the command bar to open the Chrome Web Store, where **Add to Chrome** installs into Drift (you confirm the permissions first). Extension buttons appear at the top of the sidebar. Use **Manage Extensions…** for options or removal, and **Load Unpacked Extension…** for local folders. Installed extensions update automatically. Powered by `electron-chrome-extensions` (GPL-3.0 for personal and open-source use; closed-source distribution needs its commercial licence).
- **Passwords:** Drift offers to save logins when you submit a form. Click a login field to autofill, or to get a strong-password suggestion on sign-up forms. Passwords are encrypted with the macOS Keychain and only filled into the exact HTTPS origin they were saved for, after a real click. **Passwords…** needs Touch ID before it copies a password, and clears the clipboard after 30 s. **Import Passwords from CSV** accepts Chrome, Arc and 1Password exports; **Export Passwords** also needs Touch ID.
- **Sync:** run **Set Up Sync…**, pick a folder every Mac can see (iCloud Drive is suggested), and choose a passphrase. Spaces, pinned tabs, favourites, history and passwords sync every 2 minutes. Files are AES-256-GCM encrypted with a key derived (scrypt) from your passphrase, and each device writes only its own file. No server is involved.
- **Private window:** **⌘⇧N** opens a separate Drift process with a throw-away profile kept in memory. It stores no history, passwords or extensions, and everything is deleted when you close it.

## Security & privacy

- Every web page runs in Chromium's **sandbox**, with context isolation and no Node.js access. Pages can't create `<webview>`s, and the UI is locked down with a strict CSP.
- Only Drift's own UI pages can send IPC messages, and every action is checked against an allow-list.
- **HTTPS-Only mode** upgrades `http://` sites. If a site has no HTTPS, you get a warning page where you can choose to continue.
- A built-in **tracker & ad blocker** blocks about 100 advertising and analytics domains and counts what it blocked in the URL pill (⛨ N). It also strips the `X-Client-Data` header.
- **Site permissions** (camera, microphone, location, notifications, screen sharing, etc.) prompt on each site, can be remembered, are only granted to HTTPS sites, and can be reset from the command bar.
- External protocols (mailto:, zoom:, …) always ask before they open another app. `file:`, `javascript:` and `chrome:` navigations from web pages are blocked.
- Popups that sites need for sign-in (such as OAuth) open sandboxed; everything else opens as a tab.
- Each profile is isolated in its own storage partition. Use **Clear Browsing Data** to wipe history, cookies and cache.
- The user agent looks like a normal Chrome, so sites don't treat Drift differently.

## Updates

- **App updates:** packaged builds check GitHub Releases at launch and every 4 h (`electron-updater`), download in the background, and offer to restart. Set `build.publish.owner/repo` in `package.json` to your repository, then push a `v*` tag; `.github/workflows/release.yml` builds and publishes. macOS only applies auto-updates to signed builds.
- **Chromium security updates** arrive with new Electron releases. `.github/dependabot.yml` opens a PR each week, so bump the Electron version, then tag a release.

## Project layout

```
src/main/main.js      window, tabs, spaces, split view, archive, security, menus, updates
src/main/blocker.js   tracker blocklist
src/main/store.js     state persistence (~/Library/Application Support/Drift/drift-state.json)
src/preload/ui.js     narrow bridge for Drift's own UI only
src/ui/               sidebar (index.html) and command bar overlay (palette.html)
src/web/error.html    error / HTTPS-Only / crash page
```

## Test

`DRIFT_SELFTEST=/some/dir npm start -- --no-sandbox` runs a scripted end-to-end test. It loads
real sites and checks pinning, favourites, split view, the command bar, spaces, profiles and
auto-archive. It writes `results.txt` and screenshots to that directory (Linux, under `xvfb-run`).
