import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
if (!process.env.BUNDLE_CONTROL_OUTPUT) throw new Error('Set BUNDLE_CONTROL_OUTPUT');
const temporary = mkdtempSync(join(tmpdir(), 'bundle-controls-'));
const app = join(temporary, 'app');
const desktop = join(temporary, 'desktop');
mkdirSync(app);
mkdirSync(desktop);
let surface = app;
const script = 'docs/workbench/evidence/bundle-audit.mjs';
const results = [];
const env = {
  ...process.env,
  APP_BUNDLE_DIR: app,
  DESKTOP_BUNDLE_DIR: desktop,
  BUNDLE_AUDIT_OUTPUT: join(temporary, 'output.json'),
};
function check(name, sources, expected, scriptPath = script, variables = env) {
  for (const directory of [app, desktop]) {
    writeFileSync(join(directory, 'runtime.js'), 'export {};');
    writeFileSync(join(directory, 'runtime.js.map'), JSON.stringify({ version: 3, sources: ['production.ts'] }));
  }
  writeFileSync(join(surface, 'runtime.js'), 'export {};');
  writeFileSync(
    join(surface, 'runtime.js.map'),
    typeof sources === 'string' ? sources : JSON.stringify({ version: 3, sources })
  );
  const result = spawnSync(process.execPath, [scriptPath], { env: variables, encoding: 'utf8' });
  assert.equal(result.status, expected ? 1 : 0, name);
  if (expected) assert.match(result.stderr, expected);
  results.push({ name, exit: result.status, diagnostic: result.stderr.trim() });
}
try {
  check('clean graph plus injected test negative control', ['production.ts'], null);
  for (surface of [app, desktop]) {
    for (const source of [
      'fixture.test.ts',
      'mock-host.ts',
      'sessions-audit.tsx',
      'docs/evidence/probe.mjs',
      '__fixtures__/sample.ts',
    ]) {
      check(
        `${surface === app ? 'app' : 'desktop'} plant ${source}`,
        ['production.ts', source],
        /forbidden sources found/
      );
      assert.ok(results.at(-1).diagnostic.includes(source.split('/').at(-1)));
    }
  }
  surface = app;
  check('missing env', ['production.ts'], /APP_BUNDLE_DIR/, script, { ...env, APP_BUNDLE_DIR: '' });
  check('bad map', '{', /invalid\/unreadable/);
  const broken = join(temporary, 'broken-control.mjs');
  writeFileSync(
    broken,
    readFileSync(script, 'utf8').replace("sources.push('negative-control.test.ts')", "sources.push('production.ts')")
  );
  check('failed negative control', ['production.ts'], /injected negative control was not detected/, broken);
  writeFileSync(process.env.BUNDLE_CONTROL_OUTPUT, JSON.stringify(results, null, 2) + '\n');
  console.log(`${results.length} bundle controls passed`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
