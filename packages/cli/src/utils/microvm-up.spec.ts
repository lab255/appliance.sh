import { describe, it, expect } from 'vitest';
import { historyGuaranteesPlatformReady, renderVmStatus, type EngineVmStatus } from './microvm-up.js';

// The fast-pass decision that shrinks the CLI's load-bearing registry /
// api-server waits to quick confirmations. Two independent guards must
// BOTH hold: the engine's bring-up history shows the honest-readiness
// `ingress` phase, and the history is at least as fresh as the
// kubeconfig (an engine DOWNGRADE clears only bringup.json, so a new
// engine's history can survive, stale, next to a kubeconfig an old
// engine just wrote).
describe('historyGuaranteesPlatformReady', () => {
  const ingressHistory =
    '{"phase":"cluster-api","at":1000}\n{"phase":"ingress","detail":"in-VM registry","at":2000}\n{"phase":"ready","at":3000}\n';

  it('fast-passes when the history shows ingress and is fresher than the kubeconfig', () => {
    expect(historyGuaranteesPlatformReady(ingressHistory, 2_000, 1_000)).toBe(true);
  });

  it('fast-passes on equal mtimes (same-instant writes on coarse clocks)', () => {
    expect(historyGuaranteesPlatformReady(ingressHistory, 1_000, 1_000)).toBe(true);
  });

  it('slow-paths when the history is STALE (engine downgrade: old engine rewrote the kubeconfig, never the history)', () => {
    expect(historyGuaranteesPlatformReady(ingressHistory, 1_000, 2_000)).toBe(false);
  });

  it('slow-paths when the history never reached ingress (old engine, or a boot that died early)', () => {
    const early = '{"phase":"media","at":1000}\n{"phase":"cluster","at":2000}\n';
    expect(historyGuaranteesPlatformReady(early, 2_000, 1_000)).toBe(false);
  });

  it('slow-paths on an empty history', () => {
    expect(historyGuaranteesPlatformReady('', 2_000, 1_000)).toBe(false);
  });
});

// renderVmStatus turns the engine's status JSON into the human summary.
// Contract: every state names its next command, and the summary never
// throws on missing optional fields (older engines omit them).
describe('renderVmStatus', () => {
  const base: EngineVmStatus = {
    name: 'appliance',
    exists: true,
    running: true,
    pid: 4242,
    backend: 'wsl',
    clusterReady: true,
    hostPort: 8081,
    apiPort: 6443,
    registryPort: 5052,
  };
  const text = (s: EngineVmStatus) => renderVmStatus(s).join('\n');

  it('a ready VM shows the console URL, the app URL shape, and the dev-loop next step', () => {
    const out = text(base);
    expect(out).toContain('running');
    expect(out).toContain('http://api.appliance.localhost:8081');
    expect(out).toContain('<app>-<env>.appliance.localhost:8081');
    expect(out).toContain('appliance dev');
  });

  it('a stopped VM points at vm up / dev', () => {
    const out = text({ ...base, running: false, clusterReady: false, pid: undefined });
    expect(out).toContain('stopped');
    expect(out).toContain('appliance vm up');
  });

  it('a not-yet-created VM points at init', () => {
    const out = text({ ...base, exists: false, running: false, clusterReady: false });
    expect(out).toContain('not created yet');
    expect(out).toContain('appliance init');
  });

  it('a booting VM narrates the phase and points at the console', () => {
    const out = text({ ...base, clusterReady: false, phase: 'cluster', phaseDetail: 'importing images' });
    expect(out).toContain('starting');
    expect(out).toContain('cluster: importing images');
    expect(out).toContain('appliance vm console -f');
  });

  it('surfaces a backend availability warning without throwing on minimal payloads', () => {
    const out = text({
      name: 'appliance',
      exists: true,
      running: true,
      backend: 'wsl',
      clusterReady: true,
      message: 'WSL is not ready: kernel outdated\nsecond line',
    });
    expect(out).toContain('Warning: WSL is not ready: kernel outdated');
    expect(out).not.toContain('second line');
  });
});
