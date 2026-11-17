# NV3D Studio — API Documentation

All endpoints are served under `/api` and return JSON (except binary/streamed file endpoints). Authentication uses an `HttpOnly` session cookie (`nv3d_session`) or `Authorization: Bearer <jwt>`.

---

## Generation Endpoints

### `POST /api/generate/text`

Submits an asynchronous Text-to-3D generation job. Rate-limited per user.

**Request Body (`application/json`):**
```json
{
  "prompt": "Mid-century walnut lounge chair with charcoal boucle cushions and brass feet",
  "settings": {
    "category": "furniture",
    "style": "realistic-pbr",
    "quality": "standard",
    "polygonDetail": "medium",
    "textureResolution": "2k",
    "outputFormat": "glb",
    "pbr": true,
    "rigging": false,
    "animation": false,
    "optimizeSize": true
  }
}
```

**Responses:**
- `202 Accepted` — `{ "job": GenerationJobRecord }` (queued asynchronously; poll `/api/generate/:jobId`).
- `402 Payment Required` — `INSUFFICIENT_CREDITS`.
- `422 Unprocessable Entity` — `POLICY_VIOLATION` (weapons-free policy enforcement).
- `429 Too Many Requests` — `GENERATION_RATE_LIMITED`.
- `503 Service Unavailable` — `PROVIDER_NOT_CONFIGURED` (returned in Demo Mode with `{ demoMode: true, job }` and 0 credits deducted; never simulates fake generation).

---

### `POST /api/generate/image`

Submits an asynchronous Image-to-3D reconstruction job from one or more validated reference images.

**Request Body (`multipart/form-data`):**
- `front` (or `image`): Primary reference file (`image/png`, `image/jpeg`, or `image/webp`, verified by binary magic bytes and `sharp` decode).
- `side` *(optional)*: Side-angle reference image (submitted when provider supports multi-view).
- `back` *(optional)*: Back-angle reference image (submitted when provider supports multi-view).
- `prompt` *(optional)*: Reconstruction notes string.
- `settings` *(optional)*: JSON-serialized `GenerationSettings`.

**Responses:**
- `202 Accepted` — `{ "job": GenerationJobRecord }`.
- `400 Bad Request` — `MISSING_IMAGE`, `INVALID_IMAGE_TYPE`, `CORRUPT_IMAGE`, `IMAGE_TOO_SMALL`.
- `413 Payload Too Large` — `FILE_TOO_LARGE` / `IMAGE_TOO_LARGE`.
- `503 Service Unavailable` — `PROVIDER_NOT_CONFIGURED` (Demo Mode).

---

### `GET /api/generate/:jobId`

Retrieves live job status, progress percentage (`0–100`), stage label, structured MiniMax specification, uploaded image references, error info, and completed `modelId`. Restricted strictly to the owning user.

**Status Lifecycle:**
`queued` -> `enhancing` -> `submitting` -> `processing` -> `downloading` -> `optimizing` -> `validating` -> `succeeded` (or `failed` with automatic credit refund / `provider_unconfigured`).

---

## Model & GLB Export Endpoints

### `GET /api/models`

Lists the caller's models and (by default) the read-only Demo Sample GLB library.

**Query Parameters:**
- `includeDemo` (`true` | `false`, default `true`)
- `category` (`human` | `animal` | `car` | `building` | `furniture` | `prop` | `tree` | `environment`)
- `search` (substring match)

---

### `GET /api/models/:id`

Returns full metadata, geometry/material/animation statistics, bounding-box dimensions (meters), and Khronos binary GLB 2.0 validation report. Returns `403 FORBIDDEN` if owned by another user.

---

### `GET /api/models/:id/download`

Streams a genuine, validated 3D asset with exact `Content-Length` for client download progress tracking.

**Query Parameters:**
- `format`: `glb` *(default, `model/gltf-binary`)* or `gltf` *(self-contained glTF 2.0 JSON with embedded binary & texture buffers, `model/gltf+json`)*.

**Response Headers:**
- `Content-Type`: `model/gltf-binary` or `model/gltf+json; charset=utf-8`
- `Content-Length`: exact byte size
- `Content-Disposition`: `attachment; filename="<slug>.glb"`
- `X-Content-SHA256`: hex SHA-256 checksum
- `X-GLB-Validated`: `true`
- `X-NV3D-Demo-Asset`: `true` | `false`

---

### `DELETE /api/models/:id`

Deletes a user-owned model from `generated_models` and unlinks its GLB file from disk. Returns `403` for other users' models or protected demo samples.

---

### `POST /api/models/import`

Accepts `multipart/form-data` with field `file` (`.glb`) and optional `optimizeSize` (`true` | `false`). Validates the Khronos binary GLB 2.0 container, optionally welds/deduplicates geometry and compresses textures, stores privately under the user, and returns `201 Created` with `{ model }`.

### `POST /api/models/:id/validate`

Re-reads the stored GLB binary and executes full structural validation, returning `{ validationReport }`.

---

## NVIDIA NIM MiniMax M3.1 Flash AI Endpoints

Configured server-side via `NVIDIA_NIM_ENDPOINT` (`https://integrate.api.nvidia.com/v1/chat/completions`), `NVIDIA_NIM_MODEL` (`minimaxai/minimax-m3.1-flash`), and `NVIDIA_NIM_API_KEY`.

- `POST /api/ai/enhance` — `{ prompt, settings }` -> `{ spec: StructuredGenerationSpec }`. Returns `503 NIM_NOT_CONFIGURED` if `NVIDIA_NIM_API_KEY` is absent.
- `POST /api/ai/analyze-image` — `multipart/form-data` (`front`, optional `side`, `back`, `prompt`, `settings`) -> `{ spec: StructuredGenerationSpec }`.
- `POST /api/ai/assist` — `{ message, history?, context? }` -> `{ reply, modelId }`.
- `POST /api/ai/explain-error` — `{ errorCode, errorMessage, providerId? }` -> `{ diagnosis }`.

---

## Webhooks, Auth, History & System Diagnostics

- `POST /api/webhooks/:provider` (`meshy` | `tripo` | `custom`) — Validates raw JSON body using constant-time HMAC-SHA256 against `x-webhook-signature` (and optional `x-webhook-timestamp` replay window of 300 seconds).
- `POST /api/auth/register` — `{ email, password, displayName }` -> `{ user, token }` (upgrades active guest session seamlessly).
- `POST /api/auth/login` — `{ email, password }` -> `{ user, token }`.
- `POST /api/auth/logout` — clears session cookie.
- `GET /api/auth/me` — `{ user }`.
- `GET /api/auth/credits` — `{ credits }` from `user_credits`.
- `GET /api/history` — `{ history, jobs }` from `generation_history` and `generation_jobs`.
- `GET /api/system/status` — `{ status: SystemStatus }` (never exposes secret values).
- `POST /api/system/test-nim` — live connectivity check against NVIDIA NIM.
- `POST /api/system/test-provider` — `{ providerId? }` live connectivity check against 3D provider.
- `POST /api/system/provider` — `{ providerId }` switch active configured provider adapter.
