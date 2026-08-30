import * as React from 'react';
import { Link } from 'react-router';
import type { AuthFailureCause } from '@appliance.sh/sdk';
import { parseStructuredHttpError } from '@/lib/http-error';
import { Banner } from '@/components/ui/banner';
import { LogPane } from '@/components/ui/log-pane';

// The friendly error layer: every surface that used to dump a raw
// `err.message` in red monospace renders this instead — a plain-language
// headline inferred from the error's shape, with the raw text demoted
// behind a collapsed "Details" disclosure. The audience includes
// non-technical users; the raw message stays one click away for the
// operator (and for bug reports).

export type FriendlyErrorKind = 'network' | 'auth' | 'install' | 'wsl' | 'unknown';

/** Best-effort message text from an unknown thrown/rejected value. */
export function errorText(error: unknown): string {
  if (error == null) return '';
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

const AUTH_CAUSES: ReadonlySet<string> = new Set([
  'missing_signature',
  'missing_digest',
  'digest_mismatch',
  'invalid_host',
  'unknown_key',
  'clock_skew',
  'malformed_signature',
  'signature_mismatch',
] satisfies AuthFailureCause[]);

/** The server's machine-readable auth-failure cause, when the error
 *  carries a cause-bearing 401 body (newer api-servers). Undefined on
 *  cause-less older servers — callers keep `isAuthShapedError` as the
 *  text-shape fallback. */
export function authFailureCause(error: unknown): AuthFailureCause | undefined {
  const parsed = parseStructuredHttpError(errorText(error));
  const cause = parsed?.cause;
  return cause && AUTH_CAUSES.has(cause) ? (cause as AuthFailureCause) : undefined;
}

/** Does an error look like an UPSTREAM auth rejection (401/403, bad or
 *  expired key, signature mismatch)? Shared by the classifier and the
 *  global auth-expiry signal (the query cache's error handler). */
export function isAuthShapedError(error: unknown): boolean {
  const m = errorText(error).toLowerCase();
  return (
    /(^|[^0-9])(401|403)([^0-9]|$)/.test(m) ||
    m.includes('unauthorized') ||
    m.includes('forbidden') ||
    m.includes('signature') ||
    m.includes('authentication_error') ||
    m.includes('invalid api key') ||
    m.includes('invalid x-api-key') ||
    m.includes('token expired') ||
    m.includes('token has expired') ||
    m.includes('rejected these credentials')
  );
}

/** Infer a coarse error category from the error's shape. Call sites that
 *  know the operation (VM boot, deploy, update) pass a context-specific
 *  `fallbackHeadline` for the `unknown` bucket instead. */
export function classifyError(error: unknown): FriendlyErrorKind {
  if (isAuthShapedError(error)) return 'auth';
  const m = errorText(error).toLowerCase();
  if (
    /econnrefused|econnreset|enotfound|etimedout|ehostunreach|enetunreach|failed to fetch|fetch failed|networkerror|network error|load failed|could not reach|did not respond|timed out|connection refused|connection reset|socket hang up/.test(
      m
    )
  ) {
    return 'network';
  }
  // WSL/virtualization boot failures carry their fix in the message
  // (`wsl --install`, enable virtualization) — surface it as the
  // headline instead of burying it behind the Details disclosure, or a
  // non-developer just sees "couldn't start" and retries into the same
  // wall. Matches the engine's wording (packages/vm/src/backend/wsl.rs).
  if (/\bwsl\b|virtual machine platform|virtualization|hyper-v|0x80370102/.test(m)) return 'wsl';
  if (/install/.test(m) && /engine|binary|appliance-vm|runtime/.test(m)) return 'install';
  return 'unknown';
}

const HEADLINES: Record<FriendlyErrorKind, string> = {
  network: "Can't reach the server — check that the machine is running",
  auth: "Your access key isn't valid anymore — reconnect to continue",
  install: "The local runtime couldn't be installed",
  wsl: 'Windows needs WSL2 to run the Dev Machine — and it isn’t ready yet',
  unknown: 'Something went wrong',
};

/** Inline how-to-fix line for classes whose fix is knowable without the
 *  raw details. Rendered under the headline, above any actions. */
const FIX_LINES: Partial<Record<FriendlyErrorKind, string>> = {
  wsl:
    'Open PowerShell as Administrator, run `wsl --install`, then reboot. ' +
    'If it still fails, enable virtualization in your BIOS/UEFI and run `wsl --update`.',
};

/**
 * Plain-language error card: a friendly headline (inferred from the error
 * shape, or overridden by the call site), optional page-specific actions
 * (Retry buttons, CTAs), and the raw error text behind a collapsed
 * "Details" disclosure. Auth-shaped errors get a Reconnect link to the
 * connect page unless the page brings its own re-login affordance.
 */
export function FriendlyError({
  error,
  headline,
  fallbackHeadline,
  actions,
  hideReconnect,
  className,
}: {
  error: unknown;
  /** Hard headline override (terse operator-facing panels). */
  headline?: string;
  /** Headline for errors that don't classify — the call site knows the
   *  operation ("The local machine couldn't start", …). */
  fallbackHeadline?: string;
  /** Page-specific actions (Retry, Start over, …) rendered below. */
  actions?: React.ReactNode;
  /** Suppress the built-in Reconnect link on auth-shaped errors, for
   *  pages with their own re-login affordance. */
  hideReconnect?: boolean;
  className?: string;
}) {
  const kind = classifyError(error);
  const line = headline ?? (kind === 'unknown' && fallbackHeadline ? fallbackHeadline : HEADLINES[kind]);
  const raw = errorText(error);
  const fix = FIX_LINES[kind];

  return (
    <Banner tone="error" title={line} className={className} action={actions}>
      {fix ? <div>{fix}</div> : null}
      {kind === 'auth' && !hideReconnect ? (
        <Link
          to="/setup/connect"
          className="mt-1 inline-block rounded text-xs underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
        >
          Reconnect
        </Link>
      ) : null}
      {raw && raw !== line ? (
        <LogPane className="mt-2" height="compact" label="Technical details" copyText={raw}>
          {raw}
        </LogPane>
      ) : null}
    </Banner>
  );
}
