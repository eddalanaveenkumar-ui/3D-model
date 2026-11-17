import crypto from 'node:crypto';
import type {
  ConnectivityCheckResult,
  GenerationSettings,
  ImageViewAngle,
  ProviderCapabilities,
  ProviderId,
  StructuredGenerationSpec,
} from '@nv3d/shared';
import { AppError } from '../services/authService.js';

export interface ProviderReferenceImage {
  viewAngle: ImageViewAngle;
  mimeType: string;
  originalName: string;
  buffer: Buffer;
  dataUrl: string;
}

export interface ProviderTextJobRequest {
  jobId: string;
  prompt: string;
  spec: StructuredGenerationSpec;
  settings: GenerationSettings;
}

export interface ProviderImageJobRequest {
  jobId: string;
  prompt: string | null;
  images: ProviderReferenceImage[];
  spec: StructuredGenerationSpec;
  settings: GenerationSettings;
}

export interface ProviderSubmissionResult {
  externalJobId: string;
  status: 'queued' | 'processing' | 'succeeded';
  progress: number;
  glbUrl?: string;
  glbBuffer?: Buffer;
  rawMeta?: Record<string, unknown>;
}

export interface ProviderJobStatusResult {
  externalJobId: string;
  status: 'queued' | 'processing' | 'succeeded' | 'failed';
  progress: number;
  stageLabel: string;
  glbUrl?: string;
  gltfUrl?: string;
  errorMessage?: string;
}

export interface ProviderWebhookEvent {
  externalJobId: string;
  status: 'processing' | 'succeeded' | 'failed';
  progress?: number;
  glbUrl?: string;
  errorMessage?: string;
}

export interface I3DGenerationProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly requiredEnvVars: string[];
  readonly capabilities: ProviderCapabilities;

  isConfigured(): boolean;
  hasWebhookSecret(): boolean;
  checkConnectivity(): Promise<ConnectivityCheckResult>;
  submitTextTo3D(req: ProviderTextJobRequest): Promise<ProviderSubmissionResult>;
  submitImageTo3D(req: ProviderImageJobRequest): Promise<ProviderSubmissionResult>;
  getJobStatus(externalJobId: string): Promise<ProviderJobStatusResult>;
  downloadGlb(glbUrl: string): Promise<Buffer>;
  verifyWebhookSignature(
    rawBody: Buffer,
    signatureHeader: string | undefined,
    timestampHeader?: string | undefined
  ): boolean;
  parseWebhookPayload(payload: unknown): ProviderWebhookEvent;
}

const MAX_WEBHOOK_SKEW_SECONDS = 300;
const MAX_GLB_DOWNLOAD_BYTES = 120 * 1024 * 1024; // 120 MB safety ceiling

/**
 * Constant-time HMAC-SHA256 signature verification with optional timestamp replay protection.
 * Supports headers in either plain hex or `sha256=<hex>` format.
 */
export function verifyHmacSha256Signature(params: {
  secret: string;
  rawBody: Buffer;
  signatureHeader: string | undefined;
  timestampHeader?: string | undefined;
}): boolean {
  const { secret, rawBody, signatureHeader, timestampHeader } = params;
  if (!secret || !signatureHeader) return false;

  const cleanedSig = signatureHeader.trim().replace(/^sha256=/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(cleanedSig)) return false;

  let signingPayload: Buffer = rawBody;
  if (timestampHeader) {
    const ts = Number.parseInt(timestampHeader.trim(), 10);
    if (!Number.isFinite(ts)) return false;
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - ts) > MAX_WEBHOOK_SKEW_SECONDS) {
      return false;
    }
    signingPayload = Buffer.concat([Buffer.from(`${ts}.`, 'utf8'), rawBody]);
  }

  const expected = crypto.createHmac('sha256', secret).update(signingPayload).digest();
  const provided = Buffer.from(cleanedSig, 'hex');
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

/**
 * Securely download a generated GLB binary from an upstream 3D provider URL
 * with timeout and maximum byte-size enforcement.
 */
export async function fetchProviderBinary(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 60_000
): Promise<Buffer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError(502, 'PROVIDER_INVALID_ASSET_URL', 'Provider returned an invalid GLB download URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AppError(502, 'PROVIDER_UNSAFE_PROTOCOL', 'Provider asset URL must use HTTP or HTTPS.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new AppError(
        502,
        'PROVIDER_DOWNLOAD_FAILED',
        `Failed to download GLB from 3D provider (HTTP ${res.status}).`
      );
    }

    const declaredLen = Number.parseInt(res.headers.get('content-length') || '0', 10);
    if (declaredLen > MAX_GLB_DOWNLOAD_BYTES) {
      throw new AppError(502, 'PROVIDER_ASSET_TOO_LARGE', 'Generated GLB exceeds safe download limit.');
    }

    const arrayBuf = await res.arrayBuffer();
    if (arrayBuf.byteLength === 0) {
      throw new AppError(502, 'PROVIDER_EMPTY_ASSET', 'Provider returned an empty GLB binary.');
    }
    if (arrayBuf.byteLength > MAX_GLB_DOWNLOAD_BYTES) {
      throw new AppError(502, 'PROVIDER_ASSET_TOO_LARGE', 'Generated GLB exceeds safe download limit.');
    }
    return Buffer.from(arrayBuf);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(
      502,
      'PROVIDER_DOWNLOAD_ERROR',
      `GLB download error: ${err instanceof Error ? err.message : 'network error'}`
    );
  } finally {
    clearTimeout(timeout);
  }
}
