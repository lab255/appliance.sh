import { readdirSync, readFileSync } from 'node:fs';
import { userInfo, tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
const directory = new URL('./', import.meta.url);
const temporaryId = basename(dirname(tmpdir()));
const patterns = [
  /\/Users\//,
  /\/home\//,
  /\/var\/folders/,
  /\/private\/var/,
  /\/tmp\/claude/,
  /thr_[a-z0-9]+(?:-\d+)?/,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  /playwright_[a-zA-Z0-9_-]+/,
  /claude-\d+/,
];
const files = readdirSync(directory).filter((name) => /\.(txt|json)$/.test(name));
for (const name of files) {
  const content = readFileSync(new URL(name, directory), 'utf8');
  if (
    patterns.some((pattern) => pattern.test(content)) ||
    content.includes(userInfo().username) ||
    (temporaryId.length > 10 && content.includes(temporaryId))
  ) {
    throw new Error(`Unscrubbed path/identifier pattern in ${name}`);
  }
}
console.log(
  `No configured path, username, or temporary-ID pattern matched in ${files.length} evidence text/JSON files.`
);
