import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createApplianceMcpServer, selfInvokeArgv, type McpDeps } from './mcp-server.js';

// The server is exercised end-to-end over an in-memory transport with a
// fake SDK client injected, so the full request → zod validation → tool
// handler → result path runs without a network, an engine binary, or an
// api-server.

type FakeClient = Record<string, (...args: unknown[]) => unknown>;

function ok<T>(data: T) {
  return Promise.resolve({ success: true as const, data });
}

function fail(message: string) {
  return Promise.resolve({ success: false as const, error: new Error(message) });
}

const ENV = {
  id: 'env-1',
  projectId: 'proj-1',
  name: 'dev',
  status: 'deployed',
  stackName: 'demo-dev',
  lastDeployedAt: '2026-07-20T00:00:00Z',
};

function baseFakeClient(): FakeClient {
  return {
    healthz: () => ok({ ok: true }),
    listProjects: () => ok([{ id: 'proj-1', name: 'demo', status: 'active' }]),
    listEnvironments: () => ok([ENV]),
    listDeployments: () =>
      ok([
        {
          id: 'dep-1',
          projectId: 'proj-1',
          environmentId: 'env-1',
          action: 'deploy',
          status: 'succeeded',
          startedAt: '2026-07-20T00:00:00Z',
          message: 'Deployed. URL: http://demo-dev.appliance.localhost:8081',
        },
      ]),
    getDeployment: (id: unknown) =>
      ok({
        id,
        action: 'deploy',
        status: 'succeeded',
        startedAt: '2026-07-20T00:00:00Z',
        message: 'Deployed. URL: http://demo-dev.appliance.localhost:8081',
      }),
    getEnvironmentHealth: () =>
      ok({
        environmentId: 'env-1',
        status: 'unhealthy',
        desiredReplicas: 1,
        readyReplicas: 0,
        restarts: 7,
        pods: [{ name: 'demo-abc', phase: 'Running', ready: false, restarts: 7, reason: 'CrashLoopBackOff' }],
      }),
    listEnvironmentWorkloads: () =>
      ok({
        deployments: [],
        services: [],
        pods: [{ name: 'demo-abc', phase: 'Running', ready: true, restartCount: 0 }],
      }),
    getPodLogs: () => ok('line one\nline two\n'),
    destroy: () => ok({ id: 'dep-9', action: 'destroy', status: 'pending', startedAt: '2026-07-20T00:00:00Z' }),
  };
}

