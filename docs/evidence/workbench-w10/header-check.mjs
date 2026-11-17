import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium, chromiumPath } from '../workbench-w4/browser-env.mjs';
const { HEADER_URL, HEADER_IMAGE, HEADER_MEASUREMENT } = process.env;
if (!HEADER_URL || !HEADER_IMAGE || !HEADER_MEASUREMENT)
  throw new Error('Set HEADER_URL, HEADER_IMAGE, and HEADER_MEASUREMENT');
const browser = await chromium.launch({ executablePath: chromiumPath });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(HEADER_URL);
  await page.locator('aside > div').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  if (process.env.HEADER_PLANT_OLD_HEIGHT === '1') {
    await page
      .locator('aside > div')
      .first()
      .evaluate((element) => {
        element.style.minHeight = '57px';
        element.style.height = '57px';
      });
  }
  const measurement = await page.evaluate(() => ({
    header: document.querySelector('header').getBoundingClientRect().toJSON(),
    brand: document.querySelector('aside > div').getBoundingClientRect().toJSON(),
  }));
  await page.screenshot({ path: HEADER_IMAGE });
  writeFileSync(HEADER_MEASUREMENT, JSON.stringify(measurement, null, 2) + '\n');
  assert.equal(measurement.brand.bottom, measurement.header.bottom, 'brand/header dividers must align');
  assert.ok(measurement.header.height > 0, 'control: header must have measurable height');
} finally {
  await browser.close();
}
