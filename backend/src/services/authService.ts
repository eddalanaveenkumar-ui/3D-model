import crypto from 'node:crypto';
import type { CreditLedgerEntry, UserProfile } from '@nv3d/shared';
import { getConfig } from '../config/env.js';
import { getDb } from '../db/client.js';
import { sanitizePlainText } from './safetyService.js';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
  }
}

interface JwtPayload {
  sub: string;
  iat: number;
  exp: number;
}

const SCRYPT_KEYLEN = 64;

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hexHash] = parts;
  const expected = Buffer.from(hexHash, 'hex');
  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, expected.length, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(padLen), 'base64');
}

export function signAuthToken(userId: string): string {
  const config = getConfig();
  const now = Math.floor(Date.now() / 1000);
  const exp = now + config.jwtExpiresInDays * 24 * 60 * 60;
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(JSON.stringify({ sub: userId, iat: now, exp } satisfies JwtPayload));
  const signingInput = `${header}.${payload}`;
  const sig = crypto.createHmac('sha256', config.jwtSecret).update(signingInput).digest();
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

export function verifyAuthToken(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const config = getConfig();
    const expectedSig = crypto
      .createHmac('sha256', config.jwtSecret)
      .update(`${headerB64}.${payloadB64}`)
      .digest();
    const providedSig = base64UrlDecode(sigB64);
    if (providedSig.length !== expectedSig.length) return null;
    if (!crypto.timingSafeEqual(providedSig, expectedSig)) return null;

    const payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8')) as Partial<JwtPayload>;
    const now = Math.floor(Date.now() / 1000);
    if (!payload.sub || typeof payload.sub !== 'string') return null;
    if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  const db = getDb();
  const res = await db.query<{
    id: string;
    email: string;
    display_name: string;
    is_guest: boolean;
    created_at: string | Date;
    balance: number | null;
    total_generated: string | number;
  }>(
    `SELECT
       u.id,
       u.email,
       u.display_name,
       u.is_guest,
       u.created_at,
       c.balance,
       (SELECT COUNT(*) FROM generated_models gm WHERE gm.user_id = u.id AND gm.is_demo = FALSE) AS total_generated
     FROM users u
     LEFT JOIN user_credits c ON c.user_id = u.id
     WHERE u.id = $1`,
    [userId]
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    isGuest: Boolean(row.is_guest),
    credits: Number(row.balance ?? 0),
    totalGenerated: Number(row.total_generated ?? 0),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function createGuestUser(): Promise<{ user: UserProfile; token: string }> {
  const db = getDb();
  const config = getConfig();
  const userId = crypto.randomUUID();
  const creditId = crypto.randomUUID();
  const shortTag = userId.slice(0, 8);
  const email = `studio-${shortTag}@guest.nv3d.local`;
  const displayName = `Studio Artist ${shortTag.slice(0, 4).toUpperCase()}`;
  const randomPasswordHash = await hashPassword(crypto.randomBytes(32).toString('hex'));

  await db.transaction(async (tx) => {
    await tx(
      `INSERT INTO users (id, email, password_hash, display_name, is_guest)
       VALUES ($1, $2, $3, $4, TRUE)`,
      [userId, email, randomPasswordHash, displayName]
    );
    await tx(
      `INSERT INTO user_credits (
         id, user_id, balance, lifetime_granted, lifetime_spent,
         last_transaction_delta, last_transaction_reason
       ) VALUES ($1, $2, $3, $3, 0, $3, 'Studio starter credits')`,
      [creditId, userId, config.initialUserCredits]
    );
  });

  const user = await getUserProfile(userId);
  if (!user) throw new AppError(500, 'USER_CREATE_FAILED', 'Failed to initialize studio user session.');
  return { user, token: signAuthToken(userId) };
}

export async function registerUser(params: {
  email: string;
  password: string;
  displayName: string;
  upgradeGuestUserId?: string | null;
}): Promise<{ user: UserProfile; token: string }> {
  const db = getDb();
  const config = getConfig();
  const email = params.email.trim().toLowerCase();
  const displayName = sanitizePlainText(params.displayName, 80);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.endsWith('@guest.nv3d.local')) {
    throw new AppError(400, 'INVALID_EMAIL', 'Please enter a valid email address.');
  }
  if (params.password.length < 8) {
    throw new AppError(400, 'WEAK_PASSWORD', 'Password must be at least 8 characters long.');
  }
  if (displayName.length < 2) {
    throw new AppError(400, 'INVALID_NAME', 'Display name must be at least 2 characters.');
  }

  const existing = await db.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    throw new AppError(409, 'EMAIL_EXISTS', 'An account with this email already exists.');
  }

  const passwordHash = await hashPassword(params.password);

  // If upgrading an active guest session, preserve all owned models, jobs, credits, and history
  if (params.upgradeGuestUserId) {
    const guestCheck = await db.query<{ id: string; is_guest: boolean }>(
      'SELECT id, is_guest FROM users WHERE id = $1',
      [params.upgradeGuestUserId]
    );
    if (guestCheck.rows.length > 0 && guestCheck.rows[0].is_guest) {
      await db.query(
        `UPDATE users
         SET email = $1, password_hash = $2, display_name = $3, is_guest = FALSE, updated_at = NOW()
         WHERE id = $4`,
        [email, passwordHash, displayName, params.upgradeGuestUserId]
      );
      const user = await getUserProfile(params.upgradeGuestUserId);
      if (!user) throw new AppError(500, 'USER_UPGRADE_FAILED', 'Failed to finalize account registration.');
      return { user, token: signAuthToken(user.id) };
    }
  }

  const userId = crypto.randomUUID();
  const creditId = crypto.randomUUID();
  await db.transaction(async (tx) => {
    await tx(
      `INSERT INTO users (id, email, password_hash, display_name, is_guest)
       VALUES ($1, $2, $3, $4, FALSE)`,
      [userId, email, passwordHash, displayName]
    );
    await tx(
      `INSERT INTO user_credits (
         id, user_id, balance, lifetime_granted, lifetime_spent,
         last_transaction_delta, last_transaction_reason
       ) VALUES ($1, $2, $3, $3, 0, $3, 'New account studio credits')`,
      [creditId, userId, config.initialUserCredits]
    );
  });

  const user = await getUserProfile(userId);
  if (!user) throw new AppError(500, 'USER_CREATE_FAILED', 'Failed to create account.');
  return { user, token: signAuthToken(userId) };
}

export async function loginUser(emailRaw: string, password: string): Promise<{ user: UserProfile; token: string }> {
  const db = getDb();
  const email = emailRaw.trim().toLowerCase();
  const res = await db.query<{ id: string; password_hash: string; is_guest: boolean }>(
    'SELECT id, password_hash, is_guest FROM users WHERE email = $1',
    [email]
  );
  if (res.rows.length === 0 || res.rows[0].is_guest) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
  }
  const valid = await verifyPassword(password, res.rows[0].password_hash);
  if (!valid) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
  }
  const user = await getUserProfile(res.rows[0].id);
  if (!user) throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
  return { user, token: signAuthToken(user.id) };
}

