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

## Storage v2 and cache

The persisted payload is explicitly version 2 with base64 file bytes. The original
storage directory and attempt marker are retained so an upgrade cannot silently
capture a new baseline. Old unsigned captures fail authentication; signed v1 and
unknown versions fail with an explicit unsupported-format / rebaseline-unavailable
message. No migration can establish an unsigned old capture's authenticity.

A parsed-snapshot cache retains at most 128 MiB of content and 64 baseline entries;
entries share immutable snapshots via `Arc`. The bound concerns retained file
content, not total process memory. Each hit still reads the current file, reads
the OS key, verifies the HMAC, and matches the authenticated tag. Neither mtime nor
file size substitutes for authentication. Changed signed payloads replace parsed
entries; missing tags, tampering, changed keys and deleted keys cannot reuse them.

### Same-corpus measurements

macOS arm64, Cargo `test` default **unoptimized + debuginfo** profile, warm OS page
cache, three loads per condition. Corpus: 60 files, each exactly 1 MiB of ASCII
`x`, with full byte-content and count assertions. Before: number arrays with HMAC
at `f04853c9`; after: v2 base64 with the same HMAC. Stored bytes exclude the 32-byte
sidecar tag (identical in both). Load time includes filesystem read, HMAC and parse;
cache-hit time includes read and HMAC. Key retrieval uses the isolated Rust test
key, not OS keychain latency. These debug timings do **not** reproduce or compare
directly with the brief's 434 ms measurement.

| Format / read                      | Stored bytes | Median ms | Three samples (ms, sorted)      |
| ---------------------------------- | -----------: | --------: | ------------------------------- |
| v1 JSON arrays, parsed each time   |    251668060 | 15118.068 | 14845.972, 15118.068, 15145.167 |
| v2 base64, cache cleared each time |     83896145 |  4608.754 | 3805.782, 4608.754, 4914.855    |
| v2 base64, parsed cache hit        |     83896145 |  3169.257 | 3155.893, 3169.257, 3182.963    |

Size falls by approximately 66.7%; measured parse-inclusive load by 69.5%.
The nonzero corpus and byte assertions control against accidentally measuring an
empty capture. A separate all-256-byte-values test verifies exact base64 decoding,
compact shape, cache reuse and authenticated replacement. Restoring array encoding,
removing cache reuse, or accepting unknown versions each fails its corresponding
guard. Version rejection is tested separately on load, reopen, refresh and preview.

### Reproduce controls

Install dependencies as in the root README. The runner scrubs checkout, home and
temporary paths **before** writing output. Set `EVIDENCE_DIR` to an output folder
and `WORKBENCH_PROBE` to one of `native`, `storage`, `storage-before`, `keychain`, `f3-defect`,
`hmac-defect`, `keychain-defect`, `encoding-defect`, `cache-defect`, or
`version-defect`, then run:

```sh
WORKBENCH_PROBE=native EVIDENCE_DIR=./probe-output \
python3 docs/evidence/workbench-w8/run-probes.py
```

Run probes sequentially in an isolated checkout: defect controls temporarily edit
implementation files, preserve tests, and restore source in `finally`. A control
only succeeds for an actual failing test; compiler failures do not count.
`keychain` and `keychain-defect` require an unlocked macOS login Keychain and host
permission. They create/delete only a unique test credential, including cleanup
on a failing assertion. `storage` is opt-in because it writes a 60 MiB corpus.

`storage-before` temporarily restores the HMAC-era implementation at `f04853c9`
and injects the same measurement test. Keep that commit available locally (fetch
it by SHA if using a later squash-only checkout). It uses the same Cargo profile,
corpus and assertions as `storage`, without the new cache.

Final targeted controls on macOS: **22 native tests passed**, with the two costly
opt-in tests separately exercised. Authentication bypass: **6 failed**; unknown
version acceptance: **4 failed** (one per read surface); array-encoding restoration:
**1 failed**; cache-reuse removal: **1 failed**. The real Keychain missing-read-key
creation defect: **1 failed**; restored Keychain test: **1 passed**, including cached
loads after key replacement and deletion. Both Keychain runs required elevation;
the original sandbox storage denial remains disclosed above.

A deleted-file preview is a separate authentication guard: when no current file
can be displayed, its error still names the failed baseline authentication and
rebaseline-unavailable status. No generic missing-file error conceals that failure.

The committed `storage-before` runner was also validated in an isolated checkout:
identical 251668060 stored bytes, 22283.788 ms median during concurrent repository
verification. Wall-clock timings on this shared build host vary with contention;
the table reports the initial before/after samples, not an isolated throughput SLA.

## Final verification

`NX_DAEMON=false NX_SKIP_NX_CACHE=true pnpm verify`: **GREEN** on the elevated
rerun, including all 330 VM tests and the required Rust Clippy checks. Per-run
scope: the sandboxed main run reached VM tests (320 passed, 10 failed with the
known host-filesystem EPERM restriction); the full uncached elevated rerun passed.
The final desktop library suite separately passed **83 tests**, with the two
opt-in tests exercised as described above.

Additional strict desktop library/tests Clippy found two existing warnings in
unchanged `src/lib.rs`: `large_enum_variant` at 1410 and
`needless_borrows_for_generic_args` at 3961. With only those known lints allowed,
`-D warnings` passed. No unrelated lint changes are included. Final evidence-only
README appends were formatted after verification; runtime source was unchanged.
