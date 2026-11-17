import { Router } from 'express';
import { ensureStudioUser } from '../middleware/auth.js';
import { listUserHistory } from '../services/historyService.js';
import { listJobsForUser } from '../services/jobManagerService.js';

export function createHistoryRouter(): Router {
  const router = Router();

  router.get('/', ensureStudioUser, async (req, res, next) => {
    try {
      const limit = Number.parseInt(String(req.query.limit || '50'), 10) || 50;
      const [history, jobs] = await Promise.all([
        listUserHistory(req.user!.id, limit),
        listJobsForUser(req.user!.id, Math.min(limit, 50)),
      ]);
      res.json({ history, jobs });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
