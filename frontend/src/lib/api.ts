import type {
  AssetCategory,
  ConnectivityCheckResult,
  CreditLedgerEntry,
  GeneratedModelRecord,
  GenerationHistoryEntry,
  GenerationJobRecord,
  GenerationSettings,
  GlbValidationReport,
  ImageViewAngle,
  OutputFormat,
  ProviderId,
  ProviderSummary,
  StructuredGenerationSpec,
  SystemStatus,
  UserProfile,
} from '@nv3d/shared';

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly payload?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

const SESSION_TOKEN_KEY = 'nv3d_studio_session_token';
let memorySessionToken: string | null = null;

function getStoredSessionToken(): string | null {
  if (memorySessionToken) return memorySessionToken;
  try {
    memorySessionToken = window.sessionStorage.getItem(SESSION_TOKEN_KEY);
    return memorySessionToken;
  } catch {
    return null;
  }
}

export function setStoredSessionToken(token: string | null): void {
  memorySessionToken = token;
  try {
    if (token) window.sessionStorage.setItem(SESSION_TOKEN_KEY, token);
    else window.sessionStorage.removeItem(SESSION_TOKEN_KEY);
  } catch {
    // Ignore restricted storage contexts; in-memory token remains active
  }
}

export function attachAuthHeaders(headers: Headers): Headers {
  const tok = getStoredSessionToken();
  if (tok && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${tok}`);
  }
  return headers;
}

async function requestJson<T>(url: string, init: RequestInit = {}, retried = false): Promise<T> {
  const headers = attachAuthHeaders(new Headers(init.headers));
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('Accept', 'application/json');

  const res = await fetch(url, {
    ...init,
    headers,
    credentials: 'include',
  });

  const issuedSession = res.headers.get('x-nv3d-session');
  if (issuedSession) {
    setStoredSessionToken(issuedSession);
  }

  // If a cached session token expired (e.g. server restart in dev), clear and retry once cleanly
  if (res.status === 401 && !retried && getStoredSessionToken() && !url.startsWith('/api/auth/login')) {
    setStoredSessionToken(null);
    return requestJson<T>(url, init, true);
  }

  const text = await res.text();
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      if (!res.ok) {
        throw new ApiClientError(res.status, 'HTTP_ERROR', `Request failed with status ${res.status}`);
      }
    }
  }

  if (!res.ok) {
    const errObj = (data.error ?? {}) as { code?: string; message?: string };
    throw new ApiClientError(
      res.status,
      errObj.code || `HTTP_${res.status}`,
      errObj.message || `Request failed (${res.status})`,
      data
    );
  }

  return data as T;
}

export interface DownloadProgressState {
  loadedBytes: number;
  totalBytes: number;
  percent: number;
}

/**
 * Stream a validated GLB or GLTF file from `/api/models/:id/download`
 * with real byte-level progress tracking and trigger a genuine browser save.
 */
export async function downloadModelWithProgress(params: {
  modelId: string;
  format: OutputFormat;
  fallbackName: string;
  onProgress?: (state: DownloadProgressState) => void;
  signal?: AbortSignal;
}): Promise<{ filename: string; byteLength: number; sha256: string | null }> {
  const url = `/api/models/${encodeURIComponent(params.modelId)}/download?format=${encodeURIComponent(params.format)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: attachAuthHeaders(new Headers()),
    credentials: 'include',
    signal: params.signal,
  });

  if (!res.ok) {
    const errData = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    };
    throw new ApiClientError(
      res.status,
      errData.error?.code || 'DOWNLOAD_FAILED',
      errData.error?.message || `Download failed (HTTP ${res.status})`
    );
  }

  const totalBytes = Number.parseInt(res.headers.get('content-length') || '0', 10);
  const sha256 = res.headers.get('x-content-sha256');
  const contentType =
    res.headers.get('content-type') ||
    (params.format === 'gltf' ? 'model/gltf+json' : 'model/gltf-binary');

  const disposition = res.headers.get('content-disposition') || '';
  const nameMatch = disposition.match(/filename="?([^";]+)"?/i);
  const filename = nameMatch?.[1] || `${params.fallbackName}.${params.format}`;

  let blob: Blob;
  if (res.body) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loadedBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loadedBytes += value.byteLength;
        const percent =
          totalBytes > 0 ? Math.min(100, Math.round((loadedBytes / totalBytes) * 100)) : 50;
        params.onProgress?.({ loadedBytes, totalBytes: totalBytes || loadedBytes, percent });
      }
    }

    blob = new Blob(chunks as BlobPart[], { type: contentType });
    params.onProgress?.({ loadedBytes: blob.size, totalBytes: blob.size, percent: 100 });
  } else {
    blob = await res.blob();
    params.onProgress?.({ loadedBytes: blob.size, totalBytes: blob.size, percent: 100 });
  }

  if (blob.size === 0) {
    throw new ApiClientError(502, 'EMPTY_DOWNLOAD', 'Server returned an empty model binary.');
  }

  // Verify GLB magic bytes client-side when exporting GLB
  if (params.format === 'glb') {
    const header = new DataView(await blob.slice(0, 12).arrayBuffer());
    if (blob.size < 20 || header.getUint32(0, true) !== 0x46546c67) {
      throw new ApiClientError(422, 'INVALID_GLB_HEADER', 'Downloaded binary failed GLB header verification.');
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
  }

  return { filename, byteLength: blob.size, sha256 };
}

