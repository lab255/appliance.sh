import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApplianceClient, PINNED_RELEASE_TRUST, VERSION, type ReleaseTrustPolicy } from '@appliance.sh/sdk';
import { apiServerUrlForHostPort, IN_CLUSTER_API_SERVER_HOSTNAME, mintApiKey } from '@appliance.sh/helper';
import { readProfiles, removeProfile, upsertProfile, type Profile } from './profile-store.js';
import {
  type CredentialMigrationConflict,
  type ProfileCredentialProbe,
  probeProfileCredential,
  readCredentialMigrationConflicts,
  resolveProfileSecret,
} from './credential-store.js';
import { DEFAULT_VM_NAME, LEGACY_MICROVM_PROFILE, profileForVm, resolveVmBinary, vmDir } from './microvm-up.js';
import { guestAssetsDir } from './api-server-artifact.js';

// Runtime doctor: "why doesn't my ALREADY-SET-UP runtime work?" — the
// second half of `appliance doctor`. The preflight (preflight.ts) asks
// whether a fresh machine CAN run Appliance; this module diagnoses the
// running system: dead/unknown API keys (the opaque-401 class), clock
// skew, orphaned or cross-wired credential profiles, duplicate ingress
// claims, stale guest binaries, and profiles↔Keychain drift.
//
// Layering mirrors the codebase's decide_heal/needs_mint idiom: every
// verdict is a PURE function over probed inputs (unit-tested), and the
// IO shell (`runRuntimeDoctor`) only gathers inputs and renders
// findings. Engine-side probes (guest clock, in-guest api-server
// liveness) come from `appliance-vm doctor --vm-checks --json`, which
// emits findings in this exact schema; old engines that predate the
// flag are feature-detected and skipped gracefully.

/** Severity ladder shared with the engine's findings (and, later, the
 *  desktop panel — keep this schema stable). */
export type Severity = 'ok' | 'info' | 'warn' | 'fail';

/** THE runtime finding schema. The engine (packages/vm/src/doctor.rs)
 *  serializes the same shape; the desktop will mirror it. */
export interface RuntimeFinding {
  /** Stable identifier, e.g. `engine:clock-skew`, `profile:local`. */
  id: string;
  /** Short human label rendered as the checklist row title. */
  title: string;
  severity: Severity;
  /** One-line detail (what was probed, what was found, why it failed). */
  detail?: string;
  /** Actionable fix — the exact command/step the operator can run. */
  remediation?: string;
  /** Machine-actionable fix attached to this finding. `kind` names the
   *  fixer; `applied` reports whether doctor ran it (only `--fix` runs
   *  fixers — a plain doctor is read-only; report-only findings carry
   *  no fix at all). */
  fix?: { kind: string; applied?: boolean };
}

export interface RuntimeFixOutcome {
  label: string;
  status: 'fixed' | 'skipped' | 'failed';
  detail: string;
}

export interface RuntimeDoctorReport {
  vm: string;
  findings: RuntimeFinding[];
  fixes: RuntimeFixOutcome[];
  /** True when no finding is a hard `fail`. */
  ok: boolean;
  /** The running api-server's version, when the signed probe reached it. */
  serverVersion?: string;
}

// ---- engine plumbing ------------------------------------------------------

/** The engine's `doctor --vm-checks` JSON report (packages/vm/src/doctor.rs). */
export interface EngineChecksReport {
  vm: string;
  engineVersion?: string;
  exists: boolean;
  running: boolean;
  /** Guest clock minus host clock, seconds (positive = guest ahead). */
  clockSkewSeconds?: number;
  /** Guest api-server key store state, when reachable in-VM. */
  bootstrapInitialized?: boolean;
  /** Boot-rendered MV1 launcher marker was found in the running guest. */
  controlPlaneUpdateCapable?: boolean;
  findings: RuntimeFinding[];
}

/** One row of `appliance-vm list`. */
export interface EngineVmEntry {
  name: string;
  running: boolean;
  hostPort: number;
}

/** `appliance-vm list`, with "engine binary missing/broken" kept
 *  distinct from "no VMs" — an absent engine must NEVER classify a
 *  profile as orphaned. */
export type EngineListing = { available: false } | { available: true; vms: EngineVmEntry[] };

/**
 * Parse (and VALIDATE) `appliance-vm list` output. Pure and unit-tested.
 * The listing gates the orphan/stale-port classifiers, whose fixes
 * WRITE to the profile store — so any malformed output (non-array,
 * entry without a string name or a finite hostPort) degrades the whole
 * engine to `{available:false}`: doctor reports it cannot verify,
 * instead of crashing or rewriting a healthy apiUrl to `:undefined`.
 */
export function parseEngineListing(stdout: string): EngineListing {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { available: false };
  }
  if (!Array.isArray(parsed)) return { available: false };
  const vms: EngineVmEntry[] = [];
  for (const entry of parsed) {
    const e = entry as { name?: unknown; running?: unknown; hostPort?: unknown } | null;
    if (typeof e?.name !== 'string' || typeof e.hostPort !== 'number' || !Number.isFinite(e.hostPort)) {
      return { available: false };
    }
    vms.push({ name: e.name, running: e.running === true, hostPort: e.hostPort });
  }
  return { available: true, vms };
}

function engineList(): EngineListing {
  const bin = resolveVmBinary();
  if (!bin) return { available: false };
  const r = spawnSync(bin, ['list'], { encoding: 'utf8', timeout: 15_000 });
  if (r.status !== 0 || r.error) return { available: false };
  return parseEngineListing(r.stdout);
}

/** Run the engine's runtime checks. Null when the engine is missing or
 *  predates `doctor --vm-checks` (feature-detect: unknown flags exit
 *  non-zero with no parseable JSON). Timeboxed: a wedged guest probe
 *  must not hang doctor forever. */
export function engineVmChecks(vm: string): EngineChecksReport | null {
  const bin = resolveVmBinary();
  if (!bin) return null;
  const r = spawnSync(bin, ['doctor', '--vm-checks', vm, '--json'], { encoding: 'utf8', timeout: 30_000 });
  if (r.error || r.status !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout) as EngineChecksReport;
    return Array.isArray(parsed.findings) ? parsed : null;
  } catch {
    return null;
  }
}

// ---- (d) profile ↔ VM bindings (pure) -------------------------------------

/** Map a credential profile to the microVM it belongs to, or null for a
 *  remote profile. Unlike cluster-target's vmNameForProfile this also
 *  maps the CLI-canonical `local` profile (the default VM's primary id
 *  — see profileForVm), so the default VM's binding is actually
 *  checked. */
