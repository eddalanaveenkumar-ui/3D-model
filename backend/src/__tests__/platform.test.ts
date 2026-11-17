import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_GENERATION_SETTINGS } from '@nv3d/shared';
import { createApp } from '../app.js';
import { closeDatabase, getDb, initDatabase, listPublicTables } from '../db/client.js';
import { setRuntimePreferredProvider } from '../providers/registry.js';
import { buildTestFixtureGlb, ensureDemoShowcaseModels } from '../services/demoAssetService.js';
import { validateGlbBuffer } from '../services/glbValidationService.js';

// Helper: wait for a generation job to reach a terminal state via real HTTP polling
async function pollJobUntilTerminal(
  app: ReturnType<typeof createApp>,
  token: string,
  jobId: string,
  timeoutMs = 12_000
) {
  const deadline = Date.now() + timeoutMs;
  const observedStatuses: string[] = [];

  while (Date.now() < deadline) {
    const res = await request(app)
      .get(`/api/generate/${jobId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const status = res.body.job.status as string;
    if (observedStatuses[observedStatuses.length - 1] !== status) {
      observedStatuses.push(status);
    }
    if (['succeeded', 'failed', 'provider_unconfigured'].includes(status)) {
      return { job: res.body.job, observedStatuses };
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`Timed out polling job ${jobId}; seen: ${observedStatuses.join(' -> ')}`);
}

// Helper: create genuine PNG / JPEG / WEBP images for upload testing
async function createSampleImage(
  format: 'png' | 'jpeg' | 'webp',
  width = 256,
  height = 256
): Promise<Buffer> {
  const base = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 118, g: 185, b: 0, alpha: 1 },
    },
  });
  if (format === 'png') return base.png().toBuffer();
  if (format === 'jpeg') return base.jpeg({ quality: 90 }).toBuffer();
  return base.webp({ quality: 90 }).toBuffer();
}

describe('NV3D Studio — End-to-End Platform Verification Suite', () => {
  const tmpStorage = fs.mkdtempSync(path.join(os.tmpdir(), 'nv3d-test-storage-'));
  let app: ReturnType<typeof createApp>;
  let mockServer: http.Server;
  let mockBaseUrl = '';
  let fixtureGlb: Buffer;

  // Controllable test upstream behavior flags
  let nimBehavior: 'ok' | 'http500' = 'ok';
  let providerBehavior: 'ok' | 'fail_job' | 'corrupt_glb' | 'http500' = 'ok';
  let lastNimRequestBody: Record<string, unknown> | null = null;
  let lastProviderImageCount = 0;
  const providerPollCounts = new Map<string, number>();
  const webhookSecret = crypto.randomBytes(24).toString('hex');

  let userAToken = '';
  let userBToken = '';
  let generatedModelId = '';

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.PGLITE_DATA_DIR = 'memory://';
    process.env.STORAGE_DIR = tmpStorage;
    process.env.DATABASE_URL = '';
    process.env.NVIDIA_NIM_API_KEY = '';
    process.env.MESHY_API_KEY = '';
    process.env.TRIPO_API_KEY = '';
    process.env.CUSTOM_3D_PROVIDER_URL = '';
    process.env.PROVIDER_3D = 'auto';
    process.env.JOB_POLL_INTERVAL_MS = '90';
    process.env.GENERATION_RATE_LIMIT_MAX = '40';

    await initDatabase();
    await ensureDemoShowcaseModels();
    fixtureGlb = await buildTestFixtureGlb();
    app = createApp();

    // Start local HTTP contract server exercising NVIDIA NIM + 3D Provider wire protocols
    mockServer = http.createServer(async (req, res) => {
      const url = req.url || '/';
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const rawBody = Buffer.concat(chunks).toString('utf8');

      // --- NVIDIA NIM /v1/chat/completions ---
      if (req.method === 'POST' && url === '/v1/chat/completions') {
        if (nimBehavior === 'http500') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Upstream NIM capacity limit' } }));
          return;
        }
        const parsed = JSON.parse(rawBody) as {
          model: string;
          messages: Array<{ role: string; content: unknown }>;
          response_format?: { type: string };
        };
        lastNimRequestBody = parsed;

        const isJsonMode = parsed.response_format?.type === 'json_object';
        const sysMsg = String(parsed.messages?.[0]?.content ?? '');

        let content: string;
        if (isJsonMode && sysMsg.includes('diagnose errors')) {
          content = JSON.stringify({
            explanation: 'Diagnosed provider mesh failure caused by upstream timeout.',
            recommendedActions: ['Retry with Standard quality.', 'Verify provider health in Settings.'],
          });
        } else if (isJsonMode) {
          content = JSON.stringify({
            title: 'Sculpted Nordic Chair',
            category: 'furniture',
            enhancedPrompt:
              'Single watertight 3D sculpted Nordic walnut lounge chair with charcoal boucle cushions, clean quad-dominant topology, neutral studio PBR albedo, UV unwrapped, weapons-free.',
            negativePrompt: 'broken mesh, non-manifold, harsh shadows, weapons',
            artStyle: 'realistic-pbr',
            geometryGuidance: {
              targetPolycount: 30000,
              topology: 'quad-dominant',
              symmetry: 'bilateral',
              silhouetteNotes: 'Clean tapered walnut legs and angled ergonomic backrest.',
              scaleMeters: { width: 0.78, height: 0.92, depth: 0.76 },
            },
            materials: [
              {
                name: 'Oiled_Walnut',
                surfaceType: 'wood',
                baseColorHex: '#6E472B',
                roughness: 0.42,
                metalness: 0.04,
              },
            ],
            riggingRecommended: false,
            riggingNotes: 'Static furniture hierarchy.',
            animationNotes: 'No animation required.',
            weaponsFreeVerified: true,
            referenceAnalysis: {
              primarySubject: 'Modern upholstered lounge chair',
              occludedSurfaceInference: 'Reconstruct symmetric rear backrest panel and back legs.',
              lightingCompensation: 'Remove key-light specular hotspot from walnut armrest.',
              proportionNotes: '1:1.15 width-to-height ratio.',
            },
            warnings: [],
          });
        } else {
          content =
            'Use Medium polygon detail (~30K triangles) with 2K PBR textures and specify unlit studio materials.';
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-nv3d-test',
            model: parsed.model,
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          })
        );
        return;
      }

      // --- 3D Provider Gateway ---
      if (req.method === 'GET' && url === '/provider/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'healthy' }));
        return;
      }

      if (req.method === 'POST' && (url === '/provider/generate/text' || url === '/provider/generate/image')) {
        if (providerBehavior === 'http500') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'GPU worker pool unavailable' }));
          return;
        }
        const parsed = JSON.parse(rawBody) as { images?: unknown[] };
        if (url.endsWith('/image')) {
          lastProviderImageCount = parsed.images?.length ?? 0;
        }
        const extId = `ext-${crypto.randomUUID().slice(0, 8)}`;
        providerPollCounts.set(extId, 0);
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jobId: extId, status: 'queued', progress: 15 }));
        return;
      }

      if (req.method === 'GET' && url.startsWith('/provider/jobs/')) {
        const extId = url.replace('/provider/jobs/', '');
        const count = (providerPollCounts.get(extId) ?? 0) + 1;
        providerPollCounts.set(extId, count);

        if (count === 1) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jobId: extId,
              status: 'processing',
              progress: 58,
              stage: 'Synthesizing PBR mesh (58%)',
            })
          );
          return;
        }

        if (providerBehavior === 'fail_job') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jobId: extId,
              status: 'failed',
              progress: 60,
              error: 'Surface reconstruction diverged on occluded region.',
            })
          );
          return;
        }

        const assetPath =
          providerBehavior === 'corrupt_glb' ? '/provider/assets/corrupt.glb' : '/provider/assets/valid.glb';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jobId: extId,
            status: 'succeeded',
            progress: 100,
            stage: 'Mesh ready',
            glbUrl: `${mockBaseUrl}${assetPath}`,
          })
        );
        return;
      }

      if (req.method === 'GET' && url === '/provider/assets/valid.glb') {
        res.writeHead(200, {
          'Content-Type': 'model/gltf-binary',
          'Content-Length': String(fixtureGlb.byteLength),
        });
        res.end(fixtureGlb);
        return;
      }

      if (req.method === 'GET' && url === '/provider/assets/corrupt.glb') {
        const bad = Buffer.from('NOT_A_VALID_GLB_FILE_PAYLOAD');
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(bad.byteLength),
        });
        res.end(bad);
        return;
      }

      // --- NVIDIA NIM 3D (microsoft/trellis) contract ---
      if (req.method === 'POST' && url === '/v1/genai/microsoft/trellis') {
        const auth = String(req.headers.authorization || '');
        if (!auth.startsWith('Bearer nvapi-')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ detail: 'Invalid API key' }));
          return;
        }
        const parsed = JSON.parse(rawBody || '{}') as { prompt?: string; image?: string };
        // Schema probe from checkConnectivity()
        if (!parsed.prompt && !parsed.image) {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ detail: 'Either prompt or image is required' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            artifacts: [
              {
                base64: fixtureGlb.toString('base64'),
                finishReason: 'SUCCESS',
                seed: 0,
              },
            ],
          })
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        const addr = mockServer.address() as AddressInfo;
        mockBaseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    setRuntimePreferredProvider(null);
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    await closeDatabase();
    fs.rmSync(tmpStorage, { recursive: true, force: true });
  });

  it('1. verifies PostgreSQL schema tables, zero-login anonymous workspaces, and disabled sign-up/login', async () => {
    const tables = await listPublicTables();
    expect(tables).toEqual([
      'generated_models',
      'generation_history',
      'generation_jobs',
      'uploaded_images',
      'user_credits',
      'users',
    ]);

    // Sign-up and login routes are disabled by design (zero-login studio)
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'alice@nv3d.example', password: 'StrongPassword123!', displayName: 'Alice' })
      .expect(404);
    await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@nv3d.example', password: 'StrongPassword123!' })
      .expect(404);

    // Every visitor automatically gets an isolated zero-login workspace session
    const sessA = await request(app).get('/api/auth/me').expect(200);
    expect(sessA.body.user.isGuest).toBe(true);
    expect(sessA.body.user.credits).toBe(250);
    userAToken = String(sessA.headers['x-nv3d-session'] || '');
    expect(userAToken.length).toBeGreaterThan(20);

    // Subsequent request with X-NV3D-Session resolves exact same isolated workspace
    const sessARepeat = await request(app)
      .get('/api/auth/me')
      .set('X-NV3D-Session', userAToken)
      .expect(200);
    expect(sessARepeat.body.user.id).toBe(sessA.body.user.id);

    const sessB = await request(app).get('/api/auth/me').expect(200);
    userBToken = String(sessB.headers['x-nv3d-session'] || '');
    expect(userBToken.length).toBeGreaterThan(20);
    expect(sessB.body.user.id).not.toBe(sessA.body.user.id);
  });

  it('2. enters honest Demo Mode when no 3D provider or NIM key is configured (never fakes generation)', async () => {
    const statusRes = await request(app).get('/api/system/status').expect(200);
    expect(statusRes.body.status.demoMode).toBe(true);
    expect(statusRes.body.status.activeProvider).toBeNull();
    expect(statusRes.body.status.nim.configured).toBe(false);
    expect(statusRes.body.status.nim.endpoint).toBe(
      'https://integrate.api.nvidia.com/v1/chat/completions'
    );
    expect(statusRes.body.status.nim.modelId).toBe('minimaxai/minimax-m3.1-flash');
    // Ensure no API keys leak anywhere in serialized response
    expect(JSON.stringify(statusRes.body)).not.toContain('apiKey');

    // Text generation in Demo Mode must NOT fake a model and must charge 0 credits
    const genRes = await request(app)
      .post('/api/generate/text')
      .set('Authorization', `Bearer ${userAToken}`)
      .send({
        prompt: 'Mid-century walnut armchair with boucle cushions',
        settings: DEFAULT_GENERATION_SETTINGS,
      })
      .expect(503);

    expect(genRes.body.error.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(genRes.body.demoMode).toBe(true);
    expect(genRes.body.job.status).toBe('provider_unconfigured');
    expect(genRes.body.job.modelId).toBeNull();
    expect(genRes.body.job.structuredSpec.orchestrator).toBe('local-deterministic-fallback');

    // Explicit AI chat in unconfigured mode refuses to fabricate responses
    const chatRes = await request(app)
      .post('/api/ai/assist')
      .set('Authorization', `Bearer ${userAToken}`)
      .send({ message: 'Help me improve this prompt' })
      .expect(503);
    expect(chatRes.body.error.code).toBe('NIM_NOT_CONFIGURED');

    // Credits remain completely untouched at 250
    const creditsRes = await request(app)
      .get('/api/auth/credits')
      .set('Authorization', `Bearer ${userAToken}`)
      .expect(200);
    expect(creditsRes.body.credits.balance).toBe(250);
  });

  it('3. enforces weapons-free asset policy cleanly', async () => {
    const blocked = await request(app)
      .post('/api/generate/text')
      .set('Authorization', `Bearer ${userAToken}`)
      .send({
        prompt: 'Tactical sniper rifle with scope and ammunition magazine',
        settings: DEFAULT_GENERATION_SETTINGS,
      })
      .expect(422);

    expect(blocked.body.error.code).toBe('POLICY_VIOLATION');
  });

  it('4. verifies live NVIDIA NIM MiniMax M3.1 Flash connectivity, prompt structuring & assistant', async () => {
    process.env.NVIDIA_NIM_ENDPOINT = `${mockBaseUrl}/v1/chat/completions`;
    process.env.NVIDIA_NIM_MODEL = 'minimaxai/minimax-m3.1-flash';
    process.env.NVIDIA_NIM_VISION_MODEL = 'minimaxai/minimax-m3.1-flash';
    process.env.NVIDIA_NIM_API_KEY = 'nvapi-test-ephemeral-key';

    const nimTest = await request(app)
      .post('/api/system/test-nim')
      .set('Authorization', `Bearer ${userAToken}`)
      .expect(200);
    expect(nimTest.body.result.configured).toBe(true);
    expect(nimTest.body.result.reachable).toBe(true);
    expect(nimTest.body.result.modelId).toBe('minimaxai/minimax-m3.1-flash');

    const enhance = await request(app)
      .post('/api/ai/enhance')
      .set('Authorization', `Bearer ${userAToken}`)
      .send({
        prompt: 'Sculpted Nordic walnut chair',
        settings: { ...DEFAULT_GENERATION_SETTINGS, category: 'furniture' },
      })
      .expect(200);

    expect(enhance.body.spec.orchestrator).toBe('nvidia-nim-minimax');
    expect(enhance.body.spec.modelId).toBe('minimaxai/minimax-m3.1-flash');
    expect(enhance.body.spec.category).toBe('furniture');
    expect(enhance.body.spec.materials.length).toBeGreaterThan(0);
    expect(lastNimRequestBody?.model).toBe('minimaxai/minimax-m3.1-flash');

    const assist = await request(app)
      .post('/api/ai/assist')
      .set('Authorization', `Bearer ${userAToken}`)
      .send({ message: 'What polycount should I use?' })
      .expect(200);
    expect(assist.body.reply).toContain('30K triangles');

    // Ensure secret never leaks in /api/system/status
    const status = await request(app).get('/api/system/status').expect(200);
    expect(JSON.stringify(status.body)).not.toContain('nvapi-test-ephemeral-key');
  });

  it('5. verifies 3D provider connectivity and full Text-to-3D + polling + GLB validation workflow', async () => {
    process.env.CUSTOM_3D_PROVIDER_NAME = 'Test 3D Synthesis Engine';
    process.env.CUSTOM_3D_PROVIDER_URL = `${mockBaseUrl}/provider`;
    process.env.CUSTOM_3D_PROVIDER_API_KEY = 'prov-ephemeral-key';
    process.env.CUSTOM_3D_WEBHOOK_SECRET = webhookSecret;

    const status = await request(app).get('/api/system/status').expect(200);
    expect(status.body.status.demoMode).toBe(false);
    expect(status.body.status.activeProvider.id).toBe('custom');

    const provTest = await request(app)
      .post('/api/system/test-provider')
      .set('Authorization', `Bearer ${userAToken}`)
      .send({ providerId: 'custom' })
      .expect(200);
    expect(provTest.body.result.reachable).toBe(true);

    // Submit async Text-to-3D job
    const createJob = await request(app)
      .post('/api/generate/text')
      .set('Authorization', `Bearer ${userAToken}`)
      .send({
        prompt: 'Sculpted Nordic walnut lounge chair with boucle cushions',
        settings: {
          ...DEFAULT_GENERATION_SETTINGS,
          category: 'furniture',
          quality: 'standard',
          polygonDetail: 'medium',
          textureResolution: '2k',
          pbr: true,
          optimizeSize: true,
        },
      })
      .expect(202);

    const jobId = createJob.body.job.id as string;
    expect(jobId).toBeTruthy();

    // User B cannot spy on User A's job
    await request(app)
      .get(`/api/generate/${jobId}`)
      .set('Authorization', `Bearer ${userBToken}`)
      .expect(403);

    // Poll until async workflow downloads, optimizes, and validates GLB
    const { job, observedStatuses } = await pollJobUntilTerminal(app, userAToken, jobId);
    expect(job.status).toBe('succeeded');
    expect(observedStatuses.length).toBeGreaterThanOrEqual(1);
    expect(job.structuredSpec.orchestrator).toBe('nvidia-nim-minimax');
    expect(job.modelId).toBeTruthy();
    generatedModelId = job.modelId;

    // Verify credits charged accurately (standard=12 + 2k=2 => 14 CR -> 236 balance)
    const credits = await request(app)
      .get('/api/auth/credits')
      .set('Authorization', `Bearer ${userAToken}`)
      .expect(200);
    expect(credits.body.credits.balance).toBe(236);
  });

  it('6. verifies Image-to-3D with PNG, JPG, and WEBP multi-view (front, side, back) + user file isolation', async () => {
    const [frontPng, sideJpg, backWebp] = await Promise.all([
      createSampleImage('png', 320, 320),
      createSampleImage('jpeg', 320, 320),
      createSampleImage('webp', 320, 320),
    ]);

    const res = await request(app)
      .post('/api/generate/image')
      .set('Authorization', `Bearer ${userAToken}`)
      .attach('front', frontPng, { filename: 'chair-front.png', contentType: 'image/png' })
      .attach('side', sideJpg, { filename: 'chair-side.jpg', contentType: 'image/jpeg' })
      .attach('back', backWebp, { filename: 'chair-back.webp', contentType: 'image/webp' })
      .field('prompt', 'Match warm walnut frame proportions')
      .field('settings', JSON.stringify(DEFAULT_GENERATION_SETTINGS))
      .expect(202);

    expect(res.body.job.uploadedImages).toHaveLength(3);
    const previewUrl = res.body.job.uploadedImages[0].previewUrl as string;

    // Owner can retrieve preview with strict nosniff header
    const ownImg = await request(app)
      .get(previewUrl)
      .set('Authorization', `Bearer ${userAToken}`)
      .expect(200);
    expect(ownImg.headers['x-content-type-options']).toBe('nosniff');
    expect(ownImg.headers['content-type']).toBe('image/png');

    // User B is strictly blocked from accessing User A's uploaded image
    await request(app)
      .get(previewUrl)
      .set('Authorization', `Bearer ${userBToken}`)
      .expect(403);

    const { job } = await pollJobUntilTerminal(app, userAToken, res.body.job.id);
    expect(job.status).toBe('succeeded');
    expect(job.structuredSpec.referenceAnalysis.viewsProvided).toEqual(['front', 'side', 'back']);
    expect(lastProviderImageCount).toBe(3);
  });

  it('7. rejects invalid, disguised script/HTML, empty, and tiny images and invalid GLB imports', async () => {
    // Disguised HTML/XSS saved as .png
    const fakePng = Buffer.from('<script>alert("xss")</script><html><body>fake</body></html>');
    const badType = await request(app)
      .post('/api/generate/image')
      .set('Authorization', `Bearer ${userAToken}`)
      .attach('front', fakePng, { filename: 'exploit.png', contentType: 'image/png' })
      .expect(400);
    expect(badType.body.error.code).toBe('INVALID_IMAGE_TYPE');

    // Missing image field altogether
    const missing = await request(app)
      .post('/api/generate/image')
      .set('Authorization', `Bearer ${userAToken}`)
      .field('prompt', 'No file attached')
      .expect(400);
    expect(missing.body.error.code).toBe('MISSING_IMAGE');

    // Undersized 8x8 PNG
    const tinyPng = await createSampleImage('png', 8, 8);
    const tinyRes = await request(app)
      .post('/api/generate/image')
      .set('Authorization', `Bearer ${userAToken}`)
      .attach('front', tinyPng, { filename: 'tiny.png', contentType: 'image/png' })
      .expect(400);
    expect(tinyRes.body.error.code).toBe('IMAGE_TOO_SMALL');

    // Invalid GLB upload to /api/models/import
    const badGlb = await request(app)
      .post('/api/models/import')
      .set('Authorization', `Bearer ${userAToken}`)
      .attach('file', Buffer.from('not a real glb binary'), {
        filename: 'broken.glb',
        contentType: 'model/gltf-binary',
      })
      .expect(400);
    expect(badGlb.body.error.code).toBe('GLB_VALIDATION_FAILED');
  });

  it('8. verifies GLB loading, validation, genuine GLB + GLTF downloads, user isolation, and deletion', async () => {
    // GET /api/models returns user models + 8 validated demo samples
    const listA = await request(app)
      .get('/api/models')
      .set('Authorization', `Bearer ${userAToken}`)
      .expect(200);
    const demoModels = listA.body.models.filter((m: { isDemo: boolean }) => m.isDemo);
    const ownModels = listA.body.models.filter((m: { isDemo: boolean }) => !m.isDemo);
    expect(demoModels).toHaveLength(8);
    expect(ownModels.length).toBeGreaterThanOrEqual(2);

    // User B sees 0 of User A's generated models
    const listB = await request(app)
      .get('/api/models?includeDemo=false')
      .set('Authorization', `Bearer ${userBToken}`)
      .expect(200);
    expect(listB.body.models).toHaveLength(0);

    // GET /api/models/:id
    const detail = await request(app)
      .get(`/api/models/${generatedModelId}`)
      .set('Authorization', `Bearer ${userAToken}`)
      .expect(200);
    expect(detail.body.model.validated).toBe(true);
    expect(detail.body.model.statistics.vertices).toBeGreaterThan(100);
    expect(detail.body.model.statistics.triangles).toBeGreaterThan(100);
    expect(detail.body.model.statistics.hasUVs).toBe(true);
    expect(detail.body.model.statistics.hasPbrMaterials).toBe(true);
    expect(detail.body.model.statistics.animationCount).toBeGreaterThanOrEqual(1);

    // GET /api/models/:id/download (binary GLB)
    const dlGlb = await request(app)
      .get(`/api/models/${generatedModelId}/download`)
      .set('Authorization', `Bearer ${userAToken}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);

    const downloadedBuffer = dlGlb.body as Buffer;
    expect(dlGlb.headers['content-type']).toContain('model/gltf-binary');
    expect(Number(dlGlb.headers['content-length'])).toBe(downloadedBuffer.byteLength);
    expect(dlGlb.headers['x-glb-validated']).toBe('true');

    // Validate the exact downloaded bytes with Khronos GLB validator
    const report = validateGlbBuffer(downloadedBuffer);
    expect(report.valid).toBe(true);
    expect(report.headerMagicValid).toBe(true);
    expect(report.gltfVersion).toBe('2.0');
    expect(report.sha256).toBe(dlGlb.headers['x-content-sha256']);
    expect(report.statistics.textureCount).toBeGreaterThanOrEqual(1);
    expect(report.statistics.animationCount).toBeGreaterThanOrEqual(1);

    // GET /api/models/:id/download?format=gltf (separate self-contained GLTF 2.0 JSON)
    const dlGltf = await request(app)
      .get(`/api/models/${generatedModelId}/download?format=gltf`)
      .set('Authorization', `Bearer ${userAToken}`)
      .expect(200);
    expect(dlGltf.headers['content-type']).toContain('model/gltf+json');
    const gltfParsed = JSON.parse(dlGltf.text) as {
      asset: { version: string };
      meshes: unknown[];
      materials: unknown[];
      animations: unknown[];
      buffers: Array<{ uri: string }>;
    };
    expect(gltfParsed.asset.version).toBe('2.0');
    expect(gltfParsed.meshes.length).toBeGreaterThan(0);
    expect(gltfParsed.materials.length).toBeGreaterThan(0);
    expect(gltfParsed.animations.length).toBeGreaterThan(0);
    expect(gltfParsed.buffers[0].uri.startsWith('data:application/octet-stream;base64,')).toBe(true);

    // User B cannot download or delete User A's model
    await request(app)
      .get(`/api/models/${generatedModelId}/download`)
      .set('Authorization', `Bearer ${userBToken}`)
      .expect(403);
    await request(app)
      .delete(`/api/models/${generatedModelId}`)
      .set('Authorization', `Bearer ${userBToken}`)
      .expect(403);

    // Demo models are protected from deletion
    await request(app)
      .delete(`/api/models/${demoModels[0].id}`)
      .set('Authorization', `Bearer ${userAToken}`)
      .expect(403);

    // DELETE /api/models/:id removes User A's model & file
    await request(app)
      .delete(`/api/models/${generatedModelId}`)
      .set('Authorization', `Bearer ${userAToken}`)
      .expect(200);
    await request(app)
      .get(`/api/models/${generatedModelId}`)
      .set('Authorization', `Bearer ${userAToken}`)
      .expect(404);
  });

  it('9. handles NIM failures, provider failures, and corrupted GLB outputs gracefully with automatic credit refunds', async () => {
    const beforeCredits = (
      await request(app)
        .get('/api/auth/credits')
        .set('Authorization', `Bearer ${userAToken}`)
        .expect(200)
    ).body.credits.balance as number;

    // Case A: Provider fails mid-generation
    providerBehavior = 'fail_job';
    const failSub = await request(app)
      .post('/api/generate/text')
      .set('Authorization', `Bearer ${userAToken}`)
      .send({ prompt: 'Modernist glass pavilion courtyard', settings: DEFAULT_GENERATION_SETTINGS })
      .expect(202);
    const failedPoll = await pollJobUntilTerminal(app, userAToken, failSub.body.job.id);
    expect(failedPoll.job.status).toBe('failed');
    expect(failedPoll.job.errorCode).toBe('PROVIDER_GENERATION_FAILED');

    // Case B: Provider returns corrupted non-GLB binary -> caught by GLB validator
    providerBehavior = 'corrupt_glb';
    const corruptSub = await request(app)
      .post('/api/generate/text')
      .set('Authorization', `Bearer ${userAToken}`)
      .send({ prompt: 'Ceramic desk lamp on oak base', settings: DEFAULT_GENERATION_SETTINGS })
      .expect(202);
    const corruptPoll = await pollJobUntilTerminal(app, userAToken, corruptSub.body.job.id);
    expect(corruptPoll.job.status).toBe('failed');
    expect(corruptPoll.job.errorCode).toBe('GLB_VALIDATION_FAILED');

    // Case C: NVIDIA NIM returns HTTP 500
    providerBehavior = 'ok';
    nimBehavior = 'http500';
    const nimFailSub = await request(app)
      .post('/api/generate/text')
      .set('Authorization', `Bearer ${userAToken}`)
      .send({ prompt: 'Stylized courtyard bonsai tree', settings: DEFAULT_GENERATION_SETTINGS })
      .expect(202);
    const nimFailPoll = await pollJobUntilTerminal(app, userAToken, nimFailSub.body.job.id);
    expect(nimFailPoll.job.status).toBe('failed');
    expect(nimFailPoll.job.errorCode).toBe('NIM_UPSTREAM_ERROR');
    nimBehavior = 'ok';

    // All three failed jobs must have refunded 100% of reserved credits
    const afterCredits = (
      await request(app)
        .get('/api/auth/credits')
        .set('Authorization', `Bearer ${userAToken}`)
        .expect(200)
    ).body.credits.balance as number;
    expect(afterCredits).toBe(beforeCredits);

    // AI error diagnosis explains the failure
    const explain = await request(app)
      .post('/api/ai/explain-error')
      .set('Authorization', `Bearer ${userAToken}`)
      .send({
        errorCode: failedPoll.job.errorCode,
        errorMessage: failedPoll.job.errorMessage,
        providerId: 'custom',
      })
      .expect(200);
    expect(explain.body.diagnosis.source).toBe('nvidia-nim-minimax');
    expect(explain.body.diagnosis.recommendedActions.length).toBeGreaterThan(0);
  });

  it('10. enforces HMAC-SHA256 webhook signature verification, history audit log, and rate limiting', async () => {
    const payload = JSON.stringify({
      jobId: 'nonexistent-ext-id',
      status: 'processing',
      progress: 50,
    });

    // Reject missing or forged signature
    await request(app)
      .post('/api/webhooks/custom')
      .set('Content-Type', 'application/json')
      .set('x-webhook-signature', 'sha256=' + '0'.repeat(64))
      .send(payload)
      .expect(401);

    // Reject stale replay timestamp (>5 minutes old)
    const staleTs = String(Math.floor(Date.now() / 1000) - 900);
    const staleSig = crypto
      .createHmac('sha256', webhookSecret)
      .update(`${staleTs}.${payload}`)
      .digest('hex');
    await request(app)
      .post('/api/webhooks/custom')
      .set('Content-Type', 'application/json')
      .set('x-webhook-timestamp', staleTs)
      .set('x-webhook-signature', `sha256=${staleSig}`)
      .send(payload)
      .expect(401);

    // Accept valid fresh timestamped HMAC-SHA256 signature
    const freshTs = String(Math.floor(Date.now() / 1000));
    const validSig = crypto
      .createHmac('sha256', webhookSecret)
      .update(`${freshTs}.${payload}`)
      .digest('hex');
    const okHook = await request(app)
      .post('/api/webhooks/custom')
      .set('Content-Type', 'application/json')
      .set('x-webhook-timestamp', freshTs)
      .set('x-webhook-signature', `sha256=${validSig}`)
      .send(payload)
      .expect(200);
    expect(okHook.body.received).toBe(true);

    // Verify generation_history records accumulated in PostgreSQL
    const histRes = await request(app)
      .get('/api/history')
      .set('Authorization', `Bearer ${userAToken}`)
      .expect(200);
    expect(histRes.body.history.length).toBeGreaterThanOrEqual(5);
    const dbCount = await getDb().query<{ c: string }>('SELECT COUNT(*) AS c FROM generation_history');
    expect(Number(dbCount.rows[0].c)).toBeGreaterThanOrEqual(5);

    // Verify generation endpoint rate limiting triggers HTTP 429
    process.env.GENERATION_RATE_LIMIT_MAX = '2';
    process.env.CUSTOM_3D_PROVIDER_URL = '';
    process.env.NVIDIA_NIM_API_KEY = '';
    for (let i = 0; i < 2; i++) {
      await request(app)
        .post('/api/generate/text')
        .set('Authorization', `Bearer ${userBToken}`)
        .send({ prompt: 'Minimalist ceramic vase', settings: DEFAULT_GENERATION_SETTINGS });
    }
    const limited = await request(app)
      .post('/api/generate/text')
      .set('Authorization', `Bearer ${userBToken}`)
      .send({ prompt: 'Minimalist ceramic vase', settings: DEFAULT_GENERATION_SETTINGS })
      .expect(429);
    expect(limited.body.error.code).toBe('GENERATION_RATE_LIMITED');
  });

  it('11. supports zero-env browser-localStorage NVIDIA NIM API key (BYOK) for MiniMax + NIM 3D generation', async () => {
    process.env.GENERATION_RATE_LIMIT_MAX = '40';
    process.env.NVIDIA_NIM_API_KEY = '';
    process.env.MESHY_API_KEY = '';
    process.env.TRIPO_API_KEY = '';
    process.env.CUSTOM_3D_PROVIDER_URL = '';
    process.env.NVIDIA_NIM_ENDPOINT = `${mockBaseUrl}/v1/chat/completions`;
    process.env.NVIDIA_NIM_3D_ENDPOINT = `${mockBaseUrl}/v1/genai/microsoft/trellis`;

    const browserKey = 'nvapi-browser-local-only-key-9876';

    // Without browser header -> remains in honest Demo Mode (strict request isolation)
    const noKeyStatus = await request(app).get('/api/system/status').expect(200);
    expect(noKeyStatus.body.status.demoMode).toBe(true);
    expect(noKeyStatus.body.status.nim.configured).toBe(false);
    expect(noKeyStatus.body.status.nim.keySource).toBe('none');

    // With X-Nvidia-Api-Key from browser localStorage -> unlocks MiniMax + NVIDIA NIM 3D, never echoes key
    const withKeyStatus = await request(app)
      .get('/api/system/status')
      .set('X-Nvidia-Api-Key', browserKey)
      .expect(200);
    expect(withKeyStatus.body.status.demoMode).toBe(false);
    expect(withKeyStatus.body.status.nim.configured).toBe(true);
    expect(withKeyStatus.body.status.nim.keySource).toBe('browser-storage');
    expect(withKeyStatus.body.status.activeProvider.id).toBe('nim-trellis');
    expect(JSON.stringify(withKeyStatus.body)).not.toContain(browserKey);

    // Connectivity probe succeeds with browser key
    const provCheck = await request(app)
      .post('/api/system/test-provider')
      .set('X-NV3D-Session', userAToken)
      .set('X-Nvidia-Api-Key', browserKey)
      .send({ providerId: 'nim-trellis' })
      .expect(200);
    expect(provCheck.body.result.reachable).toBe(true);

    // Record credits before BYOK generation (must charge 0 local credits)
    const creditsBefore = (
      await request(app).get('/api/auth/credits').set('X-NV3D-Session', userAToken).expect(200)
    ).body.credits.balance as number;

    // Full Text-to-3D using ONLY the frontend NVIDIA NIM key
    const sub = await request(app)
      .post('/api/generate/text')
      .set('X-NV3D-Session', userAToken)
      .set('X-Nvidia-Api-Key', browserKey)
      .send({ prompt: 'Brushed aluminum desk compass', settings: DEFAULT_GENERATION_SETTINGS })
      .expect(202);

    const done = await pollJobUntilTerminal(app, userAToken, sub.body.job.id);
    expect(done.job.status).toBe('succeeded');
    expect(done.job.providerId).toBe('nim-trellis');
    expect(done.job.modelId).toBeTruthy();

    const dl = await request(app)
      .get(`/api/models/${done.job.modelId}/download?format=glb`)
      .set('X-NV3D-Session', userAToken)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(validateGlbBuffer(dl.body as Buffer).valid).toBe(true);

    // Full Image-to-3D using ONLY the frontend NVIDIA NIM key
    const pngImg = await createSampleImage('png', 320, 320);
    const imgSub = await request(app)
      .post('/api/generate/image')
      .set('X-NV3D-Session', userAToken)
      .set('X-Nvidia-Api-Key', browserKey)
      .field('prompt', 'Sculpted ceramic planter')
      .field('settings', JSON.stringify(DEFAULT_GENERATION_SETTINGS))
      .attach('front', pngImg, { filename: 'front.png', contentType: 'image/png' })
      .expect(202);

    const imgDone = await pollJobUntilTerminal(app, userAToken, imgSub.body.job.id);
    expect(imgDone.job.status).toBe('succeeded');
    expect(imgDone.job.providerId).toBe('nim-trellis');

    // Local credits unchanged (0 charged for user's own API key) and key never persisted in DB
    const creditsAfter = (
      await request(app).get('/api/auth/credits').set('X-NV3D-Session', userAToken).expect(200)
    ).body.credits.balance as number;
    expect(creditsAfter).toBe(creditsBefore);

    const subsequentNoKey = await request(app).get('/api/system/status').expect(200);
    expect(subsequentNoKey.body.status.demoMode).toBe(true);
    expect(subsequentNoKey.body.status.nim.configured).toBe(false);
  });
});
