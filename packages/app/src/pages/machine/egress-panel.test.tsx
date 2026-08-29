import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '@/components/ui/confirm-dialog';
import type { EgressPolicy, MicroVmInstanceHost } from '@/lib/host';
import { EgressPanel } from './egress-panel';

function renderWsl(mode: 'strict' | 'cooperative'): string {
  const policy: EgressPolicy = {
    default: 'deny',
    allow: [],
    deny: [],
    mitm: false,
    boundary: 'cooperative',
    enforcement: { backend: 'wsl', bypassable: true, scope: ['http', 'https'] },
    wslMode: mode,
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
        <EgressPanel vm={vm} name="appliance-runtime" policy={policy} policyError={null} />
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
    expect(strict).not.toContain('host-enforced');

    const cooperative = renderWsl('cooperative');
    expect(cooperative).toContain('Cooperative proxy — bypassable');
    expect(cooperative).toContain('Runtime apps can ignore HTTP(S)_PROXY');
    expect(cooperative).toContain('Grants are unioned across apps in this VM');
    expect(cooperative).not.toContain('host-enforced');
  });
});
