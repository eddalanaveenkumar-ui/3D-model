import type { ConnectivityCheckResult, ProviderCapabilities } from '@nv3d/shared';
import { getConfig } from '../config/env.js';
import { AppError } from '../services/authService.js';
import { sanitizePlainText } from '../services/safetyService.js';
import {
  fetchProviderBinary,
  verifyHmacSha256Signature,
  type I3DGenerationProvider,
  type ProviderImageJobRequest,
  type ProviderJobStatusResult,
  type ProviderSubmissionResult,
  type ProviderTextJobRequest,
  type ProviderWebhookEvent,
} from './types.js';

/**
 * Replaceable Generic HTTP 3D Provider Adapter.
 * Connects NV3D Studio to any self-hosted or enterprise 3D generation gateway
 * (e.g. Hunyuan3D-2, TRELLIS, Rodin, Stable Fast 3D, or NVIDIA Edify 3D service)
 * implementing:
 *   GET  {baseUrl}/health
 *   POST {baseUrl}/generate/text   -> { jobId, status, progress?, glbUrl? }
 *   POST {baseUrl}/generate/image  -> { jobId, status, progress?, glbUrl? }
 *   GET  {baseUrl}/jobs/:jobId     -> { jobId, status, progress?, stage?, glbUrl?, error? }
 */
export class CustomHttpProviderAdapter implements I3DGenerationProvider {
  readonly id = 'custom' as const;
  readonly requiredEnvVars = ['CUSTOM_3D_PROVIDER_URL'];

  get displayName(): string {
    return getConfig().custom3d.name || 'Custom 3D Provider';
  }

  get capabilities(): ProviderCapabilities {
    const c = getConfig().custom3d;
    return {
      textTo3D: true,
      imageTo3D: true,
      multiViewImageTo3D: c.supportsMultiView,
      supportedViews: c.supportsMultiView ? ['front', 'side', 'back'] : ['front'],
      maxTextureResolution: '4k',
      pbrMaterials: true,
      rigging: c.supportsRigging,
      animation: c.supportsAnimation,
      gltfExport: true,
      webhooks: true,
    };
  }

  private get cfg() {
    return getConfig().custom3d;
  }

  isConfigured(): boolean {
    return this.cfg.baseUrl.length > 0;
  }

