import crypto from 'node:crypto';
import path from 'node:path';
import dotenv from 'dotenv';

// Load .env from repo root or backend cwd if present
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });

// Ephemeral per-process fallback secret for non-production environments only.
// Never hardcoded — generated from CSPRNG at startup if JWT_SECRET is omitted.
const ephemeralDevJwtSecret = crypto.randomBytes(48).toString('hex');

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const lower = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
  if (['0', 'false', 'no', 'off'].includes(lower)) return false;
  return fallback;
}

export interface AppConfig {
  nodeEnv: string;
  isProduction: boolean;
  isTest: boolean;
  port: number;
  host: string;
  corsOrigins: string[];
  jwtSecret: string;
  jwtExpiresInDays: number;
  initialUserCredits: number;
  databaseUrl: string;
  databaseSsl: boolean;
  pgliteDataDir: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  storageDir: string;
  maxUploadMb: number;
  maxUploadBytes: number;
  maxGlbImportMb: number;
  maxGlbImportBytes: number;
  generationRateLimitWindowMs: number;
  generationRateLimitMax: number;
  apiRateLimitWindowMs: number;
  apiRateLimitMax: number;
  nim: {
    endpoint: string;
    model: string;
    visionModel: string;
    apiKey: string;
    timeoutMs: number;
  };
  provider3d: string;
  jobPollIntervalMs: number;
  jobMaxPollAttempts: number;
  meshy: {
    apiKey: string;
    baseUrl: string;
    webhookSecret: string;
  };
  tripo: {
    apiKey: string;
    baseUrl: string;
    webhookSecret: string;
  };
  custom3d: {
    name: string;
    baseUrl: string;
    apiKey: string;
    webhookSecret: string;
    supportsMultiView: boolean;
    supportsRigging: boolean;
    supportsAnimation: boolean;
  };
}

export function getConfig(): AppConfig {
  const nodeEnv = (process.env.NODE_ENV || 'development').trim();
  const isProduction = nodeEnv === 'production';
  const isTest = nodeEnv === 'test';

  const configuredJwt = (process.env.JWT_SECRET || '').trim();
  if (isProduction && configuredJwt.length < 32) {
    throw new Error(
      'SECURITY ERROR: JWT_SECRET environment variable must be set to at least 32 characters in production.'
    );
  }

  const repoRoot = path.basename(process.cwd()) === 'backend'
    ? path.resolve(process.cwd(), '..')
    : process.cwd();

  const resolveDataPath = (raw: string | undefined, fallbackRel: string): string => {
    const val = (raw || '').trim();
    if (!val) return path.resolve(repoRoot, fallbackRel);
    if (val === 'memory://') return val;
    return path.isAbsolute(val) ? val : path.resolve(repoRoot, val);
  };

  const maxUploadMb = parsePositiveInt(process.env.MAX_UPLOAD_MB, 15);
  const maxGlbImportMb = parsePositiveInt(process.env.MAX_GLB_IMPORT_MB, 50);

  const corsOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    nodeEnv,
    isProduction,
    isTest,
    port: parsePositiveInt(process.env.PORT, 3001),
    host: (process.env.HOST || '0.0.0.0').trim(),
    corsOrigins,
    jwtSecret: configuredJwt || ephemeralDevJwtSecret,
    jwtExpiresInDays: parsePositiveInt(process.env.JWT_EXPIRES_IN_DAYS, 7),
    initialUserCredits: parsePositiveInt(process.env.INITIAL_USER_CREDITS, 250),
    databaseUrl: (process.env.DATABASE_URL || '').trim(),
    databaseSsl: parseBoolean(process.env.DATABASE_SSL, false),
    pgliteDataDir: resolveDataPath(process.env.PGLITE_DATA_DIR, '.data/pgdata'),
    supabaseUrl: (process.env.SUPABASE_URL || '').trim(),
    supabaseServiceRoleKey: (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
    storageDir: resolveDataPath(process.env.STORAGE_DIR, '.data/storage'),
    maxUploadMb,
    maxUploadBytes: maxUploadMb * 1024 * 1024,
    maxGlbImportMb,
    maxGlbImportBytes: maxGlbImportMb * 1024 * 1024,
    generationRateLimitWindowMs: parsePositiveInt(process.env.GENERATION_RATE_LIMIT_WINDOW_MS, 60_000),
    generationRateLimitMax: parsePositiveInt(process.env.GENERATION_RATE_LIMIT_MAX, 12),
    apiRateLimitWindowMs: parsePositiveInt(process.env.API_RATE_LIMIT_WINDOW_MS, 60_000),
    apiRateLimitMax: parsePositiveInt(process.env.API_RATE_LIMIT_MAX, 240),
    nim: {
      endpoint: (
        process.env.NVIDIA_NIM_ENDPOINT || 'https://integrate.api.nvidia.com/v1/chat/completions'
      ).trim(),
      model: (process.env.NVIDIA_NIM_MODEL || 'minimaxai/minimax-m3.1-flash').trim(),
      visionModel: (
        process.env.NVIDIA_NIM_VISION_MODEL ||
        process.env.NVIDIA_NIM_MODEL ||
        'minimaxai/minimax-m3.1-flash'
      ).trim(),
      apiKey: (process.env.NVIDIA_NIM_API_KEY || '').trim(),
      timeoutMs: parsePositiveInt(process.env.NVIDIA_NIM_TIMEOUT_MS, 30_000),
    },
    provider3d: (process.env.PROVIDER_3D || 'auto').trim().toLowerCase(),
    jobPollIntervalMs: parsePositiveInt(process.env.JOB_POLL_INTERVAL_MS, 4000),
    jobMaxPollAttempts: parsePositiveInt(process.env.JOB_MAX_POLL_ATTEMPTS, 150),
    meshy: {
      apiKey: (process.env.MESHY_API_KEY || '').trim(),
      baseUrl: (process.env.MESHY_API_BASE_URL || 'https://api.meshy.ai').trim().replace(/\/+$/, ''),
      webhookSecret: (process.env.MESHY_WEBHOOK_SECRET || '').trim(),
    },
    tripo: {
      apiKey: (process.env.TRIPO_API_KEY || '').trim(),
      baseUrl: (process.env.TRIPO_API_BASE_URL || 'https://api.tripo3d.ai/v2/openapi')
        .trim()
        .replace(/\/+$/, ''),
      webhookSecret: (process.env.TRIPO_WEBHOOK_SECRET || '').trim(),
    },
    custom3d: {
      name: (process.env.CUSTOM_3D_PROVIDER_NAME || 'Custom 3D Provider').trim(),
      baseUrl: (process.env.CUSTOM_3D_PROVIDER_URL || '').trim().replace(/\/+$/, ''),
      apiKey: (process.env.CUSTOM_3D_PROVIDER_API_KEY || '').trim(),
      webhookSecret: (process.env.CUSTOM_3D_WEBHOOK_SECRET || '').trim(),
      supportsMultiView: parseBoolean(process.env.CUSTOM_3D_SUPPORTS_MULTIVIEW, true),
      supportsRigging: parseBoolean(process.env.CUSTOM_3D_SUPPORTS_RIGGING, false),
      supportsAnimation: parseBoolean(process.env.CUSTOM_3D_SUPPORTS_ANIMATION, false),
    },
  };
}
