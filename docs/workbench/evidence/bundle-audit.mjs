import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Only source identifiers are inspected, never sourcesContent or declarations.
const forbidden =
  /(?:\.(?:test|spec)\.[^/]+$|(?:^|\/)(?:__tests__|__fixtures__|fixtures|harnesses)(?:\/|$)|(?:^|\/)mock-[^/]+$|(?:^|\/)[^/]*-audit\.[^/]+$|docs\/.*(?:evidence|audits)\/)/i;
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
  const roots = { 'app-library': process.env.APP_BUNDLE_DIR, 'desktop-product': process.env.DESKTOP_BUNDLE_DIR };
  assert.ok(process.env.BUNDLE_AUDIT_OUTPUT, 'Set BUNDLE_AUDIT_OUTPUT');
  const results = {};
  for (const [name, directory] of Object.entries(roots)) {
    assert.ok(directory, `Set bundle directory for ${name}`);
    const control = await audit(directory, true);
    assert.ok(control.harnessTestOrFixtureSources.length > 0, `${name}: negative control failed`);
    results[name] = await audit(directory);
    assert.equal(results[name].harnessTestOrFixtureSources.length, 0, `${name}: forbidden sources found`);
  }
  await writeFile(process.env.BUNDLE_AUDIT_OUTPUT, JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify({ results, negativeControls: 'Injected test source rejected on both surfaces' }, null, 2));
} catch {
  // Deliberately avoid raw filesystem/JSON errors, which can disclose local paths.
  console.error(
    'Bundle audit failed: check configured build directories, sourcemap validity, and test/fixture imports. No evidence written.'
  );
  process.exitCode = 1;
}
