## 1.56.0 (2026-08-26)

### Features

- desktop journey audit fixes + design-system/UX overhaul ([#66](https://github.com/lab255/appliance.sh/pull/66))

### Bug Fixes

- **ci:** unwedge the release train after the lab255 repo move ([#67](https://github.com/lab255/appliance.sh/pull/67))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.55.1 (2026-08-18)

### Bug Fixes

- **desktop:** core-first boot with lazy deployment-layer provisioning ([e415c47](https://github.com/lab255/appliance.sh/commit/e415c47))
- **desktop:** address lazy microVM review findings ([145a35f](https://github.com/lab255/appliance.sh/commit/145a35f))

### ❤️ Thank You

- Eliot Lim

## 1.55.0 (2026-08-17)

### Features

- **cloud:** CloudFormation AWS install target; retire 3-phase bootstrap ([90ffc07](https://github.com/lab255/appliance.sh/commit/90ffc07))
- **vm:** core-ready default boot; k3s/buildkit/registry become a lazy layer ([064f162](https://github.com/lab255/appliance.sh/commit/064f162))

### Refactoring

- **infra:** remove dead Docker deployment runtime ([fe68cdc](https://github.com/lab255/appliance.sh/commit/fe68cdc))

### ❤️ Thank You

- Eliot Lim

## 1.54.2 (2026-08-06)

### Bug Fixes

- **desktop:** sign staged binaries in beforeBundleCommand, not before tauri build ([c605dce](https://github.com/appliance-sh/appliance.sh/commit/c605dce))

### ❤️ Thank You

- Eliot Lim

## 1.54.1 (2026-08-06)

### Bug Fixes

- **desktop:** derive signing identity and Developer-ID-sign staged binaries ([14e6445](https://github.com/appliance-sh/appliance.sh/commit/14e6445))

### ❤️ Thank You

- Eliot Lim

## 1.54.0 (2026-08-06)

### Features

- **cli:** appliance mcp — MCP server so external agents can deploy and debug ([aed6967](https://github.com/appliance-sh/appliance.sh/commit/aed6967))
- **cli:** human vm status with next-step guidance + one-command vm reset ([3cd9830](https://github.com/appliance-sh/appliance.sh/commit/3cd9830))
- **cli:** vm up names the engine binary it resolved (path + build date) ([89e02b3](https://github.com/appliance-sh/appliance.sh/commit/89e02b3))
- **desktop:** reassure instead of bare-spinning when a VM boot goes quiet ([1a2d5ea](https://github.com/appliance-sh/appliance.sh/commit/1a2d5ea))

### Bug Fixes

- **api-server:** build bootstrap before web console in docker-prep ([c801905](https://github.com/appliance-sh/appliance.sh/commit/c801905))
- **cli:** make support-bundle tar work when GNU tar shadows bsdtar on Windows ([cf2c598](https://github.com/appliance-sh/appliance.sh/commit/cf2c598))
- **cli:** honest Ctrl+C messaging pre-dispatch; record per-call profile in MCP deploy links ([25faa91](https://github.com/appliance-sh/appliance.sh/commit/25faa91))
- **security:** restrict profiles.json ACL to the owning user on Windows ([8a15a7b](https://github.com/appliance-sh/appliance.sh/commit/8a15a7b))
- **ux:** honest deploys, no stack traces, inline WSL fix — unhappy paths for non-developers ([de9466a](https://github.com/appliance-sh/appliance.sh/commit/de9466a))
- **windows:** preflight WSL2 + disk checks, no console flashes, targeted WSL error guidance ([98debfd](https://github.com/appliance-sh/appliance.sh/commit/98debfd))

### Refactoring

- simplify MCP handlers, reuse vm capture helper, true up WSL classifier parity ([28a9c2a](https://github.com/appliance-sh/appliance.sh/commit/28a9c2a))

### Documentation

- **readme:** mention vm status guidance and the one-command vm reset ([69184e8](https://github.com/appliance-sh/appliance.sh/commit/69184e8))
- **rfcs:** add design RFC collection with status index ([7d515ff](https://github.com/appliance-sh/appliance.sh/commit/7d515ff))

### Chores

- **lint:** ignore staged .docker-deps build context in eslint ([1075e08](https://github.com/appliance-sh/appliance.sh/commit/1075e08))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.53.2 (2026-07-20)

### Bug Fixes

- **ci:** quote scoped package names in windows desktop build ([f3ae879](https://github.com/appliance-sh/appliance.sh/commit/f3ae879))

### ❤️ Thank You

- Eliot Lim

## 1.53.1 (2026-07-20)

### CI

- **release:** scope desktop signing to publish env + guard signed output ([b5fdc2b](https://github.com/appliance-sh/appliance.sh/commit/b5fdc2b))

### ❤️ Thank You

- Eliot Lim

## 1.53.0 (2026-07-20)

### Features

- improve documentation and user journeys ([80bcc6f](https://github.com/appliance-sh/appliance.sh/commit/80bcc6f))
- **app:** start machine recovery ([57e1502](https://github.com/appliance-sh/appliance.sh/commit/57e1502))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.52.0 (2026-07-17)

### Features

- microvm for windows ([dfcbe3c](https://github.com/appliance-sh/appliance.sh/commit/dfcbe3c))
- improvements to ui and ux ([35be0ea](https://github.com/appliance-sh/appliance.sh/commit/35be0ea))
- appliance stack and replica improvements ([d36d6f3](https://github.com/appliance-sh/appliance.sh/commit/d36d6f3))
- improved server ergonomics ([21230c2](https://github.com/appliance-sh/appliance.sh/commit/21230c2))
- improve microvm management ([50a400e](https://github.com/appliance-sh/appliance.sh/commit/50a400e))
- consolidate microvm runtime ([3a5208b](https://github.com/appliance-sh/appliance.sh/commit/3a5208b))
- microvm based builds ([4c9c96e](https://github.com/appliance-sh/appliance.sh/commit/4c9c96e))
- improve dx and cli ([c67f933](https://github.com/appliance-sh/appliance.sh/commit/c67f933))
- **desktop:** self-heal microVM credentials on auth failure ([#59](https://github.com/appliance-sh/appliance.sh/pull/59))
- **examples:** three tier demo ([b3df26a](https://github.com/appliance-sh/appliance.sh/commit/b3df26a))
- **vm:** engine-owned credential mint at bring-up ([#60](https://github.com/appliance-sh/appliance.sh/pull/60))

### Bug Fixes

- **ci:** publish api-server guest binaries + console bundle in CLI release ([5e88cbd](https://github.com/appliance-sh/appliance.sh/commit/5e88cbd))
- **ci:** sync cli lockfile + allow dead_code on stop_request ([#62](https://github.com/appliance-sh/appliance.sh/pull/62))
- **cli:** route server self-invocation through subcommand under bun binary ([f0daa1c](https://github.com/appliance-sh/appliance.sh/commit/f0daa1c))
- **vm:** stop the api-server manifest heredoc from executing the binary ([422020c](https://github.com/appliance-sh/appliance.sh/commit/422020c))

### Chores

- **lint:** exclude examples from eslint ([c9a223a](https://github.com/appliance-sh/appliance.sh/commit/c9a223a))

### ❤️ Thank You

- Eliot Lim @eliotlim

## Unreleased

### ⚠️ Breaking Changes — the Docker-free, one-VM overhaul

- **Docker is no longer used anywhere.** The CLI never runs `docker`/`buildctl`/`crane`; app images build **server-side** (in-VM BuildKit locally, the installation's builder on cloud) from an uploaded source zip. `framework` apps get a generated Dockerfile and are now first-class on every base; `container` zips carry the build context (Dockerfile + source), not an `image.tar` (legacy image.tar zips still deploy on cloud).
- **The api-server runs as a guest binary inside the microVM** — no more host daemon (`appliance server start` is a deprecation shim → `appliance dev` / `appliance vm`) and no more in-cluster api-server pod/image delivery at `vm up`. Credentials mint from the VM's bootstrap token automatically.
- **One managed VM.** The separate agent-sandbox VM (`appliance-sbx`) merged into the `appliance` VM; `up`/`agent`/`dev` share it. Reclaim the old sandbox's disk with `appliance vm delete appliance-sbx`.
- **Profiles:** the local profile is now `local` (owned by the VM); the legacy `microvm` name is dual-written for one release.
- **Removed/deprecated commands:** `appliance local` (deleted), `server --runtime docker` and `dev --runtime` (removed — the host-Docker runtime `appliance-base-docker` is deprecated and deploys against it error with migration guidance), `profile` (use `cluster`). New: `appliance cloud bootstrap|teardown` umbrella; bare `appliance deploy` in a stack folder deploys the whole stack.
- **Helper binaries:** docker/crane/buildctl providers removed (kubectl remains); `doctor` no longer checks Docker.
- **The desktop deploy wizard builds server-side too.** It now mints a build, packages + uploads the source through the bundled CLI (`appliance build --upload-url`, byte-identical to a terminal `appliance deploy`), and lets the api-server build the image — the host-Docker build/push path (`build_and_import_image`, crane fallback) is removed. Framework apps deploy from the wizard with no Dockerfile.
- **Desktop registers the local VM cluster as "Dev Machine"** (was "MicroVM Runtime"); previously persisted entries are relabeled in place.

### Bug Fixes

- **cli(windows):** the compiled binary parsed its own embedded entry (`B:/~BUN/...`) as the command — every invocation failed with "Unknown command"; and `.localhost` URLs (the VM's api-server + app ingress) could not connect because Bun's resolver only tries `::1` while the VM forwards listen on `127.0.0.1`. Both fixed; `ensureLocalhostFetch()` now covers the Bun runtime.

## 1.51.2 (2026-07-04)

### Bug Fixes

- **build:** build the CLI + workspace deps before the desktop bundles them ([75761fe](https://github.com/appliance-sh/appliance.sh/commit/75761fe))

### ❤️ Thank You

- Eliot Lim

## 1.51.1 (2026-07-04)

### Bug Fixes

- **cli:** auto-pull published api-server image when local build is wrong arch ([2fc35e1](https://github.com/appliance-sh/appliance.sh/commit/2fc35e1))

### ❤️ Thank You

- Eliot Lim

## 1.51.0 (2026-07-04)

### Features

- **cli:** forget clusters without teardown ([df0a92c](https://github.com/appliance-sh/appliance.sh/commit/df0a92c))

### Bug Fixes

- **infra:** update tsbuildinfo location ([82232a4](https://github.com/appliance-sh/appliance.sh/commit/82232a4))

### ❤️ Thank You

- Eliot Lim

## 1.50.0 (2026-07-01)

### Features

- dev environments and shell inside microVMs ([8573c00](https://github.com/appliance-sh/appliance.sh/commit/8573c00))
- share a host folder into the dev microVM over VirtioFS ([f77d496](https://github.com/appliance-sh/appliance.sh/commit/f77d496))
- k3s-independent shell over vsock ([4a65547](https://github.com/appliance-sh/appliance.sh/commit/4a65547))
- microVM container sandbox — appliance up + clock-sync 401 fix ([#48](https://github.com/appliance-sh/appliance.sh/pull/48))
- Phase 4 — microVM default runtime, non-root guest, unified control plane, reattachable shells, one-tap onboarding ([#50](https://github.com/appliance-sh/appliance.sh/pull/50))
- support for appliance cluster destruction ([b09cbaf](https://github.com/appliance-sh/appliance.sh/commit/b09cbaf))
- **vm:** surface microVM bring-up phases; distinguish VM running from cluster ready ([#47](https://github.com/appliance-sh/appliance.sh/pull/47))

### Bug Fixes

- update package with tauri build scripts ([15123a1](https://github.com/appliance-sh/appliance.sh/commit/15123a1))
- detect and handle argv indexing ([08a9e3e](https://github.com/appliance-sh/appliance.sh/commit/08a9e3e))
- **desktop:** refresh the managed microVM engine when stale, not just missing ([5169ce1](https://github.com/appliance-sh/appliance.sh/commit/5169ce1))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.49.0 (2026-06-17)

### Features

- microvm fleet lifecycle ([#45](https://github.com/appliance-sh/appliance.sh/pull/45))

### Bug Fixes

- dev env and microvm ux ([#44](https://github.com/appliance-sh/appliance.sh/pull/44))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.48.0 (2026-06-13)

### Features

- improve micro vm cluster switcher and interface ([3d7bf25](https://github.com/appliance-sh/appliance.sh/commit/3d7bf25))
- **cli:** thread per-VM ports and profiles through `appliance vm` ([0530dc2](https://github.com/appliance-sh/appliance.sh/commit/0530dc2))
- **desktop:** live egress traffic view with per-host allow/block ([32280e2](https://github.com/appliance-sh/appliance.sh/commit/32280e2))
- **desktop:** credential capture/injection config UI ([6b0f82c](https://github.com/appliance-sh/appliance.sh/commit/6b0f82c))
- **desktop:** manage multiple microVMs, each as its own cluster ([c72846a](https://github.com/appliance-sh/appliance.sh/commit/c72846a))
- **desktop:** offer the microVM engine in first-run onboarding ([759ed61](https://github.com/appliance-sh/appliance.sh/commit/759ed61))
- **vm:** trust the egress CA in the guest system store ([2119afb](https://github.com/appliance-sh/appliance.sh/commit/2119afb))
- **vm:** record egress traffic for the desktop view ([0910abb](https://github.com/appliance-sh/appliance.sh/commit/0910abb))
- **vm:** per-host credential capture + injection in the MITM proxy ([967317f](https://github.com/appliance-sh/appliance.sh/commit/967317f))
- **vm:** per-VM port allocation so multiple microVMs run concurrently ([485ca2a](https://github.com/appliance-sh/appliance.sh/commit/485ca2a))

### Bug Fixes

- **desktop:** refresh cluster list when the microVM registers ([4a20709](https://github.com/appliance-sh/appliance.sh/commit/4a20709))
- **desktop:** present microVMs as first-class engines, not beta add-ons ([917ea5a](https://github.com/appliance-sh/appliance.sh/commit/917ea5a))

### Documentation

- **microvm:** document automatic egress injection into workloads ([b90ed3d](https://github.com/appliance-sh/appliance.sh/commit/b90ed3d))
- **microvm:** document egress traffic view + credential injection ([df9f3f3](https://github.com/appliance-sh/appliance.sh/commit/df9f3f3))
- **vm:** document running multiple microVMs concurrently ([6854f1b](https://github.com/appliance-sh/appliance.sh/commit/6854f1b))

### ❤️ Thank You

- Eliot Lim

## 1.47.0 (2026-06-12)

### Features

- **api-server:** inject egress proxy + CA into local workloads ([452aaff](https://github.com/appliance-sh/appliance.sh/commit/452aaff))
- **desktop:** build and copy vm image ([a675280](https://github.com/appliance-sh/appliance.sh/commit/a675280))
- **vm:** improve installation experience ([a9eb457](https://github.com/appliance-sh/appliance.sh/commit/a9eb457))
- **vm:** improve installation experience ([58c9394](https://github.com/appliance-sh/appliance.sh/commit/58c9394))
- **vm:** shell into local runtimes + egress control with TLS interception ([e796cb9](https://github.com/appliance-sh/appliance.sh/commit/e796cb9))
- **vm:** publish egress policy to the cluster for api-server injection ([95b5d50](https://github.com/appliance-sh/appliance.sh/commit/95b5d50))

### Bug Fixes

- **desktop:** local runtime improvements ([5b9f45b](https://github.com/appliance-sh/appliance.sh/commit/5b9f45b))

### ❤️ Thank You

- Eliot Lim

## 1.46.0 (2026-06-11)

### Features

- sandboxed ts manifests ([74f9b61](https://github.com/appliance-sh/appliance.sh/commit/74f9b61))
- k8s support for api-server ([ae848f4](https://github.com/appliance-sh/appliance.sh/commit/ae848f4))
- enable k8s deployment ([#43](https://github.com/appliance-sh/appliance.sh/pull/43))
- docker cluster bootstrap support ([555c2be](https://github.com/appliance-sh/appliance.sh/commit/555c2be))
- headless local runtime — CLI-managed k3d cluster with cloud-parity deploys ([fabd6ff](https://github.com/appliance-sh/appliance.sh/commit/fabd6ff))
- ui improvements ([169af36](https://github.com/appliance-sh/appliance.sh/commit/169af36))
- **app:** Vercel-style interface — project-grid overview, live URLs, white-primary design language ([c2d2f69](https://github.com/appliance-sh/appliance.sh/commit/c2d2f69))
- **desktop:** manage the microVM engine from the desktop shell ([ee99c88](https://github.com/appliance-sh/appliance.sh/commit/ee99c88))
- **infra:** appliance.localhost routing ([68762c3](https://github.com/appliance-sh/appliance.sh/commit/68762c3))
- **vmm:** appliance-vmm — microVM manager with a working macOS backend ([43f1bbc](https://github.com/appliance-sh/appliance.sh/commit/43f1bbc))
- **vmm:** k3s guest — kubernetes microVM with appliance.localhost ingress ([158766f](https://github.com/appliance-sh/appliance.sh/commit/158766f))
- **vmm:** appliance deploy parity on the microVM engine ([7b09105](https://github.com/appliance-sh/appliance.sh/commit/7b09105))

### Bug Fixes

- **app:** make the web console a working first-class surface ([ca61b17](https://github.com/appliance-sh/appliance.sh/commit/ca61b17))
- **app:** audit desktop-only pages via a browser-runnable mock host ([c256ff8](https://github.com/appliance-sh/appliance.sh/commit/c256ff8))
- **desktop:** deploy wizard routes images by the selected cluster's registry ([4926ea4](https://github.com/appliance-sh/appliance.sh/commit/4926ea4))
- **dx:** platform-mismatch warning, Runtimes naming, vm kubeconfig command ([a636457](https://github.com/appliance-sh/appliance.sh/commit/a636457))
- **vmm:** capture the host process's output in host.log; name port conflicts ([9e2bf92](https://github.com/appliance-sh/appliance.sh/commit/9e2bf92))

### Documentation

- microVM engine section in ARCHITECTURE ([57efd97](https://github.com/appliance-sh/appliance.sh/commit/57efd97))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.45.1 (2026-05-27)

### Bug Fixes

- **desktop:** ensure user binary paths load ([cd0a7d4](https://github.com/appliance-sh/appliance.sh/commit/cd0a7d4))

### ❤️ Thank You

- Eliot Lim

## 1.45.0 (2026-05-27)

### Features

- **helper:** check for container runtime ([ab8839f](https://github.com/appliance-sh/appliance.sh/commit/ab8839f))

### ❤️ Thank You

- Eliot Lim

## 1.44.1 (2026-05-27)

### Bug Fixes

- **ci:** cli release ([7d2b102](https://github.com/appliance-sh/appliance.sh/commit/7d2b102))

### ❤️ Thank You

- Eliot Lim

## 1.44.0 (2026-05-27)

### Features

- **cli:** binary distribution ([c92d140](https://github.com/appliance-sh/appliance.sh/commit/c92d140))

### ❤️ Thank You

- Eliot Lim

## 1.43.0 (2026-05-27)

### Features

- **cli,desktop:** improved cli bundling ([4112800](https://github.com/appliance-sh/appliance.sh/commit/4112800))
- **helper:** setup and dependency management ([bb66bb6](https://github.com/appliance-sh/appliance.sh/commit/bb66bb6))

### ❤️ Thank You

- Eliot Lim

## 1.42.0 (2026-05-27)

### Features

- improve dx for deploy and management ([4bfd2cb](https://github.com/appliance-sh/appliance.sh/commit/4bfd2cb))
- improve environment url handling ([7154d11](https://github.com/appliance-sh/appliance.sh/commit/7154d11))

### ❤️ Thank You

- Eliot Lim

## 1.41.0 (2026-05-25)

### Features

- **app:** desktop deployment flow prototype ([819586e](https://github.com/appliance-sh/appliance.sh/commit/819586e))

### Bug Fixes

- **app:** better deploy and destroy state management ([8f9b655](https://github.com/appliance-sh/appliance.sh/commit/8f9b655))

### Chores

- gitignore non-example env files ([b82b50f](https://github.com/appliance-sh/appliance.sh/commit/b82b50f))

### ❤️ Thank You

- Eliot Lim

## 1.40.1 (2026-05-25)

### Bug Fixes

- **desktop:** adopt externally-launched local api-server ([#42](https://github.com/appliance-sh/appliance.sh/pull/42))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.40.0 (2026-05-24)

### Features

- add k3 support ([#41](https://github.com/appliance-sh/appliance.sh/pull/41))
- **bootstrap:** agnostic aws profile ([8465985](https://github.com/appliance-sh/appliance.sh/commit/8465985))
- **bootstrap:** improved baseline ([#40](https://github.com/appliance-sh/appliance.sh/pull/40))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.39.0 (2026-05-10)

### Features

- **bootstrap:** improve update mechanism ([b10279f](https://github.com/appliance-sh/appliance.sh/commit/b10279f))
- **bootstrap:** improve state promotion mechanism ([1471516](https://github.com/appliance-sh/appliance.sh/commit/1471516))

### ❤️ Thank You

- Eliot Lim

## 1.38.0 (2026-05-06)

### Features

- **api-server,bootstrap,desktop:** self-updating ([3f45d8f](https://github.com/appliance-sh/appliance.sh/commit/3f45d8f))
- **bootstrap:** improved container port management ([92f0767](https://github.com/appliance-sh/appliance.sh/commit/92f0767))
- **bootstrap:** state promotion ([a730d8d](https://github.com/appliance-sh/appliance.sh/commit/a730d8d))
- **desktop:** state promotion and detach ([0807a5e](https://github.com/appliance-sh/appliance.sh/commit/0807a5e))

### Bug Fixes

- **ci:** release triggers image build ([cc2b93a](https://github.com/appliance-sh/appliance.sh/commit/cc2b93a))

### ❤️ Thank You

- Eliot Lim

## 1.37.0 (2026-05-05)

### Features

- **bootstrap:** phased bootstrap retry ([293bca4](https://github.com/appliance-sh/appliance.sh/commit/293bca4))

### Bug Fixes

- **api-server:** host binding improvements ([fcb36de](https://github.com/appliance-sh/appliance.sh/commit/fcb36de))

### ❤️ Thank You

- Eliot Lim

## 1.36.1 (2026-05-04)

### Bug Fixes

- **cli:** add typescript devDependency ([4ed42a8](https://github.com/appliance-sh/appliance.sh/commit/4ed42a8))

### ❤️ Thank You

- Eliot Lim

## 1.36.0 (2026-05-03)

### Features

- **bootstrap:** base config handoff ([e74d3de](https://github.com/appliance-sh/appliance.sh/commit/e74d3de))
- **bootstrap:** better arch handling ([c0ebbeb](https://github.com/appliance-sh/appliance.sh/commit/c0ebbeb))

### ❤️ Thank You

- Eliot Lim

## 1.35.0 (2026-04-30)

### Features

- **bootstrap:** improve tag handling ([9eb5801](https://github.com/appliance-sh/appliance.sh/commit/9eb5801))

### ❤️ Thank You

- Eliot Lim

## 1.34.0 (2026-04-30)

### Features

- **api-server:** handle image arch ([92c0f9e](https://github.com/appliance-sh/appliance.sh/commit/92c0f9e))

### ❤️ Thank You

- Eliot Lim

## 1.33.1 (2026-04-30)

### Bug Fixes

- **bootstrap:** sequential worker and server deployment ([d0cad49](https://github.com/appliance-sh/appliance.sh/commit/d0cad49))

### ❤️ Thank You

- Eliot Lim

## 1.33.0 (2026-04-29)

### Features

- **infra:** enable awskms ([2401e62](https://github.com/appliance-sh/appliance.sh/commit/2401e62))

### Bug Fixes

- **infra:** symlink pulumi plugin files directly ([29a66e6](https://github.com/appliance-sh/appliance.sh/commit/29a66e6))

### ❤️ Thank You

- Eliot Lim

## 1.32.6 (2026-04-29)

### Bug Fixes

- **ci:** update container image build 7 ([974f25d](https://github.com/appliance-sh/appliance.sh/commit/974f25d))

### ❤️ Thank You

- Eliot Lim

## 1.32.5 (2026-04-29)

### Bug Fixes

- **ci:** update container image build 6 ([81c6762](https://github.com/appliance-sh/appliance.sh/commit/81c6762))

### ❤️ Thank You

- Eliot Lim

## 1.32.4 (2026-04-29)

### Bug Fixes

- **ci:** update container image build 5 ([cd5388f](https://github.com/appliance-sh/appliance.sh/commit/cd5388f))

### ❤️ Thank You

- Eliot Lim

## 1.32.3 (2026-04-29)

### Bug Fixes

- **ci:** update container image build 4 ([53633ea](https://github.com/appliance-sh/appliance.sh/commit/53633ea))

### ❤️ Thank You

- Eliot Lim

## 1.32.2 (2026-04-29)

### Bug Fixes

- **ci:** update container image build 3 ([65882e2](https://github.com/appliance-sh/appliance.sh/commit/65882e2))

### ❤️ Thank You

- Eliot Lim

## 1.32.1 (2026-04-29)

### Bug Fixes

- **ci:** update container image build 2 ([83de774](https://github.com/appliance-sh/appliance.sh/commit/83de774))

### ❤️ Thank You

- Eliot Lim

## 1.32.0 (2026-04-28)

### Features

- **bootstrap,desktop:** aws profile support ([ddb2825](https://github.com/appliance-sh/appliance.sh/commit/ddb2825))
- **ci:** matrix api-server build ([87f2842](https://github.com/appliance-sh/appliance.sh/commit/87f2842))
- **cli:** teardown support ([0e41b42](https://github.com/appliance-sh/appliance.sh/commit/0e41b42))

### Bug Fixes

- **all:** pin pulumi and node versions ([22fecbd](https://github.com/appliance-sh/appliance.sh/commit/22fecbd))
- **ci:** set node to v24.14.1 ([656950e](https://github.com/appliance-sh/appliance.sh/commit/656950e))
- **ci:** update pnpm lockfile ([c74ceb6](https://github.com/appliance-sh/appliance.sh/commit/c74ceb6))
- **infra:** unique lambda oac naming ([469b65a](https://github.com/appliance-sh/appliance.sh/commit/469b65a))
- **infra:** lambda functionurl region ([98c0dcd](https://github.com/appliance-sh/appliance.sh/commit/98c0dcd))

### ❤️ Thank You

- Eliot Lim

## 1.31.0 (2026-04-28)

### Features

- **api-server,bootstrap,infra:** bootstrap support ([2aa9f1f](https://github.com/appliance-sh/appliance.sh/commit/2aa9f1f))
- **app,desktop,console:** multi-cluster host ([c446e8f](https://github.com/appliance-sh/appliance.sh/commit/c446e8f))

### Bug Fixes

- **api-server,bootstrap,infra:** build and runtime manifest routing ([a429bc7](https://github.com/appliance-sh/appliance.sh/commit/a429bc7))

### ❤️ Thank You

- Eliot Lim

## 1.30.0 (2026-04-27)

### Features

- **api-server:** improved env handling ([3ccfc6a](https://github.com/appliance-sh/appliance.sh/commit/3ccfc6a))
- **api-server:** support for cancellation and refresh ([d88e508](https://github.com/appliance-sh/appliance.sh/commit/d88e508))
- **cli,sdk,api-server:** support for env and dynamic manifests ([0ef56c7](https://github.com/appliance-sh/appliance.sh/commit/0ef56c7))

### Bug Fixes

- **infra:** querystring canonicalisation ([8888d31](https://github.com/appliance-sh/appliance.sh/commit/8888d31))

### ❤️ Thank You

- Eliot Lim

## 1.29.0 (2026-04-22)

### Features

- **api-server:** support for remote build uris ([b85cd83](https://github.com/appliance-sh/appliance.sh/commit/b85cd83))

### ❤️ Thank You

- Eliot Lim

## 1.28.1 (2026-04-22)

### Bug Fixes

- **ci:** image version resolution ([cb080d5](https://github.com/appliance-sh/appliance.sh/commit/cb080d5))

### ❤️ Thank You

- Eliot Lim

## 1.28.0 (2026-04-20)

### Features

- **api-server:** image build ([7439dae](https://github.com/appliance-sh/appliance.sh/commit/7439dae))
- **console:** improved project environment ux ([51b7dba](https://github.com/appliance-sh/appliance.sh/commit/51b7dba))
- **desktop,sdk,api-server:** introduce appliance desktop ([ef8fb3b](https://github.com/appliance-sh/appliance.sh/commit/ef8fb3b))

### ❤️ Thank You

- Eliot Lim

## 1.27.3 (2026-04-15)

### Bug Fixes

- **api-server:** improve integration ([d3a362a](https://github.com/appliance-sh/appliance.sh/commit/d3a362a))

### ❤️ Thank You

- Eliot Lim

## 1.27.2 (2026-04-14)

### Bug Fixes

- **api:** dispatch worker ([#39](https://github.com/appliance-sh/appliance.sh/pull/39))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.27.1 (2026-04-06)

### Bug Fixes

- **api-server:** host derivation ([a9feb68](https://github.com/appliance-sh/appliance.sh/commit/a9feb68))
- **cli:** use execFileSync ([9099c92](https://github.com/appliance-sh/appliance.sh/commit/9099c92))

### ❤️ Thank You

- Eliot Lim

## 1.27.0 (2026-04-04)

### Features

- **api-server:** switch to crane ([c8d098b](https://github.com/appliance-sh/appliance.sh/commit/c8d098b))

### ❤️ Thank You

- Eliot Lim

## 1.26.3 (2026-04-02)

### Bug Fixes

- **ci:** setup npm trusted publisher ([abb9a11](https://github.com/appliance-sh/appliance.sh/commit/abb9a11))

### Chores

- remove extraneous appliance manifest ([4d95c6a](https://github.com/appliance-sh/appliance.sh/commit/4d95c6a))

### ❤️ Thank You

- Eliot Lim

## 1.26.2 (2026-04-01)

### Bug Fixes

- **api-server:** build and container config ([1e6c161](https://github.com/appliance-sh/appliance.sh/commit/1e6c161))
- **ci:** build and nx targets ([6d525b3](https://github.com/appliance-sh/appliance.sh/commit/6d525b3))
- **ci:** better change detection ([be67e04](https://github.com/appliance-sh/appliance.sh/commit/be67e04))

### ❤️ Thank You

- Eliot Lim

## 1.26.1 (2026-03-23)

### 🩹 Fixes

- **sdk:** types for node ([58fd037](https://github.com/appliance-sh/appliance.sh/commit/58fd037))
- **sdk:** build fixes ([b5e8902](https://github.com/appliance-sh/appliance.sh/commit/b5e8902))

### ❤️ Thank You

- Eliot Lim

## 1.26.0 (2026-03-16)

### 🚀 Features

- **api-server:** support presigned url builds ([27009d4](https://github.com/appliance-sh/appliance.sh/commit/27009d4))
- **cli:** support memory and timeout ([523f749](https://github.com/appliance-sh/appliance.sh/commit/523f749))

### 🩹 Fixes

- **api-server:** trust proxy behaviour ([6127e55](https://github.com/appliance-sh/appliance.sh/commit/6127e55))

### ❤️ Thank You

- Eliot Lim

## 1.25.0 (2026-03-16)

### 🚀 Features

- **api-server:** improve logging ([048c5e5](https://github.com/appliance-sh/appliance.sh/commit/048c5e5))
- **cli:** support for APPLIANCE_API_URL env var override ([24aa53e](https://github.com/appliance-sh/appliance.sh/commit/24aa53e))

### ❤️ Thank You

- Eliot Lim

## 1.24.0 (2026-03-16)

### 🚀 Features

- **cli:** environment variables and deployment ([1d85cfb](https://github.com/appliance-sh/appliance.sh/commit/1d85cfb))

### ❤️ Thank You

- Eliot Lim

## 1.23.0 (2026-03-15)

### 🚀 Features

- **cli:** improved documentation and app commands ([e44ac41](https://github.com/appliance-sh/appliance.sh/commit/e44ac41))

### ❤️ Thank You

- Eliot Lim

## 1.22.1 (2026-03-11)

### 🩹 Fixes

- use execFileSync and other improvements ([de20aa7](https://github.com/appliance-sh/appliance.sh/commit/de20aa7))

### ❤️ Thank You

- Eliot Lim

## 1.22.0 (2026-03-11)

### 🚀 Features

- improve build process ([e380d2d](https://github.com/appliance-sh/appliance.sh/commit/e380d2d))

### ❤️ Thank You

- Eliot Lim

## 1.21.0 (2026-03-11)

### 🚀 Features

- framework support for python and platform ([b349b1a](https://github.com/appliance-sh/appliance.sh/commit/b349b1a))

### ❤️ Thank You

- Eliot Lim

## 1.20.0 (2026-03-10)

### 🚀 Features

- **api-server:** deploy poc ([#37](https://github.com/appliance-sh/appliance.sh/pull/37))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.19.1 (2026-03-10)

### 🩹 Fixes

- **sdk:** remove baseConfig from environment ([1d9edfc](https://github.com/appliance-sh/appliance.sh/commit/1d9edfc))

### ❤️ Thank You

- Eliot Lim

## 1.19.0 (2026-03-09)

### 🚀 Features

- **api-server:** remove test infra endpoints ([60bf461](https://github.com/appliance-sh/appliance.sh/commit/60bf461))
- **sdk:** prefixed uuidv7 identifiers ([9236019](https://github.com/appliance-sh/appliance.sh/commit/9236019))

### ❤️ Thank You

- Eliot Lim

## 1.18.0 (2026-03-09)

### 🚀 Features

- project environment deployment ([#36](https://github.com/appliance-sh/appliance.sh/pull/36))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.17.0 (2026-01-19)

### 🚀 Features

- **infra:** absorb pulumi dependencies ([#35](https://github.com/appliance-sh/appliance.sh/pull/35))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.16.1 (2026-01-18)

### 🩹 Fixes

- **ci:** add npm dev setup script to infra ([#34](https://github.com/appliance-sh/appliance.sh/pull/34))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.16.0 (2026-01-18)

### 🚀 Features

- **api-server:** hoist ApplianceStack to infra ([#33](https://github.com/appliance-sh/appliance.sh/pull/33))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.15.0 (2026-01-18)

### 🚀 Features

- **api-server:** switch to express ([#32](https://github.com/appliance-sh/appliance.sh/pull/32))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.14.0 (2026-01-14)

### 🚀 Features

- **api-server:** create cloudfront distribution and invocation mechanism ([#31](https://github.com/appliance-sh/appliance.sh/pull/31))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.13.0 (2026-01-03)

### 🚀 Features

- **infra:** state and params ([#30](https://github.com/appliance-sh/appliance.sh/pull/30))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.12.1 (2026-01-03)

### 🩹 Fixes

- **infra:** update ApplianceBaseAwsVpcInput type ([#29](https://github.com/appliance-sh/appliance.sh/pull/29))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.12.0 (2026-01-01)

### 🚀 Features

- **infra:** working cloudfront poc ([#28](https://github.com/appliance-sh/appliance.sh/pull/28))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.11.1 (2025-12-30)

### 🩹 Fixes

- **ci:** update infra repository url ([#27](https://github.com/appliance-sh/appliance.sh/pull/27))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.11.0 (2025-12-29)

### 🚀 Features

- **infra:** appliance base poc 1 ([#26](https://github.com/appliance-sh/appliance.sh/pull/26))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.10.0 (2025-12-28)

### 🚀 Features

- **cli:** appliance configure 2 ([#25](https://github.com/appliance-sh/appliance.sh/pull/25))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.9.0 (2025-12-22)

### 🚀 Features

- **cli:** appliance configure 1 ([#24](https://github.com/appliance-sh/appliance.sh/pull/24))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.8.0 (2025-12-22)

### 🚀 Features

- working functionurl poc ([#23](https://github.com/appliance-sh/appliance.sh/pull/23))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.7.0 (2025-12-21)

### 🚀 Features

- switch to pulumi ([#22](https://github.com/appliance-sh/appliance.sh/pull/22))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.6.0 (2025-12-21)

### 🚀 Features

- add cloudfront and nestjs proof of concept ([#21](https://github.com/appliance-sh/appliance.sh/pull/21))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.5.0 (2025-12-15)

### 🚀 Features

- add cdk experimental stacks ([#8](https://github.com/appliance-sh/appliance.sh/pull/8))
- **api-server:** init nest project ([#7](https://github.com/appliance-sh/appliance.sh/pull/7))

### 🩹 Fixes

- nx workspaces and packages ([#9](https://github.com/appliance-sh/appliance.sh/pull/9))
- nx release ci ([#10](https://github.com/appliance-sh/appliance.sh/pull/10))
- nx release ci again ([#11](https://github.com/appliance-sh/appliance.sh/pull/11))
- release npm ([#12](https://github.com/appliance-sh/appliance.sh/pull/12))
- release node setup ([#13](https://github.com/appliance-sh/appliance.sh/pull/13))
- npm package public ([#14](https://github.com/appliance-sh/appliance.sh/pull/14))
- npm package public again ([#15](https://github.com/appliance-sh/appliance.sh/pull/15))
- nx release groups ([#16](https://github.com/appliance-sh/appliance.sh/pull/16))
- nx release projects ([#17](https://github.com/appliance-sh/appliance.sh/pull/17))
- package repository url ([#18](https://github.com/appliance-sh/appliance.sh/pull/18))
- package repository url again ([#19](https://github.com/appliance-sh/appliance.sh/pull/19))
- nx workspace changelog ([#20](https://github.com/appliance-sh/appliance.sh/pull/20))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.4.0 (2025-12-01)

### 🚀 Features

- **api-aws:** add ecr test ([#5](https://github.com/appliance-sh/appliance/pull/5))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.3.0 (2025-12-01)

### 🚀 Features

- **sdk:** add appliance manifest types ([#4](https://github.com/appliance-sh/appliance/pull/4))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.2.0 (2025-09-13)

### 🚀 Features

- enable semantic-release-monorepo ([937331f](https://github.com/appliance-sh/appliance/commit/937331f))
- improved postbuild script ([23fff01](https://github.com/appliance-sh/appliance/commit/23fff01))
- **all:** use nx release ([#2](https://github.com/appliance-sh/appliance/pull/2))
- **cli:** add appliance configure command ([828f45a](https://github.com/appliance-sh/appliance/commit/828f45a))

### 🩹 Fixes

- update pr build command ([9fb873b](https://github.com/appliance-sh/appliance/commit/9fb873b))
- move semantic-release-monorepo to devDependencies ([7dffe4d](https://github.com/appliance-sh/appliance/commit/7dffe4d))
- tsconfig rootDir ([ed088c4](https://github.com/appliance-sh/appliance/commit/ed088c4))
- ignore dist directories when linting ([54ab0fd](https://github.com/appliance-sh/appliance/commit/54ab0fd))
- add release script to subpackages ([3bdd30a](https://github.com/appliance-sh/appliance/commit/3bdd30a))
- update dependencies ([577726d](https://github.com/appliance-sh/appliance/commit/577726d))
- **ci:** git identity ([#3](https://github.com/appliance-sh/appliance/pull/3))

### ❤️ Thank You

- Eliot Lim @eliotlim
