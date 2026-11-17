import crypto from 'node:crypto';
import type {
  ArtStyle,
  AssetCategory,
  GeneratedModelRecord,
  GenerationSettings,
  GlbValidationReport,
  ModelSourceType,
  ModelStatistics,
  OutputFormat,
  StructuredGenerationSpec,
} from '@nv3d/shared';
import { getConfig } from '../config/env.js';
import { getDb } from '../db/client.js';
import { AppError } from './authService.js';
import { convertGlbToEmbeddedGltf, optimizeGlbBuffer } from './glbOptimizationService.js';
import {
  deleteStoredFile,
  readStoredFile,
  saveGlbFile,
  sha256Hex,
  statStoredFile,
} from './glbStorageService.js';
import { validateGlbBuffer } from './glbValidationService.js';
import { recordHistory } from './historyService.js';
import { inferCategoryFromPrompt } from './nvidiaNimService.js';
import { sanitizePlainText, toSafeDownloadFilename } from './safetyService.js';

interface DbModelRow {
  id: string;
  user_id: string | null;
  job_id: string | null;
  name: string;
  description: string;
  category: AssetCategory;
  style: ArtStyle;
  source_type: ModelSourceType;
  is_demo: boolean;
  provider_id: string;
  prompt: string | null;
  structured_spec: StructuredGenerationSpec | string | null;
  settings: GenerationSettings | string | null;
  storage_key: string;
  file_size_bytes: string | number;
  sha256: string;
  gltf_export_supported: boolean;
  validated: boolean;
  validation_report: GlbValidationReport | string;
  statistics: ModelStatistics | string;
  created_at: string | Date;
}

function parseJsonCol<T>(val: T | string | null): T | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return JSON.parse(val) as T;
  return val;
}

