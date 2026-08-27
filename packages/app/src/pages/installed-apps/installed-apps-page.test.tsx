import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { InstalledRuntimeApp } from '@/lib/host';
import { InstalledAppCard, InstalledAppsEmptyState } from './index';
import { UnknownPublisherDialog } from './unknown-publisher-dialog';

function fixture(overrides: Partial<InstalledRuntimeApp> = {}): InstalledRuntimeApp {
  return {
    app: {
      appId: 'notes-sync',
      name: 'Notes+Sync',
      version: '2.4.0',
      license: 'AGPL-3.0',
      publisher: { name: 'Lab 255', tier: 'known-publisher' },
      digest: `sha256:${'1'.repeat(64)}`,
      bundlePath: '/tmp/notes.appliance.zip',
      installedAt: '2026-09-02T08:00:00.000Z',
      source: 'https://notes-sync.appliance.zip/',
      verification: { signature: 'valid', indexBound: { generation: 7 } },
      controlsSummary: {
        egressHosts: ['sync.example.com'],
        mounts: [],
        publishedPorts: [{ name: 'web', guest: 8080, protocol: 'tcp' }],
        resources: {},
        serviceCount: 2,
      },
    },
    state: 'running',
    urls: ['http://127.0.0.1:8443'],
    ...overrides,
  };
}

describe('Installed Apps mock scenarios', () => {
  it('renders the installed-apps card contract from mock frame 2', () => {
    const html = renderToStaticMarkup(<InstalledAppCard item={fixture()} />);
    expect(html).toContain('Notes+Sync');
    expect(html).toContain('v2.4.0');
    expect(html).toContain('AGPL-3.0');
    expect(html).toContain('granted 2026-09-02');
    expect(html).toContain('Running');
    expect(html).toContain('2 services');
    expect(html).toContain('Open');
    expect(html).toContain('Stop');
  });

  it('renders installed-apps-empty', () => {
    const html = renderToStaticMarkup(<InstalledAppsEmptyState />);
    expect(html).toContain('No apps installed in this workspace');
    expect(html).toContain('install a local .appliance.zip bundle');
  });

  it('renders unknown-publisher with separate requested controls', () => {
    const item = fixture();
    const html = renderToStaticMarkup(
      <UnknownPublisherDialog
        action="open"
        prompt={{
          appId: item.app.appId,
          name: item.app.name,
          version: item.app.version,
          license: item.app.license,
          source: item.app.source,
          digest: item.app.digest,
          signature: 'unsigned',
          publisher: 'Local developer',
          controlsSummary: item.app.controlsSummary,
        }}
        onCancel={() => {}}
        onAccept={() => {}}
        onRemember={() => {}}
      />
    );
    expect(html).toContain('Unknown Publisher');
    expect(html).toContain('Unsigned');
    expect(html).toContain('Requested controls');
    expect(html).toContain('Open once');
    expect(html).toContain('Open and remember for 30 days');
  });
});
