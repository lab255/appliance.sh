import { chromium, chromiumPath, fixtureUrl } from './browser-env.mjs';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true, executablePath: chromiumPath });
const results = [];
const notice = 'Input not sent — observing read-only. Choose Interact with agent.';
for (const reducedMotion of ['no-preference', 'reduce']) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion });
  await page.goto(fixtureUrl());
  await page.waitForFunction(() => document.querySelector('button')?.getAttribute('aria-disabled') === 'false');
  await page.getByRole('button', { name: 'Observe', exact: true }).click();
  const drawer = page.getByRole('dialog');
  const input = drawer.locator('textarea');
  await input.focus();
  // write() is the display API, not agent input. Exercise it and the real host-output callback.
  await page.evaluate(() => new Promise((resolve) => window.w4Xterm.write('\r\nPROGRAMMATIC OUTPUT\r\n', resolve)));
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('PROGRAMMATIC OUTPUT'));
  await page.evaluate(() => window.w4Output('HOST OUTPUT STILL LIVE\r\n'));
  await page.waitForFunction(() =>
    document.querySelector('.xterm-rows')?.textContent.includes('HOST OUTPUT STILL LIVE')
  );
  const output = await page.evaluate(() => ({
    trace: window.w4Trace,
    events: window.w4InputEvents,
    displayed: document.querySelector('.xterm-rows').textContent,
  }));
  assert.deepEqual(output.trace, ['attach']);
  assert.deepEqual(output.events, []);
  assert(output.displayed.includes('PROGRAMMATIC OUTPUT') && output.displayed.includes('HOST OUTPUT STILL LIVE'));
  // Cursor-position/device-attributes queries generate input without a user gesture.
  await page.evaluate(() => new Promise((resolve) => window.w4Xterm.write('\x1b[6n\x1b[c', resolve)));
  await page.waitForFunction(() => window.w4InputEvents.length >= 2);
  await page.waitForTimeout(100);
  const autoReplies = await page.evaluate(() => ({ trace: window.w4Trace, events: window.w4InputEvents }));
  assert(autoReplies.events.length >= 2, 'both queries must actually emit replies');
  assert.deepEqual(autoReplies.trace, ['attach'], 'auto-replies must not write');
  assert.equal(await drawer.getByText(notice, { exact: true }).count(), 0, 'auto-replies must not show refusal');
  // Enable bracketed paste through the output API, exactly as an agent TUI does.
  await page.evaluate(() => new Promise((resolve) => window.w4Xterm.write('\x1b[?2004h', resolve)));
  async function routes(interactive) {
    const samples = [];
    const actions = [
      [
        'focus-then-type',
        async () => {
          await drawer.getByRole('button', { name: 'Hide', exact: true }).focus();
          await input.focus();
          await page.keyboard.type('typed-input');
        },
      ],
      ...['Enter', 'Control+c', 'Control+d', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].map((key) => [
        key,
        () => page.keyboard.press(key),
      ]),
      [
        'clipboard-paste',
        () =>
          input.evaluate((el) => {
            const clipboardData = new DataTransfer();
            clipboardData.setData('text/plain', 'clipboard-input');
            el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
          }),
      ],
      ['xterm.input', () => page.evaluate(() => window.w4Xterm.input('api-input'))],
      [
        'xterm.write-response-query',
        () => page.evaluate(() => new Promise((resolve) => window.w4Xterm.write('\x1b[6n', resolve))),
      ],
      ['xterm.paste-bracketed', () => page.evaluate(() => window.w4Xterm.paste('api-paste'))],
    ];
    for (const [route, action] of actions) {
      const before = await page.evaluate(() => ({ calls: window.w4Trace.length, events: window.w4InputEvents.length }));
      await action();
      const after = await page.evaluate(
        (before) => ({
          calls: window.w4Trace.slice(before.calls),
          events: window.w4InputEvents.slice(before.events),
          focused: document.activeElement?.classList.contains('xterm-helper-textarea'),
        }),
        before
      );
      assert(after.events.length > 0, `${route} must actually emit input (no vacuous pass)`);
      if (interactive)
        assert(
          after.calls.some((call) => call.startsWith('write:')),
          `${route} negative control must write`
        );
      else {
        assert.deepEqual(after.calls, [], `${route} must not write/close/stop`);
        await drawer.getByRole('status').filter({ hasText: notice }).waitFor();
      }
      if (route === 'focus-then-type') assert.equal(after.focused, true);
      if (route === 'xterm.paste-bracketed')
        assert(after.events.some((data) => data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~')));
      samples.push({ route, ...after });
    }
    return samples;
  }
  const refusedRoutes = await routes(false);
  const refused = await page.evaluate(() => ({
    trace: window.w4Trace,
    blinkingCursor: !!document.querySelector('.xterm-cursor-blink'),
  }));
  assert.deepEqual(refused.trace, ['attach']);
  assert.equal(refused.blinkingCursor, false);
  await page.screenshot({ path: `docs/evidence/workbench-w4/refusal-${reducedMotion}.png` });
  await drawer.getByText(notice, { exact: true }).waitFor({ state: 'hidden', timeout: 5000 });
  await drawer.getByRole('button', { name: 'Interact with agent', exact: true }).click();
  const interactiveRoutes = await routes(true);
  await page.waitForTimeout(50);
  const blinkingInteractive = await page.evaluate(() => !!document.querySelector('.xterm-cursor-blink'));
  assert.equal(blinkingInteractive, true);
  results.push({
    reducedMotion,
    output,
    autoReplies,
    refusedRoutes,
    refused,
    notice,
    expiry: 'hidden within 5s (3s timer)',
    interactiveRoutes,
    blinkingInteractive,
  });
  await page.close();
}
writeFileSync('docs/evidence/workbench-w4/refusal.json', JSON.stringify(results, null, 2) + '\n');
await browser.close();
console.log(
  results.map((result) => ({
    mode: result.reducedMotion,
    refusedRoutes: result.refusedRoutes.length,
    interactiveControls: result.interactiveRoutes.length,
    hostOutputDisplayed: true,
    programmaticOutputDisplayed: true,
    observeWrites: 0,
  }))
);
