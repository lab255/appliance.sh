import { scrubLog } from './scrub-log.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const paths = [
  'packages/app/src/pages/environments/workloads-panel.tsx',
  'packages/app/src/pages/machine/credential-helper-editor.tsx',
  'packages/app/src/components/agent-login.tsx',
  'packages/app/src/pages/settings.tsx',
  'packages/app/src/pages/machine/runtime-detail.tsx',
  'packages/app/src/lib/paint-pending.ts',
];
const original = paths.map((path) => readFileSync(root + path, 'utf8'));
const restore = () => paths.forEach((path, i) => writeFileSync(root + path, original[i]));
const replacements = [
  ['if (switching) return;', ''],
  ['if (picking || !onPickProgram) return;', 'if (!onPickProgram) return;'],
  ['if (openingTerminal || busy || hasClaude === null) return;', 'if (busy || hasClaude === null) return;'],
  ['if (!host.updater || relaunching) return;', 'if (!host.updater) return;'],
  ['if (deployingHere || busy !== null) return;', 'if (busy !== null) return;'],
  ['if (pickingFolder || busy !== null) return;', 'if (busy !== null) return;'],
];
for (const variant of ['baseline', 'unguarded', 'no-paint', 'native-disabled', 'provisioning-label', 'fixed']) {
  try {
    if (variant === 'baseline')
      paths
        .slice(0, 5)
        .forEach((path) => writeFileSync(root + path, execFileSync('git', ['show', `407345b:${path}`], { cwd: root })));
    if (variant === 'unguarded')
      paths.slice(0, 5).forEach((path, i) => {
        let source = original[i];
        for (const [from, to] of replacements) source = source.replace(from, to);
        writeFileSync(root + path, source);
      });
    if (variant === 'no-paint')
      writeFileSync(root + paths[5], original[5].replace('return afterPendingPaint();', 'return Promise.resolve();'));
    if (variant === 'native-disabled')
      paths.slice(0, 5).forEach((path, i) => {
        const source = original[i].replace(
          /aria-busy=\{(switching|picking|openingTerminal|relaunching|pickingFolder|deployingHere !== null)\}/g,
          'disabled={$1} aria-busy={$1}'
        );
        writeFileSync(root + path, source);
      });
    if (variant === 'provisioning-label')
      writeFileSync(root + paths[4], original[4].replaceAll('Provisioning cluster…', 'Opening deploy…'));
    const count = variant === 'fixed' ? 7 : variant === 'provisioning-label' ? 1 : 6;
    const filter =
      variant === 'fixed'
        ? []
        : [
            '-t',
            variant === 'provisioning-label' ? '^provision ' : '^(switch|program|terminal|relaunch|folder|deploy) ',
          ];
    const result = spawnSync(
      'pnpm',
      ['--filter', '@appliance.sh/app', 'exec', 'vitest', 'run', 'src/pages/pending-handlers.test.tsx', ...filter],
      { cwd: root, encoding: 'utf8' }
    );
    // Scrub at capture time so rerunning the controls cannot reintroduce personal roots.
    const output = scrubLog((result.stdout + result.stderr).replaceAll(root.replace(/\/$/, ''), '<repo>'));
    writeFileSync(new URL(`tests-${variant}.txt`, import.meta.url), output);
    if (
      variant === 'fixed'
        ? result.status !== 0
        : result.status === 0 || !new RegExp(`Tests\\s+${count} failed`).test(output)
    )
      throw new Error(`Unexpected ${variant} result; inspect tests-${variant}.txt`);
    console.log(
      `${variant}: ${variant === 'fixed' ? `${count} PASS` : `${count} expected FAIL`} (exit ${result.status})`
    );
  } finally {
    restore();
  }
}