export async function getUserCredits(userId: string): Promise<CreditLedgerEntry> {
  const db = getDb();
  const res = await db.query<{
    id: string;
    balance: number;
    last_transaction_delta: number;
    last_transaction_reason: string;
    lifetime_granted: number;
    lifetime_spent: number;
    updated_at: string | Date;
  }>(
    `SELECT id, balance, last_transaction_delta, last_transaction_reason,
            lifetime_granted, lifetime_spent, updated_at
     FROM user_credits
     WHERE user_id = $1`,
    [userId]
  );
  if (res.rows.length === 0) {
    throw new AppError(404, 'CREDITS_NOT_FOUND', 'Credit record not found for user.');
  }
  const r = res.rows[0];
  return {
    id: r.id,
    balance: Number(r.balance),
    lastTransactionDelta: Number(r.last_transaction_delta),
    lastTransactionReason: r.last_transaction_reason,
    lifetimeGranted: Number(r.lifetime_granted),
    lifetimeSpent: Number(r.lifetime_spent),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export async function reserveUserCredits(userId: string, amount: number, reason: string): Promise<number> {
  if (amount <= 0) {
    const current = await getUserCredits(userId);
    return current.balance;
  }
  const db = getDb();
  return db.transaction(async (tx) => {
    const res = await tx(
      `UPDATE user_credits
       SET balance = balance - $2,
           lifetime_spent = lifetime_spent + $2,
           last_transaction_delta = -$2,
           last_transaction_reason = $3,
           updated_at = NOW()
       WHERE user_id = $1 AND balance >= $2
       RETURNING balance`,
      [userId, amount, sanitizePlainText(reason, 160)]
    );
    if (res.rows.length === 0) {
      throw new AppError(
        402,
        'INSUFFICIENT_CREDITS',
        `Insufficient studio credits. This generation requires ${amount} credits.`
      );
    }
    return Number(res.rows[0].balance);
  });
}

export async function refundUserCredits(userId: string, amount: number, reason: string): Promise<void> {
  if (amount <= 0) return;
  const db = getDb();
  await db.query(
    `UPDATE user_credits
     SET balance = balance + $2,
         lifetime_spent = GREATEST(0, lifetime_spent - $2),
         last_transaction_delta = $2,
         last_transaction_reason = $3,
         updated_at = NOW()
     WHERE user_id = $1`,
    [userId, amount, sanitizePlainText(reason, 160)]
  );
}
