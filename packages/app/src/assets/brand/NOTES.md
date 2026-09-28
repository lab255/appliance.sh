# Socket A

The source directory for the provisional Appliance identity. `mark.svg` is the
full mark (24px and up); `mark-small.svg` is the pixel-hinted, notch-only variant
for 16–20px. Both are white, intended for a dark background.

The full counter spans x13–19, with pins x13–14.5 and x17.5–19. Its bottom stays
at y22, preserving the three-unit web above the leg notch at y25. The small
silhouette uses even coordinates for the notch so it lands on whole pixels at
16px. The lockup keeps the original outlined Geist wordmark and raises the mark
four units to optically balance its bottom-heavy silhouette against the caps.

From the repository root, regenerate all derived assets with:

```sh
node packages/desktop/scripts/generate-icon.mjs
```

A full-mark swap only edits `mark.svg` before regeneration; revise
`mark-small.svg` too when the new identity needs a different small silhouette.
The generator refreshes the marked region of `lockup.svg`, the 1200×630 OG
layout, both public favicon pairs, and the sanctioned Tauri icon directory.
The `tagline` group in the OG template is an empty slot for outlined paths;
there are no live text/font dependencies. Change its layout in the generator
if needed, because regeneration replaces the OG template.

SVG favicons select the small silhouette below 24px and the full mark above it.
The ICO deliberately contains the small silhouette at both 16px and 32px for
platform fallback. Tauri platform icons are rendered from the full mark on a
dark roundrect. The generator calls `pnpm exec tauri icon` against the generated
1024px `source.png` and copies only desktop outputs from its temporary directory.
