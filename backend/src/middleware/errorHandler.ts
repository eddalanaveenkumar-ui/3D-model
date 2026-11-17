import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { ZodError } from 'zod';
import { getConfig } from '../config/env.js';
import { AppError } from '../services/authService.js';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (res.headersSent) return;

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
      },
      ...(err.details ?? {}),
    });
    return;
  }

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const cfg = getConfig();
      res.status(413).json({
        error: {
          code: 'FILE_TOO_LARGE',
          message: `Uploaded file exceeds the maximum allowed size (${cfg.maxUploadMb} MB for images, ${cfg.maxGlbImportMb} MB for GLB imports).`,
        },
      });
      return;
    }
    res.status(400).json({
      error: {
        code: 'UPLOAD_ERROR',
        message: `File upload error: ${err.message}`,
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    const first = err.issues[0];
    const field = first?.path?.join('.') || 'request';
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: `Invalid ${field}: ${first?.message || 'failed schema validation'}.`,
      },
    });
    return;
  }

  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({
      error: {
        code: 'INVALID_JSON',
        message: 'Malformed JSON request body.',
      },
    });
    return;
  }

  console.error('[NV3D API Error]', err instanceof Error ? err.message : err);
  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected server error occurred while processing the request.',
    },
  });
}
