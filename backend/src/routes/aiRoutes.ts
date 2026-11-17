import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { ImageViewAngle } from '@nv3d/shared';
import { getConfig } from '../config/env.js';
import { ensureStudioUser } from '../middleware/auth.js';
import { createGenerationRateLimiter } from '../middleware/rateLimit.js';
import { AppError } from '../services/authService.js';
import {
  validateAndStoreReferenceImage,
  type StoredImageWithBuffer,
} from '../services/imageUploadService.js';
import {
  analyzeReferenceImages,
  explainGenerationError,
  runAiAssistantChat,
  structureTextPrompt,
} from '../services/nvidiaNimService.js';
import { GenerationSettingsSchema, parseSettingsInput } from './schemas.js';

const EnhanceSchema = z.object({
  prompt: z.string().min(1).max(2500),
  settings: GenerationSettingsSchema.optional(),
});

const AssistSchema = z.object({
  message: z.string().min(1).max(2000),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(2000),
      })
    )
    .max(12)
    .optional(),
  context: z
    .object({
      currentPrompt: z.string().max(2000).optional(),
      mode: z.string().max(40).optional(),
      activeModelName: z.string().max(160).optional(),
      lastError: z.string().max(600).optional(),
      settings: GenerationSettingsSchema.partial().optional(),
    })
    .optional(),
});

const ExplainErrorSchema = z.object({
  errorCode: z.string().min(1).max(80),
  errorMessage: z.string().min(1).max(1000),
  providerId: z.string().max(60).nullable().optional(),
});

export function createAiRouter(): Router {
  const router = Router();
  const limiter = createGenerationRateLimiter();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: getConfig().maxUploadBytes,
      files: 3,
    },
  });

  // POST /api/ai/enhance — MiniMax M3.1 Flash structured JSON prompt enhancement
  router.post('/enhance', ensureStudioUser, limiter, async (req, res, next) => {
    try {
      const body = EnhanceSchema.parse(req.body);
      const settings = parseSettingsInput(body.settings);
      // Require live NVIDIA NIM when user explicitly invokes MiniMax enhancement
      const spec = await structureTextPrompt(body.prompt, settings, { requireLiveNim: true });
      res.json({ spec });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/ai/analyze-image — Multimodal reference image analysis via NVIDIA NIM
  router.post(
    '/analyze-image',
    ensureStudioUser,
    limiter,
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
        const present = slots.filter(
          (s): s is { angle: ImageViewAngle; file: Express.Multer.File } => Boolean(s.file)
        );
        if (present.length === 0) {
          throw new AppError(400, 'MISSING_IMAGE', 'Upload at least one reference image to analyze.');
        }

        const stored: StoredImageWithBuffer[] = [];
        for (const slot of present) {
          stored.push(
            await validateAndStoreReferenceImage({
              userId: req.user!.id,
              viewAngle: slot.angle,
              originalName: slot.file.originalname,
              declaredMimeType: slot.file.mimetype,
              buffer: slot.file.buffer,
            })
          );
        }

        const settings = parseSettingsInput(req.body?.settings);
        const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : undefined;
        const spec = await analyzeReferenceImages(stored, prompt, settings, {
          requireLiveNim: true,
        });
        res.json({ spec });
      } catch (err) {
        next(err);
      }
    }
  );

  // POST /api/ai/assist — Interactive MiniMax M3.1 Flash workflow assistant
  router.post('/assist', ensureStudioUser, limiter, async (req, res, next) => {
    try {
      const body = AssistSchema.parse(req.body);
      const result = await runAiAssistantChat(body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/ai/explain-error — Error diagnosis (live MiniMax or labeled system diagnostic)
  router.post('/explain-error', ensureStudioUser, async (req, res, next) => {
    try {
      const body = ExplainErrorSchema.parse(req.body);
      const diagnosis = await explainGenerationError(body);
      res.json({ diagnosis });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