export function doctorVmForProfile(profileName: string): string | null {
  if (profileName === 'local' || profileName === LEGACY_MICROVM_PROFILE) return DEFAULT_VM_NAME;
  if (profileName.startsWith('microvm-')) return profileName.slice('microvm-'.length);
  return null;
}

/** The TCP port an apiUrl points at (http default 80), or null when
 *  unparseable. */
export function portOfApiUrl(apiUrl: string): number | null {
  try {
    const url = new URL(apiUrl);
    if (url.port) return Number(url.port);
    return url.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

/** The hostname an apiUrl points at, or null when unparseable. */
export function hostnameOfApiUrl(apiUrl: string): string | null {
  try {
    return new URL(apiUrl).hostname;
  } catch {
    return null;
  }
}

export type ProfileBinding =
  | { kind: 'remote' }
  | { kind: 'foreign-url'; vmName: string; hostname: string | null }
  | { kind: 'engine-unavailable'; vmName: string }
  | { kind: 'ok'; vmName: string; port: number }
  | { kind: 'orphan'; vmName: string }
  | { kind: 'stale-port'; vmName: string; profilePort: number; vmPort: number }
  | { kind: 'cross-wired'; vmName: string; profilePort: number; vmPort: number; portOwner: string };

/**
 * Classify one profile against the engine's VM registry (check d):
 * what the client BELIEVES (profiles.json apiUrl) vs what is TRUE
 * (vm.json ports via `appliance-vm list`).
 *
 *   - profile maps to no VM               → remote, out of scope;
 *   - apiUrl hostname is not the Dev Machine hostname → foreign-url.
 *     CRITICAL: a VM-ish NAME alone proves nothing — `appliance server`
 *     (docker flow) writes a `local` profile at http://127.0.0.1:<port>
 *     with no VM behind it, and `appliance login` accepts any profile
 *     name. Only a profile whose URL host is the in-cluster api
 *     hostname (api.appliance.localhost) is treated as VM-bound;
 *     everything else is report-only and NEVER fixed;
 *   - engine missing/broken               → engine-unavailable. CRITICAL:
 *     never counted as VM-missing — a missing binary must not trigger
 *     the orphan fix;
 *   - VM absent from a SUCCESSFUL listing → orphan;
 *   - apiUrl port owned by ANOTHER VM     → cross-wired;
 *   - apiUrl port ≠ the VM's hostPort     → stale-port.
 */
export function classifyProfileBinding(profileName: string, apiUrl: string, engine: EngineListing): ProfileBinding {
  const vmName = doctorVmForProfile(profileName);
  if (!vmName) return { kind: 'remote' };
  const hostname = hostnameOfApiUrl(apiUrl);
  if (hostname !== IN_CLUSTER_API_SERVER_HOSTNAME) return { kind: 'foreign-url', vmName, hostname };
  if (!engine.available) return { kind: 'engine-unavailable', vmName };
  const vm = engine.vms.find((v) => v.name === vmName);
  if (!vm) return { kind: 'orphan', vmName };
  const profilePort = portOfApiUrl(apiUrl);
  if (profilePort === vm.hostPort) return { kind: 'ok', vmName, port: vm.hostPort };
  const owner = engine.vms.find((v) => v.name !== vmName && v.hostPort === profilePort);
  if (owner && profilePort !== null) {
    return { kind: 'cross-wired', vmName, profilePort, vmPort: vm.hostPort, portOwner: owner.name };
  }
  return { kind: 'stale-port', vmName, profilePort: profilePort ?? -1, vmPort: vm.hostPort };
}

// ---- (b) key liveness triangulation (pure) --------------------------------

/** What the signed cluster-info probe came back with. */
export type SignedProbe =
  | { kind: 'ok'; serverVersion: string | null }
  | { kind: 'http'; status: number }
  | { kind: 'network-error'; message: string };

export interface AuthProbeInput {
  /** Unauthenticated GET /bootstrap/status via the profile's apiUrl. */
  bootstrapReachable: boolean;
  signed: SignedProbe;
  /** Engine's guest-vs-host skew, when engine checks ran. */
  clockSkewSeconds: number | null;
  /** Whether ~/.appliance/vm/<vm>/bootstrap-token exists (the re-mint
   *  credential — without it there is no heal path). */
  bootstrapTokenPresent: boolean;
}

/** The api-server's signature clock tolerance (sdk signing index.ts). */
export const SIGNATURE_TOLERANCE_SECS = 15;

/**
 * Triangulate the key-liveness verdict (check b). The server's 401 is
 * deliberately uniform across unknown-key/skew/digest (middleware/
 * auth.ts) — the diagnosis needs the side channels:
 *
 *   401 + skew < tolerance + /bootstrap/status reachable ⇒ the KEY is
 *   unknown to the server (dead-key class);
 *   401 + skew ≥ tolerance                                ⇒ the CLOCK.
 */
export function triangulateAuth(input: AuthProbeInput): RuntimeFinding {
  const id = 'runtime:api-key';
  const title = 'API key accepted by the api-server';
  if (!input.bootstrapReachable) {
    return {
      id,
      title,
      severity: 'fail',
      detail: 'api-server unreachable through the ingress (unauthenticated /bootstrap/status did not answer)',
      remediation:
        'Is the VM up? `appliance vm up` — then `appliance vm console` if it stays unreachable. (If the engine probe above says the server answers IN the guest, suspect the ingress route or a port mismatch below.)',
    };
  }
  if (input.signed.kind === 'ok') {
    return { id, title, severity: 'ok', detail: 'signed request accepted' };
  }
  if (input.signed.kind === 'network-error') {
    return {
      id,
      title,
      severity: 'warn',
      detail: `signed request failed to complete (${input.signed.message}) although /bootstrap/status answers`,
      remediation: 'Retry; if it persists, check `appliance vm console` for api-server crashes.',
    };
  }
  if (input.signed.status !== 401) {
    return {
      id,
      title,
      severity: 'warn',
      detail: `signed request returned HTTP ${input.signed.status} (not an auth failure)`,
      remediation: 'Check the api-server log: `appliance vm shell -- cat /var/log/appliance-api-server.log`.',
    };
  }
  // A 401. Use the engine's skew probe to split key-vs-clock.
  if (input.clockSkewSeconds !== null && Math.abs(input.clockSkewSeconds) >= SIGNATURE_TOLERANCE_SECS) {
    return {
      id,
      title,
      severity: 'fail',
      detail: `signed request 401s and the guest clock is ${Math.abs(input.clockSkewSeconds)}s off the host — this is the CLOCK, not the key`,
      remediation:
        'Restart the VM (`appliance vm stop && appliance vm up`) — the engine re-syncs the guest clock at boot.',
    };
  }
  if (input.clockSkewSeconds !== null) {
    // Clock is fine and the server answers ⇒ the key is unknown to it.
    return {
      id,
      title,
      severity: 'fail',
      detail:
        'signed request 401s while the server is reachable and the clock is in tolerance — the server does not know this key (dead/rotated key store)',
      remediation: input.bootstrapTokenPresent
        ? 'Run `appliance doctor --fix` to re-mint a key with the VM bootstrap token.'
        : 'No bootstrap token at ~/.appliance/vm/<vm>/bootstrap-token — no automatic heal path. Recreate the VM: `appliance vm delete && appliance vm up`.',
      ...(input.bootstrapTokenPresent ? { fix: { kind: 'remint-key' } } : {}),
    };
  }
  // Ambiguous: without the engine's skew probe this could just as well
  // be clock skew — minting a key would not heal that and only orphans
  // another key in the store, so NO fix is attached (remediation only).
  return {
    id,
    title,
    severity: 'fail',
    detail:
      'signed request 401s (cause ambiguous: unknown key or clock skew — engine checks unavailable to distinguish)',
    remediation:
      'Update/rebuild appliance-vm so `doctor` can probe the guest clock (it separates a dead key from clock skew), or restart the VM (`appliance vm stop && appliance vm up`) and re-run.',
  };
}

// ---- (c) duplicate ingress (pure) ------------------------------------------

export interface IngressClaim {
  name: string;
  namespace: string;
  hosts: string[];
}

/** Flatten `kubectl get ingress -A -o json` into per-ingress host claims. */
export function extractIngressClaims(kubectlJson: unknown): IngressClaim[] {
  const items = (kubectlJson as { items?: unknown[] })?.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    const meta = (item as { metadata?: { name?: string; namespace?: string } }).metadata;
    const rules = (item as { spec?: { rules?: { host?: string }[] } }).spec?.rules;
    if (!meta?.name) return [];
    return [
      {
        name: meta.name,
        namespace: meta.namespace ?? 'default',
        hosts: (rules ?? []).map((r) => r.host).filter((h): h is string => Boolean(h)),
      },
    ];
  });
}

