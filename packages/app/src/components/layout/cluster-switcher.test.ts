import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Tag } from '@/components/ui/tag';
import type { Cluster } from '@/lib/host';
import { switcherName, workspaceKind } from './cluster-switcher';

const local: Cluster = {
  id: 'microvm',
  name: 'Dev Machine',
  apiServerUrl: 'https://127.0.0.1:8443',
  createdAt: '2026-08-27T00:00:00.000Z',
};
const cloud: Cluster = {
  id: 'mock-acme-prod',
  name: 'acme-prod',
  apiServerUrl: 'https://appliance.acme.example',
  createdAt: '2026-08-27T00:00:00.000Z',
};

describe('workspace switcher presentation', () => {
  it('uses user copy without changing developer target copy', () => {
    expect(switcherName('workspace', local)).toBe('This Mac');
    expect(switcherName('workspace', null)).toBe('This Mac');
    expect(switcherName('developer', null)).toBe('Select target');
    expect(switcherName('developer', local)).toBe('Dev Machine');
  });

  it('derives workspace kind from the existing cluster identity', () => {
    expect(workspaceKind(local)).toBe('local');
    expect(workspaceKind(cloud)).toBe('cloud');
  });

  it('renders cloud metadata with the semantic info tag', () => {
    const html = renderToStaticMarkup(createElement(Tag, { emphasis: 'info', children: 'cloud' }));
    expect(html).toContain('--color-info-background');
    expect(html).toContain('--color-info-foreground');
  });

  it('keeps the menu semantics and keyboard contract in the switcher', () => {
    const source = readFileSync(fileURLToPath(new URL('./cluster-switcher.tsx', import.meta.url)), 'utf8');
    expect(source).toContain('aria-label={workspacePresentation ? `Workspace: ${currentName}`');
    expect(source).toContain('role="menu"');
    expect(source).toContain('role="menuitemradio"');
    expect(source).toContain('type="button"');
    expect(source).toContain("event.key === 'ArrowDown'");
    expect(source).toContain("e.key === 'Escape'");
  });
});
