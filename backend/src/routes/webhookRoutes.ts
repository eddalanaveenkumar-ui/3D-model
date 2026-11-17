import express, { Router } from 'express';
import { getProviderById } from '../providers/registry.js';
import { AppError } from '../services/authService.js';
import { applyVerifiedProviderWebhook } from '../services/jobManagerService.js';

export function createWebhookRouter(): Router {
  const router = Router();

  // Capture exact unparsed bytes for constant-time HMAC-SHA256 webhook verification
  router.post(
    '/:provider',
    express.raw({ type: 'application/json', limit: '1mb' }),
    async (req, res, next) => {
      try {
        const providerId = String(req.params.provider || '').toLowerCase();
        const provider = getProviderById(providerId);
        if (!provider) {
          throw new AppError(404, 'UNKNOWN_PROVIDER', `Unknown webhook provider "${providerId}".`);
        }

        if (!provider.hasWebhookSecret()) {
          throw new AppError(
            503,
            'WEBHOOK_SECRET_NOT_CONFIGURED',
            `Webhook secret for ${provider.displayName} is not configured on the server.`
          );
        }

        const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        if (rawBody.byteLength === 0) {
          throw new AppError(400, 'EMPTY_WEBHOOK_BODY', 'Webhook request body cannot be empty.');
        }

        const signature =
          req.header('x-webhook-signature') ||
          req.header('x-nv3d-signature') ||
          req.header('x-meshy-signature') ||
          req.header('x-tripo-signature') ||
          undefined;
        const timestamp = req.header('x-webhook-timestamp') || undefined;

        const isValid = provider.verifyWebhookSignature(rawBody, signature, timestamp);
        if (!isValid) {
          throw new AppError(
            401,
            'INVALID_WEBHOOK_SIGNATURE',
            'Webhook HMAC signature verification failed.'
          );
        }

        let payload: unknown;
        try {
          payload = JSON.parse(rawBody.toString('utf8'));
        } catch {
          throw new AppError(400, 'INVALID_WEBHOOK_JSON', 'Webhook body is not valid JSON.');
        }

        const event = provider.parseWebhookPayload(payload);
        const applied = await applyVerifiedProviderWebhook(provider.id, event);
        res.json({ received: true, ...applied });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
