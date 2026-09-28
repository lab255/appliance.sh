// Run after the workspace build. Only tarballs cross into these temporary consumers.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const temporary = mkdtempSync(join(tmpdir(), 'appliance-ui-packed-'));
function run(cwd, command, args) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', npm_config_cache: join(temporary, 'npm-cache') },
  });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed`);
}
function write(dir, name, contents) {
  writeFileSync(join(dir, name), contents);
}
run(join(root, 'packages/ui'), 'pnpm', ['pack', '--pack-destination', temporary]);
const tarball = join(
  temporary,
  readdirSync(temporary).find((name) => name.endsWith('.tgz'))
);
// Audit the extracted tarball before installing any consumer dependencies.
run(temporary, 'tar', ['-xzf', tarball]);
auditPackage(join(temporary, 'package'));
if (process.argv.includes('--audit-only')) {
  console.log('Packed exports, directives, CSS, tokens, and fonts passed');
  process.exit(0);
}
function auditPackage(installed) {
  const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  const client = new Set(
    'banner button command-snippet confirm-dialog input live-url log-pane long-operation toast use-tail-autoscroll'.split(
      ' '
    )
  );
  for (const [key, entry] of Object.entries(pkg.exports)) {
    if (typeof entry === 'string') {
      readFileSync(join(installed, entry));
      continue;
    }
    readFileSync(join(installed, entry.types));
    const source = readFileSync(join(installed, entry.import), 'utf8');
    assert.equal(/^['"]use client['"];/.test(source), client.has(key.slice(2)), key);
    assert(!source.includes('.css'), `JS loads CSS: ${key}`);
  }
  const css = readFileSync(join(installed, 'dist/styles.css'), 'utf8');
  assert(!/@theme|@source|@tailwind/.test(css));
  const fonts = [...css.matchAll(/url\((?:["'])?(\.\/assets\/[^)"']+)/g)];
  assert.equal(fonts.length, 11);
  for (const [, font] of fonts) readFileSync(join(installed, 'dist', font));
  const tokens = readFileSync(join(installed, 'dist/tokens.css'), 'utf8');
  const theme = readFileSync(join(installed, 'dist/theme.css'), 'utf8');
  assert(!/@theme|@import|@font-face/.test(tokens));
  assert.equal((tokens.match(/--[\w-]+:/g) ?? []).length, (theme.match(/--[\w-]+:/g) ?? []).length);
}
const interactive = `'use client';
import { Button } from '@appliance.sh/ui/button';
import { ToastProvider, useToast } from '@appliance.sh/ui/toast';
function Action() {
  const { toast } = useToast();
  return <Button onClick={() => toast('Packed interaction works')}>Show toast</Button>;
}
export default function Interactive() { return <ToastProvider><Action /></ToastProvider>; }
`;
for (const kind of ['vite', 'next']) {
  const dir = join(temporary, kind);
  mkdirSync(dir);
  write(
    dir,
    'package.json',
    JSON.stringify(
      {
        private: true,
        type: 'module',
        scripts: { build: kind === 'vite' ? 'vite build' : 'next build' },
        dependencies: {
          '@appliance.sh/ui': `file:${tarball}`,
          react: '19.2.8',
          'react-dom': '19.2.8',
          ...(kind === 'vite' ? { vite: '6.4.2' } : { next: '15.5.24' }),
        },
        devDependencies: {
          typescript: '5.9.3',
          '@types/react': '19.2.14',
          '@types/react-dom': '19.2.3',
          '@types/node': '^24',
          playwright: '1.61.1',
          postcss: '8.5.6',
        },
      },
      null,
      2
    )
  );
  if (kind === 'vite') {
    write(
      dir,
      'index.html',
      '<html><head><link rel="icon" href="data:," /></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>'
    );
    write(
      dir,
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          jsx: 'react-jsx',
          module: 'ESNext',
          moduleResolution: 'bundler',
          target: 'ES2022',
          skipLibCheck: true,
          noEmit: true,
        },
      })
    );
    write(dir, 'interactive.tsx', interactive);
    write(
      dir,
      'main.tsx',
      `import { createRoot } from 'react-dom/client';
