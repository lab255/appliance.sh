# Journey motion captures

Before: `feat/ui-motion` at `de4503d`. After: `feat/journey-motion`.
Both use the same development-only mock host fixtures. Chromium captures are
real-time, resized to 800 × 624 with a shared 96-color palette per GIF.

| Flow | Reproduction |
| --- | --- |
| Mode choice | `/?mock-host&scenario=first-run` |
| Welcome | `/setup?mock-host&scenario=journey` |
| Boot and landing handoff | Welcome → Start the Sandbox → Run your first agent |
| Wizard | `/cloud/bootstrap?mock-host&scenario=developer-mode` → AWS Cloud → Back |
| Ledger | `/machine?mock-host&scenario=journey-ledger` → Machine capabilities → Set up hosting → Set up |
| Reduced motion | Wizard with `prefers-reduced-motion: reduce` |

The ledger fixture keeps a previously selected cloud target stable while local
hosting is provisioned. Its local health probe changes from 503 to 200 only
when the mock VM is running and hosting is provisioned. This avoids the
separate first-target authorization reload, allowing the existing ledger to
observe its status changing to On.

Wizard browser checks: forward heading focus is AWS Cloud; back heading focus
is New installation. With reduced motion, the frame reports `animation: none`
and `transform: none`, while retaining the same heading focus.

All GIFs are at most 800,000 bytes. Start the mock host with
`pnpm --filter @appliance.sh/desktop dev` after building the app. Capture servers
used isolated Vite caches and the built app entry to avoid reprocessing the
library bundle through React's development transform.
