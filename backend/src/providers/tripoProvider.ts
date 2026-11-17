import {
  POLYGON_BUDGET_MAP,
  type ConnectivityCheckResult,
  type ProviderCapabilities,
} from '@nv3d/shared';
import { getConfig } from '../config/env.js';
import { AppError } from '../services/authService.js';
import { sanitizePlainText } from '../services/safetyService.js';
import {
  fetchProviderBinary,
  verifyHmacSha256Signature,
  type I3DGenerationProvider,
  type ProviderImageJobRequest,
  type ProviderJobStatusResult,
  type ProviderReferenceImage,
  type ProviderSubmissionResult,
  type ProviderTextJobRequest,
  type ProviderWebhookEvent,
} from './types.js';

/**
 * Tripo3D OpenAPI v2 Provider Adapter
 * Supports Text-to-3D, single Image-to-3D, Multi-View Image-to-3D (front, side, back),
 * PBR materials, detailed 4K textures, and optional auto-rigging & animation support.
 */
export class TripoProviderAdapter implements I3DGenerationProvider {
  readonly id = 'tripo' as const;
  readonly displayName = 'Tripo3D v2';
  readonly requiredEnvVars = ['TRIPO_API_KEY'];
  readonly capabilities: ProviderCapabilities = {
    textTo3D: true,
    imageTo3D: true,
    multiViewImageTo3D: true,
    supportedViews: ['front', 'side', 'back'],
    maxTextureResolution: '4k',
    pbrMaterials: true,
    rigging: true,
    animation: true,
    gltfExport: true,
    webhooks: true,
  };

  private get cfg() {
    return getConfig().tripo;
  }

  isConfigured(): boolean {
    return this.cfg.apiKey.length > 0;
  }

  hasWebhookSecret(): boolean {
    return this.cfg.webhookSecret.length > 0;
  }

