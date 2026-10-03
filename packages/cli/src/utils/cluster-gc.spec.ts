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
    const denied = Object.assign(new Error('registry access denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'statSync').mockImplementation(() => {
      throw denied;
    });
    expect(() => microVmGone('microvm-test', home())).toThrow(denied);
  });
  it.each(['EPERM', 'EBUSY', 'EIO', 'ELOOP', 'ENOTDIR'])('propagates %s without declaring deletion', (code) => {
    const error = Object.assign(new Error(code), { code });
    vi.spyOn(fs, 'statSync').mockImplementation(() => {
      throw error;
    });
    expect(() => microVmGone('microvm-test', home())).toThrow(error);
  });
  it.each(['vm', 'vmm'])('keeps a record when %s is a file (Windows ENOENT, Unix ENOTDIR)', (root) => {
    const dir = home();
    fs.mkdirSync(path.join(dir, '.appliance'));
    fs.writeFileSync(path.join(dir, '.appliance', root), 'not a directory');
    let code: string | undefined;
    try {
      fs.statSync(path.join(dir, '.appliance', root, 'test', 'vm.json'));
    } catch (error) {
      code = (error as NodeJS.ErrnoException).code;
    }
    expect(code).toBe(process.platform === 'win32' ? 'ENOENT' : 'ENOTDIR');
    expect(() => microVmGone('microvm-test', dir)).toThrow();
  });
  it('handles Windows ENOENT for both stat and directory traversal through a file', () => {
    const dir = home();
    fs.mkdirSync(path.join(dir, '.appliance'));
    fs.writeFileSync(path.join(dir, '.appliance', 'vm'), 'not a directory');
    const missing = Object.assign(new Error('ambiguous Windows ENOENT'), { code: 'ENOENT' });
    vi.spyOn(fs, 'statSync').mockImplementationOnce(() => {
      throw missing;
    });
    vi.spyOn(fs, 'readdirSync')
      .mockImplementationOnce(() => {
        throw missing;
      })
      .mockImplementationOnce(() => {
        throw missing;
      });
    expect(() => microVmGone('microvm-test', dir)).toThrow(missing);
  });
  it('keeps a present but unstatable entry, including a broken reparse point', () => {
    const dir = home();
    const vm = path.join(dir, '.appliance', 'vm', 'test');
    fs.mkdirSync(vm, { recursive: true });
    fs.writeFileSync(path.join(vm, 'vm.json'), '{}');
    const missing = Object.assign(new Error('unstatable entry'), { code: 'ENOENT' });
    vi.spyOn(fs, 'statSync').mockImplementationOnce(() => {
      throw missing;
    });
    expect(() => microVmGone('microvm-test', dir)).toThrow(missing);
  });
  it('does not infer absence when parent enumeration is denied', () => {
    const missing = Object.assign(new Error('ambiguous'), { code: 'ENOENT' });
    const denied = Object.assign(new Error('listing denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'statSync').mockImplementationOnce(() => {
      throw missing;
    });
    vi.spyOn(fs, 'readdirSync').mockImplementationOnce(() => {
      throw denied;
    });
    expect(() => microVmGone('microvm-test', home())).toThrow(denied);
  });
  it('keeps records when the drive or root cannot be inspected', () => {
    const missing = Object.assign(new Error('unavailable root'), { code: 'ENOENT' });
    vi.spyOn(fs, 'statSync').mockImplementation(() => {
      throw missing;
    });
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw missing;
    });
    expect(() => microVmGone('microvm-test', home())).toThrow(missing);
  });
  it.each(['bad:name', 'bad?name', 'trailing.', 'trailing ', 'NUL', 'COM1'])(
    'keeps an ambiguous Win32 name: %s',
    (name) => {
      expect(() => microVmGone(`microvm-${name}`, home())).toThrow();
    }
  );
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
    // An actual absence additionally requires a successful directory listing.
    vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
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
