# Socket A integration captures

- Sidebar: real Chromium page at `http://localhost:1420/?mock-host`, served with
  `pnpm --filter @appliance.sh/desktop dev`. Before uses the original app bundle
  from origin/main (`bd7a195`); after uses the updated shared app bundle. Header
  crops are 440×160 at 2× device scale. Only the sidebar brand crop is relevant.
- Favicon: real headed Chromium tab strip, captured with macOS `screencapture
  -x -R 0,30,650,85`. Before suppresses the two new icon links and returns 404
  for favicon requests to reproduce the original no-favicon document. After
  loads the unmodified desktop page with its actual SVG icon. Cropped at capture
  time to exclude the surrounding desktop. Browser version: Chrome for Testing
  from Playwright chromium-1234.
- App icon: origin/main and updated Tauri `source.png`, rendered at 320×320.
- Craft sheet: original candidate mark/lockup versus revised sources, on the
  same dark canvas. Marks shown at 16, 20, 24, 32px; revised 16/20 use mark-small.
- OG: generated 1200×630 SVG rendered to PNG; empty outlined-tagline slot.

No screenshot is on the feature branch. These are local mock data, not live
accounts. The source candidate worktree was read only.
