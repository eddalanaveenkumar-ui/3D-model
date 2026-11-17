# NV3D Studio

**NV3D Studio** is a full-stack AI-powered 3D asset generation, inspection, and GLB 2.0 export platform built with **React + TypeScript + Three.js** on the frontend, **Node.js + Express + TypeScript** on the backend, **PostgreSQL / Supabase** persistence, and **NVIDIA NIM (`minimaxai/minimax-m3.1-flash`)** orchestration.

---

## Architecture Overview

```
Browser (React 19 + Vite + Tailwind v4 + Lazy Three.js / GLTFLoader / OrbitControls)
   |
   |  Relative REST + Streaming GLB/GLTF Downloads (/api/*)
   v
Express Backend (TypeScript, Helmet CSP, Rate Limiters, JWT/Cookie Auth)
   |
   +--> NVIDIA NIM Orchestration Service (backend/src/services/nvidiaNimService.ts)
   |      Endpoint: https://integrate.api.nvidia.com/v1/chat/completions
   |      Model ID: minimaxai/minimax-m3.1-flash
   |      Role: Prompt enhancement, multimodal reference image analysis,
   |            structured JSON 3D generation specs, workflow assistance & error diagnosis.
   |            (Never assumed to generate raw 3D meshes; API key stays strictly server-side.)
   |
   +--> Replaceable 3D Generation Provider Registry (backend/src/providers/)
   |      - MeshyProviderAdapter      (Text-to-3D, Image-to-3D, Front/Side/Back Multi-View)
   |      - TripoProviderAdapter      (Text-to-3D, Image-to-3D, Multi-View, PBR, Rigging, Animation)
   |      - CustomHttpProviderAdapter (Self-hosted/enterprise TRELLIS, Hunyuan3D-2, Rodin, Edify 3D)
   |      - Explicit Demo Mode when unconfigured (never fakes or simulates AI mesh synthesis)
   |
   +--> Asset Pipeline Services (backend/src/services/)
   |      - imageUploadService        (Magic-byte PNG/JPG/WEBP check, sharp decode, EXIF strip)
   |      - jobManagerService         (Async background submission, status polling, webhook handler, credit refund)
   |      - glbOptimizationService    (@gltf-transform weld/dedup/prune, meshoptimizer, sharp texture compression, GLTF export)
   |      - glbValidationService      (Binary glTF 2.0 magic/chunk/accessor/bounds/UV/PBR/animation validator)
   |      - glbStorageService         (Path-traversal-safe, SHA-256 checksummed, user-isolated private storage)
   |      - demoAssetService          (8 genuine binary-validated Demo Sample GLBs across all categories)
   |
   +--> PostgreSQL / Supabase Database (backend/src/db/, supabase/migrations/)
          Tables: users, user_credits, generation_jobs, generated_models,
                  uploaded_images, generation_history
```

### Honest Demo Mode Behavior

When no 3D provider credentials (`MESHY_API_KEY`, `TRIPO_API_KEY`, or `CUSTOM_3D_PROVIDER_URL`) are present in `.env`, NV3D Studio enters **Demo Mode**:

- The UI clearly displays a **Demo Mode** status badge and setup banner.
- Generation submissions never pretend to synthesize a cloud 3D model and never deduct credits; they record `provider_unconfigured`, return the structured generation specification, and explain how to enable a live adapter.
- Users can immediately test the full Three.js PBR viewport, orbit/zoom/pan controls, lighting rig, wireframe inspection, mesh statistics, Khronos binary GLB validator, local `.glb` imports, and genuine streaming `.glb` / `.gltf` downloads using 8 built-in, explicitly labeled **Demo Sample GLB** assets covering humans, animals, cars, buildings, furniture, weapons-free props, trees, and environments.

---

## Project Structure

