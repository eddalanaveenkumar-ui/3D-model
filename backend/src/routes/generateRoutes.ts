import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { ImageViewAngle } from '@nv3d/shared';
import { getConfig } from '../config/env.js';
import { ensureStudioUser } from '../middleware/auth.js';
import { createGenerationRateLimiter } from '../middleware/rateLimit.js';
import { AppError } from '../services/authService.js';
import {
  getUserUploadedImage,
  validateAndStoreReferenceImage,
  type StoredImageWithBuffer,
} from '../services/imageUploadService.js';
import {
  getJobForUser,
  listJobsForUser,
  submitImageGenerationJob,
  submitTextGenerationJob,
} from '../services/jobManagerService.js';
import { GenerationSettingsSchema, parseSettingsInput } from './schemas.js';

const TextGenerateBodySchema = z.object({
  prompt: z.string().min(1, 'Prompt is required').max(2500),
  settings: GenerationSettingsSchema.optional(),
});

export function createGenerateRouter(): Router {
  const router = Router();
  const generationLimiter = createGenerationRateLimiter();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: getConfig().maxUploadBytes,
      files: 3,
      fields: 10,
    },
  });

  // POST /api/generate/text — Text-to-3D generation workflow
  router.post('/text', ensureStudioUser, generationLimiter, async (req, res, next) => {
    try {
      const body = TextGenerateBodySchema.parse(req.body);
      const settings = parseSettingsInput(body.settings);
      const job = await submitTextGenerationJob({
        userId: req.user!.id,
        prompt: body.prompt,
        settings,
      });
      res.status(202).json({ job });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/generate/image — Image-to-3D (single front, or multi-view front/side/back)
  router.post(
    '/image',
    ensureStudioUser,
    generationLimiter,
    upload.fields([
      { name: 'image', maxCount: 1 },
      { name: 'front', maxCount: 1 },
      { name: 'side', maxCount: 1 },
      { name: 'back', maxCount: 1 },
    ]),
    async (req, res, next) => {
      try {
        const filesMap = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
        const slots: Array<{ angle: ImageViewAngle; file: Express.Multer.File | undefined }> = [
          { angle: 'front', file: filesMap.front?.[0] ?? filesMap.image?.[0] },
          { angle: 'side', file: filesMap.side?.[0] },
          { angle: 'back', file: filesMap.back?.[0] },
        ];

        const presentSlots = slots.filter(
          (s): s is { angle: ImageViewAngle; file: Express.Multer.File } => Boolean(s.file)
        );

        if (presentSlots.length === 0) {
          throw new AppError(
            400,
            'MISSING_IMAGE',
            'Please upload a PNG, JPG, or WEBP reference image (field "front" or "image").'
          );
        }

        const storedImages: StoredImageWithBuffer[] = [];
        for (const slot of presentSlots) {
          const validated = await validateAndStoreReferenceImage({
            userId: req.user!.id,
            viewAngle: slot.angle,
            originalName: slot.file.originalname,
            declaredMimeType: slot.file.mimetype,
            buffer: slot.file.buffer,
          });
          storedImages.push(validated);
        }

        const settings = parseSettingsInput(req.body?.settings);
        const promptHint =
          typeof req.body?.prompt === 'string' && req.body.prompt.trim().length > 0
            ? req.body.prompt
            : null;

        const job = await submitImageGenerationJob({
          userId: req.user!.id,
          images: storedImages,
          prompt: promptHint,
          settings,
        });

        res.status(202).json({ job });
      } catch (err) {
        next(err);
      }
    }
  );

  // GET /api/generate — List current user's recent generation jobs
  router.get('/', ensureStudioUser, async (req, res, next) => {
    try {
      const jobs = await listJobsForUser(req.user!.id, 40);
      res.json({ jobs });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/generate/uploads/:imageId — User-isolated access to uploaded reference image
  router.get('/uploads/:imageId', ensureStudioUser, async (req, res, next) => {
    try {
      const imageId = String(req.params.imageId || '');
      if (!/^[0-9a-fA-F-]{36}$/.test(imageId)) {
        throw new AppError(400, 'INVALID_IMAGE_ID', 'Invalid image identifier.');
      }
      const img = await getUserUploadedImage(imageId, req.user!.id);
      res.setHeader('Content-Type', img.mimeType);
      res.setHeader('Content-Length', String(img.buffer.byteLength));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'");
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(img.buffer);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/generate/:jobId — Poll generation job status & progress
  router.get('/:jobId', ensureStudioUser, async (req, res, next) => {
    try {
      const job = await getJobForUser(String(req.params.jobId || ''), req.user!.id);
      res.json({ job });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
