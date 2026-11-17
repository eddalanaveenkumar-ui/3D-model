import { Router } from 'express';
import { clearSessionCookie, ensureStudioUser } from '../middleware/auth.js';
import { getUserCredits } from '../services/authService.js';

/**
 * Zero-login workspace session router.
 * Sign-up and password login are intentionally disabled: every browser automatically
 * receives an isolated anonymous studio session with no account creation required.
 */
export function createAuthRouter(): Router {
  const router = Router();

  router.get('/me', ensureStudioUser, (req, res) => {
    res.json({ user: req.user });
  });

  router.get('/credits', ensureStudioUser, async (req, res, next) => {
    try {
      const credits = await getUserCredits(req.user!.id);
      res.json({ credits });
    } catch (err) {
      next(err);
    }
  });

  router.post('/reset-session', (_req, res) => {
    clearSessionCookie(res);
    res.json({ reset: true });
  });

  return router;
}