```
3D-model/
├── package.json                       # npm workspace root (dev, build, start, test, db:migrate)
├── tsconfig.base.json                 # Shared strict TypeScript config
├── .env.example                       # Server-side environment variable template
├── docs/
│   └── API.md                         # Complete REST API & Webhook specification
├── supabase/
│   └── migrations/
│       └── 001_initial_schema.sql     # Supabase / PostgreSQL DDL + indexes + RLS policies
├── shared/                            # @nv3d/shared — TypeScript types, settings, credit calculator
│   └── src/index.ts
├── backend/                           # @nv3d/backend — Express API, NIM service, 3D adapters, DB
│   └── src/
│       ├── app.ts                     # Express setup, Helmet CSP, CORS, rate limiters, static SPA
│       ├── index.ts                   # Server entrypoint (binds 0.0.0.0)
│       ├── config/env.ts              # Typed environment configuration
│       ├── db/                        # PostgreSQL (pg.Pool) + embedded PGlite driver & schema
│       ├── middleware/                # Auth, rate limiting, structured error handling
│       ├── providers/                 # I3DGenerationProvider + Meshy, Tripo3D, Custom HTTP, Registry
│       ├── services/                  # NIM, Upload, Jobs, GLB Storage/Validation/Optimization, Auth, History
│       ├── routes/                    # /api/generate, /api/models, /api/ai, /api/auth, /api/history, /api/system, /api/webhooks
│       └── __tests__/                 # End-to-end Vitest + Supertest verification suites
└── frontend/                          # @nv3d/frontend — React 19 + Vite + Tailwind v4 + Three.js
    └── src/
        ├── App.tsx                    # Responsive creative studio shell & async job polling
        ├── lib/                       # Typed API client with streaming download progress & formatters
        └── components/
            ├── layout/                # BrandLogo, TopNav, LeftSidebar
            ├── create/                # CreatePanel, ImageDropSlot, JobStatusCard
            ├── viewer/                # Lazy-loaded ThreeViewport (GLTFLoader, OrbitControls, IBL, lighting)
            ├── inspector/             # RightInspector (Properties, GLB/GLTF Export) & AiAssistantPanel
            ├── views/                 # HomeView, MyModelsView, HistoryView, SettingsView
            └── auth/                  # AuthModal (Register, Sign In, Account & Credits)
```

---

## Quick Start

### 1. Prerequisites

- **Node.js 20+** and **npm 10+**
- **PostgreSQL 14+ or Supabase** (optional for local development: when `DATABASE_URL` is omitted, NV3D Studio automatically boots a persistent embedded PostgreSQL 16 instance via `@electric-sql/pglite` in `.data/pgdata`)

### 2. Install & Configure

```bash
npm install
cp .env.example .env
```

Edit `.env` on the server to enable live AI orchestration and 3D synthesis:

```env
# NVIDIA NIM MiniMax M3.1 Flash (server-side only)
NVIDIA_NIM_ENDPOINT=https://integrate.api.nvidia.com/v1/chat/completions
NVIDIA_NIM_MODEL=minimaxai/minimax-m3.1-flash
NVIDIA_NIM_API_KEY=<your-nvidia-nim-api-key>

# Configure one or more 3D generation providers (auto selects first configured)
PROVIDER_3D=auto
MESHY_API_KEY=<your-meshy-api-key>
TRIPO_API_KEY=<your-tripo-api-key>
CUSTOM_3D_PROVIDER_URL=<optional-self-hosted-3d-endpoint>

# Production PostgreSQL or Supabase connection string
DATABASE_URL=<optional-postgresql-or-supabase-url>
JWT_SECRET=<at-least-32-random-characters-for-production>
```

### 3. Run Database Migration

```bash
npm run db:migrate
```

For Supabase projects, you can either point `DATABASE_URL` at your Supabase connection string and run `npm run db:migrate`, or execute `supabase/migrations/001_initial_schema.sql` in the Supabase SQL Editor (which also enables Row-Level Security policies).

### 4. Start in Development Mode

```bash
npm run dev
```

- Frontend Vite dev server: `http://0.0.0.0:5173` (proxies `/api` to backend)
- Backend Express API: `http://0.0.0.0:3001`

### 5. Build & Run Unified Production Server

```bash
npm run build
npm run start
```

Serves both the optimized, code-split React + Three.js studio and `/api/*` on `http://0.0.0.0:3001`.

### 6. Deploy on Vercel

The repository includes `vercel.json` and the `api/index.js` serverless entrypoint (`backend/src/serverless.ts`):

