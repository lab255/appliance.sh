/** Development-only polish fixture; not imported by the application entry point. */
import { createRoot } from 'react-dom/client';
import { MotionProvider } from '@appliance.sh/ui';
import { HostProvider } from '@/providers/host-provider';
import type { ConsoleHost } from '@/lib/host';
import type { Inspection } from '@/lib/inspection';
import { WorkspaceInspector } from './workspace-inspector';
import '@/styles.css';

const params = new URLSearchParams(location.search);
const directory = '/Users/operator/projects/dirty-workspace';
const snapshot: Inspection = {
  snapshotId: 'fixture-snapshot',
  directory,
  capturedAt: '2026-11-17T12:00:00Z',
  refreshedAt: '2026-11-17T12:10:00Z',
  comparisonError: params.has('unavailable') ? 'Capture failed' : null,
  initialGitStatus: ' M src/initial-dirty.ts\n?? notes.txt\n',
  entries: [
    { path: 'src/', size: 0, state: 'unchanged', generated: false, issue: 'Directory — read-only' },
    { path: 'empty/', size: 0, state: 'unchanged', generated: false, issue: 'Directory — read-only' },
    { path: 'src/app.ts', size: 4096, state: 'modified', generated: false, issue: null },
    { path: 'src/added.ts', size: 2048, state: 'added', generated: false, issue: null },
    { path: 'src/deleted.ts', size: 1024, state: 'deleted', generated: false, issue: null },
    { path: 'assets/binary.png', size: 9000, state: 'modified', generated: false, issue: null },
    { path: 'data/large.txt', size: 2000000, state: 'added', generated: false, issue: null },
    { path: 'private.txt', size: 0, state: 'unavailable', generated: false, issue: 'Unreadable file' },
    { path: '.appliance/agent-results/agent-1.json', size: 200, state: 'added', generated: true, issue: null },
  ],
};
const delay = () => new Promise((resolve) => setTimeout(resolve, 200));
let refreshes = 0;
const host = {
  async inspectionRefresh() {
    await delay();
    if (params.has('fail-refresh') && refreshes++) throw new Error('Fixture refresh failure');
    return snapshot;
  },
  async inspectionRead(_directory: string, path: string, large: boolean) {
    await delay();
    const binary = path.includes('binary');
    const big = path.includes('large');
    const unreadable = path === 'private.txt';
    const deleted = path.includes('deleted');
    return {
      path,
      size: big ? 2000000 : 4096,
      notice: binary
        ? 'Binary file: 8000 → 9000 bytes'
        : unreadable
          ? 'Unreadable file'
          : big
            ? large
              ? 'Truncated: only the first 1 MiB of each side is displayed and compared here.'
              : 'Large file: 2000000 bytes. Preview withheld; load deliberately (maximum 1 MiB displayed).'
            : deleted
              ? 'Deleted file — baseline diff retained'
              : null,
      needsLoad: big && !large,
      text:
        binary || unreadable || (big && !large) ? null : Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'),
      diff:
        binary || unreadable || (big && !large)
          ? null
          : `--- baseline/${path}\n+++ workspace/${path}\n@@ -1,100 +1,100 @@\n${Array.from({ length: 200 }, (_, i) => `${i % 2 ? '+' : '-'}line ${i}`).join('\n')}`,
    };
  },
} as unknown as ConsoleHost;
createRoot(document.getElementById('root')!).render(
  <MotionProvider>
    <HostProvider host={host}>
      <main className="mx-auto max-w-6xl p-6">
        <h1 className="mb-4 text-xl">S4 inspection · fixture data</h1>
        <WorkspaceInspector directory={directory} />
        <p>Reserved-space footer</p>
      </main>
    </HostProvider>
  </MotionProvider>
);
