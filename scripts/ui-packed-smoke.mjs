// Run after the workspace build. Only tarballs cross into these temporary consumers.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
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
if (!process.env.UI_SMOKE_TARBALL) run(join(root, 'packages/ui'), 'pnpm', ['pack', '--pack-destination', temporary]);
const tarball =
  process.env.UI_SMOKE_TARBALL ||
  join(
    temporary,
    readdirSync(temporary).find((name) => name.endsWith('.tgz'))
  );
const baseline = process.env.UI_SMOKE_BASELINE === '1';
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
    'banner button command-snippet confirm-dialog input live-url log-pane long-operation toast use-tail-autoscroll motion-provider skeleton-swap dialog dropdown-menu tooltip popover'.split(
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
import { useState } from 'react';
import { Button } from '@appliance.sh/ui/button';
import { ToastProvider, useToast } from '@appliance.sh/ui/toast';
import { ConfirmProvider, useConfirm } from '@appliance.sh/ui/confirm-dialog';
import { Banner ${baseline ? '' : ', BannerPresence'} } from '@appliance.sh/ui/banner';
import { Skeleton } from '@appliance.sh/ui/skeleton';
import { Dialog } from '@appliance.sh/ui/dialog';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@appliance.sh/ui/dropdown-menu';
import { Tooltip, TooltipTrigger, TooltipContent } from '@appliance.sh/ui/tooltip';
import { Popover, PopoverTrigger, PopoverContent } from '@appliance.sh/ui/popover';
${baseline ? '' : "import { MotionProvider } from '@appliance.sh/ui/motion-provider'; import { SkeletonSwap } from '@appliance.sh/ui/skeleton-swap';"}
${baseline ? 'const MotionProvider = ({children}: {children: React.ReactNode}) => children; const BannerPresence = ({children}: {children: React.ReactNode}) => children; const SkeletonSwap = ({loading, fallback, children}: {loading: boolean; fallback: React.ReactNode; children: React.ReactNode}) => loading ? fallback : children;' : ''}
function Action() {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [banner, setBanner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState('No decision');
  return <div style={{padding:24, display:'grid', gap:16}}>
    <Button onClick={() => toast('Packed interaction works')}>Show toast</Button>
    <Button onClick={async () => setResult(await confirm({ title: 'Delete preview?', description: 'This is a motion preview.' }) ? 'Confirmed' : 'Cancelled')}>Open dialog</Button>
    <span>{result}</span>
    <Dialog />
    <DropdownMenu><DropdownMenuTrigger>Choose target</DropdownMenuTrigger><DropdownMenuContent loop><DropdownMenuItem>Alpha</DropdownMenuItem><DropdownMenuItem disabled>Unavailable</DropdownMenuItem><DropdownMenuItem>Bravo</DropdownMenuItem><DropdownMenuItem>Charlie</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
    <Tooltip><TooltipTrigger>First hint</TooltipTrigger><TooltipContent>First tooltip</TooltipContent></Tooltip>
    <Tooltip><TooltipTrigger>Second hint</TooltipTrigger><TooltipContent>Second tooltip</TooltipContent></Tooltip>
    <Popover><PopoverTrigger>Details</PopoverTrigger><PopoverContent>Popover gallery content</PopoverContent></Popover>
    <Button onClick={() => setBanner(true)}>Show banner</Button>
    <BannerPresence>{banner ? <Banner key="notice" tone="success" onDismiss={() => setBanner(false)}>Packed banner</Banner> : null}</BannerPresence>
    <Button onClick={() => setLoading(v => !v)}>Swap content</Button>
    <SkeletonSwap loading={loading} fallback={<Skeleton className="h-12 w-full" />}><p>Loaded content</p></SkeletonSwap>
  </div>;
}
export default function Interactive() { return <MotionProvider><ToastProvider><ConfirmProvider><Action /></ConfirmProvider></ToastProvider></MotionProvider>; }
`;
const measurements = {};
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
          ...(baseline ? {} : { motion: '13.4.4' }),
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
    write(
      dir,
      'vite.config.mjs',
      `export default { build: { sourcemap: true, manifest: true, rollupOptions: { input: { main: 'index.html', static: 'static.html' } } } };`
    );
    write(
      dir,
      'static.html',
      '<html><body><div id="root"></div><script type="module" src="/static.tsx"></script></body></html>'
    );
    write(
      dir,
      'static.tsx',
      `import { createRoot } from 'react-dom/client'; import { Tag } from '@appliance.sh/ui/tag'; createRoot(document.getElementById('root')!).render(<Tag>Static only</Tag>);`
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
    write(dir, 'next.config.mjs', 'export default { productionBrowserSourceMaps: true };');
    mkdirSync(join(dir, 'app'));
    mkdirSync(join(dir, 'app/static'));
    write(
      dir,
      'app/static/page.tsx',
      `import { Tag } from '@appliance.sh/ui/tag'; export default function Page() { return <Tag>Static only</Tag>; }`
    );
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
    const requests = [];
    page.on('response', (response) => {
      if (new URL(response.url()).pathname.endsWith('.js')) requests.push(response.url());
    });
    await page.goto(`${url}?mock-host`);
    await page.getByText('Packed static primitive').waitFor();
    await page.getByRole('button', { name: 'Show toast' }).click();
    await page.getByText('Packed interaction works').waitFor();
    if (!baseline) {
      const open = page.getByRole('button', { name: 'Open dialog', includeHidden: true });
      await open.click();
      assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Cancel');
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Confirm');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Cancel');
      assert(
        await open.evaluate(
          (el) => !!el.closest('[aria-hidden="true"]') && getComputedStyle(document.body).pointerEvents === 'none'
        )
      );
      assert(
        await page
          .getByText('Packed interaction works', { exact: true })
          .evaluate(
            (el) => !!el.closest('[aria-hidden="true"]') && getComputedStyle(document.body).pointerEvents === 'none'
          ),
        'Sibling toast remains inert during dialog'
      );
      await page.keyboard.press('Escape');
      await page.getByText('Cancelled', { exact: true }).waitFor();
      await page.getByRole('alertdialog').waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Open dialog');
      for (const reducedMotion of ['reduce', 'no-preference', 'reduce']) {
        await page.emulateMedia({ reducedMotion });
        await page.getByRole('button', { name: 'Show banner' }).click();
        await page.getByText('Packed banner', { exact: true }).waitFor();
        if (reducedMotion === 'reduce')
          assert.equal(
            await page
              .getByText('Packed banner', { exact: true })
              .evaluate((el) => getComputedStyle(el.closest('[role=status]')).opacity),
            '1'
          );
        await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
        await page.getByText('Packed banner', { exact: true }).waitFor({ state: 'detached' });
      }
      await page.getByRole('button', { name: 'Swap content' }).click();
      await page.getByText('Loaded content', { exact: true }).waitFor();
      assert.equal(
        await page
          .getByText('Loaded content', { exact: true })
          .evaluate((el) => getComputedStyle(el.parentElement).opacity),
        '1'
      );
    }
    // Real browser checks: focus, typeahead, delay and preference changes.
    await page.getByRole('button', { name: 'Choose target' }).focus();
    await page.keyboard.press('ArrowDown');
    await page.getByRole('menu').waitFor();
    assert.equal(await page.getByRole('menu').evaluate((el) => getComputedStyle(el).animationName), 'none');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Alpha');
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => document.activeElement.textContent === 'Bravo');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Bravo');
    await page.keyboard.press('c');
    await page.waitForTimeout(30);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Charlie');
    await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement.textContent === 'Choose target');
    await page.mouse.move(0, 0, { steps: 10 });
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: 'First hint' }).hover();
    await page.waitForTimeout(150);
    assert.equal(await page.getByRole('tooltip').count(), 0);
    await page.getByRole('tooltip').waitFor();
    await page.mouse.move(0, 0, { steps: 10 });
    await page.getByRole('tooltip').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Second hint' }).hover();
    await page.waitForTimeout(50);
    assert.equal(await page.getByRole('tooltip').textContent(), 'Second tooltip');
    await page.mouse.move(0, 0, { steps: 10 });
    await page.getByRole('button', { name: 'Details' }).click();
    await page.getByText('Popover gallery content').waitFor();
    await page.keyboard.press('Escape');
    await page.getByText('Popover gallery content').waitFor({ state: 'detached' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: 'Open dialog' }).click();
    assert.equal(await page.getByRole('alertdialog').evaluate((el) => getComputedStyle(el).animationName), 'none');
    assert.equal(await page.getByRole('alertdialog').evaluate((el) => getComputedStyle(el).opacity), '1');
    await page.mouse.click(5, 5);
    await page.getByRole('alertdialog').waitFor({ state: 'detached' });
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
    const files = [...new Set(requests)].map((request) => {
      const path = new URL(request).pathname;
      return kind === 'vite' ? join(dir, 'dist', path) : join(dir, '.next', path.replace('/_next/', ''));
    });
    const sizes = { initial: 0, lazy: 0, static: 0 };
    for (const file of files) {
      const map = JSON.parse(readFileSync(`${file}.map`, 'utf8'));
      const lazy = map.sources.some(
        (source) =>
          source.includes('/ui/dist/motion/features.js') || source.includes('/render/dom/features-animation.mjs')
      );
      sizes[lazy ? 'lazy' : 'initial'] += gzipSync(readFileSync(file)).length;
    }
    const staticPage = await browser.newPage();
    const staticRequests = [];
    staticPage.on('response', (response) => {
      if (new URL(response.url()).pathname.endsWith('.js')) staticRequests.push(response.url());
    });
    await staticPage.goto(`${url}/${kind === 'vite' ? 'static.html' : 'static'}`);
    await staticPage.getByText('Static only', { exact: true }).waitFor();
    await staticPage.waitForTimeout(200);
    for (const request of new Set(staticRequests)) {
      const path = new URL(request).pathname;
      const file = kind === 'vite' ? join(dir, 'dist', path) : join(dir, '.next', path.replace('/_next/', ''));
      const map = JSON.parse(readFileSync(`${file}.map`, 'utf8'));
      assert(
        !map.sources.some((source) => /(?:framer-motion|motion-dom|ui\/dist\/motion)/.test(source)),
        `Motion leaked into static bundle: ${file}`
      );
      sizes.static += gzipSync(readFileSync(file)).length;
    }
    if (!baseline) {
      assert(sizes.lazy > 0, 'Missing separate lazy feature chunk');
      const delayedPage = await browser.newPage();
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      await delayedPage.route('**/*.js', async (route) => {
        const path = new URL(route.request().url()).pathname;
        const file = kind === 'vite' ? join(dir, 'dist', path) : join(dir, '.next', path.replace('/_next/', ''));
        const map = JSON.parse(readFileSync(`${file}.map`, 'utf8'));
        if (
          map.sources.some(
            (source) =>
              source.includes('/ui/dist/motion/features.js') || source.includes('/render/dom/features-animation.mjs')
          )
        )
          await gate;
        await route.continue();
      });
      try {
        await delayedPage.goto(url, { waitUntil: 'domcontentloaded' });
        await delayedPage.getByRole('button', { name: 'Show toast', exact: true }).click();
        const toast = delayedPage.getByText('Packed interaction works', { exact: true });
        await toast.waitFor();
        assert.equal(await toast.evaluate((el) => getComputedStyle(el.closest('[role=status]')).opacity), '1');
        await delayedPage.getByRole('button', { name: 'Open dialog', exact: true }).click();
        const dialog = delayedPage.getByRole('alertdialog');
        assert.equal(await dialog.evaluate((el) => getComputedStyle(el).opacity), '1');
        await delayedPage.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
        await delayedPage.emulateMedia({ reducedMotion: 'reduce' });
        assert.equal(
          await delayedPage.locator('.animate-pulse').evaluate((el) => getComputedStyle(el).animationName),
          'none'
        );
      } finally {
        release();
        await delayedPage.close();
      }
    }
    measurements[kind] = sizes;
    console.log(`${kind} gzip bytes: ${JSON.stringify(sizes)}`);
    console.log(`${kind}: hydration, Button/Toast interaction, and local fonts passed`);
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
  }
}
write(temporary, 'measurements.json', JSON.stringify(measurements, null, 2));
console.log(`Packed fixtures passed; retained only in temporary storage: ${temporary}`);
