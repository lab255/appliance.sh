import { describe, it, expect } from 'vitest';
import {
  bootstrapTokenFinding,
  classifyIngressClaims,
  classifyKeychainCoherence,
  classifyProfileBinding,
  compareVersionStamp,
  decideRemintPlan,
  doctorVmForProfile,
  extractIngressClaims,
  hostnameOfApiUrl,
  parseEngineListing,
  portOfApiUrl,
  renderBindingFinding,
  softenMissingDefaultVm,
  triangulateAuth,
  type AuthProbeInput,
  type EngineListing,
  type IngressClaim,
  type RuntimeFinding,
  type RuntimeFixOutcome,
} from './runtime-doctor.js';

describe('doctorVmForProfile', () => {
  it('maps the canonical local profile AND the legacy microvm profile to the default VM', () => {
    // Unlike cluster-target's vmNameForProfile, `local` must map too —
    // it is the default VM's PRIMARY profile (profileForVm).
    expect(doctorVmForProfile('local')).toBe('appliance');
    expect(doctorVmForProfile('microvm')).toBe('appliance');
  });

  it('maps named microvm profiles to their VM and everything else to null', () => {
    expect(doctorVmForProfile('microvm-staging')).toBe('staging');
    expect(doctorVmForProfile('prod')).toBeNull();
    expect(doctorVmForProfile('default')).toBeNull();
  });
});

describe('portOfApiUrl', () => {
  it('reads explicit ports and protocol defaults', () => {
    expect(portOfApiUrl('http://api.appliance.localhost:8081')).toBe(8081);
    expect(portOfApiUrl('http://api.appliance.localhost')).toBe(80);
    expect(portOfApiUrl('https://prod.example.com')).toBe(443);
  });

  it('returns null for garbage', () => {
    expect(portOfApiUrl('not a url')).toBeNull();
  });
});

describe('hostnameOfApiUrl', () => {
  it('reads the hostname and returns null for garbage', () => {
    expect(hostnameOfApiUrl('http://api.appliance.localhost:8081')).toBe('api.appliance.localhost');
    expect(hostnameOfApiUrl('http://127.0.0.1:3000')).toBe('127.0.0.1');
    expect(hostnameOfApiUrl('not a url')).toBeNull();
  });
});

describe('parseEngineListing', () => {
  it('accepts a valid listing', () => {
    const out = JSON.stringify([{ name: 'appliance', running: true, hostPort: 8081 }]);
    expect(parseEngineListing(out)).toEqual({
      available: true,
      vms: [{ name: 'appliance', running: true, hostPort: 8081 }],
    });
  });

  it('treats malformed JSON and non-arrays as engine-unavailable', () => {
    // The listing gates DESTRUCTIVE classification (orphan deletion), so
    // anything suspect must degrade to "cannot verify", never crash.
    expect(parseEngineListing('not json')).toEqual({ available: false });
    expect(parseEngineListing('{"vms":[]}')).toEqual({ available: false });
    expect(parseEngineListing('null')).toEqual({ available: false });
  });

  it('rejects the WHOLE listing when any entry is malformed', () => {
    // A missing hostPort once produced apiUrl "http://…:undefined"
    // written into a HEALTHY profile — invalid entries poison the lot.
    expect(parseEngineListing(JSON.stringify([{ name: 'appliance', running: true }]))).toEqual({ available: false });
    expect(parseEngineListing(JSON.stringify([{ name: 'a', hostPort: '8081' }]))).toEqual({ available: false });
    expect(parseEngineListing(JSON.stringify([{ running: true, hostPort: 8081 }]))).toEqual({ available: false });
    expect(parseEngineListing(JSON.stringify([null]))).toEqual({ available: false });
  });
});

