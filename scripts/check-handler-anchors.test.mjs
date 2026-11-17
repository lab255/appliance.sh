import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAnchors } from './check-handler-anchors.mjs';
test('accepts the recorded handler and rejects a deliberately drifted row or source', () => {
  const row = '[handler](../source.tsx#L2)';
  const manifest = [{ file: 'source.tsx', line: 2, source: 'onClick={save}' }];
  const source = () => '\nonClick={save}\n';
  checkAnchors(row, manifest, source);
  assert.throws(() => checkAnchors(row.replace('#L2', '#L1'), manifest, source), /Audit link drifted/);
  assert.throws(() => checkAnchors(row, manifest, () => '\n\nonClick={save}\n'), /handler anchor drifted/);
});
