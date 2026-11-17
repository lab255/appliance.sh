import { chromium, chromiumPath, fixtureUrl } from './browser-env.mjs';
import { writeFileSync } from 'node:fs';
const browser = await chromium.launch({
  headless: true,
  executablePath: chromiumPath,
});
const results = [];
for (const reducedMotion of ['no-preference', 'reduce']) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion, colorScheme: 'dark' });
  page.on('pageerror', (e) => console.error(e));
  await page.goto(fixtureUrl('?fail-stop'));
  await page.waitForFunction(() => document.querySelector('button')?.getAttribute('aria-disabled') === 'false');
  async function timed(button, copy, keyboard = false) {
    await page.evaluate((copy) => {
      window.ack = { start: 0, ms: null, shifts: [] };
      const observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.ack.shifts.push({ value: e.value, recent: e.hadRecentInput });
      });
      observer.observe({ type: 'layout-shift' });
      window.ackObserver = observer;
      document.addEventListener(
        'click',
        () => {
          window.ack.start = performance.now();
          const poll = () => {
            if (document.body.innerText.includes(copy))
              requestAnimationFrame(() => (window.ack.ms = performance.now() - window.ack.start));
            else requestAnimationFrame(poll);
          };
          requestAnimationFrame(poll);
        },
        { once: true, capture: true }
      );
    }, copy);
    if (keyboard) {
      await button.focus();
      await button.press('Enter');
    } else await button.click();
    await page.waitForFunction(() => window.ack.ms !== null);
    await page.waitForTimeout(100);
    return await page.evaluate(() => {
      window.ackObserver.disconnect();
      return window.ack;
    });
  }
  for (let i = 0; i < 10; i++) {
    const sample = await timed(page.getByRole('button', { name: 'Observe', exact: true }), 'Observing · read-only');
    results.push({ reducedMotion, kind: 'observe', run: i, ...sample });
    const dialog = page.getByRole('dialog');
    await dialog.locator('textarea').focus();
    await page.keyboard.type('typed while observing');
    await page.keyboard.press('Enter');
    await dialog.getByRole('button', { name: 'Hide', exact: true }).click();
  }
  for (let i = 0; i < 10; i++) {
    const sample = await timed(
      page.getByRole('button', { name: 'Interact with agent', exact: true }),
      'Interactive terminal. Input is sent to the agent.'
    );
    results.push({ reducedMotion, kind: 'interact', run: i, ...sample });
    await page.getByRole('button', { name: 'Return to observation', exact: true }).click();
  }
  // Zero-write observation assertion and deliberate input negative control use the real xterm.
  const before = await page.evaluate(() => window.w4Trace);
  if (before.some((x) => x.startsWith('write:') || x === 'close' || x === 'stop'))
    throw new Error('Observe/hide wrote or stopped');
  await page.getByRole('button', { name: 'Observe', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Interact with agent', exact: true }).click();
  await dialog.locator('textarea').focus();
  await page.keyboard.type('positive-control');
  const after = await page.evaluate(() => window.w4Trace);
  if (!after.some((x) => x.startsWith('write:'))) throw new Error('Interactive negative control did not write');
  await dialog.getByRole('button', { name: 'Return to observation', exact: true }).click();
  await page.screenshot({ path: `docs/evidence/workbench-w4/observe-${reducedMotion}.png` });
  await dialog.getByRole('button', { name: 'Hide', exact: true }).click();
  for (let i = 0; i < 10; i++) {
    await page.getByRole('button', { name: 'Stop agent', exact: true }).click();
    const confirmation = page.getByRole('alertdialog');
    const sample = await timed(
      confirmation.getByRole('button', { name: 'Stop agent', exact: true }),
      'Stopping…',
      true
    );
    results.push({ reducedMotion, kind: 'stop', run: i, ...sample });
    await page.getByText('Could not confirm stop:', { exact: false }).waitFor();
  }
  results.push({ reducedMotion, kind: 'trace', before, after, final: await page.evaluate(() => window.w4Trace) });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `docs/evidence/workbench-w4/narrow-${reducedMotion}.png` });
  await page.close();
}
writeFileSync('docs/evidence/workbench-w4/interactions.json', JSON.stringify(results, null, 2) + '\n');
console.log(results.filter((r) => r.ms).map((r) => ({ mode: r.reducedMotion, kind: r.kind, ms: r.ms })));
await browser.close();
