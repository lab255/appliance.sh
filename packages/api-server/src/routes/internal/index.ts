import { Router } from 'express';
import { executeDeployment, workerEventSchema } from '../../services/deployment-executor.service';
import { getSelfUpdateService, selfUpdateWorkerEventSchema } from '../../services/self-update.service';
import { getSelfUpdateExecutor } from '../../services/self-update-executor.service';
import { redactSelfUpdateError } from '../../services/self-update-redaction';
import { logger } from '../../logger';
import {
  getSelfUpdateSchedulerService,
  selfUpdateCheckEventSchema,
} from '../../services/self-update-scheduler.service';
import { DEFAULT_TENANT } from '../../services/tenant-context';

export const internalRoutes: Router = Router();

internalRoutes.post('/self-update/check', async (req, res) => {
  const parsed = selfUpdateCheckEventSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid self-update check payload' });
    return;
  }
  if (req.apiKeyRole !== 'admin' || req.tenantId !== DEFAULT_TENANT) {
    res.status(403).json({ error: 'Self-update check requires an owner admin' });
    return;
  }
  try {
    const check = await getSelfUpdateSchedulerService().check();
    res.status(200).json({ decision: check.decision, reason: check.reason });
  } catch (error) {
    logger.error('self-update check failed', redactSelfUpdateError(error), { requestId: req.requestId });
    res.status(500).json({ error: 'Self-update check failed' });
  }
});

internalRoutes.post('/jobs/deployment', async (req, res) => {
  const parsed = workerEventSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn('worker job rejected: invalid payload', {
      requestId: req.requestId,
      issues: parsed.error.issues,
    });
    res.status(400).json({ error: 'Invalid worker event payload' });
    return;
  }
  const event = parsed.data;

  logger.info('worker job started', {
    requestId: req.requestId,
    deploymentId: event.deploymentId,
    action: event.input.action,
  });

  try {
    const outcome = await executeDeployment(event);
    logger.info('worker job completed', { requestId: req.requestId, deploymentId: event.deploymentId, outcome });
    res.status(outcome === 'continue' ? 202 : 200).json({ ok: true, outcome });
  } catch (error) {
    logger.error('worker job failed', error, { requestId: req.requestId, deploymentId: event.deploymentId });
    // Status is already persisted by executeDeployment; return 500 so retries can occur if needed.
    res.status(500).json({ error: 'Job execution failed' });
  }
});

internalRoutes.post('/jobs/self-update', async (req, res) => {
  const parsed = selfUpdateWorkerEventSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn('self-update worker job rejected: invalid payload', {
      requestId: req.requestId,
      issueCount: parsed.error.issues.length,
    });
    res.status(400).json({ error: 'Invalid self-update worker payload' });
    return;
  }
  const job = await getSelfUpdateService().get(parsed.data.jobId);
  if (!job) {
    res.status(404).json({ error: 'Self-update job not found' });
    return;
  }
  if (job.callerKeyId !== req.apiKeyId || job.ownerTenantId !== req.tenantId) {
    res.status(403).json({ error: 'Self-update job does not belong to this caller' });
    return;
  }
  try {
    const outcome = await getSelfUpdateExecutor().execute(job.id);
    res.status(200).json({ ok: true, outcome });
  } catch (error) {
    logger.error('self-update worker job failed', redactSelfUpdateError(error), {
      requestId: req.requestId,
      jobId: job.id,
      phase: job.phase,
    });
    res.status(500).json({ error: 'Self-update execution failed' });
  }
});