function rowToModelRecord(row: DbModelRow): GeneratedModelRecord {
  const validationReport = parseJsonCol<GlbValidationReport>(row.validation_report)!;
  const statistics = parseJsonCol<ModelStatistics>(row.statistics)!;
  return {
    id: row.id,
    userId: row.user_id,
    jobId: row.job_id,
    name: row.name,
    description: row.description,
    category: row.category,
    style: row.style,
    sourceType: row.source_type,
    isDemo: Boolean(row.is_demo),
    providerId: row.provider_id,
    prompt: row.prompt,
    structuredSpec: parseJsonCol<StructuredGenerationSpec>(row.structured_spec),
    settings: parseJsonCol<GenerationSettings>(row.settings),
    fileSizeBytes: Number(row.file_size_bytes),
    sha256: row.sha256,
    gltfExportSupported: Boolean(row.gltf_export_supported),
    validated: Boolean(row.validated),
    validationReport,
    statistics,
    downloadUrl: `/api/models/${row.id}/download?format=glb`,
    gltfDownloadUrl: `/api/models/${row.id}/download?format=gltf`,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function listModelsForUser(params: {
  userId: string;
  includeDemo?: boolean;
  category?: AssetCategory;
  search?: string;
}): Promise<GeneratedModelRecord[]> {
  const db = getDb();
  const includeDemo = params.includeDemo !== false;

  const conditions: string[] = [
    includeDemo ? '(user_id = $1 OR is_demo = TRUE)' : '(user_id = $1 AND is_demo = FALSE)',
  ];
  const values: unknown[] = [params.userId];

  if (params.category) {
    values.push(params.category);
    conditions.push(`category = $${values.length}`);
  }

  if (params.search && params.search.trim()) {
    values.push(`%${sanitizePlainText(params.search, 120).toLowerCase()}%`);
    const idx = values.length;
    conditions.push(`(LOWER(name) LIKE $${idx} OR LOWER(COALESCE(prompt, description)) LIKE $${idx})`);
  }

  const sql = `
    SELECT *
    FROM generated_models
    WHERE ${conditions.join(' AND ')}
    ORDER BY is_demo ASC, created_at DESC
    LIMIT 100
  `;
  const res = await db.query<DbModelRow>(sql, values);
  return res.rows.map(rowToModelRecord);
}

async function getRawModelAuthorized(modelId: string, userId: string): Promise<DbModelRow> {
  if (!/^[0-9a-fA-F-]{36}$/.test(modelId)) {
    throw new AppError(400, 'INVALID_MODEL_ID', 'Invalid model identifier format.');
  }
  const db = getDb();
  const res = await db.query<DbModelRow>('SELECT * FROM generated_models WHERE id = $1', [modelId]);
  if (res.rows.length === 0) {
    throw new AppError(404, 'MODEL_NOT_FOUND', '3D model not found.');
  }
  const row = res.rows[0];
  if (!row.is_demo && row.user_id !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to access this 3D model.');
  }
  return row;
}

export async function getModelForUser(modelId: string, userId: string): Promise<GeneratedModelRecord> {
  const row = await getRawModelAuthorized(modelId, userId);
  return rowToModelRecord(row);
}

export interface PreparedModelDownload {
  filename: string;
  contentType: string;
  byteLength: number;
  sha256: string;
  storageKey?: string;
  buffer?: Buffer;
  isDemo: boolean;
  validated: boolean;
}

/**
 * Prepare a genuine validated GLB or embedded GLTF download.
 * Never returns fake or broken payloads; verifies on-disk integrity first.
 */
export async function prepareModelDownload(
  modelId: string,
  userId: string,
  format: OutputFormat = 'glb'
): Promise<PreparedModelDownload> {
  const row = await getRawModelAuthorized(modelId, userId);

  if (!row.validated) {
    throw new AppError(422, 'MODEL_NOT_VALIDATED', 'Model failed GLB validation and cannot be exported.');
  }

  if (format === 'gltf') {
    if (!row.gltf_export_supported) {
      throw new AppError(400, 'GLTF_EXPORT_UNSUPPORTED', 'Separate GLTF export is not supported for this model.');
    }
    const rawGlb = await readStoredFile(row.storage_key);
    const gltfBuf = await convertGlbToEmbeddedGltf(rawGlb);
    return {
      filename: toSafeDownloadFilename(row.name, 'gltf'),
      contentType: 'model/gltf+json; charset=utf-8',
      byteLength: gltfBuf.byteLength,
      sha256: sha256Hex(gltfBuf),
      buffer: gltfBuf,
      isDemo: Boolean(row.is_demo),
      validated: true,
    };
  }

  // Verify the real GLB file exists on disk and has positive length
  const stat = await statStoredFile(row.storage_key);
  return {
    filename: toSafeDownloadFilename(row.name, 'glb'),
    contentType: 'model/gltf-binary',
    byteLength: stat.size,
    sha256: row.sha256,
    storageKey: row.storage_key,
    isDemo: Boolean(row.is_demo),
    validated: true,
  };
}

export async function revalidateModelForUser(
  modelId: string,
  userId: string
): Promise<GlbValidationReport> {
  const row = await getRawModelAuthorized(modelId, userId);
  const buffer = await readStoredFile(row.storage_key);
  const report = validateGlbBuffer(buffer);

  const db = getDb();
  await db.query(
    `UPDATE generated_models
     SET validated = $1,
         validation_report = $2::jsonb,
         statistics = $3::jsonb,
         file_size_bytes = $4,
         sha256 = $5
     WHERE id = $6`,
    [
      report.valid,
      JSON.stringify(report),
      JSON.stringify(report.statistics),
      buffer.byteLength,
      report.sha256,
      row.id,
    ]
  );

  return report;
}

export async function createValidatedGeneratedModel(params: {
  userId: string;
  jobId: string | null;
  name: string;
  description: string;
  category: AssetCategory;
  style: ArtStyle;
  sourceType: 'generated' | 'user_import';
  providerId: string;
  prompt: string | null;
  structuredSpec: StructuredGenerationSpec | null;
  settings: GenerationSettings | null;
  glbBuffer: Buffer;
}): Promise<GeneratedModelRecord> {
  const report = validateGlbBuffer(params.glbBuffer);
  if (!report.valid) {
    const firstErr = report.issues.find((i) => i.severity === 'error');
    throw new AppError(
      422,
      'GLB_VALIDATION_FAILED',
      `GLB validation failed (${firstErr?.code || 'INVALID_GLB'}): ${firstErr?.message || 'Corrupted GLB binary.'}`,
      { validationReport: report }
    );
  }

  const modelId = crypto.randomUUID();
  const saved = await saveGlbFile({
    ownerScope: params.userId,
    modelId,
    buffer: params.glbBuffer,
  });

  const db = getDb();
  try {
    const res = await db.query<DbModelRow>(
      `INSERT INTO generated_models (
         id, user_id, job_id, name, description, category, style,
         source_type, is_demo, provider_id, prompt, structured_spec, settings,
         storage_key, file_size_bytes, sha256, gltf_export_supported,
         validated, validation_report, statistics
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, FALSE, $9, $10, $11::jsonb, $12::jsonb,
         $13, $14, $15, TRUE,
         TRUE, $16::jsonb, $17::jsonb
       ) RETURNING *`,
      [
        modelId,
        params.userId,
        params.jobId,
        sanitizePlainText(params.name, 120) || 'Untitled 3D Model',
        sanitizePlainText(params.description, 500),
        params.category,
        params.style,
        params.sourceType,
        params.providerId,
        params.prompt ? sanitizePlainText(params.prompt, 2000) : null,
        params.structuredSpec ? JSON.stringify(params.structuredSpec) : null,
        params.settings ? JSON.stringify(params.settings) : null,
        saved.storageKey,
        saved.fileSizeBytes,
        saved.sha256,
        JSON.stringify(report),
        JSON.stringify(report.statistics),
      ]
    );
    return rowToModelRecord(res.rows[0]);
  } catch (err) {
    await deleteStoredFile(saved.storageKey);
    throw err;
  }
}

export async function importUserGlbModel(params: {
  userId: string;
  originalName: string;
  buffer: Buffer;
  optimizeSize?: boolean;
}): Promise<GeneratedModelRecord> {
  const config = getConfig();
  if (!params.buffer || params.buffer.byteLength === 0) {
    throw new AppError(400, 'EMPTY_GLB', 'Uploaded GLB file is empty.');
  }
  if (params.buffer.byteLength > config.maxGlbImportBytes) {
    throw new AppError(
      413,
      'GLB_TOO_LARGE',
      `GLB file exceeds maximum import limit of ${config.maxGlbImportMb} MB.`
    );
  }

  // Validate before running any optimizer
  const initialReport = validateGlbBuffer(params.buffer);
  if (!initialReport.valid) {
    const firstErr = initialReport.issues.find((i) => i.severity === 'error');
    throw new AppError(
      400,
      'GLB_VALIDATION_FAILED',
      `Uploaded file is not a valid GLB 2.0 model: ${firstErr?.message || 'invalid binary container'}`
    );
  }

  let finalBuffer = params.buffer;
  if (params.optimizeSize) {
    try {
      const optimized = await optimizeGlbBuffer(params.buffer, {
        optimizeSize: true,
        textureResolution: '4k',
      });
      if (validateGlbBuffer(optimized).valid) {
        finalBuffer = optimized;
      }
    } catch {
      // Preserve verified original buffer if transform rejects custom extension
    }
  }

  const baseName = sanitizePlainText(params.originalName.replace(/\.glb$/i, ''), 90) || 'Imported GLB Asset';
  const model = await createValidatedGeneratedModel({
    userId: params.userId,
    jobId: null,
    name: baseName,
    description: `User-imported GLB 2.0 asset (${baseName}), binary-validated for viewport inspection and export.`,
    category: inferCategoryFromPrompt(baseName, 'prop'),
    style: 'realistic-pbr',
    sourceType: 'user_import',
    providerId: 'local-import',
    prompt: null,
    structuredSpec: null,
    settings: null,
    glbBuffer: finalBuffer,
  });

  await recordHistory({
    userId: params.userId,
    modelId: model.id,
    action: 'model.imported',
    mode: 'import',
    status: 'succeeded',
    summary: `Imported and validated "${model.name}" (${model.statistics.triangles.toLocaleString()} triangles).`,
    providerId: 'local-import',
    creditsDelta: 0,
    metadata: { fileSizeBytes: model.fileSizeBytes, sha256: model.sha256 },
  });

  return model;
}

export async function deleteModelForUser(modelId: string, userId: string): Promise<void> {
  if (!/^[0-9a-fA-F-]{36}$/.test(modelId)) {
    throw new AppError(400, 'INVALID_MODEL_ID', 'Invalid model identifier format.');
  }
  const db = getDb();
  const res = await db.query<DbModelRow>('SELECT * FROM generated_models WHERE id = $1', [modelId]);
  if (res.rows.length === 0) {
    throw new AppError(404, 'MODEL_NOT_FOUND', '3D model not found.');
  }
  const row = res.rows[0];
  if (row.is_demo) {
    throw new AppError(403, 'DEMO_MODEL_PROTECTED', 'Built-in Demo Sample assets are read-only and cannot be deleted.');
  }
  if (row.user_id !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to delete this 3D model.');
  }

  await db.query('DELETE FROM generated_models WHERE id = $1 AND user_id = $2', [row.id, userId]);
  await deleteStoredFile(row.storage_key);

  await recordHistory({
    userId,
    modelId: null,
    action: 'model.deleted',
    mode: 'system',
    status: 'succeeded',
    summary: `Deleted model "${row.name}".`,
    providerId: row.provider_id,
    creditsDelta: 0,
  });
}
