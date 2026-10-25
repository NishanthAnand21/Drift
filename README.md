# Drift

A calm, sidebar-first web browser for macOS, built on **Chromium** (via Electron 45). It has
vertical tabs, spaces with colour themes, separate profiles, favourites, pinned tabs, a
keyboard command bar, split view, a window with no toolbar, and tabs that archive themselves.

## Install

Download **Drift-x.y.z-arm64.dmg** (Apple Silicon) or **Drift-x.y.z.dmg** (Intel) from [Releases](https://github.com/NishanthAnand21/drift/releases), open it, and drag **Drift** into Applications.

Release builds are ad-hoc signed, not signed with an Apple Developer ID, so macOS will warn the first time. To open Drift anyway, try right-click → **Open**. If that doesn't work, go to **System Settings → Privacy & Security → Open Anyway**, or run `xattr -dr com.apple.quarantine /Applications/Drift.app`. Adding Developer ID secrets to the repository (see below) produces fully signed and notarised builds.

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
| Vertical tab sidebar | Laid out like Arc. At the top: sidebar toggle and back/forward/reload, then the URL pill with extension buttons, Claude, copy link and site controls. Below that, a 4-column grid of Favorites, the space name with its icon, pinned tabs and **folders**, a **Tidy \| Clear** divider, **New Tab**, and today's tabs. The bottom bar has the Downloads & Library button, space icons and **+**. Drag tabs to reorder them, move them between sections, drop them onto a folder or a space icon, and drag the sidebar edge to resize it. |
| Pinned tabs & folders | ⌘D pins a tab. A pinned tab that has navigated away from its pinned page shows **/ title**, with a **↑** button that takes it back. Create folders with **+ → New Folder** or the command bar; drop tabs onto a folder, click it to collapse, and right-click to rename or delete it (deleting keeps its tabs). |
| Favorites previews | Hover a Favorite: **Gmail** shows your latest emails (click one to open it, or **+** to compose), and other sites show how the page last looked. All of it is read locally from your own signed-in tab. |
| + menu | New Space, New Folder, New Boost, New Split and New Tab, in the same popover style as Arc. |
| Site controls | The sliders icon in the URL pill opens a card with Share, Boost, Screenshot (copied and saved to Downloads) and Site Inspector, your extensions, and this site's settings: camera & microphone, location, notifications, screen sharing, clipboard, MIDI, automatic Picture-in-Picture, pop-ups, and ad blocking. Click a setting to change it. The 🔒 Secure / ⚠ Not Secure footer opens the certificate details, and ⋯ holds zoom, clearing the site's cookies, and resetting its settings. |
| Downloads | The bottom-left button opens the downloads panel: Quick Look thumbnails, file names, “15 hours ago”, and live progress. Click to open, drag into Finder or another app, or right-click for Show in Finder, Pause/Resume, Cancel, Copy Path, Remove or Move to Trash. The list is kept across restarts. |
| Themes | Each space has its own theme, edited in **Settings → Spaces** (or right-click a space → Edit Theme & Icon): 12 presets, or up to 3 colours blended into a gradient, Light / Dark / Auto, colour intensity, grain, and an emoji icon. Themes sync along with your spaces. |
| Better unloaded tabs | Tabs and Favorites that aren't loaded are shown greyscale and faded, so you can see what's using memory. Turn it off in Settings → Advanced, which also has a switch to hide the ↑ back-to-pinned-page button. |
| Find bar (⌘F) | A floating bar in your space's colours with **Highlight All**, **Match Case**, **Match Diacritics** (when off, “exámple” matches “example”) and **Whole Words**, plus “1 of 4 matches” and ↑/↓. It runs in an isolated world and paints matches with the browser's CSS Custom Highlight API, so the page itself is never modified. Your choices are remembered. |
| Create Visual | **+ → New Visual** or the command bar turns the page you're on into a **slide deck, poster, infographic or dashboard** in your space's colours. It reads your open tab, so it works behind logins too. With an API key, Claude builds it into a tab, and **Export Visual as PDF** saves it to Downloads. Generated visuals have scripts stripped and run under a no-script Content-Security-Policy. Without a key, the request and page are typed into Claude on claude.ai, which builds it as an artifact using your plan. |
| No-toolbar window | Inset traffic lights. The sidebar holds back/forward/reload and the URL pill. ⌘S hides the sidebar; hover the left edge to peek at it. |
| Command bar | **⌘T** opens a new tab. **⌘L** edits the current URL. It searches open tabs, history, archived tabs and commands, shows live search suggestions, and is used for every setting. |
| Spaces | Ctrl+1…9 or ⌘⌥←/→ to switch. Click **＋** at the bottom or press ⌘⇧N to create one. Right-click a space dot to rename it, change its colour (the whole window is tinted) or change its profile. |
| Profiles | Pick “New Space with New Profile” for separate cookies, logins, storage and favourites. Spaces can share a profile. |
| Favourites & pinned | ⌘D pins or unpins. Use right-click or drag to favourite. ⌘W on a pinned or favourite tab only unloads it, and the tab goes back to its pinned URL. |
| Split view | Up to **4 tabs** at once, side by side or stacked. **Ctrl+⇧=** adds a pane: it opens the command bar so you can pick a tab or page for it. You can also right-click a tab → Open in Split View, or right-click a link → Open Link in Split View. Drag the dividers to resize, and double-click one to make the panes equal. The focused pane has a coloured outline. Use **Split View: Side by Side / Stacked** in the command bar, **Remove Tab from Split View**, or **Ctrl+⇧-** to separate the panes. |
| Floating video | Switch tabs or apps while a video is playing and it pops out into Chromium's native Picture-in-Picture window. You can move it anywhere and resize it, and on macOS it stays on top of other apps. Return to the tab, or to Drift, and the video goes back into the page. **⌥⌘P** pops it out by hand. Both automatic triggers can be turned off in Settings → Advanced. |
| Peek | ⇧-click a link, or right-click it → **Open Link in Peek**, to preview it in a popup over the page. From there, open it as a tab or in split view. |
| Auto-archive | Unpinned tabs not used for 12 h (you can choose 24 h, 7 d, 30 d or never) move to the archive. ⌘⇧A or ⌂ shows the archive, and the command bar searches it. **↓ Clear** archives today's tabs now. |
| Memory | Memory Saver unloads tabs you haven't used for a while (30 min by default); background tabs are throttled |
| Other | ⌘F find in page, ⌘⇧T reopen a closed tab, ⌘⇧C copy the URL, ⌘1…9 jump to a tab, Ctrl+Tab cycle tabs, ⌘± zoom, ⌘⌥I DevTools, per-tab mute, downloads in the sidebar, crash and error pages, opens links when set as the default browser. |

## Extensions, passwords, sync, private windows

- **Extensions:** run **Get Extensions** in the command bar to open the Chrome Web Store, where **Add to Chrome** installs into Drift (you confirm the permissions first). Extension buttons appear at the top of the sidebar. Use **Manage Extensions…** for options or removal, and **Load Unpacked Extension…** for local folders. Installed extensions update automatically. Powered by `electron-chrome-extensions` (GPL-3.0 for personal and open-source use; closed-source distribution needs its commercial licence).
- **Passwords:** Drift offers to save logins when you submit a form. Click a login field to autofill, or to get a strong-password suggestion on sign-up forms. Passwords are encrypted with the macOS Keychain and only filled into the exact HTTPS origin they were saved for, after a real click. **Passwords…** needs Touch ID before it copies a password, and clears the clipboard after 30 s. **Import Passwords from CSV** accepts Chrome, Arc and 1Password exports; **Export Passwords** also needs Touch ID.
- **Sync:** run **Set Up Sync…**, pick a folder every Mac can see (iCloud Drive is suggested), and choose a passphrase. Spaces, pinned tabs, favourites, history and passwords sync every 2 minutes. Files are AES-256-GCM encrypted with a key derived (scrypt) from your passphrase, and each device writes only its own file. No server is involved.
- **Private window:** **⌘⇧N** opens a separate Drift process with a throw-away profile kept in memory. It stores no history, passwords or extensions, and everything is deleted when you close it.

## Claude, MCP and the Site Inspector

- **Ask Claude (⌘E):** opens a Claude panel beside the page. There are two ways to use it; switch with the **⋯** menu or in Settings → Integrations.
  - **Your Claude account (default, no API key):** the panel shows the official claude.ai, where you sign in with your Pro, Max or Team plan, so usage counts against your plan. It runs in its own isolated session: Drift never sees your Claude password or session, and websites can't reach it. **＋ Add page** types the current tab's text into Claude's message box so you can add your question. Typing `claude` then **Tab** in the command bar asks a question there. **Sign Out** clears Drift's claude.ai session.
  - **An API key (optional, pay-per-use):** a native chat built on the official Anthropic SDK, with Claude Opus 5.5 by default (Sonnet 5.5 or Haiku 5.5 also available) and adjustable effort. A refused request is retried automatically on Anthropic's recommended fallback model. The key is stored encrypted in the Keychain; `ANTHROPIC_API_KEY` or `ant auth login` also work. In this mode, page text is wrapped as untrusted content, and very long pages are shortened with a notice.
  - Drift doesn't extract a Pro/Max login to make API calls for you, because Anthropic's terms only allow subscription logins in Anthropic's own apps. Signing in on claude.ai, as above, is the supported way to use your plan.
- **MCP:** turn on **Settings → Integrations → Allow MCP clients**, then copy the shown JSON into `claude_desktop_config.json` (Claude Desktop), or run the shown `claude mcp add …` command (Claude Code). The bridge needs Node.js 18 or newer (`node` on your PATH).
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

- **Dangerous-site protection:** Drift checks pages against the abuse.ch URLhaus malware list and the OpenPhish phishing list. The lists are downloaded every 6 hours and checked on your Mac; nothing you browse is sent anywhere. Phishing entries match on host *and* path, so a shared host isn't blocked entirely. Blocked pages show a red warning with **Back to safety**, plus **Continue anyway** if you choose to proceed.
- **Hardened binary (Electron fuses):**
  - Cookies are encrypted with the macOS Keychain.
  - App-code integrity is checked at launch, and the app only loads from its archive.
  - `RunAsNode`, `NODE_OPTIONS` and `--inspect` are disabled, so the signed app can't be used as a Node.js runtime.
  - `file://` pages get no extra privileges. Drift's own UI is served from a private `drift-ui://` scheme that websites can't read. Its internal pages that open inside tabs, such as error and warning pages and visuals, load as self-contained pages with strict CSPs.
- **Up-to-date engine:** Electron **45** (current stable Chromium), with every dependency on its latest version. `npm audit` reports 0 vulnerabilities. A vulnerable `adm-zip`, pulled in by the Web Store library, is pinned to the fixed 0.6.1, and Dependabot proposes updates weekly.
- **Audited:** `npm run security` runs `npm audit` and Doyensec's Electronegativity scanner. Its findings were reviewed: every UI page's CSP now forbids `<base>` and form submissions, and external links refuse network-share schemes (smb/afp/nfs/cifs).
- **Isolated Claude session:** claude.ai, the MCP endpoint and the extension popups each run in their own session, separate from your browsing profiles.

## Speed & memory

- Tabs load lazily: on launch only the tab you're looking at loads, and the rest restore when you open them.
- **Memory Saver** unloads tabs you haven't used for 30 minutes (adjustable). Background tabs are throttled. Unloaded tabs are shown greyscale.
- **Task Manager** (command bar) lists the memory each loaded tab uses; pick one to unload it.
- Drift connects to a site early (TLS and DNS) as soon as you select it in the command bar or hover a Favorite, so it opens faster.
- The sidebar only redraws when something actually changes. Favourite snapshots are capped at 24 to keep memory bounded.

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
