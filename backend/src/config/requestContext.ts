import { AsyncLocalStorage } from 'node:async_hooks';
import net from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import type { NimKeySource } from '@nv3d/shared';
import { getConfig } from './env.js';

export interface RequestNimCredentials {
  apiKey: string;
  model: string;
  nim3dEndpoint: string;
}

export interface EffectiveNimConfig {
  endpoint: string;
  model: string;
  visionModel: string;
  nim3dEndpoint: string;
  nim3dEnabled: boolean;
  apiKey: string;
  keySource: NimKeySource;
  isBrowserKey: boolean;
  timeoutMs: number;
}

const nimContextStorage = new AsyncLocalStorage<RequestNimCredentials>();

function sanitizeApiKeyHeader(raw: string | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  // Require printable non-whitespace ASCII, bounded length, never logged or stored
  if (trimmed.length < 8 || trimmed.length > 256) return '';
  if (!/^[\x21-\x7E]+$/.test(trimmed)) return '';
  return trimmed;
}

function sanitizeModelHeader(raw: string | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (trimmed.length < 3 || trimmed.length > 120) return '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(trimmed)) return '';
  return trimmed;
}

function isBlockedPrivateHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower === 'metadata.google.internal'
  ) {
    return true;
  }

  const ipVersion = net.isIP(lower);
  if (ipVersion === 4) {
    const [a, b] = lower.split('.').map((n) => Number.parseInt(n, 10));
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (ipVersion === 6) {
    if (
      lower === '::1' ||
      lower === '::' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe80') ||
      lower.startsWith('::ffff:127.') ||
      lower.startsWith('::ffff:10.') ||
      lower.startsWith('::ffff:192.168.') ||
      lower.startsWith('::ffff:169.254.')
    ) {
      return true;
    }
  }
  return false;
}

function sanitizeNim3dEndpointHeader(raw: string | undefined, isTest: boolean): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (trimmed.length > 300) return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return '';
  }
  if (parsed.username || parsed.password) return '';
  if (!isTest) {
    if (parsed.protocol !== 'https:') return '';
    if (isBlockedPrivateHostname(parsed.hostname)) return '';
  } else if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return '';
  }
  return parsed.toString().replace(/\/+$/, '');
}

/**
 * Per-request scoped BYOK credential middleware.
 * Accepts `X-Nvidia-Api-Key` (stored solely in the user's browser `localStorage`)
 * strictly inside `AsyncLocalStorage` memory for the current request — never persisted
 * to database, disk, logs, or responses, and strictly isolated across concurrent requests.
 */
export function attachClientNimCredentials(req: Request, _res: Response, next: NextFunction): void {
  const isTest = getConfig().isTest;
  const apiKey = sanitizeApiKeyHeader(req.header('x-nvidia-api-key') ?? undefined);
  const model = sanitizeModelHeader(req.header('x-nvidia-nim-model') ?? undefined);
  const nim3dEndpoint = sanitizeNim3dEndpointHeader(
    req.header('x-nvidia-3d-endpoint') ?? undefined,
    isTest
  );

  if (!apiKey && !model && !nim3dEndpoint) {
    next();
    return;
  }

  nimContextStorage.run({ apiKey, model, nim3dEndpoint }, () => {
    next();
  });
}

export function getEffectiveNimConfig(): EffectiveNimConfig {
  const base = getConfig().nim;
  const reqCreds = nimContextStorage.getStore();

  const browserKey = reqCreds?.apiKey || '';
  const apiKey = browserKey || base.apiKey;
  const keySource: NimKeySource = browserKey
    ? 'browser-storage'
    : base.apiKey
    ? 'server-env'
    : 'none';

  const model = reqCreds?.model || base.model;
  const visionModel = reqCreds?.model || base.visionModel;
  const nim3dEndpoint = reqCreds?.nim3dEndpoint || base.nim3dEndpoint;

  return {
    endpoint: base.endpoint,
    model,
    visionModel,
    nim3dEndpoint,
    nim3dEnabled: base.nim3dEnabled,
    apiKey,
    keySource,
    isBrowserKey: Boolean(browserKey),
    timeoutMs: base.timeoutMs,
  };
}
