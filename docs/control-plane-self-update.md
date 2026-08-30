# Control-plane self-update (AP-218)

**Status:** S1 written decision, re-baselined on `main` at `673be14`. This is a design, not an implementation. Scope is the
control-plane image/binary only: cloud first, then microVM. Cloud baseline changes remain operator-side in `runCloudBaselineUpdate`.

## 0. Ground truth at `673be14`

| Fact                                                                                                                   | Evidence                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The CFN template has one `ImageUri`, guarded by `HasImage`.                                                            | `packages/install-aws/template/appliance-cloudformation.yaml:9-19`                                                                                                                |
| The worker and server are image Lambdas; the worker has 900 seconds.                                                   | `packages/install-aws/template/appliance-cloudformation.yaml:162-176,210-224`                                                                                                     |
| Both Function URLs are public transport (`AuthType: NONE`); app routes supply authentication.                          | `packages/install-aws/template/appliance-cloudformation.yaml:186-200,236-250`                                                                                                     |
| Both system execution roles currently attach `AdministratorAccess`.                                                    | `packages/install-aws/template/appliance-cloudformation.yaml:92-121`                                                                                                              |
| The stack owns its ECR repository.                                                                                     | `packages/install-aws/template/appliance-cloudformation.yaml:126-139`                                                                                                             |
| The YAML is embedded as text and tested against the 51,200-byte `TemplateBody` limit.                                  | `packages/install-aws/src/template.ts:1-6`; `packages/install-aws/src/template.spec.ts:12-15`                                                                                     |
| Today's CLI mirrors, changes `ImageUri`, waits for CFN, then health-polls; health failure only prints a rollback hint. | `packages/cli/src/appliance-cloud-update.ts:12-35`; `packages/install-aws/src/cloud-lifecycle.ts:64-103`                                                                          |
| Baseline update is a separate host operation that preserves `ImageUri`; resume never blanks it.                        | `packages/install-aws/src/cloud-lifecycle.ts:106-124`; `packages/install-aws/src/cloud-install.ts:197-203`                                                                        |
| `deployStack` sends `UpdateStack` and waits for completion.                                                            | `packages/install-aws/src/cloud-install.ts:394-409`                                                                                                                               |
| The old three-phase updater is frozen for non-CFN installs.                                                            | `packages/bootstrap/src/api-server-update.ts:78-89`; `packages/bootstrap/src/deprecation.ts:4-17`                                                                                 |
| The legacy system-role override is explicitly not the CFN path.                                                        | `packages/api-server/src/services/deployment-executor.service.ts:25-36,296-302`                                                                                                   |
| One app has `server` and `worker` modes; signed API routes are mounted only in server mode.                            | `packages/api-server/src/app.ts:32-42,72-89`                                                                                                                                      |
| `/bootstrap/status` exposes `serverVersion`; cluster-info exposes the same drift surface.                              | `packages/api-server/src/routes/bootstrap/index.ts:77-84`; `packages/api-server/src/routes/cluster-info/index.ts:9-17,42,95-108`                                                  |
| The cloud image still needs in-process Pulumi, and already contains crane with writable auth under `/tmp`.             | `packages/infra/src/lib/ApplianceDeploymentService.ts:3-6,25-26`; `packages/api-server/Dockerfile:32-38,95-108`                                                                   |
| The guest binary is release-built, host-staged, copied from boot media, and respawned.                                 | `.github/workflows/release-cli-binaries.yml:107-118,175-190`; `packages/cli/src/utils/api-server-artifact.ts:30-38,147-166,181-186`; `packages/vm/src/guest.rs:973-981,1154-1158` |
| The guest has stable SA credentials, selector-less routing, legacy quarantine, and shared WSL bootstrap.               | `packages/vm/src/guest.rs:1006-1012,1024-1060,1111-1118,1160-1198`; `packages/vm/src/backend/wsl.rs:694-704,955-967`                                                              |
| Current skew UX says restage/reboot rather than update in place.                                                       | `packages/cli/src/utils/runtime-doctor.ts:438-488`; `packages/app/src/components/cluster-compat-banner.tsx:28-48`                                                                 |

App Runtime (`appliance runtime ...`, the pooled `appliance-runtime` VM) does not run the api-server and is out of scope.

## 1. Safety invariant

> A failed update must never prevent the next update.

- **Cloud:** CFN resource failure rolls back; post-CFN health failure makes the still-running worker re-pin the non-empty prior image.
  A new signed request must then be accepted by the restored server.
- **microVM:** the supervisor retains the prior verified binary until candidate health passes. Failure restores `current` and restarts;
  boot must not overwrite that known-good release with stale media.
- **Trigger:** jobs are persisted before dispatch and never depend on the initiating HTTP connection surviving a restart.

Lambda alias/two-slot cutover would narrow the cloud interruption window, but is future hardening, not a CU1 prerequisite.

## 2. Cloud mechanism (CU1)

### Route and job contract

`POST /api/v1/self-update` is RFC-9421 signature-authenticated. Its body is `{"targetVersion":"1.2.3"}`; only exact semver release
tags are accepted. The server creates a CAS-protected job and returns `202 {jobId,status:"queued",statusUrl}`. Repeating an
idempotency key returns that job. A non-terminal job causes `409 {jobId,statusUrl}`.

