# @appliance.sh/ui

Shared Appliance React 19 primitives. Import components from the root or named
subpaths, and import `@appliance.sh/ui/styles.css` once at the application root.
JavaScript imports do not load CSS. Fonts are self-hosted.

`tokens.css` provides standalone CSS variables; `theme.css` is a Tailwind v4
build-time source. Consumer classes require consumer CSS. Static primitives
are server-compatible; interactive primitives preserve per-file client boundaries.

From the repository root, run `pnpm run build` and then
`node scripts/ui-packed-smoke.mjs` to pack and production-build isolated Vite
and Next 15 consumers. The smoke also checks export declarations, client
directives, standalone tokens, local fonts, and hydrated Button/Toast behavior.
It requires a Playwright Chromium installation (or `UI_SMOKE_CHROMIUM` pointing
to a Chromium executable). Fixtures and their npm cache stay under the system
temporary directory; the script prints their location.
