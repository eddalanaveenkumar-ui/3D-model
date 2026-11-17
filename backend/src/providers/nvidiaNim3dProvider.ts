import sharp from 'sharp';
import type { ConnectivityCheckResult, ProviderCapabilities, QualityTier } from '@nv3d/shared';
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

const QUALITY_STEPS: Record<QualityTier, { ss: number; slat: number }> = {
  draft: { ss: 16, slat: 16 },
  standard: { ss: 25, slat: 25 },
  high: { ss: 36, slat: 36 },
};

// Keep inline base64 data URL strictly below NVIDIA NIM's ~180 KB JSON payload image limit
const MAX_INLINE_IMAGE_BYTES = 130_000;

interface Nim3dJsonResponse {
  artifacts?: Array<{
    base64?: string;
    finishReason?: string;
    seed?: number;
  }>;
  glb?: string;
  glb_base64?: string;
  model?: string;
  glbUrl?: string;
  output_url?: string;
  detail?: unknown;
  title?: string;
  message?: string;
  error?: { message?: string } | string;
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

function decodeBase64Glb(encoded: string): Buffer {
  const cleaned = encoded.trim().replace(/^data:[^;]+;base64,/i, '').replace(/\s+/g, '');
  if (!cleaned) {
    throw new AppError(502, 'PROVIDER_EMPTY_ASSET', 'NVIDIA NIM 3D returned an empty base64 artifact.');
  }
  return Buffer.from(cleaned, 'base64');
}

function extractErrorDetail(status: number, rawText: string, parsed: Nim3dJsonResponse): string {
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
  if (status === 401 || status === 403) {
    return `Authentication rejected by NVIDIA NIM 3D (HTTP ${status}): ${clean}. Verify your NVIDIA API key (nvapi-...) and 3D model access on build.nvidia.com.`;
  }
  if (status === 402) {
    return `NVIDIA NIM API credits exhausted (HTTP 402): ${clean}.`;
  }
  if (status === 404) {
    return `NVIDIA NIM 3D endpoint returned HTTP 404 (${clean}). Verify the 3D NIM endpoint URL in API Key settings (e.g. microsoft/trellis or self-hosted NIM URL).`;
  }
  return `NVIDIA NIM 3D request failed (HTTP ${status}): ${clean}`;
}

async function parseNim3dResponse(
  res: Response,
  jobId: string
): Promise<ProviderSubmissionResult> {
  const contentType = (res.headers.get('content-type') || '').toLowerCase();

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    let parsedErr: Nim3dJsonResponse = {};
    try {
      parsedErr = JSON.parse(errText) as Nim3dJsonResponse;
    } catch {
      // Non-JSON error body
    }
    throw new AppError(502, 'PROVIDER_SUBMIT_FAILED', extractErrorDetail(res.status, errText, parsedErr));
  }

  // Binary GLB response path (used by Stable Fast 3D / SPAR3D / direct binary NIM gateways)
  if (
    contentType.includes('model/gltf-binary') ||
    contentType.includes('application/octet-stream')
  ) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0) {
      throw new AppError(502, 'PROVIDER_EMPTY_ASSET', 'NVIDIA NIM 3D returned an empty GLB stream.');
    }
    return {
      externalJobId: `nim3d-${jobId.slice(0, 12)}`,
      status: 'succeeded',
      progress: 90,
      glbBuffer: buf,
    };
  }

  // JSON artifact response path (standard NVIDIA NIM microsoft/trellis response)
  const rawText = await res.text();
  let data: Nim3dJsonResponse = {};
  try {
    data = JSON.parse(rawText) as Nim3dJsonResponse;
  } catch {
    throw new AppError(502, 'PROVIDER_INVALID_RESPONSE', 'NVIDIA NIM 3D returned invalid JSON.');
  }

  const b64Candidate =
    data.artifacts?.[0]?.base64 || data.glb_base64 || data.glb || data.model || '';
  if (typeof b64Candidate === 'string' && b64Candidate.length > 0) {
    return {
      externalJobId: `nim3d-${jobId.slice(0, 12)}`,
      status: 'succeeded',
      progress: 90,
      glbBuffer: decodeBase64Glb(b64Candidate),
      rawMeta: {
        seed: data.artifacts?.[0]?.seed ?? 0,
        finishReason: data.artifacts?.[0]?.finishReason ?? 'SUCCESS',
      },
    };
  }

  const remoteUrl = data.glbUrl || data.output_url;
  if (typeof remoteUrl === 'string' && remoteUrl.length > 0) {
    return {
      externalJobId: `nim3d-${jobId.slice(0, 12)}`,
      status: 'succeeded',
      progress: 90,
      glbUrl: remoteUrl,
    };
  }

  throw new AppError(
    502,
    'PROVIDER_EMPTY_ASSET',
    'NVIDIA NIM 3D completed without returning a GLB artifact.'
  );
}

