import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readRuntimeRegistry,
  removeRuntimeRecord,
  updateRuntimeRecord,
  upsertRuntimeRecord,
  type RuntimeRecord,
} from './runtime-registry.js';

const dirs: string[] = [];

function tempRegistry(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-runtime-registry-'));
  dirs.push(dir);
  return path.join(dir, 'registry.json');
}

function record(appId: string): RuntimeRecord {
  return {
    appId,
    version: '1.0.0',
    state: 'running',
    principalIp: '192.168.127.10',
    hostPorts: [{ name: 'http', host: 20000, guest: 3000, protocol: 'tcp' }],
    startedAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    poolVm: 'appliance-runtime',
    poolRestartPending: false,
    bundlePath: '/tmp/journal.appliance.zip',
    installDir: '/tmp/journal',
    shareTag: 'ap-0123456789abcdef0123456789abcdef',
    uid: 20000,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('runtime registry', () => {
  it('atomically upserts, updates, and removes records', () => {
    const file = tempRegistry();
    upsertRuntimeRecord(record('journal'), file);
    upsertRuntimeRecord({ ...record('api'), principalIp: '192.168.127.11', uid: 20001 }, file);
    expect(readRuntimeRegistry(file).map((entry) => entry.appId)).toEqual(['api', 'journal']);
    expect(updateRuntimeRecord('journal', { state: 'exited', exitCode: 7 }, file)).toMatchObject({
      state: 'exited',
      exitCode: 7,
    });
    expect(removeRuntimeRecord('api', file)).toBe(true);
    expect(removeRuntimeRecord('missing', file)).toBe(false);
    expect(readRuntimeRegistry(file)).toHaveLength(1);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['registry.json']);
  });

  it('fails closed to an empty registry for corrupt input', () => {
    const file = tempRegistry();
    fs.writeFileSync(file, '{broken');
    expect(readRuntimeRegistry(file)).toEqual([]);
  });
});
