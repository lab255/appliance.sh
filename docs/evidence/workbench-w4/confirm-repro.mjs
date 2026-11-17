import { chromium, chromiumPath, fixtureUrl } from './browser-env.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
const browser = await chromium.launch({
  headless: true,
  executablePath: chromiumPath,
});
const results = [];
for (const reducedMotion of ['no-preference', 'reduce']) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion });
  await page.goto(fixtureUrl('?confirm-only'));
  // Negative control: decorative button press offset is still suppressed under reduce.
  const opener = page.getByRole('button', { name: 'Open standalone confirmation' });
  await opener.hover();
  await page.mouse.down();
  const pressedTranslate = await opener.evaluate((element) => getComputedStyle(element).translate);
  await page.mouse.up();

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
  results.push({
    reducedMotion,
    pointerError,
    pointerTrace,
    pressedTranslate,
    finalTrace: await page.evaluate(() => window.w4Trace),
  });
  await page.close();
}
writeFileSync('docs/evidence/workbench-w4/confirm-repro.json', JSON.stringify(results, null, 2) + '\n');
console.log(results);
await browser.close();
for (const result of results) {
  assert.equal(result.pointerError, null, `${result.reducedMotion}: pointer click failed`);
  assert.ok(result.pointerTrace.trace.includes('confirmed:true'));
  if (result.reducedMotion === 'reduce') assert.equal(result.pressedTranslate, 'none');
  else assert.notEqual(result.pressedTranslate, 'none', 'decorative press control must actually translate');
}
