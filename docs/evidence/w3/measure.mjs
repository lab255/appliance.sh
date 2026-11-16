import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
const results = [];
for (const reducedMotion of ['no-preference', 'reduce']) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion, colorScheme: 'dark' });
  page.on('pageerror', (e) => console.error(e.message));
  await page.goto('http://127.0.0.1:1443/inspection-audit.html');
  await page.getByRole('treeitem').first().waitFor();
  await page.waitForTimeout(300);
  for (const kind of ['tab', 'file', 'diff', 'binary', 'large']) {
    const samples = [];
    for (let run = 0; run < 10; run++) {
      const targetTab = kind === 'file' ? 'Files' : 'Changes';
      if (kind !== 'tab') await page.getByRole('tab', { name: targetTab, exact: true }).click();
      const target =
        kind === 'tab'
          ? page.getByRole('tab', { name: run % 2 ? 'Changes' : 'Files', exact: true })
          : page.getByRole('treeitem').filter({
              hasText:
                kind === 'binary'
                  ? 'assets/binary.png'
                  : kind === 'large'
                    ? 'data/large.txt'
                    : run % 2
                      ? 'src/added.ts'
                      : 'src/app.ts',
            });
      await page.evaluate(
        ({ kind }) => {
          window.sample = { start: 0, ack: null, shifts: [] };
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries())
              window.sample.shifts.push({ value: entry.value, recentInput: entry.hadRecentInput });
          });
          observer.observe({ type: 'layout-shift' });
          document.addEventListener(
            'pointerdown',
            () => {
              window.sample.start = performance.now();
              const poll = () => {
                const ack =
                  kind === 'tab'
                    ? document.activeElement?.getAttribute('aria-selected') === 'true'
                    : document.querySelector('[role=status]')?.textContent?.includes('Loading file');
                if (ack) window.sample.ack = performance.now() - window.sample.start;
                else requestAnimationFrame(poll);
              };
              requestAnimationFrame(poll);
            },
            { once: true }
          );
          window.stopObserver = () => observer.disconnect();
        },
        { kind }
      );
      await target.click();
      await page.waitForTimeout(350);
      samples.push(
        await page.evaluate(() => {
          window.stopObserver();
          return window.sample;
        })
      );
    }
    const timings = samples.map((s) => s.ack).sort((a, b) => a - b);
    results.push({ reducedMotion, kind, count: samples.length, medianMs: (timings[4] + timings[5]) / 2, samples });
  }
  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
  await page.getByRole('treeitem').filter({ hasText: 'src/app.ts' }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Refresh inspection' }).focus();
  await page.getByRole('tab', { name: 'Changes', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('[role=tab]')).some(
      (el) => el.textContent === 'Files' && el.getAttribute('aria-selected') === 'true'
    )
  );
  if ((await page.getByRole('tab', { name: 'Files', exact: true }).getAttribute('aria-selected')) !== 'true')
    throw new Error('Keyboard tabs failed');
  await page.getByRole('treeitem').first().focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
  await page.getByRole('treeitem').filter({ hasText: 'src/app.ts' }).click();
  await page.waitForTimeout(300);
  await page.locator('pre[aria-label="Unified diff"]').evaluate((el) => {
    el.scrollTop = 900;
    el.focus();
  });
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(250); // allow the browser's native keyboard scroll to settle
  const before = await page.locator('pre[aria-label="Unified diff"]').evaluate((el) => el.scrollTop);
  await page.getByRole('button', { name: 'Refresh inspection' }).click();
  await page.waitForTimeout(550);
  const after = await page.locator('pre[aria-label="Unified diff"]').evaluate((el) => el.scrollTop);
  if (before !== after) throw new Error(`Refresh moved reader ${before} -> ${after}`);
  await page.screenshot({ path: `docs/evidence/w3/inspector-${reducedMotion}.png` });
  results.push({
    reducedMotion,
    keyboard: 'tabs, tree arrows/Enter, diff PageDown passed',
    refreshScroll: { before, after },
  });
  await page.getByRole('treeitem').filter({ hasText: 'data/large.txt' }).click();
  await page.getByRole('button', { name: 'Load large file' }).waitFor();
  await page.screenshot({ path: `docs/evidence/w3/large-${reducedMotion}.png` });
  await page.getByRole('button', { name: 'Load large file' }).click();
  await page.getByText('Truncated: only the first 1 MiB of each side is displayed and compared here.').waitFor();
  if (await page.getByRole('treeitem').filter({ hasText: 'agent-1.json' }).count())
    throw new Error('Generated results leaked into default changes');
  await page.getByRole('checkbox').check();
  await page.getByRole('treeitem').filter({ hasText: 'agent-1.json' }).waitFor();
  results.push({
    reducedMotion,
    truncation: 'withheld until deliberate load; truncation label visible',
    generatedFilter: 'hidden by default, overridable',
  });
  await page.setViewportSize({ width: 720, height: 1000 });
  await page.screenshot({ path: `docs/evidence/w3/narrow-${reducedMotion}.png` });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://127.0.0.1:1443/inspection-audit.html?fail-refresh');
  await page.getByRole('treeitem').first().waitFor();
  await page.getByRole('treeitem').filter({ hasText: 'src/app.ts' }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Refresh inspection' }).click();
  await page.getByText('Previous snapshot is stale').waitFor();
  if (!(await page.locator('pre[aria-label="Unified diff"]').textContent()).includes('baseline/src/app.ts'))
    throw new Error('Lost stale preview');
  await page.goto('http://127.0.0.1:1443/inspection-audit.html?unavailable');
  await page.getByText('No baseline captured — change comparison will be unavailable').waitFor();
  if ((await page.locator('body').textContent()).includes('No changes since workspace baseline'))
    throw new Error('False no changes');
  await page.close();
}
writeFileSync(
  'docs/evidence/w3/measurements.json',
  JSON.stringify(
    {
      platform: process.platform,
      arch: process.arch,
      viewport: [1440, 1000],
      source: 'actual component / fixture host with 200ms latency',
      results,
    },
    null,
    2
  ) + '\n'
);
await browser.close();
