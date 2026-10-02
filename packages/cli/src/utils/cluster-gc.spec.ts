import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { microVmGone } from './cluster-gc';

const homes: string[] = [];
function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-gc-'));
  homes.push(dir);
  return dir;
}
afterEach(() => {
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
