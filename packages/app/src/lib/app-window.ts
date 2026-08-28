export type AppWindowClosePolicy = 'keep-running' | 'stop-on-close';

export interface RuntimeAppUi {
  type: 'web' | 'native' | 'none';
  port?: string;
  path?: string;
}

export interface RuntimeAppWindowDescriptor {
  appId: string;
  target: string;
  name: string;
  version: string;
  license: string;
  ui: RuntimeAppUi;
  state: 'starting' | 'running' | 'degraded' | 'stopped' | 'exited' | 'failed';
  exitCode?: number;
  url?: string;
  hostPort?: number;
  egressHostCount: number;
  openMetric?: AppOpenMetricContext;
}

export type AppOpenKind = 'cold' | 'warm' | 'reopen';

export interface AppOpenMetricContext {
  kind: AppOpenKind;
  startedAtMs: number;
}

export interface AppWindowMetric {
  name: 'app_open_ttv' | 'app_stop_ttx';
  appId: string;
  durationMs: number;
  kind?: AppOpenKind;
}

export interface PortWaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
}

export function appWindowLabel(appId: string): string {
  const trimmed = appId.trim();
  const safe = trimmed
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
  if (!safe) throw new Error('an app id is required');
  return `app-${safe}-${shortAppIdHash(trimmed)}`;
}

export function appWindowTitle(name: string): string {
  return `${name.trim() || 'App'} — Appliance`;
}

export function closePolicyAction(policy: AppWindowClosePolicy = 'keep-running'): 'keep' | 'stop' {
  return policy === 'stop-on-close' ? 'stop' : 'keep';
}

export async function waitForPublishedPort(
  probe: () => Promise<boolean>,
  options: PortWaitOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 100;
  const now = options.now ?? Date.now;
  const delay = options.delay ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + timeoutMs;
  let lastError: unknown;

  do {
    try {
      if (await probe()) return;
    } catch (cause) {
      lastError = cause;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await delay(Math.min(intervalMs, remaining));
  } while (now() <= deadline);

  const suffix = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`app port was not ready within ${timeoutMs}ms${suffix}`);
}

export function reconcileRuntimeApps<T extends { appId: string }>(
  installedIds: readonly string[],
  registry: readonly T[]
): T[] {
  const installed = new Set(installedIds);
  return registry.filter((record) => installed.has(record.appId));
}

