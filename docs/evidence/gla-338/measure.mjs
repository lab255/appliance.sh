import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
for (const name of ['PLAYWRIGHT_MODULE', 'CHROMIUM_PATH', 'BASE_URL']) {
  if (!process.env[name]) throw new Error(`Set ${name} before running the GLA-338 probe.`);
}
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const out = fileURLToPath(new URL('./', import.meta.url));
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
const cases = [
  ['switch', 'Switch', 'Switching…'],
  ['program', 'Browse', 'Choose program…'],
  ['terminal', 'Start sign-in', 'Opening terminal…'],
  ['relaunch', 'Restart to update', 'Restarting…'],
  ['folder', 'Share a folder…', 'Choose folder…'],
  ['deploy', 'Deploy app', 'Opening deploy…'],
];
const samples = [];
const timingControl = process.env.PAINT_CONTROL === '1';
const geometryControl = process.env.RESERVE_CONTROL === '1';
const calibration = timingControl || geometryControl;
const modes = calibration ? ['no-preference'] : ['no-preference', 'reduce'];
const count = calibration ? 1 : 10;
const suffix = timingControl ? '-timing-control' : geometryControl ? '-reservation-control' : '';
try {
  for (const reducedMotion of modes) {
    for (const [kind, idle, pending] of cases) {
      for (let run = 0; run < count; run++) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion });
        page.on('pageerror', (error) => {
          throw error;
        });
        await page.goto(`${process.env.BASE_URL}/?kind=${kind}`);
        if (kind === 'relaunch') {
          await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
          await page.getByRole('button', { name: 'Download & install 9.0.0', exact: true }).click();
        }
        const button = page.getByRole('button', { name: idle, exact: true });
        await button.waitFor();
        await button.focus();
        if (geometryControl)
          await button.evaluate((control) => control.querySelectorAll('.invisible').forEach((ghost) => ghost.remove()));
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(650);
        if (!calibration && run === 0) await page.screenshot({ path: `${out}/${kind}-${reducedMotion}-idle.png` });
        await button.evaluate((control, expected) => {
          const rect = () => {
            const r = control.getBoundingClientRect();
            return [r.x, r.y, r.width, r.height];
          };
          window.__sample = { start: 0, ack: null, rectBefore: rect(), shifts: [], scrollBefore: [scrollX, scrollY] };
          const s = window.__sample;
          new PerformanceObserver((list) => {
            for (const e of list.getEntries())
              if (s.start && e.startTime >= s.start)
                s.shifts.push({ value: e.value, recent: e.hadRecentInput, at: e.startTime - s.start });
          }).observe({ type: 'layout-shift', buffered: false });
          control.addEventListener(
            'keydown',
            () => {
              s.start = performance.now();
              const check = () => {
                if (control.getAttribute('aria-label') === expected && control.getAttribute('aria-busy') === 'true') {
                  requestAnimationFrame(() => {
                    s.ack = performance.now() - s.start;
                    s.observedFocusAtAck = document.activeElement === control;
                    s.rectPending = rect();
                    s.scrollAfter = [scrollX, scrollY];
                  });
                } else requestAnimationFrame(check);
              };
              requestAnimationFrame(check);
            },
            { once: true }
          );
        }, pending);
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => window.__sample.ack !== null && window.__calls === 1);
        await page.waitForTimeout(650);
        const sample = await page.evaluate(() => ({
          ...window.__sample,
          workStart: window.__workStart - window.__sample.start,
          calls: window.__calls,
        }));
        if (timingControl) {
          assert(sample.ack > 100, `${kind} timing detector failed to catch missing paint barrier: ${sample.ack}`);
          assert(sample.workStart < sample.ack, `${kind} control did not start work before acknowledgment`);
        } else {
          assert(sample.ack <= 100, `${kind} ack ${sample.ack}`);
          assert(sample.workStart >= sample.ack, `${kind} work before acknowledgment`);
        }
        // Focus is an observation, not a native-disabled safety guard. The DOM tests
        // enforce absence of disabled with a failing mutation for all six controls.
        if (geometryControl)
          assert.notDeepEqual(sample.rectPending, sample.rectBefore, `${kind} reservation removal was not detected`);
        else assert.deepEqual(sample.rectPending, sample.rectBefore, `${kind} changed geometry`);
        assert.deepEqual(sample.scrollAfter, sample.scrollBefore);
        assert(sample.shifts.reduce((sum, e) => sum + e.value, 0) <= 0.01);
        if (!calibration && run === 0) await page.screenshot({ path: `${out}/${kind}-${reducedMotion}-pending.png` });
        // Every zero result has its own live detector control, after the recent-input exclusion window.
        await page.evaluate(() => {
          document.querySelector('[data-probe-shift]').style.height = '160px';
        });
        await page.waitForTimeout(150);
        const control = await page.evaluate(() => window.__sample.shifts);
        const controlCls = control.filter((e) => !e.recent).reduce((sum, e) => sum + e.value, 0);
        assert(controlCls > 0.01, `${kind} layout detector negative control failed: ${controlCls}`);
        samples.push({ kind, reducedMotion, run, ...sample, controlCls });
        await page.close();
      }
      console.log(`PASS ${kind} ${reducedMotion}: ${count} samples with per-sample negative controls`);
    }
  }
} finally {
  await writeFile(`${out}/samples${suffix}.json`, JSON.stringify(samples, null, 2) + '\n');
  await browser.close();
}
const median = (values) => {
  const a = [...values].sort((a, b) => a - b);
  return (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2;
};
const lines = [];
for (const reducedMotion of modes)
  for (const [kind] of cases) {
    const group = samples.filter((s) => s.kind === kind && s.reducedMotion === reducedMotion);
    lines.push(
      `${kind} ${reducedMotion}: n=${count} ack median=${median(group.map((s) => s.ack)).toFixed(2)}ms; max CLS=${Math.max(...group.map((s) => s.shifts.filter((e) => !e.recent).reduce((a, e) => a + e.value, 0))).toFixed(6)}; max raw shift=${Math.max(...group.map((s) => s.shifts.reduce((a, e) => a + e.value, 0))).toFixed(6)}; negative-control CLS min=${Math.min(...group.map((s) => s.controlCls)).toFixed(6)}; width delta=${(group[0].rectPending[2] - group[0].rectBefore[2]).toFixed(3)}px; ${calibration ? 'calibration detected' : 'geometry/scroll PASS'}; focus observation only`
    );
  }
console.log(lines.join('\n'));
await writeFile(`${out}/summary${suffix}.txt`, lines.join('\n') + '\n');
