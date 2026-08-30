# Control-plane self-update (AP-218)

**Status:** CU1 shipped by AP-219, CU2 by AP-220, and CU3 by AP-221; the microVM path remains follow-on work. Scope is the control-plane
image/binary only. Cloud baseline changes remain operator-side in `runCloudBaselineUpdate`.

## CU2 shipped (AP-220)

The SDK now provides typed `selfUpdate.start/status/watch` methods over the CU1 route and shares the public job contract with the
server. The CLI resolves a named/latest release, downloads and verifies its signed evidence offline, starts the job, streams phase
changes, reports before/after `serverVersion`, and emits per-phase durations plus terminal `totalMs` under `--json`. Polling tolerates
transient service replacement errors and remains bounded by a deadline/abort signal. `409` is attachable with `--follow`; failed
healthy recovery reports the prior-image re-pin, while exhausted recovery points to `--local`.

Desktop CloudFormation-v1 profiles call this SDK route through the selected cluster client and render queued, mirror, CloudFormation,
health, recovered, and failed states in the existing panel. The sidecar remains only for legacy installs during the two-release
deprecation window. `--local` preserves the operator-machine mirror/UpdateStack path. Production self-update remains deliberately
disabled until AP-226 pins the production key.

## CU1 shipped (AP-219)

The cloud server now exposes owner-admin signed POST/GET self-update routes, persists idempotent CAS-leased jobs in the ObjectStore,
re-signs job-id-only worker dispatch, independently verifies production release evidence, mirrors the bound digest with pinned crane,
and performs previous-template `ImageUri`-only CloudFormation update/recovery. Scoped self-update and CloudFormation service roles plus
the protected-resource stack policy bound the mutation surface. Both route and worker call MV0's `verifyReleaseEnvelope` directly with
`PINNED_RELEASE_TRUST`; its intentionally empty key set fails closed with AP-226 guidance. CU2 only re-points the CLI/desktop/SDK to
these routes and supplies signed release evidence. CU1 does not change existing client triggers.

Owner live proof, on a disposable installation:

1. Capture CloudTrail for both the worker-assumed self-update role and the CloudFormation service role; minimize both allow-lists and
   confirm the only `iam:PassRole` is the scoped CFN role with `iam:PassedToService=cloudformation.amazonaws.com`.
2. Attempt arbitrary-template baseline, IAM, S3, and KMS mutations and confirm the stack policy/service role denies all of them; confirm
   no `lambda:GetFunction` appears.
3. Perform a signed N→N+1 update, then submit a concurrent different idempotency key and observe `409` only while the lease is live.
4. Kill the worker during stack wait and prove GET polling resumes after lease expiry without re-injecting target controls.
5. Force a CloudFormation resource failure and confirm rollback/events are recorded; force a healthy wrong-version response and confirm
   the worker re-pins the previous image.
6. Retry a good signed release after each failure and confirm terminal/exhausted jobs no longer hold the installation lock.

## 0. Ground truth at `673be14`

| Fact                                                                                                                               | Evidence                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The CFN template has one `ImageUri`, guarded by `HasImage`.                                                                        | `packages/install-aws/template/appliance-cloudformation.yaml:9-19`                                                                                                                |
| The worker and server are image Lambdas; the worker has 900 seconds.                                                               | `packages/install-aws/template/appliance-cloudformation.yaml:162-176,210-224`                                                                                                     |
| Both Function URLs are public transport (`AuthType: NONE`); app routes supply authentication.                                      | `packages/install-aws/template/appliance-cloudformation.yaml:186-200,236-250`                                                                                                     |
| Both system execution roles currently attach `AdministratorAccess`.                                                                | `packages/install-aws/template/appliance-cloudformation.yaml:92-121`                                                                                                              |
| The stack owns its ECR repository.                                                                                                 | `packages/install-aws/template/appliance-cloudformation.yaml:126-139`                                                                                                             |
| The YAML is embedded as text and tested against the 51,200-byte `TemplateBody` limit.                                              | `packages/install-aws/src/template.ts:1-6`; `packages/install-aws/src/template.spec.ts:12-15`                                                                                     |
| Today's CLI entry point delegates to `runCloudSystemUpdate`, which mirrors, changes `ImageUri`, waits, and only hints at rollback. | `packages/cli/src/appliance-cloud-update.ts:12-35`; `packages/install-aws/src/cloud-lifecycle.ts:64-103`                                                                          |
| Baseline update is a separate host operation that preserves `ImageUri`; resume never blanks it.                                    | `packages/install-aws/src/cloud-lifecycle.ts:106-124`; `packages/install-aws/src/cloud-install.ts:197-203`                                                                        |
| `deployStack` sends `UpdateStack` and waits for completion.                                                                        | `packages/install-aws/src/cloud-install.ts:394-409`                                                                                                                               |
| The old three-phase updater is frozen for non-CFN installs.                                                                        | `packages/bootstrap/src/api-server-update.ts:78-89`; `packages/bootstrap/src/deprecation.ts:4-17`                                                                                 |
| The legacy system-role override is explicitly not the CFN path.                                                                    | `packages/api-server/src/services/deployment-executor.service.ts:25-36,296-302`                                                                                                   |
| One app has `server` and `worker` modes; signed API routes are mounted only in server mode.                                        | `packages/api-server/src/app.ts:32-42,72-89`                                                                                                                                      |
| `/bootstrap/status` exposes `serverVersion`; cluster-info exposes the same drift surface.                                          | `packages/api-server/src/routes/bootstrap/index.ts:77-84`; `packages/api-server/src/routes/cluster-info/index.ts:9-17,42,95-108`                                                  |
| The cloud image still needs in-process Pulumi, and already contains crane with writable auth under `/tmp`.                         | `packages/infra/src/lib/ApplianceDeploymentService.ts:3-6,25-26`; `packages/api-server/Dockerfile:32-38,95-108`                                                                   |
| The guest binary is release-built, host-staged, copied from boot media, and respawned.                                             | `.github/workflows/release-cli-binaries.yml:107-118,175-190`; `packages/cli/src/utils/api-server-artifact.ts:30-38,147-166,181-186`; `packages/vm/src/guest.rs:973-981,1154-1158` |
| The guest has stable SA credentials, selector-less routing, legacy quarantine, and shared WSL bootstrap.                           | `packages/vm/src/guest.rs:1006-1012,1024-1060,1111-1118,1160-1198`; `packages/vm/src/backend/wsl.rs:694-704,955-967`                                                              |
| Current skew UX says restage/reboot rather than update in place.                                                                   | `packages/cli/src/utils/runtime-doctor.ts:438-488`; `packages/app/src/components/cluster-compat-banner.tsx:28-48`                                                                 |
| The shipped Ed25519/RFC-8785 trust machinery has generation/expiry/blacklist checks, but its default key is an RFC fixture.        | `packages/sdk/src/models/catalogue-trust.ts:9-24,61-89,124-178,189-254`; `packages/cli/src/appliance-runtime-install.ts:115-154,392-487`                                          |

