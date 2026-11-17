import { chromium, chromiumPath, fixtureUrl } from './browser-env.mjs';
import { writeFileSync } from 'node:fs';
const browser = await chromium.launch({
  headless: true,
  executablePath: chromiumPath,
});
const results = [];
for (const reducedMotion of ['no-preference', 'reduce']) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion });
  await page.goto(fixtureUrl('?fail-stop'));
  await page.waitForFunction(() => document.querySelector('button')?.getAttribute('aria-disabled') === 'false');
  // A disabled Interact remains focusable; real key activation cannot open/authorize a terminal.
  const interact = page.getByRole('button', { name: 'Interact with agent', exact: true });
  await interact.focus();
  await interact.press('Enter');
  const gated = await page.evaluate(() => ({ trace: window.w4Trace, focus: document.activeElement.textContent }));
  if (gated.trace.length) throw new Error('gated activation made a call');
  await page.getByRole('button', { name: 'Stop agent', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
  await page.waitForTimeout(250);
  const cancelled = await page.evaluate(() => ({ trace: window.w4Trace, focus: document.activeElement.textContent }));
  if (cancelled.trace.length) throw new Error('cancel stopped the agent');
  await page.getByRole('button', { name: 'Observe', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Hide', exact: true }).click();
  const hidden = await page.evaluate(() => ({ trace: window.w4Trace, focus: document.activeElement.textContent }));
  if (hidden.trace.join(',') !== 'attach' || hidden.focus !== 'Observe')
    throw new Error('hide lost focus or changed lifecycle: ' + JSON.stringify(hidden));
  await page.evaluate(() => (document.body.style.zoom = '2'));
  await page.screenshot({ path: `docs/evidence/workbench-w4/zoom-${reducedMotion}.png` });
  await page.evaluate(() => (document.body.style.zoom = '1'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Observe', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.waitForTimeout(100);
  await page.screenshot({ path: `docs/evidence/workbench-w4/narrow-terminal-${reducedMotion}.png` });
  const narrow = await page.evaluate(() => ({
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    terminalHeight: document.querySelector('.xterm')?.getBoundingClientRect().height,
  }));
  results.push({ reducedMotion, gated, cancelled, hidden, narrow, zoom: 'CSS zoom 2; not native browser zoom' });
  await page.close();
}
writeFileSync('docs/evidence/workbench-w4/extra-checks.json', JSON.stringify(results, null, 2) + '\n');
console.log(results);
await browser.close();
