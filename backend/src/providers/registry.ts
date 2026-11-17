import type { ProviderId, ProviderSummary } from '@nv3d/shared';
import { getConfig } from '../config/env.js';
import { AppError } from '../services/authService.js';
import { CustomHttpProviderAdapter } from './customHttpProvider.js';
import { MeshyProviderAdapter } from './meshyProvider.js';
import { NvidiaNim3DProviderAdapter } from './nvidiaNim3dProvider.js';
import { TripoProviderAdapter } from './tripoProvider.js';
import type { I3DGenerationProvider } from './types.js';

const providers = new Map<ProviderId, I3DGenerationProvider>();
providers.set('nim-trellis', new NvidiaNim3DProviderAdapter());
providers.set('meshy', new MeshyProviderAdapter());
providers.set('tripo', new TripoProviderAdapter());
providers.set('custom', new CustomHttpProviderAdapter());

let runtimePreferredProvider: ProviderId | null = null;

export function registerProviderAdapter(adapter: I3DGenerationProvider): void {
  providers.set(adapter.id, adapter);
}

export function getProviderById(id: string): I3DGenerationProvider | null {
  return providers.get(id as ProviderId) ?? null;
}

export function setRuntimePreferredProvider(id: ProviderId | null): I3DGenerationProvider | null {
  if (id === null) {
    runtimePreferredProvider = null;
    return getActiveProvider();
  }
  const adapter = providers.get(id);
  if (!adapter) {
    throw new AppError(400, 'UNKNOWN_PROVIDER', `Unknown 3D provider adapter "${id}".`);
  }
  if (!adapter.isConfigured()) {
    throw new AppError(
      400,
      'PROVIDER_NOT_CONFIGURED',
      `${adapter.displayName} cannot be activated because required credentials (${adapter.requiredEnvVars.join(', ')}) are not configured.`
    );
  }
  runtimePreferredProvider = id;
  return adapter;
}

/**
 * Resolve the currently active 3D generation provider adapter.
 * When a user supplies only their NVIDIA NIM API key (via frontend localStorage
 * or server env), `nim-trellis` automatically activates. Dedicated 3D provider keys
 * (`meshy`, `tripo`, `custom`) take precedence if configured.
 * Returns `null` when no credentials are set — entering honest Demo Mode.
 */
export function getActiveProvider(): I3DGenerationProvider | null {
  if (runtimePreferredProvider) {
    const preferred = providers.get(runtimePreferredProvider);
    if (preferred?.isConfigured()) return preferred;
  }

  const configuredChoice = getConfig().provider3d;
  if (configuredChoice === 'none' || configuredChoice === 'demo') {
    return null;
  }

  if (configuredChoice && configuredChoice !== 'auto') {
    const explicit = providers.get(configuredChoice as ProviderId);
    if (explicit?.isConfigured()) {
      return explicit;
    }
    return null;
  }

  // "auto": use explicit dedicated 3D adapter if set, otherwise NVIDIA NIM 3D with the user's NIM key
  for (const id of ['meshy', 'tripo', 'custom', 'nim-trellis'] as const) {
    const adapter = providers.get(id);
    if (adapter?.isConfigured()) {
      return adapter;
    }
  }
  return null;
}

export function listProviderSummaries(): ProviderSummary[] {
  const active = getActiveProvider();
  return Array.from(providers.values()).map((adapter) => ({
    id: adapter.id,
    displayName: adapter.displayName,
    configured: adapter.isConfigured(),
    active: active?.id === adapter.id,
    requiredEnvVars: adapter.requiredEnvVars,
    capabilities: adapter.capabilities,
  }));
}

export function getDemoModeInfo(): { demoMode: boolean; reason: string | null } {
  const active = getActiveProvider();
  if (active) {
    return { demoMode: false, reason: null };
  }
  const choice = getConfig().provider3d;
  if (choice === 'none' || choice === 'demo') {
    return {
      demoMode: true,
      reason: 'PROVIDER_3D is set to "none". Live 3D provider submission is disabled.',
    };
  }
  if (choice !== 'auto') {
    const adapter = getProviderById(choice);
    if (adapter) {
      return {
        demoMode: true,
        reason: `Selected provider "${adapter.displayName}" requires ${adapter.requiredEnvVars.join(', ')}.`,
      };
    }
  }
  return {
    demoMode: true,
    reason:
      'No NVIDIA NIM API key configured yet. Click "NVIDIA API Key" in the top bar to save your nvapi-... key locally in your browser (no login required), or explore the 8 validated Demo Sample GLB assets.',
  };
}
