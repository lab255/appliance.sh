import fs from 'node:fs';
import assert from 'node:assert/strict';
const { PLAYWRIGHT_MODULE, CHROMIUM_PATH, BASE_URL } = process.env;
if (!PLAYWRIGHT_MODULE || !CHROMIUM_PATH || !BASE_URL)
  throw new Error('Set PLAYWRIGHT_MODULE, CHROMIUM_PATH and BASE_URL');
const { chromium } = await import(PLAYWRIGHT_MODULE);
const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM_PATH });
const results = [];
try {
  for (const motion of ['no-preference', 'reduce'])
    for (const view of ['narrow', 'zoom']) {
      const page = await browser.newPage({
        viewport: { width: view === 'narrow' ? 390 : 1280, height: 900 },
        reducedMotion: motion,
      });
      await page.goto(BASE_URL + '/?slow=1');
      await page.locator('button').waitFor();
      if (view === 'zoom') await page.evaluate(() => (document.documentElement.style.zoom = '2'));
      await page.locator('button').focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('button').getAttribute('aria-busy') === 'true');
      await page.screenshot({ path: new URL(`./${view}-${motion}.png`, import.meta.url).pathname });
      const result = await page.evaluate(() => ({
        busy: document.querySelector('button').getAttribute('aria-busy'),
        label: document.querySelector('button').getAttribute('aria-label'),
        focus: document.activeElement === document.querySelector('button'),
        overflow: document.documentElement.scrollWidth > innerWidth,
        rect: document.querySelector('button').getBoundingClientRect().toJSON(),
      }));
      assert(result.focus);
      assert.equal(result.label, 'Retrying…');
      assert(!result.overflow);
      results.push({ motion, view, ...result });
      await page.close();
    }
  fs.writeFileSync(new URL('./appearance.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
} finally {
  await browser.close();
}
