import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function appliance(...args: string[]) {
  return spawnSync('bun', ['src/appliance.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, COLUMNS: '100', NO_COLOR: '1' },
  });
}

function listedVerbs(output: string): string[] {
  return output
    .split('\n')
    .filter((line) => /^ {2}[a-z]/.test(line))
    .map((line) => line.trim().split(/\s+/, 1)[0]);
}

describe('appliance umbrella routing', () => {
  it('groups top-level help by product surface', () => {
    const result = appliance('--help');
    expect(result.status).toBe(0);
    expect(
      result.stdout
        .split('\n')
        .filter((line) => ['Builder:', 'Cluster & machine:', 'Agents:', 'Account:', 'Runtime:'].includes(line))
    ).toMatchInlineSnapshot(`
      [
        "Builder:",
        "Cluster & machine:",
        "Agents:",
        "Account:",
        "Runtime:",
      ]
    `);
    expect(result.stdout).toContain(
      'install       install the linked (or named) project to the local VM cluster (--cluster <name> to override)'
    );
    expect(result.stdout).toContain(
      'deploy        deploy the linked (or named) project to the active cluster (see `appliance cluster`; usually cloud)'
    );
    expect(result.stdout).not.toContain('cloud-install');
  });

  it('lists only Builder verbs in builder help', () => {
    const result = appliance('builder', '--help');
    expect(result.status).toBe(0);
    expect(listedVerbs(result.stdout)).toMatchInlineSnapshot(`
      [
        "build",
        "configure",
        "deploy",
        "deployment",
        "destroy",
        "dev",
        "down",
        "env",
        "init",
        "install",
        "link",
        "logs",
        "manifest",
        "open",
        "package",
        "shell",
        "stack",
        "test",
        "unlink",
        "up",
      ]
    `);
  });

  it('lists all Runtime verbs in runtime help', () => {
    const result = appliance('runtime', '--help');
    expect(result.status).toBe(0);
    expect(listedVerbs(result.stdout)).toMatchInlineSnapshot(`
      [
        "run",
        "install",
        "uninstall",
        "list",
        "ps",
        "stop",
        "logs",
        "open",
        "search",
        "entitlements",
      ]
    `);
    expect(result.stdout).toContain('Container run/ps/stop/logs are available');
  });

  it('resolves Builder and existing shortcut aliases without changing command help', () => {
    expect(appliance('builder', 'build', '--help').stdout).toBe(appliance('build', '--help').stdout);
    expect(appliance('builder', 'package', '--help').stdout).toBe(appliance('package', '--help').stdout);
    expect(appliance('builder', 'install', '--help').stdout).toBe(appliance('install', '--help').stdout);
    expect(appliance('builder', 'open', '--help').stdout).toBe(appliance('open', '--help').stdout);
    expect(appliance('list', '--help').stdout).toBe(appliance('app', 'list', '--help').stdout);
  });

  it('routes cloud baseline-update and documents the scoped/admin escape hatch', () => {
    const result = appliance('cloud', 'baseline-update', '--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--system-role-mode <mode>');
    expect(result.stdout).toContain('scoped or admin');
    expect(result.stdout).toContain('--yes');
  });

  it('documents signed cloud update, follow, JSON timing, and local break glass', () => {
    const result = appliance('cloud', 'update', '--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/signed in-server self-update\s+route/);
    expect(result.stdout).toContain('--version <version>');
    expect(result.stdout).toContain('--follow <jobId>');
    expect(result.stdout).toContain('--json');
    expect(result.stdout).toContain('--local');
    expect(result.stdout).toContain('--policy <policy>');
    expect(result.stdout).toContain('--check-now');
    expect(result.stdout).toContain('checked ~daily');
    expect(result.stdout).toContain('off, notify, or auto');
    expect(result.stdout).toContain('break glass');
  });

  it('rejects JSON for the local path because it has no server job record', () => {
    const result = appliance('cloud', 'update', '--local', '--json');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--local has no job record; omit --json');
    expect(result.stderr).not.toContain('at run');
  });

  it('validates the scheduled cloud update policy before profile or AWS access', () => {
    const invalid = appliance('cloud', 'update', '--policy', 'always');
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('--policy must be off, notify, or auto');

    const mixed = appliance('cloud', 'update', '--policy', 'notify', '--json');
    expect(mixed.status).toBe(1);
    expect(mixed.stderr).toContain('--policy cannot be combined');

    const checkMixed = appliance('cloud', 'update', '--check-now', '--json');
    expect(checkMixed.status).toBe(1);
    expect(checkMixed.stderr).toContain('--check-now cannot be combined');
  });

  it('requires explicit confirmation before restoring AdministratorAccess', () => {
    const result = appliance('cloud', 'baseline-update', '--system-role-mode', 'admin');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('AdministratorAccess break-glass mode requested');
    expect(result.stderr).toContain('Restore with: appliance cloud baseline-update --system-role-mode scoped');
    expect(result.stderr).toContain('without --yes confirmation');
  });

  it('routes implemented runtime aliases to the shared command implementation', () => {
    const namespaced = appliance('runtime', 'run');
    const aliased = appliance('run');
    expect(namespaced.status).toBe(2);
    expect(aliased.status).toBe(2);
    expect(namespaced.stderr).toContain('Usage: appliance runtime run <path-to-app.appliance.zip>');
    expect(aliased.stderr).toBe(namespaced.stderr);

    const namespacedHelp = appliance('runtime', 'run', '--help');
    const aliasedHelp = appliance('run', '--help');
    expect(namespacedHelp.status).toBe(0);
    expect(aliasedHelp.status).toBe(0);
    expect(namespacedHelp.stdout).toContain('Usage: appliance runtime run <path-to-app.appliance.zip>');
    expect(aliasedHelp.stdout).toBe(namespacedHelp.stdout);
  });

  it('rejects unknown runtime commands', () => {
    const result = appliance('runtime', 'bogus');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown runtime command: bogus');
  });

  it('keeps runtime install separate from cluster-defaulting top-level install', () => {
    const runtime = appliance('runtime', 'install');
    expect(runtime.status).toBe(1);
    expect(runtime.stderr).toContain('Usage: appliance runtime install <path|https-url>');

    const installHelp = appliance('install', '--help');
    const deployHelp = appliance('deploy', '--help');
    expect(installHelp.status).toBe(0);
    expect(installHelp.stdout).toContain('defaults to local');
    expect(installHelp.stdout).toContain('--cluster <name>');
    expect(deployHelp.stdout).toContain('usually cloud');
    expect(deployHelp.stdout).not.toContain('--cluster <name>');
  });

  it('rejects conflicting install cluster selectors before deployment', () => {
    const result = appliance('install', '--cluster', 'staging', '--profile', 'production');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Provide either --cluster or --profile, not both.');
  });
});
