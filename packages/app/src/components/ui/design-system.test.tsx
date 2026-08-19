import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Banner, type BannerTone } from './banner';
import { LogPane } from './log-pane';
import { LongOperation } from './long-operation';
import { StatusDot } from './status-dot';
import { StatusPill, type StatusTone } from './status-pill';

describe('Banner', () => {
  it.each<BannerTone>(['neutral', 'info', 'sandbox', 'success', 'warning', 'error'])(
    'renders the %s semantic recipe',
    (tone) => {
      const html = renderToStaticMarkup(
        <Banner tone={tone} title="Headline">
          Message
        </Banner>
      );
      expect(html).toContain('Headline');
      expect(html).toContain('Message');
      expect(html).toContain(tone === 'error' ? 'role="alert"' : tone === 'success' ? 'role="status"' : '<div class=');
      expect(html).not.toMatch(/(?:red|green|cyan|amber|yellow|violet)-\d/);
    }
  );

  it('supports an action, icon, dismissal, and caller role', () => {
    function Icon() {
      return <svg data-icon="test" />;
    }
    const html = renderToStaticMarkup(
      <Banner icon={Icon} action={<a href="/retry">Retry</a>} onDismiss={() => undefined} role="status">
        Notice
      </Banner>
    );
    expect(html).toContain('data-icon="test"');
    expect(html).toContain('Retry');
    expect(html).toContain('aria-label="Dismiss"');
    expect(html).toContain('role="status"');
  });
});

describe('Status primitives', () => {
  it.each<StatusTone>(['neutral', 'info', 'sandbox', 'success', 'warning', 'error'])(
    'renders a persistent label for %s',
    (tone) => {
      const html = renderToStaticMarkup(<StatusPill tone={tone} label="Visible state" />);
      expect(html).toContain('Visible state');
      expect(html).toContain(
        tone === 'neutral' ? '--color-muted' : `--color-${tone === 'error' ? 'destructive' : tone}`
      );
      expect(html).toContain('text-micro');
    }
  );

  it('renders spin, pulse, no-dot, and accessible dot modes', () => {
    expect(renderToStaticMarkup(<StatusPill tone="info" label="Running" activity="spin" />)).toContain('animate-spin');
    expect(renderToStaticMarkup(<StatusPill tone="info" label="Running" activity="pulse" />)).toContain(
      'animate-pulse'
    );
    expect(renderToStaticMarkup(<StatusPill tone="neutral" label="Stopped" dot={false} />)).not.toContain('bg-current');
    const dot = renderToStaticMarkup(<StatusDot tone="sandbox" label="Sandbox ready" activity="pulse" size="md" />);
    expect(dot).toContain('role="img"');
    expect(dot).toContain('aria-label="Sandbox ready"');
    expect(dot).toContain('animate-ping');
    expect(dot).toContain('h-2.5');
  });

  it('keeps the legacy status resolver available during migration', () => {
    const html = renderToStaticMarkup(<StatusDot status="failed" />);
    expect(html).toContain('aria-label="Failed"');
    expect(html).toContain('--color-destructive-foreground');
  });
});

describe('LogPane', () => {
  it('renders controlled open log output with live and copy affordances', () => {
    const html = renderToStaticMarkup(
      <LogPane open live="polite" copyText="line one" height="compact">
        <div>line one</div>
      </LogPane>
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('role="log"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-relevant="additions"');
    expect(html).toContain('aria-label="Copy log"');
    expect(html).toContain('max-h-40');
    expect(html).toContain('line one');
  });

  it('supports uncontrolled default-open and closed modes with an empty state', () => {
    const open = renderToStaticMarkup(<LogPane defaultOpen empty="Nothing yet" />);
    expect(open).toContain('Nothing yet');
    expect(open).toContain('aria-expanded="true"');
    const closed = renderToStaticMarkup(<LogPane open={false}>hidden</LogPane>);
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('role="log"');
  });
});

describe('LongOperation', () => {
  it('combines its ladder, now-line, honest time copy, and disclosed log', () => {
    const html = renderToStaticMarkup(
      <LongOperation
        title="Setting up App hosting"
        status="running"
        timeClass="minutes"
        estimate="one-time · usually 2–4 minutes"
        leaveSafety="resumable"
        activeStep={1}
        nowLine="Platform images staged — importing."
        steps={[
          { key: 'restart', label: 'Restarting with hosting' },
          { key: 'platform', label: 'App platform ready', runningLabel: 'Starting the app platform' },
        ]}
        log={<div>engine output</div>}
      />
    );
    expect(html).toContain('Starting the app platform');
    expect(html).toContain('Platform images staged — importing.');
    expect(html).toContain('one-time · usually 2–4 minutes');
    expect(html).toContain('Safe to visit other areas');
    expect(html).toContain('aria-live="polite"');
  });
});
