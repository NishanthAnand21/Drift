## Install

| Mac | Download |
|---|---|
| Apple Silicon (M1–M4) | `Drift-1.0.1-arm64.dmg` |
| Intel | `Drift-1.0.1.dmg` |

Open the DMG and drag **Drift** to Applications. This build is ad-hoc signed, not signed with an Apple Developer ID, so on the first launch macOS will say it can't verify the app. To open it, right-click → **Open**, or go to **System Settings → Privacy & Security → Open Anyway**. Alternatively, run:

```
xattr -dr com.apple.quarantine /Applications/Drift.app
```

**Updating from 1.0.0:** download the new DMG and replace the app in Applications. Automatic updates need a Developer ID–signed build, and this one is ad-hoc signed.

## What's new in 1.0.1

- **Hidden sidebar works like Arc.**
  - Hover the left edge and the sidebar floats over the page. It opens instantly and the page doesn't resize.
  - Only the sidebar button (or ⌘S) docks it.
  - Its buttons are clickable: it no longer flickers away as you reach for them.
  - The window buttons hide with the sidebar and return when it peeks.
- **Fewer glitches:**
  - The command bar, popovers and previews no longer drop behind the page when the window resizes or a tab loads.
  - Favicons don't blink and clicks aren't lost while pages load.
  - Dragging the sidebar edge or a split divider no longer leaves the window unclickable.
  - Toasts show while the sidebar is hidden.
  - The find bar no longer keeps a peeked sidebar open.
- **Arc sizes:**
  - Sidebar: wider (285 px), shorter URL bar, flatter favourite tiles and taller tab rows.
  - Site controls: compact, with a different icon for each setting, and they follow the space's light/dark mode.
  - Settings: a compact preferences window with icon tabs.

## Highlights

- An Arc-style sidebar browser on **Chromium (Electron 45)**:
  - spaces with colour themes, profiles, Favorites with hover previews, pinned tabs and folders
  - split view (up to 4 tabs), Peek, Little Window, floating Picture-in-Picture video
  - Tidy tabs, the command bar, auto-archive and a downloads panel
- **Claude built in:** use your Claude account (Pro/Max/Team) or an API key. Create slide decks, posters, infographics or dashboards from any page. An MCP server lets Claude Desktop and Claude Code drive the browser.
- **Security:**
  - Chromium sandbox, per-site permissions, HTTPS-Only mode, EasyList ad & tracker blocking
  - malware & phishing protection, checked locally
  - Site Inspector (certificate, headers, cookies, tech stack)
  - password manager with Keychain encryption and Touch ID
  - encrypted sync, private windows, and hardened Electron fuses (cookie encryption, asar integrity, no RunAsNode)
- **Speed:** tabs load lazily, Memory Saver, Task Manager, and connections start early from the command bar.

## Quality

Before this release, 106 end-to-end checks passed on both the development build and the packaged, fused build. `npm audit` reports 0 vulnerabilities, and Electronegativity found nothing high-severity.
