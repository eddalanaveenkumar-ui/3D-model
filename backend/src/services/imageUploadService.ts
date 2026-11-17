import crypto from 'node:crypto';
import sharp from 'sharp';
import type { ImageViewAngle, UploadedImageRecord } from '@nv3d/shared';
import { getConfig } from '../config/env.js';
import { getDb } from '../db/client.js';
import { AppError } from './authService.js';
import { deleteStoredFile, readStoredFile, saveImageFile } from './glbStorageService.js';
import { sanitizePlainText } from './safetyService.js';

type SupportedImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

const MAX_IMAGE_DIMENSION = 8192;
const MIN_IMAGE_DIMENSION = 32;

/**
 * Inspect magic bytes directly so renamed HTML, SVG, EXE, or text files
 * can never bypass MIME checks.
 */
export function detectImageMimeFromMagicBytes(buffer: Buffer): SupportedImageMime | null {
  if (buffer.byteLength < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // WEBP: "RIFF" .... "WEBP"
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}

function mimeToExt(mime: SupportedImageMime): 'png' | 'jpg' | 'webp' {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpg';
  return 'webp';
}

export interface StoredImageWithBuffer extends UploadedImageRecord {
  storageKey: string;
  buffer: Buffer;
  dataUrl: string;
}

/**
 * Validate, decode, strip EXIF/metadata, re-encode cleanly, store privately
 * scoped to the user, and persist metadata in `uploaded_images`.
 */
export async function validateAndStoreReferenceImage(params: {
  userId: string;
  jobId?: string | null;
  viewAngle: ImageViewAngle;
  originalName: string;
  declaredMimeType: string;
  buffer: Buffer;
}): Promise<StoredImageWithBuffer> {
  const config = getConfig();

  if (!params.buffer || params.buffer.byteLength === 0) {
    throw new AppError(400, 'EMPTY_IMAGE', `Uploaded ${params.viewAngle} reference image is empty.`);
  }

  if (params.buffer.byteLength > config.maxUploadBytes) {
    throw new AppError(
      413,
      'IMAGE_TOO_LARGE',
      `Reference image exceeds maximum upload size of ${config.maxUploadMb} MB.`
    );
  }

  const detectedMime = detectImageMimeFromMagicBytes(params.buffer);
  if (!detectedMime) {
    throw new AppError(
      400,
      'INVALID_IMAGE_TYPE',
      'Unsupported or invalid image file. Only genuine PNG, JPG, and WEBP images are accepted.'
    );
  }

  // Decode pixel buffer via sharp to verify image integrity & prevent polyglot payloads
  let sanitizedBuffer: Buffer;
  let width: number;
  let height: number;

  try {
    const image = sharp(params.buffer, { limitInputPixels: MAX_IMAGE_DIMENSION * MAX_IMAGE_DIMENSION });
    const meta = await image.metadata();
    if (!meta.width || !meta.height) {
      throw new AppError(400, 'CORRUPT_IMAGE', 'Unable to read image dimensions.');
    }
    if (meta.width < MIN_IMAGE_DIMENSION || meta.height < MIN_IMAGE_DIMENSION) {
      throw new AppError(
        400,
        'IMAGE_TOO_SMALL',
        `Reference image must be at least ${MIN_IMAGE_DIMENSION}x${MIN_IMAGE_DIMENSION} pixels.`
      );
    }
    if (meta.width > MAX_IMAGE_DIMENSION || meta.height > MAX_IMAGE_DIMENSION) {
      throw new AppError(
        400,
        'IMAGE_DIMENSIONS_EXCEEDED',
        `Reference image exceeds ${MAX_IMAGE_DIMENSION}x${MAX_IMAGE_DIMENSION} pixel limit.`
      );
    }

    // Re-encode and rotate per EXIF, stripping private metadata & capping at 2048px for provider submission
    const normalized = image.rotate().resize(2048, 2048, {
      fit: 'inside',
      withoutEnlargement: true,
    });

    if (detectedMime === 'image/png') {
      sanitizedBuffer = await normalized.png({ compressionLevel: 8 }).toBuffer();
    } else if (detectedMime === 'image/jpeg') {
      sanitizedBuffer = await normalized.jpeg({ quality: 92, mozjpeg: true }).toBuffer();
    } else {
      sanitizedBuffer = await normalized.webp({ quality: 92 }).toBuffer();
    }

    const finalMeta = await sharp(sanitizedBuffer).metadata();
    width = finalMeta.width ?? meta.width;
    height = finalMeta.height ?? meta.height;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(
      400,
      'CORRUPT_IMAGE',
      'Uploaded file could not be decoded as a valid PNG, JPG, or WEBP image.'
    );
  }

  const imageId = crypto.randomUUID();
  const safeOriginalName = sanitizePlainText(params.originalName || `${params.viewAngle}.png`, 160);
  const saved = await saveImageFile({
    userId: params.userId,
    imageId,
    ext: mimeToExt(detectedMime),
    buffer: sanitizedBuffer,
  });

  const db = getDb();
  try {
    const res = await db.query<{ created_at: string | Date }>(
      `INSERT INTO uploaded_images (
         id, user_id, job_id, view_angle, original_name, mime_type,
         storage_key, file_size_bytes, width, height, sha256
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING created_at`,
      [
        imageId,
        params.userId,
        params.jobId ?? null,
        params.viewAngle,
        safeOriginalName,
        detectedMime,
        saved.storageKey,
        saved.fileSizeBytes,
        width,
        height,
        saved.sha256,
      ]
    );

    const createdAt = new Date(res.rows[0].created_at).toISOString();
    return {
      id: imageId,
      viewAngle: params.viewAngle,
      originalName: safeOriginalName,
      mimeType: detectedMime,
      fileSizeBytes: saved.fileSizeBytes,
      width,
      height,
      previewUrl: `/api/generate/uploads/${imageId}`,
      createdAt,
      storageKey: saved.storageKey,
      buffer: sanitizedBuffer,
      dataUrl: `data:${detectedMime};base64,${sanitizedBuffer.toString('base64')}`,
    };
  } catch (err) {
    await deleteStoredFile(saved.storageKey);
    throw err;
  }
}

export async function attachImagesToJob(imageIds: string[], userId: string, jobId: string): Promise<void> {
  if (imageIds.length === 0) return;
  const db = getDb();
  for (const id of imageIds) {
    await db.query(
      `UPDATE uploaded_images SET job_id = $1 WHERE id = $2 AND user_id = $3`,
      [jobId, id, userId]
    );
  }
}

export async function getUserUploadedImage(
  imageId: string,
  userId: string
): Promise<{ mimeType: string; buffer: Buffer; originalName: string }> {
  const db = getDb();
  const res = await db.query<{
    user_id: string;
    mime_type: string;
    storage_key: string;
    original_name: string;
  }>(
    `SELECT user_id, mime_type, storage_key, original_name
     FROM uploaded_images
     WHERE id = $1`,
    [imageId]
  );

  if (res.rows.length === 0) {
    throw new AppError(404, 'IMAGE_NOT_FOUND', 'Uploaded image not found.');
  }
  const row = res.rows[0];
  if (row.user_id !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to access this uploaded image.');
  }
  const buffer = await readStoredFile(row.storage_key);
  return {
    mimeType: row.mime_type,
    buffer,
    originalName: row.original_name,
  };
}
