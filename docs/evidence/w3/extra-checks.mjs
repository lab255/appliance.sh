import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
await page.goto('http://127.0.0.1:1443/inspection-audit.html');
await page.getByRole('treeitem').filter({ hasText: 'data/large.txt' }).click();
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
fs.writeFileSync(
  'docs/evidence/w3/extra-checks.json',
  JSON.stringify(
    {
      composedFailure: { staleCapturedAt: '2026-11-17T12:10:00Z', refreshFailed: true, noFalseNoChanges: true },
      largeRefresh: { before: 800, after: largeRefresh.scrollTop, retainedText: true },
      zoom200: { horizontalOverflow: zoomOverflow },
      narrow390: { horizontalOverflow: narrowOverflow },
    },
    null,
    2
  ) + '\n'
);
await browser.close();
