import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { EntitlementSuggestion } from '@appliance.sh/sdk';
import { EntitlementsEmptyState, EntitlementSuggestionRow } from './settings';

const suggestion: EntitlementSuggestion = {
  appId: 'journal',
  version: '1.2.0',
  license: 'MIT',
  grant: {
    id: 'egress:api.example.com',
    control: 'egress-host',
    value: { host: 'api.example.com', ports: [443] },
    approvedAt: '2026-07-01T09:30:00.000Z',
  },
  lastUsedAt: '2026-07-10T08:00:00.000Z',
  reason: 'unused',
  revokeCommand: 'appliance runtime entitlements revoke journal egress:api.example.com',
};

describe('Settings entitlement states', () => {
  it('renders the explicit empty state', () => {
    const html = renderToStaticMarkup(<EntitlementsEmptyState />);
    expect(html).toContain('All entitlement grants are active');
    expect(html).toContain('No non-mount grants have been unused for 30 days.');
  });

  it('prefixes the control kind and renders a two-step revoke confirmation', () => {
    const html = renderToStaticMarkup(
      <EntitlementSuggestionRow
        suggestion={suggestion}
        confirming
        busy={false}
        anotherBusy={false}
        onReview={() => {}}
        onRevoke={() => {}}
        onKeep={() => {}}
      />
    );
    expect(html).toContain('Network · <span class="font-mono">egress:api.example.com</span> · last used 2026-07-10');
    expect(html).toContain('Revoke <span class="font-mono">egress:api.example.com</span> from journal?');
    expect(html).toContain('aria-label="Confirm revoke from journal"');
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain('>Revoke</button>');
    expect(html).toContain('>Keep</button>');
  });
});
