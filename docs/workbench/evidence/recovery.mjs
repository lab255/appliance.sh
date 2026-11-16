import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const { chromium } = createRequire(process.env.PLAYWRIGHT_NODE_MODULES + '/package.json')('playwright-core');
const out = process.env.EVIDENCE_DIR || '/tmp/workbench-evidence';
const b = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
const results = [];
for (const motion of ['no-preference', 'reduce']) {
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: motion });
  await p.addInitScript(() => {
    window.shifts = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.shifts.push({ value: e.value, input: e.hadRecentInput });
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await p.goto(
    (process.env.APP_ORIGIN || 'http://localhost:1450') +
      '/workbench/' +
      encodeURIComponent('/Users/dev/projects/' + 'long-directory-name-'.repeat(8)) +
      '?mock-host&scenario=developer-mode&workbench-fixture=save-error'
  );
  await p.locator('#workbench-target option[value="microvm"]').waitFor({ state: 'attached' });
  await p.locator('#workbench-target').selectOption('microvm');
  await p.getByRole('alert').waitFor();
  const result = {
    motion,
    oldTargetRetained: (await p.locator('#workbench-target').inputValue()) === '',
    globalTargetUnchanged: await p.evaluate(
      () => JSON.parse(sessionStorage.getItem('mock-host:clusters')).selectedClusterId === null
    ),
    shifts: await p.evaluate(() => window.shifts),
  };
  await p.screenshot({ path: `${out}/s2-target-error-${motion}.png` });
  await p.getByRole('tab', { name: 'Files', exact: true }).focus();
  await p.keyboard.press('ArrowRight');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(100);
  result.keyboardTab = await p.getByRole('tab', { name: 'Logs', exact: true }).getAttribute('aria-selected');
  await p.evaluate(() => (document.documentElement.style.zoom = '2'));
  await p.screenshot({ path: `${out}/s2-zoom-${motion}.png` });
  result.zoomOverflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  await p.evaluate(() => (document.documentElement.style.zoom = '1'));
  await p.setViewportSize({ width: 390, height: 844 });
  await p.screenshot({ path: `${out}/s2-narrow-${motion}.png` });
  result.narrowOverflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  results.push(result);
  await p.close();
}
writeFileSync(`${out}/recovery.json`, JSON.stringify(results, null, 2));
await b.close();
