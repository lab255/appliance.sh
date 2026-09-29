# Server identity restoration captures

Before: origin/main c4d36cb (Socket A). After: feat/brand-server-revert.

- Sidebar and welcome: real shared app in desktop DEV mock host, Chromium 1228,
  `/setup?mock-host&scenario=journey`, 1000×780 viewport at 2× device scale.
  Sidebar crop is 240×110. Both captures use the same fresh journey fixture.
- Favicon: actual headed Chromium tab strip on macOS, captured with
  `screencapture -x -R 0,30,650,85` after loading settles. Both use the real
  desktop favicon links; desktop and console SVG/ICO assets are identical.
- App icon: actual Tauri `src-tauri/icons/source.png`, before and after,
  1024×1024. This is an asset preview, not a native installed app screenshot.
- Vite was restarted with `--force` after rebuilding the shared app so the
  after capture uses the new bundle. The welcome screen itself needed no edits:
  its existing `mark.svg` import renders the Server glyph after replacement.

All screens use local mock data. No live accounts or board writes.
