import sharp from 'sharp';
import type { ConnectivityCheckResult, ProviderCapabilities, QualityTier } from '@nv3d/shared';
import { getConfig } from '../config/env.js';
import { getEffectiveNimConfig } from '../config/requestContext.js';
import { AppError } from '../services/authService.js';
import { sanitizePlainText } from '../services/safetyService.js';
import {
  fetchProviderBinary,
  type I3DGenerationProvider,
  type ProviderImageJobRequest,
  type ProviderJobStatusResult,
  type ProviderSubmissionResult,
  type ProviderTextJobRequest,
  type ProviderWebhookEvent,
} from './types.js';

const HOSTED_NIM_GENAI_ORIGIN = 'https://ai.api.nvidia.com';
const NIM_TRELLIS_URL = 'https://ai.api.nvidia.com/v1/genai/microsoft/trellis';
const NIM_SF3D_URL = 'https://ai.api.nvidia.com/v1/genai/stabilityai/stable-fast-3d';
const NIM_SPAR3D_URL = 'https://ai.api.nvidia.com/v1/genai/stabilityai/stable-point-aware-3d';
const NIM_FLUX_SCHNELL_URL = 'https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-schnell';
const NIM_SD3_MEDIUM_URL =
  'https://ai.api.nvidia.com/v1/genai/stabilityai/stable-diffusion-3-medium';

const QUALITY_STEPS: Record<QualityTier, { ss: number; slat: number }> = {
  draft: { ss: 16, slat: 16 },
  standard: { ss: 25, slat: 25 },
  high: { ss: 36, slat: 36 },
};

// Keep inline base64 data URL strictly below NVIDIA NIM's ~180 KB JSON payload image limit
const MAX_INLINE_IMAGE_BYTES = 130_000;

interface NimGenAiJsonResponse {
  artifacts?: Array<{
    base64?: string;
    finishReason?: string;
    seed?: number;
  }>;
  image?: string;
  glb?: string;
  glb_base64?: string;
  model?: string;
  glbUrl?: string;
  output_url?: string;
  status?: number;
  detail?: unknown;
  title?: string;
  message?: string;
  error?: { message?: string } | string;
}

