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

Mount `MotionProvider` from `/motion-provider` once around the interactive subtree
(inside application providers, outside routes). Install the tested `motion@13.4.4`;
the peer supports that stable major. Features load in a separate `domAnimation`
chunk. Without a provider, or before features load, primitives remain immediate
and readable. Initial SSR content never starts hidden.

Use `BannerPresence` from `/banner` at the owner of conditional banner state:
`<BannerPresence>{visible ? <Banner key="notice">Message</Banner> : null}</BannerPresence>`.
Use `SkeletonSwap` from `/skeleton-swap` with `loading`, `fallback`, and `children`
for a loading-to-content crossfade. `/skeleton` itself stays server-compatible.
Preference changes select immediate transitions; state updates and actions never
wait for animation. Toast and dialog providers continue to own their own state.

Transition constants are generated from `src/theme.css` during the build. Author
CSS with `duration-(--duration-fast)` or explicit variables, and motion elements
with `import * as m from 'motion/react-m'`. No layout projection or drag features
are loaded. Static-only packed routes assert that Motion stays out of their JS.
The fixture reports gzip bytes for initial, lazy-feature, and static-route JS;
`UI_SMOKE_BASELINE=1 UI_SMOKE_TARBALL=/path/to/pre-motion.tgz` measures the same
consumer against the extraction artifact.
