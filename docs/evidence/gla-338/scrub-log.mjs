import { stripVTControlCharacters } from 'node:util';
import { homedir, tmpdir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';

export function scrubLog(text) {
  const repo = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
  return stripVTControlCharacters(text)
    .replaceAll(repo, '<repo>')
    .replaceAll(tmpdir().replace(/\/$/, ''), '<tmp>')
    .replace(/\/(?:private\/)?var\/folders\/[^\s"'<>]+/g, '<tmp>')
    .replace(/\/tmp\/[^\s"'<>]+/g, '<tmp>')
    .replaceAll(homedir(), '<repo>')
    .replace(/\/(?:Users|home)\/[^/\s"'<>]+/g, '<repo>')
    .replace(/<repo>\/\.appliance\/vm\/[^\s"'<>]+/g, '<tmp>')
    .replaceAll(userInfo().username, '<user>')
    .replace(/\bthr_[a-z0-9]+(?:-\d+)?\b/g, '<tmp>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<tmp>')
    .replace(/[ \t]+$/gm, '');
}

// Usage: node scrub-log.mjs path/to/log.txt [more logs...], in place.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const path of process.argv.slice(2)) writeFileSync(path, scrubLog(readFileSync(path, 'utf8')));
}
