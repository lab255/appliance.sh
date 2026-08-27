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
    .filter((line) => /^  [a-z]/.test(line))
    .map((line) => line.trim().split(/\s+/, 1)[0]);
}

describe('appliance umbrella routing', () => {
  it('groups top-level help by product surface', () => {
    const result = appliance('--help');
    expect(result.status).toBe(0);
    expect(
      result.stdout
        .split('\n')
        .filter((line) => ['Runtime:', 'Builder:', 'Cluster & Machine:', 'Agents:', 'Account:'].includes(line))
    ).toMatchInlineSnapshot(`
      [
        "Runtime:",
        "Builder:",
        "Cluster & Machine:",
        "Agents:",
        "Account:",
      ]
    `);
    expect(result.stdout).toContain('install       install the linked (or named) target to a selected cluster');
    expect(result.stdout).toContain(
      'deploy        deploy the linked (or named) target using the selected/active cluster'
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
    expect(appliance('builder', 'open', '--help').stdout).toBe(appliance('open', '--help').stdout);
    expect(appliance('list', '--help').stdout).toBe(appliance('app', 'list', '--help').stdout);
  });

  it('routes runtime aliases to the shared exit-2 stub', () => {
    const namespaced = appliance('runtime', 'run');
    const aliased = appliance('run');
    expect(namespaced.status).toBe(2);
    expect(aliased.status).toBe(2);
    expect(namespaced.stderr).toBe('appliance runtime run: coming in a later release\n');
    expect(aliased.stderr).toBe(namespaced.stderr);
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
});
