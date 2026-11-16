import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const { chromium } = createRequire(process.env.PLAYWRIGHT_NODE_MODULES + '/package.json')('playwright-core');
const out = process.env.EVIDENCE_DIR || '/tmp/workbench-evidence';
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
const results = [];
for (const motion of ['no-preference', 'reduce']) {
  for (let run = 0; run < 10; run++) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      colorScheme: 'dark',
      reducedMotion: motion,
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.shifts = [];
      new PerformanceObserver((l) => {
        for (const e of l.getEntries())
          window.shifts.push({ value: e.value, time: e.startTime, input: e.hadRecentInput });
      }).observe({ type: 'layout-shift', buffered: true });
    });
    const measurements = { motion, run };
    async function measure(name, action, selector, text) {
      await page.evaluate(
        ({ selector, text }) => {
          window.ack = null;
          const listen = () => {
            const start = performance.now();
            const check = () => {
              const el = document.querySelector(selector);
              if (el && (!text || el.textContent.includes(text)) && getComputedStyle(el).visibility !== 'hidden') {
                window.ack = performance.now() - start;
              } else requestAnimationFrame(check);
            };
            requestAnimationFrame(check);
          };
          document.addEventListener('click', listen, { once: true, capture: true });
        },
        { selector, text }
      );
      await action();
      await page.waitForFunction(() => window.ack !== null);
      measurements[name] = await page.evaluate(() => window.ack);
    }
    await page.goto(
      (process.env.APP_ORIGIN || 'http://localhost:1450') +
        '/workbench?mock-host&scenario=developer-mode&workbench-fixture=empty'
    );
    await page.getByText('No workspaces yet.', { exact: false }).waitFor();
    if (!run) await page.screenshot({ path: `${out}/s1-empty-${motion}.png` });
    await measure(
      'create',
      () => page.getByRole('button', { name: 'Create workspace', exact: true }).click(),
      '[role="dialog"]'
    );
    await page.waitForTimeout(250); // Entry acknowledgment measured above; exercise the next control after the dialog settles.
    await page.getByRole('dialog').getByRole('button', { name: 'Create blank workspace', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('conflict');
    await page.getByLabel('Parent directory', { exact: true }).fill('/Users/dev/projects');
    await measure(
      'validationAcknowledgment',
      () => page.getByRole('dialog').getByRole('button', { name: 'Create blank workspace', exact: true }).click(),
      '[role="dialog"]',
      'Creating…'
    );
    await page.getByRole('alert').waitFor();
    measurements.retained = (await page.getByLabel('Name', { exact: true }).inputValue()) === 'conflict';
    if (!run) await page.screenshot({ path: `${out}/s1-conflict-${motion}.png` });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.textContent === 'Create workspace');
    measurements.cancelFocus = await page
      .getByRole('button', { name: 'Create workspace', exact: true })
      .evaluate((el) => el === document.activeElement);
    await page.goto(
      (process.env.APP_ORIGIN || 'http://localhost:1450') +
        '/workbench?mock-host&scenario=developer-mode&workbench-fixture=mismatch'
    );
    await page.getByRole('link', { name: /demo-node-container/ }).waitFor();
    await measure(
      'openRow',
      () => page.getByRole('link', { name: /demo-node-container/ }).click(),
      'main',
      'Opening workspace'
    );
    await page.getByText('This machine is using another folder', { exact: true }).waitFor();
    if (!run) await page.screenshot({ path: `${out}/s2-mismatch-${motion}.png` });
    const options = await page
      .locator('#workbench-target option')
      .evaluateAll((els) => els.filter((e) => !e.disabled).map((e) => e.value));
    measurements.targetOptions = options;
    if (options.length) {
      await page.evaluate(() => {
        window.ack = null;
        document.addEventListener(
          'change',
          () => {
            const start = performance.now();
            const loop = () => {
              if (document.body.textContent.includes('Saving deployment target'))
                window.ack = performance.now() - start;
              else requestAnimationFrame(loop);
            };
            requestAnimationFrame(loop);
          },
          { once: true, capture: true }
        );
      });
      await page.locator('#workbench-target').selectOption(options[0]);
      await page.waitForFunction(() => window.ack !== null);
      measurements.target = await page.evaluate(() => window.ack);
      await page.getByText('Applies to this workspace only.').waitFor();
    }
    measurements.shifts = await page.evaluate(() => window.shifts);
    results.push(measurements);
    writeFileSync(`${out}/surface.json`, JSON.stringify(results, null, 2));
    await context.close();
  }
}
await browser.close();
