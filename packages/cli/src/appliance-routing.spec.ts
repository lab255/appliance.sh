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
    expect(result.stdout).toContain('Runtime commands are coming in a later release.');
  });

  it('resolves Builder and existing shortcut aliases without changing command help', () => {
    expect(appliance('builder', 'build', '--help').stdout).toBe(appliance('build', '--help').stdout);
    expect(appliance('builder', 'install', '--help').stdout).toBe(appliance('install', '--help').stdout);
    expect(appliance('builder', 'open', '--help').stdout).toBe(appliance('open', '--help').stdout);
    expect(appliance('list', '--help').stdout).toBe(appliance('app', 'list', '--help').stdout);
  });

  it('routes runtime aliases to the shared exit-2 stub', () => {
    const namespaced = appliance('runtime', 'run');
    const aliased = appliance('run');
    expect(namespaced.status).toBe(2);
    expect(aliased.status).toBe(2);
    expect(namespaced.stderr).toContain('appliance runtime run: coming in a later release');
    expect(aliased.stderr).toBe(namespaced.stderr);

    const namespacedHelp = appliance('runtime', 'run', '--help');
    const aliasedHelp = appliance('run', '--help');
    expect(namespacedHelp.status).toBe(0);
    expect(aliasedHelp.status).toBe(0);
    expect(namespacedHelp.stdout).toContain('appliance runtime run: coming in a later release');
    expect(aliasedHelp.stdout).toBe(namespacedHelp.stdout);
  });

  it('rejects unknown runtime commands', () => {
    const result = appliance('runtime', 'bogus');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown runtime command: bogus');
  });

  it('keeps runtime install separate from cluster-defaulting top-level install', () => {
    const runtime = appliance('runtime', 'install');
    expect(runtime.status).toBe(2);
    expect(runtime.stderr).toContain('coming in a later release');

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