  private jsonHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
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
        message: 'Not configured. Set TRIPO_API_KEY in server environment variables.',
        checkedAt,
        endpoint: this.cfg.baseUrl,
      };
    }

    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${this.cfg.baseUrl}/user/balance`, {
        method: 'GET',
        headers: this.jsonHeaders(),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - start;
      if (res.ok) {
        return {
          service: this.displayName,
          configured: true,
          reachable: true,
          latencyMs,
          statusCode: res.status,
          message: `Connected to Tripo3D OpenAPI (${latencyMs} ms).`,
          checkedAt,
          endpoint: this.cfg.baseUrl,
        };
      }
      const txt = await res.text().catch(() => '');
      return {
        service: this.displayName,
        configured: true,
        reachable: false,
        latencyMs,
        statusCode: res.status,
        message: `Tripo3D returned HTTP ${res.status}${txt ? `: ${sanitizePlainText(txt, 160)}` : ''}`,
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
        message: `Tripo3D connection failed: ${err instanceof Error ? err.message : 'network error'}`,
        checkedAt,
        endpoint: this.cfg.baseUrl,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async uploadReferenceImage(img: ProviderReferenceImage): Promise<{ type: string; file_token: string }> {
    const ext = img.mimeType === 'image/png' ? 'png' : img.mimeType === 'image/webp' ? 'webp' : 'jpg';
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(img.buffer)], { type: img.mimeType }),
      `${img.viewAngle}.${ext}`
    );

    const res = await fetch(`${this.cfg.baseUrl}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.apiKey}` },
      body: form,
    });

    const data = (await res.json().catch(() => ({}))) as {
      code?: number;
      message?: string;
      data?: { image_token?: string };
    };
    if (!res.ok || !data.data?.image_token) {
      throw new AppError(
        502,
        'PROVIDER_UPLOAD_FAILED',
        `Tripo3D reference image upload failed (${res.status}): ${sanitizePlainText(data.message || 'missing token', 200)}`
      );
    }
    return { type: ext, file_token: data.data.image_token };
  }

  async submitTextTo3D(req: ProviderTextJobRequest): Promise<ProviderSubmissionResult> {
    if (!this.isConfigured()) {
      throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'Tripo3D API key is not configured.');
    }

    const faceLimit = Math.min(
      200_000,
      req.spec.geometryGuidance.targetPolycount || POLYGON_BUDGET_MAP[req.settings.polygonDetail]
    );

    const payload: Record<string, unknown> = {
      type: 'text_to_model',
      model_version: 'v2.5-20250123',
      prompt: req.spec.enhancedPrompt.slice(0, 1024),
      negative_prompt: req.spec.negativePrompt.slice(0, 255),
      texture: true,
      pbr: req.settings.pbr,
      texture_quality: req.settings.textureResolution === '4k' ? 'detailed' : 'standard',
      face_limit: faceLimit,
      quad: req.spec.geometryGuidance.topology === 'quad-dominant',
      auto_size: true,
    };

    const res = await fetch(`${this.cfg.baseUrl}/task`, {
      method: 'POST',
      headers: this.jsonHeaders(),
      body: JSON.stringify(payload),
    });

    const data = (await res.json().catch(() => ({}))) as {
      code?: number;
      message?: string;
      data?: { task_id?: string };
    };
    if (!res.ok || !data.data?.task_id) {
      throw new AppError(
        502,
        'PROVIDER_SUBMIT_FAILED',
        `Tripo3D Text-to-3D submission failed (${res.status}): ${sanitizePlainText(data.message || 'error', 240)}`
      );
    }

    return {
      externalJobId: data.data.task_id,
      status: 'queued',
      progress: 15,
    };
  }

  async submitImageTo3D(req: ProviderImageJobRequest): Promise<ProviderSubmissionResult> {
    if (!this.isConfigured()) {
      throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'Tripo3D API key is not configured.');
    }

    const byView = new Map(req.images.map((img) => [img.viewAngle, img]));
    const front = byView.get('front') ?? req.images[0];
    const side = byView.get('side');
    const back = byView.get('back');

    const faceLimit = Math.min(
      200_000,
      req.spec.geometryGuidance.targetPolycount || POLYGON_BUDGET_MAP[req.settings.polygonDetail]
    );

    let payload: Record<string, unknown>;
    if (side || back) {
      const frontTok = await this.uploadReferenceImage(front);
      const sideTok = side ? await this.uploadReferenceImage(side) : {};
      const backTok = back ? await this.uploadReferenceImage(back) : {};
      // Tripo multiview file slot order: [front, left, back, right]
      payload = {
        type: 'multiview_to_model',
        model_version: 'v2.5-20250123',
        files: [frontTok, sideTok, backTok, {}],
        texture: true,
        pbr: req.settings.pbr,
        texture_quality: req.settings.textureResolution === '4k' ? 'detailed' : 'standard',
        face_limit: faceLimit,
        quad: req.spec.geometryGuidance.topology === 'quad-dominant',
        auto_size: true,
      };
    } else {
      const frontTok = await this.uploadReferenceImage(front);
      payload = {
        type: 'image_to_model',
        model_version: 'v2.5-20250123',
        file: frontTok,
        texture: true,
        pbr: req.settings.pbr,
        texture_quality: req.settings.textureResolution === '4k' ? 'detailed' : 'standard',
        face_limit: faceLimit,
        quad: req.spec.geometryGuidance.topology === 'quad-dominant',
        auto_size: true,
      };
    }

    const res = await fetch(`${this.cfg.baseUrl}/task`, {
      method: 'POST',
      headers: this.jsonHeaders(),
      body: JSON.stringify(payload),
    });

    const data = (await res.json().catch(() => ({}))) as {
      message?: string;
      data?: { task_id?: string };
    };
    if (!res.ok || !data.data?.task_id) {
      throw new AppError(
        502,
        'PROVIDER_SUBMIT_FAILED',
        `Tripo3D Image-to-3D submission failed (${res.status}): ${sanitizePlainText(data.message || 'error', 240)}`
      );
    }

    return {
      externalJobId: data.data.task_id,
      status: 'queued',
      progress: 15,
    };
  }

  async getJobStatus(externalJobId: string): Promise<ProviderJobStatusResult> {
    const res = await fetch(`${this.cfg.baseUrl}/task/${encodeURIComponent(externalJobId)}`, {
      method: 'GET',
      headers: this.jsonHeaders(),
    });

    const body = (await res.json().catch(() => ({}))) as {
      message?: string;
      data?: {
        status?: string;
        progress?: number;
        output?: { pbr_model?: string; model?: string; base_model?: string };
      };
    };

    if (!res.ok || !body.data) {
      throw new AppError(
        502,
        'PROVIDER_POLL_FAILED',
        `Tripo3D poll failed (${res.status}): ${sanitizePlainText(body.message || 'error', 200)}`
      );
    }

    const status = (body.data.status || 'queued').toLowerCase();
    const pct = typeof body.data.progress === 'number' ? Math.max(0, Math.min(100, body.data.progress)) : 0;

    if (status === 'success') {
      const glbUrl = body.data.output?.pbr_model || body.data.output?.model || body.data.output?.base_model;
      if (!glbUrl) {
        return {
          externalJobId,
          status: 'failed',
          progress: 100,
          stageLabel: 'Failed',
          errorMessage: 'Tripo3D task completed without a GLB output URL.',
        };
      }
      return {
        externalJobId,
        status: 'succeeded',
        progress: 100,
        stageLabel: 'PBR mesh generated',
        glbUrl,
      };
    }

    if (['failed', 'cancelled', 'banned', 'expired', 'unknown'].includes(status)) {
      return {
        externalJobId,
        status: 'failed',
        progress: pct,
        stageLabel: 'Provider failed',
        errorMessage: `Tripo3D task terminated with status "${status}".`,
      };
    }

    return {
      externalJobId,
      status: status === 'queued' ? 'queued' : 'processing',
      progress: Math.round(20 + pct * 0.65),
      stageLabel: status === 'queued' ? 'Queued on Tripo3D' : `Synthesizing 3D mesh (${pct}%)`,
    };
  }

  async downloadGlb(glbUrl: string): Promise<Buffer> {
    return fetchProviderBinary(glbUrl);
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
      task_id?: string;
      status?: string;
      progress?: number;
      output?: { pbr_model?: string; model?: string };
      message?: string;
    };
    if (!obj.task_id || typeof obj.task_id !== 'string') {
      throw new AppError(400, 'INVALID_WEBHOOK_PAYLOAD', 'Missing task_id in Tripo3D webhook payload.');
    }
    const st = (obj.status || '').toLowerCase();
    return {
      externalJobId: obj.task_id,
      status:
        st === 'success'
          ? 'succeeded'
          : ['failed', 'cancelled', 'banned', 'expired'].includes(st)
          ? 'failed'
          : 'processing',
      progress: typeof obj.progress === 'number' ? obj.progress : undefined,
      glbUrl: obj.output?.pbr_model || obj.output?.model,
      errorMessage: obj.message,
    };
  }
}
