import { chromium, chromiumPath, fixtureUrl } from './browser-env.mjs';
import { writeFileSync } from 'node:fs';
const browser = await chromium.launch({
  headless: true,
  executablePath: chromiumPath,
});
const results = [];
for (const reducedMotion of ['no-preference', 'reduce']) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion });
  await page.goto(fixtureUrl('?confirm-only'));
  await page.getByRole('button', { name: 'Open standalone confirmation' }).click();
  const button = page.getByRole('alertdialog').getByRole('button', { name: 'Confirm probe' });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.events = [];
    for (const name of ['pointerdown', 'pointerup', 'click'])
      document.addEventListener(
        name,
        (e) => window.events.push({ type: name, target: e.target.tagName, text: e.target.textContent?.slice(0, 80) }),
        true
      );
  });
  let pointerError = null;
  try {
    await button.click({ timeout: 3000 });
  } catch (e) {
    pointerError = String(e).split('Call log:')[0];
  }
  await page.waitForTimeout(200);
  const pointerTrace = await page.evaluate(() => ({ trace: window.w4Trace, events: window.events }));
  if (pointerError) {
    await button.focus();
    await button.press('Enter');
    await page.waitForTimeout(200);
  }
  results.push({ reducedMotion, pointerError, pointerTrace, finalTrace: await page.evaluate(() => window.w4Trace) });
  await page.close();
}
writeFileSync('docs/evidence/workbench-w4/confirm-repro.json', JSON.stringify(results, null, 2) + '\n');
console.log(results);
await browser.close();
