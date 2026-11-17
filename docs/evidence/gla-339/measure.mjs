import fs from 'node:fs';
import assert from 'node:assert/strict';
const { PLAYWRIGHT_MODULE, CHROMIUM_PATH, BASE_URL } = process.env;
if (!PLAYWRIGHT_MODULE || !CHROMIUM_PATH || !BASE_URL)
  throw new Error('Set PLAYWRIGHT_MODULE, CHROMIUM_PATH and BASE_URL');
const { chromium } = await import(PLAYWRIGHT_MODULE);
const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM_PATH });
const results = [];
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};
async function arm(page) {
  await page.evaluate(() => {
    window.shifts = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.shifts.push({ value: e.value, recentInput: e.hadRecentInput });
    }).observe({ type: 'layout-shift' });
    const button = document.querySelector('button');
    window.before = {
      button: button.getBoundingClientRect().toJSON(),
      anchor: document.querySelector('#anchor').getBoundingClientRect().toJSON(),
      scroll: scrollY,
    };
    button.addEventListener(
      'click',
      () => {
        if (window.clicked !== undefined) return;
        window.clicked = performance.now();
        const check = () => {
          if (button.getAttribute('aria-busy') === 'true' || button.disabled) {
            window.ack = performance.now() - window.clicked;
            window.atAck = {
              button: button.getBoundingClientRect().toJSON(),
              anchor: document.querySelector('#anchor').getBoundingClientRect().toJSON(),
              focus: document.activeElement === button,
              scroll: scrollY,
            };
          } else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      },
      { capture: true }
    );
  });
}
try {
  for (const motion of ['no-preference', 'reduce'])
    for (const icon of [false, true])
      for (const defect of [true, false]) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: motion });
        const samples = [];
        for (let run = 0; run < 10; run++) {
          await page.goto(
            BASE_URL +
              '/?' +
              new URLSearchParams({ ...(icon ? { icon: '1' } : {}), ...(defect ? { defect: '1' } : {}) })
          );
          await page.locator('button').waitFor();
          await page.waitForTimeout(100);
          await arm(page);
          await page.locator('button').focus();
          // Trusted keyboard activation, followed by a rapid second activation.
          await page.keyboard.press('Enter');
          await page.evaluate(() => document.querySelector('button').click());
          await page.waitForFunction(() => window.ack !== null && window.starts.length > 0);
          await page.waitForTimeout(400);
          const sample = await page.evaluate(() => ({
            ack: window.ack,
            starts: window.starts.map((t) => t - window.clicked),
            before: window.before,
            atAck: window.atAck,
            shifts: window.shifts,
            focusAfter: document.activeElement === document.querySelector('button'),
            busyAfter: document.querySelector('button').getAttribute('aria-busy'),
            scrollAfter: scrollY,
          }));
          sample.cls = sample.shifts.filter((s) => !s.recentInput).reduce((sum, s) => sum + s.value, 0);
          sample.rawShift = sample.shifts.reduce((sum, s) => sum + s.value, 0);
          sample.movement = Math.max(
            ...['x', 'y', 'width', 'height'].map((k) => Math.abs(sample.before.button[k] - sample.atAck.button[k])),
            Math.abs(sample.before.anchor.x - sample.atAck.anchor.x)
          );
          if (!defect) {
            assert.equal(sample.starts.length, 1);
            assert(sample.starts[0] > sample.ack);
            assert(sample.atAck.focus && sample.focusAfter);
            assert.equal(sample.movement, 0);
            assert.equal(sample.scrollAfter, sample.before.scroll);
            assert(sample.cls <= 0.01 && sample.rawShift <= 0.01);
            assert.equal(sample.busyAfter, 'false');
          }
          samples.push(sample);
        }
        const summary = {
          motion,
          icon,
          defect,
          medianAck: median(samples.map((s) => s.ack)),
          maxCLS: Math.max(...samples.map((s) => s.cls)),
          maxRawShift: Math.max(...samples.map((s) => s.rawShift)),
          samples,
        };
        if (defect) assert(summary.medianAck > 100);
        else assert(summary.medianAck <= 100);
        results.push(summary);
        console.log(JSON.stringify({ ...summary, samples: undefined }));
        await page.close();
      }
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(BASE_URL + '/?backoff=1');
  await page.locator('button').waitFor();
  await arm(page);
  await page.locator('button').click();
  await page.waitForFunction(() => document.body.innerText.includes('Read state: failed'), {}, { timeout: 15000 });
  const backoff = await page.evaluate(() => ({
    starts: window.starts,
    ack: window.ack,
    focus: document.activeElement === document.querySelector('button'),
  }));
  backoff.gaps = backoff.starts.slice(1).map((t, i) => t - backoff.starts[i]);
  // QueryFn contributes 160ms synchronous work + 180ms response delay before each retry delay.
  backoff.retryDelays = backoff.gaps.map((t) => t - 340);
  assert.equal(backoff.starts.length, 4);
  backoff.retryDelays.forEach((delay, i) => assert(Math.abs(delay - [1000, 2000, 4000][i]) < 160));
  // Independent negative controls: prove the geometry/CLS, focus and scroll probes can see regressions.
  await page.goto(BASE_URL + '/?icon=1');
  await page.locator('button').waitFor();
  await page.waitForTimeout(650);
  await arm(page);
  await page.locator('button').focus();
  await page.evaluate(() => {
    document.querySelector('button').style.width = '400px';
    document.querySelector('main').style.paddingTop = '300px';
  });
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    document.querySelector('button').blur();
    document.body.style.minHeight = '3000px';
    scrollTo(0, 200);
  });
  const negative = await page.evaluate(() => ({
    shifts: window.shifts,
    anchorDelta: document.querySelector('#anchor').getBoundingClientRect().x - window.before.anchor.x,
    focus: document.activeElement === document.querySelector('button'),
    scrollDelta: scrollY - window.before.scroll,
  }));
  assert(negative.shifts.reduce((s, e) => s + e.value, 0) > 0.01);
  assert(negative.anchorDelta > 100);
  assert(!negative.focus);
  assert(negative.scrollDelta > 0);
  fs.writeFileSync(
    new URL('./measurements.json', import.meta.url),
    JSON.stringify({ results, backoff, negative }, null, 2) + '\n'
  );
  console.log(JSON.stringify({ backoff, negative }));
} finally {
  await browser.close();
}