/** The canonical api-server ingress the guest bootstrap writes every
 *  boot (guest.rs): name/namespace/host are fixed. */
export const CANONICAL_API_INGRESS = { name: 'appliance-api-server', namespace: 'default' } as const;

/**
 * Assert exactly one claimant per hostname (check c). A duplicate claim
 * on `api.appliance.localhost` is the legacy-ingress class of failure:
 * traefik round-robins or misroutes, and clients see intermittent
 * 404/401. REPORT-ONLY by design — deleting cluster objects is the
 * operator's call; the remediation carries the exact command.
 */
export function classifyIngressClaims(claims: IngressClaim[], kubectlPrefix: string): RuntimeFinding[] {
  const byHost = new Map<string, IngressClaim[]>();
  for (const claim of claims) {
    for (const host of claim.hosts) {
      byHost.set(host, [...(byHost.get(host) ?? []), claim]);
    }
  }
  const findings: RuntimeFinding[] = [];
  const apiClaims = byHost.get(IN_CLUSTER_API_SERVER_HOSTNAME) ?? [];
  if (apiClaims.length === 0) {
    findings.push({
      id: 'runtime:ingress-api',
      title: `Ingress claim on ${IN_CLUSTER_API_SERVER_HOSTNAME}`,
      severity: 'warn',
      detail: 'no ingress claims the api-server hostname — the route is written at VM boot and may still be settling',
      remediation: 'If this persists after boot completes, restart the VM: `appliance vm stop && appliance vm up`.',
    });
  } else if (apiClaims.length === 1) {
    const c = apiClaims[0];
    findings.push({
      id: 'runtime:ingress-api',
      title: `Ingress claim on ${IN_CLUSTER_API_SERVER_HOSTNAME}`,
      severity: 'ok',
      detail: `exactly one claimant (${c.namespace}/${c.name})`,
    });
  } else {
    const extras = apiClaims.filter(
      (c) => !(c.name === CANONICAL_API_INGRESS.name && c.namespace === CANONICAL_API_INGRESS.namespace)
    );
    const victims = extras.length > 0 ? extras : apiClaims.slice(1);
    findings.push({
      id: 'runtime:ingress-api',
      title: `Ingress claim on ${IN_CLUSTER_API_SERVER_HOSTNAME}`,
      severity: 'fail',
      detail: `${apiClaims.length} ingresses claim the api-server hostname (${apiClaims
        .map((c) => `${c.namespace}/${c.name}`)
        .join(', ')}) — traefik can route requests to the wrong backend`,
      remediation: victims.map((c) => `${kubectlPrefix} delete ingress ${c.name} -n ${c.namespace}`).join(' && '),
    });
  }
  // Any other host with multiple claimants is suspicious too, but only
  // worth a warning — deploy hostnames are user-controlled.
  for (const [host, hostClaims] of byHost) {
    if (host === IN_CLUSTER_API_SERVER_HOSTNAME || hostClaims.length <= 1) continue;
    findings.push({
      id: `runtime:ingress:${host}`,
      title: `Ingress claim on ${host}`,
      severity: 'warn',
      detail: `${hostClaims.length} ingresses claim this hostname (${hostClaims
        .map((c) => `${c.namespace}/${c.name}`)
        .join(', ')})`,
      remediation: `Keep one: ${kubectlPrefix} delete ingress <name> -n <namespace>`,
    });
  }
  return findings;
}

// ---- (e) guest binary stamp (pure) ------------------------------------------

const normVersion = (v: string): string => v.replace(/^v/, '');

/**
 * Compare the staged guest-assets stamp (`<SDK VERSION>:<arch>`, written
 * by api-server-artifact.ts) against this CLI's version and the RUNNING
 * server's version (check e). serverVersion ≠ stamp means the VM booted
 * before the artifacts were restaged — the fix is a restart, not a
 * restage.
 */
