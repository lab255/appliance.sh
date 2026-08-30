import { Router } from 'express';
import {
  getSelfUpdateSchedulerService,
  selfUpdateCheckEventSchema,
} from '../../services/self-update-scheduler.service';
import { logger } from '../../logger';

/** Lambda Web Adapter pass-through endpoint for direct, non-HTTP invocations. */
export const eventRoutes: Router = Router();

eventRoutes.post('/', async (req, res) => {
  const parsed = selfUpdateCheckEventSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn('worker event rejected: invalid fixed payload', { issueCount: parsed.error.issues.length });
    res.status(400).json({ error: 'Invalid worker event payload' });
    return;
  }
  const outcome = await getSelfUpdateSchedulerService().check();
  res.status(200).json({ ok: true, outcome });
});
