import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { verifySignedRequest, computeContentDigest, type ApiKeyRole } from '@appliance.sh/sdk';
import { apiKeyService, roleOf } from '../services/api-key.service';
import { DEFAULT_TENANT, runWithTenant, tenantIdForKey } from '../services/tenant-context';
import { logger } from '../logger';

/**
 * Verify HTTP Message Signatures (RFC 9421) against the shared api-key
 * store. Used for both data-plane `/api/v1/*` routes and the internal
 * server→worker `/api/internal/*` routes — the server re-signs each worker
 * dispatch with the original caller's key, so both sides share the same
 * key lookup.
 *
 * Every 401 body carries `{ error, cause }` (AuthFailureCause) so
 * clients pick the right recovery instead of guessing from opaque text.
 * Deliberate disclosure trade-off: `unknown_key` vs `signature_mismatch`
 * lets an unauthenticated caller probe whether a key id exists (an
 * oracle) — accepted for a local appliance, where the self-heal path
 * needs exactly that distinction to know re-minting will help.
 */
export async function signatureAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const signature = req.headers['signature'];
  const signatureInput = req.headers['signature-input'];

  if (!signature || !signatureInput) {
    logger.warn('auth failed: missing signature headers', { requestId: req.requestId, path: req.originalUrl });
    res.status(401).json({ error: 'Missing signature headers', cause: 'missing_signature' });
    return;
  }

  if (req.rawBody && req.rawBody.length > 0) {
    const contentDigest = req.headers['content-digest'] as string | undefined;
    if (!contentDigest) {
      logger.warn('auth failed: missing content-digest', { requestId: req.requestId, path: req.originalUrl });
      res.status(401).json({ error: 'Missing Content-Digest header', cause: 'missing_digest' });
      return;
    }

    const expected = await computeContentDigest(req.rawBody.toString());
    if (
      contentDigest.length !== expected.length ||
      !timingSafeEqual(Buffer.from(contentDigest), Buffer.from(expected))
    ) {
      logger.warn('auth failed: content-digest mismatch', { requestId: req.requestId, path: req.originalUrl });
      res.status(401).json({ error: 'Request body does not match its Content-Digest', cause: 'digest_mismatch' });
      return;
    }
  }

  const rawHost = req.app.get('trust proxy') ? req.get('x-forwarded-host') || req.get('host') : req.get('host');
  const host = /^[a-zA-Z0-9._-]+(:\d+)?$/.test(rawHost ?? '') ? rawHost : undefined;
  if (!host) {
    logger.warn('auth failed: invalid host header', { requestId: req.requestId, path: req.originalUrl });
    res.status(401).json({ error: 'Invalid Host header', cause: 'invalid_host' });
    return;
  }
  const url = `${req.protocol}://${host}${req.originalUrl}`;

  // Resolve the owning principal (tenant) from the SERVER-STORED key as a
  // side effect of the signature-verification lookup — never from a
  // client-asserted header/body. A legacy key maps to the default tenant.
  let principalTenantId: string | undefined;
  // Captured by the key-lookup callback so the verified request can
  // carry its role without a second storage read.
  let resolvedRole: ApiKeyRole | undefined;

  const result = await verifySignedRequest(
    {
      method: req.method,
      url,
      headers: req.headers as Record<string, string | string[]>,
    },
    async (keyId: string) => {
      const key = await apiKeyService.getByKeyId(keyId);
      if (!key) return null;
      principalTenantId = tenantIdForKey(key);
      resolvedRole = roleOf(key);
      return { secret: key.secret };
    }
  );

  if (!result.verified) {
    logger.warn('auth failed: invalid signature', {
      requestId: req.requestId,
      path: req.originalUrl,
      error: result.error,
      cause: result.cause,
      diag: buildAuthDiag(req, url),
    });
    // Human message per cause; the raw verifier error stays in the log
    // only (it can echo header internals).
    const messages: Record<string, string> = {
      unknown_key: 'This API key is not recognized by the server',
      clock_skew: 'Request timestamp outside the accepted window (client/server clock skew)',
      malformed_signature: 'Request signature is malformed',
      signature_mismatch: 'Request signature does not match',
    };
    res.status(401).json({
      error: (result.cause && messages[result.cause]) || 'Unauthorized',
      ...(result.cause ? { cause: result.cause } : {}),
    });
    return;
  }

  req.apiKeyId = result.keyId;
  // principalTenantId was set (already defaulted via tenantIdForKey) when
  // the key resolved during verification; default once more defensively.
  const tenantId = principalTenantId ?? DEFAULT_TENANT;
  req.tenantId = tenantId;
  req.apiKeyRole = resolvedRole;

  if (result.keyId) {
    apiKeyService.updateLastUsed(result.keyId).catch(() => {});
  }

  // Establish the tenant scope for the ENTIRE downstream request by
  // construction. Because every authenticated route mounts this one
  // middleware, there is no per-route opt-in to forget — an unguarded
  // route cannot exist without also skipping auth. The storage choke
  // point reads this ambient tenant; outside it (multi-tenant on, no
  // context) keyed access fails closed.
  runWithTenant(tenantId, () => next());
}

/**
 * Gate a route on the calling key's role. Runs after `signatureAuth`,
 * which attaches `req.apiKeyRole`. Member keys get the data plane only;
 * key/invite management stays admin-only so a teammate's leaked key
 * cannot enumerate or revoke other credentials.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.apiKeyRole !== 'admin') {
    logger.warn('authz failed: admin role required', {
      requestId: req.requestId,
      path: req.originalUrl,
      keyId: req.apiKeyId,
      role: req.apiKeyRole,
    });
    res.status(403).json({ error: 'This action needs an admin key' });
    return;
  }
  next();
}

// Redacted snapshot of the inbound request to help diagnose signature
// mismatches. No secrets, no signature bytes — just the derivation
// inputs (method, URL, headers that affect @authority / @path /
// trust-proxy behavior) plus a list of header names so we can spot
// missing/unexpected fields.
function buildAuthDiag(req: Request, reconstructedUrl: string): Record<string, unknown> {
  return {
    method: req.method,
    originalUrl: req.originalUrl,
    reconstructedUrl,
    protocol: req.protocol,
    trustProxy: req.app.get('trust proxy'),
    host: req.get('host'),
    xForwardedHost: req.get('x-forwarded-host'),
    xForwardedProto: req.get('x-forwarded-proto'),
    xForwardedFor: req.get('x-forwarded-for'),
    // CU1 redaction: never log values from signature/key headers. Presence
    // is enough to diagnose reconstruction without retaining signed bytes.
    signatureInputPresent: typeof req.headers['signature-input'] === 'string',
    signaturePresent: typeof req.headers['signature'] === 'string',
    contentDigestPresent: typeof req.headers['content-digest'] === 'string',
    headerNames: Object.keys(req.headers).sort(),
  };
}
