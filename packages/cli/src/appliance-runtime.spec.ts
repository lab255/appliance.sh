import { applianceV2Input } from '@appliance.sh/sdk';
import { describe, expect, it } from 'vitest';
import { manifestToRuntimePlan, sanitizeRuntimeLog } from './appliance-runtime.js';

function manifest(resources: Record<string, number> = {}) {
  return applianceV2Input.parse({
    manifest: 'v2',
    kind: 'runnable',
    type: 'container',
    name: 'journal',
    version: '1.2.3',
    license: 'MIT',
    publisher: { name: 'Lab 255' },
    payload: {
      images: {
        'linux/arm64': { path: 'payload/journal.oci.tar' },
        'linux/amd64': { path: 'payload/journal.oci.tar' },
      },
    },
    ports: [{ name: 'http', guest: 3000, protocol: 'tcp', expose: 'host', primary: true }],
    resources,
  });
}

describe('manifest to pooled runtime plan', () => {
  it('targets published ports at the principal /32 and maps resources to cgroup hints', () => {
    const plan = manifestToRuntimePlan(
      manifest({ cpus: 2, memoryMib: 1024, diskGib: 4 }),
      '/tmp/journal',
      '192.168.127.10',
      20000,
      [{ name: 'http', host: 20000, guest: 3000, protocol: 'tcp' }]
    );
    expect(plan.ports).toEqual([
      {
        name: 'http',
        host: 20000,
        guest: 3000,
        protocol: 'tcp',
        relay: 22000,
        target: '192.168.127.10',
      },
    ]);
    expect(plan.resources).toEqual({ cpus: 2, memoryMib: 1024, diskGib: 4, pids: 256 });
    expect(plan.share).toMatchObject({ readOnly: true, hostPath: '/tmp/journal' });
    expect(plan.share.tag).toMatch(/^ap-[0-9a-f]{32}$/);
  });

  it('applies RFC defaults without changing the 2 CPU / 4 GiB pool size', () => {
    expect(
      manifestToRuntimePlan(manifest(), '/tmp/journal', '192.168.127.10', 20000, [
        { name: 'http', host: 20000, guest: 3000, protocol: 'tcp' },
      ]).resources
    ).toEqual({ cpus: 1, memoryMib: 512, diskGib: 2, pids: 256 });
  });

  it('bounds relay allocation to one 16-port principal slice', () => {
    const value = manifest();
    value.ports = Array.from({ length: 17 }, (_, index) => ({
      name: `p${index}`,
      guest: 3000 + index,
      protocol: 'tcp' as const,
      expose: 'host' as const,
      primary: index === 0,
    }));
    expect(() =>
      manifestToRuntimePlan(
        value,
        '/tmp/journal',
        '192.168.127.10',
        20000,
        value.ports.map((port, index) => ({ ...port, host: 20000 + index }))
      )
    ).toThrow('at most 16 ports');
  });
});

describe('runtime log rendering', () => {
  it('strips ANSI and terminal control bytes while preserving lines and tabs', () => {
    expect(sanitizeRuntimeLog('\u001b[31mred\u001b[0m\u0000\u0007\tline\nnext\u007f')).toBe('red\tline\nnext');
  });
});
