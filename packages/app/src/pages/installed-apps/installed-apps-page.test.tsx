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
        serviceNames: ['web', 'sync'],
      },
    },
    state: 'running',
    urls: ['http://127.0.0.1:8443'],
    ui: { type: 'web', port: 'web', path: '/' },
    ...overrides,
  };
}

describe('Installed Apps mock scenarios', () => {
  it('renders the installed-apps card contract from mock frame 2', () => {
    const html = renderToStaticMarkup(<InstalledAppCard item={fixture()} />);
    expect(html).toContain('Notes+Sync');
    expect(html).toContain('v2.4.0');
    expect(html).toContain('AGPL-3.0');
    expect(html).toContain('installed 2026-09-02');
    expect(html).toContain('Running');
    expect(html).toContain('2 services');
    expect(html).toContain('web, sync');
    expect(html).toContain('egress: 1 host');
    expect(html).toContain('aria-label="Open Notes+Sync"');
    expect(html).toContain('aria-label="Stop Notes+Sync"');
    expect(html).toContain('aria-label="Logs for Notes+Sync"');
    expect(html).toContain('Open');
    expect(html).toContain('Stop');
  });

  it('renders exited and no-UI card states without an Open action', () => {
    const html = renderToStaticMarkup(
      <InstalledAppCard item={fixture({ state: 'exited', exitCode: 7, urls: [], ui: { type: 'native' } })} />
    );
    expect(html).toContain('Exited (7)');
    expect(html).toContain('No UI');
    expect(html).toContain('Logs');
    expect(html).not.toContain('aria-label="Open Notes+Sync"');
  });

  it('announces opening and stopping busy actions', () => {
    const opening = renderToStaticMarkup(<InstalledAppCard item={fixture()} busy busyAction="opening" />);
    expect(opening).toContain('Opening…');
    expect(opening).toContain('aria-busy="true"');

    const stopping = renderToStaticMarkup(<InstalledAppCard item={fixture()} busy busyAction="stopping" />);
    expect(stopping).toContain('Stopping…');
    expect(stopping).toContain('aria-busy="true"');
  });

  it('renders installed-apps-empty', () => {
    const html = renderToStaticMarkup(<InstalledAppsEmptyState onInstall={() => {}} />);
    expect(html).toContain('No apps installed in this workspace');
    expect(html).toContain('font-mono');
    expect(html).toContain('.appliance.zip');
    expect(html).toContain('Install from file');
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
    expect(html.match(/<button/g)?.length).toBe(3);
    expect(html.match(/bg-\[var\(--color-primary\)\]/g)?.length).toBe(1);
  });
});
