# GLA-277 evidence

Before: audited 6866e82 app sources built against the same dependency lockfile.
After: 556f3a7. Chromium 1223, 1100×780, self-hosted Inter Variable.
Actual desktop mock-host developer-mode page, AppShell navigation, and TerminalTabBar.
The capture script injects only an in-memory terminal transport through Playwright
response interception because the existing browser mock has no terminal capability.
No production component or styles are simulated. Terminal titles are renamed
through the existing F2 interaction. Active tabs open the existing terminal overlay.

Raw requestAnimationFrame samples measure navigation rows and labels, terminal
rows, tab buttons, and following status siblings throughout every transition.
Every after/reduced-motion sample has dx=0 and dw=0. Intermediate wght values
prove the 80ms transition ran; reduced motion contains endpoints only with 0s.
The ruler marks actual terminal-row left edges. GIFs are presentation captures;
JSON is the timing/geometry evidence (screenshots need not align to every rAF).

Source script assumes existing local Playwright and a desktop Vite server on
41779; adjust executable/module paths for another machine. Run with before,
after, or reduced after building the corresponding app version, then encode
PNG frames as GIFs (80ms display cadence). Captures are deterministic mock data.
