# UI motion visual proof

Headless Chromium, 760 × 540 viewport, actual desktop `?mock-host&scenario=user-mode`
background with a temporary primitive interaction panel. The panel is outside the
feature branch; it drives the actual source components and UI providers.

- Before: `origin/main` at `09e9e7a`, original app-local primitives. Skeleton swap
  is a plain loading/content conditional because the client wrapper is new.
- After: `feat/ui-motion` at `794b6d7`, stacked on extraction `721b981`; same controls,
  toast/dialog/banner text, viewport, and mock-host scenario.
- Reduced: same after build with Chromium `prefers-reduced-motion: reduce`.
- Toast includes enter and manual dismissal; dialog includes open and Escape;
  banner includes entry and dismissal; skeleton includes loading-to-content swap.
- GIF frame durations follow measured screenshot timestamps, with extra holds
  before/after the action. Shared 96-color palette; every file is below 800 KB.
- These are isolated primitive demonstrations over the real mock-host shell,
  not new production routes or journey-motion changes.

The final feature PR records commits, packed Next/Vite measurements, and the
foreground verification result. Browser keyboard, live preference toggling,
static-import isolation, and delayed-feature behavior are tested in
`scripts/ui-packed-smoke.mjs` on the feature branch.