export function compareVersionStamp(
  stamp: string | null,
  cliVersion: string,
  serverVersion: string | null,
  signingKeyId: string | null = null,
  releaseTrust: ReleaseTrustPolicy = PINNED_RELEASE_TRUST,
  updateCapable = false
): RuntimeFinding {
  const id = 'runtime:guest-stamp';
  const title = 'Guest api-server artifacts vs CLI / running server';
  if (!stamp) {
    return {
      id,
      title,
      severity: 'info',
      detail: 'no staged guest artifacts (stamp missing) — `appliance vm up` stages them before boot',
    };
  }
  if (stamp.startsWith('override:')) {
    return {
      id,
      title,
      severity: 'info',
      detail:
        'guest binary staged from an APPLIANCE_API_SERVER_BINARY override (dev build) — version comparison skipped',
    };
  }
  const pinnedKeys = Object.keys(releaseTrust.keys);
  const recognizedKey = signingKeyId !== null && Object.prototype.hasOwnProperty.call(releaseTrust.keys, signingKeyId);
  const trustDetail = recognizedKey
    ? `staged asset signed by keyId ${signingKeyId}`
    : signingKeyId && pinnedKeys.length === 0
      ? `signed release, CLI has no pinned trust — upgrade the CLI (keyId ${signingKeyId})`
      : signingKeyId
        ? `staged asset signed by an unrecognized key ${signingKeyId}`
        : pinnedKeys.length === 0
          ? 'staged asset unsigned pre-MV0 release; self-update disabled'
          : 'staged asset is unsigned even though production release trust is pinned';
  const trustSeverity: Severity | null = recognizedKey
    ? null
    : signingKeyId || pinnedKeys.length === 0
      ? 'warn'
      : 'fail';
  const stampVersion = stamp.split(':')[0] ?? '';
  if (serverVersion && normVersion(serverVersion) !== normVersion(stampVersion)) {
    return {
      id,
      title,
      severity: trustSeverity === 'fail' ? 'fail' : 'warn',
      detail: `running api-server is ${serverVersion} but the staged artifacts are ${stampVersion} — the VM booted before the restage; ${trustDetail}`,
      remediation: updateCapable
        ? 'Install the staged signed release without rebooting: `appliance vm update`.'
        : 'This launcher predates in-place update. Restage and reboot: `appliance vm stop && appliance vm up --cluster`.',
    };
  }
  if (normVersion(stampVersion) !== normVersion(cliVersion)) {
    return {
      id,
      title,
      severity: trustSeverity === 'fail' ? 'fail' : 'warn',
      detail: `staged guest artifacts are ${stampVersion} but this CLI is ${cliVersion}; ${trustDetail}`,
      remediation: 'Run `appliance vm up` — it restages the matching artifacts before boot.',
    };
  }
  return {
    id,
    title,
    severity: trustSeverity ?? 'ok',
    detail: serverVersion
      ? `CLI ${cliVersion} = staged ${stampVersion} = running ${serverVersion}; ${trustDetail}`
      : `CLI ${cliVersion} = staged ${stampVersion} (running server version unknown); ${trustDetail}`,
  };
}

// ---- (f) profiles ↔ Keychain coherence (pure) -------------------------------

export type KeychainProbe = ProfileCredentialProbe;

/**
 * Coherence between profiles.json metadata and the platform credential store
 * (check f). Windows applies this to every profile; macOS applies it only to
 * desktop-managed profiles. Linux and macOS CLI-managed profiles return null.
 */
export function classifyKeychainCoherence(
  profileName: string,
  profile: Pick<Profile, 'keyId' | 'secret'>,
  probe: KeychainProbe
): RuntimeFinding | null {
  if (probe.state === 'not-applicable') return null;
  const id = `keychain:${profileName}`;
  const title = `Credential store ↔ profiles.json ('${profileName}')`;
  const fileSecret = profile.secret.length > 0;
  if (probe.state === 'denied') {
    return {
      id,
      title,
      severity: 'info',
      detail: 'denied: the OS credential store could not be read; coherence is unknown',
    };
  }
  if (probe.state === 'helper-missing') {
    return {
      id,
      title,
      severity: 'fail',
      detail: 'helper-missing: the packaged Windows credential helper is not installed beside the CLI',
      remediation:
        'Reinstall the packaged Appliance CLI; credential access is supported only in the packaged sibling layout.',
    };
  }
  if (probe.state === 'malformed') {
    return {
      id,
      title,
      severity: 'fail',
      detail: 'malformed: the OS credential-store value is not a valid Appliance cluster credential',
      remediation: 'Re-login to replace it; Windows will not fall back to a cleartext file.',
    };
  }
  if (probe.state === 'conflict') {
    return {
      id,
      title,
      severity: 'fail',
      detail: `conflict: the OS store holds key ${probe.keyId}, but the legacy file holds different bytes`,
      remediation:
        'Re-login to choose the canonical credential; both copies were preserved and neither was overwritten.',
    };
  }
  if (probe.state === 'legacy-name') {
    return {
      id,
      title,
      severity: 'warn',
      detail: `legacy-name: the Keychain credential for key ${probe.keyId} still uses the unencoded profile name`,
      remediation: 'Run an authenticated command to migrate it to the canonical encoded Keychain account.',
    };
  }
  if (probe.state === 'missing') {
    if (fileSecret) {
      return {
        id,
        title,
        severity: 'warn',
        detail: 'missing: the OS credential entry is absent while profiles.json still carries a legacy secret',
        remediation: 'Run `appliance doctor --fix` to retry verified migration, or re-login if migration fails.',
        fix: { kind: 'keychain-writeback' },
      };
    }
    return {
      id,
      title,
      severity: 'fail',
      detail: 'missing: the OS credential entry and the on-disk secret are both absent; no usable secret remains',
      remediation:
        'Open the desktop app (its cluster sync re-writes the Keychain), or re-mint: `appliance doctor --fix` / `appliance vm up`.',
    };
  }
  // OS credential entry found and structurally valid (`migrated`).
  if (fileSecret) {
    if (probe.keyId !== profile.keyId) {
      // File fresher (chooseCredential's rule): a CLI rotate that
      // couldn't reach the Keychain. Writable back.
      return {
        id,
        title,
        severity: 'warn',
        detail: `profiles.json carries a NEWER key (${profile.keyId}) than the Keychain (${probe.keyId}) — a rotate that missed the Keychain`,
        remediation: 'Run `appliance doctor --fix` to write the fresh key to the Keychain.',
        fix: { kind: 'keychain-writeback' },
      };
    }
    return {
      id,
      title,
      severity: 'warn',
      detail: 'migrated: the OS store and profiles.json agree, but the verified cleartext scrub has not completed yet',
      remediation: 'Run an authenticated command to retry the idempotent scrub migration.',
    };
  }
  if (probe.keyId !== profile.keyId) {
    return {
      id,
      title,
      severity: 'warn',
      detail: `profiles.json metadata names key ${profile.keyId} but the Keychain holds ${probe.keyId} — stale metadata (desktop rekey not yet mirrored)`,
      remediation:
        'Usually self-heals via the desktop sync; if the CLI misbehaves, re-select the cluster in the desktop app.',
    };
  }
  return { id, title, severity: 'ok', detail: `migrated: OS credential entry matches keyId ${profile.keyId}` };
}

