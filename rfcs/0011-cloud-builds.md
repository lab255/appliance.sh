# RFC 0011: Cloud Container Builds (the Installation's Builder)

- **Status:** Draft
- **Created:** 2026-07-07

## Summary

Every base builds app images server-side from an uploaded source zip — except cloud AWS, where no builder is provisioned. The api-server's cloud resolver already contains a complete BuildKit + ECR build path; it dies at one guard because `aws.buildkit.addr` is never populated:

```ts
// packages/api-server/src/services/build.service.ts:230-236
const buildkitAddr = aws.buildkit?.addr;
if (!buildkitAddr) {
  throw new Error(
    'Container builds need a builder, and this base has none configured (aws.buildkit.addr). ' +
      'Deploy a pre-built image with --image-uri instead.'
  );
}
```

This RFC provisions that builder: a **buildkitd service on ECS Fargate behind a public Network Load Balancer, authenticated with mutual TLS**, created by a new Pulumi component inside `ApplianceBaseAwsPublic`, with its address and TLS material flowing into the resolved base config as `aws.buildkit.{addr, tls}`. The api-server's `buildctl` invocation grows TLS flags. Everything else — zip intake from S3, Dockerfile generation, the two-step Lambda Web Adapter graft, ECR push, digest idempotency — already exists and is untouched.

After this lands, `appliance deploy --profile <cloud>` builds `container` and `framework` apps on the installation exactly like the microVM does locally, and `--image-uri` becomes an escape hatch instead of a requirement.

## Motivation

[RFC 0006](./0006-application-types-and-builds.md) §"Remote Build (Planned)" promised server-side builds. `docs/control-plane.md` §"Placement & builds" states the contract: _"the api-server builds images server-side with BuildKit — the in-VM buildkitd + in-VM registry locally, the installation's builder + ECR on cloud."_ The local half shipped (see `docs/microvm.md` §BuildKit: every VM provisions buildkitd, gRPC guest `:8372` forwarded to host `127.0.0.1:5054`). The cloud half is aspirational: `grep` finds no builder resource anywhere in `packages/infra` or `packages/install-aws` — only the ECR repository half exists (`ApplianceBaseAwsPublic.ts:258-285`).

The consequence today: cloud deploys of `container` apps (and `framework` apps that ship their own Dockerfile targeting the container path) require the user to build and push an image themselves and pass `--image-uri` — precisely the docker-on-the-laptop dependency the rest of the product just removed.

## Current state (read this first)

All paths relative to repo root. Line numbers as of the commit this RFC landed in; treat them as anchors, not gospel.

### The build pipeline that already works

| Piece                                        | Where                                                                               | Notes                                                                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Build record + presigned S3 PUT              | `packages/api-server/src/services/build-upload.service.ts:72-91`                    | Cloud zips land at `builds/<buildId>.zip` in the base's S3 `dataBucket`                                                                   |
| Zip download at resolve time                 | `packages/api-server/src/services/build.service.ts:129-135`                         | `GetObjectCommand` → temp dir                                                                                                             |
| Safe unzip + manifest read                   | `packages/api-server/src/services/image-build.service.ts:98-122`                    | needs `zipinfo` + `unzip` binaries                                                                                                        |
| Dockerfile generation (framework)            | `image-build.service.ts:124-230`                                                    | node/python detection, lockfile-aware                                                                                                     |
| `buildctl` invocation                        | `image-build.service.ts:237-268` (`buildImageWithBuildKit`)                         | `--addr <opts.addr>`, dockerfile.v0 frontend, `--output type=image,push=true`, digest from `--metadata-file`                              |
| ECR auth                                     | `build.service.ts:292-302` (`getEcrAuth`) → scoped `DOCKER_CONFIG` dir (`:240-248`) | buildctl forwards registry auth from the **client side** via the BuildKit session — the remote daemon needs no ECR credentials of its own |
| Cloud container resolve (two-step LWA graft) | `build.service.ts:211-290` (`resolveContainer`)                                     | Step 1 builds the app image; Step 2 wraps it with the Lambda Web Adapter (`FROM <LWA_IMAGE> AS adapter …`, `:263-282`) and pushes to ECR  |
| The honest error                             | `build.service.ts:230-236`                                                          | the only thing standing between the code above and a working cloud build                                                                  |
| SDK schema stub                              | `packages/sdk/src/models/appliance-base.ts:271-275`                                 | `aws.buildkit.addr` already defined: _"When absent, container deploys must pass --image-uri"_                                             |

The Kubernetes twin of this path (`resolveKubernetesUpload`, `image-build.service.ts:306-335`) is the reference implementation: same `buildctl`, different addr and registry.

### The infra that exists

`packages/infra` (Pulumi, live) — NOT `packages/install-aws` (CDK, placeholder Hello-World Lambdas; do not build there).

