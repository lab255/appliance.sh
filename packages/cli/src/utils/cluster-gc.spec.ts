import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { microVmGone } from './cluster-gc';
import { resolveProfile, type ProfilesFile } from './profile-store';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof fs>()) }));

const homes: string[] = [];
function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-gc-'));
  homes.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
describe('microVmGone', () => {
  it('rejects missing default and named VMs but preserves remote clusters', () => {
    const dir = home();
    expect(microVmGone('microvm', dir)).toBe(true);
    expect(microVmGone('microvm-test', dir)).toBe(true);
    expect(microVmGone('cloud', dir)).toBe(false);
  });
  it.each(['vm', 'vmm'])('keeps stopped VMs in the %s registry', (root) => {
    const dir = home();
    const vm = path.join(dir, '.appliance', root, 'test');
    fs.mkdirSync(vm, { recursive: true });
    fs.writeFileSync(path.join(vm, 'vm.json'), '{}');
    expect(microVmGone('microvm-test', dir)).toBe(false);
  });
  it('does not treat registry errors as deletion', () => {
    const dir = home();
    fs.mkdirSync(path.join(dir, '.appliance'));
    fs.writeFileSync(path.join(dir, '.appliance', 'vm'), 'not a directory');
    expect(() => microVmGone('microvm-test', dir)).toThrow();
  });
});

describe('default profile safety', () => {
  it('collects loopback local but preserves remote local', () => {
    const dir = home();
    expect(microVmGone('local', dir, 'http://api.appliance.localhost:8081')).toBe(true);
    expect(microVmGone('local', dir, 'https://remote.example')).toBe(false);
    expect(microVmGone('local', dir, 'https://localhost.example')).toBe(false);
    const vm = path.join(dir, '.appliance', 'vm', 'appliance');
    fs.mkdirSync(vm, { recursive: true });
    fs.writeFileSync(path.join(vm, 'vm.json'), '{}');
    expect(microVmGone('local', dir, 'http://127.0.0.1:8081')).toBe(false);
  });

  it('refuses gone local credentials but permits removal and remote logins', () => {
    vi.spyOn(fs, 'statSync').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    });
    const file: ProfilesFile = {
      version: 1,
      activeProfile: 'local',
      profiles: {
        local: { apiUrl: 'http://localhost:8081', keyId: 'key', secret: 'secret' },
      },
    };
    expect(() => resolveProfile(file, { override: 'local' })).toThrow('microVM is gone');
    expect(resolveProfile(file, { override: 'local', allowUnavailable: true })?.name).toBe('local');
    file.profiles.local.apiUrl = 'https://remote.example';
    expect(resolveProfile(file, { override: 'local' })?.profile.apiUrl).toBe('https://remote.example');
  });
});
