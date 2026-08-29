// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CredentialRule, MicroVmInstanceHost } from '@/lib/host';
import { CredentialsPanel } from './credentials-panel';
import { splitLegacyHelper, validateHelperArgv } from './credential-helper-editor';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(async () => {
  while (mounted.length) {
    const item = mounted.pop()!;
    await act(async () => item.root.unmount());
    item.container.remove();
  }
});

function inputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

async function renderPanel(rules: CredentialRule[] = []) {
  const add = vi.fn().mockResolvedValue(undefined);
  const creds = {
    list: vi.fn().mockResolvedValue({ rules, secrets: [] }),
    add,
    remove: vi.fn().mockResolvedValue(undefined),
    setSecret: vi.fn().mockResolvedValue(undefined),
    forget: vi.fn().mockResolvedValue(undefined),
    pickHelperProgram: vi.fn().mockResolvedValue('C:\\picked\\helper.exe'),
  };
  const vm = { creds } as unknown as MicroVmInstanceHost;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <CredentialsPanel vm={vm} name="appliance" mitmOn platform="windows" />
      </QueryClientProvider>
    );
  });
  await act(async () => vi.waitFor(() => expect(container.textContent).toContain(`${rules.length} rule`)));
  return { add, container };
}

describe('credential helper argv conversion', () => {
  it('splits quoted Windows legacy helpers without consuming path backslashes', () => {
    expect(splitLegacyHelper("'C:\\a b\\x.exe' --type claude-code")).toEqual([
      'C:\\a b\\x.exe',
      '--type',
      'claude-code',
    ]);
    expect(splitLegacyHelper("'\\\\server\\share name\\helper.exe'")).toEqual(['\\\\server\\share name\\helper.exe']);
    expect(() => splitLegacyHelper("'C:\\broken.exe --type codex")).toThrow('unmatched');
  });

  it('validates the engine program and argument contract inline', () => {
    expect(validateHelperArgv('helper.exe', [], 'windows').program).toContain('absolute Windows path');
    expect(validateHelperArgv('C:\\tools\\helper.cmd', [], 'windows').program).toContain('.exe or .com');
    expect(validateHelperArgv('C:\\tools\\helper.exe', [''], 'windows').args[0]).toBe('Argument cannot be empty.');
    expect(validateHelperArgv('/usr/local/bin/helper', ['--type', 'codex'], 'linux')).toEqual({
      program: undefined,
      args: [undefined, undefined],
    });
  });

  it('emits an argv array from the editor and supports keyboard argument rows', async () => {
    const { add, container } = await renderPanel();
    await act(async () => button(container, 'Add credential rule').click());
    await act(async () => container.querySelector('summary')!.click());

    await act(async () => {
      inputValue(container.querySelector<HTMLInputElement>('#credential-host')!, 'api.example.com');
      button(container, 'Browse').click();
      await Promise.resolve();
      button(container, 'Add argument').click();
    });
    const first = container.querySelector<HTMLInputElement>('[aria-label="Helper argument 1"]')!;
    await act(async () => inputValue(first, '--type'));
    await act(async () => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(container.querySelector('[aria-label="Helper argument 2"]')).not.toBeNull();
    const second = container.querySelector<HTMLInputElement>('[aria-label="Helper argument 2"]')!;
    await act(async () => inputValue(second, 'codex'));
    expect(container.querySelector('[aria-label="Remove helper argument 1"]')).not.toBeNull();
    await act(async () => {
      button(container, 'Add rule').click();
      await vi.waitFor(() => expect(add).toHaveBeenCalledOnce());
    });

    expect(add.mock.calls[0][0].helper).toEqual(['C:\\picked\\helper.exe', '--type', 'codex']);
  });

  it('trims arguments on save and lets Backspace remove the final empty row', async () => {
    const { add, container } = await renderPanel();
    await act(async () => button(container, 'Add credential rule').click());
    await act(async () => container.querySelector('summary')!.click());
    await act(async () => {
      inputValue(container.querySelector<HTMLInputElement>('#credential-host')!, 'api.example.com');
      button(container, 'Browse').click();
      await Promise.resolve();
      button(container, 'Add argument').click();
    });
    const argument = container.querySelector<HTMLInputElement>('[aria-label="Helper argument 1"]')!;
    await act(async () => argument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true })));
    expect(container.querySelector('[aria-label="Helper argument 1"]')).toBeNull();

    await act(async () => button(container, 'Add argument').click());
    await act(async () =>
      inputValue(container.querySelector<HTMLInputElement>('[aria-label="Helper argument 1"]')!, '  --type=codex  ')
    );
    await act(async () => {
      button(container, 'Add rule').click();
      await vi.waitFor(() => expect(add).toHaveBeenCalledOnce());
    });
    expect(add.mock.calls[0][0].helper).toEqual(['C:\\picked\\helper.exe', '--type=codex']);
  });

  it('shows helpful errors and does not submit invalid argv', async () => {
    const { add, container } = await renderPanel();
    await act(async () => button(container, 'Add credential rule').click());
    await act(async () => container.querySelector('summary')!.click());
    await act(async () => {
      inputValue(container.querySelector<HTMLInputElement>('#credential-host')!, 'api.example.com');
      inputValue(container.querySelector<HTMLInputElement>('#credential-helper-program')!, 'helper.cmd');
      button(container, 'Add argument').click();
    });
    await act(async () => button(container, 'Add rule').click());
    expect(container.textContent).toContain('Use an absolute Windows path');
    expect(container.textContent).toContain('Argument cannot be empty');
    expect(add).not.toHaveBeenCalled();
  });

  it('keeps legacy helpers read-only and only saves the confirmed array conversion', async () => {
    const legacy: CredentialRule = {
      host: 'api.anthropic.com',
      capture: false,
      inject: true,
      header: 'x-api-key',
      helper: "'C:\\a b\\x.exe' --type claude-code",
    };
    const { add, container } = await renderPanel([legacy]);
    expect(container.textContent).toContain('Legacy shell helper — read only');
    expect(container.querySelector('input[value*="a b"]')).toBeNull();

    await act(async () => button(container, 'Convert to argv').click());
    expect(container.querySelector<HTMLInputElement>('#credential-host')!.readOnly).toBe(true);
    expect(container.querySelector<HTMLInputElement>('#credential-helper-program')!.value).toBe('C:\\a b\\x.exe');
    expect(container.querySelector<HTMLInputElement>('[aria-label="Helper argument 1"]')!.value).toBe('--type');
    expect(container.querySelector<HTMLInputElement>('[aria-label="Helper argument 2"]')!.value).toBe('claude-code');

    await act(async () => {
      button(container, 'Save converted rule').click();
      await vi.waitFor(() => expect(add).toHaveBeenCalledOnce());
    });
    expect(add.mock.calls[0][0].helper).toEqual(['C:\\a b\\x.exe', '--type', 'claude-code']);
    expect(typeof add.mock.calls[0][0].helper).not.toBe('string');
  });
});
