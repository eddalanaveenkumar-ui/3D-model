import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import { getConfig } from '../config/env.js';

function clientKey(req: Request): string {
  if (req.user?.id) return `user:${req.user.id}`;
  return `ip:${req.ip || req.socket.remoteAddress || 'unknown'}`;
}

export function createApiRateLimiter() {
  return rateLimit({
    windowMs: getConfig().apiRateLimitWindowMs,
    limit: () => getConfig().apiRateLimitMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: clientKey,
    message: {
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many API requests. Please wait a moment and try again.',
      },
    },
  });
}

export function createGenerationRateLimiter() {
  return rateLimit({
    windowMs: getConfig().generationRateLimitWindowMs,
    limit: () => getConfig().generationRateLimitMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: clientKey,
    message: {
      error: {
        code: 'GENERATION_RATE_LIMITED',
        message:
          'Generation rate limit reached. Please wait a minute before submitting additional 3D jobs.',
      },
    },
  });
}

export function createAuthRateLimiter() {
  return rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
      error: {
        code: 'AUTH_RATE_LIMITED',
        message: 'Too many authentication attempts. Please wait a minute and retry.',
      },
    },
  });
}