describe('classifyProfileBinding', () => {
  const engine: EngineListing = {
    available: true,
    vms: [
      { name: 'appliance', running: true, hostPort: 8081 },
      { name: 'staging', running: false, hostPort: 8100 },
    ],
  };
  const url = (port: number) => `http://api.appliance.localhost:${port}`;

  it('passes a profile whose apiUrl matches its VM hostPort', () => {
    expect(classifyProfileBinding('local', url(8081), engine)).toEqual({
      kind: 'ok',
      vmName: 'appliance',
      port: 8081,
    });
    expect(classifyProfileBinding('microvm-staging', url(8100), engine)).toEqual({
      kind: 'ok',
      vmName: 'staging',
      port: 8100,
    });
  });

  it('flags a profile whose VM is gone as an orphan — only on a successful listing', () => {
    expect(classifyProfileBinding('microvm-ghost', url(8105), engine)).toEqual({
      kind: 'orphan',
      vmName: 'ghost',
    });
  });

  it('NEVER classifies as orphan when the engine binary is unavailable', () => {
    // The critical safety rule: engine-binary-missing must not count as
    // VM-missing, or a broken install would strip working profiles.
    const noEngine: EngineListing = { available: false };
    expect(classifyProfileBinding('microvm-ghost', url(8105), noEngine)).toEqual({
      kind: 'engine-unavailable',
      vmName: 'ghost',
    });
  });

  it('flags a port that drifted from the VM spec as stale', () => {
    expect(classifyProfileBinding('local', url(9999), engine)).toEqual({
      kind: 'stale-port',
      vmName: 'appliance',
      profilePort: 9999,
      vmPort: 8081,
    });
  });

  it('treats a VM-ish NAME with a non-Dev-Machine URL as foreign — never orphan/stale', () => {
    // The v1.51 `appliance server` docker flow writes a `local` profile
    // at http://127.0.0.1:<port> with NO VM behind it. Name-only
    // classification called that an orphan (→ deleted) or stale-port
    // (→ rewritten to the VM's URL). Only the in-cluster api hostname
    // proves a profile VM-bound.
    expect(classifyProfileBinding('local', 'http://127.0.0.1:3000', engine)).toEqual({
      kind: 'foreign-url',
      vmName: 'appliance',
      hostname: '127.0.0.1',
    });
    // `appliance login` accepts any profile name — a REMOTE cluster
    // saved under a VM-ish name must not be classified against VMs.
    expect(classifyProfileBinding('local', 'https://prod.example.com', engine)).toEqual({
      kind: 'foreign-url',
      vmName: 'appliance',
      hostname: 'prod.example.com',
    });
    expect(classifyProfileBinding('microvm-staging', 'https://team.example.com:8100', engine)).toEqual({
      kind: 'foreign-url',
      vmName: 'staging',
      hostname: 'team.example.com',
    });
    // Same rule when the VM is genuinely absent: foreign beats orphan.
    expect(classifyProfileBinding('microvm-ghost', 'http://127.0.0.1:8105', engine)).toEqual({
      kind: 'foreign-url',
      vmName: 'ghost',
      hostname: '127.0.0.1',
    });
    // An unparseable apiUrl proves nothing either → foreign, not a fix.
    expect(classifyProfileBinding('local', 'garbage', engine)).toEqual({
      kind: 'foreign-url',
      vmName: 'appliance',
      hostname: null,
    });
    // Foreign-url wins even when the engine is unavailable — the URL
    // check needs no engine.
    expect(classifyProfileBinding('local', 'http://127.0.0.1:3000', { available: false })).toEqual({
      kind: 'foreign-url',
      vmName: 'appliance',
      hostname: '127.0.0.1',
    });
  });

  it('flags a port owned by ANOTHER VM as cross-wired (worse than stale: requests reach the wrong cluster)', () => {
    expect(classifyProfileBinding('local', url(8100), engine)).toEqual({
      kind: 'cross-wired',
      vmName: 'appliance',
      profilePort: 8100,
      vmPort: 8081,
      portOwner: 'staging',
    });
  });

  it('leaves remote profiles out of scope', () => {
    expect(classifyProfileBinding('prod', 'https://prod.example.com', engine)).toEqual({ kind: 'remote' });
  });
});

