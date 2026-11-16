import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const out = process.env.EVIDENCE_DIR || fileURLToPath(new URL('./', import.meta.url));
mkdirSync(out, { recursive: true });
const phase = process.argv[2] || 'before';
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
const scenarios = [
  ['developer-apps', '/apps?mock-host&scenario=developer-mode'],
  ['developer-settings', '/settings?mock-host&scenario=developer-mode'],
  ['machine-daemon-down', '/machine?mock-host&scenario=daemon-down'],
  ['stale-catalogue', '/catalogue?mock-host&scenario=catalogue-stale'],
  ['unverified-catalogue', '/catalogue?mock-host&scenario=catalogue-unverified'],
  ['user-ipc', '/apps'],
  ['vm-lost-ipc', '/machine'],
];
const results = [];
for (const reducedMotion of ['no-preference', 'reduce'])
  for (const [name, path] of scenarios.filter(
    ([name]) => !process.env.SCENARIOS || process.env.SCENARIOS.split(',').includes(name)
  )) {
    for (let sample = 0; sample < 10; sample++) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        deviceScaleFactor: 1,
        colorScheme: 'dark',
        reducedMotion,
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));

      const extraNav = Number(process.env.EXTRA_NAV || 0);

      if (extraNav) {
        await page.route('**/packages/app/dist/index-*.js', async (route) => {
          const response = await route.fetch();
          let body = await response.text();
          const marker = '{ key: "projects", to: "/projects", label: "Projects" },';
          if (body.includes(marker)) {
            const rows = Array.from(
              { length: extraNav },
              (_, i) => `{ key: "projects", to: "/stress-${i}", label: "Workbench fixture ${i}" },`
            ).join('\n');
            body = body.replace(marker, marker + rows);
          }
          await route.fulfill({ response, body });
        });
      }
      await page.addInitScript(
        ({ ipc, mode }) => {
          window.shifts = [];
          window.inputs = [];
          window.headers = [];
          new PerformanceObserver((list) => {
            for (const e of list.getEntries())
              window.shifts.push({
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
          for (const type of ['pointerdown', 'keydown', 'click'])
            addEventListener(
              type,
              (e) => window.inputs.push({ type, time: performance.now(), target: e.target.outerHTML?.slice(0, 150) }),
              true
            );
          const timer = setInterval(() => {
            const h = document.querySelector('#root header');
            if (h) {
              const height = h.getBoundingClientRect().height;
              if (window.headers.at(-1)?.height !== height)
                window.headers.push({ time: performance.now(), height, text: h.textContent });
            }
          }, 5);
          setTimeout(() => clearInterval(timer), 4500);
          if (ipc)
            window.__TAURI_INTERNALS__ = {
              invoke: async (cmd) => {
                if (cmd === 'host_platform') return 'macos';
                await new Promise((r) => setTimeout(r, 100));
                if (cmd === 'get_config') return { clusters: [], selectedClusterId: null, apiKey: null };
                if (cmd === 'get_app_mode') return mode;
                if (cmd === 'microvm_status')
                  return {
                    available: true,
                    installable: false,
                    exists: false,
                    running: false,
                    clusterProvisioned: false,
                    kubeconfigReady: false,
                    controlPlaneUpdateCapable: false,
                    selfUpdateEnabled: false,
                    dev: false,
                    apiServerUrl: '',
                  };
                if (['microvm_list', 'runtime_installed_list'].includes(cmd)) return [];
                if (cmd === 'plugin:event|listen') return 1;
                throw Error('Unimplemented IPC ' + cmd);
              },
              transformCallback: () => 1,
            };
        },
        { ipc: name.endsWith('-ipc'), mode: name === 'user-ipc' ? 'user' : 'developer' }
      );
      await page.goto((process.env.APP_URL || 'http://localhost:1435') + path);
      await page.waitForTimeout(2200);

      if (
        phase.startsWith('after') &&
        !(await page
          .locator('#root header')
          .first()
          .evaluate((el) => el.classList.contains('min-h-[calc(1lh+var(--spacing)*9+3px)]')))
      ) {
        throw Error('Served bundle is stale: expected reserved shell header');
      }
      if (extraNav && (await page.getByTitle(/^Workbench fixture/).count()) !== extraNav)
        throw Error('Stress nav injection failed');

      if (name === 'vm-lost-ipc') await page.getByText('Not created', { exact: true }).waitFor();
      const geometry = await page
        .locator('#root header')
        .first()
        .evaluate((header) => {
          function box(el) {
            if (!el) return null;
            const style = getComputedStyle(el);
            return {
              height: el.getBoundingClientRect().height,
              minHeight: style.minHeight,
              fontSize: style.fontSize,
              lineHeight: style.lineHeight,
              paddingTop: style.paddingTop,
              paddingBottom: style.paddingBottom,
              borderTop: style.borderTopWidth,
              borderBottom: style.borderBottomWidth,
            };
          }
          return {
            header: box(header),
            switcher: box(header.querySelector('button')),
            spacing: getComputedStyle(header).getPropertyValue('--spacing'),
          };
        });
      const cold = await page.evaluate(() => ({ shifts: window.shifts, headers: window.headers }));
      if (sample === 0) await page.screenshot({ path: `${out}/${phase}-${name}-${reducedMotion}.png` });
      // Trusted navigation: retain raw shifts even when excluded by recent input.
      await page.locator('nav a[href="/settings"]').click();
      await page.waitForTimeout(700);
      const data = await page.evaluate(() => ({ shifts: window.shifts, inputs: window.inputs }));
      function windows(shifts) {
        const w = [];
        for (const s of shifts.filter((x) => !x.hadRecentInput)) {
          let last = w.at(-1);
          if (!last || s.time - last.last > 1000 || s.time - last.start > 5000) {
            last = { start: s.time, last: s.time, score: 0 };
            w.push(last);
          }
          last.last = s.time;
          last.score += s.value;
        }
        return w;
      }
      const sessionWindows = windows(cold.shifts);
      results.push({
        geometry,
        extraNav,
        name,
        reducedMotion,
        sample,
        cls: Math.max(0, ...sessionWindows.map((w) => w.score)),
        sessionWindows,
        ...data,
        headers: cold.headers,
        errors,
      });
      await context.close();
    }
    console.log(
      phase,
      name,
      reducedMotion,
      results.filter((r) => r.name === name && r.reducedMotion === reducedMotion).map((r) => r.cls)
    );
    writeFileSync(
      `${out}/${phase}.json`,
      JSON.stringify({ phase, viewport: [1440, 1000], browser: browser.version(), results }, null, 2)
    );
  }
await browser.close();