- Static React + Three.js bundle is served from `frontend/dist` on Vercel's CDN.
- All `/api/*` endpoints route to `api/index.js` with serverless-safe `/tmp` scratch paths, cold-start Demo Sample GLB auto-recovery, and request-driven + webhook-driven 3D job progression.
- Configure these server-side Environment Variables in Vercel Project Settings:
  - `JWT_SECRET` — at least 32 random characters (`openssl rand -hex 32`)
  - `DATABASE_URL` and `DATABASE_SSL=true` — Supabase (transaction/session pooler) or managed PostgreSQL URL
  - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_STORAGE_BUCKET=nv3d-assets` — recommended for durable multi-instance storage of generated/imported GLBs and uploaded reference images
  - `NVIDIA_NIM_API_KEY` (plus `NVIDIA_NIM_MODEL=minimaxai/minimax-m3.1-flash`) — enables live MiniMax M3.1 Flash orchestration
  - `PROVIDER_3D=auto` and one of `MESHY_API_KEY`, `TRIPO_API_KEY`, or `CUSTOM_3D_PROVIDER_URL` — enables live Text-to-3D and Image-to-3D synthesis
  - Note: Vercel Serverless Functions enforce a ~4.5 MB request body ceiling, so `MAX_UPLOAD_MB` and `MAX_GLB_IMPORT_MB` default to `4` when `VERCEL` is detected.

### 7. Run Typecheck & Automated Tests

```bash
npm run typecheck
npm test
```

---

## Adding or Replacing a 3D Provider Adapter

1. Implement `I3DGenerationProvider` from `backend/src/providers/types.ts` (`isConfigured`, `checkConnectivity`, `submitTextTo3D`, `submitImageTo3D`, `getJobStatus`, `downloadGlb`, `verifyWebhookSignature`, `parseWebhookPayload`).
2. Register the adapter with `registerProviderAdapter(new YourProvider())` in `backend/src/providers/registry.ts` — or connect any internal HTTP service directly via `CUSTOM_3D_PROVIDER_URL` with zero code changes.

---

## Core API Summary

See [`docs/API.md`](./docs/API.md) for full request/response schemas and status codes.

| Method | Route | Description |
| --- | --- | --- |
| `POST` | `/api/generate/text` | Submit async Text-to-3D job (MiniMax enhancement + provider submission) |
| `POST` | `/api/generate/image` | Submit async Image-to-3D job (PNG/JPG/WEBP; `front`, optional `side` & `back`) |
| `GET` | `/api/generate/:jobId` | Poll job status, progress, structured spec, errors, and resulting `modelId` |
| `GET` | `/api/models` | List user-owned models and optional Demo Sample GLBs |
| `GET` | `/api/models/:id` | Get model details, statistics (vertices, triangles, materials, dimensions), and validation report |
| `GET` | `/api/models/:id/download` | Stream genuine validated `.glb` (`?format=glb`) or `.gltf` (`?format=gltf`) |
| `DELETE` | `/api/models/:id` | Delete a user-owned model and remove its binary file from storage |
| `POST` | `/api/models/import` | Upload, validate, and optionally optimize a local `.glb` model |
| `POST` | `/api/models/:id/validate` | Re-run binary Khronos glTF 2.0 validation on a stored model |
| `POST` | `/api/ai/enhance` | Enhance & structure a text prompt with NVIDIA NIM MiniMax M3.1 Flash |
| `POST` | `/api/ai/analyze-image` | Analyze uploaded reference image(s) via NVIDIA NIM |
| `POST` | `/api/ai/assist` | Interactive MiniMax M3.1 Flash 3D generation assistant |
| `POST` | `/api/ai/explain-error` | Diagnose generation or validation failures |
| `POST` | `/api/webhooks/:provider` | HMAC-SHA256 signature-verified provider job webhook receiver |
| `GET` | `/api/system/status` | Retrieve Demo Mode status, provider capabilities, DB tables, and limits |
| `POST` | `/api/system/test-nim` | Live connectivity test to NVIDIA NIM MiniMax M3.1 Flash |
| `POST` | `/api/system/test-provider` | Live connectivity test to configured 3D provider adapter |

---

## Security Controls

- **Server-side credentials**: `NVIDIA_NIM_API_KEY`, `MESHY_API_KEY`, `TRIPO_API_KEY`, `CUSTOM_3D_PROVIDER_API_KEY`, `DATABASE_URL`, and `JWT_SECRET` live solely in Node.js and are never sent to browser JavaScript.
- **Upload verification**: Reference images are inspected by magic bytes (`PNG`, `JPEG`, `WEBP`), size-limited, pixel-decoded and re-encoded via `sharp` (stripping EXIF metadata and neutralizing polyglot files). GLB imports are binary-validated and blocked if external URIs are present.
- **Per-user isolation**: Uploaded images, jobs, models, downloads, and deletions enforce `user_id` ownership checks; files are stored with random UUID keys inside path-traversal-guarded storage outside static web roots.
- **Abuse & replay protection**: Generation, auth, and API endpoints are rate-limited; provider webhooks enforce constant-time `crypto.timingSafeEqual` HMAC-SHA256 verification and 5-minute timestamp skew checks.
- **XSS & content safety**: Strict Helmet Content-Security-Policy, `X-Content-Type-Options: nosniff`, server-side HTML/script sanitization, and weapons-free prompt policy enforcement.
