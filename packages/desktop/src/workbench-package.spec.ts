import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '../../..');
const source = (path: string) => readFileSync(resolve(repo, path), 'utf8');

it('keeps the eight existing MCP registrations unchanged and excludes authoring actions', () => {
  const mcp = source('packages/cli/src/utils/mcp-server.ts');
  const tools = [...mcp.matchAll(/server\.registerTool\(\s*'([^']+)'/g)].map((match) => match[1]);
  expect(tools).toEqual(['overview', 'deploy', 'deployment_status', 'health', 'logs', 'destroy', 'doctor', 'vm']);
  expect(mcp).not.toMatch(/workbench_package|workbenchPackage|builder.*package/);
});

it('keeps the native Package command a bundled packaging-only invocation', () => {
  const bridge = source('packages/desktop/src-tauri/src/workbench_package.rs');
  expect(bridge).toContain('.sidecar("appliance")');
  expect(bridge).toContain('"builder".to_string()');
  expect(bridge).toContain('"package".into()');
  expect(bridge).not.toMatch(
    /runtime_install|deploy_to_cloud|package_and_upload|registerTool|agents\.json|agent-results/
  );
  expect(bridge).toContain('exit_code != Some(0)');
  expect(bridge).toContain('developer-ed25519.pem');
  expect(bridge).not.toContain('std::env::var(');
});
