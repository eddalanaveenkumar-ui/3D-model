import crypto from 'node:crypto';
import {
  calculateGenerationCreditCost,
  type GenerationJobRecord,
  type GenerationMode,
  type GenerationSettings,
  type ImageViewAngle,
  type JobStatus,
  type StructuredGenerationSpec,
  type UploadedImageRecord,
} from '@nv3d/shared';
import { getConfig } from '../config/env.js';
import { getEffectiveNimConfig } from '../config/requestContext.js';
import { getDb } from '../db/client.js';
import { getActiveProvider, getDemoModeInfo, getProviderById } from '../providers/registry.js';
import type { I3DGenerationProvider, ProviderWebhookEvent } from '../providers/types.js';
import { AppError, refundUserCredits, reserveUserCredits } from './authService.js';
import { optimizeGlbBuffer } from './glbOptimizationService.js';
import { recordHistory } from './historyService.js';
import { attachImagesToJob, type StoredImageWithBuffer } from './imageUploadService.js';
import { createValidatedGeneratedModel } from './modelService.js';
import { analyzeReferenceImages, structureTextPrompt } from './nvidiaNimService.js';
import { checkWeaponsFreePolicy, sanitizePlainText } from './safetyService.js';

interface DbJobRow {
  id: string;
  user_id: string;
  mode: GenerationMode;
  status: JobStatus;
  stage_label: string;
  progress: number;
  prompt: string | null;
  enhanced_prompt: string | null;
  structured_spec: StructuredGenerationSpec | string | null;
  settings: GenerationSettings | string;
  provider_id: string | null;
  external_job_id: string | null;
  model_id: string | null;
  credits_charged: number;
  credits_refunded: boolean;
  error_code: string | null;
  error_message: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  completed_at: string | Date | null;
}

const activeJobsInFlight = new Set<string>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJson<T>(val: T | string | null): T | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return JSON.parse(val) as T;
  return val;
}

