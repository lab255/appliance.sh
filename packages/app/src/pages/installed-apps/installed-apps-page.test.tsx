import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { InstalledRuntimeApp } from '@/lib/host';
import { GrantDialog, InstalledAppCard, InstalledAppsEmptyState } from './index';
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
    entitlement: { license: 'AGPL-3.0', grantedAt: '2026-09-03T09:30:00.000Z' },
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
    expect(html).toContain('granted 2026-09-03');
    expect(html).toContain('rounded bg-[var(--color-muted)]');
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

  it('renders an accessible grant dialog with grouped required controls and selectable mounts', () => {
    const html = renderToStaticMarkup(
      <GrantDialog
        prompt={{
          appId: 'notes-sync',
          version: '2.4.0',
          license: 'AGPL-3.0',
          upgrade: false,
          requiredGrantIds: ['egress:sync.example.com', 'resources:runtime'],
          grants: [
            {
              id: 'egress:sync.example.com',
              control: 'egress-host',
              value: { host: 'sync.example.com', ports: [443] },
              approvedAt: '2026-09-03T09:30:00.000Z',
            },
            {
              id: 'mount:data',
              control: 'mount',
              value: { name: 'data', source: 'volume', guest: '/data', access: 'read-write' },
              approvedAt: '2026-09-03T09:30:00.000Z',
            },
            {
              id: 'resources:runtime',
              control: 'resources',
              value: { cpus: 1, memoryMib: 512, diskGib: 2 },
              approvedAt: '2026-09-03T09:30:00.000Z',
            },
          ],
        }}
        onCancel={() => {}}
        onGrant={() => {}}
      />
    );
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="grant-dialog-title"');
    expect(html).toContain('aria-describedby="grant-dialog-description"');
    expect(html).toContain('notes-sync 2.4.0 (AGPL-3.0) asks for the controls below');
    expect(html).toContain('Required');
    expect(html).toContain('Mounts');
    expect(html).toContain('egress:sync.example.com');
    expect(html).toContain('mount:data');
    expect(html).toContain('1 CPU · 512 MiB memory · 2 GiB disk');
    expect(html.match(/type="checkbox"/g)).toHaveLength(1);
    expect(html).toContain('id="grant-mount:data"');
    expect(html).not.toContain('disabled=""');
    expect(html).toContain('Grant and install');
  });
});
