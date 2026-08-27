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
  state: 'starting' | 'running' | 'stopped' | 'exited' | 'failed';
  exitCode?: number;
  url?: string;
  hostPort?: number;
  egressHostCount: number;
}

export interface PortWaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
}

export function appWindowLabel(appId: string): string {
  const safe = appId
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
  if (!safe) throw new Error('an app id is required');
  return `app-${safe}`;
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
  const timeoutMs = options.timeoutMs ?? 8_000;
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

export function renderAppWindow(
  root: HTMLElement,
  initial: RuntimeAppWindowDescriptor,
  options: {
    status?: () => Promise<RuntimeAppWindowDescriptor>;
    reopen?: () => Promise<RuntimeAppWindowDescriptor>;
    pollMs?: number;
  } = {}
): () => void {
  let descriptor = initial;
  let stopped = false;
  let stripLeft: HTMLSpanElement | null = null;
  let stripRight: HTMLSpanElement | null = null;

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

    if (isTerminal(descriptor)) {
      const exited = document.createElement('section');
      exited.className = 'appliance-app-exited';
      const title = document.createElement('h1');
      title.textContent = 'App exited';
      const detail = document.createElement('p');
      detail.textContent =
        descriptor.exitCode == null
          ? `${descriptor.name} is no longer running.`
          : `${descriptor.name} exited (${descriptor.exitCode}).`;
      const reopen = document.createElement('button');
      reopen.type = 'button';
      reopen.textContent = 'Reopen';
      reopen.disabled = !options.reopen;
      reopen.addEventListener('click', () => {
        if (!options.reopen) return;
        reopen.disabled = true;
        void options
          .reopen()
          .then((next) => {
            descriptor = next;
            draw();
          })
          .finally(() => {
            reopen.disabled = false;
          });
      });
      exited.append(title, detail, reopen);
      shell.append(exited);
    } else if (descriptor.url) {
      const frame = document.createElement('iframe');
      frame.src = descriptor.url;
      frame.title = `${descriptor.name} web UI`;
      frame.referrerPolicy = 'no-referrer';
      frame.setAttribute(
        'sandbox',
        'allow-downloads allow-forms allow-modals allow-popups allow-scripts allow-same-origin'
      );
      shell.append(frame);
    }

    const strip = document.createElement('footer');
    strip.className = 'appliance-app-status';
    stripLeft = document.createElement('span');
    stripRight = document.createElement('span');
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
  };

  function updateStatusStrip() {
    if (stripLeft) stripLeft.textContent = appWindowStatusText(descriptor);
    if (stripRight) stripRight.textContent = `${descriptor.name} ${descriptor.version} · ${descriptor.license}`;
  }
}

function isTerminal(descriptor: RuntimeAppWindowDescriptor): boolean {
  return descriptor.state === 'stopped' || descriptor.state === 'exited' || descriptor.state === 'failed';
}

function wrapperCsp(descriptor: RuntimeAppWindowDescriptor): string {
  const frame = descriptor.hostPort == null ? "'none'" : `http://127.0.0.1:${descriptor.hostPort}`;
  return `default-src 'none'; frame-src ${frame}; style-src 'unsafe-inline'; img-src data:`;
}

const APP_WINDOW_CSS = `
  :root { color-scheme: dark; font-family: "Geist Variable", Geist, ui-sans-serif, system-ui, sans-serif; }
  * { box-sizing: border-box; }
  html, body, #root { width: 100%; height: 100%; margin: 0; overflow: hidden; background: hsl(0 0% 4%); color: hsl(0 0% 93%); }
  .appliance-app-window { display: grid; grid-template-rows: minmax(0, 1fr) 28px; width: 100%; height: 100%; }
  .appliance-app-window iframe { width: 100%; height: 100%; border: 0; background: hsl(0 0% 7%); }
  .appliance-app-status { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-width: 0; padding: 0 10px; border-top: 1px solid hsl(0 0% 18%); background: hsl(0 0% 7%); color: hsl(0 0% 63%); font: 11px/28px "Geist Mono Variable", "SFMono-Regular", monospace; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .appliance-app-status span { overflow: hidden; text-overflow: ellipsis; }
  .appliance-app-status span:first-child::first-letter { color: hsl(189 85% 70%); }
  .appliance-app-exited { align-self: center; justify-self: center; width: min(420px, calc(100% - 48px)); padding: 28px; border: 1px solid hsl(0 0% 18%); border-radius: 6px; background: hsl(0 0% 7%); text-align: center; }
  .appliance-app-exited h1 { margin: 0; font-size: 20px; font-weight: 600; }
  .appliance-app-exited p { margin: 8px 0 20px; color: hsl(0 0% 63%); font-size: 13px; }
  .appliance-app-exited button { border: 0; border-radius: 5px; padding: 7px 13px; background: hsl(0 0% 93%); color: hsl(0 0% 4%); font: 600 12px/16px inherit; cursor: pointer; }
  .appliance-app-exited button:disabled { cursor: default; opacity: .5; }
`;
