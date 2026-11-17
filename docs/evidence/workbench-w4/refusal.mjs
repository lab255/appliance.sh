import { chromium, chromiumPath, fixtureUrl } from './browser-env.mjs';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true, executablePath: chromiumPath });
const results = [];
const notice = 'Input not sent — observing read-only. Choose Interact with agent.';
for (const reducedMotion of ['no-preference', 'reduce']) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion });
  await page.goto(fixtureUrl());
  const observe = page.getByRole('button', { name: 'Observe', exact: true });
  await page.waitForFunction(() => document.querySelector('button')?.getAttribute('aria-disabled') === 'false');
  await observe.click();
  const drawer = page.getByRole('dialog');
  const input = drawer.locator('textarea');
  await input.focus();
  await page.keyboard.type('refused typing');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+c');
  await input.evaluate((el) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'refused paste');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await drawer.getByRole('status').filter({ hasText: notice }).waitFor();
  const refused = await page.evaluate(() => ({
    trace: window.w4Trace,
    blinkingCursor: !!document.querySelector('.xterm-cursor-blink'),
  }));
  assert.deepEqual(refused.trace, ['attach']);
  assert.equal(refused.blinkingCursor, false);
  await page.screenshot({ path: `docs/evidence/workbench-w4/refusal-${reducedMotion}.png` });
  await drawer.getByText(notice, { exact: true }).waitFor({ state: 'hidden', timeout: 5000 });
  await drawer.getByRole('button', { name: 'Interact with agent', exact: true }).click();
  await input.focus();
  await page.keyboard.type('negative-control');
  await page.waitForTimeout(50);
  const interactive = await page.evaluate(() => ({
    trace: window.w4Trace,
    blinkingCursor: !!document.querySelector('.xterm-cursor-blink'),
  }));
  assert(interactive.trace.some((item) => item.startsWith('write:')));
  assert.equal(interactive.blinkingCursor, true);
  results.push({ reducedMotion, refused, notice, expiry: 'hidden within 5s (3s timer)', interactive });
  await page.close();
}
writeFileSync('docs/evidence/workbench-w4/refusal.json', JSON.stringify(results, null, 2) + '\n');
await browser.close();
console.log(results);