export function encodeAppWindowDescriptor(descriptor: RuntimeAppWindowDescriptor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(descriptor));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeAppWindowDescriptor(encoded: string): RuntimeAppWindowDescriptor {
  const padded = encoded
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(encoded.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as RuntimeAppWindowDescriptor;
}

export function appWindowStatusText(descriptor: RuntimeAppWindowDescriptor): string {
  const hosts = descriptor.egressHostCount;
  const port = descriptor.hostPort == null ? 'port unavailable' : `port ${descriptor.hostPort}`;
  return `sandboxed · egress: ${hosts} host${hosts === 1 ? '' : 's'} allowed · ${port}`;
}

export function recordAppStopStart(appId: string, startedAtMs = Date.now()): void {
  window.localStorage.setItem(appStopMetricKey(appId), String(startedAtMs));
}

export function clearAppStopStart(appId: string): void {
  window.localStorage.removeItem(appStopMetricKey(appId));
}

export function renderAppWindow(
  root: HTMLElement,
  initial: RuntimeAppWindowDescriptor,
  options: {
    status?: () => Promise<RuntimeAppWindowDescriptor>;
    reopen?: () => Promise<RuntimeAppWindowDescriptor>;
    metric?: (metric: AppWindowMetric) => void | Promise<void>;
    pollMs?: number;
  } = {}
): () => void {
  let descriptor = initial;
  let stopped = false;
  let stripLeft: HTMLSpanElement | null = null;
  let stripRight: HTMLSpanElement | null = null;
  const emittedOpenMetrics = new Set<number>();

  const meta = document.createElement('meta');
  meta.httpEquiv = 'Content-Security-Policy';
  meta.content = wrapperCsp(descriptor);
  document.head.append(meta);
  document.title = appWindowTitle(descriptor.name);

  const draw = () => {
    root.replaceChildren();
    root.setAttribute('data-app-window', descriptor.appId);
    const shell = document.createElement('main');
    shell.className = 'appliance-app-window';
    shell.tabIndex = -1;

    if (isTerminal(descriptor)) {
      const exited = document.createElement('section');
      exited.className = 'appliance-app-exited';
      const title = document.createElement('h1');
      title.textContent = 'App exited';
      const detail = document.createElement('p');
      detail.textContent = terminalCopy(descriptor);
      const reopen = document.createElement('button');
      reopen.type = 'button';
      reopen.textContent = 'Reopen';
      reopen.disabled = !options.reopen;
      const reopenError = document.createElement('p');
      reopenError.className = 'appliance-app-reopen-error';
      reopenError.setAttribute('role', 'alert');
      reopen.addEventListener('click', () => {
        if (!options.reopen) return;
        const startedAtMs = Date.now();
        reopen.disabled = true;
        reopen.setAttribute('aria-busy', 'true');
        reopen.textContent = 'Reopening…';
        reopenError.textContent = '';
        void options
          .reopen()
          .then((next) => {
            descriptor = { ...next, openMetric: { kind: 'reopen', startedAtMs } };
            draw();
            window.requestAnimationFrame(() => {
              (root.querySelector<HTMLElement>('iframe') ?? root.querySelector<HTMLElement>('main'))?.focus();
            });
          })
          .catch((cause: unknown) => {
            reopenError.textContent = cause instanceof Error ? cause.message : `Could not reopen ${descriptor.name}.`;
            reopen.disabled = false;
            reopen.removeAttribute('aria-busy');
            reopen.textContent = 'Reopen';
          });
      });
      exited.append(title, detail, reopen, reopenError);
      shell.append(exited);
      emitStopMetricAfterPaint();
    } else if (descriptor.url) {
      const frame = document.createElement('iframe');
      const openMetric = descriptor.openMetric;
      frame.src = descriptor.url;
      frame.title = `${descriptor.name} web UI`;
      frame.referrerPolicy = 'no-referrer';
      frame.setAttribute(
        'sandbox',
        'allow-downloads allow-forms allow-modals allow-popups allow-scripts allow-same-origin'
      );
      frame.addEventListener('load', () => emitOpenMetric(openMetric));
      shell.append(frame);
    }

    const strip = document.createElement('footer');
    strip.className = 'appliance-app-status';
    strip.setAttribute('role', 'status');
    strip.setAttribute('aria-live', 'polite');
    strip.setAttribute('aria-atomic', 'true');
    stripLeft = document.createElement('span');
    stripLeft.className = 'appliance-app-status__group';
    stripRight = document.createElement('span');
    stripRight.className = 'appliance-app-status__group';
    updateStatusStrip();
    strip.append(stripLeft, stripRight);
    shell.append(strip);
    root.append(shell);
  };

  const style = document.createElement('style');
  style.textContent = APP_WINDOW_CSS;
  document.head.append(style);
  draw();

  const timer = options.status
    ? window.setInterval(() => {
        void options.status!().then((next) => {
          if (stopped) return;
          const redraw = isTerminal(descriptor) !== isTerminal(next) || descriptor.url !== next.url;
          descriptor = next;
          if (redraw) draw();
          else updateStatusStrip();
        });
      }, options.pollMs ?? 1_000)
    : undefined;

  return () => {
    stopped = true;
    if (timer !== undefined) window.clearInterval(timer);
    meta.remove();
    style.remove();
  };

  function updateStatusStrip() {
    if (stripLeft) {
      const hosts = descriptor.egressHostCount;
      stripLeft.replaceChildren(
        statusSpan('', 'appliance-app-status__dot', true),
        statusSpan('sandboxed'),
        statusSpan('·', 'appliance-app-status__separator', true),
        statusSpan(`egress: ${hosts} host${hosts === 1 ? '' : 's'} allowed`),
        statusSpan('·', 'appliance-app-status__separator', true),
        statusSpan(descriptor.hostPort == null ? 'port unavailable' : `port ${descriptor.hostPort}`)
      );
    }
    if (stripRight) {
      stripRight.replaceChildren(
        statusSpan(`${descriptor.name} ${descriptor.version}`),
        statusSpan('·', 'appliance-app-status__separator', true),
        statusSpan(descriptor.license)
      );
    }
  }

  function emitOpenMetric(context: AppOpenMetricContext | undefined) {
    if (!context || emittedOpenMetrics.has(context.startedAtMs)) return;
    emittedOpenMetrics.add(context.startedAtMs);
    void options.metric?.({
      name: 'app_open_ttv',
      appId: descriptor.appId,
      durationMs: Math.max(0, Date.now() - context.startedAtMs),
      kind: context.kind,
    });
  }

  function emitStopMetricAfterPaint() {
    const key = appStopMetricKey(descriptor.appId);
    const startedAtMs = Number(window.localStorage.getItem(key));
    if (!Number.isFinite(startedAtMs) || startedAtMs <= 0 || Date.now() - startedAtMs > 60_000) return;
    window.localStorage.removeItem(key);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        void options.metric?.({
          name: 'app_stop_ttx',
          appId: descriptor.appId,
          durationMs: Math.max(0, Date.now() - startedAtMs),
        });
      });
    });
  }
}

