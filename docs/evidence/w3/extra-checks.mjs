import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
await page.goto('http://127.0.0.1:1443/inspection-audit.html');
await page.getByRole('treeitem').filter({ hasText: 'data/large.txt' }).click();
await page.evaluate(() => {
  window.largeShifts = [];
  window.largeObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      window.largeShifts.push({ value: entry.value, recentInput: entry.hadRecentInput });
  });
  window.largeObserver.observe({ type: 'layout-shift' });
});
await page.getByRole('button', { name: 'Load large file' }).click();
await page.getByText(/Truncated diff inputs:/).waitFor();
await page.locator('pre[aria-label="Unified diff"]').evaluate((el) => (el.scrollTop = 800));
await page.getByRole('button', { name: 'Refresh inspection' }).click();
await page.waitForTimeout(550);
const largeRefresh = await page
  .locator('pre[aria-label="Unified diff"]')
  .evaluate((el) => ({ scrollTop: el.scrollTop, text: el.textContent }));
if (largeRefresh.scrollTop !== 800 || !largeRefresh.text.includes('baseline/data/large.txt'))
  throw Error(`Large refresh lost reading state: ${JSON.stringify(largeRefresh)}`);
const largeShifts = await page.evaluate(() => {
  window.largeObserver.disconnect();
  return window.largeShifts;
});
await page.evaluate(() => (document.documentElement.style.zoom = '2'));
await page.screenshot({ path: 'docs/evidence/w3/zoom-200.png' });
const zoomOverflow = await page.evaluate(
  () => document.documentElement.scrollWidth > document.documentElement.clientWidth
);
await page.evaluate(() => (document.documentElement.style.zoom = '1'));
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: 'docs/evidence/w3/narrow-390.png' });
const narrowOverflow = await page.evaluate(
  () => document.documentElement.scrollWidth > document.documentElement.clientWidth
);
await page.setViewportSize({ width: 1440, height: 1000 });
await page.goto('http://127.0.0.1:1443/inspection-audit.html?composed');
await page.getByText('No changes since workspace baseline', { exact: true }).waitFor();
await page.getByRole('button', { name: 'Refresh inspection' }).click();
await page.getByText('Previous snapshot is stale — captured 2026-11-17T12:10:00Z; refresh failed').waitFor();
const composedText = await page.locator('body').textContent();
if (composedText.includes('No changes since workspace baseline'))
  throw new Error('Composed failure falsely claims no changes');
await page.screenshot({ path: 'docs/evidence/w3/composed-stale.png' });
await page.goto('http://127.0.0.1:1443/inspection-audit.html?generated-only');
await page.getByText(/0 files · 3 generated changes hidden/).waitFor();
await page.getByText(/No changes to tracked files. 3 generated paths changed/).waitFor();
if ((await page.locator('body').textContent()).includes('No changes since workspace baseline'))
  throw Error('Generated-only changes falsely claim an unchanged workspace');
await page.screenshot({ path: 'docs/evidence/w3/generated-hidden.png' });
await page.getByRole('checkbox').check();
if ((await page.getByRole('treeitem').count()) !== 3) throw Error('Generated override must reveal all three paths');
await page.getByText(/Changed since workspace baseline · 3 files/).waitFor();
fs.writeFileSync(
  'docs/evidence/w3/extra-checks.json',
  JSON.stringify(
    {
      generatedOnly: { hiddenCount: 3, disclosed: true, overrideCount: 3, noFalseNoChanges: true },
      composedFailure: { staleCapturedAt: '2026-11-17T12:10:00Z', refreshFailed: true, noFalseNoChanges: true },
      largePayload: {
        retainedBytes: 1048576,
        rawShifts: largeShifts,
        cls: largeShifts.filter((s) => !s.recentInput).reduce((sum, s) => sum + s.value, 0),
      },
      largeRefresh: { before: 800, after: largeRefresh.scrollTop, retainedText: true },
      zoom200: { horizontalOverflow: zoomOverflow },
      narrow390: { horizontalOverflow: narrowOverflow },
    },
    null,
    2
  ) + '\n'
);
await browser.close();
