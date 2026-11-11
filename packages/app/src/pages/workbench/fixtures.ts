import type { AgentInfo } from '../../lib/host';

/** Branch-only view model. No API identity or authority is stored here. */
export const fixtureDirectory = '/Users/you/projects/journal';
export const capturedAt = '2026-11-11 09:00 UTC';
export const fixtureKey = 'appliance.workbench.fixture';
export const scenarios = [
  ['1', 'Folders · blank / dirty'],
  ['2', 'Sign-in and launch'],
  ['3', 'Delayed launch / quiet output'],
  ['4', 'Approval / delivery failure'],
  ['5', 'Session scale'],
  ['6', 'Partial edits / results'],
  ['7', 'Package prerequisites'],
  ['8', 'Destination fork'],
  ['9', 'Bundle recipient'],
  ['10', 'Deploy outcomes'],
  ['11', 'VM / catalogue recovery'],
  ['12', 'WSL capability conflict'],
] as const;
export function fixtureScenario(): string {
  return sessionStorage.getItem(fixtureKey) ?? '';
}
export function fixtureRuns(count = 4): AgentInfo[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `workbench-${index}`,
    sessionId: `agent-workbench-${index}`,
    type: ['claude-code', 'codex', 'copilot'][index % 3],
    task: ['Add a journal entry form', 'Review empty states', 'Inspect keyboard navigation', 'Check manifest'][
      index % 4
    ],
    status: (['running', 'done', 'error', 'exited'] as const)[index % 4],
    mode: index % 4 === 0 ? 'interactive' : 'autonomous',
    live: index % 4 === 0,
  }));
}
export const credentialCopy: Record<string, string> = {
  'claude-code': 'Your Anthropic key stays on this computer; the VM only sees a placeholder.',
  codex: 'Your OpenAI key stays on this computer; the VM only sees a placeholder.',
  copilot:
    'Your GitHub token stays on this computer. A short-lived Copilot session token derived from it does enter the VM. A prompt-injected agent could read that token and spend against your GitHub account until it expires.',
};
export const stopCopy =
  'Stop this agent session? Changes already made remain. Stopping does not undo actions or contain hostile code.';
export const wslCopy =
  "Brokered sign-in isn't available on WSL yet. Workbench does not support putting your key in the VM.";
export const files = [
  {
    path: 'index.html',
    kind: 'Modified',
    diff: '@@ -12,2 +12,4 @@\n-<h1>Journal</h1>\n+<h1>Your journal</h1>\n+<label for="entry">New entry</label>\n+<textarea id="entry"></textarea>',
    content:
      '<main>\n  <h1>Your journal</h1>\n  <label for="entry">New entry</label>\n  <textarea id="entry"></textarea>\n</main>',
  },
  {
    path: 'README.md',
    kind: 'Added',
    diff: '+# Journal\n+Write a little, every day.',
    content: '# Journal\nWrite a little, every day.',
  },
  {
    path: 'old-entry.html',
    kind: 'Deleted',
    diff: '-<p>Old entry</p>',
    content: 'Deleted file — retained baseline available in Changes.',
  },
  {
    path: 'cover.png',
    kind: 'Binary',
    diff: 'Binary file changed · 24 KB',
    content: 'Binary file · 24 KB · preview unavailable',
  },
  {
    path: 'archive.json',
    kind: 'Modified',
    diff: 'Large file · 2.4 MB · preview truncated',
    content: 'Large file · 2.4 MB · preview truncated',
  },
  {
    path: 'private.txt',
    kind: 'Unreadable',
    diff: 'Could not read file; previous snapshot retained · stale',
    content: 'Could not read file; previous snapshot retained · stale',
  },
];
