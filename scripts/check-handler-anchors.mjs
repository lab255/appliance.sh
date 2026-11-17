import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
export function checkAnchors(document, anchors, readSource) {
  const links = [...document.matchAll(/\]\(\.\.\/([^#)]+)#L(\d+)\)/g)].map(([, file, line]) => ({
    file,
    line: Number(line),
  }));
  assert.equal(links.length, anchors.length, 'Audit inventory changed: review the anchor manifest');
  links.forEach(({ file, line }, index) => {
    const expected = anchors[index];
    assert.equal(`${file}:${line}`, `${expected.file}:${expected.line}`, 'Audit link drifted');
    assert.equal(
      readSource(file).split('\n')[line - 1]?.trim(),
      expected.source,
      `${file}:${line}: handler anchor drifted; review and update the audit and manifest together`
    );
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkAnchors(
    readFileSync(path.join(root, 'docs/gla-337-handler-audit.md'), 'utf8'),
    JSON.parse(readFileSync(path.join(root, 'docs/gla-337-handler-anchors.json'), 'utf8')),
    (file) => readFileSync(path.join(root, file), 'utf8')
  );
  console.log('Handler audit: all recorded source anchors match');
}
