import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  kubeconfigServerLines,
  redactDeep,
  redactDesktopConfig,
  redactEgressPolicy,
  redactProfilesFile,
  scrubLogText,
  writeSupportBundle,
  type ProcessRunner,
} from './doctor-bundle.js';

// ---- pure redaction ----------------------------------------------------------

describe('redactDeep', () => {
  it('replaces matched keys at any depth and keeps everything else', () => {
    const tree = {
      a: 1,
      secret: 'hunter2',
      nested: [{ secret: 'deep', keep: 'me' }],
    };
    expect(redactDeep(tree, { secret: 'string-len' })).toEqual({
      a: 1,
      secret: '<redacted:len=7>',
      nested: [{ secret: '<redacted:len=4>', keep: 'me' }],
    });
  });

  it('drops opaque subtrees entirely', () => {
    const tree = { lastBootstrapInput: { aws: { secretKey: 'sk-123' } }, name: 'x' };
    expect(redactDeep(tree, { lastBootstrapInput: 'opaque' })).toEqual({
      lastBootstrapInput: '<redacted>',
      name: 'x',
    });
  });

  it('leaves empty secrets empty (desktop-managed profiles carry "" by policy)', () => {
    expect(redactDeep({ secret: '' }, { secret: 'string-len' })).toEqual({ secret: '' });
  });

  it('named redactors cover their stores (secret / bootstrap-input / egress helper)', () => {
    expect(redactProfilesFile({ profiles: { a: { secret: 'x', keyId: 'k' } } })).toEqual({
      profiles: { a: { secret: '<redacted:len=1>', keyId: 'k' } },
    });
    expect(redactDesktopConfig({ last_bootstrap_input: { x: 1 }, apiKey: { secret: 'ss' } })).toEqual({
      last_bootstrap_input: '<redacted>',
      apiKey: { secret: '<redacted:len=2>' },
    });
    expect(redactEgressPolicy({ default: 'deny', helper: 'cmd' })).toEqual({
      default: 'deny',
      helper: '<redacted:len=3>',
    });
  });
});

describe('scrubLogText', () => {
  it('scrubs 32+ hex runs and JWTs but keeps ordinary diagnostics', () => {
    const hex = 'deadbeef'.repeat(8);
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln';
    const text = `token=${hex} bearer ${jwt} commit 548b1b1 uuid 2b06a172-1ea9-4410-b42c-e06eae91843b`;
    const scrubbed = scrubLogText(text);
    expect(scrubbed).not.toContain(hex);
    expect(scrubbed).not.toContain(jwt);
    expect(scrubbed).toContain('commit 548b1b1');
    expect(scrubbed).toContain('2b06a172-1ea9-4410-b42c-e06eae91843b');
  });

  it('scrubs sk_-prefixed minted api-key secrets (the underscore defeats the plain hex rule)', () => {
    // Minted secrets are `sk_` + 64 hex (api-key.service.ts); mint error
    // paths can paint full responses into host.log, which bundles ship.
    const minted = `sk_${'5f'.repeat(32)}`;
    const openai = `sk-${'ab'.repeat(20)}`;
    const scrubbed = scrubLogText(`mint failed: secret=${minted} upstream=${openai} status=500`);
    expect(scrubbed).not.toContain(minted);
    expect(scrubbed).not.toContain(openai);
    expect(scrubbed).toContain('status=500');
    // Short sk_-words are ordinary identifiers, not secrets.
    expect(scrubLogText('sk_live sk_test_short')).toBe('sk_live sk_test_short');
  });
});

describe('kubeconfigServerLines', () => {
  it('keeps only the server line — never certificate material', () => {
    const raw = [
      'apiVersion: v1',
      'clusters:',
      '- cluster:',
      '    certificate-authority-data: CERTBYTES',
      '    server: https://127.0.0.1:6443',
      'users:',
      '- user:',
      '    client-key-data: KEYBYTES',
    ].join('\n');
    const out = kubeconfigServerLines(raw);
    expect(out).toContain('server: https://127.0.0.1:6443');
    expect(out).not.toContain('CERTBYTES');
    expect(out).not.toContain('KEYBYTES');
  });
});

// ---- THE redaction test: plant a secret in every redacted location, ----------
// ---- build the real tarball, assert none of them survive. --------------------

