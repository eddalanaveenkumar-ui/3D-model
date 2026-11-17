import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { getConfig } from './config/env.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createApiRateLimiter } from './middleware/rateLimit.js';
import { createAiRouter } from './routes/aiRoutes.js';
import { createAuthRouter } from './routes/authRoutes.js';
import { createGenerateRouter } from './routes/generateRoutes.js';
import { createHistoryRouter } from './routes/historyRoutes.js';
import { createModelRouter } from './routes/modelRoutes.js';
import { createSystemRouter } from './routes/systemRoutes.js';
import { createWebhookRouter } from './routes/webhookRoutes.js';

export function createApp(): Express {
  const app = express();
  const config = getConfig();

  // Trust single reverse proxy hop (cloud / sandbox HTTPS preview gateway)
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Security headers preventing arbitrary script/HTML execution while permitting preview framing & WebGL
  app.use(
    helmet({
      frameguard: false,
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'", 'blob:', 'data:'],
          workerSrc: ["'self'", 'blob:'],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
    })
  );

  app.use(
    cors({
      origin: config.corsOrigins.length > 0 ? config.corsOrigins : true,
      credentials: true,
    })
  );

  app.use(cookieParser());

  // Mount raw-body signature-verified webhooks BEFORE express.json()
  app.use('/api/webhooks', createWebhookRouter());

  // Body parsers with tight safety limits
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));

  // Global API rate limiter
  app.use('/api', createApiRateLimiter());

  // Lightweight health check
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'nv3d-studio-api', timestamp: new Date().toISOString() });
  });

  // Core NV3D Studio REST API routes
  app.use('/api/auth', createAuthRouter());
  app.use('/api/system', createSystemRouter());
  app.use('/api/generate', createGenerateRouter());
  app.use('/api/models', createModelRouter());
  app.use('/api/ai', createAiRouter());
  app.use('/api/history', createHistoryRouter());

  // Catch unknown /api routes with JSON 404 (never HTML)
  app.use('/api', (_req, res) => {
    res.status(404).json({
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: 'Requested API route does not exist.',
      },
    });
  });

  // Serve built frontend bundle on standalone Node deployments (Vercel serves frontend/dist via CDN)
  if (!config.isVercel) {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const frontendDist = path.resolve(currentDir, '../../frontend/dist');
    if (fs.existsSync(path.join(frontendDist, 'index.html'))) {
      app.use(
        express.static(frontendDist, {
          index: false,
          maxAge: '1h',
        })
      );
      app.get('*', (_req, res) => {
        res.sendFile(path.join(frontendDist, 'index.html'));
      });
    }
  }

  app.use(errorHandler);
  return app;
}