- `src/lib/appliance-infra.ts` — `applianceInfra({ bases })`, one controller per base type.
- `src/lib/aws/ApplianceBaseAwsPublic.ts` — **the installation**. Per base: Route53 zone, ACM wildcard cert, CloudFront + Lambda@Edge SigV4 router → Lambda Function URLs, S3 `dataBucket` (`:149-186`) + `stateBucket`, KMS key, system IAM roles (`systemApiServerRole`/`systemWorkerRole`, both `AdministratorAccess`, `:225-256`), **ECR repository** (`:258-285`), SSM SecureString `/appliance/base/<name>/config` with the resolved base config (`:668-676`), emitted `this.config` (`:639-666`).
- `src/lib/aws/ApplianceStack.ts` — per-app deploy component (Lambda Image/Zip, Function URL, DNS).
- `src/lib/ApplianceDeploymentService.ts` — Pulumi Automation API wrapper the cloud worker uses.
- **There is no VPC anywhere.** `ApplianceBaseAwsVpc.ts` is an empty stub (`:16-24`). The api-server and worker run as non-VPC Lambdas (deployed as ordinary appliances by bootstrap phase 2, `packages/bootstrap/src/phases/phase2.ts:293-326`).

### The bootstrap flow

`appliance bootstrap` → `packages/bootstrap/src/run.ts` → `engines/workspace.ts` runs three phases: **1** base infra via `applianceInfra` on a local-file Pulumi backend (`phases/phase1.ts`), **2** hoist the api-server/worker onto the installation via the public deploy API (`phases/phase2.ts`), **3** promote Pulumi state to S3 (`phases/phase3.ts`). Teardown reverses it. A builder provisioned _inside_ `ApplianceBaseAwsPublic` rides phase 1 and teardown for free — **no new bootstrap phase is needed**.

## Design

### Decision: managed buildkitd on Fargate + public NLB + mTLS

The api-server code assumes a **buildctl-reachable gRPC endpoint** (`BuildKitBuildOptions.addr`). The lowest-friction cloud builder is therefore a real buildkitd daemon, not a build _service_ abstraction:

1. **ECS Fargate service** (new cluster, 1 task, default 1 vCPU / 4 GB / 50 GiB ephemeral) running `moby/buildkit:v0.<pinned>` with `--addr tcp://0.0.0.0:8372` and TLS flags. Port 8372 matches the in-VM guest convention (`docs/microvm.md:287-296`).
2. **Public NLB** (TCP :8372 → target group → the task). Public because the worker Lambda is **not VPC-attached** and this RFC keeps it that way (see Alternatives).
3. **Mutual TLS** is the entire authorization story: buildkitd runs with `--tlscacert/--tlscert/--tlskey` and only presents/accepts certs from the installation's private CA. An unauthenticated buildkitd is remote code execution as the daemon — the NLB being public is acceptable _only_ with client-cert verification on. No cert, no session.
4. **Certificates from Pulumi's `tls` provider** (no external CA): a self-signed CA → one server cert (SANs: the NLB DNS name) → one client cert. Private material lives only in the base config SSM SecureString (already KMS-encrypted) and in the buildkitd task's secrets.

### Why the existing auth model keeps working

BuildKit sessions forward registry credentials **from the buildctl client**, and the worker already builds a scoped `DOCKER_CONFIG` from `getEcrAuth()` (`build.service.ts:240-248`). So the remote daemon pushes to ECR using the worker's token, and the builder task role needs **no ECR permissions**. Build context also travels over the session (`--local context=…`), so the daemon does not need S3 access either. The builder task role is empty except CloudWatch logs.

### Config schema

Extend `packages/sdk/src/models/appliance-base.ts` — both the **input** schema and the **resolved** config (mirror how `kubernetes.buildkit` is declared at `:169-173` / `:341-345`):

```ts
aws: {
  // existing …
  buildkit?: {
    /** buildctl-reachable gRPC endpoint, e.g. "tcp://<nlb-dns>:8372". */
    addr: string;
    /** mTLS material, PEM. Present iff addr is a tls endpoint. */
    tls?: {
      ca: string;       // CA cert buildctl verifies the server against
      cert: string;     // client cert presented to buildkitd
      key: string;      // client key (secret)
    };
  };
}
```

`aws.buildkit.addr` already exists in the schema — only `tls` is new. Keep the whole `buildkit` block optional: an installation bootstrapped `--no-builder` (below) simply omits it and the honest error remains, unchanged.

### New Pulumi component: `BuildKitBuilder`

New file `packages/infra/src/lib/aws/BuildKitBuilder.ts`, instantiated from `ApplianceBaseAwsPublic` (regional provider). Resources, in dependency order:

