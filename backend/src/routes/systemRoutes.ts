import { Router } from 'express';
import { z } from 'zod';
import type { SystemStatus } from '@nv3d/shared';
import { getConfig } from '../config/env.js';
import { getDb, listPublicTables } from '../db/client.js';
import { ensureStudioUser } from '../middleware/auth.js';
import {
  getActiveProvider,
  getDemoModeInfo,
  getProviderById,
  listProviderSummaries,
  setRuntimePreferredProvider,
} from '../providers/registry.js';
import { checkNimConnectivity, isNimConfigured } from '../services/nvidiaNimService.js';

const SelectProviderSchema = z.object({
  providerId: z.enum(['meshy', 'tripo', 'custom']).nullable(),
});

const TestProviderSchema = z.object({
  providerId: z.enum(['meshy', 'tripo', 'custom']).optional(),
});

export function createSystemRouter(): Router {
  const router = Router();

  // GET /api/system/status — Honest runtime capability & configuration readout (never leaks secrets)
  router.get('/status', async (_req, res, next) => {
    try {
      const config = getConfig();
      const db = getDb();
      const tables = await listPublicTables();
      const providers = listProviderSummaries();
      const active = providers.find((p) => p.active) ?? null;
      const demo = getDemoModeInfo();

      const status: SystemStatus = {
        appName: 'NV3D Studio',
        version: '1.0.0',
        demoMode: demo.demoMode,
        demoReason: demo.reason,
        nim: {
          configured: isNimConfigured(),
          endpoint: config.nim.endpoint,
          modelId: config.nim.model,
          visionModelId: config.nim.visionModel,
        },
        activeProvider: active,
        providers,
        database: {
          engine: db.engine,
          connected: true,
          tables,
        },
        limits: {
          maxUploadMb: config.maxUploadMb,
          maxGlbImportMb: config.maxGlbImportMb,
          acceptedImageTypes: ['image/png', 'image/jpeg', 'image/webp'],
          generationRateLimitPerMin: config.generationRateLimitMax,
        },
        security: {
          serverSideSecrets: true,
          fileAccessRestrictedByUser: true,
          rateLimitingActive: true,
          webhookSignatureVerification: true,
          cspEnabled: true,
          weaponsFreePolicy: true,
        },
      };

      res.json({ status });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/system/test-nim — Live connectivity test against NVIDIA NIM MiniMax M3.1 Flash
  router.post('/test-nim', ensureStudioUser, async (_req, res, next) => {
    try {
      const result = await checkNimConnectivity();
      res.json({ result });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/system/test-provider — Live connectivity test against 3D generation provider adapter
  router.post('/test-provider', ensureStudioUser, async (req, res, next) => {
    try {
      const body = TestProviderSchema.parse(req.body ?? {});
      const target = body.providerId ? getProviderById(body.providerId) : getActiveProvider();
      if (!target) {
        res.json({
          result: {
            service: '3D Generation Provider',
            configured: false,
            reachable: false,
            latencyMs: null,
            statusCode: null,
            message:
              'No active 3D provider is configured. Set MESHY_API_KEY, TRIPO_API_KEY, or CUSTOM_3D_PROVIDER_URL in server .env.',
            checkedAt: new Date().toISOString(),
          },
        });
        return;
      }
      const result = await target.checkConnectivity();
      res.json({ result });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/system/provider — Switch active configured 3D provider adapter
  router.post('/provider', ensureStudioUser, async (req, res, next) => {
    try {
      const body = SelectProviderSchema.parse(req.body);
      setRuntimePreferredProvider(body.providerId);
      const providers = listProviderSummaries();
      const activeProvider = providers.find((p) => p.active) ?? null;
      const demo = getDemoModeInfo();
      res.json({ activeProvider, providers, demoMode: demo.demoMode, demoReason: demo.reason });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
