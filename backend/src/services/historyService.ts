import crypto from 'node:crypto';
import type { GenerationHistoryEntry, GenerationMode } from '@nv3d/shared';
import { getDb } from '../db/client.js';
import { sanitizePlainText } from './safetyService.js';

export async function recordHistory(params: {
  userId: string;
  jobId?: string | null;
  modelId?: string | null;
  action: string;
  mode: GenerationMode | 'import' | 'system';
  status: string;
  summary: string;
  prompt?: string | null;
  providerId?: string | null;
  creditsDelta?: number;
  durationMs?: number | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const db = getDb();
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO generation_history (
       id, user_id, job_id, model_id, action, mode, status,
       summary, prompt, provider_id, credits_delta, duration_ms, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
    [
      id,
      params.userId,
      params.jobId ?? null,
      params.modelId ?? null,
      sanitizePlainText(params.action, 80),
      params.mode,
      sanitizePlainText(params.status, 40),
      sanitizePlainText(params.summary, 400),
      params.prompt ? sanitizePlainText(params.prompt, 2000) : null,
      params.providerId ?? null,
      params.creditsDelta ?? 0,
      params.durationMs ?? null,
      JSON.stringify(params.metadata ?? {}),
    ]
  );
}

export async function listUserHistory(userId: string, limit = 50): Promise<GenerationHistoryEntry[]> {
  const db = getDb();
  const safeLimit = Math.min(Math.max(1, limit), 200);
  const res = await db.query<{
    id: string;
    user_id: string;
    job_id: string | null;
    model_id: string | null;
    action: string;
    mode: GenerationMode | 'import' | 'system';
    status: string;
    summary: string;
    prompt: string | null;
    provider_id: string | null;
    credits_delta: number;
    duration_ms: number | null;
    metadata: Record<string, unknown> | string;
    created_at: string | Date;
  }>(
    `SELECT id, user_id, job_id, model_id, action, mode, status,
            summary, prompt, provider_id, credits_delta, duration_ms, metadata, created_at
     FROM generation_history
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, safeLimit]
  );

  return res.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    jobId: row.job_id,
    modelId: row.model_id,
    action: row.action,
    mode: row.mode,
    status: row.status,
    summary: row.summary,
    prompt: row.prompt,
    providerId: row.provider_id,
    creditsDelta: Number(row.credits_delta),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? {}),
    createdAt: new Date(row.created_at).toISOString(),
  }));
}