const PLANTED = {
  profileSecret: 'PLANTED-PROFILE-SECRET-f00',
  bootstrapInput: 'PLANTED-BOOTSTRAP-INPUT-AWS-KEY',
  legacySecret: 'PLANTED-LEGACY-CREDENTIALS-SECRET',
  bootstrapToken: 'ab12'.repeat(16), // 64 hex — the real token shape
  egressSecret: 'PLANTED-CAPTURED-OPENAI-KEY',
  kubeCert: 'PLANTEDCERTIFICATEDATA',
  kubeKey: 'PLANTEDCLIENTKEYDATA',
  consoleToken: 'deadbeefcafef00d'.repeat(4), // 64 hex painted into console.log
  mintedSecret: `sk_${'0badf00d'.repeat(8)}`, // sk_ + 64 hex — the minted api-key shape
  saJwt: 'eyJhbGciOiJSUzI1NiJ9.eyJQTEFOVEVEIjp0cnVlfQ.UExBTlRFRFNJR05BVFVSRQ',
  helperCmd: 'cat /secrets/PLANTED-HELPER-API-KEY',
  desktopSecret: 'PLANTED-DESKTOP-APIKEY-SECRET',
  apiserverLogToken: '0123456789abcdef'.repeat(4), // via an engine that did NOT scrub
};

