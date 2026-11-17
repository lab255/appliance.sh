import fs from 'node:fs';
import assert from 'node:assert/strict';
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ||
    '/Users/eliot/.bb/plugins/environment-personal-workspace/host-data/workspaces/thr_g274tsjrk3/node_modules/playwright/index.mjs'
);
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROMIUM_PATH ||
    '/Users/eliot/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
});
const results = [];
for (const motion of ['no-preference', 'reduce']) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: motion });
  await page.goto('http://localhost:1455');
  await page.locator('[data-package-readiness]').waitFor();
  await page.evaluate(() => window.emitProposal('done', '/other'));
  assert.equal(await page.getByText('Agent-proposed · not approved', { exact: true }).count(), 0);
  await page.evaluate(() => window.emitProposal());
  const link = page.getByRole('link', { name: 'Inspect changes', exact: true });
  await link.focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Dismiss proposal');
  await page.keyboard.press('Enter');
  await page.getByText('Stale proposal — You dismissed this proposal.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Dismiss proposal');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'workbench-inspection');
  await page.reload();
  await page.locator('[data-package-readiness]').waitFor();
  await page.evaluate(() => window.emitProposal('stopped'));
  await page.getByText('Stale proposal — The source session was stopped.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Package', exact: true }).isEnabled(), true);
  assert.equal(await page.evaluate(() => window.packageCalls), 0);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.evaluate(() => (document.body.style.zoom = '2'));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false);
  results.push({
    motion,
    wrongDirectoryRejected: true,
    keyboardDismissRetainsFocus: true,
    keyboardInspectionFocus: true,
    stoppedIsStale: true,
    packageEnabled: true,
    automaticCalls: 0,
    zoom200HorizontalOverflow: overflow,
  });
  await page.close();
}
fs.writeFileSync(new URL('./acceptance.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
await browser.close();