/**
 * NVIDIA NIM Native 3D Provider Adapter (Microsoft TRELLIS / Stability 3D NIM).
 * Uses the same NVIDIA NIM API key (`nvapi-...` from browser localStorage or server env)
 * while keeping MiniMax M3.1 Flash strictly separated as the prompt/vision orchestrator.
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
      // Lightweight schema probe: verifies DNS/TLS, endpoint existence, and Bearer key acceptance
      // without billing a full 3D generation inference run.
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

      // 200/204 or 400/422 (input schema validation) confirms the NIM 3D service accepted auth and is live
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
      let parsed: Nim3dJsonResponse = {};
      try {
        parsed = JSON.parse(raw) as Nim3dJsonResponse;
      } catch {
        // Ignore non-JSON body
      }

      return {
        service: this.displayName,
        configured: true,
        reachable: false,
        latencyMs,
        statusCode: res.status,
        message: extractErrorDetail(res.status, raw, parsed),
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

    const endpointLower = nim.nim3dEndpoint.toLowerCase();
    if (
      endpointLower.includes('stable-fast-3d') ||
      endpointLower.includes('stable-point-aware-3d')
    ) {
      throw new AppError(
        400,
        'MODALITY_UNSUPPORTED',
        'The configured Stability 3D NIM endpoint supports Image-to-3D only. Switch to Image-to-3D or use microsoft/trellis for Text-to-3D.'
      );
    }

    const steps = QUALITY_STEPS[req.settings.quality] ?? QUALITY_STEPS.standard;
    // Keep prompt concise and clean for TRELLIS text conditioning
    const prompt = sanitizePlainText(req.spec.enhancedPrompt || req.prompt, 800);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55_000);
    try {
      const res = await fetch(nim.nim3dEndpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${nim.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          prompt,
          slat_cfg_scale: 3.0,
          ss_cfg_scale: 7.5,
          slat_sampling_steps: steps.slat,
          ss_sampling_steps: steps.ss,
          seed: 0,
          no_texture: !req.settings.pbr,
        }),
        signal: controller.signal,
      });

      return await parseNim3dResponse(res, req.jobId);
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AppError(
          504,
          'PROVIDER_TIMEOUT',
          'NVIDIA NIM 3D generation timed out. Try Draft or Standard quality.'
        );
      }
      throw new AppError(
        502,
        'PROVIDER_NETWORK_ERROR',
        `Unable to reach NVIDIA NIM 3D endpoint: ${err instanceof Error ? err.message : 'network error'}`
      );
    } finally {
      clearTimeout(timeout);
    }
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
    const endpointLower = nim.nim3dEndpoint.toLowerCase();
    const isStability3d =
      endpointLower.includes('stable-fast-3d') || endpointLower.includes('stable-point-aware-3d');
    const steps = QUALITY_STEPS[req.settings.quality] ?? QUALITY_STEPS.standard;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55_000);
    try {
      let res: Response;
      if (isStability3d) {
        const form = new FormData();
        const ext = encoded.mimeType === 'image/png' ? 'png' : 'jpg';
        form.append(
          'image',
          new Blob([new Uint8Array(encoded.buffer)], { type: encoded.mimeType }),
          `reference.${ext}`
        );
        res = await fetch(nim.nim3dEndpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${nim.apiKey}`,
            Accept: 'model/gltf-binary, application/json',
          },
          body: form,
          signal: controller.signal,
        });
      } else {
        res = await fetch(nim.nim3dEndpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${nim.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            image: encoded.dataUrl,
            slat_cfg_scale: 3.0,
            ss_cfg_scale: 7.5,
            slat_sampling_steps: steps.slat,
            ss_sampling_steps: steps.ss,
            seed: 0,
            no_texture: !req.settings.pbr,
          }),
          signal: controller.signal,
        });
      }

      return await parseNim3dResponse(res, req.jobId);
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AppError(
          504,
          'PROVIDER_TIMEOUT',
          'NVIDIA NIM 3D image reconstruction timed out. Try Draft or Standard quality.'
        );
      }
      throw new AppError(
        502,
        'PROVIDER_NETWORK_ERROR',
        `Unable to reach NVIDIA NIM 3D endpoint: ${err instanceof Error ? err.message : 'network error'}`
      );
    } finally {
      clearTimeout(timeout);
    }
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