1. **VPC for the builder only** — minimal: one /16, 2 public subnets across 2 AZs, IGW, public route table. No NAT (the task gets a public IP for image pulls from Docker Hub/ECR-public). `awsx` is not a dependency in this package; write the handful of resources by hand like the rest of the file.
2. **TLS chain** (`@pulumi/tls`, new dep for `packages/infra`): `PrivateKey`+`SelfSignedCert` (CA, ~10y), server key+cert signed by the CA with `dnsNames: [nlb.dnsName]`, client key+cert signed by the CA. Mark keys as Pulumi secrets.
3. **Secrets Manager secret** (or SSM SecureString — match the file's existing preference for SSM) holding `{serverCert, serverKey, caCert}` for the task.
4. **ECS cluster + task definition + service**:
   - container `moby/buildkit:<pinned tag>`, entrypoint writes the three PEMs from the secret (injected as env vars via `secrets:`) to `/certs/…` then execs `buildkitd --addr tcp://0.0.0.0:8372 --tlscacert /certs/ca.pem --tlscert /certs/server.pem --tlskey /certs/server-key.pem`;
   - `privileged` is unavailable on Fargate — buildkitd must run **rootless** (`moby/buildkit:…-rootless`, `--oci-worker-no-process-sandbox`) — this is the documented Fargate pattern; note it clearly in the component;
   - ephemeral storage 50 GiB (BuildKit cache lives and dies with the task; acceptable v1 — see Future work);
   - awslogs log group `/appliance/<base>/buildkit`.
5. **NLB** + TCP listener :8372 + target group (target type `ip`, health check TCP) + security group allowing :8372 from 0.0.0.0/0 (mTLS is the gate).
6. **Outputs**: `addr` (`tcp://<nlb dns>:8372`), `caCertPem`, `clientCertPem`, `clientKeyPem` (secret).

Wire into `ApplianceBaseAwsPublic`:

- gate on a new component arg `builder?: boolean` (default **true**) threaded from `BootstrapInput` (`packages/bootstrap/src/types.ts`) and a CLI flag `appliance bootstrap --no-builder`;
- merge outputs into `this.config` (`ApplianceBaseAwsPublic.ts:639-666`): `aws.buildkit = { addr, tls: { ca, cert, key } }`. The config already lands in the SSM SecureString (`:668-676`) and flows to the api-server/worker as `APPLIANCE_BASE_CONFIG`, so **no new plumbing** is needed downstream of the config object.

### api-server changes

1. **`buildImageWithBuildKit`** (`image-build.service.ts:237-268`): extend `BuildKitBuildOptions` with `tls?: { ca, cert, key }`. When present, write the PEMs to the build's temp dir (`0600`) and append `--tlscacert/--tlscert/--tlskey` to the argv. Nothing else changes — same frontend, same output, same metadata digest.
2. **`resolveContainer`** (`build.service.ts:211-290`): replace the guard body — when `aws.buildkit?.addr` exists pass `{ addr, tls: aws.buildkit.tls }` into both build steps; when absent keep the existing honest error verbatim (it is now the `--no-builder` path, not a lie).
3. **`resolveFramework`** (`build.service.ts:168-195`): unchanged this RFC — framework-on-Lambda deploys as a Zip and never needed the builder. (Framework-as-container on cloud is out of scope; the manifest currently routes cloud framework apps to Lambda Zip.)
4. **Worker image**: the cloud api-server/worker container image must carry `buildctl` (client only, from the `moby/buildkit` release tarball), plus `unzip`/`zipinfo` which the zip intake shells out to (`image-build.service.ts:98-115`). Find the image's Dockerfile under `packages/api-server` (it is the artifact phase 2 mirrors GHCR→ECR; see `packages/cli/src/utils/api-server-artifact.ts` for how the local guest binary is staged — the **cloud** image build is a separate Dockerfile). Verify `zipinfo` is present in the base distro (`busybox unzip` does NOT provide it — use the real `unzip` package).
5. **Build timeout/limits**: Lambda workers cap at 15 min. `runCapture` has no timeout today — add one (default 12 min, `APPLIANCE_BUILD_TIMEOUT_MS`) so a hung remote build fails inside the Lambda budget with a readable error instead of a Lambda timeout.

### CLI / bootstrap surface

- `appliance bootstrap`: new `--no-builder` flag → `BootstrapInput.aws.builder = false` → component arg. Default on.
- `appliance teardown`: nothing — the builder is part of the base stack.
- Phase-2 runtime needs no change (the builder is not on the api-server's request path; it's dialed lazily during deploys).

### Failure modes & UX

| Failure                                         | Surface                                                                                                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Builder not provisioned (`--no-builder`)        | existing honest error, unchanged                                                                                                                      |
| NLB up, task still starting                     | buildctl connect timeout → wrap with: `the installation's builder is not answering (aws.buildkit.addr) — it may still be starting; retry in a minute` |
| Cert mismatch (rotated base config, stale task) | TLS handshake error → same wrapped hint + `appliance bootstrap` re-run note                                                                           |
| Build OOM/dies                                  | buildctl non-zero → existing tail-25-lines error path (`runCapture`, `image-build.service.ts:271-291`)                                                |

### Cost

Always-on v1: 1 Fargate task (1 vCPU/4 GB) ≈ $36/mo + NLB ≈ $16/mo + negligible logs/secrets. Called out in the bootstrap summary output so it isn't a surprise; `--no-builder` opts out entirely. Scale-to-zero is Future work, not v1 — it needs a start-on-demand hook in the worker and adds a ~60 s cold start to the first build.

## Implementation plan (suggested order)

1. **SDK**: `aws.buildkit.tls` in input + resolved schemas; spec in `appliance-base.spec.ts` next to the existing `kubernetes.buildkit` case (`:68`).
2. **api-server**: TLS-aware `buildImageWithBuildKit` (+ unit spec: argv assembly with/without tls, PEM files written 0600); guard rewrite in `resolveContainer`; `runCapture` timeout. There is **no spec file for `build.service.ts` today** — add one at least for the guard/addr/tls plumbing with the AWS SDK mocked.
3. **infra**: `BuildKitBuilder.ts` + `@pulumi/tls` dep + instantiation/config merge in `ApplianceBaseAwsPublic`; `pulumi preview` against a scratch stack.
4. **bootstrap/CLI**: `--no-builder` flag threading.
5. **Worker image**: buildctl + unzip/zipinfo; version-pin buildctl to the daemon's minor.
6. **Docs**: `docs/control-plane.md` §"Placement & builds" (drop the "aspirational" caveat), RFC 0006's "Remote Build (Planned)" section, CHANGELOG.
7. **Live verification** (needs an AWS account): `appliance bootstrap` a scratch installation → `appliance deploy` `examples/demo-node-container` and `examples/demo-python-container` with `--profile <cloud>` → confirm two-step LWA graft lands and the Function URL serves → redeploy unchanged source → confirm digest idempotency short-circuits → `appliance teardown`.

## Alternatives considered

- **VPC-attach the worker Lambda + private builder.** Cleaner network story, but it drags the whole Lambda fleet into VPC land (subnets, NAT gateway ≈ $32/mo + per-GB, ENI cold starts) and `ApplianceBaseAwsPublic` is deliberately VPC-free today. mTLS on a public NLB gives equivalent authz with a fraction of the moving parts. Revisit if/when a VPC base (`ApplianceBaseAwsVpc`) becomes real — the builder component should then accept existing subnets.
- **AWS CodeBuild as the builder.** Managed, scales to zero, but it is not a buildctl endpoint: `resolveContainer` would need a second resolver path (start build, poll, stream logs), the LWA two-step graft would need to move into buildspec, and local/cloud parity of the build path — the whole point of the unified pipeline — is lost. Rejected for v1.
- **kaniko / buildah inside the worker Lambda.** No daemon to run, but Lambda's 15-min cap, 10 GB image, read-only rootfs (kaniko needs its own executor image), and no privileged mode make this fragile; and it abandons BuildKit cache reuse entirely.
- **EC2 instead of Fargate.** Cheaper steady-state and allows the non-rootless daemon, but adds AMI/patching/SSH surface the product otherwise doesn't have. Fargate rootless is the better ops trade.

## Open questions

1. **Rootless buildkitd limits on Fargate** — some Dockerfiles (privileged RUN, chown-heavy) behave differently rootless. Acceptable for v1? (The in-VM daemon is rootful, so there is a parity gap to document.)
2. **Cache persistence** — ephemeral-only cache means every task restart is a cold build. EFS mount or `--export-cache type=registry` into ECR are both viable later; registry cache also survives scale-to-zero.
3. **Cert rotation** — Pulumi `tls` certs are long-lived; re-running `appliance bootstrap` rotates them atomically (config + task secret update together). Is that story enough, or does the builder need independent rotation?
4. **Multi-arch** — the resolver currently passes `--opt platform=` opaquely; Lambda supports arm64 and x86_64. A single Fargate task builds its own arch natively and cross-arch via QEMU-less emulation is unavailable rootless. v1: pin the builder task arch to x86_64 and pass `--opt platform=linux/amd64`; document.

## Appendix: verification cheat-sheet for the implementer

```bash
# after bootstrap, from the repo:
aws ssm get-parameter --name /appliance/base/<name>/config --with-decryption   # aws.buildkit populated?
buildctl --addr tcp://<nlb>:8372 --tlscacert ca.pem --tlscert client.pem --tlskey key.pem debug workers
appliance deploy demo /examples/demo-node-container --profile <cloud>          # end-to-end
```
