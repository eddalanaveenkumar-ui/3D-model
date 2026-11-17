import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Express } from 'express';
import { createApp } from './app.js';
import { initDatabase } from './db/client.js';
import { ensureDemoShowcaseModels } from './services/demoAssetService.js';

let cachedApp: Express | null = null;
let bootPromise: Promise<Express> | null = null;

async function ensureBootstrapped(): Promise<Express> {
  if (cachedApp) return cachedApp;
  if (bootPromise) return bootPromise;

  bootPromise = (async () => {
    await initDatabase();
    await ensureDemoShowcaseModels();
    const app = createApp();
    cachedApp = app;
    return app;
  })();

  try {
    return await bootPromise;
  } catch (err) {
    bootPromise = null;
    throw err;
  }
}

export default async function vercelHandler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  try {
    const app = await ensureBootstrapped();
    if (req.url && !req.url.startsWith('/api')) {
      req.url = `/api${req.url.startsWith('/') ? '' : '/'}${req.url}`;
    }
    app(req, res);
  } catch (err) {
    console.error('[NV3D Vercel Bootstrap Error]', err instanceof Error ? err.message : err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: {
            code: 'SERVERLESS_INIT_FAILED',
            message: 'Backend service failed to initialize. Check Vercel environment variables and function logs.',
          },
        })
      );
    }
  }
}