describe('renderBindingFinding', () => {
  const profile = { apiUrl: 'http://127.0.0.1:3000', keyId: 'k1', secret: 's1' };

  it('reports a foreign-url profile as a warning and NEVER fixes it — even with --fix', async () => {
    // The docker-base `local` profile: doctor must not delete it, must
    // not rewrite its apiUrl, and must not attach any fix at all.
    const fixes: RuntimeFixOutcome[] = [];
    const finding = await renderBindingFinding(
      'local',
      profile,
      { kind: 'foreign-url', vmName: 'appliance', hostname: '127.0.0.1' },
      { autoFix: true, fixes }
    );
    expect(finding?.severity).toBe('warn');
    expect(finding?.detail).toContain('not the Dev Machine hostname');
    expect(finding?.fix).toBeUndefined();
    expect(fixes).toEqual([]);
  });

  it('reports orphan and stale-port WITHOUT mutating when --fix is off', async () => {
    const fixes: RuntimeFixOutcome[] = [];
    const orphan = await renderBindingFinding(
      'microvm-ghost',
      profile,
      { kind: 'orphan', vmName: 'ghost' },
      { autoFix: false, fixes }
    );
    expect(orphan?.severity).toBe('warn');
    expect(orphan?.fix).toEqual({ kind: 'remove-orphan-profile' });
    expect(orphan?.remediation).toContain('--fix');

    const stale = await renderBindingFinding(
      'local',
      profile,
      { kind: 'stale-port', vmName: 'appliance', profilePort: 9999, vmPort: 8081 },
      { autoFix: false, fixes }
    );
    expect(stale?.severity).toBe('warn');
    expect(stale?.fix).toEqual({ kind: 'rewrite-stale-port' });

    // Read-only means read-only: no fix outcomes were recorded.
    expect(fixes).toEqual([]);
  });
});

describe('softenMissingDefaultVm', () => {
  const missingVm: RuntimeFinding[] = [
    {
      id: 'engine:vm',
      title: 'VM definition',
      severity: 'fail',
      detail: "no VM named 'appliance' is defined on this host",
      remediation: 'appliance vm up',
    },
  ];

  it('downgrades a missing IMPLICIT default VM to info — a pre-first-run machine is not broken', () => {
    const softened = softenMissingDefaultVm(missingVm, false, false);
    expect(softened[0].severity).toBe('info');
    expect(softened[0].detail).toContain('no Dev Machine yet');
    expect(softened[0].detail).toContain('appliance vm up');
  });

  it('keeps the hard failure when the user explicitly asked about a VM (--vm <name>)', () => {
    expect(softenMissingDefaultVm(missingVm, false, true)).toEqual(missingVm);
  });

  it('touches nothing when the VM exists', () => {
    const running: RuntimeFinding[] = [{ id: 'engine:vm', title: 'VM running', severity: 'ok' }];
    expect(softenMissingDefaultVm(running, true, false)).toEqual(running);
  });
});

describe('triangulateAuth', () => {
  const base: AuthProbeInput = {
    bootstrapReachable: true,
    signed: { kind: 'http', status: 401 },
    clockSkewSeconds: 2,
    bootstrapTokenPresent: true,
  };

  it('passes when the signed request is accepted', () => {
    const f = triangulateAuth({ ...base, signed: { kind: 'ok', serverVersion: 'v1.51.2' } });
    expect(f.severity).toBe('ok');
  });

  it('fails on an unreachable server before blaming the key', () => {
    const f = triangulateAuth({ ...base, bootstrapReachable: false });
    expect(f.severity).toBe('fail');
    expect(f.detail).toContain('unreachable');
    expect(f.fix).toBeUndefined();
  });

  it('blames the CLOCK for a 401 when skew is at/over the signature tolerance', () => {
    const f = triangulateAuth({ ...base, clockSkewSeconds: -40 });
    expect(f.severity).toBe('fail');
    expect(f.detail).toContain('CLOCK');
    expect(f.fix).toBeUndefined();
  });

  it('blames the KEY for a 401 when the server answers and the clock is in tolerance', () => {
    const f = triangulateAuth(base);
    expect(f.severity).toBe('fail');
    expect(f.detail).toContain('does not know this key');
    expect(f.fix).toEqual({ kind: 'remint-key' });
    expect(f.remediation).toContain('--fix');
  });

  it('offers no re-mint when the bootstrap token is missing (no heal path)', () => {
    const f = triangulateAuth({ ...base, bootstrapTokenPresent: false });
    expect(f.severity).toBe('fail');
    expect(f.fix).toBeUndefined();
    expect(f.remediation).toContain('No bootstrap token');
  });

  it('reports ambiguity honestly when engine skew data is unavailable — and NEVER attaches the re-mint fix', () => {
    // Without the skew probe the 401 could be clock skew: minting would
    // not heal that and only orphans another key. Remediation text only.
    const f = triangulateAuth({ ...base, clockSkewSeconds: null });
    expect(f.severity).toBe('fail');
    expect(f.detail).toContain('ambiguous');
    expect(f.fix).toBeUndefined();
    expect(f.remediation).toBeTruthy();
    // Even with the bootstrap token present — the trigger is the
    // triangulated dead-key verdict, not token availability.
    expect(triangulateAuth({ ...base, clockSkewSeconds: null, bootstrapTokenPresent: true }).fix).toBeUndefined();
  });

  it('downgrades non-401 statuses to a warning (not an auth diagnosis)', () => {
    const f = triangulateAuth({ ...base, signed: { kind: 'http', status: 500 } });
    expect(f.severity).toBe('warn');
    expect(f.detail).toContain('500');
  });
});

