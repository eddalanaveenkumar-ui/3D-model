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
  type ProviderSubmissionResult,
  type ProviderTextJobRequest,
  type ProviderWebhookEvent,
} from './types.js';

/**
 * Meshy API Provider Adapter
 * Supports:
 *  - Text-to-3D: POST /openapi/v2/text-to-3d
 *  - Image-to-3D (single view): POST /openapi/v1/image-to-3d
 *  - Multi-Image-to-3D (front, side, back): POST /openapi/v1/multi-image-to-3d
 *
 * External IDs are encoded as `<taskKind>:<meshyTaskId>` so getJobStatus routes accurately.
 */
export class MeshyProviderAdapter implements I3DGenerationProvider {
  readonly id = 'meshy' as const;
  readonly displayName = 'Meshy AI 3D';
  readonly requiredEnvVars = ['MESHY_API_KEY'];
  readonly capabilities: ProviderCapabilities = {
    textTo3D: true,
    imageTo3D: true,
    multiViewImageTo3D: true,
    supportedViews: ['front', 'side', 'back'],
    maxTextureResolution: '4k',
    pbrMaterials: true,
    rigging: false,
    animation: false,
    gltfExport: true,
    webhooks: true,
  };

  private get cfg() {
    return getConfig().meshy;
  }

  isConfigured(): boolean {
    return this.cfg.apiKey.length > 0;
  }

  hasWebhookSecret(): boolean {
    return this.cfg.webhookSecret.length > 0;
  }