export function classifyCredentialMigrationConflict(conflict: CredentialMigrationConflict): RuntimeFinding {
  const fileList = conflict.files.map((file) => `'${file}'`).join(' or ');
  return {
    id: `credential-migration:${conflict.key}`,
    title: `Credential migration conflict (${conflict.key})`,
    severity: 'fail',
    detail: `Credential Manager and the legacy owner-only file differ; both copies were preserved at ${fileList}`,
    remediation: `Choose the authoritative credential. To keep Credential Manager, remove the conflicting legacy file exactly at ${fileList}, then re-run \`appliance doctor\`.`,
  };
}

export interface VmCredentialRulesFixture {
  vm: string;
  config: unknown;
}

/** Warn for every explicit capture rule on Windows. Capture persists the
 * selected header in the per-VM cleartext secret file, so the finding names
 * both routing dimensions an operator needs to locate and disable the rule. */
export function classifyWindowsCaptureRules(
  platform: NodeJS.Platform,
  fixtures: readonly VmCredentialRulesFixture[]
): RuntimeFinding[] {
  if (platform !== 'win32') return [];
  return fixtures.flatMap(({ vm, config }) => {
    const rules = (config as { rules?: unknown } | null)?.rules;
    if (!Array.isArray(rules)) return [];
    return rules.flatMap((rule) => {
      const candidate = rule as { capture?: unknown; host?: unknown } | null;
      if (candidate?.capture !== true || typeof candidate.host !== 'string' || !candidate.host.trim()) return [];
      const host = candidate.host.trim();
      return [
        {
          id: `credentials:capture:${encodeURIComponent(vm)}:${encodeURIComponent(host)}`,
          title: `Capture-mode credential rule (${vm} → ${host})`,
          severity: 'warn' as const,
          detail: `VM '${vm}' captures credentials for host '${host}' into cleartext egress-secrets.json; backups, same-user code, Administrator/SYSTEM, and applicable WSL file access remain residual risks`,
          remediation: `Disable capture for '${host}' in VM '${vm}' and remove any stored captured secret that is no longer needed.`,
        },
      ];
    });
  });
}

