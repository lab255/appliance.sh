import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const { chromium } = createRequire(process.env.PLAYWRIGHT_NODE_MODULES + '/package.json')('playwright-core');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.addInitScript(() => {
  sessionStorage.setItem(
    'mock-host:clusters',
    JSON.stringify({
      clusters: [
        {
          id: 'mock-cloud',
          name: 'Acceptance cloud',
          apiServerUrl: 'https://acceptance.example',
          createdAt: '2026-11-17T00:00:00Z',
          apiKey: { id: 'fixture', secret: 'fixture' },
        },
      ],
      selectedClusterId: 'mock-cloud',
    })
  );
  const real = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://acceptance.example')) {
      const body = url.includes('keys/self')
        ? { id: 'fixture', name: 'Fixture', role: 'admin' }
        : url.includes('cluster-info')
          ? { serverVersion: '1.62.0', baseConfig: { aws: {} }, capabilities: { uploadBuilds: true } }
          : [];
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      );
    }
    return real(input, init);
  };
});
await page.goto(
  (process.env.APP_ORIGIN || 'http://localhost:1450') + '/projects/deploy?mock-host&scenario=developer-mode'
);
await page.getByRole('button', { name: 'Deploy to Acceptance cloud', exact: true }).click();
await page.getByText('Review this deploy', { exact: true }).waitFor();
await page.getByRole('button', { name: 'Deploy to Acceptance cloud / production', exact: true }).click();
await page
  .getByText('Deployed at https://demo-node-container.mock.appliance.sh', { exact: true })
  .waitFor({ timeout: 20000 });
writeFileSync(
  (process.env.EVIDENCE_DIR || '/tmp/workbench-evidence') + '/deploy-success.txt',
  await page.locator('body').innerText()
);
await page.screenshot({ path: (process.env.EVIDENCE_DIR || '/tmp/workbench-evidence') + '/deploy-success.png' });
await browser.close();