async function connect(deps: Partial<McpDeps>, fakeClient: FakeClient = baseFakeClient()) {
  const server = createApplianceMcpServer({
    getClient: () => ({
      client: fakeClient as never,
      apiUrl: 'http://api.appliance.localhost:8081',
      profileName: 'local',
    }),
    ...deps,
  });
  const client = new Client({ name: 'spec', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function text(result: CallToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('expected a text content block');
  return first.text;
}

describe('createApplianceMcpServer', () => {
  it('lists the full tool surface', async () => {
    const client = await connect({});
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'deploy',
      'deployment_status',
      'destroy',
      'doctor',
      'health',
      'logs',
      'overview',
      'vm',
    ]);
    // Every tool must self-describe for agents that browse blind.
    for (const tool of tools) expect(tool.description?.length ?? 0).toBeGreaterThan(30);
  });

  it('overview reports profiles, reachability, and per-environment URLs', async () => {
    const client = await connect({});
    const result = (await client.callTool({ name: 'overview', arguments: {} })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(text(result));
    expect(data.server).toMatchObject({ profile: 'local', reachable: true });
    expect(data.projects).toHaveLength(1);
    expect(data.projects[0].environments[0]).toMatchObject({
      name: 'dev',
      status: 'deployed',
      url: 'http://demo-dev.appliance.localhost:8081',
    });
  });

  it('deployment_status extracts the deployed URL from the record message', async () => {
    const client = await connect({});
    const result = (await client.callTool({
      name: 'deployment_status',
      arguments: { deploymentId: 'dep-1' },
    })) as CallToolResult;
    const data = JSON.parse(text(result));
    expect(data.id).toBe('dep-1');
    expect(data.url).toBe('http://demo-dev.appliance.localhost:8081');
  });

  it('health surfaces crashloop reasons and points the agent at logs', async () => {
    const client = await connect({});
    const result = (await client.callTool({
      name: 'health',
      arguments: { project: 'demo', environment: 'dev' },
    })) as CallToolResult;
    const data = JSON.parse(text(result));
    expect(data.status).toBe('unhealthy');
    expect(data.pods[0].reason).toBe('CrashLoopBackOff');
    expect(data.hint).toContain('logs');
  });

  it('logs labels each pod section', async () => {
    const client = await connect({});
    const result = (await client.callTool({
      name: 'logs',
      arguments: { project: 'demo', environment: 'dev' },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('=== pod demo-abc (Running) ===');
    expect(text(result)).toContain('line one');
  });

  it('logs on a cloud base explains the limitation instead of a bare 409', async () => {
    const fake = baseFakeClient();
    fake.listEnvironmentWorkloads = () => fail('409 Conflict');
    const client = await connect({}, fake);
    const result = (await client.callTool({
      name: 'logs',
      arguments: { project: 'demo', environment: 'dev' },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Kubernetes-driven bases');
  });

  it('unknown environment names fail with the available remediation', async () => {
    const client = await connect({});
    const result = (await client.callTool({
      name: 'health',
      arguments: { project: 'demo', environment: 'nope' },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Environment not found: demo/nope');
  });

  it('destroy refuses without confirm: true', async () => {
    const client = await connect({});
    const result = (await client.callTool({
      name: 'destroy',
      arguments: { project: 'demo', environment: 'dev', confirm: false },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('confirm: true');
  });

  it('doctor merges preflight checks and runtime findings with remediations', async () => {
    const client = await connect({
      runPreflight: async () => ({
        ok: false,
        results: [
          { id: 'port:8081', label: 'port 8081 free', status: 'fail', detail: 'in use', remediation: 'free it' },
        ],
      }),
      runRuntimeDoctor: async () => ({
        vm: 'appliance',
        ok: true,
        findings: [{ id: 'auth:key', title: 'api key', severity: 'ok' }],
        fixes: [],
        serverVersion: 'v1.52.0',
      }),
    });
    const result = (await client.callTool({ name: 'doctor', arguments: {} })) as CallToolResult;
    const data = JSON.parse(text(result));
    expect(data.ok).toBe(false);
    expect(data.preflight[0]).toMatchObject({ id: 'port:8081', status: 'fail', remediation: 'free it' });
    expect(data.runtime[0]).toMatchObject({ id: 'auth:key', severity: 'ok' });
    expect(data.hint).toContain('doctor --fix');
  });

  it('vm routes actions through self-invocation and flags failures', async () => {
    const calls: string[][] = [];
    const client = await connect({
      selfInvoke: (args) => {
        calls.push(args);
        return { status: args[1] === 'stop' ? 1 : 0, output: `ran ${args.join(' ')}` };
      },
    });
    const up = (await client.callTool({ name: 'vm', arguments: { action: 'up' } })) as CallToolResult;
    expect(up.isError).toBeFalsy();
    expect(text(up)).toBe('ran vm up --name appliance');

    const stop = (await client.callTool({ name: 'vm', arguments: { action: 'stop' } })) as CallToolResult;
    expect(stop.isError).toBe(true);
    expect(calls).toEqual([
      ['vm', 'up', '--name', 'appliance'],
      ['vm', 'stop', '--name', 'appliance'],
    ]);
  });

  it('credential failures come back as guidance, not protocol errors', async () => {
    const server = createApplianceMcpServer({
      getClient: () => {
        throw new Error('Not logged in — no credentials for the active profile.');
      },
    });
    const client = new Client({ name: 'spec', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const result = (await client.callTool({
      name: 'health',
      arguments: { project: 'demo', environment: 'dev' },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Not logged in');
    // remediationHint appends the actionable next step.
    expect(text(result)).toContain('appliance login');
  });
});

describe('selfInvokeArgv', () => {
  it('drops the script slot under node', () => {
    expect(selfInvokeArgv(['/usr/bin/node', '/repo/dist/appliance.js', 'mcp'])).toEqual({
      command: '/usr/bin/node',
      prefix: ['/repo/dist/appliance.js'],
    });
  });

  it('re-invokes the bare binary for bun standalone builds (both entry shapes)', () => {
    expect(selfInvokeArgv(['C:\\bin\\appliance.exe', 'B:/~BUN/root/appliance', 'mcp'])).toEqual({
      command: 'C:\\bin\\appliance.exe',
      prefix: [],
    });
    expect(selfInvokeArgv(['/usr/local/bin/appliance', '/$bunfs/root/appliance', 'mcp'])).toEqual({
      command: '/usr/local/bin/appliance',
      prefix: [],
    });
    expect(selfInvokeArgv(['/usr/local/bin/appliance', '/usr/local/bin/appliance', 'mcp'])).toEqual({
      command: '/usr/local/bin/appliance',
      prefix: [],
    });
  });
});