class Nim3dHttpError extends AppError {
  constructor(
    public readonly httpStatus: number,
    code: string,
    message: string,
    public readonly isSafetyUnavailable = false
  ) {
    super(httpStatus === 503 ? 503 : 502, code, message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function isHostedNvidiaEndpoint(url: string): boolean {
  return url.toLowerCase().startsWith(`${HOSTED_NIM_GENAI_ORIGIN}/`);
}

function isImageOnlyNim3dEndpoint(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.includes('stable-fast-3d') || lower.includes('stable-point-aware-3d');
}

/**
 * Strip meta-policy phrasing from positive prompts so benign object descriptions
 * do not carry policy keywords into upstream safety classifiers, and cap length
 * cleanly for TRELLIS / FLUX text encoders.
 */
function buildClean3dPrompt(rawPrompt: string, enhancedPrompt: string, maxLen = 460): string {
  const source = (enhancedPrompt || rawPrompt || '').trim();
  const cleaned = sanitizePlainText(source, 900)
    .replace(/\b(strictly\s+)?weapons?-free\b/gi, '')
    .replace(/\bunarmed\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/,\s*,/g, ',')
    .replace(/,\s*\./g, '.')
    .trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen).replace(/\s+\S*$/, '').trim();
}

async function encodeImageForNim(rawBuffer: Buffer): Promise<{
  buffer: Buffer;
  mimeType: string;
  dataUrl: string;
}> {
  const png512 = await sharp(rawBuffer)
    .rotate()
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer();

  if (png512.byteLength <= MAX_INLINE_IMAGE_BYTES) {
    return {
      buffer: png512,
      mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${png512.toString('base64')}`,
    };
  }

  const jpg512 = await sharp(rawBuffer)
    .rotate()
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: { r: 240, g: 240, b: 240 } })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();

  if (jpg512.byteLength <= MAX_INLINE_IMAGE_BYTES) {
    return {
      buffer: jpg512,
      mimeType: 'image/jpeg',
      dataUrl: `data:image/jpeg;base64,${jpg512.toString('base64')}`,
    };
  }

  const jpg384 = await sharp(rawBuffer)
    .rotate()
    .resize(384, 384, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: { r: 240, g: 240, b: 240 } })
    .jpeg({ quality: 75, mozjpeg: true })
    .toBuffer();

  return {
    buffer: jpg384,
    mimeType: 'image/jpeg',
    dataUrl: `data:image/jpeg;base64,${jpg384.toString('base64')}`,
  };
}

function decodeBase64Binary(encoded: string, label: string): Buffer {
  const cleaned = encoded.trim().replace(/^data:[^;]+;base64,/i, '').replace(/\s+/g, '');
  if (!cleaned) {
    throw new AppError(502, 'PROVIDER_EMPTY_ASSET', `NVIDIA NIM returned an empty base64 ${label}.`);
  }
  return Buffer.from(cleaned, 'base64');
}

function buildNim3dHttpError(
  status: number,
  rawText: string,
  parsed: NimGenAiJsonResponse
): Nim3dHttpError {
  let detail = '';
  if (typeof parsed.detail === 'string') {
    detail = parsed.detail;
  } else if (Array.isArray(parsed.detail) && parsed.detail.length > 0) {
    const first = parsed.detail[0] as { msg?: string };
    detail = first?.msg || JSON.stringify(parsed.detail[0]);
  } else if (typeof parsed.error === 'string') {
    detail = parsed.error;
  } else if (parsed.error?.message) {
    detail = parsed.error.message;
  } else if (parsed.message) {
    detail = parsed.message;
  } else if (parsed.title) {
    detail = parsed.title;
  } else if (rawText) {
    detail = rawText.slice(0, 220);
  }

  const clean = sanitizePlainText(detail || `HTTP ${status}`, 240);
  const safetyDown = status === 503 && /content\s*safety\s*screening/i.test(clean);

  if (safetyDown) {
    return new Nim3dHttpError(
      503,
      'PROVIDER_SAFETY_UNAVAILABLE',
      'NVIDIA NIM hosted content safety screening is temporarily unavailable (HTTP 503). NV3D Studio retried automatically, but NVIDIA cloud screening is still busy — wait 15–30 seconds and click Retry, or try Image-to-3D with the Stable Fast 3D preset in API Key settings.',
      true
    );
  }
  if (status === 401 || status === 403) {
    return new Nim3dHttpError(
      status,
      'PROVIDER_AUTH_FAILED',
      `Authentication rejected by NVIDIA NIM 3D (HTTP ${status}): ${clean}. Verify your NVIDIA API key (nvapi-...) and model access on build.nvidia.com.`
    );
  }
  if (status === 402) {
    return new Nim3dHttpError(
      402,
      'PROVIDER_CREDITS_EXHAUSTED',
      `NVIDIA NIM API credits exhausted (HTTP 402): ${clean}.`
    );
  }
  if (status === 404) {
    return new Nim3dHttpError(
      404,
      'PROVIDER_ENDPOINT_NOT_FOUND',
      `NVIDIA NIM 3D endpoint returned HTTP 404 (${clean}). Verify the 3D NIM endpoint URL in API Key settings.`
    );
  }
  return new Nim3dHttpError(
    status,
    'PROVIDER_SUBMIT_FAILED',
    `NVIDIA NIM 3D request failed (HTTP ${status}): ${clean}`
  );
}

async function parseNim3dResponse(
  res: Response,
  jobId: string,
  pipelineTag = 'nim3d'
): Promise<ProviderSubmissionResult> {
  const contentType = (res.headers.get('content-type') || '').toLowerCase();

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    let parsedErr: NimGenAiJsonResponse = {};
    try {
      parsedErr = JSON.parse(errText) as NimGenAiJsonResponse;
    } catch {
      // Non-JSON error body
    }
    throw buildNim3dHttpError(res.status, errText, parsedErr);
  }

  if (
    contentType.includes('model/gltf-binary') ||
    contentType.includes('application/octet-stream')
  ) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0) {
      throw new AppError(502, 'PROVIDER_EMPTY_ASSET', 'NVIDIA NIM 3D returned an empty GLB stream.');
    }
    return {
      externalJobId: `${pipelineTag}-${jobId.slice(0, 12)}`,
      status: 'succeeded',
      progress: 90,
      glbBuffer: buf,
      rawMeta: { pipeline: pipelineTag },
    };
  }

  const rawText = await res.text();
  let data: NimGenAiJsonResponse = {};
  try {
    data = JSON.parse(rawText) as NimGenAiJsonResponse;
  } catch {
    throw new AppError(502, 'PROVIDER_INVALID_RESPONSE', 'NVIDIA NIM 3D returned invalid JSON.');
  }

  const b64Candidate =
    data.artifacts?.[0]?.base64 || data.glb_base64 || data.glb || data.model || '';
  if (typeof b64Candidate === 'string' && b64Candidate.length > 0) {
    return {
      externalJobId: `${pipelineTag}-${jobId.slice(0, 12)}`,
      status: 'succeeded',
      progress: 90,
      glbBuffer: decodeBase64Binary(b64Candidate, 'GLB artifact'),
      rawMeta: {
        pipeline: pipelineTag,
        seed: data.artifacts?.[0]?.seed ?? 0,
        finishReason: data.artifacts?.[0]?.finishReason ?? 'SUCCESS',
      },
    };
  }

  const remoteUrl = data.glbUrl || data.output_url;
  if (typeof remoteUrl === 'string' && remoteUrl.length > 0) {
    return {
      externalJobId: `${pipelineTag}-${jobId.slice(0, 12)}`,
      status: 'succeeded',
      progress: 90,
      glbUrl: remoteUrl,
      rawMeta: { pipeline: pipelineTag },
    };
  }

  throw new AppError(
    502,
    'PROVIDER_EMPTY_ASSET',
    'NVIDIA NIM 3D completed without returning a GLB artifact.'
  );
}

async function postJsonWithTransientRetry(params: {
  url: string;
  apiKey: string;
  payload: Record<string, unknown>;
  jobId: string;
  pipelineTag: string;
  deadlineMs: number;
  maxAttempts: number;
  perAttemptCapMs: number;
}): Promise<ProviderSubmissionResult> {
  const isTest = getConfig().isTest;
  let lastErr: unknown;

  for (let attempt = 0; attempt < params.maxAttempts; attempt++) {
    const remaining = params.deadlineMs - Date.now();
    if (remaining < 3_500) break;

    const timeoutMs = Math.min(params.perAttemptCapMs, remaining - 500);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(params.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${params.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, model/gltf-binary',
        },
        body: JSON.stringify(params.payload),
        signal: controller.signal,
      });
      return await parseNim3dResponse(res, params.jobId, params.pipelineTag);
    } catch (err) {
      lastErr = err;
      if (
        err instanceof Nim3dHttpError &&
        isRetryableHttpStatus(err.httpStatus) &&
        attempt + 1 < params.maxAttempts
      ) {
        const delay = isTest ? 35 : 1100 * Math.pow(1.9, attempt) + Math.floor(Math.random() * 250);
        if (params.deadlineMs - Date.now() > delay + 5_000) {
          await sleep(delay);
          continue;
        }
      }
      break;
    } finally {
      clearTimeout(timer);
    }
  }

  if (lastErr instanceof AppError) throw lastErr;
  if (lastErr instanceof Error && lastErr.name === 'AbortError') {
    throw new AppError(
      504,
      'PROVIDER_TIMEOUT',
      'NVIDIA NIM 3D generation timed out. Try Draft or Standard quality.'
    );
  }
  throw new AppError(
    502,
    'PROVIDER_NETWORK_ERROR',
    `Unable to reach NVIDIA NIM 3D endpoint: ${lastErr instanceof Error ? lastErr.message : 'network error'}`
  );
}

async function invokeStabilityImageTo3d(params: {
  url: string;
  apiKey: string;
  encoded: { buffer: Buffer; mimeType: string; dataUrl: string };
  jobId: string;
  pipelineTag: string;
  deadlineMs: number;
  maxAttempts: number;
}): Promise<ProviderSubmissionResult> {
  try {
    // Hosted NVIDIA NIM Stability 3D endpoints accept JSON `{ image: "data:image/...;base64,..." }`
    return await postJsonWithTransientRetry({
      url: params.url,
      apiKey: params.apiKey,
      payload: { image: params.encoded.dataUrl },
      jobId: params.jobId,
      pipelineTag: params.pipelineTag,
      deadlineMs: params.deadlineMs,
      maxAttempts: params.maxAttempts,
      perAttemptCapMs: 28_000,
    });
  } catch (err) {
    // Fallback to multipart/form-data if a self-hosted/newer gateway requires binary form upload
    if (
      err instanceof Nim3dHttpError &&
      (err.httpStatus === 415 || err.httpStatus === 422 || err.httpStatus === 400) &&
      params.deadlineMs - Date.now() > 6_000
    ) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        Math.min(24_000, params.deadlineMs - Date.now() - 500)
      );
      try {
        const form = new FormData();
        const ext = params.encoded.mimeType === 'image/png' ? 'png' : 'jpg';
        form.append(
          'image',
          new Blob([new Uint8Array(params.encoded.buffer)], { type: params.encoded.mimeType }),
          `reference.${ext}`
        );
        const res = await fetch(params.url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${params.apiKey}`,
            Accept: 'application/json, model/gltf-binary',
          },
          body: form,
          signal: controller.signal,
        });
        return await parseNim3dResponse(res, params.jobId, params.pipelineTag);
      } finally {
        clearTimeout(timer);
      }
    }
    throw err;
  }
}

