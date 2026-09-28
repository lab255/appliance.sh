import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../packages/app/src/', import.meta.url));
// No migration exceptions remain. Black/white modal scrims are intentionally
// outside this hue/size guard (design-system-spec.md §D).
const forbidden =
  /text-\[\d+(?:\.\d+)?px\]|\b[\w-]+-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-(?:50|[1-9]\d{2})\b/g;

async function scan(directory) {
  let violations = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      violations += await scan(file);
    } else if (/\.(?:[cm]?[jt]sx?|css)$/.test(entry.name)) {
      const lines = (await readFile(file, 'utf8')).split('\n');
      for (const [index, line] of lines.entries()) {
        for (const match of line.matchAll(forbidden)) {
          console.error(`${path.relative(root, file)}:${index + 1}: ${match[0]}`);
          violations++;
        }
      }
    }
  }
  return violations;
}

const violations = await scan(root);
if (violations) {
  console.error(`Design tokens: ${violations} violation(s). Use semantic colors and named text roles.`);
  process.exitCode = 1;
} else {
  console.log('Design tokens: zero raw hue or pixel text-size violations.');
}
