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
const out = new URL('./', import.meta.url).pathname;
const results = [];
for (const motion of ['no-preference', 'reduce']) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: motion });
  page.on('pageerror', (e) => {
    throw e;
  });
  const samples = [];
  for (let run = 0; run < 10; run++) {
    await page.goto('http://localhost:1455');
    const region = page.locator('[data-package-readiness]');
    await region.waitFor();
    await region.scrollIntoViewIfNeeded();
    await page.waitForTimeout(650);
    await page.evaluate(() => {
      window.shifts = [];
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.shifts.push({ value: e.value, recentInput: e.hadRecentInput });
      }).observe({ type: 'layout-shift' });
      window.initialTop = document.querySelector('button[aria-busy]').getBoundingClientRect().top;
      window.arrivalStart = performance.now();
      window.emitProposal();
      const check = () => {
        if (document.body.innerText.includes('Agent-proposed · not approved'))
          requestAnimationFrame(() => (window.arrivalAck = performance.now() - window.arrivalStart));
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
    await page.waitForFunction(() => window.arrivalAck !== undefined);
    await page.waitForTimeout(200);
    const arrival = await page.evaluate(() => ({
      ack: window.arrivalAck,
      shifts: window.shifts,
      buttonMovement: document.querySelector('button[aria-busy]').getBoundingClientRect().top - window.initialTop,
      calls: window.packageCalls,
    }));
    const dismiss = page.getByRole('button', { name: 'Dismiss proposal', exact: true });
    await dismiss.scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss proposal');
      b.addEventListener(
        'pointerdown',
        () => {
          window.dismissStart = performance.now();
          const check = () => {
            if (document.body.innerText.includes('Stale proposal — You dismissed'))
              requestAnimationFrame(() => (window.dismissAck = performance.now() - window.dismissStart));
            else requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        },
        { once: true }
      );
    });
    await dismiss.click();
    await page.waitForFunction(() => window.dismissAck !== undefined);
    const dismissal = await page.evaluate(() => ({
      ack: window.dismissAck,
      focus: document.activeElement?.textContent,
      calls: window.packageCalls,
    }));
    const pack = page.getByRole('button', { name: 'Package', exact: true });
    await pack.scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      document.querySelector('button[aria-busy]').addEventListener(
        'pointerdown',
        () => {
          window.packageStart = performance.now();
          const check = () => {
            if (document.querySelector('button[aria-busy=true]'))
              requestAnimationFrame(() => (window.packageAck = performance.now() - window.packageStart));
            else requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        },
        { once: true }
      );
    });
    await pack.click();
    await page.waitForFunction(() => window.backendEnd !== undefined);
    const packaging = await page.evaluate(() => ({
      ack: window.packageAck,
      fixtureBackend: window.backendEnd - window.backendStart,
      calls: window.packageCalls,
    }));
    samples.push({ arrival, dismissal, packaging });
    if (run === 0) await page.screenshot({ path: out + 'stale-' + motion + '.png' });
  }
  // Negative control: remove reserve-space on the same rendered surface.
  await page.goto('http://localhost:1455');
  await page.locator('[data-package-readiness]').scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    document.querySelector('[data-package-readiness]').style.height = 'auto';
  });
  await page.waitForTimeout(650);
  await page.evaluate(() => {
    window.badShifts = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.badShifts.push({ value: e.value, recentInput: e.hadRecentInput });
    }).observe({ type: 'layout-shift' });
    window.emitProposal();
  });
  await page.waitForTimeout(300);
  const negativeControl = await page.evaluate(() => window.badShifts);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://localhost:1455');
  await page.locator('[data-package-readiness]').waitFor();
  await page.evaluate(() => window.emitProposal());
  await page.locator('[data-package-readiness]').scrollIntoViewIfNeeded();
  const narrow = await page.evaluate(() => ({
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    regionScrollable:
      document.querySelector('[data-package-readiness]').scrollHeight >
      document.querySelector('[data-package-readiness]').clientHeight,
  }));
  await page.screenshot({ path: out + 'narrow-' + motion + '.png' });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.evaluate(() => (document.body.style.zoom = '2'));
  await page.locator('[data-package-readiness]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: out + 'zoom-' + motion + '.png' });
  results.push({ motion, samples, negativeControl, narrow });
  await page.close();
}
const median = (a) => {
  a.sort((x, y) => x - y);
  return (a[4] + a[5]) / 2;
};
const summary = results.map((r) => ({
  motion: r.motion,
  count: r.samples.length,
  arrivalMedian: median(r.samples.map((s) => s.arrival.ack)),
  dismissMedian: median(r.samples.map((s) => s.dismissal.ack)),
  packageMedian: median(r.samples.map((s) => s.packaging.ack)),
  fixtureBackendMedian: median(r.samples.map((s) => s.packaging.fixtureBackend)),
  arrivalMaxRawCLS: Math.max(...r.samples.map((s) => s.arrival.shifts.reduce((n, e) => n + e.value, 0))),
  arrivalMaxStandardCLS: Math.max(
    ...r.samples.map((s) => s.arrival.shifts.filter((e) => !e.recentInput).reduce((n, e) => n + e.value, 0))
  ),
  maxButtonMovement: Math.max(...r.samples.map((s) => Math.abs(s.arrival.buttonMovement))),
  negativeControlRawCLS: r.negativeControl.reduce((n, e) => n + e.value, 0),
  zeroCallsBeforeHumanClick: r.samples.every((s) => s.arrival.calls === 0 && s.dismissal.calls === 0),
  oneCallAfterClick: r.samples.every((s) => s.packaging.calls === 1),
  focusRetained: r.samples.every((s) => s.dismissal.focus === 'Dismiss proposal'),
  narrow: r.narrow,
}));
fs.writeFileSync(
  out + 'measurements.json',
  JSON.stringify(
    {
      kind: 'Browser fixture only: real detail/PackageSection; simulated session/result/package host. No live authorization or hardware timing claim.',
      clock: 'event to second requestAnimationFrame after visible DOM; paint opportunity, not compositor pixels',
      viewport: { width: 1280, height: 1000 },
      platform: process.platform,
      summary,
      results,
    },
    null,
    2
  )
);
for (const row of summary) {
  assert(row.arrivalMedian <= 100 && row.dismissMedian <= 100 && row.packageMedian <= 100);
  assert(row.arrivalMaxRawCLS <= 0.01 && row.maxButtonMovement === 0);
  assert(row.negativeControlRawCLS > 0.01);
  assert(row.zeroCallsBeforeHumanClick && row.oneCallAfterClick && row.focusRetained);
  assert(!row.narrow.horizontalOverflow);
}
console.log(JSON.stringify(summary, null, 2));
await browser.close();