function readVmCredentialRulesFixtures(): VmCredentialRulesFixture[] {
  if (process.platform !== 'win32') return [];
  // This is intentionally an unverified diagnostic read: only hostnames escape
  // into findings, never captured credential values.
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  const root = path.resolve(home, '.appliance', 'vm');
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        try {
          const vmRoot = path.resolve(root, entry.name);
          if (path.dirname(vmRoot) !== root) return [];
          const credentialPath = path.resolve(vmRoot, 'egress-credentials.json');
          if (path.dirname(credentialPath) !== vmRoot) return [];
          if (fs.statSync(credentialPath).size > 1024 * 1024) return [];
          const raw = fs.readFileSync(credentialPath, 'utf8');
          return [{ vm: entry.name, config: JSON.parse(raw) }];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

// ---- bootstrap token ---------------------------------------------------------

export function bootstrapTokenPath(vm: string): string {
  return path.join(vmDir(vm), 'bootstrap-token');
}

/** Pure verdict for the bootstrap-token file (the only re-mint
 *  credential: without it a dead key has NO heal path). */
export function bootstrapTokenFinding(vm: string, present: boolean): RuntimeFinding {
  const id = 'runtime:bootstrap-token';
  const title = 'VM bootstrap token (the key re-mint credential)';
  if (present) {
    return { id, title, severity: 'ok', detail: `present at ~/.appliance/vm/${vm}/bootstrap-token` };
  }
  return {
    id,
    title,
    severity: 'warn',
    detail: `missing at ~/.appliance/vm/${vm}/bootstrap-token — if the API key is ever lost there is no heal path`,
    remediation: 'Run `appliance vm up` (the engine generates + persists the token at bring-up).',
  };
}

// ---- IO probes ---------------------------------------------------------------

async function probeBootstrapReachable(apiUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiUrl.replace(/\/+$/, '')}/bootstrap/status`, {
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function probeSigned(apiUrl: string, keyId: string, secret: string): Promise<SignedProbe> {
  try {
    const client = createApplianceClient({ baseUrl: apiUrl, credentials: { keyId, secret } });
    const result = await client.getClusterInfo();
    if (result.success) {
      return { kind: 'ok', serverVersion: result.data.serverVersion ?? result.data.version ?? null };
    }
    const match = /HTTP (\d{3})/.exec(result.error.message);
    if (match) return { kind: 'http', status: Number(match[1]) };
    return { kind: 'network-error', message: result.error.message };
  } catch (err) {
    return { kind: 'network-error', message: err instanceof Error ? err.message : String(err) };
  }
}

function readGuestStamp(): string | null {
  try {
    const stamp = fs.readFileSync(path.join(guestAssetsDir(), 'appliance-api-server.version'), 'utf8').trim();
    return stamp || null;
  } catch {
    return null;
  }
}

function readGuestSigningKeyId(): string | null {
  try {
    const envelope = JSON.parse(
      fs.readFileSync(path.join(guestAssetsDir(), 'control-plane-release.sig.json'), 'utf8')
    ) as { keyId?: unknown; role?: unknown };
    return envelope.role === 'control-plane-release' &&
      typeof envelope.keyId === 'string' &&
      /^ed25519:sha256:[0-9a-f]{64}$/.test(envelope.keyId)
      ? envelope.keyId
      : null;
  } catch {
    try {
      const keyId = fs
        .readFileSync(path.join(guestAssetsDir(), 'control-plane-release.untrusted-key-id'), 'utf8')
        .trim();
      return /^ed25519:sha256:[0-9a-f]{64}$/.test(keyId) ? keyId : null;
    } catch {
      return null;
    }
  }
}

function probeKeychain(profileName: string, profile: Profile): KeychainProbe {
  return probeProfileCredential(profileName, profile);
}

interface IngressProbe {
  ran: boolean;
  skipReason?: string;
  findings: RuntimeFinding[];
}

function probeIngress(vm: string): IngressProbe {
  const kubeconfig = path.join(vmDir(vm), 'kubeconfig.yaml');
  if (!fs.existsSync(kubeconfig)) {
    return { ran: false, skipReason: `no kubeconfig at ${kubeconfig} (VM not up?)`, findings: [] };
  }
  const r = spawnSync('kubectl', ['--kubeconfig', kubeconfig, 'get', 'ingress', '-A', '-o', 'json'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (r.error || r.status !== 0) {
    const reason = r.error
      ? `kubectl not runnable (${r.error.message})`
      : `kubectl exited ${r.status}: ${(r.stderr ?? '').trim().split('\n')[0] ?? ''}`;
    return { ran: false, skipReason: reason, findings: [] };
  }
  try {
    const claims = extractIngressClaims(JSON.parse(r.stdout));
    return { ran: true, findings: classifyIngressClaims(claims, `kubectl --kubeconfig ${kubeconfig}`) };
  } catch {
    return { ran: false, skipReason: 'unparseable kubectl output', findings: [] };
  }
}

// ---- orchestrator -------------------------------------------------------------

export interface RuntimeDoctorOptions {
  /** VM whose runtime to diagnose (default: the default VM). */
  vm?: string;
  /** True when the operator explicitly targeted this VM (`--vm <name>`
   *  on the command line). An IMPLICIT default-VM run downgrades
   *  "the VM does not exist" from fail to info — a machine that has
   *  never run `appliance vm up` is not broken. Defaults to "a vm was
   *  passed in", so programmatic callers naming a VM keep the strict
   *  verdict unless they opt out. */
  vmExplicit?: boolean;
  /** Apply the fixes (re-mint, keychain write-back, orphan-profile
   *  removal, stale-port rewrite). WITHOUT this flag doctor is strictly
   *  read-only: it reports and never mutates the profile store, the
   *  Keychain, or anything else. */
  fix?: boolean;
}

/**
 * Pure post-filter for the engine's findings (check #3): when the
 * target VM is the IMPLICIT default (the user never passed --vm) and
 * the engine reports it does not exist, the "VM definition" fail is
 * downgraded to info — every pre-first-run machine would otherwise
 * exit 1 from a plain `appliance doctor`. An EXPLICIT `--vm <name>`
 * keeps the hard failure: the user asked about that VM specifically.
 */
export function softenMissingDefaultVm(
  findings: RuntimeFinding[],
  exists: boolean,
  vmExplicit: boolean
): RuntimeFinding[] {
  if (exists || vmExplicit) return findings;
  return findings.map((f) =>
    f.id === 'engine:vm' && f.severity === 'fail'
      ? {
          id: f.id,
          title: f.title,
          severity: 'info' as const,
          detail: 'no Dev Machine yet — `appliance vm up` creates it',
          remediation: 'Run `appliance vm up` when you want the local Dev Machine.',
        }
      : f
  );
}

/** Resolve the credential profile the target VM's clients use: the VM's
 *  own profile, falling back (default VM only) to the legacy `microvm`
 *  profile pre-cutover installs still carry. */
export function resolveVmProfile(vm: string, file = readProfiles()): { name: string; profile: Profile } | null {
  const primary = profileForVm(vm);
  if (file.profiles[primary]) return { name: primary, profile: file.profiles[primary] };
  if (vm === DEFAULT_VM_NAME && file.profiles[LEGACY_MICROVM_PROFILE]) {
    return { name: LEGACY_MICROVM_PROFILE, profile: file.profiles[LEGACY_MICROVM_PROFILE] };
  }
  return null;
}

export async function runRuntimeDoctor(opts: RuntimeDoctorOptions = {}): Promise<RuntimeDoctorReport> {
  const vm = opts.vm ?? DEFAULT_VM_NAME;
  const vmExplicit = opts.vmExplicit ?? opts.vm !== undefined;
  const findings: RuntimeFinding[] = [];
  const fixes: RuntimeFixOutcome[] = [];

  // 1. Engine-side checks (guest clock, in-guest api-server liveness).
  //    Old/missing engines degrade to an info row, never a failure; a
  //    missing IMPLICIT-default VM is a pre-first-run machine, not a
  //    failure (softenMissingDefaultVm).
  const engine = engineVmChecks(vm);
  if (engine) {
    findings.push(...softenMissingDefaultVm(engine.findings, engine.exists, vmExplicit));
  } else {
    findings.push({
      id: 'engine:checks',
      title: 'Engine runtime checks',
      severity: 'info',
      detail: 'appliance-vm missing or predates `doctor --vm-checks` — guest clock/liveness probes skipped',
      remediation: 'Update appliance-vm (`cargo build` + sign in packages/vm, or reinstall) for full diagnostics.',
    });
  }
  const clockSkewSeconds = engine?.clockSkewSeconds ?? null;

  // 2. Profile ↔ VM bindings for every local profile (check d). The
  //    fixes (orphan removal, stale-port rewrite) mutate the profile
  //    store and the Keychain, so they run ONLY under --fix.
  const listing = engineList();
  // A plain doctor is read-only. Keep legacy fields visible so the coherence
  // probe can report missing/conflict/migrated before any scrub occurs.
  const profilesFile = readProfiles({ migrateCredentials: false });
  findings.push(...readCredentialMigrationConflicts().map(classifyCredentialMigrationConflict));
  findings.push(...classifyWindowsCaptureRules(process.platform, readVmCredentialRulesFixtures()));
  for (const [name, profile] of Object.entries(profilesFile.profiles)) {
    const binding = classifyProfileBinding(name, profile.apiUrl, listing);
    const bindingFinding = await renderBindingFinding(name, profile, binding, {
      autoFix: opts.fix === true,
      fixes,
    });
    if (bindingFinding) findings.push(bindingFinding);
  }

  // 3. Key liveness for the target VM's profile (check b).
  const resolved = resolveVmProfile(vm, profilesFile);
  const tokenPresent = fs.existsSync(bootstrapTokenPath(vm));
  let serverVersion: string | null = null;
  if (!resolved) {
    findings.push({
      id: 'runtime:api-key',
      title: 'API key accepted by the api-server',
      severity: engine?.bootstrapInitialized === false ? 'info' : 'warn',
      detail:
        engine?.bootstrapInitialized === false
          ? `no credential profile for VM '${vm}' and the guest key store is empty — the engine mints one automatically at (next) bring-up`
          : `no credential profile for VM '${vm}' on this host`,
      remediation: 'Run `appliance vm up` — it adopts or mints the VM credential profile.',
    });
  } else {
    let credential: { keyId: string; secret: string } | null = null;
    let credentialError: unknown;
    try {
      credential = resolveProfileSecret(resolved.name, resolved.profile);
    } catch (cause) {
      credentialError = cause;
    }
    if (credentialError) {
      findings.push({
        id: 'runtime:api-key',
        title: 'API key accepted by the api-server',
        severity: 'fail',
        detail: `credential store unavailable: ${credentialError instanceof Error ? credentialError.message : String(credentialError)}`,
        remediation: 'Restore the bundled credential helper/store access, then re-run `appliance doctor`.',
      });
    } else if (!credential?.keyId || !credential.secret) {
      findings.push({
        id: 'runtime:api-key',
        title: 'API key accepted by the api-server',
        severity: 'warn',
        detail: `profile '${resolved.name}' has no usable credential (keyId/secret empty or credential store unavailable)`,
        remediation: 'Run `appliance vm up` to re-adopt or mint credentials.',
      });
    } else {
      const { keyId, secret } = credential;
      const apiUrl = resolved.profile.apiUrl;
      const bootstrapReachable = await probeBootstrapReachable(apiUrl);
      const signed = bootstrapReachable
        ? await probeSigned(apiUrl, keyId, secret)
        : ({ kind: 'network-error', message: 'skipped (server unreachable)' } as SignedProbe);
      if (signed.kind === 'ok') serverVersion = signed.serverVersion;
      let authFinding = triangulateAuth({
        bootstrapReachable,
        signed,
        clockSkewSeconds,
        bootstrapTokenPresent: tokenPresent,
      });
      if (opts.fix && authFinding.fix?.kind === 'remint-key') {
        authFinding = await applyRemintFix(vm, resolved.name, resolved.profile, keyId, authFinding, fixes);
      }
      findings.push(authFinding);
    }
  }

  // 4. Guest artifact stamp vs CLI vs running server (check e).
  findings.push(
    compareVersionStamp(
      readGuestStamp(),
      VERSION,
      serverVersion,
      readGuestSigningKeyId(),
      PINNED_RELEASE_TRUST,
      engine?.controlPlaneUpdateCapable === true
    )
  );

  // 5. Duplicate ingress claims (check c) — skip-not-fail without kubectl.
  const ingress = probeIngress(vm);
  if (ingress.ran) {
    findings.push(...ingress.findings);
  } else {
    findings.push({
      id: 'runtime:ingress-api',
      title: `Ingress claim on ${IN_CLUSTER_API_SERVER_HOSTNAME}`,
      severity: 'info',
      detail: `check skipped: ${ingress.skipReason}`,
    });
  }

  // 6. profiles ↔ Keychain coherence for desktop-managed profiles (check f).
  for (const [name, profile] of Object.entries(profilesFile.profiles)) {
    let finding = classifyKeychainCoherence(name, profile, probeKeychain(name, profile));
    if (!finding) continue;
    if (opts.fix && finding.fix?.kind === 'keychain-writeback') {
      finding = applyKeychainWriteback(name, profile, finding, fixes);
    }
    findings.push(finding);
  }

  // 7. Bootstrap token presence (the heal-path prerequisite).
  findings.push(bootstrapTokenFinding(vm, tokenPresent));

  return {
    vm,
    findings,
    fixes,
    ok: findings.every((f) => f.severity !== 'fail'),
    ...(serverVersion ? { serverVersion } : {}),
  };
}

// ---- fixers (D2) --------------------------------------------------------------

/** Render a binding classification as a finding. Returns null for
 *  remote profiles (out of scope).
 *
 *  Fix policy (`ctx.autoFix` is true ONLY under `doctor --fix` — a
 *  plain `appliance doctor` reports and never writes):
 *   - orphan: removeProfile + Keychain-entry delete. Only offered when
 *     the classification required: VM-bound profile (name AND the
 *     in-cluster api hostname) AND a SUCCESSFUL validated engine
 *     listing AND the VM absent from it. The CLI never edits the
 *     desktop's config.json (no shared lock) — the desktop converges
 *     via its own cluster sync.
 *   - stale-port / cross-wired: rewrite apiUrl to the VM's real
 *     hostPort (apiServerUrlForHostPort) via upsertProfile.
 *   - foreign-url: NEVER fixed, even under --fix — the profile's URL
 *     does not prove it belongs to a Dev Machine. */
export async function renderBindingFinding(
  profileName: string,
  profile: Profile,
  binding: ProfileBinding,
  ctx: { autoFix: boolean; fixes: RuntimeFixOutcome[] }
): Promise<RuntimeFinding | null> {
  const id = `profile:${profileName}`;
  const title = `Profile '${profileName}' ↔ VM registry`;
  switch (binding.kind) {
    case 'remote':
      return null;
    case 'foreign-url':
      return {
        id,
        title,
        severity: 'warn',
        detail: `profile name looks bound to VM '${binding.vmName}', but its apiUrl host ${
          binding.hostname ? `'${binding.hostname}'` : '(unparseable)'
        } is not the Dev Machine hostname (${IN_CLUSTER_API_SERVER_HOSTNAME}) — likely a docker-based local server or a remote cluster reusing the name; doctor leaves it untouched`,
        remediation:
          'If this profile SHOULD point at the microVM, `appliance vm up` rebinds it; otherwise nothing to do.',
      };
    case 'engine-unavailable':
      return {
        id,
        title,
        severity: 'info',
        detail: `maps to VM '${binding.vmName}', but the appliance-vm engine is not runnable — cannot verify (NOT treated as an orphan)`,
        remediation: 'Install/build appliance-vm, then re-run `appliance doctor`.',
      };
    case 'ok':
      return {
        id,
        title,
        severity: 'ok',
        detail: `bound to VM '${binding.vmName}' on port ${binding.port}`,
      };
    case 'orphan': {
      if (ctx.autoFix) {
        const label = `remove orphan profile '${profileName}'`;
        try {
          if (removeProfile(profileName)) {
            ctx.fixes.push({
              label,
              status: 'fixed',
              detail: `VM '${binding.vmName}' no longer exists — pruned the profile and its typed credential entry`,
            });
            return {
              id,
              title,
              severity: 'ok',
              detail: `orphan profile removed (its VM '${binding.vmName}' no longer exists)`,
              fix: { kind: 'remove-orphan-profile', applied: true },
            };
          }
          ctx.fixes.push({ label, status: 'failed', detail: 'profile store reported nothing to remove' });
        } catch (err) {
          ctx.fixes.push({ label, status: 'failed', detail: err instanceof Error ? err.message : String(err) });
        }
      }
      return {
        id,
        title,
        severity: 'warn',
        detail: `profile points at VM '${binding.vmName}', which no longer exists (engine listing succeeded)`,
        remediation: `Run \`appliance doctor --fix\` to prune it, or remove it yourself: \`appliance cluster rm ${profileName}\`.`,
        fix: { kind: 'remove-orphan-profile' },
      };
    }
    case 'stale-port':
    case 'cross-wired': {
      const crossWired = binding.kind === 'cross-wired';
      if (ctx.autoFix) {
        const label = `rewrite apiUrl of profile '${profileName}'`;
        try {
          const newUrl = apiServerUrlForHostPort(binding.vmPort);
          upsertProfile(profileName, { ...profile, apiUrl: newUrl });
          ctx.fixes.push({ label, status: 'fixed', detail: `${profile.apiUrl} → ${newUrl}` });
          return {
            id,
            title,
            severity: 'ok',
            detail: `apiUrl rewritten from port ${binding.profilePort}${
              crossWired ? ` (owned by VM '${binding.portOwner}'!)` : ''
            } to VM '${binding.vmName}' port ${binding.vmPort}`,
            fix: { kind: 'rewrite-stale-port', applied: true },
          };
        } catch (err) {
          ctx.fixes.push({ label, status: 'failed', detail: err instanceof Error ? err.message : String(err) });
        }
      }
      return {
        id,
        title,
        severity: crossWired ? 'fail' : 'warn',
        detail: crossWired
          ? `profile apiUrl points at port ${binding.profilePort}, which belongs to a DIFFERENT VM ('${binding.portOwner}') — requests would hit the wrong cluster`
          : `profile apiUrl points at port ${binding.profilePort} but VM '${binding.vmName}' owns port ${binding.vmPort}`,
        remediation: `Run \`appliance doctor --fix\` to point the profile back at its VM (apiUrl ${apiServerUrlForHostPort(binding.vmPort)}).`,
        fix: { kind: 'rewrite-stale-port' },
      };
    }
  }
}

