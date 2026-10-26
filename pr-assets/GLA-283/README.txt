GLA-283 capture reproduction

Baseline: 42e77d1 (origin/main merged before review; original audit cafd493). Feature: feat/polish-async-state-stability.
No binaries are present on the feature branch. These assets live only on chore/artifacts.
Viewport 1280x900; device scale factor 1; dark theme; identical mock objects and routes.
The timestamps in fixture objects are fixed; relative-time labels and build timestamps naturally advance.

Install dependencies in the repo: pnpm install
Build UI and SDK first via NX_DAEMON=false NX_SKIP_NX_CACHE=true pnpm verify. The verified CLI Docker fixture exception stops this script before Rust; run all three Rust build/test/clippy sequences from scripts/verify.sh explicitly in that case.
Disable Nx caching when validating across revision switches; this worktree otherwise retained a main app/dist bundle despite modified feature sources.
For EACH revision, build packages/app and restart the desktop dev server with --force:
  pnpm --filter @appliance.sh/app build
  pnpm --filter @appliance.sh/desktop dev --host 127.0.0.1 --force
Do not reuse the previous Vite dependency cache: it otherwise serves the old app bundle.

Temporary harness dependencies (no runtime/package-lock changes to the repo):
  npm install --prefix /tmp/gla283-capture --cache /tmp/gla283-npm-cache --no-audit --no-fund playwright@1.64.1 pngjs@7.0.0 gifenc@1.0.3
Download capture.mjs and recovery.mjs into /tmp/gla283-capture/.
Update the chromium executablePath in both scripts for your host, or use Playwright's installed Chromium.
Chromium needs permission to create Mach ports on macOS; it cannot launch inside this filesystem sandbox.
  node /tmp/gla283-capture/capture.mjs before
  node /tmp/gla283-capture/recovery.mjs before
Then restore the feature branch, rebuild/restart --force, and run with 'after'.
Optional third argument is a comma-separated subset of case names; measurements merge with existing output.
Restore the feature branch in an EXIT trap whenever temporarily checking out the baseline. Delete temporary scripts after use.

Simulation: read-only mock host calls are wrapped with 1600ms delays, REST reads intercepted with the same 1600ms delay. Recovery cases use 800ms delays, force initial read failures, then click available Retry controls after five frames. The main module interception affects only the browser fixture, not repo source. No production data or credentials are used.

25 screenshots per case, separated by 200ms plus screenshot overhead, encoded at 240ms/frame. GIF playback is illustrative; measurements are captured live before each screenshot. Geometry is the outer page block (main > div), not normalized Web Vitals CLS. Each measurement file includes every sampled rectangle. Comparison counts adjacent samples with a >1px bounding-box change. Polling and dependent reads can produce multiple sampled changes per page.

Error-to-success captures preserve the page instance but can change height when real content replaces the small error; these changes are recorded separately from initial successful-arrival measurements. Unknown list cardinality, optional blocks, narrow wrapping, and different runtime/provider states remain documented limitations in docs/async-state-audit.md.
