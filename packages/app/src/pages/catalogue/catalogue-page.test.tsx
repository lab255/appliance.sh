// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogueEntry } from '@appliance.sh/sdk';
import type { ConsoleHost } from '@/lib/host';
import { HostProvider } from '@/providers/host-provider';
import { CatalogueContent, CataloguePage } from '../runtime-catalogue';

const entry: CatalogueEntry = vi.hoisted(() => ({
  id: 'journal',
  name: 'Journal',
  version: '1.2.0',
  description: 'Private daily notes.',
  license: 'MIT',
  publisher: { name: 'Lab 255' },
  tier: 'known-publisher',
  url: 'https://journal.appliance.zip',
  digest: `sha256:${'1'.repeat(64)}`,
  category: 'Productivity',
}));

vi.mock('@/components/layout/workspace-switcher', () => ({
  useCurrentWorkspace: () => ({ cluster: null, kind: 'local', isLoading: false }),
}));

vi.mock('@/lib/trust/catalogue', () => ({
  verifyHostCatalogue: vi.fn().mockResolvedValue({
    entries: [entry],
    stale: false,
    verifiedAt: '2026-08-27T00:00:00Z',
    generation: 1,
  }),
}));

async function catalogueInstallMessage(rejection: unknown): Promise<string> {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <CatalogueContent
          data={{ entries: [entry], stale: false, verifiedAt: '2026-08-27T00:00:00Z', generation: 1 }}
          error={null}
          onInstall={() => Promise.reject(rejection)}
          platform="macos"
        />
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Install Journal"]')?.click();
      await Promise.resolve();
    });
    expect(consoleError).toHaveBeenCalledWith('[catalogue] install failed', rejection);
    return container.textContent ?? '';
  } finally {
    await act(async () => root.unmount());
    consoleError.mockRestore();
  }
}

describe('CatalogueContent', () => {
  it('renders the verified scenario and never renders a paid entry', () => {
    const html = renderToStaticMarkup(
      <CatalogueContent
        data={{
          entries: [entry, { ...entry, id: 'paid-hidden', name: 'Paid Hidden', paid: true }],
          stale: false,
          verifiedAt: '2026-08-27T00:00:00Z',
          generation: 1,
        }}
        error={null}
        platform="macos"
      />
    );
    expect(html).toContain('Verified index ✓ signed');
    expect(html).toContain('Journal');
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('role="radio"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-label="Install Journal"');
    expect(html).toContain('role="status">1 apps');
    expect(html).not.toContain('aria-live');
    expect(html).not.toContain('Paid Hidden');
  });

  it('renders the unverified scenario fail-closed', () => {
    const html = renderToStaticMarkup(<CatalogueContent data={null} error="bad signature" platform="macos" />);
    expect(html).toContain('Unverified');
    expect(html).toContain('No catalogue apps are shown');
    expect(html).toContain('Reason: Bad signature.');
    expect(html).not.toContain('Journal');
  });

  it('renders stale entries read-only', () => {
    const html = renderToStaticMarkup(
      <CatalogueContent
        data={{ entries: [entry], stale: true, verifiedAt: '2026-08-20T00:00:00Z', generation: 1 }}
        error={null}
        platform="macos"
      />
    );
    expect(html).toContain('This catalogue index is stale');
    expect(html).toContain('Journal');
    expect(html).toContain('disabled=""');
  });

  it('uses the Windows machine label', () => {
    const html = renderToStaticMarkup(<CatalogueContent data={null} error="bad signature" platform="windows" />);
    expect(html).toContain('this PC');
  });

  it('shows a Tauri invoke string rejection in the installation banner', async () => {
    await expect(catalogueInstallMessage('Bundle is not a regular file: C:\\x.zip')).resolves.toContain(
      'Bundle is not a regular file: C:\\x.zip'
    );
  });

  it('shows an Error rejection message in the installation banner', async () => {
    await expect(catalogueInstallMessage(new Error('install exploded'))).resolves.toContain('install exploded');
  });

  it('shows the installation fallback for an empty string rejection', async () => {
    await expect(catalogueInstallMessage('')).resolves.toContain('Installation failed.');
  });

  it('shows a friendly catalogue banner instead of a raw entitlement grant error', async () => {
    const rejection =
      'ENTITLEMENT_GRANT_REQUIRED:{"appId":"demo","version":"1.0.0","license":"MIT","upgrade":false,"grants":[],"requiredGrantIds":[]}';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const installedApps = { installBundle: vi.fn().mockRejectedValue(rejection) };
    const host = {
      catalogue: { fetchCatalogue: vi.fn().mockResolvedValue({}) },
      installedApps,
      platform: 'macos',
    } as unknown as ConsoleHost;
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <HostProvider host={host}>
            <CataloguePage />
          </HostProvider>
        );
      });
      await vi.waitFor(() => expect(container.querySelector('[aria-label="Install Journal"]')).not.toBeNull());
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[aria-label="Install Journal"]')?.click();
      });
      await vi.waitFor(() =>
        expect(container.textContent).toContain(
          'This app requests permissions the catalogue installer cannot grant. Install it from Installed Apps to review them.'
        )
      );
      expect(container.textContent).not.toContain('ENTITLEMENT_GRANT_REQUIRED');
      expect(container.textContent).not.toContain('"appId":"demo"');
    } finally {
      await act(async () => root.unmount());
      consoleError.mockRestore();
    }
  });
});
