import { Router, type RequestHandler } from 'express';
import { DEFAULT_TENANT } from '../../services/tenant-context';
import { apiKeyService } from '../../services/api-key.service';
import {
  getSelfUpdateService,
  selfUpdateRequestSchema,
  SelfUpdateConflictError,
  type SelfUpdateService,
} from '../../services/self-update.service';
import { logger } from '../../logger';

export const requireOwnerTenant: RequestHandler = (req, res, next) => {
  if (req.tenantId !== DEFAULT_TENANT) {
    logger.warn('authz failed: owner tenant required', {
      requestId: req.requestId,
      path: req.originalUrl,
      keyId: req.apiKeyId,
      tenantId: req.tenantId,
    });
    res.status(403).json({ error: 'Control-plane self-update requires the owner tenant' });
    return;
  }
  next();
};

export function createSelfUpdateRoutes(resolveService: () => SelfUpdateService = getSelfUpdateService): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    if (!process.env.SELF_UPDATE_ROLE_ARN) {
      res.status(503).json({
        error:
          'Self-update requires scoped system roles; run appliance cloud baseline-update --system-role-mode scoped',
      });
      return;
    }
    const parsed = selfUpdateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid self-update request' });
      return;
    }
    if (!req.apiKeyId || !req.tenantId) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const caller = await apiKeyService.getByKeyId(req.apiKeyId);
    if (!caller) {
      res.status(401).json({ error: 'Api key not found' });
      return;
    }
    try {
      const { job } = await resolveService().create(
        parsed.data,
        { keyId: caller.id, tenantId: req.tenantId, secret: caller.secret },
        req.get('idempotency-key')
      );
      const statusUrl = `/api/v1/self-update/${job.id}`;
      res.status(202).json({ jobId: job.id, status: job.status, statusUrl });
    } catch (error) {
      if (error instanceof SelfUpdateConflictError) {
        res.status(409).json({
          jobId: error.jobId,
          statusUrl: `/api/v1/self-update/${error.jobId}`,
        });
        return;
      }
      const code = trustErrorCode(error);
      if (code) {
        logger.warn('self-update release rejected', { requestId: req.requestId, keyId: req.apiKeyId, code });
        res.status(400).json({
          error:
            code === 'unknown-key'
              ? 'Release signing trust is not provisioned; AP-226 must pin the production key'
              : 'Release evidence rejected',
          code,
        });
        return;
      }
      logger.error('create self-update job failed', redactSelfUpdateError(error), {
        requestId: req.requestId,
        keyId: req.apiKeyId,
      });
      res.status(400).json({ error: 'Failed to create self-update job' });
    }
  });

  router.get('/:jobId', async (req, res) => {
    if (!req.apiKeyId || !req.tenantId) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    try {
      const service = resolveService();
      let job = await service.get(req.params.jobId);
      if (!job) {
        res.status(404).json({ error: 'Self-update job not found' });
        return;
      }
      if (job.ownerTenantId !== req.tenantId) {
        res.status(403).json({ error: 'Self-update job belongs to another tenant' });
        return;
      }
      if (job.status !== 'failed' && job.status !== 'succeeded') {
        const originalCaller = await apiKeyService.getByKeyId(job.callerKeyId);
        if (originalCaller) {
          job =
            (await service.getAndResume(job.id, { keyId: originalCaller.id, secret: originalCaller.secret })) ?? job;
        } else {
          logger.warn('self-update original caller key unavailable; job remains resumable', {
            requestId: req.requestId,
            jobId: job.id,
            callerKeyId: job.callerKeyId,
          });
        }
      }
      res.json(service.publicJob(job));
    } catch (error) {
      logger.error('get self-update job failed', redactSelfUpdateError(error), {
        requestId: req.requestId,
        keyId: req.apiKeyId,
        jobId: req.params.jobId,
      });
      res.status(500).json({ error: 'Failed to get self-update job' });
    }
  });

  return router;
}

export const selfUpdateRoutes = createSelfUpdateRoutes();

function trustErrorCode(error: unknown): string | undefined {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/** Named CU1 redaction set. Error text is scrubbed before it reaches logs/job status. */
export function redactSelfUpdateError(error: unknown, exactSecrets: readonly string[] = []): Error {
  const raw = error instanceof Error ? error.message : String(error);
  let redacted = raw;
  for (const secret of exactSecrets) {
    if (secret) redacted = redacted.replaceAll(secret, '[REDACTED_ECR_TOKEN]');
  }
  redacted = redacted
    .replace(/arn:[a-z0-9-]*:[^\s"']+/gi, '[REDACTED_ARN]')
    .replace(/(?:Basic|Bearer)\s+[A-Za-z0-9+/=_-]+/gi, '[REDACTED_ECR_TOKEN]')
    .replace(/\b\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\b/gi, '[REDACTED_ECR_REGISTRY]')
    .replace(/arn:[^\s,]+:iam::\d{12}:role\/[^\s,]+/gi, '[REDACTED_ROLE_ARN]')
    .replace(/\bself-update-[A-Za-z0-9_-]+\b/g, '[REDACTED_ROLE_SESSION]')
    .replace(/(signature|signature-input|authorization|content-digest|x-api-key)\s*[:=]\s*[^\s,}]+/gi, '$1=[REDACTED]')
    .replace(/("?(?:envelope|sig)"?\s*:\s*)"[^"]+"/gi, '$1"[REDACTED]"')
    .replace(/\b\d{12}\b/g, '[REDACTED_ACCOUNT]');
  return new Error(redacted);
}
