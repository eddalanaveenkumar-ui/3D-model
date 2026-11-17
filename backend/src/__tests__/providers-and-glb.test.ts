import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_GENERATION_SETTINGS } from '@nv3d/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MeshyProviderAdapter } from '../providers/meshyProvider.js';
import { TripoProviderAdapter } from '../providers/tripoProvider.js';
import {
  getActiveProvider,
  listProviderSummaries,
  setRuntimePreferredProvider,
} from '../providers/registry.js';
import { buildTestFixtureGlb } from '../services/demoAssetService.js';
import { convertGlbToEmbeddedGltf, optimizeGlbBuffer } from '../services/glbOptimizationService.js';
import { validateGlbBuffer } from '../services/glbValidationService.js';
import { buildDeterministicFallbackSpec } from '../services/nvidiaNimService.js';

describe('Replaceable 3D Providers (Meshy + Tripo3D) & Binary GLB/GLTF Integrity', () => {
  let server: http.Server;
  let baseUrl = '';

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      const url = req.url || '/';
      // Drain body
      for await (const _ of req) {
        // consume stream
      }

      // Meshy routes
      if (req.method === 'GET' && url === '/openapi/v1/balance') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ balance: 1000 }));
        return;
      }
      if (req.method === 'POST' && url === '/openapi/v2/text-to-3d') {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: 'msy-text-01' }));
        return;
      }
      if (req.method === 'POST' && url === '/openapi/v1/multi-image-to-3d') {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: 'msy-multi-01' }));
        return;
      }
      if (req.method === 'GET' && url === '/openapi/v1/multi-image-to-3d/msy-multi-01') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'SUCCEEDED',
            progress: 100,
            model_urls: { glb: `${baseUrl}/out.glb` },
          })
        );
        return;
      }

      // Tripo3D routes
      if (req.method === 'GET' && url === '/user/balance') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, data: { balance: 500 } }));
        return;
      }
      if (req.method === 'POST' && url === '/upload') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, data: { image_token: 'tok-img-123' } }));
        return;
      }
      if (req.method === 'POST' && url === '/task') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, data: { task_id: 'trp-task-99' } }));
        return;
      }
      if (req.method === 'GET' && url === '/task/trp-task-99') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            code: 0,
            data: {
              status: 'success',
              progress: 100,
              output: { pbr_model: `${baseUrl}/out.glb` },
            },
          })
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    setRuntimePreferredProvider(null);
    process.env.MESHY_API_KEY = '';
    process.env.TRIPO_API_KEY = '';
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('switches cleanly between Meshy and Tripo3D adapters and handles multi-view image jobs', async () => {
    process.env.MESHY_API_KEY = 'msy-ephemeral-test';
    process.env.MESHY_API_BASE_URL = baseUrl;
    process.env.MESHY_WEBHOOK_SECRET = 'msy-hook-secret';
    process.env.TRIPO_API_KEY = 'tsk-ephemeral-test';
    process.env.TRIPO_API_BASE_URL = baseUrl;
    process.env.TRIPO_WEBHOOK_SECRET = 'trp-hook-secret';
    process.env.PROVIDER_3D = 'auto';

    const summaries = listProviderSummaries();
    expect(summaries.find((s) => s.id === 'meshy')?.configured).toBe(true);
    expect(summaries.find((s) => s.id === 'tripo')?.configured).toBe(true);
    expect(getActiveProvider()?.id).toBe('meshy');

    // Switch active adapter to Tripo3D at runtime
    setRuntimePreferredProvider('tripo');
    expect(getActiveProvider()?.id).toBe('tripo');

    const spec = buildDeterministicFallbackSpec({
      prompt: 'Aerodynamic silver concept car',
      settings: { ...DEFAULT_GENERATION_SETTINGS, category: 'car' },
      fallbackReason: 'unit test',
    });

    // Exercise Meshy multi-image (front + side + back) & polling
    const meshy = new MeshyProviderAdapter();
    expect((await meshy.checkConnectivity()).reachable).toBe(true);
    const msyText = await meshy.submitTextTo3D({
      jobId: 'j1',
      prompt: 'Concept car',
      spec,
      settings: DEFAULT_GENERATION_SETTINGS,
    });
    expect(msyText.externalJobId).toBe('text:msy-text-01');

    const dummyImg = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const msyMulti = await meshy.submitImageTo3D({
      jobId: 'j2',
      prompt: null,
      spec,
      settings: DEFAULT_GENERATION_SETTINGS,
      images: [
        { viewAngle: 'front', mimeType: 'image/png', originalName: 'f.png', buffer: dummyImg, dataUrl: 'data:image/png;base64,iVBORw==' },
        { viewAngle: 'side', mimeType: 'image/png', originalName: 's.png', buffer: dummyImg, dataUrl: 'data:image/png;base64,iVBORw==' },
        { viewAngle: 'back', mimeType: 'image/png', originalName: 'b.png', buffer: dummyImg, dataUrl: 'data:image/png;base64,iVBORw==' },
      ],
    });
    expect(msyMulti.externalJobId).toBe('multiview:msy-multi-01');
    const msyPolled = await meshy.getJobStatus(msyMulti.externalJobId);
    expect(msyPolled.status).toBe('succeeded');
    expect(msyPolled.glbUrl).toBe(`${baseUrl}/out.glb`);

    // Exercise Tripo3D connectivity, multi-view upload, polling & webhook HMAC
    const tripo = new TripoProviderAdapter();
    expect((await tripo.checkConnectivity()).reachable).toBe(true);
    expect(tripo.capabilities.rigging).toBe(true);
    expect(tripo.capabilities.animation).toBe(true);

    const trpSub = await tripo.submitImageTo3D({
      jobId: 'j3',
      prompt: 'Humanoid explorer',
      spec,
      settings: { ...DEFAULT_GENERATION_SETTINGS, rigging: true, animation: true },
      images: [
        { viewAngle: 'front', mimeType: 'image/png', originalName: 'f.png', buffer: dummyImg, dataUrl: 'data:image/png;base64,iVBORw==' },
        { viewAngle: 'back', mimeType: 'image/png', originalName: 'b.png', buffer: dummyImg, dataUrl: 'data:image/png;base64,iVBORw==' },
      ],
    });
    expect(trpSub.externalJobId).toBe('trp-task-99');
    const trpPolled = await tripo.getJobStatus(trpSub.externalJobId);
    expect(trpPolled.status).toBe('succeeded');

    const hookBody = Buffer.from(JSON.stringify({ task_id: 'trp-task-99', status: 'success' }));
    const validSig = crypto.createHmac('sha256', 'trp-hook-secret').update(hookBody).digest('hex');
    expect(tripo.verifyWebhookSignature(hookBody, validSig)).toBe(true);
    expect(tripo.verifyWebhookSignature(hookBody, 'bad-signature')).toBe(false);
  });

  it('optimizes GLB binaries and preserves geometry, UVs, PBR textures, and animations in GLB & GLTF exports', async () => {
    const rawGlb = await buildTestFixtureGlb();
    const optimized = await optimizeGlbBuffer(rawGlb, {
      optimizeSize: true,
      textureResolution: '1k',
      polygonDetail: 'medium',
      enforcePolygonBudget: true,
    });

    const report = validateGlbBuffer(optimized);
    expect(report.valid).toBe(true);
    expect(report.statistics.hasUVs).toBe(true);
    expect(report.statistics.hasNormals).toBe(true);
    expect(report.statistics.hasPbrMaterials).toBe(true);
    expect(report.statistics.textureCount).toBe(1);
    expect(report.statistics.animationCount).toBe(1);
    expect(report.statistics.dimensions.height).toBeGreaterThan(1.0);
    // Optimization reduces or maintains binary file size
    expect(optimized.byteLength).toBeLessThanOrEqual(rawGlb.byteLength);

    // Reject mutated header length
    const tampered = Buffer.from(optimized);
    tampered.writeUInt32LE(optimized.byteLength + 64, 8);
    const badReport = validateGlbBuffer(tampered);
    expect(badReport.valid).toBe(false);
    expect(badReport.issues.some((i) => i.code === 'LENGTH_MISMATCH')).toBe(true);

    // Self-contained GLTF export preserves embedded buffer, images, materials & animation
    const gltfBytes = await convertGlbToEmbeddedGltf(optimized);
    const gltf = JSON.parse(gltfBytes.toString('utf8')) as {
      asset: { version: string };
      buffers: Array<{ uri: string }>;
      textures: unknown[];
      animations: Array<{ name: string }>;
    };
    expect(gltf.asset.version).toBe('2.0');
    expect(gltf.buffers[0].uri).toMatch(/^data:application\/octet-stream;base64,/);
    expect(gltf.textures).toHaveLength(1);
    expect(gltf.animations[0].name).toBe('Core_Orbit_Cycle');
  });
});
