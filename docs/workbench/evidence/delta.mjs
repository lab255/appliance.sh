import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const { chromium } = createRequire(process.env.PLAYWRIGHT_NODE_MODULES + '/package.json')('playwright-core');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
const origin = process.env.APP_ORIGIN;
const out = process.env.EVIDENCE_DIR;
const directory = '/Users/dev/projects/demo-node-container';
const detail = `/workbench/${encodeURIComponent(directory)}`;
const results = [];
async function page(motion) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: motion });
  await p.addInitScript(() => {
    window.shifts = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries())
        window.shifts.push({ value: e.value, input: e.hadRecentInput, time: e.startTime });
    }).observe({ type: 'layout-shift', buffered: true });
    const real = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
      if (url.origin !== location.origin) {
        const body = url.pathname.endsWith('/keys/self')
          ? { id: 'fixture', name: 'Fixture', role: 'admin' }
          : url.pathname.endsWith('/cluster-info')
            ? { serverVersion: '1.62.0', baseConfig: { kubernetes: {} }, capabilities: { uploadBuilds: true } }
            : [];
        return Promise.resolve(
          new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
        );
      }
      return real(input, init);
    };
  });
  return p;
}
const url = (path, fixture) => `${origin}${path}?mock-host&scenario=developer-mode&workbench-fixture=${fixture}`;
for (const motion of ['no-preference', 'reduce']) {
  for (let run = 0; run < 10; run++) {
    const p = await page(motion);
    await p.goto(url(detail, 'save-error-bound'));
    await p.locator('#workbench-target').waitFor();
    // Exercise the existing global switcher before failing a workspace-only save.
    await p.getByRole('button', { name: 'Select target', exact: true }).click();
    await p.getByRole('menuitemradio', { name: /Dev Machine/ }).click();
    await p.waitForFunction(
      () => JSON.parse(sessionStorage.getItem('mock-host:clusters')).selectedClusterId === 'microvm'
    );
    if ((await p.locator('#workbench-target').inputValue()) !== 'mock-acme-prod')
      throw Error('Global switch changed workspace target');
    await p.waitForTimeout(150);
    await p.evaluate(() => {
      window.beforeSave = performance.now();
    });
    await p.locator('#workbench-target').selectOption('microvm');
    await p.getByRole('alert').waitFor();
    await p.waitForTimeout(100);
    const record = {
      motion,
      run,
      previousWorkspaceTargetRetained: (await p.locator('#workbench-target').inputValue()) === 'mock-acme-prod',
      globalTargetRetained: await p.evaluate(
        () => JSON.parse(sessionStorage.getItem('mock-host:clusters')).selectedClusterId === 'microvm'
      ),
      stayedOnDetail: new URL(p.url()).pathname === detail,
      ...(await p.evaluate(() => ({
        shifts: window.shifts,
        saveShifts: window.shifts.filter((s) => s.time >= window.beforeSave),
      }))),
    };
    if (!record.previousWorkspaceTargetRetained || !record.globalTargetRetained || !record.stayedOnDetail)
      throw Error('Target isolation failed');
    if (!run) await p.screenshot({ path: `${out}/delta-save-error-${motion}.png` });
    results.push(record);
    await p.close();
  }
  const p = await page(motion);
  await p.goto(url(detail, 'populated'));
  await p.locator('#workbench-target').selectOption('mock-acme-prod');
  await p.getByText('Applies to this workspace only.', { exact: true }).waitFor();
  if ((await p.evaluate(() => JSON.parse(sessionStorage.getItem('mock-host:clusters')).selectedClusterId)) !== null)
    throw Error('Workspace save changed global target');
  await p.getByRole('button', { name: 'Select target', exact: true }).click();
  await p.getByRole('menuitemradio', { name: /Dev Machine/ }).click();
  await p.waitForFunction(
    () => JSON.parse(sessionStorage.getItem('mock-host:clusters')).selectedClusterId === 'microvm'
  );
  if ((await p.locator('#workbench-target').inputValue()) !== 'mock-acme-prod')
    throw Error('Global save changed workspace target');
  results.push({
    motion,
    scenario: 'both-success-paths',
    workspaceTarget: await p.locator('#workbench-target').inputValue(),
    globalTarget: 'microvm',
    stayedOnDetail: new URL(p.url()).pathname === detail,
  });
  for (const [path, fixture] of [
    [detail, 'corrupt-binding'],
    ['/workbench', 'corrupt-binding'],
    ['/workbench', 'corrupt-index'],
    [detail, 'corrupt-save'],
  ]) {
    await p.goto(url(path, fixture));
    if (fixture === 'corrupt-save') {
      await p.locator('#workbench-target').selectOption('microvm');
    }
    await p.getByRole('alert').waitFor();
    const message = await p.getByRole('alert').innerText();
    if (!message.includes('is unreadable (EOF') || !message.includes('Your project and deploy link are not affected.'))
      throw Error(message);
    results.push({ motion, path, fixture, message });
    if (path === '/workbench' && fixture === 'corrupt-binding') {
      await p.getByRole('button', { name: 'Remove from Workbench', exact: true }).click();
      await p
        .getByText('No workspaces yet. Open a project folder or start with a blank folder.', { exact: true })
        .waitFor();
      results.push({ motion, scenario: 'dead-row-removed', passed: true });
    }
  }
  await p.goto(url('/workbench', 'corrupt-binding'));
  await p.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await p.getByRole('dialog').getByRole('button', { name: 'Open existing project', exact: true }).click();
  await p.getByRole('dialog').getByRole('alert').waitFor();
  results.push({
    motion,
    scenario: 'open-dialog',
    message: await p.getByRole('dialog').getByRole('alert').innerText(),
  });
  await p.close();
}
writeFileSync(`${out}/delta.json`, JSON.stringify(results, null, 2));
await browser.close();
