import { Router } from 'express';
import {
  getSelfUpdateSchedulerService,
  selfUpdateCheckEventSchema,
} from '../../services/self-update-scheduler.service';
import { logger } from '../../logger';

/** Lambda Web Adapter pass-through endpoint for direct, non-HTTP invocations. */
export const eventRoutes: Router = Router();

eventRoutes.post('/', async (req, res) => {
  // Lambda Web Adapter adds this header for Function URL requests but not
  // for direct Lambda invokes forwarded through its pass-through path. Keep
  // the public worker URL from becoming an unauthenticated check trigger.
  if (req.headers['x-amzn-request-context']) {
    res.status(404).end();
    return;
  }
  const parsed = selfUpdateCheckEventSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn('worker event rejected: invalid fixed payload', { issueCount: parsed.error.issues.length });
    res.status(400).json({ error: 'Invalid worker event payload' });
    return;
  }
  const outcome = await getSelfUpdateSchedulerService().check();
  logger.info('worker self-update check completed', { outcome });
  res.status(200).json({ ok: true });
});
