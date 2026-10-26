# GLA-282 — immediacy evidence

Baseline: main cafd493. After: 1ebc2b9. Only feature file changed: packages/app/src/pages/machine/egress-panel.tsx.

Desktop mock host, developer-mode, default appliance sandbox, Egress tab; 1280×900, DPR 1, normal motion, Chromium headless 1223 on macOS. Both captures rebuild the app package. After capture restarts Vite with --force. Fresh browser page/state for each capture; panel scrolled to the top in both.

GIF timeline (real screenshot intervals, approximately 14 fps): rest → hover at 0.4 s → pointer down at 1.0 s → release/click at 1.5 s → policy result. The target is the first Blocked requests Allow action (pkgs.example.test:443). GIFs show state/layout; frame timing comes from the separate JSON measurements, not GIF playback.

Measurement: after a settled hover, real Playwright mouse.down triggers a pointerdown listener. Twelve consecutive requestAnimationFrame callbacks sample computed background, color, translate, opacity and transition. One trial per control per revision, no screenshots during measurement. JSON milliseconds are callback offsets from pointerdown, not photon latency.

- Row before: hover and press both rgb(36,36,36); no distinct pressed feedback across 12 frames / 175.1 ms.
- Row after: hover rgb(26,26,26), press rgb(36,36,36) at the first sampled frame (0.3 ms callback offset), transition-property none. Estimate: ready for the next ~16.7 ms frame at 60 Hz, not a measured physical display latency.
- Shared policy Button: CSS translate 0px 1px at first sampled frame before (0.4 ms) and after (0.5 ms); unchanged, already immediate. Its transition lists transform, not translate.
- Seven raw-button recipe sites now scope transitions off only during :active. Five row-action recipe sites use the named hover token. Zero decorative motion added; zero global transition rules removed.
- Terminal: no transitions or debounce on the terminal critical path (code audit at cafd493); live-pane frame measurements blocked — mock host has no terminal fixture; rAF attachment timing unverified. Frames-to-content before/after: unavailable, not zero.

Decisions: retain terminal code, shared Button movement/focus/hover recipes, input focus token timing, noninteractive row stillness, server-confirmed policy updates, busy/disabled behavior, 4 s feed and 15 s policy polling, throttled live announcements, and the 5 s clear/undo delay. These preserve semantics, accessible feedback, and safety rather than adding cosmetic motion. Preserve global token durations and registry files. No conflict with the recorded Fluid Functionalism decisions is introduced; hover easing remains.

Follow-up: mock-host terminal fixture so immediacy claims are measurable.

Verification: foreground pnpm verify on final source is GREEN with filesystem access; 11 builds, 6 typechecks, lint/token checks, TS 1,391 passed / 1 skipped, Rust 362 passed / 1 ignored, all three crates build/test/clippy. Initial sandboxed baseline failed ten fixture tests: egress::tests::{brokered_injection_requires_exact_lease_peer,netstack_policy_forces_deny_and_bakes_allowlist,peer_guard_pins_exact_guest_ip_when_known,peer_guard_uses_recorded_wsl_prefix_before_exact_lease,proxy_keeps_vz_on_persisted_policy_without_the_netstack_baked_allowlist,proxy_url_prefers_the_recorded_gateway}; netstack::guard::tests::{denied_flow_is_dropped_and_logged,unavailable_runtime_ca_aborts_and_logs_fail_closed}; traffic::tests::{records_path_for_intercepted,tail_limits_and_parses}. All pass in the final run.
