import { Router } from 'express';
import { z } from 'zod';
import {
  clearSessionCookie,
  ensureStudioUser,
  resolveOptionalUserId,
  setSessionCookie,
} from '../middleware/auth.js';
import { createAuthRateLimiter } from '../middleware/rateLimit.js';
import {
  getUserCredits,
  loginUser,
  registerUser,
} from '../services/authService.js';

const RegisterSchema = z.object({
  email: z.string().email().max(180),
  password: z.string().min(8).max(128),
  displayName: z.string().min(2).max(80),
});

const LoginSchema = z.object({
  email: z.string().email().max(180),
  password: z.string().min(1).max(128),
});

export function createAuthRouter(): Router {
  const router = Router();
  const authLimiter = createAuthRateLimiter();

  router.post('/register', authLimiter, async (req, res, next) => {
    try {
      const body = RegisterSchema.parse(req.body);
      const currentUserId = await resolveOptionalUserId(req);
      const { user, token } = await registerUser({
        email: body.email,
        password: body.password,
        displayName: body.displayName,
        upgradeGuestUserId: currentUserId,
      });
      setSessionCookie(res, token);
      res.status(201).json({ user, token });
    } catch (err) {
      next(err);
    }
  });

  router.post('/login', authLimiter, async (req, res, next) => {
    try {
      const body = LoginSchema.parse(req.body);
      const { user, token } = await loginUser(body.email, body.password);
      setSessionCookie(res, token);
      res.json({ user, token });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', (_req, res) => {
    clearSessionCookie(res);
    res.json({ loggedOut: true });
  });

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

  return router;
}
