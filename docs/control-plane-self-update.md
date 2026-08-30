# Control-plane self-update (AP-218)

**Status:** S1 written decision, re-baselined on `main` at `673be14`. This is a design, not an implementation. Scope is the
control-plane image/binary only: cloud first, then microVM. Cloud baseline changes remain operator-side in `runCloudBaselineUpdate`.

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
verified target/prior identity, timestamps, recovery state, and redacted error. Jobs live in S3 ObjectStore, not Lambda memory.

Idempotency is keyed by `(callerKeyId, tenantId, idempotencyKey)`, never a global client string. A live lease has `expiresAt` and
`heartbeatAt`; only it causes `409`. A later admin request CAS-takes an expired lease, marks the abandoned job `failed/unknown`, and may
start a new job. Terminal or exhausted recovery state never holds the lock or short-circuits a request with a new idempotency key.

The server re-signs `POST /api/internal/jobs/self-update` to the public `WORKER_URL` using the existing shared key-store path
(`packages/api-server/src/app.ts:94-98`). Its body is **only** `{jobId}`. The worker rejects extra target/version/URI fields, loads the
job, independently re-verifies its signed release evidence, and CAS-claims its live lease before deriving every digest, repository,
stack, and prior image from server-persisted/install data. Direct calls to the worker therefore cannot bypass route validation.

Audit/log redaction explicitly covers ECR auth tokens, the ECR registry host/account id, assumed-role ARN/session, release envelope
bytes, and all key/signature headers. Logs retain job id, caller key id, digest prefix, phase, and result.

### Mirror, update, and recovery

Use **crane**, not a new ECR-SDK layer copier. `crane cp` solves cross-registry manifests and layer uploads without Docker and keeps
only auth in `/tmp`; an SDK copier would recreate OCI negotiation, streaming, and multi-arch selection. Pinning crane in source matters
only after that image is built and delivered; CU1 pins it and CU2 acceptance verifies the delivered binary version.

Before `crane cp`, the worker uses the new production release trust (not `PINNED_CATALOGUE_TRUST`) to verify the RFC-8785 envelope,
keyId SHA-256 pin, generation floor/high-water mark, validity, blacklist, artifact kind/arch, and exact GHCR manifest digest. Verification
needs no transparency/network service. Only that digest is copied to installation ECR; the verified source and resolved target digest
are recorded. Signature, expiry, rollback-generation, blacklist, or digest mismatch fails before ECR/CFN mutation.

The worker never materializes the image in Lambda's 4-GiB filesystem. First it describes the stack, rejects blank `ImageUri`, and
records `previousImage`, stack id, signed target, target ECR digest, and template identity. The health URL is re-derived from
`DescribeStacks` output `ApiServerFunctionUrl`; no missing worker environment variable is assumed
(`packages/install-aws/template/appliance-cloudformation.yaml:280-291`).

It calls `UpdateStack` with `UsePreviousTemplate: true`; only `ImageUri` is new and all other parameters use `UsePreviousValue: true`.
Because the retained template contains IAM resources it passes exactly `Capabilities: [CAPABILITY_IAM]`, as today's updater does
(`packages/install-aws/src/cloud-install.ts:394-400`). No template body enters this path. CFN rollback handles resource-update failure.

The parameter updates both functions, so CFN does not promise worker-before-server ordering. Lambda preserves the in-flight old worker
while code changes. Job phases and schemas are N/N-1 compatible and resumable: each invocation heartbeats a bounded phase; GET polling
re-dispatches `{jobId}` after an expired lease, and a fresh worker resumes stack wait or health from persisted AWS/job state. Before
mutation the worker reserves recovery time; near its hard deadline it attempts re-pin rather than waiting indefinitely.

After `UPDATE_COMPLETE`, the worker polls unauthenticated `GET /bootstrap/status` every five seconds for two minutes. Success is HTTP
200 with `initialized: true` and the target `serverVersion`. CU2 is gated on live p95/p99 mirror and CFN timing proving the recovery
reserve inside 900 seconds; the existing 1,800-second host waiter is not copied into a single invocation.

On probe failure the worker repeats the previous-template, ImageUri-only update with `previousImage`, waiting for a stable stack and
retrying submission. CFN continues after worker exit. A restored prior version yields `failed`/`recovered: true`; exhaustion is
persisted as terminal `failed`, `recovered:false`, `recoveryState:"exhausted"`, with lease cleared; it alerts and leaves `--local` break
glass, but cannot block a later signed request. This is weaker than aliases only during the bounded bad-image window.