/** Pure decide_heal-style safeguard for the re-mint fix: if the stored
 *  keyId moved since the failing probe (another surface re-keyed while
 *  doctor ran), VERIFY that rekey first instead of minting yet another
 *  key on top of it. */
export function decideRemintPlan(failingKeyId: string, freshKeyId: string | undefined): 'verify-first' | 'mint' {
  return freshKeyId && freshKeyId !== failingKeyId ? 'verify-first' : 'mint';
}

/** `--fix` for the dead-key class: adopt a concurrent rekey when one
 *  verifies, else mint a new key with the VM's bootstrap token and
 *  persist it exactly as `vm up` would (primary profile + legacy dual-
 *  write for the default VM). Never steals the active-profile slot —
 *  a doctor repair must not switch the user's selected cluster. */
async function applyRemintFix(
  vm: string,
  profileName: string,
  profile: Profile,
  failingKeyId: string,
  finding: RuntimeFinding,
  fixes: RuntimeFixOutcome[]
): Promise<RuntimeFinding> {
  const label = 're-mint API key';
  const apiUrl = profile.apiUrl;
  try {
    // Safeguard 1: adopt an existing rekey instead of minting over it.
    const fresh = readProfiles().profiles[profileName];
    if (fresh && decideRemintPlan(failingKeyId, fresh.keyId) === 'verify-first') {
      const creds = resolveProfileSecret(profileName, fresh);
      if (creds.keyId && creds.secret && (await probeSigned(apiUrl, creds.keyId, creds.secret)).kind === 'ok') {
        fixes.push({
          label,
          status: 'fixed',
          detail: `adopted existing rekey ${creds.keyId} (verified) — no new key minted`,
        });
        return {
          ...finding,
          severity: 'ok',
          detail: `a newer key (${creds.keyId}) already existed and verifies — adopted instead of re-minting`,
          remediation: undefined,
          fix: { kind: 'remint-key', applied: true },
        };
      }
    }
    const token = fs.readFileSync(bootstrapTokenPath(vm), 'utf8').trim();
    if (!token) throw new Error(`empty bootstrap token at ${bootstrapTokenPath(vm)}`);
    const keyName = vm === DEFAULT_VM_NAME ? 'Dev Machine' : `Dev Machine (${vm})`;
    const minted = await mintApiKey(apiUrl, token, keyName);
    const creds: Profile = { apiUrl, keyId: minted.id, secret: minted.secret, managed: 'cli' };
    // Persist under the VM's canonical profile ids (persistVmCredentials'
    // dual-write), but WITHOUT makeActive — repairs don't switch clusters.
    upsertProfile(profileForVm(vm), creds);
    if (vm === DEFAULT_VM_NAME) upsertProfile(LEGACY_MICROVM_PROFILE, creds);
    // Safeguard 2: prove the mint actually heals before reporting fixed.
    const confirm = await probeSigned(apiUrl, minted.id, minted.secret);
    if (confirm.kind !== 'ok') {
      fixes.push({
        label,
        status: 'failed',
        detail: `minted ${minted.id} and saved it, but the signed probe still fails — see the api-server log`,
      });
      return { ...finding, detail: `${finding.detail} (re-mint attempted: new key saved but still rejected)` };
    }
    fixes.push({
      label,
      status: 'fixed',
      detail: `minted ${minted.id} with the VM bootstrap token and saved it to profile '${profileForVm(vm)}'`,
    });
    return {
      ...finding,
      severity: 'ok',
      detail: `dead key replaced: re-minted ${minted.id} with the VM bootstrap token; signed request now accepted`,
      remediation: undefined,
      fix: { kind: 'remint-key', applied: true },
    };
  } catch (err) {
    fixes.push({ label, status: 'failed', detail: err instanceof Error ? err.message : String(err) });
    return finding;
  }
}