App Runtime (`appliance runtime ...`, the pooled `appliance-runtime` VM) does not run the api-server and is out of scope.

## 1. Safety invariant

> A failed update must never prevent the next update.

- **Cloud:** CFN resource failure rolls back; post-CFN health failure makes the still-running worker re-pin the non-empty prior image.
  A new signed request must then be accepted by the restored server.
- **microVM:** the supervisor retains the prior verified binary until candidate health passes. Failure restores `current` and restarts;
  boot must not overwrite that known-good release with stale media.
- **Trigger:** jobs are persisted before dispatch and never depend on the initiating HTTP connection surviving a restart.
- **Lease:** a killed worker cannot hold the installation forever; an expired lease is recoverable and never causes permanent `409`.

Lambda alias/two-slot cutover would narrow the cloud interruption window, but is future hardening, not a CU1 prerequisite.

## 2. Cloud mechanism (CU1)

### Route and job contract

`POST /api/v1/self-update` mounts `signatureAuth, requireAdmin`, then explicitly requires the default/owner tenant; a member key or any
other tenant gets `403` (`packages/api-server/src/middleware/auth.ts:126-144`). Its body is
`{"targetDigest":"sha256:...","release":{payload,envelope}}`: no tag, version, image URI, or stack name controls mutation. The signed
payload binds that digest to the cloud-image artifact, version, architecture, generation, validity, and production release key.

The server verifies the Ed25519 envelope and current signed blacklist before persistence, creates a CAS-protected job, and returns
`202 {jobId,status:"queued",statusUrl}`. `GET /api/v1/self-update/:jobId` has the same admin/owner-tenant gates and returns phase,
verified target/prior identity, timestamps, per-phase durations, recovery state, and redacted error. Jobs live in S3 ObjectStore, not
Lambda memory.

Idempotency is keyed by `(callerKeyId, tenantId, idempotencyKey)`, never a global client string. A live lease has `expiresAt` and
`heartbeatAt`; a claimed lease also has a random `holder` fencing epoch. Heartbeat and finish CAS against that holder, so an invocation
that outlives its lease cannot mutate after a replacement worker claims the job. A repeat is reused only when digest and generation
still match; otherwise it gets `409 {jobId,statusUrl}`. A later admin request CAS-takes an expired lease, marks the abandoned job
`failed/unknown`, and may start a new job. Terminal/exhausted recovery never holds the lock or short-circuits a new idempotency key.

The server re-signs `POST /api/internal/jobs/self-update` to the public `WORKER_URL` using the existing shared key-store path
(`packages/api-server/src/app.ts:94-98`). Its body is **only** `{jobId}`. The worker rejects extra target/version/URI fields, loads the
job, independently re-verifies its signed release evidence, and CAS-claims its live lease before deriving every digest, repository,
stack, and prior image from server-persisted/install data. Direct calls to the worker therefore cannot bypass route validation.
GET checks job ownership before attempting resume and signs redispatch with the job's original caller key; a redispatch failure is
logged but leaves the job resumable. Installations in `SystemRoleMode=admin` receive `503` guidance to restore scoped roles before a
job is persisted, and the worker also turns a missing scoped-role ARN into a terminal pre-mutation failure.

Audit/log redaction explicitly covers the exact live ECR token, bearer/basic forms, every AWS ARN and bare account id, the ECR registry
host, assumed-role session, release envelope bytes, and all key/signature headers. Logs retain job id, caller key id, digest prefix,
phase, and result.

### Mirror, update, and recovery

Use **crane**, not a new ECR-SDK layer copier. `crane cp` solves cross-registry manifests and layer uploads without Docker and keeps
only auth in `/tmp`; an SDK copier would recreate OCI negotiation, streaming, and multi-arch selection. Pinning crane in source matters
only after that image is built and delivered; CU1 pins it and CU2 acceptance verifies the delivered binary version.

