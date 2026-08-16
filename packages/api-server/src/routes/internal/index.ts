import { Router } from 'express';
import { executeDeployment, workerEventSchema } from '../../services/deployment-executor.service';
import { logger } from '../../logger';

export const internalRoutes: Router = Router();

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
