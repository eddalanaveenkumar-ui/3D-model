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

  await fsp.mkdir(path.dirname(fullPath), { recursive: true });
  const tmpPath = `${fullPath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fsp.writeFile(tmpPath, params.buffer, { mode: 0o600 });
  await fsp.rename(tmpPath, fullPath);

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

  await fsp.mkdir(path.dirname(fullPath), { recursive: true });
  const tmpPath = `${fullPath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fsp.writeFile(tmpPath, params.buffer, { mode: 0o600 });
  await fsp.rename(tmpPath, fullPath);

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
    throw new AppError(404, 'ASSET_FILE_MISSING', 'Stored asset file does not exist on disk.');
  }
}

export async function statStoredFile(storageKey: string): Promise<{ fullPath: string; size: number }> {
  const fullPath = resolveStoragePath(storageKey);
  try {
    const stat = await fsp.stat(fullPath);
    if (!stat.isFile() || stat.size <= 0) {
      throw new AppError(404, 'ASSET_FILE_MISSING', 'Stored asset file is unavailable.');
    }
    return { fullPath, size: stat.size };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(404, 'ASSET_FILE_MISSING', 'Stored asset file does not exist on disk.');
  }
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
}
