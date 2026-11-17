// ============================================================================
// Browser LocalStorage Manager for User-Supplied NVIDIA NIM API Key (BYOK)
// Stored exclusively in window.localStorage on the user's device.
// Never hardcoded, never persisted to any database or server disk.
// ============================================================================

export const NVIDIA_API_KEY_STORAGE_KEY = 'nv3d_nvidia_nim_api_key';
export const NVIDIA_SETTINGS_STORAGE_KEY = 'nv3d_nvidia_nim_settings';

export const DEFAULT_NIM_MODEL_ID = 'minimaxai/minimax-m3.1-flash';
export const DEFAULT_NIM_3D_ENDPOINT = 'https://ai.api.nvidia.com/v1/genai/microsoft/trellis';

export interface StoredNimSettings {
  modelId: string;
  nim3dEndpoint: string;
}

const listeners = new Set<() => void>();
let memoryKeyFallback = '';
let memorySettingsFallback: StoredNimSettings = {
  modelId: DEFAULT_NIM_MODEL_ID,
  nim3dEndpoint: DEFAULT_NIM_3D_ENDPOINT,
};

function notifyListeners(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // Ignore listener errors
    }
  }
}

export function getStoredNvidiaApiKey(): string {
  try {
    const val = window.localStorage.getItem(NVIDIA_API_KEY_STORAGE_KEY);
    return (val ?? memoryKeyFallback).trim();
  } catch {
    return memoryKeyFallback;
  }
}

export function setStoredNvidiaApiKey(rawKey: string): string {
  const cleaned = rawKey.trim().replace(/\s+/g, '');
  memoryKeyFallback = cleaned;
  try {
    if (cleaned) {
      window.localStorage.setItem(NVIDIA_API_KEY_STORAGE_KEY, cleaned);
    } else {
      window.localStorage.removeItem(NVIDIA_API_KEY_STORAGE_KEY);
    }
  } catch {
    // Restricted storage environment; in-memory fallback remains active
  }
  notifyListeners();
  return cleaned;
}

export function clearStoredNvidiaApiKey(): void {
  memoryKeyFallback = '';
  try {
    window.localStorage.removeItem(NVIDIA_API_KEY_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
  notifyListeners();
}

export function getStoredNimSettings(): StoredNimSettings {
  try {
    const raw = window.localStorage.getItem(NVIDIA_SETTINGS_STORAGE_KEY);
    if (!raw) return { ...memorySettingsFallback };
    const parsed = JSON.parse(raw) as Partial<StoredNimSettings>;
    return {
      modelId: (parsed.modelId || DEFAULT_NIM_MODEL_ID).trim() || DEFAULT_NIM_MODEL_ID,
      nim3dEndpoint:
        (parsed.nim3dEndpoint || DEFAULT_NIM_3D_ENDPOINT).trim().replace(/\/+$/, '') ||
        DEFAULT_NIM_3D_ENDPOINT,
    };
  } catch {
    return { ...memorySettingsFallback };
  }
}

export function setStoredNimSettings(next: Partial<StoredNimSettings>): StoredNimSettings {
  const current = getStoredNimSettings();
  const merged: StoredNimSettings = {
    modelId: (next.modelId ?? current.modelId).trim() || DEFAULT_NIM_MODEL_ID,
    nim3dEndpoint:
      (next.nim3dEndpoint ?? current.nim3dEndpoint).trim().replace(/\/+$/, '') ||
      DEFAULT_NIM_3D_ENDPOINT,
  };
  memorySettingsFallback = merged;
  try {
    const isDefault =
      merged.modelId === DEFAULT_NIM_MODEL_ID &&
      merged.nim3dEndpoint === DEFAULT_NIM_3D_ENDPOINT;
    if (isDefault) {
      window.localStorage.removeItem(NVIDIA_SETTINGS_STORAGE_KEY);
    } else {
      window.localStorage.setItem(NVIDIA_SETTINGS_STORAGE_KEY, JSON.stringify(merged));
    }
  } catch {
    // Ignore storage errors
  }
  notifyListeners();
  return merged;
}

export function maskNvidiaApiKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 10) return '••••••••';
  const prefix = trimmed.startsWith('nvapi-') ? 'nvapi-' : `${trimmed.slice(0, 4)}`;
  const suffix = trimmed.slice(-4);
  return `${prefix}••••${suffix}`;
}

export function subscribeNimKeyChanges(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (ev: StorageEvent) => {
    if (
      ev.key === null ||
      ev.key === NVIDIA_API_KEY_STORAGE_KEY ||
      ev.key === NVIDIA_SETTINGS_STORAGE_KEY
    ) {
      listener();
    }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage);
    }
  };
}
