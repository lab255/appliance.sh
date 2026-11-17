// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { PackageSection } from './package-section';
import type { ReadinessFixture } from '@/lib/workbench-readiness';
const proposal: ReadinessFixture = {
  source: 'fixture',
  directory: '/workspace',
  sessionId: 'agent-fixture',
  proposalId: 'ready-1',
  sessionStatus: 'done',
  summary: 'Fixture changes ready for human review.',
};
import { UNSIGNED_PACKAGE_LABEL, type WorkbenchPackageResult } from '@/lib/workbench-package';

const artifact: WorkbenchPackageResult = {
  outputPath: '/host/review.appliance.zip',
  digest: `sha256:${'a'.repeat(64)}`,
  sizeBytes: 123,
  name: 'review',
  version: '1.0.0',
  signatureStatus: 'unsigned',
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('rejects another directory at PackageSection without relying on the source hook', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = (directory: string) =>
    act(async () =>
      root.render(
        <MemoryRouter>
          <PackageSection directory="/workspace" readinessProposal={{ ...proposal, directory }} />
        </MemoryRouter>
      )
    );
  try {
    await render('/workspace');
    expect(container.textContent).toContain('Agent-proposed · not approved');
    await render('/other-workspace');
    expect(container.textContent).toContain('No structured readiness proposal.');
    expect(container.textContent).not.toContain('Agent-proposed · not approved');
  } finally {
    await act(async () => root.unmount());
  }
});

it('ignores activation of aria-disabled Dismiss and preserves the stopped-session reason', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <PackageSection directory="/workspace" readinessProposal={{ ...proposal, sessionStatus: 'stopped' }} />
        </MemoryRouter>
      )
    );
    const dismiss = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss proposal')!;
    expect(dismiss.getAttribute('aria-disabled')).toBe('true');
    // Native keyboard Enter dispatches this click; acceptance.mjs exercises the actual key.
    await act(async () => dismiss.click());
    expect(container.textContent).toContain('Stale proposal — The source session was stopped.');
    expect(container.textContent).not.toContain('You dismissed this proposal.');
  } finally {
    await act(async () => root.unmount());
  }
});

it('readiness/result updates make zero calls; only one click crosses the bridge after visible acknowledgment', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  let frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const frame = async () => {
    const next = frames;
    frames = [];
    await act(async () => next.forEach((fn) => fn(0)));
  };
  let finish!: (value: WorkbenchPackageResult) => void;
  const calls: string[] = [];
  const host = {
    package: vi.fn(() => {
      calls.push('package');
      return new Promise<WorkbenchPackageResult>((resolve) => {
        finish = resolve;
      });
    }),
    install: vi.fn(() => calls.push('install')),
    publish: vi.fn(() => calls.push('publish')),
    deploy: vi.fn(() => calls.push('deploy')),
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const fixtureProposal = proposal;
  const render = (proposal: boolean) =>
    act(async () =>
      root.render(
        <MemoryRouter>
          <PackageSection
            directory="/workspace"
            packageHost={host}
            readinessProposal={proposal ? fixtureProposal : null}
          />
        </MemoryRouter>
      )
    );
  try {
    await render(false);
    await render(true);
    await render(false);
    await render(true);
    expect(calls).toEqual([]);
    const button = container.querySelector<HTMLButtonElement>('button[aria-busy]')!;
    button.focus();
    await act(async () => {
      button.click();
      button.click();
    });
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent).toBe('Packaging…');
    expect(document.activeElement).toBe(button);
    expect(calls).toEqual([]);
    await frame();
    expect(calls).toEqual([]);
    await frame();
    expect(calls).toEqual(['package']);
    await act(async () => finish(artifact));
    expect(container.textContent).toContain(UNSIGNED_PACKAGE_LABEL);
    expect(document.activeElement).toBe(button);
    expect(container.textContent).toContain(artifact.digest);
    expect(calls).toEqual(['package']);
    await render(true);
    expect(calls).toEqual(['package']);
    expect(container.querySelector('a[href="/projects/deploy"]')).not.toBeNull();
    expect(container.querySelector('a[href="/apps"]')).not.toBeNull();
    const disclosure = container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    await act(async () => disclosure.click());
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    await act(async () => disclosure.click());
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(calls).toEqual(['package']);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('retains the real v1 error without a successful File hand-off and retries only on another click', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  const host = { package: vi.fn().mockRejectedValue(new Error('This is a manifest v1 source project.')) };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <PackageSection directory="/workspace" packageHost={host} />
        </MemoryRouter>
      )
    );
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-busy]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(host.package).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('This is a manifest v1 source project.');
    expect(container.querySelector('a[href="/apps"]')).toBeNull();
    expect(container.textContent).toContain('No hand-off file from this attempt.');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-busy]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(host.package).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('warns about changing files without treating agent readiness as authorization', async () => {
  const host = { package: vi.fn() };
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <PackageSection directory="/workspace" packageHost={host} filesChanging readinessProposal={proposal} />
        </MemoryRouter>
      )
    );
    expect(container.textContent).toContain('Files are still changing. Stop editing and review them before packaging.');
    expect(container.querySelector<HTMLButtonElement>('button[aria-busy]')!.disabled).toBe(false);
    expect(host.package).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
