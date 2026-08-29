import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '@/components/ui/confirm-dialog';
import type { EgressPolicy, MicroVmInstanceHost } from '@/lib/host';
import { EgressPanel } from './egress-panel';

function renderWsl(
  mode: 'strict' | 'cooperative',
  options: { platform?: 'windows' | 'macos'; policy?: Partial<EgressPolicy> } = {}
): string {
  const policy: EgressPolicy = {
    default: 'deny',
    allow: [],
    deny: [],
    mitm: false,
    boundary: 'cooperative',
    enforcement: { backend: 'wsl', bypassable: true, scope: ['http', 'https'] },
    wslMode: mode,
    ...options.policy,
  };
  const egress = {
    get: vi.fn(),
    setWslMode: vi.fn(),
    setDefault: vi.fn(),
    addRule: vi.fn(),
    removeRule: vi.fn(),
    reset: vi.fn(),
    setMitm: vi.fn(),
    ca: vi.fn(),
    denied: vi.fn(),
    log: vi.fn().mockResolvedValue([]),
    clearLog: vi.fn(),
  };
  const vm = { egress } as unknown as MicroVmInstanceHost;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <EgressPanel
          vm={vm}
          name="appliance-runtime"
          policy={policy}
          policyError={null}
          platform={options.platform ?? 'windows'}
        />
      </ConfirmProvider>
    </QueryClientProvider>
  );
}

describe('WSL egress panel', () => {
  it('renders strict and cooperative policy truthfully without host-enforced wording', () => {
    const strict = renderWsl('strict');
    expect(strict).toContain('WSL strict mode');
    expect(strict).toContain('Runtime apps that request egress grants are refused');
    expect(strict).toContain('aria-checked="true"');
    expect(strict).toContain('role="status"');
    expect(strict).not.toContain('host-enforced');

    const cooperative = renderWsl('cooperative');
    expect(cooperative).toContain('Cooperative proxy — bypassable');
    expect(cooperative).toContain('Runtime apps can ignore HTTP(S)_PROXY');
    expect(cooperative).toContain('Grants are unioned into a host-only allowlist across apps');
    expect(cooperative).toContain('direct UDP 53 is dropped');
    expect(cooperative).not.toContain('host-enforced');
  });

  it('never renders enforced on Windows when a stale engine omits backend capability', () => {
    const stale = renderWsl('strict', {
      platform: 'windows',
      policy: { boundary: 'enforced', enforced: true, enforcement: undefined },
    });
    expect(stale).toContain('WSL enforcement unknown — update appliance-vm');
    expect(stale).toContain('unknown (stale engine; treat as cooperative)');
    expect(stale).not.toContain('Protection enforced');
    expect(stale).not.toContain('enforced (netstack)');
  });

  it('never renders enforced on Windows when the WSL backend reports an enforced boundary', () => {
    const wsl = renderWsl('strict', {
      platform: 'windows',
      policy: { boundary: 'enforced', enforced: true },
    });
    expect(wsl).toContain('cooperative (in-guest proxy)');
    expect(wsl).not.toContain('enforced (netstack)');
  });
});
