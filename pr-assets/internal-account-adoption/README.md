# Account UI adoption

Synthetic local dev-stub data only; no able credentials or production accounts.

- Before: appliance-internal `40fe4c5` (origin/main before UI adoption).
- After: `ba31898` (`feat/account-ui-adoption`), exact UI kit 1.59.0 / Motion 13.4.4.
- Desktop: 1440 × 960; mobile: 390 × 960. Full-page Chromium screenshots.
- States: `/` with dev stub, `/` with sign-in unconfigured, `/account` empty,
  `/account` with a synthetic device and signed app-permission record.
- Device fixtures are registered and synced through the existing APIs using
  ephemeral Ed25519 keys, rather than mocked account-page HTML.

Browser proof (2026-09-29): sign in through the Development only form; reach
`/account`; copy the displayed shortened key and compare clipboard text with
its full API key ID; observe the copy toast; click Sign out; observe
`POST /api/auth/sign-out` 204, signed-out toast and `/`; revisit `/account`
and confirm redirect to `/`. Reduced-motion rendering passed. No horizontal
overflow at either captured width. No browser page errors during the flow.

Sign-out first obtains `/api/auth/csrf`, then posts the same-origin CSRF header.
The exact manual steps are in the account app README in the implementation PR.