/**
 * Generate a clean, isolated single-object studio reference image via NVIDIA NIM GenAI
 * (FLUX.1-schnell -> SD3-Medium) using the user's same NVIDIA API key, used strictly when
 * direct Text-to-3D is unavailable (e.g. TRELLIS HTTP 503 safety screener outage or image-only 3D NIM).
 */
async function synthesizeStudioReferenceImageViaNim(params: {
  apiKey: string;
  cleanPrompt: string;
  deadlineMs: number;
}): Promise<Buffer | null> {
  const studioPrompt = `${params.cleanPrompt.slice(0, 340)}, single centered 3D object isolated on plain solid light neutral gray background, full three-quarter front view, complete object in frame, soft even studio lighting, crisp PBR surface materials, no text`;

  const candidates: Array<{
    url: string;
    body: Record<string, unknown>;
  }> = [
    {
      url: NIM_FLUX_SCHNELL_URL,
      body: {
        prompt: studioPrompt,
        width: 768,
        height: 768,
        seed: 0,
        steps: 4,
      },
    },
    {
      url: NIM_SD3_MEDIUM_URL,
      body: {
        prompt: studioPrompt,
        cfg_scale: 5,
        aspect_ratio: '1:1',
        seed: 0,
        steps: 28,
        negative_prompt: 'cropped, cut off, multiple objects, blurry, dark shadows, text, watermark',
      },
    },
  ];

  for (const candidate of candidates) {
    const remaining = params.deadlineMs - Date.now();
    if (remaining < 10_000) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(18_000, remaining - 5_000));
    try {
      const res = await fetch(candidate.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${params.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(candidate.body),
        signal: controller.signal,
      });
      if (!res.ok) continue;

      const data = (await res.json().catch(() => ({}))) as NimGenAiJsonResponse;
      const imgB64 = data.artifacts?.[0]?.base64 || data.image || '';
      if (typeof imgB64 === 'string' && imgB64.length > 100) {
        return decodeBase64Binary(imgB64, 'reference image');
      }
    } catch {
      // Try next hosted NVIDIA NIM image model
    } finally {
      clearTimeout(timer);
    }
  }

  return null;
}

