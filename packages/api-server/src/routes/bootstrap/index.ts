import { Router } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import { apiKeyInput, inviteRedeemInput, VERSION } from '@appliance.sh/sdk';
import { apiKeyService } from '../../services/api-key.service';
import { inviteService } from '../../services/invite.service';
import { logger } from '../../logger';
import { getSelfUpdateSchedulerService, selfUpdatePolicy } from '../../services/self-update-scheduler.service';
import { DEFAULT_TENANT, runWithTenant } from '../../services/tenant-context';
import { redactSelfUpdateError } from '../../services/self-update-redaction';

function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export const bootstrapRoutes: Router = Router();

bootstrapRoutes.post('/create-key', async (req, res) => {
  try {
    if (await apiKeyService.exists()) {
      res.status(409).json({ error: 'Appliance is already initialized' });
      return;
    }

    const bootstrapToken = process.env.BOOTSTRAP_TOKEN;
    if (!bootstrapToken) {
      res.status(500).json({ error: 'Bootstrap token not configured' });
      return;
    }

    const providedToken = req.headers['x-bootstrap-token'] as string | undefined;
    if (!providedToken || !constantTimeEqual(providedToken, bootstrapToken)) {
      logger.warn('bootstrap auth failed', { requestId: req.requestId });
      res.status(403).json({ error: 'Invalid bootstrap token' });
      return;
    }

    const input = apiKeyInput.parse(req.body);
    const result = await apiKeyService.create(input.name);
    logger.info('api key created', { requestId: req.requestId, keyName: input.name });
    res.status(201).json(result);
  } catch (error) {
    logger.error('create key failed', error, { requestId: req.requestId });
    res.status(400).json({ error: 'Failed to create API key', message: String(error) });
  }
});

/**
 * Redeem a single-use invite token for a fresh API key. Unauthenticated
 * by design — the redeeming teammate has no key yet; the token itself
 * is the credential. Failure modes are distinguished so the console can
 * tell the user something actionable: 404 unknown, 410 already used or
 * expired (ask the inviter for a new link).
 */
bootstrapRoutes.post('/redeem-invite', async (req, res) => {
  try {
    const input = inviteRedeemInput.parse(req.body);
    const result = await inviteService.redeem(input.token);
    if (!result.ok) {
      if (result.reason === 'not-found') {
        res.status(404).json({ error: 'This invite link is not valid — check it was copied completely' });
        return;
      }
      const message =
        result.reason === 'redeemed'
          ? 'This invite link was already used — ask for a new one'
          : 'This invite link has expired — ask for a new one';
      res.status(410).json({ error: message });
      return;
    }
    logger.info('invite redeemed', { requestId: req.requestId, newKeyId: result.key.id, keyName: result.key.name });
    res.status(201).json(result.key);
  } catch (error) {
    logger.error('redeem invite failed', error, { requestId: req.requestId });
    res.status(400).json({ error: 'Failed to redeem invite', message: String(error) });
  }
});

bootstrapRoutes.get('/status', async (req, res) => {
  try {
    const initialized = await apiKeyService.exists();
    let selfUpdateAvailable = false;
    if (selfUpdatePolicy() === 'notify') {
      try {
        selfUpdateAvailable = Boolean(
          await runWithTenant(DEFAULT_TENANT, () => getSelfUpdateSchedulerService().getAvailable())
        );
      } catch (error) {
        // This optional boolean must never break the bootstrap health probe.
        logger.warn('bootstrap self-update marker unavailable', { error: redactSelfUpdateError(error).message });
      }
    }
    // serverVersion rides the one unauthenticated probe every client
    // already polls, so version skew is observable before any
    // credential exists (cluster-info needs a signed request). Engine-
    // side consumption is deferred; additive + optional for clients.
    res.json({ initialized, serverVersion: VERSION, selfUpdateAvailable });
  } catch (error) {
    logger.error('bootstrap status check failed', error, { requestId: req.requestId });
    res.status(500).json({ error: 'Failed to check bootstrap status', message: String(error) });
  }
});
