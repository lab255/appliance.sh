import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Only source identifiers are inspected, never sourcesContent or declarations.
const forbidden =
  /(?:\.(?:test|spec)\.[^/]+$|(?:^|\/)(?:__tests__|__fixtures__|fixtures|harnesses)(?:\/|$)|(?:^|\/)mock-[^/]+$|(?:^|\/)[^/]*-audit\.[^/]+$|docs\/.*(?:evidence|audits)\/)/i;
class AuditFailure extends Error {}
const fail = (message) => {
  throw new AuditFailure(message);
};
async function audit(directory, inject = false) {
  const result = { javascriptMapsAudited: 0, sourceEntriesAudited: 0, harnessTestOrFixtureSources: [] };
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (/\.(?:js|mjs|cjs)\.map$/.test(entry.name)) {
        // Require a corresponding runtime artifact, not an orphan map.
        await readFile(file.slice(0, -4));
        const map = JSON.parse(await readFile(file, 'utf8'));
        assert.equal(map.version, 3);
        assert.ok(Array.isArray(map.sources));
        const sources = [...map.sources];
        if (inject && result.javascriptMapsAudited === 0) sources.push('negative-control.test.ts');
        result.javascriptMapsAudited++;
        result.sourceEntriesAudited += sources.length;
        for (const source of sources) {
          assert.equal(typeof source, 'string');
          if (forbidden.test(source.replaceAll('\\', '/'))) {
            // Do not persist absolute build-machine paths or temporary IDs.
            result.harnessTestOrFixtureSources.push({
              map: path.relative(directory, file),
              source: path.basename(source),
            });
          }
        }
      }
    }
  }
  await walk(directory);
  assert.ok(result.javascriptMapsAudited > 0, 'No production JavaScript maps found');
  assert.ok(result.sourceEntriesAudited > 0, 'No source entries found');
  return result;
}

try {
  const roots = { 'app-library': 'APP_BUNDLE_DIR', 'desktop-product': 'DESKTOP_BUNDLE_DIR' };
  for (const name of [...Object.values(roots), 'BUNDLE_AUDIT_OUTPUT'])
    if (!process.env[name]) fail(`Missing required environment variable: ${name}`);
  const results = {};
  for (const [name, variable] of Object.entries(roots)) {
    const directory = process.env[variable];
    const control = await audit(directory, true);
    if (!control.harnessTestOrFixtureSources.length) fail(`${name}: injected negative control was not detected`);
    results[name] = await audit(directory);
    if (results[name].harnessTestOrFixtureSources.length)
      fail(`${name}: forbidden sources found: ${JSON.stringify(results[name].harnessTestOrFixtureSources)}`);
  }
  await writeFile(process.env.BUNDLE_AUDIT_OUTPUT, JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify({ results, negativeControls: 'Injected test source rejected on both surfaces' }, null, 2));
} catch (error) {
  // Raw filesystem/JSON errors may contain local paths. Only our safe diagnostics escape.
  console.error(
    `Bundle audit failed: ${error instanceof AuditFailure ? error.message : 'invalid/unreadable build directory or JavaScript sourcemap'}. No evidence written.`
  );
  process.exitCode = 1;
}
