import { Router } from 'express';
import multer from 'multer';
import type { AssetCategory, OutputFormat } from '@nv3d/shared';
import { getConfig } from '../config/env.js';
import { ensureStudioUser } from '../middleware/auth.js';
import { AppError } from '../services/authService.js';
import { createStoredReadStream } from '../services/glbStorageService.js';
import {
  deleteModelForUser,
  getModelForUser,
  importUserGlbModel,
  listModelsForUser,
  prepareModelDownload,
  revalidateModelForUser,
} from '../services/modelService.js';

const VALID_CATEGORIES = new Set<AssetCategory>([
  'human',
  'animal',
  'car',
  'building',
  'furniture',
  'prop',
  'tree',
  'environment',
]);

export function createModelRouter(): Router {
  const router = Router();

  const glbUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: getConfig().maxGlbImportBytes,
      files: 1,
    },
  });

  // GET /api/models — List user's generated/imported models + optional Demo Showcase assets
  router.get('/', ensureStudioUser, async (req, res, next) => {
    try {
      const includeDemo = req.query.includeDemo !== 'false';
      const rawCat = typeof req.query.category === 'string' ? req.query.category : undefined;
      const category =
        rawCat && VALID_CATEGORIES.has(rawCat as AssetCategory)
          ? (rawCat as AssetCategory)
          : undefined;
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;

      const models = await listModelsForUser({
        userId: req.user!.id,
        includeDemo,
        category,
        search,
      });

      res.json({ models });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/models/import — Upload, validate & optionally optimize a user-provided .glb file
  router.post(
    '/import',
    ensureStudioUser,
    glbUpload.single('file'),
    async (req, res, next) => {
      try {
        if (!req.file) {
          throw new AppError(400, 'MISSING_FILE', 'Upload a binary .glb file in field "file".');
        }
        const optimizeSize = req.body?.optimizeSize === 'true' || req.body?.optimizeSize === true;
        const model = await importUserGlbModel({
          userId: req.user!.id,
          originalName: req.file.originalname,
          buffer: req.file.buffer,
          optimizeSize,
        });
        res.status(201).json({ model });
      } catch (err) {
        next(err);
      }
    }
  );

  // GET /api/models/:id — Retrieve single model metadata, statistics & GLB validation report
  router.get('/:id', ensureStudioUser, async (req, res, next) => {
    try {
      const model = await getModelForUser(String(req.params.id || ''), req.user!.id);
      res.json({ model });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/models/:id/validate — Re-run full Khronos binary GLB 2.0 validation on disk
  router.post('/:id/validate', ensureStudioUser, async (req, res, next) => {
    try {
      const validationReport = await revalidateModelForUser(
        String(req.params.id || ''),
        req.user!.id
      );
      res.json({ validationReport });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/models/:id/download — Stream genuine validated GLB (or embedded GLTF) asset
  router.get('/:id/download', ensureStudioUser, async (req, res, next) => {
    try {
      const rawFmt = typeof req.query.format === 'string' ? req.query.format.toLowerCase() : 'glb';
      if (rawFmt !== 'glb' && rawFmt !== 'gltf') {
        throw new AppError(400, 'INVALID_EXPORT_FORMAT', 'Supported export formats are "glb" and "gltf".');
      }
      const format: OutputFormat = rawFmt;
      const prepared = await prepareModelDownload(
        String(req.params.id || ''),
        req.user!.id,
        format
      );

      res.setHeader('Content-Type', prepared.contentType);
      res.setHeader('Content-Length', String(prepared.byteLength));
      res.setHeader('Content-Disposition', `attachment; filename="${prepared.filename}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Content-SHA256', prepared.sha256);
      res.setHeader('X-GLB-Validated', String(prepared.validated));
      res.setHeader('X-NV3D-Demo-Asset', String(prepared.isDemo));
      res.setHeader('Cache-Control', 'private, no-cache');

      if (prepared.buffer) {
        res.send(prepared.buffer);
        return;
      }

      const stream = createStoredReadStream(prepared.storageKey!);
      stream.on('error', (err) => next(err));
      stream.pipe(res);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/models/:id — Delete user-owned model & binary storage
  router.delete('/:id', ensureStudioUser, async (req, res, next) => {
    try {
      await deleteModelForUser(String(req.params.id || ''), req.user!.id);
      res.json({ deleted: true, id: req.params.id });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
