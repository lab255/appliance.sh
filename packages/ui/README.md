# @appliance.sh/ui

Shared Appliance React 19 primitives. Import components from the root or named
subpaths, and import `@appliance.sh/ui/styles.css` once at the application root.
JavaScript imports do not load CSS. Fonts are self-hosted.

`tokens.css` provides standalone CSS variables; `theme.css` is a Tailwind v4
build-time source. Consumer classes require consumer CSS. Static primitives
are server-compatible; interactive primitives preserve per-file client boundaries.
