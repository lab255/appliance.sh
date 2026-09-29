# Server identity

The original Appliance identity is the Lucide `Server` glyph. The sidebar uses
its original white rounded chip and live Lucide component. `mark.svg` embeds the
same glyph with white strokes on transparent, centered in a 32×32 viewBox.
`mark-small.svg` thickens the strokes to 3 units and omits indicator dots for
legibility at 16px. The lockup retains the outlined Geist wordmark.

From the repository root, regenerate all derived assets with:

```sh
node packages/desktop/scripts/generate-icon.mjs
```

A full-mark swap only edits `mark.svg` before regeneration; revise
`mark-small.svg` too when the new identity needs a different small silhouette.
The generator refreshes the marked region of `lockup.svg`, the 1200×630 dark OG
template, both desktop/console public favicon pairs, and the sanctioned Tauri
icon directory. The OG `tagline` group is an empty slot for outlined paths;
there are no live text/font dependencies.

SVG favicons select the small glyph below 24px and the full glyph above it.
The ICO contains the small glyph at both 16px and 32px. Tauri platform icons
use the full glyph centered on a dark roundrect. The generator runs
`pnpm exec tauri icon` against generated `source.png` and copies only desktop
outputs from its temporary directory.

Socket A survives in git history (69b536b / PR #128) and candidate sheets on `chore/artifacts` for the future logo-refinement pass.

## Embedded glyph license

Lucide Server is ISC-licensed; the small glyph is an adaptation. License notice
from the installed `lucide-react` package:

```text
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```
