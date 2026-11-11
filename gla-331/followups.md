# Review follow-up records

These are evidence amendments for the Manager’s existing cards, not newly created tracker tickets.

## Shell CLS

Board card **GLA-336 — “Measured shell/installer defects exposed by GLA-331”**. Owner: **Morgan**, opens build epic. Includes cold shell **0.11638** with **+0.01940** branch contribution, user-mode **0.01016 PRODUCT DEFECT**, scenario 11 **0.11723**, and Install first acknowledgment **147.2 / 147.8 ms**.

FAIL, unchanged 0.01 gate. Matched operator `/projects` runs: base 00a0bdd 0.09698362, branch 0.11638035, delta +0.01939672 (10 observations each). Pre-existing mode-resolution nav insertion; Workbench adds one row. Original scenario 9: USER MODE header shift 0.01015608, no Workbench nav. Scenario 11: 0.11723245. See base-cold-comparison.json, scenario-session-windows.json. Carry all figures to the existing cold-shell card. Scenario 9 classification: **PRODUCT DEFECT**. Without mock-host, production createTauriHost with native IPC stubs reproduces 0.01015608 in all 18 base/branch runs, including zero added response delay; the loading header grows 41 to 59 px. See user-shell-classification.json. This is component causal evidence, not a live native-session measurement.

## S3 delayed acceptance

Same board card **GLA-336 — “Measured shell/installer defects exposed by GLA-331”**. Owner: **Morgan**, opens build epic. Carries **S3 0.02164 delayed-acceptance liveness finding**.

FAIL, Continuity: scenario 3’s independent window at t=66526.8 ms is 0.02164225, hadRecentInput false. The cold maximum does not excuse it. No S3 code change was made in this correction; reserve accepted-state/dock space in follow-up. See scenario-session-windows.json and original scenario-3 trace/recording.

## Installer immediacy

FAIL, existing installer. Historical no-preference set: 9 valid samples, median 147.2 ms, null attempt 2 excluded. Supplemental runs: 10 finite samples each, median 147.8 ms both configs. S6 own CLS 0.00254584 is within gate; its other five polish properties pass. No live-install proof is claimed.

## Reduced-motion pointer

Unresolved modal pointer delivery in automated Chromium. Keyboard Validation/Stop works; do not relabel keyboard timings as a pointer pass. Existing failed calibration logs remain in evidence.
