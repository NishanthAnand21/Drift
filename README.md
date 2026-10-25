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
| Memory | Memory Saver unloads tabs you haven't used for a while (30 min by default); background tabs are throttled |
| Other | ⌘F find in page, ⌘⇧T reopen a closed tab, ⌘⇧C copy the URL, ⌘1…9 jump to a tab, Ctrl+Tab cycle tabs, ⌘± zoom, ⌘⌥I DevTools, per-tab mute, downloads in the sidebar, crash and error pages, opens links when set as the default browser. |

## Extensions, passwords, sync, private windows

- **Extensions:** run **Get Extensions** in the command bar to open the Chrome Web Store, where **Add to Chrome** installs into Drift (you confirm the permissions first). Extension buttons appear at the top of the sidebar. Use **Manage Extensions…** for options or removal, and **Load Unpacked Extension…** for local folders. Installed extensions update automatically. Powered by `electron-chrome-extensions` (GPL-3.0 for personal and open-source use; closed-source distribution needs its commercial licence).
- **Passwords:** Drift offers to save logins when you submit a form. Click a login field to autofill, or to get a strong-password suggestion on sign-up forms. Passwords are encrypted with the macOS Keychain and only filled into the exact HTTPS origin they were saved for, after a real click. **Passwords…** needs Touch ID before it copies a password, and clears the clipboard after 30 s. **Import Passwords from CSV** accepts Chrome, Arc and 1Password exports; **Export Passwords** also needs Touch ID.
- **Sync:** run **Set Up Sync…**, pick a folder every Mac can see (iCloud Drive is suggested), and choose a passphrase. Spaces, pinned tabs, favourites, history and passwords sync every 2 minutes. Files are AES-256-GCM encrypted with a key derived (scrypt) from your passphrase, and each device writes only its own file. No server is involved.
- **Private window:** **⌘⇧N** opens a separate Drift process with a throw-away profile kept in memory. It stores no history, passwords or extensions, and everything is deleted when you close it.

## Claude, MCP and the Site Inspector

- **Ask Claude (⌘E):** opens a chat panel beside the page. Tick **Use this page** to send the current tab's text along with your question. You can also type `claude` in the command bar and press **Tab**, or pick the **Ask Claude** result.
  - It uses the official Anthropic SDK, with Claude Opus 5.5 by default; you can switch to Sonnet 5.5 or Haiku 5.5. Effort is adjustable in Settings → Integrations. If a request is refused, it is automatically retried on Anthropic's recommended fallback model.
  - Add your API key in **Settings → Integrations**, where it is stored encrypted in the Keychain. Alternatively, set `ANTHROPIC_API_KEY` or sign in with `ant auth login`.
  - Page text is wrapped as untrusted content, so instructions hidden in a website are not followed. Very long pages are shortened, and the chat tells you when that happens.
- **MCP:** turn on **Settings → Integrations → Allow MCP clients**, then copy the shown JSON into `claude_desktop_config.json` (Claude Desktop), or run the shown `claude mcp add …` command (Claude Code).
  - Tools: `list_tabs`, `open_url`, `switch_tab`, `close_tab`, `get_page_text` (needs a separate opt-in), `search_history`, `list_spaces`, `switch_space`, `search_archive`, `inspect_site`.
  - The server only listens on 127.0.0.1, needs a random token on every call, and ignores requests from web pages.
- **Site Inspector (⌘⇧I or the ⓘ in the URL pill) shows:**
  - certificate: issuer, chain, validity, fingerprint and verification result
  - security headers with an A+–F grade (HSTS, CSP, frame options, nosniff, referrer and permissions policies, COOP/CORP)
  - every cookie with its Secure / HttpOnly / SameSite flags
  - the detected tech stack: frameworks, CMS, CDN/host, server, analytics and payments
  - mixed content, third-party scripts, blocked trackers and granted permissions

## Settings (⌘,)

| Tab | What's there |
|---|---|
| General | Automatic updates, warn before quitting (⌘Q twice), restore tabs from the last session, default browser |
| Profiles | Add, rename or delete profiles; search engine and suggestions; archive timing; download location (Downloads, ask every time, or a custom folder); passwords; clear browsing data |
| Tidy | Tidy Tabs (the ✧ button groups tabs by site and archives duplicates), Instant Links (⇧↩ opens the top result; separate several queries with commas), Tidy Tab Titles when pinning (double-click a tab to rename it), Tidy Downloads (renames files like `387494875.pdf` after their page), AI in the command bar (Claude, ChatGPT or Perplexity). All of these run locally. |
| Links | Little Window (⌥⌘N from any app; a small window with an **Open in Drift** button), links from other apps open in a Little Window, Peek (⇧-click a link, or follow a link to another site from a Favourite or Pinned tab) |
| Privacy & Security | Ad & tracker blocking with EasyList/EasyPrivacy filter lists (cosmetic hiding included; Strict mode adds cookie-banner and annoyance lists), HTTPS-Only, proxy (system / none / manual incl. SOCKS5 / PAC URL), and per-site permissions with reset |
| Integrations | Claude API key, model and effort; MCP; sync; extensions |
| Shortcuts | Every keyboard shortcut |
| Icon | Four app icons: Aurora, Midnight, Sunrise and Graphite |
| Advanced | Picture-in-Picture when you leave a playing video, Boosts (per-site dark mode, reading layout, fonts or custom CSS), Memory Saver (unloads background tabs after 15 min to 4 h), Export Data |

The **Library** (▤ at the bottom of the sidebar) lists media that's playing, downloads, spaces, Boosts and archived tabs.

**About TLS:** Drift uses Chromium's TLS 1.3 / 1.2 with certificate verification and Certificate Transparency. TLS 1.0/1.1 are removed from Chromium (and from Chrome, Safari and Arc) because they are insecure, so they cannot be enabled.

## Security & privacy

- Every web page runs in Chromium's **sandbox**, with context isolation and no Node.js access. Pages can't create `<webview>`s, and the UI is locked down with a strict CSP.
- Only Drift's own UI pages can send IPC messages, and every action is checked against an allow-list.
- **HTTPS-Only mode** upgrades `http://` sites. If a site has no HTTPS, you get a warning page where you can choose to continue.
- A built-in **ad & tracker blocker** uses EasyList and EasyPrivacy filter lists (downloaded on first run and refreshed weekly) plus a built-in domain list. It hides ad slots on pages, counts blocked requests in the URL pill (⛨ N), and strips the `X-Client-Data` header.
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