  private authHeaders(): Record<string, string> {
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
        message: 'Not configured. Set MESHY_API_KEY in server environment variables.',
        checkedAt,
        endpoint: this.cfg.baseUrl,
      };
    }

    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${this.cfg.baseUrl}/openapi/v1/balance`, {
        method: 'GET',
        headers: this.authHeaders(),
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
          message: `Connected to Meshy API (${latencyMs} ms).`,
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
        message: `Meshy API returned HTTP ${res.status}${txt ? `: ${sanitizePlainText(txt, 160)}` : ''}`,
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
        message: `Meshy connection failed: ${err instanceof Error ? err.message : 'network error'}`,
        checkedAt,
        endpoint: this.cfg.baseUrl,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async submitTextTo3D(req: ProviderTextJobRequest): Promise<ProviderSubmissionResult> {
    if (!this.isConfigured()) {
      throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'Meshy API key is not configured.');
    }

    const artStyle = req.settings.style === 'sculpted' ? 'sculpture' : 'realistic';
    const topology = req.spec.geometryGuidance.topology === 'quad-dominant' ? 'quad' : 'triangle';
    const targetPolycount = Math.min(
      300_000,
      Math.max(1000, req.spec.geometryGuidance.targetPolycount || POLYGON_BUDGET_MAP[req.settings.polygonDetail])
    );

    const payload = {
      mode: 'preview',
      prompt: req.spec.enhancedPrompt.slice(0, 600),
      negative_prompt: req.spec.negativePrompt.slice(0, 300),
      art_style: artStyle,
      ai_model: req.settings.quality === 'high' ? 'meshy-4' : 'meshy-4',
      topology,
      target_polycount: targetPolycount,
      should_remesh: true,
      symmetry_mode: req.spec.geometryGuidance.symmetry === 'bilateral' ? 'on' : 'auto',
    };

    const res = await fetch(`${this.cfg.baseUrl}/openapi/v2/text-to-3d`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(payload),
    });

    const data = (await res.json().catch(() => ({}))) as { result?: string; message?: string };
    if (!res.ok || !data.result) {
      throw new AppError(
        502,
        'PROVIDER_SUBMIT_FAILED',
        `Meshy Text-to-3D submission failed (${res.status}): ${sanitizePlainText(data.message || 'unexpected response', 240)}`
      );
    }

    return {
      externalJobId: `text:${data.result}`,
      status: 'queued',
      progress: 15,
    };
  }

  async submitImageTo3D(req: ProviderImageJobRequest): Promise<ProviderSubmissionResult> {
    if (!this.isConfigured()) {
      throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'Meshy API key is not configured.');
    }

    const topology = req.spec.geometryGuidance.topology === 'quad-dominant' ? 'quad' : 'triangle';
    const targetPolycount = Math.min(
      300_000,
      Math.max(1000, req.spec.geometryGuidance.targetPolycount || POLYGON_BUDGET_MAP[req.settings.polygonDetail])
    );

    const isMultiView = req.images.length > 1;
    const endpoint = isMultiView
      ? `${this.cfg.baseUrl}/openapi/v1/multi-image-to-3d`
      : `${this.cfg.baseUrl}/openapi/v1/image-to-3d`;

    const ordered = [...req.images].sort((a, b) => {
      const rank = { front: 0, side: 1, back: 2 };
      return rank[a.viewAngle] - rank[b.viewAngle];
    });

    const payload = isMultiView
      ? {
          image_urls: ordered.slice(0, 4).map((i) => i.dataUrl),
          topology,
          target_polycount: targetPolycount,
          should_remesh: true,
          should_texture: true,
          enable_pbr: req.settings.pbr,
          texture_prompt: req.spec.enhancedPrompt.slice(0, 500),
        }
      : {
          image_url: ordered[0].dataUrl,
          topology,
          target_polycount: targetPolycount,
          should_remesh: true,
          should_texture: true,
          enable_pbr: req.settings.pbr,
          texture_prompt: req.spec.enhancedPrompt.slice(0, 500),
        };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(payload),
    });

    const data = (await res.json().catch(() => ({}))) as { result?: string; message?: string };
    if (!res.ok || !data.result) {
      throw new AppError(
        502,
        'PROVIDER_SUBMIT_FAILED',
        `Meshy Image-to-3D submission failed (${res.status}): ${sanitizePlainText(data.message || 'unexpected response', 240)}`
      );
    }

    const kind = isMultiView ? 'multiview' : 'image';
    return {
      externalJobId: `${kind}:${data.result}`,
      status: 'queued',
      progress: 15,
    };
  }

  async getJobStatus(externalJobId: string): Promise<ProviderJobStatusResult> {
    const [kind, rawId] = externalJobId.includes(':')
      ? (externalJobId.split(':', 2) as [string, string])
      : ['text', externalJobId];

    const routeMap: Record<string, string> = {
      text: `/openapi/v2/text-to-3d/${encodeURIComponent(rawId)}`,
      image: `/openapi/v1/image-to-3d/${encodeURIComponent(rawId)}`,
      multiview: `/openapi/v1/multi-image-to-3d/${encodeURIComponent(rawId)}`,
    };
    const apiPath = routeMap[kind] ?? routeMap.text;

    const res = await fetch(`${this.cfg.baseUrl}${apiPath}`, {
      method: 'GET',
      headers: this.authHeaders(),
    });

    const data = (await res.json().catch(() => ({}))) as {
      status?: string;
      progress?: number;
      model_urls?: { glb?: string };
      task_error?: { message?: string };
      message?: string;
    };

    if (!res.ok) {
      throw new AppError(
        502,
        'PROVIDER_POLL_FAILED',
        `Meshy status poll failed (${res.status}): ${sanitizePlainText(data.message || 'error', 200)}`
      );
    }

    const upstream = (data.status || 'PENDING').toUpperCase();
    const rawPct = typeof data.progress === 'number' ? Math.max(0, Math.min(100, data.progress)) : 0;

    if (upstream === 'SUCCEEDED') {
      if (!data.model_urls?.glb) {
        return {
          externalJobId,
          status: 'failed',
          progress: 100,
          stageLabel: 'Failed',
          errorMessage: 'Meshy reported SUCCEEDED without a downloadable GLB URL.',
        };
      }
      return {
        externalJobId,
        status: 'succeeded',
        progress: 100,
        stageLabel: 'Mesh generated',
        glbUrl: data.model_urls.glb,
      };
    }

    if (upstream === 'FAILED' || upstream === 'CANCELED' || upstream === 'EXPIRED') {
      return {
        externalJobId,
        status: 'failed',
        progress: rawPct,
        stageLabel: 'Provider failed',
        errorMessage: sanitizePlainText(
          data.task_error?.message || `Meshy job terminated with status ${upstream}.`,
          300
        ),
      };
    }

    return {
      externalJobId,
      status: upstream === 'PENDING' ? 'queued' : 'processing',
      progress: Math.round(20 + rawPct * 0.65),
      stageLabel:
        upstream === 'PENDING' ? 'Queued on Meshy cluster' : `Generating 3D geometry (${rawPct}%)`,
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
      id?: string;
      status?: string;
      progress?: number;
      model_urls?: { glb?: string };
      task_error?: { message?: string };
    };
    if (!obj.id || typeof obj.id !== 'string') {
      throw new AppError(400, 'INVALID_WEBHOOK_PAYLOAD', 'Missing task id in Meshy webhook payload.');
    }
    const st = (obj.status || '').toUpperCase();
    return {
      externalJobId: obj.id,
      status:
        st === 'SUCCEEDED'
          ? 'succeeded'
          : st === 'FAILED' || st === 'CANCELED' || st === 'EXPIRED'
          ? 'failed'
          : 'processing',
      progress: typeof obj.progress === 'number' ? obj.progress : undefined,
      glbUrl: obj.model_urls?.glb,
      errorMessage: obj.task_error?.message,
    };
  }
}
