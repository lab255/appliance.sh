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
  comparisonError: params.has('unavailable') ? 'No baseline captured — change comparison will be unavailable' : null,
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
if (params.has('generated-only'))
  snapshot.entries = [
    { path: '.appliance/agents.json', size: 100, state: 'modified', generated: true, issue: null },
    { path: '.appliance/agent-results/agent-1.json', size: 200, state: 'added', generated: true, issue: null },
    { path: '.appliance/.agents.lock', size: 10, state: 'deleted', generated: true, issue: null },
  ];
const delay = () => new Promise((resolve) => setTimeout(resolve, 200));
let refreshes = 0;
const host = {
  async inspectionRefresh() {
    await delay();
    const refreshIndex = refreshes++;
    if (params.has('composed') && refreshIndex)
      throw new Error(
        'Comparison unavailable: scan needs more than 1 MiB (1048576 bytes) of retained previews (already 2 MiB (2097152 bytes) at oversized-b; this file is 1 MiB (1048640 bytes)). Previous snapshot was not refreshed. Inspect a narrower project folder; no files were silently omitted.'
      );
    if (params.has('fail-refresh') && refreshIndex) throw new Error('Fixture refresh failure');
    return params.has('composed') ? { ...snapshot, entries: [] } : snapshot;
  },
  async inspectionRead(_directory: string, path: string, large: boolean) {
    await delay();
    const binary = path.includes('binary');
    const big = path.includes('large');
    const unreadable = path === 'private.txt';
    const deleted = path.includes('deleted');
    const lines =
      big && large
        ? '+large retained prefix line\n'.repeat(50000).slice(0, 1048576)
        : Array.from({ length: 200 }, (_, i) => `${i % 2 ? '+' : '-'}line ${i}`).join('\n');
    return {
      path,
      size: big ? 2000000 : 4096,
      notice: binary
        ? 'Binary file: 8000 → 9000 bytes'
        : unreadable
          ? 'Unreadable file'
          : big
            ? large
              ? 'Truncated diff inputs: baseline 0 bytes of 0 bytes shown; current 1 MiB (1048576 bytes) of 1.91 MiB (2000000 bytes) shown. Changes beyond these prefixes are detected by full-file hash but omitted from this diff.'
              : 'Large file: 1.91 MiB (2000000 bytes) total; 0 bytes shown. Load up to 1 MiB deliberately; the rest will be labelled as omitted.'
            : deleted
              ? 'Deleted file — baseline diff retained'
              : null,
      needsLoad: big && !large,
      text: binary || unreadable || (big && !large) ? null : lines,
      diff:
        binary || unreadable || (big && !large)
          ? null
          : `--- baseline/${path}\n+++ workspace/${path}\n@@ -1,100 +1,100 @@\n${lines}`,
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
