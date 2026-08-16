import { Router } from 'express';
import { deploymentInput } from '@appliance.sh/sdk';
import { deploymentService, EnvironmentBusyError } from '../../services/deployment.service';
import { apiKeyService } from '../../services/api-key.service';
import { logger } from '../../logger';

export const deploymentRoutes: Router = Router();

deploymentRoutes.post('/', async (req, res) => {
  try {
    const input = deploymentInput.parse(req.body);
    if (input.target?.type === 'edge' && req.apiKeyRole !== 'admin') {
      res.status(403).json({ error: 'Edge provisioning requires an admin key' });
      return;
    }
    logger.info('deployment started', {
      requestId: req.requestId,
      environmentId: input.environmentId,
      action: input.action,
      buildId: input.buildId,
    });

    // The worker dispatch re-signs the internal request with the same
    // API key the caller used here, so the worker verifies against the
    // shared api-key store instead of a separate shared secret. Fetch
    // the full key now while the request context is still in scope.
    if (!req.apiKeyId) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const callerKey = await apiKeyService.getByKeyId(req.apiKeyId);
    if (!callerKey) {
      res.status(401).json({ error: 'Api key not found' });
      return;
    }

    const deployment = await deploymentService.execute(input, {
      keyId: callerKey.id,
      secret: callerKey.secret,
    });
    logger.info('deployment dispatched', {
      requestId: req.requestId,
      deploymentId: deployment.id,
      status: deployment.status,
    });
    res.status(201).json(deployment);
  } catch (error) {
    if (error instanceof EnvironmentBusyError) {
      logger.warn('deployment rejected: environment busy', {
        requestId: req.requestId,
        error: error.message,
      });
      res.status(409).json({ error: 'Environment busy' });
      return;
    }
    logger.error('execute deployment failed', error, { requestId: req.requestId });
    res.status(400).json({ error: 'Failed to execute deployment' });
  }
});

// Ordered before the :id route so `/deployments/` with no id falls
// through to list instead of getting parsed as an empty id.
deploymentRoutes.get('/', async (req, res) => {
  try {
    const limit = parseIntParam(req.query.limit);
    const offset = parseIntParam(req.query.offset);
    const environmentId = typeof req.query.environmentId === 'string' ? req.query.environmentId : undefined;
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;

    const deployments = await deploymentService.list({ limit, offset, environmentId, projectId });
    res.json(deployments);
  } catch (error) {
    logger.error('list deployments failed', error, { requestId: req.requestId });
    res.status(500).json({ error: 'Failed to list deployments', message: String(error) });
  }
});

deploymentRoutes.get('/:id', async (req, res) => {
  try {
    const deployment = await deploymentService.get(req.params.id);
    if (!deployment) {
      res.status(404).json({ error: 'Deployment not found' });
      return;
    }
    res.json(deployment);
  } catch (error) {
    logger.error('get deployment failed', error, { requestId: req.requestId, deploymentId: req.params.id });
    res.status(500).json({ error: 'Failed to get deployment', message: String(error) });
  }
});

deploymentRoutes.post('/:id/continue', async (req, res) => {
  try {
    if (req.apiKeyRole !== 'admin' || !req.apiKeyId) {
      res.status(403).json({ error: 'Edge continuation requires an admin key' });
      return;
    }
    const callerKey = await apiKeyService.getByKeyId(req.apiKeyId);
    if (!callerKey) {
      res.status(401).json({ error: 'Api key not found' });
      return;
    }
    const deployment = await deploymentService.continueEdge(req.params.id, {
      keyId: callerKey.id,
      secret: callerKey.secret,
    });
    if (!deployment) {
      res.status(404).json({ error: 'Deployment not found' });
      return;
    }
    res.status(202).json(deployment);
  } catch (error) {
    logger.error('continue edge deployment failed', error, { requestId: req.requestId, deploymentId: req.params.id });
    res.status(409).json({ error: 'Failed to continue edge deployment', message: String(error) });
  }
});

deploymentRoutes.post('/:id/cancel', async (req, res) => {
  try {
    const force = req.body?.force === true;
    const deployment = await deploymentService.cancel(req.params.id, { force });
    if (!deployment) {
      res.status(404).json({ error: 'Deployment not found' });
      return;
    }
    // Cooperative cancel: 202 — worker observes the flag on its next
    // status poll and converges to a terminal status.
    // Force cancel: 200 — terminal status is already written.
    res.status(force ? 200 : 202).json(deployment);
  } catch (error) {
    logger.error('cancel deployment failed', error, { requestId: req.requestId, deploymentId: req.params.id });
    res.status(500).json({ error: 'Failed to cancel deployment', message: String(error) });
  }
});

function parseIntParam(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}
