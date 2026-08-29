import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import {
  REQUIRED_PORTS,
  checkDiskSpace,
  checkMacSigning,
  checkPorts,
  checkWsl,
  classifyWslFailure,
  decodeWindowsToolOutput,
  decodeWslConfig,
  runFixes,
  wslConfigUsesMirroredNetworking,
  WSL_MIRRORED_REMEDIATION,
} from './preflight.js';
import type { PreflightReport } from './preflight.js';

interface WslOutputManifest {
  classifications: Array<{ key: string; signatures: string[]; remediation: string }>;
  fixtures: Array<{ file: string; decoded: string; classification: string }>;
}

const wslOutputFixtureRoot = new URL('../../../vm/tests/fixtures/wsl-output/', import.meta.url);
const wslOutputManifest = JSON.parse(
  fs.readFileSync(new URL('expected.json', wslOutputFixtureRoot), 'utf8')
) as WslOutputManifest;

// These tests cover the deterministic decision logic in the preflight
// suite — the bits that don't depend on what's installed on the test
// machine. Docker is deliberately absent from the suite: nothing in the
// appliance flow needs it (the control plane is a guest binary and
// images build server-side), so no check may reintroduce it.

describe('runPreflight surface', () => {
  it('carries no docker checks — the flow is docker-free by contract', async () => {
    const preflight = await import('./preflight.js');
    expect('checkDockerRuntime' in preflight).toBe(false);
    expect('checkApiServerImage' in preflight).toBe(false);
  });
});

describe('checkMacSigning', () => {
  it('passes as not-applicable off macOS', () => {
    if (process.platform === 'darwin') {
      // On macOS it is an informational warn pointing at the signing step.
      const result = checkMacSigning();
      expect(result.status).toBe('warn');
      expect(result.remediation).toMatch(/sign-dev\.sh|xcode-select/);
    } else {
      const result = checkMacSigning();
      expect(result.status).toBe('pass');
      expect(result.detail).toMatch(/not applicable/i);
    }
  });
});

describe('checkPorts', () => {
  it('returns a result per required port with a stable id', async () => {
    const results = await checkPorts();
    expect(results).toHaveLength(REQUIRED_PORTS.length);
    for (const r of results) {
      expect(r.id).toMatch(/^port:\d+$/);
      expect(['pass', 'fail']).toContain(r.status);
    }
  });
});

describe('checkWsl', () => {
  it('passes as not-applicable off Windows, and reaches a verdict on Windows', () => {
    const result = checkWsl();
    if (process.platform === 'win32') {
      // This machine either has working WSL (pass) or a failure with an
      // actionable remediation — never a throw, never an empty verdict.
      expect(['pass', 'fail']).toContain(result.status);
      if (result.status === 'fail') expect(result.remediation).toBeTruthy();
    } else {
      expect(result.status).toBe('pass');
      expect(result.detail).toMatch(/not applicable/i);
    }
  });
});

describe('decodeWindowsToolOutput', () => {
  it('decodes every shared WSL output fixture', () => {
    for (const fixture of wslOutputManifest.fixtures) {
      const bytes = fs.readFileSync(new URL(fixture.file, wslOutputFixtureRoot));
      expect(decodeWindowsToolOutput(bytes), fixture.file).toBe(fixture.decoded);
      expect(decodeWslConfig(bytes), fixture.file).toBe(fixture.decoded);
    }
  });
});

describe('classifyWslFailure', () => {
  it('maps every shared fixture and signature to its shared key and remediation', () => {
    for (const fixture of wslOutputManifest.fixtures) {
      const bytes = fs.readFileSync(new URL(fixture.file, wslOutputFixtureRoot));
      expect(classifyWslFailure(decodeWindowsToolOutput(bytes)).key, fixture.file).toBe(fixture.classification);
    }
    for (const rule of wslOutputManifest.classifications) {
      for (const signature of rule.signatures) {
        const classification = classifyWslFailure(signature);
        expect(classification.key, signature).toBe(rule.key);
        expect(classification.remediation, signature).toBe(rule.remediation);
      }
    }
  });

  it('maps the HCS virtualization-disabled error to the BIOS/feature fix', () => {
    const { detail, remediation } = classifyWslFailure(
      'WslRegisterDistribution failed with error: 0x80370102\nPlease enable the Virtual Machine Platform Windows feature and ensure virtualization is enabled in the BIOS.'
    );
    expect(detail).toMatch(/virtualization/i);
    expect(remediation).toMatch(/BIOS/);
    expect(remediation).toMatch(/VirtualMachinePlatform/);
  });

  it('maps a missing/outdated kernel to wsl --update', () => {
    expect(classifyWslFailure('The WSL 2 kernel file is not found. Please run wsl --update').remediation).toMatch(
      /wsl --update/
    );
  });

  it('maps a not-installed WSL to wsl --install with a reboot', () => {
    const { remediation } = classifyWslFailure(
      'Windows Subsystem for Linux has no installed distributions. Use wsl --install.'
    );
    expect(remediation).toMatch(/wsl --install/);
    expect(remediation).toMatch(/reboot/i);
  });

  it('falls back to pointing at wsl --status for unrecognized failures', () => {
    const { remediation } = classifyWslFailure('some novel breakage');
    expect(remediation).toMatch(/wsl --status/);
  });
});

describe('wslConfigUsesMirroredNetworking', () => {
  it('detects mirrored mode from the shared UTF-8 and UTF-16LE fixtures', () => {
    for (const name of ['wslconfig-mirrored.ini', 'wslconfig-mirrored-utf16le.ini']) {
      const bytes = fs.readFileSync(new URL(`../../../vm/tests/fixtures/${name}`, import.meta.url));
      expect(wslConfigUsesMirroredNetworking(decodeWslConfig(bytes))).toBe(true);
    }
    expect(WSL_MIRRORED_REMEDIATION).toContain('networkingMode=NAT');
    expect(WSL_MIRRORED_REMEDIATION).toContain('wsl --shutdown');
  });

  it('ignores comments and lets the final [wsl2] value win', () => {
    expect(wslConfigUsesMirroredNetworking('[wsl2]\n# networkingMode=mirrored\nnetworkingMode=NAT')).toBe(false);
    expect(wslConfigUsesMirroredNetworking('[wsl2]\nnetworkingMode=mirrored\nnetworkingMode = NAT')).toBe(false);
  });
});

describe('checkDiskSpace', () => {
  it('probes the nearest existing ancestor of a not-yet-created dir and reports GB free', () => {
    const result = checkDiskSpace();
    expect(['pass', 'warn', 'fail']).toContain(result.status);
    // Whatever the verdict, the detail names the probed location so the
    // user knows which disk is short.
    if (result.detail && !/could not probe/.test(result.detail)) {
      expect(result.detail).toMatch(/GB free at /);
    }
  });
});

describe('runFixes', () => {
  function reportWith(results: PreflightReport['results']): PreflightReport {
    return { ok: true, results };
  }

  it('does nothing when every check passes', async () => {
    expect(await runFixes(reportWith([{ id: 'bin:kubectl', label: 'kubectl', status: 'pass' }]))).toEqual([]);
  });

  it('ignores non-binary failures (ports, toolchain) — those stay with the operator', async () => {
    expect(
      await runFixes(
        reportWith([
          { id: 'port:8081', label: 'Port 8081 free', status: 'fail', detail: 'occupied' },
          { id: 'rust', label: 'Rust toolchain', status: 'warn', detail: 'missing' },
        ])
      )
    ).toEqual([]);
  });
});
