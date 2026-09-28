# UI overlays evidence

Baseline: `origin/feat/ui-motion` (`de4503d`), PR #130.
After: Radix overlays on `feat/ui-overlays`.

Chromium, 760×540, no reduced-motion preference. A temporary gallery imports the
actual before/after ConfirmProvider and ClusterSwitcher with the desktop mock
host's user-mode fixture, production app/kit styles, and a single MotionProvider.
Dialog capture opens then escapes. Menu capture uses ArrowDown to open and
traverse, then Escape. Tooltip capture hovers and leaves; its baseline is a bare
control because there was no tooltip primitive before this change.

The confirm dialog looks identical to #130 by design: same geometry, colors,
200 ms opacity/0.98→1 entry, and 120 ms scrim/exit. Radix owns accessibility and
presence. GIF frame timing follows screenshot timestamps; it is evidence of
appearance/interaction, not a frame-perfect timing benchmark. Automated tests
assert the motion contract and reduced-motion behavior separately.

The popover is demonstrated in the packed-smoke gallery and design-system tests.