describe('ingress claims', () => {
  const kubectlPrefix = 'kubectl --kubeconfig /home/u/.appliance/vm/appliance/kubeconfig.yaml';
  const claim = (name: string, namespace: string, hosts: string[]): IngressClaim => ({ name, namespace, hosts });

  it('extracts name/namespace/hosts from kubectl JSON and tolerates junk', () => {
    const json = {
      items: [
        {
          metadata: { name: 'appliance-api-server', namespace: 'default' },
          spec: { rules: [{ host: 'api.appliance.localhost' }] },
        },
        { metadata: { name: 'no-rules', namespace: 'x' } },
        { spec: { rules: [{ host: 'orphan.example' }] } }, // no metadata.name → dropped
      ],
    };
    expect(extractIngressClaims(json)).toEqual([
      claim('appliance-api-server', 'default', ['api.appliance.localhost']),
      claim('no-rules', 'x', []),
    ]);
    expect(extractIngressClaims({})).toEqual([]);
    expect(extractIngressClaims(null)).toEqual([]);
  });

  it('passes exactly one canonical claimant', () => {
    const findings = classifyIngressClaims(
      [claim('appliance-api-server', 'default', ['api.appliance.localhost'])],
      kubectlPrefix
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('ok');
  });

  it('fails duplicates on the api hostname with the exact delete command for the NON-canonical claimant', () => {
    const findings = classifyIngressClaims(
      [
        claim('appliance-api-server', 'default', ['api.appliance.localhost']),
        claim('appliance-api-server', 'appliance-system', ['api.appliance.localhost']),
      ],
      kubectlPrefix
    );
    const apiFinding = findings.find((f) => f.id === 'runtime:ingress-api');
    expect(apiFinding?.severity).toBe('fail');
    expect(apiFinding?.remediation).toBe(`${kubectlPrefix} delete ingress appliance-api-server -n appliance-system`);
    // The canonical claimant must never be the one nominated for deletion.
    expect(apiFinding?.remediation).not.toContain('-n default');
  });

  it('warns when nothing claims the api hostname yet', () => {
    const findings = classifyIngressClaims([claim('web', 'default', ['app.appliance.localhost'])], kubectlPrefix);
    const apiFinding = findings.find((f) => f.id === 'runtime:ingress-api');
    expect(apiFinding?.severity).toBe('warn');
  });

  it('warns (not fails) on duplicate user hostnames', () => {
    const findings = classifyIngressClaims(
      [
        claim('appliance-api-server', 'default', ['api.appliance.localhost']),
        claim('a', 'default', ['web.appliance.localhost']),
        claim('b', 'default', ['web.appliance.localhost']),
      ],
      kubectlPrefix
    );
    const dup = findings.find((f) => f.id === 'runtime:ingress:web.appliance.localhost');
    expect(dup?.severity).toBe('warn');
  });
});

describe('compareVersionStamp', () => {
  it('passes when CLI, staged stamp, and running server agree (v-prefix insensitive)', () => {
    expect(compareVersionStamp('v1.51.2:arm64', 'v1.51.2', 'v1.51.2').severity).toBe('ok');
    expect(compareVersionStamp('1.51.2:arm64', 'v1.51.2', null).severity).toBe('ok');
  });

  it('suggests a RESTART when the running server predates the staged stamp', () => {
    const f = compareVersionStamp('v1.51.2:arm64', 'v1.51.2', 'v1.50.0');
    expect(f.severity).toBe('warn');
    expect(f.detail).toContain('booted before the restage');
    expect(f.remediation).toContain('appliance vm stop && appliance vm up');
  });

  it('suggests a RESTAGE when the stamp trails the CLI', () => {
    const f = compareVersionStamp('v1.50.0:arm64', 'v1.51.2', null);
    expect(f.severity).toBe('warn');
    expect(f.remediation).toContain('appliance vm up');
  });

  it('treats a missing stamp and an override stamp as informational', () => {
    expect(compareVersionStamp(null, 'v1.51.2', null).severity).toBe('info');
    expect(compareVersionStamp('override:arm64:123:456:no-console', 'v1.51.2', 'v1.51.2').severity).toBe('info');
  });
});

describe('classifyKeychainCoherence', () => {
  const profile = (keyId: string, secret: string) => ({ keyId, secret });

  it('returns null when the check does not apply', () => {
    expect(classifyKeychainCoherence('prod', profile('k1', 's'), { state: 'not-applicable' })).toBeNull();
  });

  it('passes a matching Keychain entry with an empty file secret (the macOS policy)', () => {
    const f = classifyKeychainCoherence('c1', profile('k1', ''), { state: 'migrated', keyId: 'k1' });
    expect(f?.severity).toBe('ok');
  });

  it('flags a desktop-managed profile with a cleartext secret on disk as a policy violation', () => {
    const f = classifyKeychainCoherence('c1', profile('k1', 's3cret'), { state: 'migrated', keyId: 'k1' });
    expect(f?.severity).toBe('warn');
    expect(f?.detail).toContain('cleartext');
  });

  it('offers the Keychain write-back when the FILE is fresher (rotate that missed the Keychain)', () => {
    const f = classifyKeychainCoherence('c1', profile('k2', 's3cret'), { state: 'migrated', keyId: 'k1' });
    expect(f?.severity).toBe('warn');
    expect(f?.fix).toEqual({ kind: 'keychain-writeback' });
  });

  it('treats stale file metadata (Keychain fresher, no file secret) as self-healing', () => {
    const f = classifyKeychainCoherence('c1', profile('k1', ''), { state: 'migrated', keyId: 'k2' });
    expect(f?.severity).toBe('warn');
    expect(f?.fix).toBeUndefined();
  });

  it('fails hard when neither the Keychain nor the file holds a secret', () => {
    const f = classifyKeychainCoherence('c1', profile('k1', ''), { state: 'missing' });
    expect(f?.severity).toBe('fail');
    expect(f?.detail).toContain('no usable secret');
  });

  it('offers write-back when the Keychain entry is missing but the file has the secret', () => {
    const f = classifyKeychainCoherence('c1', profile('k1', 's3cret'), { state: 'missing' });
    expect(f?.severity).toBe('warn');
    expect(f?.fix).toEqual({ kind: 'keychain-writeback' });
  });

  it('degrades to informational when macOS denies the Keychain read', () => {
    const f = classifyKeychainCoherence('c1', profile('k1', ''), { state: 'denied' });
    expect(f?.severity).toBe('info');
    expect(f?.detail).toContain('denied');
  });

  it('fails closed on malformed and conflict states with re-login guidance', () => {
    const malformed = classifyKeychainCoherence('c1', profile('k1', ''), { state: 'malformed' });
    expect(malformed?.severity).toBe('fail');
    expect(malformed?.detail).toContain('malformed');
    const conflict = classifyKeychainCoherence('c1', profile('file-key', 'file-secret'), {
      state: 'conflict',
      keyId: 'store-key',
    });
    expect(conflict?.severity).toBe('fail');
    expect(conflict?.detail).toContain('conflict');
    expect(conflict?.remediation).toContain('Re-login');
  });
});

describe('decideRemintPlan', () => {
  it('verifies first when the stored keyId moved since the failing probe (concurrent rekey)', () => {
    // decide_heal safeguard: another surface re-keyed while doctor ran
    // — verify + adopt that key instead of minting on top of it.
    expect(decideRemintPlan('k-old', 'k-new')).toBe('verify-first');
  });

  it('mints when the stored key is still the failing one (or gone)', () => {
    expect(decideRemintPlan('k-old', 'k-old')).toBe('mint');
    expect(decideRemintPlan('k-old', undefined)).toBe('mint');
    expect(decideRemintPlan('k-old', '')).toBe('mint');
  });
});

describe('bootstrapTokenFinding', () => {
  it('passes when the token file exists and warns about the missing heal path otherwise', () => {
    expect(bootstrapTokenFinding('appliance', true).severity).toBe('ok');
    const missing = bootstrapTokenFinding('appliance', false);
    expect(missing.severity).toBe('warn');
    expect(missing.detail).toContain('no heal path');
  });
});