function shouldAttemptHostedFallback(err: unknown): boolean {
  if (err instanceof Nim3dHttpError) {
    // Never mask bad API keys or zero-credit errors
    if (err.httpStatus === 401 || err.httpStatus === 403 || err.httpStatus === 402) {
      return false;
    }
    return (
      err.isSafetyUnavailable ||
      err.httpStatus === 404 ||
      err.httpStatus === 429 ||
      err.httpStatus === 502 ||
      err.httpStatus === 503 ||
      err.httpStatus === 504
    );
  }
  return err instanceof AppError && err.code === 'PROVIDER_TIMEOUT';
}

/**
 * NVIDIA NIM Native 3D Provider Adapter (TRELLIS + Stability 3D NIM fallback).
 * Uses only the user's NVIDIA NIM API key (`nvapi-...` from browser localStorage or server env),
 * automatically retries transient 503 content-safety-screening hiccups, and seamlessly bridges
 * through NVIDIA NIM's hosted Stability 3D endpoints when TRELLIS experiences temporary 503 outages.
 */
export class NvidiaNim3DProviderAdapter implements I3DGenerationProvider {
  readonly id = 'nim-trellis' as const;
  readonly displayName = 'NVIDIA NIM 3D (TRELLIS)';
  readonly requiredEnvVars = ['NVIDIA_NIM_API_KEY'];

