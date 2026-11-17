import { chromium } from '/Users/eliot/.bb/plugins/environment-personal-workspace/host-data/workspaces/thr_g274tsjrk3/node_modules/playwright/index.mjs';
import { writeFileSync } from 'node:fs';
const browser = await chromium.launch({
  headless: true,
  executablePath:
    '/Users/eliot/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
});
const results = [];
// Real 65-second acceptance timers run concurrently; no virtual-clock timing claims.
await Promise.all(
  ['no-preference', 'reduce'].map(async (reducedMotion) => {
    const pages = await Promise.all(
      Array.from({ length: 11 }, async (_, i) => {
        const page = await browser.newPage({
          viewport: { width: 1440, height: 1000 },
          reducedMotion,
          colorScheme: 'dark',
        });
        page.on('pageerror', (error) => console.error(error));
        await page.goto(`http://127.0.0.1:1454/sessions-audit.html?acceptance${i === 10 ? '&negative' : ''}`);
        await page.getByText('Inspection and human Package remain separate from agent acceptance.').waitFor();
        await page.waitForTimeout(500);
        await page.evaluate(() => {
          window.shifts = [];
          new PerformanceObserver((list) => {
            for (const e of list.getEntries())
              window.shifts.push({ value: e.value, recentInput: e.hadRecentInput, time: e.startTime });
          }).observe({ type: 'layout-shift' });
          window.acceptanceStart = performance.now();
        });
        return { page, i };
      })
    );
    await Promise.all(
      pages.map(async ({ page, i }) => {
        await page
          .getByText('Session accepted · agent-fixture · Observing · read-only', { exact: true })
          .waitFor({ timeout: 75000 });
        await page.waitForTimeout(250);
        const sample = await page.evaluate(() => ({
          elapsed: performance.now() - window.acceptanceStart,
          shifts: window.shifts,
          raw: window.shifts.reduce((s, e) => s + e.value, 0),
          cls: window.shifts.filter((e) => !e.recentInput).reduce((s, e) => s + e.value, 0),
        }));
        results.push({ reducedMotion, run: i, negativeControl: i === 10, ...sample });
        if (i === 0) await page.screenshot({ path: `docs/evidence/workbench-w4/acceptance-${reducedMotion}.png` });
        await page.close();
      })
    );
  })
);
writeFileSync('docs/evidence/workbench-w4/acceptance.json', JSON.stringify(results, null, 2) + '\n');
await browser.close();
console.log(
  JSON.stringify(
    results.map(({ reducedMotion, run, cls, negativeControl }) => ({ reducedMotion, run, cls, negativeControl }))
  )
);