## 3. IAM decision and draft

CU1 adds conditional `SelfUpdateRole` and a stack-scoped CFN service role. Update AWS clients require assumed credentials, never the
default chain. CU0 first removes `AdministratorAccess` from both system Lambda roles using a CloudTrail-derived, live-proven deployment
allow-list; this is a release gate, not a residual caveat.

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

The role sets `MaxSessionDuration: 3600`; the AssumeRole request sets `SourceIdentity` to the exact job id and the executor rejects any
mismatch. Root-plus-`aws:PrincipalArn` survives safe role recreation without silently trusting a stale principal id.

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
  - Sid: UpdateOnlyThisStack
    Effect: Allow
    Action:
      - cloudformation:DescribeStacks
      - cloudformation:DescribeStackEvents
      - cloudformation:UpdateStack
    Resource: !Ref AWS::StackId
    Condition:
      StringEquals:
        cloudformation:RoleArn: !GetAtt SelfUpdateCloudFormationRole.Arn
```

There is no `lambda:GetFunction` (it exposes plaintext environment variables including `BOOTSTRAP_TOKEN`) and no `iam:PassRole` or direct
Lambda mutation. The permanently associated CFN service role owns the exact two-function permissions. Start from
`lambda:UpdateFunctionCode`, `GetFunctionConfiguration`, `ListTags`, `TagResource`, and only add `UpdateFunctionConfiguration` if the CU1
CloudTrail run proves CFN needs it; it has no IAM/S3/KMS/ECR mutation. The live run must prove no PassRole is needed.

IAM cannot express “only `ImageUri` changed”; audit the caller as if it submitted an arbitrary template. CU1 therefore also associates
the scoped CFN role, conditions `UpdateStack` on its ARN, and installs a stack policy denying updates to every IAM, S3, and KMS logical
resource. The code adds `UsePreviousTemplate`, previous values, and exact capability as defense in depth. CU0 owns de-admin of the two
Lambda execution roles; CU1 owns this structural self-modifying-stack boundary.

The current YAML is 8,695 bytes versus 51,200 bytes. Keep the role and compact
inline policy in that file (not another embedded asset), extend the existing byte
limit test, and add assertions for exact actions/resources and absence of
baseline actions. CU1 therefore remains far below the direct-body limit.

## 4. Triggers and client re-pointing

- **CU1:** ship the admin route/job and production-key verifier. `latestGhcrTag` is advisory only; mutation names a signed manifest digest.
- **CU2:** `appliance cloud update` calls the route and polls the job. `--local`
  preserves today's `runCloudSystemUpdate` for break glass. Cloud baseline update
  remains local and separately named. Desktop “Check for updates” calls the same
  SDK route only when `profile.installGeneration === 'cloudformation-v1'`; frozen legacy installs retain `updateApiServer` sidecar for
  the two-release window. `updateBaseline` stays host-side (`packages/app/src/lib/host.ts:212-242`;
  `packages/cli/src/appliance-cloud-update.ts:20-25`).
- **CU3:** an opt-in EventBridge rule invokes the worker. Policy is `off` (no
  check), `notify` (persist/surface `availableVersion`, never mutate), or `auto`
  (enqueue the same image job). `auto` applies IMAGE updates only; baseline drift
  is notification-only and `runCloudBaselineUpdate` remains operator-side.

## 5. microVM mechanism (MV1)

`appliance vm update [--name NAME] [--version VERSION]` downloads the matching
musl guest asset on the host. Require a release SHA-256 plus a Sigstore bundle
whose GitHub OIDC identity is pinned to the release workflow: a checksum fetched
beside its binary detects corruption but does not authenticate the publisher.
The host verifies signature, identity, digest, architecture, and version before
opening the VM channel; the guest independently verifies exact byte count and
SHA-256 before making the root-owned candidate executable.

Extend the existing owner-only VZ vsock one-shot transport
(`packages/vm/src/backend/vz/shell.rs:1-55`) with a non-PTY artifact receive mode;
do not push binary bytes through the interactive PTY. WSL uses its existing
size-plus-SHA streaming primitive (`packages/vm/src/backend/wsl.rs:624-704`).

Store releases under `/persist/appliance/control-plane/releases/<version>/` with
`current`, `previous`, and `pending` symlinks changed by atomic rename. Extend
`APISERVER_COMMON` into the supervisor state machine: launch `pending`, poll
guest-loopback `/bootstrap/status` for two minutes and require its target version;
on success promote it, and on exit/bad health restore `previous` and respawn.
The updater asks the supervisor to restart; it never kills the only retained
known-good bytes.

Boot-media and WSL copy become seed-only: import a verified media asset when no
persistent release exists, but never overwrite `current`. The 60-second legacy
Deployment quarantine remains independent. Selector-less Service/Ingress and SA
token wiring do not change. The skew doctor changes remediation from reboot to
`appliance vm update`; it reports host-staged, persistent-current, and running
versions. Desktop invokes the same host transport and replaces “restart the Dev
Machine” with an update action. VZ and WSL must pass identical supervisor tests.

## 6. Failure matrix

| Method / failure                           | Detection                     | Automatic action                   | Next update path                   |
| ------------------------------------------ | ----------------------------- | ---------------------------------- | ---------------------------------- |
| Cloud mirror/auth/disk budget              | crane exit/deadline           | no stack mutation                  | current signed route               |
| Cloud CFN resource failure                 | stack terminal status         | CFN built-in rollback              | restored/current route             |
| Cloud server starts but is wrong/unhealthy | versioned bootstrap probe     | re-pin `previousImage`             | restored signed route              |
| Cloud worker code changes mid-job          | expected Lambda behavior      | old invocation continues           | new worker handles next job        |
| Cloud re-pin submission transient          | stack-state check/retry       | retry, then CFN runs independently | `--local` break glass if exhausted |
| microVM download/signature/hash failure    | host verifier                 | do not transport/swap              | old guest route/CLI command        |
| microVM candidate crash or probe timeout   | supervisor                    | restore `previous`, respawn        | `appliance vm update`              |
| microVM reboot with stale media            | persistent release exists     | ignore media seed                  | persistent supervisor path         |
| microVM transport interruption             | `.partial` size/hash mismatch | discard candidate                  | retry host command                 |

## 7. Test and owner live-verification plan (input to AP-223)

Automate route signature/validation, CAS conflict and idempotency, durable phase
transitions, redaction, server-to-worker signing, crane argv/no-shell behavior,
digest pinning, prior-image nonblank guard, exact `UpdateStack` request, CFN
failure rollback, failed-health re-pin, worker timeout budget, and N/N-1 job reads.
Template tests parse YAML, enforce size, and snapshot the exact allow-list.

For MV1 test bad signature, wrong arch/version/hash, interrupted transfer, atomic
rename, candidate crash/hang/wrong-version, rollback health, stale boot media,
watchdog coexistence, doctor output, and VZ/WSL parity.

Owner live verification: install a disposable cloud stack; update N→N+1 and
observe job/version; reject a concurrent job; deny baseline APIs using assumed
role; deploy a boot-failing image and observe CFN rollback; deploy a healthy-HTTP
wrong-version image and observe automatic re-pin; then retry a good update. For
microVM, update without reboot, inject a crashing candidate, confirm automatic
rollback and a subsequent good update, then reboot with stale media and confirm
the persistent good version survives.

## 8. Sequencing and effort

| Card | Scope                                                                   | Depends on            | Effort |
| ---- | ----------------------------------------------------------------------- | --------------------- | ------ |
| CU1  | cloud route/job, worker executor, crane mirror, scoped role, CFN/re-pin | S1                    | L      |
| CU2  | CLI/desktop/SDK re-point plus `--local`                                 | CU1                   | M      |
| CU3  | EventBridge and `off/notify/auto` policy                                | CU1; after CU2        | M      |
| MV1  | verified transport, persistent supervisor, UX, VZ/WSL parity            | S1; parallel with CU1 | XL     |

AP-223 consumes the live steps after CU1/MV1 test environments exist.

## 9. Open owner fork

**Guest trust root (Sasha gate):** approve keyless Sigstore verification pinned to
the GitHub release-workflow identity (recommended), or require an offline Appliance
release key and rotation/revocation procedure. MV1 must not ship unattended binary
swap with checksum-only verification.