Before `crane cp`, the worker uses the new production release trust (not `PINNED_CATALOGUE_TRUST`) to verify the RFC-8785 envelope,
keyId SHA-256 pin, generation floor/high-water mark, validity, blacklist, artifact kind/arch, and exact GHCR manifest digest. Verification
needs no transparency/network service. Only that digest is copied to installation ECR under `system-<version>`; the repository
lifecycle expires only old `build-` workload tags plus untagged manifests older than seven days, so updater `system-`, installer
`sha256-`, and release-version tags are never lifecycle candidates. Tags are immutable. `ecr:DescribeImages` resolves the mirrored tag
back to a digest, which must equal the signed digest and is persisted before `UpdateStack`. Signature, expiry, rollback-generation,
blacklist, or digest mismatch fails before ECR/CFN mutation.

The worker never materializes the image in Lambda's 4-GiB filesystem. First it describes the stack, rejects blank `ImageUri`, and
records `previousImage`, stack id, signed target, target ECR digest, and template identity. The health URL is re-derived from
`DescribeStacks` output `ApiServerFunctionUrl`; no missing worker environment variable is assumed
(`packages/install-aws/template/appliance-cloudformation.yaml:280-291`).

It calls `UpdateStack` with `UsePreviousTemplate: true`; only `ImageUri` is new and all other parameters use `UsePreviousValue: true`.
Because the retained template names IAM roles and managed policies it passes exactly
`Capabilities: [CAPABILITY_NAMED_IAM]`. The operator installer uses the same capability, installs the protective stack policy
unconditionally with `SetStackPolicy`, and supplies an allow-all `StackPolicyDuringUpdateBody` only for an operator baseline update.
The self-update executor never supplies that override or a template body. CFN rollback handles resource-update failure.

The parameter updates both functions, so CFN does not promise worker-before-server ordering. Lambda preserves the in-flight old worker
while code changes. Job phases and schemas are N/N-1 compatible and resumable: each invocation heartbeats a bounded phase; GET polling
re-dispatches `{jobId}` after an expired lease, and a fresh worker resumes stack wait or health from persisted AWS/job state. Before
mutation the worker reserves recovery time; it will not submit a re-pin unless both stack-wait and health floors remain. A re-pin that
was submitted but cannot be observed before the invocation deadline stays `recoveryState:"in-progress"` with its phase and lease
heartbeat persisted, so the next GET-driven invocation resumes rather than declaring false exhaustion.

After `UPDATE_COMPLETE`, the worker polls unauthenticated `GET /bootstrap/status` every five seconds for two minutes. Success is HTTP
200 with `initialized: true` and the target `serverVersion`. CU2 is gated on live p95/p99 mirror and CFN timing proving the recovery
reserve inside 900 seconds; the existing 1,800-second host waiter is not copied into a single invocation.

On probe failure the worker repeats the previous-template, ImageUri-only update with `previousImage`, waiting for a stable stack and
retrying submission. Stable `*_FAILED` states stop retries and include redacted stack events; `UPDATE_ROLLBACK_FAILED` is not hammered.
CFN continues after worker exit. A restored prior version yields `failed`/`recovered: true`; exhaustion is
persisted as terminal `failed`, `recovered:false`, `recoveryState:"exhausted"`, with lease cleared; it alerts and leaves `--local` break
glass, but cannot block a later signed request. This is weaker than aliases only during the bounded bad-image window.

## 3. IAM decision and draft

