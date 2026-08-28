import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CatalogueEntry } from '@appliance.sh/sdk';
import { CatalogueContent } from '../runtime-catalogue';

const entry: CatalogueEntry = {
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
};

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
    const html = renderToStaticMarkup(<CatalogueContent data={null} error="bad signature" />);
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
      />
    );
    expect(html).toContain('This catalogue index is stale');
    expect(html).toContain('Journal');
    expect(html).toContain('disabled=""');
  });
});
