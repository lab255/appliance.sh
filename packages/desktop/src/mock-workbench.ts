import type { WorkbenchHost, WorkbenchWorkspace } from '@appliance.sh/app';

/** Explicit browser fixtures; no filesystem writes or live agent claims. */
export function createMockWorkbench(): WorkbenchHost {
  const fixture = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search).get(
    'workbench-fixture'
  );
  const rows = new Map<string, WorkbenchWorkspace>();
  const directory = '/Users/dev/projects/demo-node-container';
  const corrupt = (path: string) => ({
    kind: 'unreadable-file' as const,
    path,
    reason: 'EOF while parsing an object at line 1 column 1',
  });
  const make = (path: string): WorkbenchWorkspace => ({
    directory: path,
    binding: {
      version: 1,
      ...(fixture === 'save-error-bound' ? { selectedTarget: { kind: 'cloud' as const, ref: 'mock-acme-prod' } } : {}),
    },
    ...(fixture === 'corrupt-binding' ? { error: corrupt(`${path}/.appliance/workbench.json`) } : {}),
    machine: 'appliance',
    mount: fixture === 'mismatch' ? '/Users/dev/projects/another-folder' : path,
    sessions: [],
    baselineWarning: 'No baseline captured — change comparison will be unavailable',
  });
  if (fixture && fixture !== 'empty') rows.set(directory, make(directory));
  const delay = () => new Promise((resolve) => setTimeout(resolve, fixture === 'delayed' ? 800 : 100));
  return {
    async forget(path) {
      rows.delete(path);
    },
    async list() {
      await delay();
      if (fixture === 'corrupt-index') throw corrupt('/app-data/workbench-directories.json');
      return [...rows.values()];
    },
    async open(path) {
      await delay();
      if (fixture === 'corrupt-binding') throw corrupt(`${path}/.appliance/workbench.json`);
      const row = rows.get(path) || make(path);
      rows.set(path, row);
      return row;
    },
    async read(path) {
      const row = rows.get(path);
      if (!row) throw new Error('Folder not found');
      return row;
    },
    async create(parent, name) {
      await delay();
      const path = `${parent.replace(/\/$/, '')}/${name}`;
      if (name === 'conflict' || rows.has(path)) throw new Error('Could not create folder: already exists');
      const row = make(path);
      rows.set(path, row);
      return row;
    },
    async update(path, binding) {
      await delay();
      if (fixture === 'corrupt-save') throw corrupt(`${path}/.appliance/workbench.json`);
      if (fixture === 'save-error' || fixture === 'save-error-bound') throw new Error('Folder is not writable');
      const row = rows.get(path);
      if (!row) throw new Error('Folder not found');
      const updated = { ...row, binding };
      rows.set(path, updated);
      return updated;
    },
  };
}