  hasWebhookSecret(): boolean {
    return this.cfg.webhookSecret.length > 0;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.cfg.apiKey) {
      h.Authorization = `Bearer ${this.cfg.apiKey}`;
    }
    return h;
  }

  async checkConnectivity(): Promise<ConnectivityCheckResult> {
    const checkedAt = new Date().toISOString();
    if (!this.isConfigured()) {
      return {
        service: this.displayName,
        configured: false,
        reachable: false,
        latencyMs: null,
        statusCode: null,
        message: 'Not configured. Set CUSTOM_3D_PROVIDER_URL in server environment variables.',
        checkedAt,
      };
    }

    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${this.cfg.baseUrl}/health`, {
        method: 'GET',
        headers: this.headers(),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - start;
      return {
        service: this.displayName,
        configured: true,
        reachable: res.ok,
        latencyMs,
        statusCode: res.status,
        message: res.ok
          ? `Connected to ${this.displayName} (${latencyMs} ms).`
          : `${this.displayName} returned HTTP ${res.status}.`,
        checkedAt,
        endpoint: this.cfg.baseUrl,
      };
    } catch (err) {
      return {
        service: this.displayName,
        configured: true,
        reachable: false,
        latencyMs: Date.now() - start,
        statusCode: null,
        message: `Connection failed: ${err instanceof Error ? err.message : 'network error'}`,
        checkedAt,
        endpoint: this.cfg.baseUrl,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async submitTextTo3D(req: ProviderTextJobRequest): Promise<ProviderSubmissionResult> {
    if (!this.isConfigured()) {
      throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'Custom 3D provider URL is not configured.');
    }

    const res = await fetch(`${this.cfg.baseUrl}/generate/text`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        clientJobId: req.jobId,
        prompt: req.spec.enhancedPrompt,
        negativePrompt: req.spec.negativePrompt,
        rawPrompt: req.prompt,
        structuredSpec: req.spec,
        settings: req.settings,
      }),
    });

    const data = (await res.json().catch(() => ({}))) as {
      jobId?: string;
      status?: string;
      progress?: number;
      glbUrl?: string;
      error?: string;
    };

    if (!res.ok || !data.jobId) {
      throw new AppError(
        502,
        'PROVIDER_SUBMIT_FAILED',
        `${this.displayName} submission failed (${res.status}): ${sanitizePlainText(data.error || 'missing jobId', 240)}`
      );
    }

    const normStatus =
      data.status === 'succeeded' ? 'succeeded' : data.status === 'processing' ? 'processing' : 'queued';

    return {
      externalJobId: data.jobId,
      status: normStatus,
      progress: typeof data.progress === 'number' ? data.progress : 20,
      glbUrl: data.glbUrl,
    };
  }

  async submitImageTo3D(req: ProviderImageJobRequest): Promise<ProviderSubmissionResult> {
    if (!this.isConfigured()) {
      throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'Custom 3D provider URL is not configured.');
    }

    const res = await fetch(`${this.cfg.baseUrl}/generate/image`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        clientJobId: req.jobId,
        prompt: req.spec.enhancedPrompt,
        structuredSpec: req.spec,
        settings: req.settings,
        images: req.images.map((img) => ({
          viewAngle: img.viewAngle,
          mimeType: img.mimeType,
          dataUrl: img.dataUrl,
        })),
      }),
    });

    const data = (await res.json().catch(() => ({}))) as {
      jobId?: string;
      status?: string;
      progress?: number;
      glbUrl?: string;
      error?: string;
    };

    if (!res.ok || !data.jobId) {
      throw new AppError(
        502,
        'PROVIDER_SUBMIT_FAILED',
        `${this.displayName} image submission failed (${res.status}): ${sanitizePlainText(data.error || 'missing jobId', 240)}`
      );
    }

    const normStatus =
      data.status === 'succeeded' ? 'succeeded' : data.status === 'processing' ? 'processing' : 'queued';

    return {
      externalJobId: data.jobId,
      status: normStatus,
      progress: typeof data.progress === 'number' ? data.progress : 20,
      glbUrl: data.glbUrl,
    };
  }

  async getJobStatus(externalJobId: string): Promise<ProviderJobStatusResult> {
    const res = await fetch(`${this.cfg.baseUrl}/jobs/${encodeURIComponent(externalJobId)}`, {
      method: 'GET',
      headers: this.headers(),
    });

    const data = (await res.json().catch(() => ({}))) as {
      jobId?: string;
      status?: string;
      progress?: number;
      stage?: string;
      glbUrl?: string;
      gltfUrl?: string;
      error?: string;
    };

    if (!res.ok) {
      throw new AppError(
        502,
        'PROVIDER_POLL_FAILED',
        `${this.displayName} poll failed (${res.status}): ${sanitizePlainText(data.error || 'error', 200)}`
      );
    }

    const st = (data.status || 'processing').toLowerCase();
    const pct = typeof data.progress === 'number' ? Math.max(0, Math.min(100, data.progress)) : 45;

    if (st === 'succeeded' || st === 'completed') {
      if (!data.glbUrl) {
        return {
          externalJobId,
          status: 'failed',
          progress: 100,
          stageLabel: 'Failed',
          errorMessage: 'Provider completed job without returning a GLB download URL.',
        };
      }
      return {
        externalJobId,
        status: 'succeeded',
        progress: 100,
        stageLabel: sanitizePlainText(data.stage || 'Mesh ready', 80),
        glbUrl: data.glbUrl,
        gltfUrl: data.gltfUrl,
      };
    }

    if (st === 'failed' || st === 'error' || st === 'canceled') {
      return {
        externalJobId,
        status: 'failed',
        progress: pct,
        stageLabel: 'Provider failed',
        errorMessage: sanitizePlainText(data.error || '3D provider reported failure.', 300),
      };
    }

    return {
      externalJobId,
      status: st === 'queued' || st === 'pending' ? 'queued' : 'processing',
      progress: Math.round(20 + pct * 0.65),
      stageLabel: sanitizePlainText(data.stage || `Generating 3D model (${pct}%)`, 80),
    };
  }

  async downloadGlb(glbUrl: string): Promise<Buffer> {
    const authHeaders: Record<string, string> = {};
    if (this.cfg.apiKey) {
      authHeaders.Authorization = `Bearer ${this.cfg.apiKey}`;
    }
    return fetchProviderBinary(glbUrl, authHeaders);
  }

  verifyWebhookSignature(
    rawBody: Buffer,
    signatureHeader: string | undefined,
    timestampHeader?: string | undefined
  ): boolean {
    return verifyHmacSha256Signature({
      secret: this.cfg.webhookSecret,
      rawBody,
      signatureHeader,
      timestampHeader,
    });
  }

  parseWebhookPayload(payload: unknown): ProviderWebhookEvent {
    const obj = (payload ?? {}) as {
      jobId?: string;
      status?: string;
      progress?: number;
      glbUrl?: string;
      error?: string;
    };
    if (!obj.jobId || typeof obj.jobId !== 'string') {
      throw new AppError(400, 'INVALID_WEBHOOK_PAYLOAD', 'Missing jobId in provider webhook payload.');
    }
    const st = (obj.status || '').toLowerCase();
    return {
      externalJobId: obj.jobId,
      status:
        st === 'succeeded' || st === 'completed'
          ? 'succeeded'
          : st === 'failed' || st === 'error'
          ? 'failed'
          : 'processing',
      progress: typeof obj.progress === 'number' ? obj.progress : undefined,
      glbUrl: obj.glbUrl,
      errorMessage: obj.error,
    };
  }
}
