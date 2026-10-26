import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Banner, type BannerTone } from './banner.js';
import { LogPane } from './log-pane.js';
import { LongOperation } from './long-operation.js';
import { StatusDot } from './status-dot.js';
import { StatusPill, type StatusTone } from './status-pill.js';

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
  it('keeps server markup deterministic until the live clock starts after hydration', () => {
    const clock = vi.spyOn(Date, 'now');
    const render = () =>
      renderToStaticMarkup(
        <LongOperation
          title="Starting"
          status="running"
          timeClass="minutes"
          estimate="A few minutes"
          leaveSafety="resumable"
          lastActivityAt={1}
        />
      );
    try {
      clock.mockReturnValue(10_000);
      const server = render();
      clock.mockReturnValue(200_000);
      expect(render()).toBe(server);
      expect(server).toContain('0:00');
    } finally {
      clock.mockRestore();
    }
  });

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

// CSS parity and JS spring shapes are separate contracts; matching durations alone is insufficient.
import { readFileSync } from 'node:fs';
import { motionTokens } from '../motion/tokens.js';
import { spring, exitFallbackMs } from '../lib/springs.js';
import { selectTransition } from '../motion/use-transition.js';
import { MotionProvider } from '../motion-provider.js';
import { SkeletonSwap } from './skeleton-swap.js';
import { Skeleton } from './skeleton.js';

describe('Motion contract', () => {
  it('keeps the CSS lane and exported CSS mirror in milliseconds', () => {
    const theme = readFileSync(new URL('../theme.css', import.meta.url), 'utf8');
    const exported = readFileSync(new URL('../../dist/tokens.css', import.meta.url), 'utf8');
    for (const [tier, enterMs, exitMs] of [
      ['fast', 80, 60],
      ['base', 160, 120],
      ['slow', 240, 160],
    ] as const) {
      for (const [suffix, ms] of [
        ['', enterMs],
        ['-exit', exitMs],
      ] as const) {
        const token = `--duration-${tier}${suffix}: ${ms}ms;`;
        expect(theme).toContain(token);
        expect(exported).toContain(token);
      }
      // Assert the conversion explicitly; equal-looking numbers in different units are not parity.
      expect(motionTokens[tier].duration).toBe(enterMs / 1000);
      expect(motionTokens[tier].exit.duration).toBe(exitMs / 1000);
      expect(motionTokens[tier].duration * 1000).toBe(enterMs);
      expect(motionTokens[tier].exit.duration * 1000).toBe(exitMs);
    }
    for (const css of [theme, exported]) {
      expect(css).toContain('--ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1)');
      expect(css).toContain('--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1)');
    }
  });
  it('keeps JS tiers as FF springs with explicit exit tweens', () => {
    for (const [tier, ffTier, duration, exitDuration, bounce] of [
      ['fast', 'fast', 0.08, 0.06, 0],
      ['base', 'moderate', 0.16, 0.12, 0],
      ['slow', 'slow', 0.24, 0.16, 0.12],
    ] as const) {
      expect(motionTokens[tier]).toEqual({
        type: 'spring',
        duration,
        bounce,
        exit: { type: 'tween', duration: exitDuration },
      });
      expect(spring[ffTier]).toMatchObject({ type: 'spring', duration, bounce, exit: { duration: exitDuration } });
      expect(exitFallbackMs(spring[ffTier])).toBe(Math.round(exitDuration * 1000) + 100);
    }
    expect(selectTransition(false).type).toBe('spring');
    expect(selectTransition(false, 'base', 'exit').type).toBe('tween');
    expect(selectTransition(false, 'base', 'exit').duration).toBe(0.12);
  });
  it('selects real enter springs and named exit tweens, with immediate reduced motion', () => {
    for (const speed of ['fast', 'base', 'slow'] as const) {
      const { exit, ...enter } = motionTokens[speed];
      expect(selectTransition(false, speed)).toEqual(enter);
      expect(selectTransition(false, speed, 'exit')).toEqual(exit);
      for (const phase of ['enter', 'exit'] as const) {
        expect(selectTransition(true, speed, phase)).toEqual({ type: 'tween', duration: 0 });
      }
    }
    expect(selectTransition(false)).toEqual({ type: 'spring', duration: 0.16, bounce: 0 });
  });
  it('keeps initial content readable before lazy features, including SSR', () => {
    const html = renderToStaticMarkup(
      <MotionProvider>
        <Banner tone="error">Readable alert</Banner>
        <SkeletonSwap loading={false} fallback={<Skeleton />}>
          Ready content
        </SkeletonSwap>
      </MotionProvider>
    );
    expect(html).toContain('Readable alert');
    expect(html).toContain('Ready content');
    expect(html).not.toContain('opacity:0');
    expect(html).toContain('role="alert"');
  });
  it('mounts one provider outside app routes and loads features dynamically', () => {
    const app = readFileSync(new URL('../../../app/src/App.tsx', import.meta.url), 'utf8');
    expect(app.match(/<MotionProvider>/g)).toHaveLength(1);
    expect(app.indexOf('<MotionProvider>')).toBeLessThan(app.indexOf('<RouterProvider'));
    const provider = readFileSync(new URL('../motion-provider.tsx', import.meta.url), 'utf8');
    expect(provider).toContain('reducedMotion="user"');
    expect(provider).toContain('<LazyMotion features={loadFeatures}>');
    expect(provider).toContain("import('./motion/features.js')");
  });
});