function isTerminal(descriptor: RuntimeAppWindowDescriptor): boolean {
  return descriptor.state === 'stopped' || descriptor.state === 'exited' || descriptor.state === 'failed';
}

export function wrapperCsp(descriptor: RuntimeAppWindowDescriptor): string {
  const frame = descriptor.hostPort == null ? "'none'" : `http://127.0.0.1:${descriptor.hostPort}`;
  return `default-src 'none'; frame-src ${frame}; connect-src ipc: http://ipc.localhost; script-src 'self'; style-src 'unsafe-inline'; img-src data:`;
}

function shortAppIdHash(appId: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(appId)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function appStopMetricKey(appId: string): string {
  return `appliance:app-stop:${appWindowLabel(appId)}`;
}

function terminalCopy(descriptor: RuntimeAppWindowDescriptor): string {
  if (descriptor.state === 'failed') {
    return descriptor.exitCode == null
      ? `${descriptor.name} failed.`
      : `${descriptor.name} failed (exit code ${descriptor.exitCode}).`;
  }
  if (descriptor.exitCode == null || descriptor.exitCode === 0) return `${descriptor.name} has stopped.`;
  return `${descriptor.name} stopped (exit code ${descriptor.exitCode}).`;
}

function statusSpan(text: string, className?: string, ariaHidden = false): HTMLSpanElement {
  const span = document.createElement('span');
  span.textContent = text;
  if (className) span.className = className;
  if (ariaHidden) span.setAttribute('aria-hidden', 'true');
  return span;
}

const APP_WINDOW_CSS = `
  :root { color-scheme: dark; font-family: "Geist Variable", Geist, ui-sans-serif, system-ui, sans-serif; }
  * { box-sizing: border-box; }
  html, body, #root { width: 100%; height: 100%; margin: 0; overflow: hidden; background: hsl(0 0% 4%); color: hsl(0 0% 93%); }
  .appliance-app-window { display: grid; grid-template-rows: minmax(0, 1fr) 28px; width: 100%; height: 100%; }
  .appliance-app-window iframe { width: 100%; height: 100%; border: 0; background: hsl(0 0% 7%); }
  .appliance-app-status { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-width: 0; padding: 0 10px; border-top: 1px solid var(--color-border); background: var(--color-muted); color: var(--color-muted-foreground); font: 11px/28px var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .appliance-app-status__group { display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .appliance-app-status__group > span { overflow: hidden; text-overflow: ellipsis; }
  .appliance-app-status__dot { width: 6px; height: 6px; flex: 0 0 6px; border-radius: 999px; background: var(--color-sandbox); }
  .appliance-app-status__separator { color: var(--color-border-strong); }
  .appliance-app-exited { align-self: center; justify-self: center; width: min(420px, calc(100% - 48px)); padding: 28px; border: 1px solid hsl(0 0% 18%); border-radius: 6px; background: hsl(0 0% 7%); text-align: center; }
  .appliance-app-exited h1 { margin: 0; font-size: 20px; font-weight: 600; }
  .appliance-app-exited p { margin: 8px 0 20px; color: hsl(0 0% 63%); font-size: 13px; }
  .appliance-app-exited button { border: 0; border-radius: 5px; padding: 7px 13px; background: hsl(0 0% 93%); color: hsl(0 0% 4%); font: 600 12px/16px inherit; cursor: pointer; }
  .appliance-app-exited button:disabled { cursor: default; opacity: .5; }
  .appliance-app-exited .appliance-app-reopen-error { min-height: 16px; margin: 10px 0 0; color: var(--color-destructive-foreground); font-size: 12px; }
`;
