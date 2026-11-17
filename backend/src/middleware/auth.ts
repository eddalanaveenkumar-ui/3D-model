import type { NextFunction, Request, Response } from 'express';
import type { UserProfile } from '@nv3d/shared';
import { getConfig } from '../config/env.js';
import {
  AppError,
  createGuestUser,
  getUserProfile,
  verifyAuthToken,
} from '../services/authService.js';

export const AUTH_COOKIE_NAME = 'nv3d_session';

declare global {
  namespace Express {
    interface Request {
      user?: UserProfile;
      rawBody?: Buffer;
    }
  }
}

export function setSessionCookie(res: Response, token: string): void {
  const config = getConfig();
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    maxAge: config.jwtExpiresInDays * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
  });
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

/**
 * Resolve the authenticated user from Bearer JWT or HttpOnly session cookie.
 * If an explicit Authorization header is malformed/expired, reject with 401.
 * Otherwise, if no cookie is present yet, provision an isolated per-visitor
 * studio account in `users` + `user_credits` so every workspace action and file
 * is strictly user-scoped.
 */
export async function ensureStudioUser(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const bearer = extractBearerToken(req);
    if (bearer !== null) {
      if (!bearer) {
        throw new AppError(401, 'INVALID_TOKEN', 'Malformed Authorization header.');
      }
      const userId = verifyAuthToken(bearer);
      if (!userId) {
        throw new AppError(401, 'INVALID_TOKEN', 'Authentication token is invalid or expired.');
      }
      const profile = await getUserProfile(userId);
      if (!profile) {
        throw new AppError(401, 'USER_NOT_FOUND', 'Authenticated user account no longer exists.');
      }
      req.user = profile;
      next();
      return;
    }

    const cookieToken = req.cookies?.[AUTH_COOKIE_NAME];
    if (typeof cookieToken === 'string' && cookieToken.length > 0) {
      const userId = verifyAuthToken(cookieToken);
      if (userId) {
        const profile = await getUserProfile(userId);
        if (profile) {
          req.user = profile;
          next();
          return;
        }
      }
    }

    const guest = await createGuestUser();
    setSessionCookie(res, guest.token);
    res.setHeader('X-NV3D-Session', guest.token);
    req.user = guest.user;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Peek current user without auto-creating a guest (used during registration upgrade).
 */
export async function resolveOptionalUserId(req: Request): Promise<string | null> {
  const bearer = extractBearerToken(req);
  if (bearer) return verifyAuthToken(bearer);
  const cookieToken = req.cookies?.[AUTH_COOKIE_NAME];
  if (typeof cookieToken === 'string' && cookieToken) {
    return verifyAuthToken(cookieToken);
  }
  return null;
}
