import { createApp } from './app.js';
import { getConfig } from './config/env.js';
import { closeDatabase, initDatabase } from './db/client.js';
import { getActiveProvider, getDemoModeInfo } from './providers/registry.js';
import { ensureDemoShowcaseModels } from './services/demoAssetService.js';
import { isNimConfigured } from './services/nvidiaNimService.js';

async function bootstrap() {
  const config = getConfig();
  const db = await initDatabase();
  await ensureDemoShowcaseModels();

  const app = createApp();
  const activeProvider = getActiveProvider();
  const demo = getDemoModeInfo();

  const server = app.listen(config.port, config.host, () => {
    console.log(`[NV3D Studio] API listening on http://${config.host}:${config.port}`);
    console.log(`[NV3D Studio] Database: ${db.engine}`);
    console.log(
      `[NV3D Studio] NVIDIA NIM (${config.nim.model}): ${
        isNimConfigured() ? 'CONFIGURED' : 'UNCONFIGURED (set NVIDIA_NIM_API_KEY)'
      }`
    );
    console.log(
      `[NV3D Studio] 3D Provider: ${
        activeProvider ? `${activeProvider.displayName} (LIVE)` : `DEMO MODE (${demo.reason})`
      }`
    );
  });

  const shutdown = async (signal: string) => {
    console.log(`[NV3D Studio] Received ${signal}, shutting down cleanly...`);
    server.close(async () => {
      await closeDatabase();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  console.error('[NV3D Studio] Fatal startup error:', err);
  process.exit(1);
});