`GET /api/v1/self-update/:jobId` is signed and returns `queued | mirroring | updating | health-checking | re-pinning | succeeded |
failed`, target/prior versions and images, timestamps, and redacted error. Jobs live in S3 ObjectStore; one CAS lease is the lock.

The server re-signs `POST /api/internal/jobs/self-update` to `WORKER_URL`, following the existing fire-and-continue dispatch
(`packages/api-server/src/services/deployment.service.ts:21-25,136-188`). Only worker mode executes it. Caller and job id are audited.

### Mirror, update, and recovery

Use **crane**, not a new ECR-SDK layer copier. `crane cp` solves cross-registry manifests and layer uploads without Docker and keeps
only auth in `/tmp`; an SDK copier would recreate OCI negotiation, streaming, and multi-arch selection. CU1 pins the crane release.

The worker copies the requested platform digest from GHCR to installation ECR and uses its digest-pinned URI, never materializing the
image in Lambda's 4-GiB filesystem. First it describes the stack, rejects blank `ImageUri`, and records prior/target/template identity.

It calls `UpdateStack` with `UsePreviousTemplate: true`; only `ImageUri` is new and all other parameters use `UsePreviousValue: true`.
No template or IAM capability enters this path. CFN's normal rollback handles resource-update failure.

The parameter updates both functions, so CFN does not promise worker-before-server ordering. None is needed: Lambda preserves the
in-flight old worker invocation, which owns the job. Keep the schema N/N-1 compatible; no new worker invocation finishes this job.

After `UPDATE_COMPLETE`, the old worker polls unauthenticated `GET /bootstrap/status` every five seconds for two minutes. Success is
HTTP 200 with `initialized: true` and the target `serverVersion`. The 900 seconds budget 3m mirror, 5m CFN, 2m health, and 5m recovery.

On probe failure the worker repeats the previous-template, ImageUri-only update with `previousImage`, waiting for a stable stack and
retrying submission. CFN continues after worker exit. A restored prior version yields `failed`/`recovered: true`; exhaustion is
page-worthy and `--local` remains break glass. This is weaker than aliases only during the bounded bad-image window.

## 3. IAM decision and draft

CU1 adds conditional `SelfUpdateRole` in the template, assumed only by `SystemWorkerRole`; a separate `AWS::IAM::Policy` grants only
`sts:AssumeRole` on it and avoids a dependency cycle. Update AWS clients require the assumed credentials, never the default chain.

Its trust policy is:

```yaml
Version: '2012-10-17'
Statement:
  - Effect: Allow
    Principal:
      AWS: !GetAtt SystemWorkerRole.Arn
    Action: sts:AssumeRole
```

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
      - ecr:InitiateLayerUpload
      - ecr:PutImage
      - ecr:UploadLayerPart
    Resource: !GetAtt ImageRepository.Arn
  - Sid: UpdateOnlyThisStack
    Effect: Allow
    Action:
      - cloudformation:DescribeStacks
      - cloudformation:UpdateStack
    Resource: !Ref AWS::StackId
  - Sid: MutateOnlySystemFunctionCode
    Effect: Allow
    Action:
      - lambda:GetFunction
      - lambda:UpdateFunctionCode
    Resource:
      - !GetAtt WorkerFunction.Arn
      - !GetAtt ApiServerFunction.Arn
  - Sid: PassOnlyExistingSystemLambdaRoles
    Effect: Allow
    Action: iam:PassRole
    Resource:
      - !GetAtt SystemWorkerRole.Arn
      - !GetAtt SystemApiServerRole.Arn
    Condition:
      StringEquals:
        iam:PassedToService: lambda.amazonaws.com
```

IAM cannot express “only this parameter changed.” The enforcement is layered:
the updater never accepts a template and uses `UsePreviousTemplate`; the role
lacks IAM/Route53/S3/KMS resource mutation and cannot apply a baseline; its
underlying CFN permissions can only change code on the two named functions.
Tests must assert both the request shape and denied baseline mutations.

Residual: both system execution roles still have `AdministratorAccess` for existing deploy behavior (`§0`). The scoped assumed role makes
the self-update path least-privilege and auditable, but does not claim to contain arbitrary code execution in today's admin worker.

The current YAML is 8,695 bytes versus 51,200 bytes. Keep the role and compact
inline policy in that file (not another embedded asset), extend the existing byte
limit test, and add assertions for exact actions/resources and absence of
baseline actions. CU1 therefore remains far below the direct-body limit.

## 4. Triggers and client re-pointing

- **CU1:** ship the signed route and server-side `latestGhcrTag`; latest lookup
  may suggest a version, but mutation always names an immutable target digest.
- **CU2:** `appliance cloud update` calls the route and polls the job. `--local`
  preserves today's `runCloudSystemUpdate` for break glass. Cloud baseline update
  remains local and separately named. Desktop “Check for updates” calls the same
  SDK route; `updateApiServer`/`latestApiServerVersion` stop using the sidecar,
  while `updateBaseline` stays host-side (`packages/app/src/lib/host.ts:212-242`;
  `packages/desktop/src-tauri/src/lib.rs:2453-2462`).
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
