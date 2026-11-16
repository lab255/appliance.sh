import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const out = process.env.EVIDENCE_DIR;
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
const results = [];
const cases = (process.env.CASES || 'cluster-switch,cold-role-pending,cold-host-stall,footer-arrival').split(',');
function cls(shifts) {
  let start = 0,
    last = 0,
    score = 0,
    max = 0;
  for (const s of shifts.filter((s) => !s.hadRecentInput)) {
    if (!last || s.time - last > 1000 || s.time - start > 5000) {
      start = s.time;
      score = 0;
    }
    last = s.time;
    score += s.value;
    max = Math.max(max, score);
  }
  return max;
}
for (const motion of ['no-preference', 'reduce'])
  for (const name of cases)
    for (let sample = 0; sample < 10; sample++) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        colorScheme: 'dark',
        reducedMotion: motion,
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript(
        ({ name }) => {
          window.audit = { shifts: [], inputs: [], nav: [], calls: [], roles: [] };
          new PerformanceObserver((list) => {
            for (const e of list.getEntries())
              window.audit.shifts.push({
                time: e.startTime,
                value: e.value,
                hadRecentInput: e.hadRecentInput,
                sources: e.sources.map((s) => ({
                  node: s.node?.outerHTML?.slice(0, 350),
                  before: s.previousRect.toJSON(),
                  after: s.currentRect.toJSON(),
                })),
              });
          }).observe({ type: 'layout-shift', buffered: true });
          for (const type of ['pointerdown', 'click', 'keydown'])
            addEventListener(
              type,
              (e) =>
                window.audit.inputs.push({ type, time: performance.now(), target: e.target.outerHTML?.slice(0, 150) }),
              true
            );
          function frame() {
            const nav = document.querySelector('nav');
            if (nav) {
              const visible = getComputedStyle(nav).visibility === 'visible';
              if (window.audit.nav.at(-1)?.visible !== visible)
                window.audit.nav.push({ time: performance.now(), visible });
            }
            requestAnimationFrame(frame);
          }
          requestAnimationFrame(frame);
          if (name === 'footer-arrival') return;
          const clusters = ['A', 'B', 'C'].map((id) => ({
            id,
            name: `Cluster ${id}`,
            apiServerUrl: `https://cluster-${id.toLowerCase()}.test`,
            createdAt: '2026-01-01T00:00:00Z',
          }));
          let selected = 'A';
          window.releaseRole = {};
          const originalFetch = window.fetch.bind(window);
          window.fetch = async (input, options) => {
            const url = String(input);
            if (!url.includes('.test/')) return originalFetch(input, options);
            if (url.endsWith('/keys/self')) {
              const id = new URL(url).hostname.split('-')[1].split('.')[0].toUpperCase();
              const record = { id, start: performance.now() };
              window.audit.roles.push(record);
              if (id !== 'A' || name === 'cold-role-pending')
                await new Promise((resolve) => (window.releaseRole[id] = resolve));
              record.end = performance.now();
              return new Response(JSON.stringify({ id: 'fixture-key', role: 'admin' }), { status: 200 });
            }
            if (url.endsWith('/cluster-info'))
              return new Response(JSON.stringify({ version: '1.62.0', baseConfig: {} }), { status: 200 });
            return new Response(JSON.stringify([]), { status: 200 });
          };
          window.__TAURI_INTERNALS__ = {
            transformCallback: () => 1,
            invoke: async (cmd, args) => {
              window.audit.calls.push({ cmd, time: performance.now() });
              if (cmd === 'host_platform') return 'macos';
              await new Promise((r) =>
                setTimeout(r, name === 'cold-host-stall' && ['get_app_mode', 'get_config'].includes(cmd) ? 2500 : 100)
              );
              if (cmd === 'get_app_mode') return 'developer';
              if (cmd === 'get_config')
                return name === 'cold-host-stall'
                  ? { clusters: [], selectedClusterId: null, apiKey: null }
                  : { clusters, selectedClusterId: selected, apiKey: { id: 'fixture-key', secret: 'fixture-secret' } };
              if (cmd === 'select_cluster') {
                selected = args.clusterId;
                return;
              }
              if (['microvm_list', 'runtime_installed_list'].includes(cmd)) return [];
              if (cmd === 'plugin:event|listen') return 1;
              throw Error('Unexpected IPC ' + cmd);
            },
          };
        },
        { name }
      );
      await page.goto(
        (process.env.APP_URL || 'http://localhost:1435') +
          (name === 'footer-arrival' ? '/apps?mock-host&scenario=developer-mode' : '/apps')
      );
      await page.waitForTimeout(3200);
      let actionStart = 0,
        footerGeometry;
      if (name === 'cluster-switch') {
        for (const id of ['B', 'C']) {
          await page.locator('#root header').first().getByRole('button').click();
          await page.getByRole('menuitemradio', { name: new RegExp(`Cluster ${id}`) }).click();
          await page.waitForFunction((id) => window.audit.roles.some((r) => r.id === id && !r.end), id);
          if (!actionStart) actionStart = await page.evaluate(() => performance.now());
          await page.waitForTimeout(1500);
          if (!(await page.locator('nav').isVisible())) throw Error('Navigation hid during role lookup');
          await page.evaluate((id) => window.releaseRole[id](), id);
          await page.waitForTimeout(200);
        }
      } else if (name === 'cold-role-pending') {
        if (!(await page.evaluate(() => window.audit.roles.some((r) => r.id === 'A' && !r.end))))
          throw Error('Role was not pending');
        if (!(await page.locator('nav').isVisible())) throw Error('Pending role hides cold nav');
        await page.evaluate(() => window.releaseRole.A());
      } else if (name === 'footer-arrival') {
        await page.evaluate(() => {
          window.footer = document.querySelector('aside').lastElementChild;
          window.footer.remove();
        });
        await page.waitForTimeout(700);
        footerGeometry = await page.evaluate(() => ({
          before: [...document.querySelectorAll('nav a')].map((n) => n.getBoundingClientRect().toJSON()),
          footerHeight: window.footer.getBoundingClientRect().height,
        }));
        actionStart = await page.evaluate(() => {
          const time = performance.now();
          document.querySelector('aside').append(window.footer);
          return time;
        });
        await page.waitForTimeout(700);
        footerGeometry.after = await page.evaluate(() =>
          [...document.querySelectorAll('nav a')].map((n) => n.getBoundingClientRect().toJSON())
        );
        footerGeometry.footerHeight = await page.evaluate(() => window.footer.getBoundingClientRect().height);
      }
      const audit = await page.evaluate(() => window.audit);
      const shifts = name === 'footer-arrival' ? audit.shifts.filter((s) => s.time >= actionStart) : audit.shifts;
      const hiddenAgain = audit.nav.slice(audit.nav.findIndex((n) => n.visible) + 1).some((n) => !n.visible);
      if (hiddenAgain) throw Error('Revealed navigation hid again');
      if (sample === 0) await page.screenshot({ path: `${out}/${name}-${motion}.png` });
      results.push({
        name,
        motion,
        sample,
        cls: cls(shifts),
        actionCls: cls(audit.shifts.filter((s) => s.time >= actionStart)),
        hiddenAgain,
        hideDurationMs: audit.nav[0]?.visible ? 0 : audit.nav.find((n) => n.visible)?.time - audit.nav[0]?.time,
        actionStart,
        footerGeometry,
        ...audit,
        errors,
      });
      await context.close();
      writeFileSync(
        `${out}/reveal.json`,
        JSON.stringify({ viewport: [1440, 1000], browser: browser.version(), results }, null, 2)
      );
      console.log(name, motion, sample, results.at(-1).cls, results.at(-1).hideDurationMs);
    }
await browser.close();