import { PageShell, Tag } from '@appliance.sh/ui';
import '@appliance.sh/ui/styles.css';
import Interactive from './interactive';
createRoot(document.getElementById('root')!).render(<PageShell><Tag>Packed static primitive</Tag><Interactive /></PageShell>);
`
    );
  } else {
    write(
      dir,
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          jsx: 'preserve',
          module: 'ESNext',
          moduleResolution: 'bundler',
          target: 'ES2022',
          lib: ['dom', 'dom.iterable', 'esnext'],
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          noEmit: true,
          plugins: [{ name: 'next' }],
        },
        include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
        exclude: ['node_modules'],
      })
    );
    mkdirSync(join(dir, 'app'));
    write(dir, 'app/interactive.tsx', interactive);
    write(
      dir,
      'app/layout.tsx',
      `import '@appliance.sh/ui/styles.css';
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><head><link rel="icon" href="data:," /></head><body>{children}</body></html>;
}`
    );
    write(
      dir,
      'app/page.tsx',
      `import { PageShell } from '@appliance.sh/ui/page-shell';
import { Tag } from '@appliance.sh/ui';
import Interactive from './interactive';
export default function Page() { return <PageShell><Tag>Packed static primitive</Tag><Interactive /></PageShell>; }`
    );
  }
  run(dir, 'npm', ['install', '--no-audit', '--no-fund']);
  const installed = join(dir, 'node_modules/@appliance.sh/ui');
  auditPackage(installed);
  mkdirSync(join(dir, 'public'), { recursive: true });
  write(dir, 'public/tokens.css', readFileSync(join(installed, 'dist/tokens.css'), 'utf8'));
  write(
    dir,
    'audit.mjs',
    `import postcss from 'postcss';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const root = postcss.parse(readFileSync('node_modules/@appliance.sh/ui/dist/tokens.css', 'utf8'));
root.walkRules(rule => assert.equal(rule.selector, ':root'));
root.walkDecls(decl => assert(decl.prop.startsWith('--')));
console.log('Standalone tokens parse successfully');
`
  );
  run(dir, 'node', ['audit.mjs']);

  run(dir, 'npm', ['run', 'build']);
  if (process.argv.includes('--install-browser')) {
    run(dir, process.execPath, ['node_modules/playwright/cli.js', 'install', '--with-deps', 'chromium']);
  }
  const { chromium } = await import(pathToFileURL(join(dir, 'node_modules/playwright/index.mjs')).href);
  const port = kind === 'vite' ? 41731 : 41732;
  const server = spawn(
    process.execPath,
    kind === 'vite'
      ? [join(dir, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(port), '--host', '127.0.0.1']
      : [join(dir, 'node_modules/next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'],
    { cwd: dir, stdio: 'inherit' }
  );
  let browser;
  try {
    const url = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        if ((await fetch(url)).ok) break;
      } catch {
        /* Server is starting. */
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    browser = await chromium.launch({
      headless: true,
      ...(process.env.UI_SMOKE_CHROMIUM ? { executablePath: process.env.UI_SMOKE_CHROMIUM } : {}),
    });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(url);
    await page.getByText('Packed static primitive').waitFor();
    await page.getByRole('button', { name: 'Show toast' }).click();
    await page.getByText('Packed interaction works').waitFor();
    const fontUrls = await page.evaluate(async () => {
      await document.fonts.ready;
      if (!document.fonts.check('14px "Geist Variable"')) throw new Error('Geist failed to load');
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(await (await fetch('/tokens.css')).text());
      return performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => name.includes('.woff2'));
    });
    assert(fontUrls.length > 0, 'No local font loaded');
    assert(
      fontUrls.every((font) => font.startsWith(url)),
      'Remote font request'
    );
    assert.deepEqual(errors, []);
    console.log(`${kind}: hydration, Button/Toast interaction, and local fonts passed`);
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
  }
}
console.log(`Packed fixtures passed; retained only in temporary storage: ${temporary}`);
