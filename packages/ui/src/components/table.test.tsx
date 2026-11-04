// @vitest-environment jsdom
import * as React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from './table.js';

afterEach(cleanup);

describe('Table', () => {
  it('keeps native semantics, caption naming, header scope and column spans', () => {
    render(
      <Table>
        <TableCaption>Workloads</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>State</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableHead scope="row">Journal</TableHead>
            <TableCell>Ready</TableCell>
          </TableRow>
          <TableRow>
            <TableCell colSpan={2}>No more workloads</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    );
    expect(screen.getByRole('table', { name: 'Workloads' }).tagName).toBe('TABLE');
    expect(screen.getByRole('columnheader', { name: 'Name' }).getAttribute('scope')).toBe('col');
    expect(screen.getByRole('rowheader', { name: 'Journal' }).getAttribute('scope')).toBe('row');
    expect(screen.getByRole('cell', { name: 'No more workloads' }).getAttribute('colspan')).toBe('2');
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it('forwards refs and attributes, permits class overrides, and keeps actions on controls', () => {
    const ref = React.createRef<HTMLTableElement>();
    const action = vi.fn();
    render(
      <Table ref={ref} aria-label="Pods" aria-busy="true" className="text-xs">
        <TableHeader data-testid="header">
          <TableRow>
            <TableHead className="w-1/2">Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody data-testid="body">
          <TableRow data-testid="row">
            <TableCell className="text-right">
              <button onClick={action}>Logs</button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    );
    expect(ref.current).toBe(screen.getByRole('table'));
    expect(ref.current?.getAttribute('aria-busy')).toBe('true');
    expect(ref.current?.className).toContain('table-fixed');
    expect(ref.current?.className).not.toContain('text-sm');
    expect(screen.getByTestId('header').tagName).toBe('THEAD');
    expect(screen.getByTestId('body').tagName).toBe('TBODY');
    expect(screen.getByTestId('row').hasAttribute('tabindex')).toBe(false);
    expect(screen.getByRole('cell').className).toContain('text-right');
    fireEvent.click(screen.getByRole('button', { name: 'Logs' }));
    expect(action).toHaveBeenCalledOnce();
  });
});
