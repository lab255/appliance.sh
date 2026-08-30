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
    const caller = await apiKeyService.getByKeyId(req.apiKeyId);
    if (!caller) {
      res.status(401).json({ error: 'Api key not found' });
      return;
    }
    try {
      const job = await resolveService().getAndResume(req.params.jobId, { keyId: caller.id, secret: caller.secret });
      if (!job) {
        res.status(404).json({ error: 'Self-update job not found' });
        return;
      }
      if (job.ownerTenantId !== req.tenantId) {
        res.status(403).json({ error: 'Self-update job belongs to another tenant' });
        return;
      }
      res.json(resolveService().publicJob(job));
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
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Named CU1 redaction set. Error text is scrubbed before it reaches logs/job status. */
export function redactSelfUpdateError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = raw
    .replace(/(?:Basic|Bearer)\s+[A-Za-z0-9+/=_-]+/gi, '[REDACTED_ECR_TOKEN]')
    .replace(/\b\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\b/gi, '[REDACTED_ECR_REGISTRY]')
    .replace(/arn:[^\s,]+:iam::\d{12}:role\/[^\s,]+/gi, '[REDACTED_ROLE_ARN]')
    .replace(/\bself-update-[A-Za-z0-9_-]+\b/g, '[REDACTED_ROLE_SESSION]')
    .replace(/(signature|signature-input|authorization|content-digest|x-api-key)\s*[:=]\s*[^\s,}]+/gi, '$1=[REDACTED]')
    .replace(/(?:"?(?:envelope|sig)"?\s*:\s*)"[^"]+"/gi, '$1"[REDACTED]"');
  return new Error(redacted);
}
