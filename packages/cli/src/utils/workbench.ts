import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

/** View preferences only. Never store credentials, API records or results here. */
export interface WorkbenchBinding {
  version: 1;
  label?: string;
  selectedTarget?: { kind: 'local' | 'cloud'; ref: string };
  mutatingSessionId?: string;
}

/** Nearest existing link or binding, with canonical directory identity. */
export function resolveWorkbenchDirectory(directory: string): string {
  const start = fs.realpathSync(directory);
  if (!fs.statSync(start).isDirectory()) throw new Error('Choose a directory');
  let current = start;
  while (true) {
    if (['link.json', 'workbench.json'].some((file) => fs.existsSync(path.join(current, '.appliance', file))))
      return current;
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

export function validateWorkbenchBinding(value: unknown): WorkbenchBinding {
  if (!value || typeof value !== 'object') throw new Error('Invalid Workbench binding');
  const v = value as Record<string, unknown>;
  if (
    v.version !== 1 ||
    Object.keys(v).some((key) => !['version', 'label', 'selectedTarget', 'mutatingSessionId'].includes(key))
  )
    throw new Error('Unsupported Workbench binding');
  for (const key of ['label', 'mutatingSessionId'])
    if (v[key] !== undefined && typeof v[key] !== 'string') throw new Error(`Invalid ${key}`);
  if (v.selectedTarget !== undefined) {
    const target = v.selectedTarget as Record<string, unknown>;
    if (
      !target ||
      typeof target !== 'object' ||
      !['local', 'cloud'].includes(String(target.kind)) ||
      typeof target.ref !== 'string' ||
      !target.ref ||
      Object.keys(target).some((key) => !['kind', 'ref'].includes(key))
    )
      throw new Error('Invalid deployment target');
  }
  return v as unknown as WorkbenchBinding;
}

export function readWorkbenchBinding(directory: string): WorkbenchBinding {
  const file = path.join(resolveWorkbenchDirectory(directory), '.appliance', 'workbench.json');
  if (!fs.existsSync(file)) return { version: 1 };
  return validateWorkbenchBinding(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function writeWorkbenchBinding(directory: string, binding: WorkbenchBinding): void {
  const value = validateWorkbenchBinding(binding);
  readWorkbenchBinding(directory);
  const root = resolveWorkbenchDirectory(directory);
  const folder = path.join(root, '.appliance');
  fs.mkdirSync(folder, { recursive: true });
  const temporary = path.join(folder, `.workbench.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, path.join(folder, 'workbench.json'));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