  readonly capabilities: ProviderCapabilities = {
    textTo3D: true,
    imageTo3D: true,
    multiViewImageTo3D: false,
    supportedViews: ['front'],
    maxTextureResolution: '4k',
    pbrMaterials: true,
    rigging: false,
    animation: false,
    gltfExport: true,
    webhooks: false,
  };

  isConfigured(): boolean {
    const nim = getEffectiveNimConfig();
    return Boolean(nim.nim3dEnabled && nim.apiKey && nim.nim3dEndpoint);
  }

  hasWebhookSecret(): boolean {
    return false;
  }

  async checkConnectivity(): Promise<ConnectivityCheckResult> {
    const checkedAt = new Date().toISOString();
    const nim = getEffectiveNimConfig();

    if (!nim.apiKey || !nim.nim3dEnabled) {
      return {
        service: this.displayName,
        configured: false,
        reachable: false,
        latencyMs: null,
        statusCode: null,
        message: 'Add your NVIDIA NIM API key (nvapi-...) in API Key settings to enable NVIDIA NIM 3D.',
        checkedAt,
        endpoint: nim.nim3dEndpoint,
      };
    }

    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const res = await fetch(nim.nim3dEndpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${nim.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({}),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - start;

      if (res.ok || res.status === 400 || res.status === 422) {
        return {
          service: this.displayName,
          configured: true,
          reachable: true,
          latencyMs,
          statusCode: res.status,
          message: `Connected to ${this.displayName} (${latencyMs} ms).`,
          checkedAt,
          endpoint: nim.nim3dEndpoint,
        };
      }

      const raw = await res.text().catch(() => '');
      let parsed: NimGenAiJsonResponse = {};
      try {
        parsed = JSON.parse(raw) as NimGenAiJsonResponse;
      } catch {
        // Ignore non-JSON body
      }
      const mapped = buildNim3dHttpError(res.status, raw, parsed);

      return {
        service: this.displayName,
        configured: true,
        reachable: false,
        latencyMs,
        statusCode: res.status,
        message: mapped.message,
        checkedAt,
        endpoint: nim.nim3dEndpoint,
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const msg =
        err instanceof Error && err.name === 'AbortError'
          ? 'Connection timed out after 12s.'
          : err instanceof Error
          ? err.message
          : 'Network error';
      return {
        service: this.displayName,
        configured: true,
        reachable: false,
        latencyMs,
        statusCode: null,
        message: `Could not reach NVIDIA NIM 3D endpoint: ${msg}`,
        checkedAt,
        endpoint: nim.nim3dEndpoint,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async submitTextTo3D(req: ProviderTextJobRequest): Promise<ProviderSubmissionResult> {
    const nim = getEffectiveNimConfig();
    if (!nim.apiKey || !nim.nim3dEnabled) {
      throw new AppError(
        503,
        'PROVIDER_NOT_CONFIGURED',
        'Add your NVIDIA NIM API key to run Text-to-3D generation.'
      );
    }

    const totalBudgetMs = getConfig().isVercel ? 47_000 : 75_000;
    const deadlineMs = Date.now() + totalBudgetMs;
    const steps = QUALITY_STEPS[req.settings.quality] ?? QUALITY_STEPS.standard;
    const cleanPrompt = buildClean3dPrompt(req.prompt, req.spec.enhancedPrompt, 460);
    const hosted = isHostedNvidiaEndpoint(nim.nim3dEndpoint);
    const imageOnlySelected = isImageOnlyNim3dEndpoint(nim.nim3dEndpoint);

    let primaryError: unknown = null;

    // 1. Primary direct Text-to-3D via TRELLIS (with automatic retry on transient 503 safety hiccups)
    if (!imageOnlySelected) {
      try {
        return await postJsonWithTransientRetry({
          url: nim.nim3dEndpoint,
          apiKey: nim.apiKey,
          payload: {
            prompt: cleanPrompt,
            slat_cfg_scale: 3.0,
            ss_cfg_scale: 7.5,
            slat_sampling_steps: steps.slat,
            ss_sampling_steps: steps.ss,
            seed: 0,
            no_texture: !req.settings.pbr,
          },
          jobId: req.jobId,
          pipelineTag: 'nim3d-trellis',
          deadlineMs,
          maxAttempts: 3,
          perAttemptCapMs: 36_000,
        });
      } catch (err) {
        primaryError = err;
        if (!hosted || !shouldAttemptHostedFallback(err)) {
          throw err;
        }
      }
    }

    // 2. Hosted NVIDIA NIM two-stage real 3D synthesis (NIM Studio Image -> NIM 3D Mesh)
    // Engaged when TRELLIS text endpoint returns HTTP 503 (e.g. content safety screening
    // temporarily unavailable) / 404, or when user picked Stable Fast 3D / SPAR3D preset.
    if (hosted && deadlineMs - Date.now() > 14_000) {
      const refImageBuf = await synthesizeStudioReferenceImageViaNim({
        apiKey: nim.apiKey,
        cleanPrompt: buildClean3dPrompt(req.prompt, req.prompt, 320),
        deadlineMs,
      });

      if (refImageBuf) {
        const encoded = await encodeImageForNim(refImageBuf);
        const meshFallbacks: Array<{ url: string; tag: string; isTrellis?: boolean }> =
          imageOnlySelected
            ? [
                { url: nim.nim3dEndpoint, tag: 'nim3d-sf3d' },
                {
                  url: nim.nim3dEndpoint === NIM_SF3D_URL ? NIM_SPAR3D_URL : NIM_SF3D_URL,
                  tag: 'nim3d-spar3d',
                },
              ]
            : [
                { url: NIM_SF3D_URL, tag: 'nim3d-sf3d' },
                { url: NIM_SPAR3D_URL, tag: 'nim3d-spar3d' },
                { url: NIM_TRELLIS_URL, tag: 'nim3d-trellis-img', isTrellis: true },
              ];

        for (const fb of meshFallbacks) {
          if (deadlineMs - Date.now() < 6_000) break;
          try {
            if (fb.isTrellis) {
              return await postJsonWithTransientRetry({
                url: fb.url,
                apiKey: nim.apiKey,
                payload: {
                  image: encoded.dataUrl,
                  slat_cfg_scale: 3.0,
                  ss_cfg_scale: 7.5,
                  slat_sampling_steps: steps.slat,
                  ss_sampling_steps: steps.ss,
                  seed: 0,
                  no_texture: !req.settings.pbr,
                },
                jobId: req.jobId,
                pipelineTag: fb.tag,
                deadlineMs,
                maxAttempts: 1,
                perAttemptCapMs: 28_000,
              });
            }
            return await invokeStabilityImageTo3d({
              url: fb.url,
              apiKey: nim.apiKey,
              encoded,
              jobId: req.jobId,
              pipelineTag: fb.tag,
              deadlineMs,
              maxAttempts: 2,
            });
          } catch (fbErr) {
            if (!primaryError) primaryError = fbErr;
          }
        }
      }
    }

    if (primaryError instanceof Error) {
      throw primaryError;
    }
    throw new AppError(
      503,
      'PROVIDER_SAFETY_UNAVAILABLE',
      'NVIDIA NIM 3D service is temporarily unavailable (HTTP 503). Please retry in a few seconds or upload a reference image in Image-to-3D mode.'
    );
  }

  async submitImageTo3D(req: ProviderImageJobRequest): Promise<ProviderSubmissionResult> {
    const nim = getEffectiveNimConfig();
    if (!nim.apiKey || !nim.nim3dEnabled) {
      throw new AppError(
        503,
        'PROVIDER_NOT_CONFIGURED',
        'Add your NVIDIA NIM API key to run Image-to-3D generation.'
      );
    }

    const primary = req.images.find((i) => i.viewAngle === 'front') ?? req.images[0];
    if (!primary) {
      throw new AppError(400, 'MISSING_IMAGE', 'At least one reference image is required.');
    }

    const encoded = await encodeImageForNim(primary.buffer);
    const totalBudgetMs = getConfig().isVercel ? 47_000 : 75_000;
    const deadlineMs = Date.now() + totalBudgetMs;
    const steps = QUALITY_STEPS[req.settings.quality] ?? QUALITY_STEPS.standard;
    const hosted = isHostedNvidiaEndpoint(nim.nim3dEndpoint);
    const isStabilityPrimary = isImageOnlyNim3dEndpoint(nim.nim3dEndpoint);

    let primaryError: unknown;
    try {
      if (isStabilityPrimary) {
        return await invokeStabilityImageTo3d({
          url: nim.nim3dEndpoint,
          apiKey: nim.apiKey,
          encoded,
          jobId: req.jobId,
          pipelineTag: 'nim3d-sf3d',
          deadlineMs,
          maxAttempts: 3,
        });
      }
      return await postJsonWithTransientRetry({
        url: nim.nim3dEndpoint,
        apiKey: nim.apiKey,
        payload: {
          image: encoded.dataUrl,
          slat_cfg_scale: 3.0,
          ss_cfg_scale: 7.5,
          slat_sampling_steps: steps.slat,
          ss_sampling_steps: steps.ss,
          seed: 0,
          no_texture: !req.settings.pbr,
        },
        jobId: req.jobId,
        pipelineTag: 'nim3d-trellis',
        deadlineMs,
        maxAttempts: 3,
        perAttemptCapMs: 36_000,
      });
    } catch (err) {
      primaryError = err;
      if (!hosted || !shouldAttemptHostedFallback(err)) {
        throw err;
      }
    }

    // Automatic hosted NVIDIA NIM Image-to-3D fallback if primary endpoint hits 503 safety unavailability
    const fallbacks = [NIM_SF3D_URL, NIM_SPAR3D_URL].filter(
      (u) => u !== nim.nim3dEndpoint.toLowerCase()
    );
    for (const fallbackUrl of fallbacks) {
      if (deadlineMs - Date.now() < 6_000) break;
      try {
        return await invokeStabilityImageTo3d({
          url: fallbackUrl,
          apiKey: nim.apiKey,
          encoded,
          jobId: req.jobId,
          pipelineTag: fallbackUrl === NIM_SF3D_URL ? 'nim3d-sf3d' : 'nim3d-spar3d',
          deadlineMs,
          maxAttempts: 2,
        });
      } catch {
        // Continue to next hosted NIM 3D candidate
      }
    }

    throw primaryError;
  }

  async getJobStatus(externalJobId: string): Promise<ProviderJobStatusResult> {
    return {
      externalJobId,
      status: 'succeeded',
      progress: 100,
      stageLabel: 'Completed on NVIDIA NIM 3D',
    };
  }

  async downloadGlb(glbUrl: string): Promise<Buffer> {
    const nim = getEffectiveNimConfig();
    const headers: Record<string, string> = {};
    if (nim.apiKey) {
      headers.Authorization = `Bearer ${nim.apiKey}`;
    }
    return fetchProviderBinary(glbUrl, headers);
  }

  verifyWebhookSignature(): boolean {
    return false;
  }

  parseWebhookPayload(): ProviderWebhookEvent {
    throw new AppError(400, 'WEBHOOK_UNSUPPORTED', 'NVIDIA NIM 3D operates synchronously without webhooks.');
  }
}