/** `--fix` for credential-store desync where profiles.json holds the fresher
 * secret: write, verify, and let the central profile store scrub where the OS
 * credential store is canonical. */
function applyKeychainWriteback(
  profileName: string,
  profile: Profile,
  finding: RuntimeFinding,
  fixes: RuntimeFixOutcome[]
): RuntimeFinding {
  const label = `write '${profileName}' secret back to the credential store`;
  if (!profile.keyId || !profile.secret) {
    fixes.push({ label, status: 'skipped', detail: 'no on-disk secret to migrate' });
    return finding;
  }
  try {
    const result = upsertProfile(profileName, profile, { makeActive: false });
    if (!result.credentialWriteFailed) {
      fixes.push({ label, status: 'fixed', detail: `OS credential store now carries key ${profile.keyId}` });
      return {
        ...finding,
        severity: 'ok',
        detail: `Credential-store entry rewritten and verified from profiles.json (key ${profile.keyId})`,
        remediation: undefined,
        fix: { kind: 'keychain-writeback', applied: true },
      };
    }
  } catch (cause) {
    fixes.push({ label, status: 'failed', detail: cause instanceof Error ? cause.message : String(cause) });
    return finding;
  }
  fixes.push({
    label,
    status: 'failed',
    detail: 'the OS credential store denied the write',
  });
  return finding;
}