export const api = {
  // System & Diagnostics
  getSystemStatus: () => requestJson<{ status: SystemStatus }>('/api/system/status'),
  testNimConnectivity: () =>
    requestJson<{ result: ConnectivityCheckResult }>('/api/system/test-nim', { method: 'POST' }),
  testProviderConnectivity: (providerId?: ProviderId) =>
    requestJson<{ result: ConnectivityCheckResult }>('/api/system/test-provider', {
      method: 'POST',
      body: JSON.stringify(providerId ? { providerId } : {}),
    }),
  selectProvider: (providerId: ProviderId | null) =>
    requestJson<{
      activeProvider: ProviderSummary | null;
      providers: ProviderSummary[];
      demoMode: boolean;
      demoReason: string | null;
    }>('/api/system/provider', {
      method: 'POST',
      body: JSON.stringify({ providerId }),
    }),

  // Authentication & Credits
  getMe: () => requestJson<{ user: UserProfile }>('/api/auth/me'),
  getCredits: () => requestJson<{ credits: CreditLedgerEntry }>('/api/auth/credits'),
  register: async (payload: { email: string; password: string; displayName: string }) => {
    const out = await requestJson<{ user: UserProfile; token: string }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    setStoredSessionToken(out.token);
    return out;
  },
  login: async (payload: { email: string; password: string }) => {
    const out = await requestJson<{ user: UserProfile; token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    setStoredSessionToken(out.token);
    return out;
  },
  logout: async () => {
    const out = await requestJson<{ loggedOut: boolean }>('/api/auth/logout', { method: 'POST' });
    setStoredSessionToken(null);
    return out;
  },

  // Text-to-3D & Image-to-3D Generation
  generateFromText: (prompt: string, settings: GenerationSettings) =>
    requestJson<{ job: GenerationJobRecord }>('/api/generate/text', {
      method: 'POST',
      body: JSON.stringify({ prompt, settings }),
    }),

  generateFromImages: (params: {
    files: Partial<Record<ImageViewAngle, File>>;
    prompt?: string;
    settings: GenerationSettings;
  }) => {
    const form = new FormData();
    if (params.files.front) form.append('front', params.files.front);
    if (params.files.side) form.append('side', params.files.side);
    if (params.files.back) form.append('back', params.files.back);
    if (params.prompt?.trim()) form.append('prompt', params.prompt.trim());
    form.append('settings', JSON.stringify(params.settings));
    return requestJson<{ job: GenerationJobRecord }>('/api/generate/image', {
      method: 'POST',
      body: form,
    });
  },

  getJob: (jobId: string) =>
    requestJson<{ job: GenerationJobRecord }>(`/api/generate/${encodeURIComponent(jobId)}`),

  listJobs: () => requestJson<{ jobs: GenerationJobRecord[] }>('/api/generate'),

  // Models & GLB Validation/Import
  listModels: (params?: { includeDemo?: boolean; category?: AssetCategory; search?: string }) => {
    const qs = new URLSearchParams();
    if (params?.includeDemo !== undefined) qs.set('includeDemo', String(params.includeDemo));
    if (params?.category) qs.set('category', params.category);
    if (params?.search) qs.set('search', params.search);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return requestJson<{ models: GeneratedModelRecord[] }>(`/api/models${suffix}`);
  },

  getModel: (id: string) =>
    requestJson<{ model: GeneratedModelRecord }>(`/api/models/${encodeURIComponent(id)}`),

  validateModel: (id: string) =>
    requestJson<{ validationReport: GlbValidationReport }>(
      `/api/models/${encodeURIComponent(id)}/validate`,
      { method: 'POST' }
    ),

  importGlb: (file: File, optimizeSize = false) => {
    const form = new FormData();
    form.append('file', file);
    form.append('optimizeSize', String(optimizeSize));
    return requestJson<{ model: GeneratedModelRecord }>('/api/models/import', {
      method: 'POST',
      body: form,
    });
  },

  deleteModel: (id: string) =>
    requestJson<{ deleted: boolean; id: string }>(`/api/models/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  // NVIDIA NIM MiniMax M3.1 Flash AI Assistant
  enhancePrompt: (prompt: string, settings: GenerationSettings) =>
    requestJson<{ spec: StructuredGenerationSpec }>('/api/ai/enhance', {
      method: 'POST',
      body: JSON.stringify({ prompt, settings }),
    }),

  analyzeReferenceImages: (params: {
    files: Partial<Record<ImageViewAngle, File>>;
    prompt?: string;
    settings: GenerationSettings;
  }) => {
    const form = new FormData();
    if (params.files.front) form.append('front', params.files.front);
    if (params.files.side) form.append('side', params.files.side);
    if (params.files.back) form.append('back', params.files.back);
    if (params.prompt?.trim()) form.append('prompt', params.prompt.trim());
    form.append('settings', JSON.stringify(params.settings));
    return requestJson<{ spec: StructuredGenerationSpec }>('/api/ai/analyze-image', {
      method: 'POST',
      body: form,
    });
  },

  chatAssistant: (params: {
    message: string;
    history?: Array<{ role: 'user' | 'assistant'; content: string }>;
    context?: {
      currentPrompt?: string;
      mode?: string;
      activeModelName?: string;
      lastError?: string;
      settings?: Partial<GenerationSettings>;
    };
  }) =>
    requestJson<{ reply: string; modelId: string }>('/api/ai/assist', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  explainError: (params: { errorCode: string; errorMessage: string; providerId?: string | null }) =>
    requestJson<{
      diagnosis: {
        source: 'nvidia-nim-minimax' | 'system-diagnostic';
        modelId: string | null;
        explanation: string;
        recommendedActions: string[];
      };
    }>('/api/ai/explain-error', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  // History
  getHistory: (limit = 60) =>
    requestJson<{ history: GenerationHistoryEntry[]; jobs: GenerationJobRecord[] }>(
      `/api/history?limit=${limit}`
    ),
};
