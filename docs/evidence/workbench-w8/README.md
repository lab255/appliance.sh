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
