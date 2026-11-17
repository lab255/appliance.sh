# W8 trust reconciliation

## F3 fixture reconciliation

Guard controls on macOS, Vitest/jsdom: restored the four pre-fix implementation
files from `5172323b` while keeping the new tests. Both new guards failed:
PackageSection continued presenting current without host context, and the real
detail/inspector composition continued presenting current after host-session
removal. Result: 2 failed / 11 passed. With the fix, both surfaces reject missing
or mismatched session and snapshot/baseline evidence. Matching evidence is the
positive control. These are UI reconciliation checks, not live adapter authority
or native keychain evidence. No new UI region, asynchronous action, or automated
Package call is introduced; refresh invalidation shares the existing pending paint.

## Baseline HMAC

macOS host Rust tests: 16 passed, one opt-in Keychain test ignored in the ordinary
suite. Disabling the `authenticate(path, &bytes)?` load guard makes all five new
regressions fail: load, reopen, refresh, preview, and unsigned/relocated captures.
Each first verifies an authentic capture, then changes valid JSON bytes without
changing the tag. Preview keeps current file text but withholds the diff and names
the authentication failure. Reopen preserves the bytes and does not recapture.

The real macOS Keychain test ran separately with `WORKBENCH_KEYCHAIN_TEST=1` and
`--ignored`: sandbox attempt failed on OS keychain storage; elevated rerun passed
1/1. It checks missing-key refusal on reads, creation/persistent retrieval,
authentic bytes, changed bytes, replacement key, and deletion. The test uses a
unique test account and deletes it; it never reads or changes a production key.
