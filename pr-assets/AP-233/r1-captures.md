# AP-233 r1 captures

Source: feat/ap-233-able-native-signin @ 56cbea1. Claim: avery-ap233-fixes-r1.

Captured in the desktop development mock-host harness at 1440 × 1100, with all non-local browser requests blocked. No live able calls, real accounts, or credentials.

| Image | Recipe at /settings?mock-host | Verified state |
| --- | --- | --- |
| settings-waiting.png | &scenario=account-waiting; click Sign in with able | Five-minute waiting text, disabled login button, enabled Cancel sign-in |
| settings-failure.png | &scenario=account-failure; click Sign in with able | Banner tone=error, role=alert, port 43104 and actionable retry guidance |
| settings-revocation-failed.png | &scenario=account-revoke-failed; click Sign out | Signed out plus credentials-erased/upstream-revocation-unconfirmed notice |
| settings-signed-in.png | &scenario=ready; click Sign in with able | Updated “Signed in with able as” wording |

Baseline and signed-out captures from the initial review remain alongside these. Captures belong only to chore/artifacts and must never be merged into main.