async function fetchJobImages(jobId: string, userId: string): Promise<UploadedImageRecord[]> {
  const db = getDb();
  const res = await db.query<{
    id: string;
    view_angle: ImageViewAngle;
    original_name: string;
    mime_type: string;
    file_size_bytes: string | number;
    width: number;
    height: number;
    created_at: string | Date;
  }>(
    `SELECT id, view_angle, original_name, mime_type, file_size_bytes, width, height, created_at
     FROM uploaded_images
     WHERE job_id = $1 AND user_id = $2
     ORDER BY created_at ASC`,
    [jobId, userId]
  );

  return res.rows.map((r) => ({
    id: r.id,
    viewAngle: r.view_angle,
    originalName: r.original_name,
    mimeType: r.mime_type,
    fileSizeBytes: Number(r.file_size_bytes),
    width: Number(r.width),
    height: Number(r.height),
    previewUrl: `/api/generate/uploads/${r.id}`,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

async function rowToJobRecord(row: DbJobRow): Promise<GenerationJobRecord> {
  const uploadedImages = row.mode === 'image' ? await fetchJobImages(row.id, row.user_id) : [];
  return {
    id: row.id,
    userId: row.user_id,
    mode: row.mode,
    status: row.status,
    stageLabel: row.stage_label,
    progress: Number(row.progress),
    prompt: row.prompt,
    enhancedPrompt: row.enhanced_prompt,
    structuredSpec: parseJson<StructuredGenerationSpec>(row.structured_spec),
    settings: parseJson<GenerationSettings>(row.settings)!,
    providerId: row.provider_id,
    externalJobId: row.external_job_id,
    modelId: row.model_id,
    uploadedImages,
    creditsCharged: Number(row.credits_charged),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}

async function updateJobState(
  jobId: string,
  patch: Partial<{
    status: JobStatus;
    stageLabel: string;
    progress: number;
    enhancedPrompt: string;
    structuredSpec: StructuredGenerationSpec;
    externalJobId: string;
    modelId: string;
    errorCode: string;
    errorMessage: string;
    completed: boolean;
  }>
): Promise<void> {
  const db = getDb();
  const sets: string[] = ['updated_at = NOW()'];
  const values: unknown[] = [];

  const push = (col: string, val: unknown, cast = '') => {
    values.push(val);
    sets.push(`${col} = $${values.length}${cast}`);
  };

  if (patch.status !== undefined) push('status', patch.status);
  if (patch.stageLabel !== undefined) push('stage_label', patch.stageLabel);
  if (patch.progress !== undefined) push('progress', Math.max(0, Math.min(100, Math.round(patch.progress))));
  if (patch.enhancedPrompt !== undefined) push('enhanced_prompt', patch.enhancedPrompt);
  if (patch.structuredSpec !== undefined) push('structured_spec', JSON.stringify(patch.structuredSpec), '::jsonb');
  if (patch.externalJobId !== undefined) push('external_job_id', patch.externalJobId);
  if (patch.modelId !== undefined) push('model_id', patch.modelId);
  if (patch.errorCode !== undefined) push('error_code', patch.errorCode);
  if (patch.errorMessage !== undefined) push('error_message', patch.errorMessage);
  if (patch.completed) sets.push('completed_at = NOW()');

  values.push(jobId);
  await db.query(`UPDATE generation_jobs SET ${sets.join(', ')} WHERE id = $${values.length}`, values);
}

async function failJobAndRefund(params: {
  jobId: string;
  userId: string;
  mode: GenerationMode;
  prompt: string | null;
  providerId: string | null;
  creditsCharged: number;
  errorCode: string;
  errorMessage: string;
  startedAt: number;
}): Promise<void> {
  const db = getDb();
  const check = await db.query<{ status: JobStatus; credits_refunded: boolean }>(
    'SELECT status, credits_refunded FROM generation_jobs WHERE id = $1',
    [params.jobId]
  );
  if (check.rows.length === 0) return;
  if (check.rows[0].status === 'succeeded' || check.rows[0].status === 'failed') return;

  const safeMsg = sanitizePlainText(params.errorMessage, 500);
  await db.query(
    `UPDATE generation_jobs
     SET status = 'failed',
         stage_label = 'Generation failed',
         error_code = $1,
         error_message = $2,
         credits_refunded = TRUE,
         updated_at = NOW(),
         completed_at = NOW()
     WHERE id = $3`,
    [params.errorCode, safeMsg, params.jobId]
  );

  if (!check.rows[0].credits_refunded && params.creditsCharged > 0) {
    await refundUserCredits(
      params.userId,
      params.creditsCharged,
      `Refund for failed ${params.mode}-to-3D job ${params.jobId.slice(0, 8)}`
    );
  }

  await recordHistory({
    userId: params.userId,
    jobId: params.jobId,
    action: `generate.${params.mode}.failed`,
    mode: params.mode,
    status: 'failed',
    summary: safeMsg,
    prompt: params.prompt,
    providerId: params.providerId,
    creditsDelta: 0,
    durationMs: Date.now() - params.startedAt,
    metadata: { errorCode: params.errorCode, creditsRefunded: params.creditsCharged },
  });
}

async function finalizeProviderAsset(params: {
  jobId: string;
  userId: string;
  mode: GenerationMode;
  prompt: string | null;
  spec: StructuredGenerationSpec;
  settings: GenerationSettings;
  provider: I3DGenerationProvider;
  glbUrl?: string;
  glbBuffer?: Buffer;
  creditsCharged: number;
  startedAt: number;
}): Promise<void> {
  const db = getDb();
  const statusCheck = await db.query<{ status: JobStatus }>(
    'SELECT status FROM generation_jobs WHERE id = $1',
    [params.jobId]
  );
  if (statusCheck.rows[0]?.status === 'succeeded') return;

  let rawGlb: Buffer;
  if (params.glbBuffer) {
    rawGlb = params.glbBuffer;
  } else if (params.glbUrl) {
    await updateJobState(params.jobId, {
      status: 'downloading',
      stageLabel: `Retrieving GLB from ${params.provider.displayName}`,
      progress: 88,
    });
    rawGlb = await params.provider.downloadGlb(params.glbUrl);
  } else {
    throw new AppError(502, 'PROVIDER_EMPTY_ASSET', 'Provider did not return a GLB payload.');
  }

  await updateJobState(params.jobId, {
    status: 'optimizing',
    stageLabel: params.settings.optimizeSize
      ? 'Compressing textures & optimizing mesh geometry'
      : 'Preparing GLB buffers & PBR textures',
    progress: 93,
  });

  let processedGlb = rawGlb;
  try {
    processedGlb = await optimizeGlbBuffer(rawGlb, {
      optimizeSize: params.settings.optimizeSize,
      textureResolution: params.settings.textureResolution,
      polygonDetail: params.settings.polygonDetail,
      enforcePolygonBudget: params.settings.optimizeSize,
    });
  } catch {
    // Retain raw provider GLB so validation below reports exact structural errors if corrupted
    processedGlb = rawGlb;
  }

  await updateJobState(params.jobId, {
    status: 'validating',
    stageLabel: 'Running Khronos glTF 2.0 binary validation',
    progress: 97,
  });

  const model = await createValidatedGeneratedModel({
    userId: params.userId,
    jobId: params.jobId,
    name: params.spec.title,
    description: params.spec.enhancedPrompt.slice(0, 420),
    category: params.spec.category,
    style: params.settings.style,
    sourceType: 'generated',
    providerId: params.provider.id,
    prompt: params.prompt,
    structuredSpec: params.spec,
    settings: params.settings,
    glbBuffer: processedGlb,
  });

  await updateJobState(params.jobId, {
    status: 'succeeded',
    stageLabel: 'Validated GLB ready in viewport',
    progress: 100,
    modelId: model.id,
    completed: true,
  });

  await recordHistory({
    userId: params.userId,
    jobId: params.jobId,
    modelId: model.id,
    action: `generate.${params.mode}.succeeded`,
    mode: params.mode,
    status: 'succeeded',
    summary: `Generated "${model.name}" via ${params.provider.displayName} (${model.statistics.triangles.toLocaleString()} triangles, validated GLB).`,
    prompt: params.prompt,
    providerId: params.provider.id,
    creditsDelta: -params.creditsCharged,
    durationMs: Date.now() - params.startedAt,
    metadata: {
      quality: params.settings.quality,
      polygonDetail: params.settings.polygonDetail,
      textureResolution: params.settings.textureResolution,
      fileSizeBytes: model.fileSizeBytes,
      orchestrator: params.spec.orchestrator,
    },
  });
}

async function runAsyncGenerationPipeline(params: {
  jobId: string;
  userId: string;
  mode: GenerationMode;
  prompt: string | null;
  images?: StoredImageWithBuffer[];
  settings: GenerationSettings;
  provider: I3DGenerationProvider;
  creditsCharged: number;
  skipBackgroundPolling?: boolean;
}): Promise<void> {
  if (activeJobsInFlight.has(params.jobId)) return;
  activeJobsInFlight.add(params.jobId);
  const startedAt = Date.now();
  const config = getConfig();

  try {
    // Stage 1: MiniMax M3.1 Flash prompt enhancement / multimodal reference image analysis
    await updateJobState(params.jobId, {
      status: 'enhancing',
      stageLabel:
        params.mode === 'text'
          ? 'Structuring generation spec via MiniMax M3.1 Flash'
          : 'Analyzing reference images for 3D reconstruction',
      progress: 10,
    });

    const spec =
      params.mode === 'text'
        ? await structureTextPrompt(params.prompt || '', params.settings)
        : await analyzeReferenceImages(params.images ?? [], params.prompt ?? undefined, params.settings);

    // Annotate capability notices transparently if user asked for rigging/animation on a provider without it
    if (params.settings.rigging && !params.provider.capabilities.rigging) {
      spec.warnings.push(`${params.provider.displayName} outputs static meshes; auto-rigging skipped.`);
    }
    if (params.settings.animation && !params.provider.capabilities.animation) {
      spec.warnings.push(`${params.provider.displayName} does not synthesize skeletal animation clips.`);
    }

    await updateJobState(params.jobId, {
      status: 'submitting',
      stageLabel: `Submitting structured job to ${params.provider.displayName}`,
      progress: 20,
      enhancedPrompt: spec.enhancedPrompt,
      structuredSpec: spec,
    });

    // Stage 2: Submit to configured 3D provider adapter
    const submission =
      params.mode === 'text'
        ? await params.provider.submitTextTo3D({
            jobId: params.jobId,
            prompt: params.prompt || '',
            spec,
            settings: params.settings,
          })
        : await params.provider.submitImageTo3D({
            jobId: params.jobId,
            prompt: params.prompt,
            images: (params.images ?? []).map((i) => ({
              viewAngle: i.viewAngle,
              mimeType: i.mimeType,
              originalName: i.originalName,
              buffer: i.buffer,
              dataUrl: i.dataUrl,
            })),
            spec,
            settings: params.settings,
          });

    await updateJobState(params.jobId, {
      status: 'processing',
      stageLabel: `Generating 3D geometry on ${params.provider.displayName}`,
      progress: Math.max(22, Math.min(85, submission.progress)),
      externalJobId: submission.externalJobId,
    });

    // Immediate completion path (e.g. NVIDIA NIM 3D synchronous base64/binary GLB or instant URL)
    if (submission.status === 'succeeded' && (submission.glbBuffer || submission.glbUrl)) {
      await finalizeProviderAsset({
        jobId: params.jobId,
        userId: params.userId,
        mode: params.mode,
        prompt: params.prompt,
        spec,
        settings: params.settings,
        provider: params.provider,
        glbUrl: submission.glbUrl,
        glbBuffer: submission.glbBuffer,
        creditsCharged: params.creditsCharged,
        startedAt,
      });
      return;
    }

    // On Vercel Serverless Functions, background loops freeze after the HTTP response ends.
    // Subsequent GET /api/generate/:jobId polls and /api/webhooks/:provider drive completion instead.
    if (params.skipBackgroundPolling) {
      return;
    }

    // Stage 3: Poll provider status asynchronously until completion, failure, or webhook resolution
    for (let attempt = 0; attempt < config.jobMaxPollAttempts; attempt++) {
      await sleep(config.jobPollIntervalMs);

      // Stop if already completed or failed via webhook
      const dbCheck = await getDb().query<{ status: JobStatus }>(
        'SELECT status FROM generation_jobs WHERE id = $1',
        [params.jobId]
      );
      const curStatus = dbCheck.rows[0]?.status;
      if (!curStatus || curStatus === 'succeeded' || curStatus === 'failed') {
        return;
      }

      const polled = await params.provider.getJobStatus(submission.externalJobId);

      if (polled.status === 'succeeded' && polled.glbUrl) {
        await finalizeProviderAsset({
          jobId: params.jobId,
          userId: params.userId,
          mode: params.mode,
          prompt: params.prompt,
          spec,
          settings: params.settings,
          provider: params.provider,
          glbUrl: polled.glbUrl,
          creditsCharged: params.creditsCharged,
          startedAt,
        });
        return;
      }

      if (polled.status === 'failed') {
        throw new AppError(
          502,
          'PROVIDER_GENERATION_FAILED',
          polled.errorMessage || `${params.provider.displayName} failed to generate the 3D model.`
        );
      }

      await updateJobState(params.jobId, {
        status: 'processing',
        stageLabel: polled.stageLabel,
        progress: Math.max(24, Math.min(86, polled.progress)),
      });
    }

    throw new AppError(
      504,
      'JOB_POLL_TIMEOUT',
      `3D generation job timed out after ${config.jobMaxPollAttempts} polling attempts.`
    );
  } catch (err) {
    const errorCode = err instanceof AppError ? err.code : 'PIPELINE_ERROR';
    const errorMessage =
      err instanceof Error ? err.message : 'Unexpected 3D generation pipeline error.';

    await failJobAndRefund({
      jobId: params.jobId,
      userId: params.userId,
      mode: params.mode,
      prompt: params.prompt,
      providerId: params.provider.id,
      creditsCharged: params.creditsCharged,
      errorCode,
      errorMessage,
      startedAt,
    });
  } finally {
    activeJobsInFlight.delete(params.jobId);
  }
}

/**
 * Create and launch a Text-to-3D generation job.
 * When no 3D provider is configured, honestly records `provider_unconfigured`
 * and raises 503 PROVIDER_NOT_CONFIGURED (never simulates fake AI generation).
 */
export async function submitTextGenerationJob(params: {
  userId: string;
  prompt: string;
  settings: GenerationSettings;
}): Promise<GenerationJobRecord> {
  const cleanPrompt = sanitizePlainText(params.prompt, 2000);
  if (cleanPrompt.length < 3) {
    throw new AppError(400, 'INVALID_PROMPT', 'Please enter a descriptive prompt (at least 3 characters).');
  }

  const policy = checkWeaponsFreePolicy(cleanPrompt);
  if (!policy.allowed) {
    throw new AppError(422, 'POLICY_VIOLATION', policy.reason!);
  }

  const provider = getActiveProvider();
  const db = getDb();
  const jobId = crypto.randomUUID();

  if (!provider) {
    const demoInfo = getDemoModeInfo();
    const spec = await structureTextPrompt(cleanPrompt, params.settings);
    const reason =
      demoInfo.reason ||
      'Demo Mode active: no 3D generation provider is configured. Configure MESHY_API_KEY, TRIPO_API_KEY, or CUSTOM_3D_PROVIDER_URL in .env to generate live 3D meshes.';

    const inserted = await db.query<DbJobRow>(
      `INSERT INTO generation_jobs (
         id, user_id, mode, status, stage_label, progress,
         prompt, enhanced_prompt, structured_spec, settings,
         provider_id, credits_charged, error_code, error_message, completed_at
       ) VALUES (
         $1, $2, 'text', 'provider_unconfigured',
         'Demo Mode — 3D provider not configured', 0,
         $3, $4, $5::jsonb, $6::jsonb,
         NULL, 0, 'PROVIDER_NOT_CONFIGURED', $7, NOW()
       ) RETURNING *`,
      [
        jobId,
        params.userId,
        cleanPrompt,
        spec.enhancedPrompt,
        JSON.stringify(spec),
        JSON.stringify(params.settings),
        reason,
      ]
    );

    await recordHistory({
      userId: params.userId,
      jobId,
      action: 'generate.text.provider_unconfigured',
      mode: 'text',
      status: 'provider_unconfigured',
      summary: `Prepared structured specification for "${spec.title}" — halted because no live 3D provider is configured (0 credits charged).`,
      prompt: cleanPrompt,
      providerId: null,
      creditsDelta: 0,
      metadata: { category: spec.category, orchestrator: spec.orchestrator },
    });

    const jobRecord = await rowToJobRecord(inserted.rows[0]);
    throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', reason, {
      demoMode: true,
      job: jobRecord,
    });
  }

  const isBrowserByok = getEffectiveNimConfig().isBrowserKey && provider.id === 'nim-trellis';
  const creditCost = isBrowserByok ? 0 : calculateGenerationCreditCost(params.settings, 'text');
  if (creditCost > 0) {
    await reserveUserCredits(
      params.userId,
      creditCost,
      `Text-to-3D (${params.settings.quality}, ${params.settings.textureResolution.toUpperCase()})`
    );
  }

  const inserted = await db.query<DbJobRow>(
    `INSERT INTO generation_jobs (
       id, user_id, mode, status, stage_label, progress,
       prompt, settings, provider_id, credits_charged
     ) VALUES (
       $1, $2, 'text', 'queued', 'Queued for MiniMax orchestration', 5,
       $3, $4::jsonb, $5, $6
     ) RETURNING *`,
    [jobId, params.userId, cleanPrompt, JSON.stringify(params.settings), provider.id, creditCost]
  );

  if (getConfig().isVercel) {
    // Submit to MiniMax + 3D provider before responding so the Lambda never freezes mid-submission.
    await runAsyncGenerationPipeline({
      jobId,
      userId: params.userId,
      mode: 'text',
      prompt: cleanPrompt,
      settings: params.settings,
      provider,
      creditsCharged: creditCost,
      skipBackgroundPolling: true,
    });
    const refreshed = await db.query<DbJobRow>('SELECT * FROM generation_jobs WHERE id = $1', [jobId]);
    return rowToJobRecord(refreshed.rows[0] ?? inserted.rows[0]);
  }

  const record = await rowToJobRecord(inserted.rows[0]);

  // Kick off non-blocking background workflow on persistent Node servers
  setImmediate(() => {
    void runAsyncGenerationPipeline({
      jobId,
      userId: params.userId,
      mode: 'text',
      prompt: cleanPrompt,
      settings: params.settings,
      provider,
      creditsCharged: creditCost,
    });
  });

  return record;
}

/**
 * Create and launch an Image-to-3D (single or front/side/back multi-view) generation job.
 */
export async function submitImageGenerationJob(params: {
  userId: string;
  images: StoredImageWithBuffer[];
  prompt?: string | null;
  settings: GenerationSettings;
}): Promise<GenerationJobRecord> {
  if (params.images.length === 0) {
    throw new AppError(400, 'MISSING_IMAGE', 'Upload at least one PNG, JPG, or WEBP reference image.');
  }

  const cleanPrompt = params.prompt ? sanitizePlainText(params.prompt, 1500) : null;
  if (cleanPrompt) {
    const policy = checkWeaponsFreePolicy(cleanPrompt);
    if (!policy.allowed) {
      throw new AppError(422, 'POLICY_VIOLATION', policy.reason!);
    }
  }

  const provider = getActiveProvider();
  const db = getDb();
  const jobId = crypto.randomUUID();
  const imageIds = params.images.map((i) => i.id);

  if (!provider) {
    const demoInfo = getDemoModeInfo();
    const spec = await analyzeReferenceImages(params.images, cleanPrompt ?? undefined, params.settings);
    const reason =
      demoInfo.reason ||
      'Demo Mode active: no 3D generation provider is configured. Reference image(s) were validated, but live Image-to-3D generation requires MESHY_API_KEY, TRIPO_API_KEY, or CUSTOM_3D_PROVIDER_URL.';

    const inserted = await db.query<DbJobRow>(
      `INSERT INTO generation_jobs (
         id, user_id, mode, status, stage_label, progress,
         prompt, enhanced_prompt, structured_spec, settings,
         provider_id, credits_charged, error_code, error_message, completed_at
       ) VALUES (
         $1, $2, 'image', 'provider_unconfigured',
         'Demo Mode — 3D provider not configured', 0,
         $3, $4, $5::jsonb, $6::jsonb,
         NULL, 0, 'PROVIDER_NOT_CONFIGURED', $7, NOW()
       ) RETURNING *`,
      [
        jobId,
        params.userId,
        cleanPrompt,
        spec.enhancedPrompt,
        JSON.stringify(spec),
        JSON.stringify(params.settings),
        reason,
      ]
    );
    await attachImagesToJob(imageIds, params.userId, jobId);

    await recordHistory({
      userId: params.userId,
      jobId,
      action: 'generate.image.provider_unconfigured',
      mode: 'image',
      status: 'provider_unconfigured',
      summary: `Validated ${params.images.length} reference view(s) (${params.images.map((i) => i.viewAngle).join(', ')}) — halted because no live 3D provider is configured (0 credits charged).`,
      prompt: cleanPrompt,
      providerId: null,
      creditsDelta: 0,
      metadata: {
        views: params.images.map((i) => i.viewAngle),
        orchestrator: spec.orchestrator,
      },
    });

    const jobRecord = await rowToJobRecord(inserted.rows[0]);
    throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', reason, {
      demoMode: true,
      job: jobRecord,
    });
  }

  // Filter to single front image if provider doesn't advertise multi-view support
  const acceptedImages =
    provider.capabilities.multiViewImageTo3D
      ? params.images
      : [params.images.find((i) => i.viewAngle === 'front') ?? params.images[0]];

  const isBrowserByok = getEffectiveNimConfig().isBrowserKey && provider.id === 'nim-trellis';
  const creditCost = isBrowserByok ? 0 : calculateGenerationCreditCost(params.settings, 'image');
  if (creditCost > 0) {
    await reserveUserCredits(
      params.userId,
      creditCost,
      `Image-to-3D (${acceptedImages.length} view${acceptedImages.length > 1 ? 's' : ''}, ${params.settings.quality})`
    );
  }

  const inserted = await db.query<DbJobRow>(
    `INSERT INTO generation_jobs (
       id, user_id, mode, status, stage_label, progress,
       prompt, settings, provider_id, credits_charged
     ) VALUES (
       $1, $2, 'image', 'queued', 'Queued for reference image analysis', 5,
       $3, $4::jsonb, $5, $6
     ) RETURNING *`,
    [jobId, params.userId, cleanPrompt, JSON.stringify(params.settings), provider.id, creditCost]
  );
  await attachImagesToJob(imageIds, params.userId, jobId);

  if (getConfig().isVercel) {
    await runAsyncGenerationPipeline({
      jobId,
      userId: params.userId,
      mode: 'image',
      prompt: cleanPrompt,
      images: acceptedImages,
      settings: params.settings,
      provider,
      creditsCharged: creditCost,
      skipBackgroundPolling: true,
    });
    const refreshed = await db.query<DbJobRow>('SELECT * FROM generation_jobs WHERE id = $1', [jobId]);
    return rowToJobRecord(refreshed.rows[0] ?? inserted.rows[0]);
  }

  const record = await rowToJobRecord(inserted.rows[0]);

  setImmediate(() => {
    void runAsyncGenerationPipeline({
      jobId,
      userId: params.userId,
      mode: 'image',
      prompt: cleanPrompt,
      images: acceptedImages,
      settings: params.settings,
      provider,
      creditsCharged: creditCost,
    });
  });

  return record;
}

/**
 * Advance a provider-submitted job by a single status check on serverless deployments
 * where background setImmediate poll loops do not persist between HTTP requests.
 */
async function advanceServerlessJobOnce(row: DbJobRow): Promise<DbJobRow> {
  if (
    row.status !== 'processing' ||
    !row.provider_id ||
    !row.external_job_id ||
    activeJobsInFlight.has(row.id)
  ) {
    return row;
  }

  const provider = getProviderById(row.provider_id);
  if (!provider || !provider.isConfigured()) {
    return row;
  }

  activeJobsInFlight.add(row.id);
  const startedAt = new Date(row.created_at).getTime();
  try {
    const polled = await provider.getJobStatus(row.external_job_id);
    if (polled.status === 'succeeded' && polled.glbUrl) {
      const settings = parseJson<GenerationSettings>(row.settings);
      const spec = parseJson<StructuredGenerationSpec>(row.structured_spec);
      if (settings && spec) {
        await finalizeProviderAsset({
          jobId: row.id,
          userId: row.user_id,
          mode: row.mode,
          prompt: row.prompt,
          spec,
          settings,
          provider,
          glbUrl: polled.glbUrl,
          creditsCharged: Number(row.credits_charged),
          startedAt,
        });
      }
    } else if (polled.status === 'failed') {
      await failJobAndRefund({
        jobId: row.id,
        userId: row.user_id,
        mode: row.mode,
        prompt: row.prompt,
        providerId: provider.id,
        creditsCharged: Number(row.credits_charged),
        errorCode: 'PROVIDER_GENERATION_FAILED',
        errorMessage:
          polled.errorMessage || `${provider.displayName} failed to generate the 3D model.`,
        startedAt,
      });
    } else {
      await updateJobState(row.id, {
        status: 'processing',
        progress: Math.max(24, Math.min(86, polled.progress)),
        stageLabel:
          polled.stageLabel ||
          `Generating 3D geometry on ${provider.displayName} (${Math.round(polled.progress)}%)`,
        externalJobId: polled.externalJobId,
      });
    }
  } catch (err) {
    const code = err instanceof AppError ? err.code : 'GENERATION_PIPELINE_ERROR';
    const msg = err instanceof Error ? err.message : 'Unexpected provider status error.';
    await failJobAndRefund({
      jobId: row.id,
      userId: row.user_id,
      mode: row.mode,
      prompt: row.prompt,
      providerId: provider.id,
      creditsCharged: Number(row.credits_charged),
      errorCode: code,
      errorMessage: msg,
      startedAt,
    });
  } finally {
    activeJobsInFlight.delete(row.id);
  }

  const refreshed = await getDb().query<DbJobRow>('SELECT * FROM generation_jobs WHERE id = $1', [
    row.id,
  ]);
  return refreshed.rows[0] ?? row;
}

export async function getJobForUser(jobId: string, userId: string): Promise<GenerationJobRecord> {
  if (!/^[0-9a-fA-F-]{36}$/.test(jobId)) {
    throw new AppError(400, 'INVALID_JOB_ID', 'Invalid job identifier format.');
  }
  const db = getDb();
  const res = await db.query<DbJobRow>('SELECT * FROM generation_jobs WHERE id = $1', [jobId]);
  if (res.rows.length === 0) {
    throw new AppError(404, 'JOB_NOT_FOUND', 'Generation job not found.');
  }
  let row = res.rows[0];
  if (row.user_id !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view this generation job.');
  }
  if (getConfig().isVercel && row.status === 'processing') {
    row = await advanceServerlessJobOnce(row);
  }
  return rowToJobRecord(row);
}

export async function listJobsForUser(userId: string, limit = 30): Promise<GenerationJobRecord[]> {
  const db = getDb();
  const safeLimit = Math.min(Math.max(1, limit), 100);
  const res = await db.query<DbJobRow>(
    `SELECT * FROM generation_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, safeLimit]
  );
  return Promise.all(res.rows.map(rowToJobRecord));
}

/**
 * Process a signature-verified webhook event from a 3D generation provider.
 */
export async function applyVerifiedProviderWebhook(
  providerId: string,
  event: ProviderWebhookEvent
): Promise<{ matched: boolean; jobId?: string }> {
  const provider = getProviderById(providerId);
  if (!provider) return { matched: false };

  const db = getDb();
  const res = await db.query<DbJobRow>(
    `SELECT * FROM generation_jobs
     WHERE provider_id = $1
       AND (external_job_id = $2 OR external_job_id LIKE $3)
     ORDER BY created_at DESC
     LIMIT 1`,
    [providerId, event.externalJobId, `%:${event.externalJobId}`]
  );
  if (res.rows.length === 0) {
    return { matched: false };
  }

  const row = res.rows[0];
  if (row.status === 'succeeded' || row.status === 'failed') {
    return { matched: true, jobId: row.id };
  }

  if (event.status === 'succeeded' && event.glbUrl) {
    const settings = parseJson<GenerationSettings>(row.settings)!;
    const spec = parseJson<StructuredGenerationSpec>(row.structured_spec);
    if (spec) {
      await finalizeProviderAsset({
        jobId: row.id,
        userId: row.user_id,
        mode: row.mode,
        prompt: row.prompt,
        spec,
        settings,
        provider,
        glbUrl: event.glbUrl,
        creditsCharged: Number(row.credits_charged),
        startedAt: new Date(row.created_at).getTime(),
      });
    }
    return { matched: true, jobId: row.id };
  }

  if (event.status === 'failed') {
    await failJobAndRefund({
      jobId: row.id,
      userId: row.user_id,
      mode: row.mode,
      prompt: row.prompt,
      providerId,
      creditsCharged: Number(row.credits_charged),
      errorCode: 'PROVIDER_WEBHOOK_FAILED',
      errorMessage: event.errorMessage || `${provider.displayName} webhook reported job failure.`,
      startedAt: new Date(row.created_at).getTime(),
    });
    return { matched: true, jobId: row.id };
  }

  if (typeof event.progress === 'number') {
    await updateJobState(row.id, {
      status: 'processing',
      progress: Math.round(20 + Math.max(0, Math.min(100, event.progress)) * 0.65),
      stageLabel: `Generating 3D geometry (${Math.round(event.progress)}%)`,
    });
  }

  return { matched: true, jobId: row.id };
}
