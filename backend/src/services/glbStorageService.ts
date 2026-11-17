import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from '../config/env.js';
import { AppError } from './authService.js';

function getStorageRoot(): string {
  const root = path.resolve(getConfig().storageDir);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

interface SupabaseStorageConfig {
  baseUrl: string;
  serviceRoleKey: string;
  bucket: string;
}

let ensuredBucketName: string | null = null;

function getSupabaseStorageConfig(): SupabaseStorageConfig | null {
  const config = getConfig();
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey || !config.supabaseStorageBucket) {
    return null;
  }
  return {
    baseUrl: config.supabaseUrl.replace(/\/+$/, ''),
    serviceRoleKey: config.supabaseServiceRoleKey,
    bucket: config.supabaseStorageBucket,
  };
}

function encodeStorageObjectPath(storageKey: string): string {
  return storageKey
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

async function ensureSupabaseBucket(sb: SupabaseStorageConfig): Promise<void> {
  if (ensuredBucketName === sb.bucket) return;
  const res = await fetch(`${sb.baseUrl}/storage/v1/bucket`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sb.serviceRoleKey}`,
      apikey: sb.serviceRoleKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: sb.bucket,
      name: sb.bucket,
      public: false,
    }),
  });
  // 200 created, 409 already exists
  if (res.ok || res.status === 409) {
    ensuredBucketName = sb.bucket;
    return;
  }
  const text = await res.text().catch(() => '');
  if (text.toLowerCase().includes('already exists') || text.toLowerCase().includes('duplicate')) {
    ensuredBucketName = sb.bucket;
    return;
  }
  throw new AppError(
    502,
    'OBJECT_STORAGE_ERROR',
    `Failed to initialize Supabase Storage bucket "${sb.bucket}" (HTTP ${res.status}).`
  );
}

async function uploadToSupabaseStorage(
  storageKey: string,
  buffer: Buffer,
  contentType: string
): Promise<void> {
  const sb = getSupabaseStorageConfig();
  if (!sb) return;
  await ensureSupabaseBucket(sb);
  const objectPath = encodeStorageObjectPath(storageKey);
  const res = await fetch(`${sb.baseUrl}/storage/v1/object/${encodeURIComponent(sb.bucket)}/${objectPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sb.serviceRoleKey}`,
      apikey: sb.serviceRoleKey,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    body: new Uint8Array(buffer),
  });
  if (!res.ok) {
    throw new AppError(
      502,
      'OBJECT_STORAGE_UPLOAD_FAILED',
      `Failed to persist asset in Supabase Storage (HTTP ${res.status}).`
    );
  }
}

async function hydrateFromSupabaseStorage(storageKey: string, fullPath: string): Promise<Buffer | null> {
  const sb = getSupabaseStorageConfig();
  if (!sb) return null;
  const objectPath = encodeStorageObjectPath(storageKey);
  const res = await fetch(`${sb.baseUrl}/storage/v1/object/${encodeURIComponent(sb.bucket)}/${objectPath}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${sb.serviceRoleKey}`,
      apikey: sb.serviceRoleKey,
    },
  });
  if (!res.ok) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) return null;
  await writeBufferAtomically(fullPath, buffer);
  return buffer;
}

async function deleteFromSupabaseStorage(storageKey: string): Promise<void> {
  const sb = getSupabaseStorageConfig();
  if (!sb) return;
  try {
    const objectPath = encodeStorageObjectPath(storageKey);
    await fetch(`${sb.baseUrl}/storage/v1/object/${encodeURIComponent(sb.bucket)}/${objectPath}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${sb.serviceRoleKey}`,
        apikey: sb.serviceRoleKey,
      },
    });
  } catch {
    // Ignore cleanup network errors
  }
}

async function writeBufferAtomically(fullPath: string, buffer: Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(fullPath), { recursive: true });
  const tmpPath = `${fullPath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fsp.writeFile(tmpPath, buffer, { mode: 0o600 });
  await fsp.rename(tmpPath, fullPath);
}

/**
 * Resolve a relative storage key safely inside the private storage root.
 * Blocks any path traversal, null bytes, or absolute path escape attempts.
 */
export function resolveStoragePath(storageKey: string): string {
  if (!storageKey || storageKey.includes('\0') || path.isAbsolute(storageKey)) {
    throw new AppError(400, 'INVALID_STORAGE_KEY', 'Invalid asset storage path.');
  }
  if (!/^[a-zA-Z0-9/_\-.]+$/.test(storageKey)) {
    throw new AppError(400, 'INVALID_STORAGE_KEY', 'Storage path contains disallowed characters.');
  }
  const root = getStorageRoot();
  const resolved = path.resolve(root, storageKey);
  if (!resolved.startsWith(root + path.sep)) {
    throw new AppError(403, 'PATH_TRAVERSAL_BLOCKED', 'Access outside storage root is forbidden.');
  }
  return resolved;
}

export function sha256Hex(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export async function saveGlbFile(params: {
  ownerScope: string;
  modelId: string;
  buffer: Buffer;
}): Promise<{ storageKey: string; fileSizeBytes: number; sha256: string }> {
  const safeScope = params.ownerScope.replace(/[^a-zA-Z0-9_-]/g, '');
  const safeId = params.modelId.replace(/[^a-zA-Z0-9_-]/g, '');
  const storageKey = `models/${safeScope}/${safeId}.glb`;
  const fullPath = resolveStoragePath(storageKey);

  await writeBufferAtomically(fullPath, params.buffer);
  await uploadToSupabaseStorage(storageKey, params.buffer, 'model/gltf-binary');

  const stat = await fsp.stat(fullPath);
  return {
    storageKey,
    fileSizeBytes: stat.size,
    sha256: sha256Hex(params.buffer),
  };
}

export async function saveImageFile(params: {
  userId: string;
  imageId: string;
  ext: 'png' | 'jpg' | 'webp';
  buffer: Buffer;
}): Promise<{ storageKey: string; fileSizeBytes: number; sha256: string }> {
  const safeUser = params.userId.replace(/[^a-zA-Z0-9_-]/g, '');
  const safeId = params.imageId.replace(/[^a-zA-Z0-9_-]/g, '');
  const storageKey = `images/${safeUser}/${safeId}.${params.ext}`;
  const fullPath = resolveStoragePath(storageKey);
  const contentType =
    params.ext === 'png' ? 'image/png' : params.ext === 'webp' ? 'image/webp' : 'image/jpeg';

  await writeBufferAtomically(fullPath, params.buffer);
  await uploadToSupabaseStorage(storageKey, params.buffer, contentType);

  const stat = await fsp.stat(fullPath);
  return {
    storageKey,
    fileSizeBytes: stat.size,
    sha256: sha256Hex(params.buffer),
  };
}

export async function readStoredFile(storageKey: string): Promise<Buffer> {
  const fullPath = resolveStoragePath(storageKey);
  try {
    return await fsp.readFile(fullPath);
  } catch {
    const hydrated = await hydrateFromSupabaseStorage(storageKey, fullPath);
    if (hydrated) return hydrated;
    throw new AppError(404, 'ASSET_FILE_MISSING', 'Stored asset file does not exist on disk.');
  }
}

export async function statStoredFile(storageKey: string): Promise<{ fullPath: string; size: number }> {
  const fullPath = resolveStoragePath(storageKey);
  try {
    const stat = await fsp.stat(fullPath);
    if (stat.isFile() && stat.size > 0) {
      return { fullPath, size: stat.size };
    }
  } catch {
    // Try hydrating from object storage on serverless cold starts
  }

  const hydrated = await hydrateFromSupabaseStorage(storageKey, fullPath);
  if (hydrated) {
    return { fullPath, size: hydrated.length };
  }
  throw new AppError(404, 'ASSET_FILE_MISSING', 'Stored asset file does not exist on disk.');
}

export function createStoredReadStream(storageKey: string): fs.ReadStream {
  const fullPath = resolveStoragePath(storageKey);
  return fs.createReadStream(fullPath);
}

export async function deleteStoredFile(storageKey: string): Promise<void> {
  try {
    const fullPath = resolveStoragePath(storageKey);
    await fsp.unlink(fullPath);
  } catch {
    // Ignore already-deleted file
  }
  await deleteFromSupabaseStorage(storageKey);
}
