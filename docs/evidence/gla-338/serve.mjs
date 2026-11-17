import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
if (!process.env.BASE_URL) throw new Error('Set BASE_URL to the local fixture URL (including port).');
const url = new URL(process.env.BASE_URL);
const app = fileURLToPath(new URL('../../../packages/app/', import.meta.url));
const fixture = new URL('../../../packages/app/.gla338/', import.meta.url);
await mkdir(fixture, { recursive: true });
for (const file of ['fixture.tsx', 'vite.config.mjs']) {
  await copyFile(new URL(`${file}.txt`, import.meta.url), new URL(file, fixture));
}
await writeFile(
  new URL('index.html', fixture),
  '<html class="dark"><div id="root"></div><script type="module" src="/fixture.tsx"></script></html>'
);
const child = spawn(
  'pnpm',
  ['exec', 'vite', '--config', '.gla338/vite.config.mjs', '--host', url.hostname, '--port', url.port, '--strictPort'],
  { cwd: app, stdio: 'inherit' }
);
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (code) => process.exit(code ?? 1));