CU1 adds conditional `SelfUpdateRole` and a stack-scoped CFN service role. Update AWS clients require assumed credentials, never the
default chain. CU0 first removes `AdministratorAccess` from both system Lambda roles using a statically enumerated deployment
allow-list; this is a release gate, not a residual caveat. CloudTrail live proof is still owed before release; follow the
[owner proof steps](cli.md#cloud-baseline-role-mode).

**CU0 shipped:** `SystemRoleMode=scoped` is now the CloudFormation default.
The api-server can read/write only its data bucket; CloudFormation, not the Lambda, resolves the bootstrap secret.
The worker adds Pulumi state/KMS, installation ECR, and permissions-boundary-contained user-appliance provisioning.
Its runtime grant stays inline; IAM/Lambda and edge-service provisioning use separate scoped managed policies under `/appliance-system/`.
Tests resolve worst-case names and partitions against IAM's 10,240-character aggregate inline and 6,144-character managed-policy limits, preserving CU1 headroom.
That boundary lives under `/appliance-system/`, outside the worker's mutable `/appliance/` policy namespace.
It denies its own policy mutation, non-appliance role assumption, all non-read operations on the control-plane stack, and mutations of both qualified and unqualified system functions.
Pre-CU0 appliance roles adopt only this boundary on their first redeploy; deletion, replacement, and trust-policy mutation are not granted.
Account-scoped `Resource: '*'` remains only where AWS exposes no resource-level authorization, and every case is test-allowlisted.
Run `appliance cloud baseline-update --system-role-mode admin --yes` only for break glass; rerun with `scoped` to restore least privilege.

Upgrade transition: CloudFormation owns the api-server and worker Function URL permissions. Pre-CU0 edge stacks may still track redundant
Pulumi resources whose URNs end in `-apiServer-public-function-url` and `-worker-public-function-url`; before the first scoped edge
redeploy, run `pulumi login s3://<state-bucket>`, locate the edge stack with `pulumi stack ls --all`, and remove exactly those two URNs
with `pulumi state delete --stack <edge-stack-ref> --yes '<urn>'`. This edits Pulumi state only:
do not delete the AWS permissions, and do not remove the separate `-edge-router-invoke-permission` resource. Confirm both legacy URNs
are absent from `pulumi stack --show-urns --stack <edge-stack-ref>` before redeploying; the CFN grants remain authoritative.

Its trust policy is:

```yaml
Version: '2012-10-17'
Statement:
  - Effect: Allow
    Principal: { AWS: !Sub 'arn:${AWS::Partition}:iam::${AWS::AccountId}:root' }
    Action: sts:AssumeRole
    Condition:
      StringEquals: { aws:PrincipalArn: !GetAtt SystemWorkerRole.Arn }
      StringLike: { sts:SourceIdentity: 'self-update-*' }
```

The role and each executor session use 3,600 seconds; CU0 grants the worker `sts:AssumeRole` only on this role. The request sets both
`SourceIdentity` and `RoleSessionName` to `self-update-<jobId>`. Root-plus-`aws:PrincipalArn` survives role recreation without trusting
a stale principal id.

The inline permissions policy draft (substitutions denote CFN references) is:

```yaml
Version: '2012-10-17'
Statement:
  - Sid: EcrAuth
    Effect: Allow
    Action: ecr:GetAuthorizationToken
    Resource: '*'
  - Sid: MirrorOnlyToInstallationRepository
    Effect: Allow
    Action:
      - ecr:BatchCheckLayerAvailability
      - ecr:BatchGetImage
      - ecr:CompleteLayerUpload
      - ecr:DescribeImages
      - ecr:GetDownloadUrlForLayer
      - ecr:InitiateLayerUpload
      - ecr:PutImage
      - ecr:UploadLayerPart
    Resource: !GetAtt ImageRepository.Arn
  - Sid: ObserveOnlyThisStack
    Effect: Allow
    Action:
      - cloudformation:DescribeStacks
      - cloudformation:DescribeStackEvents
    Resource: !Ref AWS::StackId
  - Sid: UpdateOnlyThisStack
    Effect: Allow
    Action:
      - cloudformation:ContinueUpdateRollback
      - cloudformation:UpdateStack
    Resource: !Ref AWS::StackId
    Condition:
      StringEquals:
        cloudformation:RoleArn: !GetAtt SelfUpdateCloudFormationRole.Arn
  - Sid: PassOnlySelfUpdateCloudFormationRole
    Effect: Allow
    Action: iam:PassRole
    Resource: !GetAtt SelfUpdateCloudFormationRole.Arn
    Condition:
      StringEquals:
        iam:PassedToService: cloudformation.amazonaws.com
```

There is no `lambda:GetFunction` (it exposes plaintext environment variables including `BOOTSTRAP_TOKEN`) or direct Lambda mutation.
Expect one `iam:PassRole`, scoped to `SelfUpdateCloudFormationRole` and `iam:PassedToService: cloudformation.amazonaws.com`; the CU1
CloudTrail run confirms the exact minimum. The CFN service role owns the exact two-function permissions. Start from
`lambda:UpdateFunctionCode`, `GetFunctionConfiguration`, `ListTags`, `TagResource`, and only add `UpdateFunctionConfiguration` if the CU1
CloudTrail run proves CFN needs it; it has no IAM/S3/KMS/ECR mutation.

IAM cannot express “only `ImageUri` changed”; audit the caller as if it submitted an arbitrary template. CU1 therefore also associates
the scoped CFN role, conditions `UpdateStack` on its ARN, and installs a stack policy denying updates to every IAM, S3, and KMS logical
resource. The code adds `UsePreviousTemplate`, previous values, and exact capability as defense in depth. CU0 owns de-admin of the two
Lambda execution roles; CU1 owns this structural self-modifying-stack boundary.
Operator baseline changes temporarily override that policy only for their in-flight update and then re-install it; the signed executor
has no path to `StackPolicyDuringUpdateBody`.

The current YAML is 8,695 bytes versus 51,200 bytes. Keep the role and compact
inline policy in that file (not another embedded asset), extend the existing byte
limit test, and add assertions for exact actions/resources and absence of
baseline actions. CU1 therefore remains far below the direct-body limit.

## 4. Triggers and client re-pointing

- **CU1:** ship the admin route/job and production-key verifier. `latestGhcrTag` is advisory only; mutation names a signed manifest digest.
- **CU2 (shipped by AP-220):** `appliance cloud update` calls the route and polls the job. `--local`
  preserves today's `runCloudSystemUpdate` for break glass. Cloud baseline update
  remains local and separately named. Desktop “Check for updates” calls the same
  SDK route only when `profile.installGeneration === 'cloudformation-v1'`; frozen legacy installs retain `updateApiServer` sidecar for
  the two-release window. `updateBaseline` stays host-side (`packages/app/src/lib/host.ts:212-242`;
  `packages/cli/src/appliance-cloud-update.ts:20-25`).
- **CU3 (shipped by AP-221):** an opt-in EventBridge Scheduler schedule invokes the worker daily with the fixed payload
  `{"kind":"self-update-check"}`. Policy is `off` by default (the schedule and its execution role are absent), `notify` (verify the
  latest signed release and persist an update-available marker), or `auto` (create and dispatch the same verified, leased image job as
  the owner-admin route). The event carries no job, digest, version, image URI, or release origin. The scheduler execution role can
  invoke only the installation worker. `auto` applies image updates only; baseline changes remain operator-side. Empty production pins
  and `SystemRoleMode=admin` both log a reason and exit without fetching or mutating. Function URL requests cannot reach the direct
  `/events` pass-through handler, scheduler role trust is account/source-ARN bound, and Scheduler retries are disabled in favor of the
  next daily check. Every outcome is persisted as `self-update-last-check`; signed cluster-info and the CLI/desktop render it, while
  unauthenticated bootstrap exposes only the memoized availability boolean.

CU3 owner runbook (after AP-226 provisions production trust), on a disposable installation:

Set the installation coordinates once (replace the three example values):

```sh
export APPLIANCE_PROFILE=prod
export APPLIANCE_STACK=appliance-prod
export AWS_REGION=us-east-1
```

1. Enable notify and trigger a deterministic check:

   ```sh
   appliance cloud baseline-update --system-role-mode scoped
   appliance cloud update --policy notify
   aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "$APPLIANCE_STACK" --query 'Stacks[0].Parameters[?ParameterKey==`SelfUpdatePolicy`].ParameterValue' --output text
   aws cloudformation describe-stack-resource --region "$AWS_REGION" --stack-name "$APPLIANCE_STACK" --logical-resource-id SelfUpdateSchedule --query 'StackResourceDetail.ResourceStatus' --output text
   appliance cloud update --check-now
   appliance cloud update --status --json | jq '.lastCheck, .available'
   ```

   Expect `notify`, `CREATE_COMPLETE`/`UPDATE_COMPLETE`, then `notify (notify-marked)`, then a `lastCheck.reason` of `notify-marked` and an available version. Before AP-226,
   expect the explicit inactive message and `lastCheck.reason == "no-pinned-release-trust"`. The desktop must show **Update available
   (vX)**; its **Update now** action independently resolves the latest signed release. `/bootstrap/status` may expose only
   `selfUpdateAvailable`, never version, generation, digest, reason, or trust state.

2. Prove a manual update uses the ordinary route and clears the marker:

   ```sh
   appliance cloud update
   appliance cloud update --status --json | jq '.available // "cleared"'
   ```

   Expect the command to print `Updating to vX (from the scheduled notify check)` or `(latest signed release)` before phases, then
   `"cleared"` after success. No marker banner or bootstrap boolean may remain when the marker version equals the running version.

3. Enable auto and prove manual-check cooldown plus scheduled-job idempotency:

   ```sh
   appliance cloud update --policy auto
   SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   appliance cloud update --check-now
   appliance cloud update --check-now
   sleep 60
   appliance cloud update --check-now
   appliance cloud update --status --json | jq '.lastCheck'
   aws cloudformation describe-stack-events --region "$AWS_REGION" --stack-name "$APPLIANCE_STACK" --query "StackEvents[?Timestamp >= \`$SINCE\` && ResourceStatus == \`UPDATE_IN_PROGRESS\`].[Timestamp,LogicalResourceId,ResourceType]" --output table
   ```

   Expect the immediate repeat to report `cooldown` without another worker dispatch. After 60 seconds, expect `auto-reused`,
   `lease-conflict` while another update lease is live, or `current` if the first job already completed; the scheduled idempotency key
   remains `scheduled:<digest>`. Follow any reported live job with `appliance cloud update --follow <jobId>`. Since the captured
   timestamp, the stack events may show only `ApiServerFunction` and `WorkerFunction` entering `UPDATE_IN_PROGRESS`; no IAM, S3, KMS,
   permissions-boundary, managed-policy, scheduler-role, or schedule logical resource may appear.

4. Turn the feature off and verify CloudFormation removed its trigger resources:

   ```sh
   appliance cloud update --policy off
   aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "$APPLIANCE_STACK" --query 'Stacks[0].Parameters[?ParameterKey==`SelfUpdatePolicy`].ParameterValue' --output text
   aws cloudformation describe-stack-resource --region "$AWS_REGION" --stack-name "$APPLIANCE_STACK" --logical-resource-id SelfUpdateSchedule
   aws cloudformation describe-stack-resource --region "$AWS_REGION" --stack-name "$APPLIANCE_STACK" --logical-resource-id SelfUpdateSchedulerRole
   appliance cloud update --status --json | jq '.'
   ```

   Expect `off`, both `describe-stack-resource` calls to report `ResourceNotFound`, and status to report policy `off`.

## 5. microVM mechanism (MV1)

**MV1 shipped (AP-222):** capable VZ and WSL guests now have the protected persistent release volume, raw artifact transport,
same-open-handle verification, atomic pointer-file promotion, two-minute versioned health gate, and automatic rollback described below.
`appliance vm update` and the Desktop compatibility banner use the same signed host transport. VMs booted by an older launcher are
detected before transfer and retain the signed restage-and-reboot path. Production self-update remains intentionally disabled until
AP-226 fills `PINNED_RELEASE_TRUST` with the offline release key.
For owner testing only, a non-release build may load the same trust-policy JSON shape from
`APPLIANCE_RELEASE_TRUST_FILE=<path>`. Release builds ignore that variable with a loud warning and retain the empty/production pin set;
the escape hatch never permits unsigned in-place replacement.
A build is non-release when the CLI `VERSION` starts with `0.0.0` or contains `-dev`. The file shape is
`{"keys":{"<keyId>":"<pubkey>"},"generationFloor":N,"blacklistedKeyIds":[]}`, with `blacklistedKeyIds` optional.

**MV0 shipped (AP-225):** release assets now include `SHA256SUMS`, `control-plane-release.json`, and
`control-plane-release.sig.json` under the distinct `control-plane-release` Ed25519 role.
The protected `release-signing` environment signs only when `APPLIANCE_RELEASE_SIGNING_KEY` exists; pre-AP-226 publishing remains unsigned.
Create/restage verifies the envelope, generation, validity, version, architecture, size, and SHA-256 before its first write.
VZ and WSL use verified hash/size and keyId sidecars without `jq`, and compare the sidecar keyId to the trust pin rendered explicitly
by the CLI rather than deriving trust from media; AP-226 replaces the intentionally empty production pin set.

MV0 first adds a `control-plane-release` envelope role and changes the workflow to publish `SHA256SUMS` plus its Ed25519/RFC-8785
production release envelope covering both
`appliance-api-server-linux-*`, `appliance-console.tar.gz`, and the GHCR manifest digest. It uses a new offline Appliance production
key whose SHA-256 `keyId` is pinned separately from the RFC-0001 fixture. Reuse the catalogue verifier's canonical envelopes,
generation floor/high-water protection, expiry, and blacklist gate. The release path does not yet fetch a signed blacklist: revocation
currently requires a CLI upgrade; signed blacklist distribution is an AP-226/CU2 follow-up. Key custody/rotation is a separate owner card.
Only releases produced after MV0 are eligible for either cloud or microVM self-update.

MV0 makes `stageFromRelease` verify an available envelope before writing. While the production pin set is empty, legacy unsigned release
seeds remain bootable with a loud warning and self-update disabled; once AP-226 pins a key, release builds fail closed on missing evidence.
`--allow-unsigned` remains development-only. The guest accepts a signed seed copy from boot media only when it matches the verified
sidecars. Restage+reboot becomes a sanctioned update fallback only for signed post-MV0 releases.

The unprivileged macOS/Linux CLI cannot create a genuinely root-owned host cache without an elevation contract. MV0 therefore keeps the
compatible `~/.appliance/vm/images/guest-assets` path, makes the directory `0700`, stages verified files atomically as `0444`, and treats
the guest-side digest/size check as the effective seed gate. Windows additionally applies the existing protected owner/SYSTEM/
Administrators DACL. The MV0 guest does not perform Ed25519 itself: the host verifies the signature and derives boot-media sidecars, then
both VZ and WSL independently compare the selected binary's hash/size/architecture and keyId against the CLI-rendered production pin.
This protects the seed copy after host
staging; it is not a second signature-verification boundary.

`appliance vm update [--name NAME] [--version VERSION]` first performs the launcher-capability probe, then downloads binary, console,
`SHA256SUMS`, payload, and envelope to an ACL'd temporary staging directory. It verifies the envelope offline, production key id,
generation, validity, blacklist, version/architecture, and both hashes before opening the artifact channel. The guest independently
checks exact byte count and signed hash. The host publishes the verified release into next-boot `guest-assets` only after the running
guest reports successful promotion and the target version; rollback leaves next-boot media unchanged.

The shell listener cannot become a raw receiver because socat allocates its PTY before `SHELL_AGENT` parses input
(`packages/vm/src/guest.rs:320-324,1234-1250`). MV1 adds a second `VSOCK-LISTEN:ARTIFACT_VSOCK_PORT` using non-PTY `EXEC:` and reuses
`runtime_guest::artifact_receive_command`; VZ adds host `connect_vsock(ARTIFACT_VSOCK_PORT)`. WSL keeps `stream_guest_artifact`'s
same-open-handle hash/stream contract but changes api-server/console from `expected_sha256: None` to the signed digest
(`packages/vm/src/backend/wsl.rs:623-704`). MV1 must widen that receive helper's current Windows/test-only cfg for VZ
(`packages/vm/src/backend/runtime_guest.rs:228`).

VZ gains a root-only persistent control-plane volume mounted at `/var/lib/appliance-control-plane`, separate from `/persist`
(the agent HOME/data disk) and never exposed by hostPath. It is appended after the contractual vda data, vdb boot-media, and optional
vdc agent devices, resolved by the `appliance-control-plane` filesystem label, and sized from three copies of the signed artifact sizes
plus headroom with a 1 GiB minimum. When host staging grows the sparse disk, the provisioner runs online `resize2fs` after mounting so
the guest filesystem gains the capacity. Formatting is allowed only for a device on which `blkid` reports neither type nor label. The mount
tries `nodev,nosuid,nosymfollow`, logs and falls back to `nodev,nosuid` only when the guest mount implementation rejects `nosymfollow`.
WSL uses an ACL'd directory on its distro VHD, never drvfs.

Releases live in content-addressed `releases/<version>-<binary-sha12>/` directories containing
`{binary, console.tar.gz, console/}`. `current`, `previous`, and `pending` are one-line relative pointer files, restricted to
`releases/[0-9A-Za-z._+-]+` and flipped with a same-directory `mv -f` rename supported by BusyBox. Existing matching content is reused;
the updater never removes a directory referenced by any pointer. The promoted signed generation is persisted beside the pointers and
the guest refuses any lower generation, and permits equality only when the content-addressed target is already `current`. Properties,
payload version/generation, and the payload binary SHA must also agree with the checksum sidecar before staging. This promotes
`APPLIANCE_CONSOLE_DIR` and binary together without destroying rollback state.

Extend `APISERVER_COMMON` into a supervisor: open the candidate without following symlinks, verify its signed SHA-256 through that held
fd immediately before executing `/proc/self/fd/<fd>`, launch with the candidate console, and poll guest-loopback `/bootstrap/status`
for two minutes requiring the target version. Success promotes the directory; exit/bad health restores `previous` and respawns. Keep
the old release until a later successful update. Recovery consumes `previous` as a one-shot pointer and falls back to the legacy seed
when both persistent targets are unusable. Workload namespaces enforce PSA `restricted`; a default-deny
ValidatingAdmissionPolicy blocks hostPath outside explicitly labelled control-plane namespaces, and a second cluster-wide rule rejects
every hostPath at, below, or containing `/var/lib/appliance-control-plane` (including `/var/lib` and `/`), even in privileged namespaces. Older Kubernetes versions that do not
apply ValidatingAdmissionPolicy retain PSA but are reported as a doctor warning rather than being claimed as equivalently protected.

Boot-media/WSL copy is seed-only and never overwrites `current`; quarantine, selector-less routing, and SA wiring remain independent.
Because the artifact listener and supervisor are rendered by the host CLI at boot, VMs created before MV1 cannot update in place. A
launcher-capability probe in doctor/banner detects this and offers restage+reboot; capable VMs get the update action. Doctor reports
host-staged, signed release, persistent-current, console, and running versions. Desktop calls the same host transport. VZ and WSL must
pass identical supervisor tests.

## 6. Failure matrix

| Method / failure                                            | Detection                                | Automatic action                                                                             | Next update path                  |
| ----------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------- |
| Cloud unknown/expired/blacklisted signer or digest mismatch | production envelope verifier             | no crane/CFN mutation                                                                        | corrected signed request          |
| Direct worker target injection                              | jobId-only schema + persisted derivation | reject before lease/mutation                                                                 | admin server route                |
| Worker kill/stale lease                                     | expiry + holder-epoch CAS                | fence zombie; resume same job or fail abandoned for a new request                            | signed route never permanent-409s |
| Cloud mirror/auth/digest                                    | crane + ECR-resolved digest              | persist recovered pre-mutation failure                                                       | current route                     |
| Cloud CFN resource failure                                  | stack events/status                      | CFN built-in rollback                                                                        | restored/current route            |
| Cloud wrong/unhealthy server                                | versioned bootstrap probe                | re-pin `previousImage`                                                                       | restored signed route             |
| Cloud re-pin exhausted                                      | persisted terminal recovery state        | clear lease + alert                                                                          | new request or `--local`          |
| Cloud re-pin submitted but unobserved                       | deadline with recovery in progress       | retain phase/holder state; resume after lease expiry                                         | GET resumes recovery              |
| Cloud stable `*_FAILED` / rollback failed                   | stack status + events                    | stop submission loop, redact events, mark exhausted; scoped role permits operator rollback   | new request or operator recovery  |
| Pre-MV0 release                                             | empty production pin / missing envelope  | allow initial seed with loud warning and disable self-update; refuse after AP-226 pins trust | install a signed post-MV0 release |
| Old launcher after MV0                                      | capability probe                         | no in-place transfer                                                                         | signed restage+reboot             |
| microVM signature/hash/transfer failure                     | host + guest verifier                    | discard `.partial`; no swap                                                                  | old release, retry command        |
| microVM lower signed generation                             | guest persisted generation high-water    | refuse candidate before pending pointer                                                      | newer signed release              |
| microVM malformed/dangling pointer                          | strict relative pointer parser           | remove rejected unreferenced release; restore `previous`, else run the legacy seed           | doctor, then signed update        |
| microVM corrupt/missing console with valid binary           | guest console hash/extract check         | warn and run headless; never delete the api-server binary                                    | restage the same signed release   |
| microVM candidate crash/probe timeout                       | supervisor                               | restore `previous`, respawn                                                                  | `appliance vm update`             |
| microVM reboot with stale media                             | persistent current exists                | ignore media seed                                                                            | persistent supervisor             |

## 7. Test and owner live-verification plan (input to AP-223)

Automate POST/GET member and non-owner-tenant `403`, admin success, idempotency caller/tenant binding, live/expired lease takeover,
durable resume, direct-worker extra-field/unknown-job rejection, N/N-1 job reads, and the named redaction set. Test bad/fixture/unknown
keys, malformed envelopes, expiry, generation rollback, blacklist, wrong artifact/arch/digest, and successful production-key fixtures.
Also test original-caller resume signing, non-fatal resume dispatch, idempotency target mismatch, scoped-role preflight, holder fencing,
and a zombie worker heartbeat after takeover.

Test crane array argv/no shell, verified source-to-target digest binding, nonblank prior image, and exact `UpdateStack`: stack ARN,
`UsePreviousTemplate`, only `ImageUri` new, every other parameter previous, service `RoleArn`, and exactly
`[CAPABILITY_NAMED_IAM]`, with no stack-policy override. Parse YAML, enforce 51,200 bytes, fail if a named IAM resource lacks
NAMED_IAM acknowledgement, snapshot caller/service-role allow-lists and stack-policy protected logical IDs, and submit an
arbitrary-template negative test. Test operator-only `StackPolicyDuringUpdateBody`, unconditional policy installation, the exact
build-tag/untagged lifecycle rules, ECR digest resolution and immutable-tag match/mismatch behavior, exact AssumeRole shape,
token-to-DOCKER_CONFIG wiring, pre-mutation failure,
terminal stack failures, submitted-but-unobserved recovery, exhaustion clearing its lease, resumption, and deadline reserve.

CU0/CU1 live verification uses a disposable install and CloudTrail to remove admin, minimize both normal execution and CFN service-role
actions, confirm only the scoped CFN PassRole and no GetFunction, and prove baseline/IAM/S3/KMS mutation denied. Then update N→N+1,
reject concurrency, kill a worker and resume, force CFN failure, force healthy-wrong-version re-pin, and retry good.

CU2's owner timing gate is live-only and feeds AP-223; unit fakes are not evidence. After AP-226 pins the production key, run three
consecutive signed updates on a disposable CloudFormation-v1 installation with `appliance cloud update --json` (use three monotonically
new signed releases, or another owner-approved sequence that creates three real jobs). Use only fresh, uninterrupted jobs as timing
samples. Preserve each terminal JSON record, its `phaseDurationsMs`, and its explicit `totalMs`. For every run record:

Set the three signed release versions, then capture each run as described in the [CLI cloud update reference](cli.md#cloud-update):

```sh
v1=1.58.0 v2=1.59.0 v3=1.60.0 # replace with the three live signed releases
appliance cloud update --version "$v1" --json > run1.json
appliance cloud update --version "$v2" --json > run2.json
appliance cloud update --version "$v3" --json > run3.json
jq -se 'all(.[]; (.job.resumeCount // 0) == 0)' run*.json
jq '{mirror:(.job.phaseDurationsMs.mirroring // 0), cfn:((.job.phaseDurationsMs["submitting-update"] // 0)+(.job.phaseDurationsMs["waiting-for-stack"] // 0)), health:(.job.phaseDurationsMs["probing-health"] // 0), total:.job.totalMs}' run*.json
jq -s 'map(.job.totalMs)|max' run*.json
```

1. mirror = `mirroring`;
2. CloudFormation = `submitting-update + waiting-for-stack`;
3. health = `probing-health`;
4. target total = `totalMs` = `completedAt − startedAt`, covering every pre-complete phase, including queued, verifying, and
   describing-stack.

Mirror, CloudFormation, and health are diagnostic breakdowns, not a substitute for the target total. A resumed job has
`resumeCount > 0` and charges lease-gap wall time to whichever phase was in flight; retain that record as recovery evidence but discard
it from the timing sample set. The first `jq` command above must exit `0`, proving that all three sample files are uninterrupted jobs.
Compute p95 and p99 for each component and target total; with three observations, report the nearest-rank value (the maximum) and retain
all raw values. Acceptance requires the observed p99 target total to fit the 660-second target deadline, leaving 180 seconds to the
840-second hard-work limit for recovery and a final 60-second reserve inside Lambda's 900-second worker budget. Also force one unhealthy
target and preserve the recovery-phase durations to prove the previous-image re-pin uses that reserve. Record region, architecture,
source/target versions, job ids, wall-clock timestamps, and the `--json` files in the PR/live-proof artifact set. Durations use server
wall-clock timestamps, so note any NTP/clock step and discard an affected timing sample. Do not claim this gate from a fake or dry run.

For MV0/MV1 test signed `SHA256SUMS`/cloud digest, pre-MV0 warning before the pin and refusal after it, fail-closed create/restage before writing, protected staging and signed
boot-media seed, raw VZ and same-handle WSL transfer, wrong size/hash, root-only volume/VHD, symlink/held-fd race, PSA/hostPath denial,
atomic binary+console promotion, crash/hang/
wrong-version rollback, stale media, old-launcher fallback, quarantine coexistence, doctor/banner, and VZ/WSL parity. Owner updates without
reboot, injects a crash, confirms rollback then a good update, and reboots with stale media to confirm persistent current survives.

## 8. Sequencing and effort

| Card | Scope                                                                                 | Depends on                     | Effort |
| ---- | ------------------------------------------------------------------------------------- | ------------------------------ | ------ |
| KEY  | Owner provisions production Ed25519 key and custody/rotation/revocation procedure     | S1                             | M      |
| CU0  | CloudTrail allow-list; de-admin both system Lambda execution roles                    | S1                             | L      |
| CU1  | admin route/job, trust verifier, crane, scoped caller/CFN roles, stack policy, re-pin | CU0                            | XL     |
| MV0  | sign releases; verify/harden create/restage staging and boot-media seed               | S1, KEY                        | M      |
| CU2  | CLI/desktop/SDK re-point, signed release evidence, `--local`, live timing gate        | CU1, MV0                       | M      |
| CU3  | EventBridge and `off/notify/auto` policy                                              | CU2                            | M      |
| MV1  | verified transport, protected volume, supervisor, UX, VZ/WSL parity                   | S1, MV0; parallel with CU0/CU1 | XL     |

AP-223 consumes the live steps after CU0/CU1 and MV0/MV1 test environments exist.

## 9. Decisions taken

- Trust root is a new offline Appliance production Ed25519 key, never the shipped RFC-0001 fixture; custody/rotation/revocation is an
  owner card, while verifiers pin its SHA-256 key id and enforce generation and expiry offline. Until signed blacklist distribution lands,
  revocation requires shipping a CLI with the compromised key removed.
- One signed production release envelope gates two transports: the GHCR manifest digest before cloud crane copy and guest binary plus
  console hashes before VM transfer.
- CU0 de-admins both system Lambda execution roles before CU1/CU2; CU1 adds the scoped self-update/CFN roles and stack policy.
- MV0 may preserve unsigned initial boot before AP-226, but Cloud CU2 and MV1 accept only signed post-MV0 releases; checksum-only
  self-update is never allowed.
