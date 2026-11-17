import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const repo = process.cwd();
const require = createRequire(repo + '/packages/app/package.json');
const { createServer } = await import(require.resolve('vite'));
const react = (await import(require.resolve('@vitejs/plugin-react'))).default;
const tailwind = (await import(require.resolve('@tailwindcss/vite'))).default;
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'w5-browser-')));
fs.writeFileSync(
  root + '/index.html',
  '<html class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>'
);
fs.writeFileSync(
  root + '/fixture.tsx',
  fs.readFileSync(repo + '/docs/evidence/workbench-w5/fixture.tsx.txt', 'utf8').replaceAll('REPO', repo)
);
if (!fs.existsSync(root + '/node_modules'))
  fs.symlinkSync(repo + '/packages/app/node_modules', root + '/node_modules', 'dir');
const server = await createServer({
  root,
  configFile: false,
  plugins: [react(), tailwind()],
  resolve: { dedupe: ['react', 'react-dom'], alias: { '@': repo + '/packages/app/src' } },
  server: { port: 1455, fs: { allow: [repo, root] } },
});
await server.listen();
console.log('fixture on 1455');
