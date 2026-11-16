import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readWorkbenchBinding, resolveWorkbenchDirectory, writeWorkbenchBinding } from './workbench.js';
const roots: string[] = [];
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
describe('Workbench binding ownership', () => {
  it('resolves nested and symlink directories to the existing project root', () => {
    const root = project();
    fs.mkdirSync(path.join(root, '.appliance'));
    fs.writeFileSync(path.join(root, '.appliance/link.json'), '{}');
    fs.mkdirSync(path.join(root, 'src'));
    fs.symlinkSync(path.join(root, 'src'), path.join(root, 'alias'));
    expect(resolveWorkbenchDirectory(path.join(root, 'alias'))).toBe(fs.realpathSync(root));
  });
  it('writes only view metadata while preserving link and registry bytes', () => {
    const root = project();
    fs.mkdirSync(path.join(root, '.appliance'));
    const original = '{"sentinel": 1}\n';
    for (const file of ['link.json', 'agents.json']) fs.writeFileSync(path.join(root, '.appliance', file), original);
    writeWorkbenchBinding(root, {
      version: 1,
      label: 'Example',
      selectedTarget: { kind: 'cloud', ref: 'cloud-id' },
      mutatingSessionId: 'agent-1',
    });
    expect(readWorkbenchBinding(root).selectedTarget?.ref).toBe('cloud-id');
    for (const file of ['link.json', 'agents.json'])
      expect(fs.readFileSync(path.join(root, '.appliance', file), 'utf8')).toBe(original);
  });
  it('does not require metadata for an ordinary project and rejects non-view fields', () => {
    const root = project();
    expect(readWorkbenchBinding(root)).toEqual({ version: 1 });
    expect(fs.readdirSync(root)).toEqual([]);
    expect(() => writeWorkbenchBinding(root, { version: 1, apiKey: 'secret' } as never)).toThrow();
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it('reports corrupt and future format files without treating them as defaults', () => {
    const root = project();
    fs.mkdirSync(path.join(root, '.appliance'));
    for (const value of ['{', '{"version":2}']) {
      fs.writeFileSync(path.join(root, '.appliance/workbench.json'), value);
      expect(() => readWorkbenchBinding(root)).toThrow();
    }
  });
});