describe('writeSupportBundle redaction', () => {
  let home: string;
  let outDir: string;
  let extracted: string;
  /** Every file in the tarball, concatenated — the haystack. */
  let bundleText: string;
  /** Relative paths of every file in the tarball. */
  let bundleFiles: string[];

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-bundle-home-'));
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-bundle-out-'));
    const appliance = path.join(home, '.appliance');
    const vmDir = path.join(appliance, 'vm', 'appliance');
    fs.mkdirSync(vmDir, { recursive: true });
    fs.mkdirSync(path.join(appliance, 'vm', 'images', 'guest-assets'), { recursive: true });

    // Redacted-in-place locations.
    fs.writeFileSync(
      path.join(appliance, 'profiles.json'),
      JSON.stringify({
        version: 1,
        activeProfile: 'local',
        profiles: {
          local: {
            apiUrl: 'http://api.appliance.localhost:8081',
            keyId: 'k-local',
            secret: PLANTED.profileSecret,
            lastBootstrapInput: { aws: { secretAccessKey: PLANTED.bootstrapInput } },
          },
        },
      })
    );
    const desktopConfig = path.join(home, 'desktop-config.json');
    fs.writeFileSync(
      desktopConfig,
      JSON.stringify({
        clusters: [{ id: 'c1', name: 'Dev', lastBootstrapInput: { aws: { secret: PLANTED.bootstrapInput } } }],
        apiKey: { id: 'k-desktop', secret: PLANTED.desktopSecret },
      })
    );
    fs.writeFileSync(
      path.join(vmDir, 'egress-policy.json'),
      JSON.stringify({ default: 'deny', allow: ['api.openai.com'], helper: PLANTED.helperCmd })
    );

    // Never-included locations.
    fs.writeFileSync(path.join(appliance, 'credentials.json'), JSON.stringify({ secret: PLANTED.legacySecret }));
    fs.writeFileSync(path.join(vmDir, 'bootstrap-token'), PLANTED.bootstrapToken);
    fs.writeFileSync(
      path.join(vmDir, 'egress-secrets.json'),
      JSON.stringify({ 'api.openai.com': { authorization: PLANTED.egressSecret } })
    );
    fs.writeFileSync(
      path.join(vmDir, 'kubeconfig.yaml'),
      `apiVersion: v1\nclusters:\n- cluster:\n    certificate-authority-data: ${PLANTED.kubeCert}\n    server: https://127.0.0.1:6443\nusers:\n- user:\n    client-key-data: ${PLANTED.kubeKey}\n`
    );

    // Scrubbed log tails.
    fs.writeFileSync(
      path.join(vmDir, 'console.log'),
      `boot ok\n+ export BOOTSTRAP_TOKEN=${PLANTED.consoleToken}\n+ SA_TOKEN=${PLANTED.saJwt}\napi-server up\n`
    );
    fs.writeFileSync(
      path.join(vmDir, 'host.log'),
      // A mint error path can paint the full response — minted secret
      // included — into host.log; the sk_ prefix keeps it one word.
      `host log line\ntoken ${PLANTED.consoleToken}\nmint 500: {"secret":"${PLANTED.mintedSecret}"}\n`
    );

    // Plain state that ships as-is.
    fs.writeFileSync(path.join(vmDir, 'vm.json'), JSON.stringify({ name: 'appliance', hostPort: 8081 }));
    fs.writeFileSync(path.join(vmDir, 'bringup.json'), JSON.stringify({ phase: 'ready', since: 1 }));
    fs.writeFileSync(
      path.join(appliance, 'vm', 'images', 'guest-assets', 'appliance-api-server.version'),
      'v1.51.2:arm64'
    );

    // A stub engine whose api-server log tail was NOT scrubbed
    // server-side (an old engine) — the client-side scrub must catch it.
    const engine: ProcessRunner = (args) => {
      if (args[0] === '--version') return { status: 0, stdout: 'appliance-vm 0.1.0\n' };
      if (args[0] === 'status') return { status: 0, stdout: JSON.stringify({ name: 'appliance', running: true }) };
      if (args[0] === 'doctor' && args[1] === '--apiserver-log') {
        return { status: 0, stdout: `auth failed keyId=k-dead token=${PLANTED.apiserverLogToken}\n` };
      }
      return { status: 1, stdout: '' };
    };
    const kubectl: ProcessRunner = () => ({
      status: 0,
      stdout: JSON.stringify({ items: [{ metadata: { name: 'appliance-api-server', namespace: 'default' } }] }),
    });

    const tarball = await writeSupportBundle({
      vm: 'appliance',
      report: { ok: false, note: 'test report' },
      outPath: path.join(outDir, 'bundle.tar.gz'),
      homeDir: home,
      desktopConfigPaths: [desktopConfig],
      engine,
      kubectl,
    });

    extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-bundle-x-'));
    // Relative -f + cwd, matching writeSupportBundle: GNU tar parses an
    // absolute `C:\…` archive path as a remote host on Windows.
    const untar = spawnSync('tar', ['-xzf', path.basename(tarball), '-C', extracted], { cwd: path.dirname(tarball) });
    expect(untar.status).toBe(0);

    bundleFiles = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        // Posix separators so expectations read the same on Windows.
        else bundleFiles.push(path.relative(extracted, full).split(path.sep).join('/'));
      }
    };
    walk(extracted);
    bundleText = bundleFiles.map((f) => fs.readFileSync(path.join(extracted, f), 'utf8')).join('\n---\n');
  });

  afterAll(() => {
    for (const dir of [home, outDir, extracted]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never contains ANY planted secret, in any file', () => {
    for (const [name, secret] of Object.entries(PLANTED)) {
      expect(bundleText, `planted secret '${name}' leaked into the bundle`).not.toContain(secret);
    }
  });

  it('never packs the forbidden files at all', () => {
    for (const forbidden of [
      'bootstrap-token',
      'egress-secrets.json',
      'kubeconfig.yaml',
      'credentials.json',
      'profiles.json', // only profiles.REDACTED.json ships
    ]) {
      expect(
        bundleFiles.some((f) => path.basename(f) === forbidden),
        `${forbidden} must never be in the bundle`
      ).toBe(false);
    }
  });

  it('ships the diagnostic surface: report, env, redacted stores, VM state, scrubbed logs', () => {
    for (const expected of [
      'report.json',
      'env.json',
      'profiles.redacted.json',
      'desktop-config.redacted.json',
      'guest-assets/stamp',
      'vm/appliance/vm.json',
      'vm/appliance/bringup.json',
      'vm/appliance/status.json',
      'vm/appliance/host.log',
      'vm/appliance/console.log',
      'vm/appliance/egress-policy.json',
      'vm/appliance/apiserver.log',
      'vm/appliance/kubeconfig-server.txt',
      'vm/appliance/kubectl/ingress.json',
    ]) {
      expect(bundleFiles, `${expected} missing from the bundle`).toContain(expected);
    }
  });

  it('keeps the diagnosability the redaction is careful about', () => {
    const profiles = JSON.parse(fs.readFileSync(path.join(extracted, 'profiles.redacted.json'), 'utf8')) as {
      profiles: Record<string, { keyId: string; secret: string }>;
    };
    // keyId survives (identifies WHICH key without granting anything);
    // the secret's length marker survives for staleness diagnosis.
    expect(profiles.profiles.local.keyId).toBe('k-local');
    expect(profiles.profiles.local.secret).toBe(`<redacted:len=${PLANTED.profileSecret.length}>`);

    const env = JSON.parse(fs.readFileSync(path.join(extracted, 'env.json'), 'utf8')) as {
      bootstrapToken: { present: boolean; mtime: string | null };
    };
    // Token presence + mtime ride along — the content never does.
    expect(env.bootstrapToken.present).toBe(true);
    expect(env.bootstrapToken.mtime).toBeTruthy();

    // The kubeconfig's server line is recorded (where the client points).
    expect(fs.readFileSync(path.join(extracted, 'vm/appliance/kubeconfig-server.txt'), 'utf8')).toContain(
      'server: https://127.0.0.1:6443'
    );

    // Scrubbed logs keep their context lines.
    const consoleLog = fs.readFileSync(path.join(extracted, 'vm/appliance/console.log'), 'utf8');
    expect(consoleLog).toContain('BOOTSTRAP_TOKEN=<scrubbed:');
    expect(consoleLog).toContain('api-server up');
  });
});
