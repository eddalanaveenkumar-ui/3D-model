import { useEffect, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RotateCcw,
  ShieldCheck,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import type { ConnectivityCheckResult } from '@nv3d/shared';
import { api, ApiClientError } from '../../lib/api';
import {
  clearStoredNvidiaApiKey,
  DEFAULT_NIM_3D_ENDPOINT,
  DEFAULT_NIM_MODEL_ID,
  getStoredNimSettings,
  getStoredNvidiaApiKey,
  maskNvidiaApiKey,
  NVIDIA_API_KEY_STORAGE_KEY,
  setStoredNimSettings,
  setStoredNvidiaApiKey,
} from '../../lib/nimKeyStore';

interface ApiKeyModalProps {
  open: boolean;
  onClose: () => void;
  onKeyUpdated: () => Promise<void>;
}

const NIM_3D_PRESETS = [
  {
    label: 'TRELLIS (Text + Image)',
    url: 'https://ai.api.nvidia.com/v1/genai/microsoft/trellis',
  },
  {
    label: 'Stable Fast 3D (Image)',
    url: 'https://ai.api.nvidia.com/v1/genai/stabilityai/stable-fast-3d',
  },
] as const;

export function ApiKeyModal({ open, onClose, onKeyUpdated }: ApiKeyModalProps) {
  const [savedKey, setSavedKey] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [revealKey, setRevealKey] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [modelId, setModelId] = useState(DEFAULT_NIM_MODEL_ID);
  const [nim3dEndpoint, setNim3dEndpoint] = useState(DEFAULT_NIM_3D_ENDPOINT);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [nimResult, setNimResult] = useState<ConnectivityCheckResult | null>(null);
  const [nim3dResult, setNim3dResult] = useState<ConnectivityCheckResult | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const currentKey = getStoredNvidiaApiKey();
    const currentSettings = getStoredNimSettings();
    setSavedKey(currentKey);
    setKeyInput(currentKey);
    setModelId(currentSettings.modelId);
    setNim3dEndpoint(currentSettings.nim3dEndpoint);
    setRevealKey(false);
    setError(null);
    setFeedback(null);
    setNimResult(null);
    setNim3dResult(null);
  }, [open]);

  if (!open) return null;

  const persistInputs = (): string => {
    const trimmed = keyInput.trim();
    if (trimmed.length < 8) {
      throw new Error('Enter a valid NVIDIA NIM API key (starts with nvapi-...).');
    }
    if (!/^[\x21-\x7E]+$/.test(trimmed)) {
      throw new Error('API key must not contain spaces or non-ASCII characters.');
    }
    const stored = setStoredNvidiaApiKey(trimmed);
    setStoredNimSettings({
      modelId: modelId.trim() || DEFAULT_NIM_MODEL_ID,
      nim3dEndpoint: nim3dEndpoint.trim() || DEFAULT_NIM_3D_ENDPOINT,
    });
    setSavedKey(stored);
    setKeyInput(stored);
    return stored;
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFeedback(null);
    setSaving(true);
    try {
      persistInputs();
      await onKeyUpdated();
      setFeedback('Saved to browser localStorage. Ready for AI orchestration and 3D generation.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save API key.');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAndTest = async () => {
    setError(null);
    setFeedback(null);
    setNimResult(null);
    setNim3dResult(null);
    setTesting(true);
    try {
      persistInputs();
      await onKeyUpdated();
      const [nimRes, provRes] = await Promise.all([
        api.testNimConnectivity(),
        api.testProviderConnectivity('nim-trellis'),
      ]);
      setNimResult(nimRes.result);
      setNim3dResult(provRes.result);
    } catch (err) {
      setError(
        err instanceof ApiClientError || err instanceof Error
          ? err.message
          : 'Connectivity test failed.'
      );
    } finally {
      setTesting(false);
    }
  };

  const handleClear = async () => {
    clearStoredNvidiaApiKey();
    setSavedKey('');
    setKeyInput('');
    setNimResult(null);
    setNim3dResult(null);
    setError(null);
    setFeedback('Removed NVIDIA NIM API key from browser localStorage.');
    await onKeyUpdated().catch(() => undefined);
  };

  const handleResetDefaults = () => {
    setModelId(DEFAULT_NIM_MODEL_ID);
    setNim3dEndpoint(DEFAULT_NIM_3D_ENDPOINT);
    setStoredNimSettings({
      modelId: DEFAULT_NIM_MODEL_ID,
      nim3dEndpoint: DEFAULT_NIM_3D_ENDPOINT,
    });
    void onKeyUpdated().catch(() => undefined);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="nim-key-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-2xl border border-[#242e42] bg-[#111520] shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-[#1d2536] px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#76b900]/35 bg-[#76b900]/12 text-[#8ed90b]">
              <KeyRound className="h-4 w-4" />
            </span>
            <div>
              <h2 id="nim-key-modal-title" className="text-sm font-semibold text-white">
                NVIDIA NIM API Key
              </h2>
              <p className="text-[11px] text-[#8d97ab]">
                No sign-up or login required · Saved only in your browser localStorage
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close API key dialog"
            className="rounded-lg p-1.5 text-[#838ea4] transition hover:bg-[#1a2232] hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={(e) => void handleSave(e)} className="space-y-4 p-5">
          {/* Current Status Strip */}
          <div className="flex items-center justify-between gap-2 rounded-xl border border-[#1d2536] bg-[#0b0f17] px-3.5 py-2.5 text-xs">
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  savedKey ? 'bg-[#8ed90b]' : 'bg-amber-400'
                }`}
              />
              <span className="font-medium text-[#dfe5f0]">
                {savedKey ? `Saved: ${maskNvidiaApiKey(savedKey)}` : 'No API key saved in browser'}
              </span>
            </div>
            <a
              href="https://build.nvidia.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] font-medium text-[#a3e635] transition hover:underline"
            >
              <span>Get Key at build.nvidia.com</span>
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>

          {/* API Key Input */}
          <div>
            <label
              htmlFor="nvidia-nim-key-input"
              className="mb-1.5 block text-xs font-medium text-[#cfd6e4]"
            >
              NVIDIA NIM API Key
            </label>
            <div className="relative">
              <input
                id="nvidia-nim-key-input"
                type={revealKey ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder="nvapi-..."
                className="w-full rounded-xl border border-[#283248] bg-[#0b0e15] py-2.5 pr-10 pl-3.5 font-mono-tech text-xs text-white placeholder-[#5c677d] transition focus:border-[#8ed90b] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setRevealKey((v) => !v)}
                aria-label={revealKey ? 'Hide API key' : 'Show API key'}
                className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-md p-1 text-[#7e899f] transition hover:text-white"
              >
                {revealKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
            <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-[#7e899f]">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#8ed90b]" />
              <span>
                Stored locally under{' '}
                <code className="font-mono-tech text-[#b9c3d6]">{NVIDIA_API_KEY_STORAGE_KEY}</code>.
                Powers MiniMax M3.1 Flash prompt/vision orchestration and NVIDIA NIM 3D (TRELLIS)
                without saving your key on the server.
              </span>
            </p>
          </div>

          {/* Collapsible Advanced Endpoints */}
          <div className="rounded-xl border border-[#1d2536] bg-[#0c1018]">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="flex w-full items-center justify-between px-3.5 py-2.5 text-left text-[11px] font-medium text-[#aeb8cb] transition hover:text-white"
            >
              <span>Advanced NVIDIA NIM Endpoints (Optional)</span>
              {advancedOpen ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </button>

            {advancedOpen && (
              <div className="space-y-3 border-t border-[#1d2536] px-3.5 py-3">
                <div>
                  <label
                    htmlFor="nim-model-id-input"
                    className="mb-1 block text-[11px] font-medium text-[#b9c3d6]"
                  >
                    Orchestration Model ID (integrate.api.nvidia.com)
                  </label>
                  <input
                    id="nim-model-id-input"
                    type="text"
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                    placeholder={DEFAULT_NIM_MODEL_ID}
                    className="w-full rounded-lg border border-[#263046] bg-[#090c12] px-3 py-2 font-mono-tech text-[11px] text-white focus:border-[#8ed90b] focus:outline-none"
                  />
                </div>

                <div>
                  <label
                    htmlFor="nim-3d-endpoint-input"
                    className="mb-1 block text-[11px] font-medium text-[#b9c3d6]"
                  >
                    NVIDIA NIM 3D Mesh Endpoint
                  </label>
                  <input
                    id="nim-3d-endpoint-input"
                    type="url"
                    value={nim3dEndpoint}
                    onChange={(e) => setNim3dEndpoint(e.target.value)}
                    placeholder={DEFAULT_NIM_3D_ENDPOINT}
                    className="w-full rounded-lg border border-[#263046] bg-[#090c12] px-3 py-2 font-mono-tech text-[11px] text-white focus:border-[#8ed90b] focus:outline-none"
                  />
                  <div className="mt-1.5 flex flex-wrap items-center justify-between gap-1.5">
                    <div className="flex flex-wrap gap-1.5">
                      {NIM_3D_PRESETS.map((preset) => (
                        <button
                          key={preset.url}
                          type="button"
                          onClick={() => setNim3dEndpoint(preset.url)}
                          className={`rounded-md border px-2 py-0.5 text-[10px] font-medium transition ${
                            nim3dEndpoint === preset.url
                              ? 'border-[#76b900]/50 bg-[#76b900]/15 text-[#a3e635]'
                              : 'border-[#252f44] bg-[#131824] text-[#9aa4b8] hover:text-white'
                          }`}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={handleResetDefaults}
                      className="inline-flex items-center gap-1 text-[10px] text-[#838ea4] transition hover:text-white"
                    >
                      <RotateCcw className="h-3 w-3" />
                      <span>Reset defaults</span>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Feedback / Error / Test Diagnostics */}
          {error && (
            <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-200">
              {error}
            </div>
          )}

          {feedback && (
            <div className="flex items-center gap-2 rounded-xl border border-[#76b900]/35 bg-[#76b900]/10 px-3.5 py-2.5 text-xs text-[#d8f3a2]">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-[#8ed90b]" />
              <span>{feedback}</span>
            </div>
          )}

          {(nimResult || nim3dResult) && (
            <div className="space-y-2">
              {[nimResult, nim3dResult].filter(Boolean).map((res) => (
                <div
                  key={res!.service}
                  className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-[11px] ${
                    res!.reachable
                      ? 'border-[#76b900]/35 bg-[#76b900]/10 text-[#d8f3a2]'
                      : 'border-amber-500/35 bg-amber-500/10 text-amber-200'
                  }`}
                >
                  {res!.reachable ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#8ed90b]" />
                  ) : (
                    <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                  )}
                  <div>
                    <p className="font-semibold">{res!.service}</p>
                    <p className="opacity-90">{res!.message}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            {savedKey ? (
              <button
                type="button"
                onClick={() => void handleClear()}
                className="inline-flex items-center gap-1.5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs font-medium text-rose-300 transition hover:bg-rose-500/20"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Clear Key</span>
              </button>
            ) : (
              <span />
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={testing || saving || !keyInput.trim()}
                onClick={() => void handleSaveAndTest()}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[#2c374e] bg-[#161c2a] px-3.5 py-2 text-xs font-medium text-white transition hover:border-[#8ed90b] disabled:opacity-50"
              >
                {testing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-[#8ed90b]" />
                ) : (
                  <Activity className="h-3.5 w-3.5 text-[#8ed90b]" />
                )}
                <span>Save & Test</span>
              </button>

              <button
                type="submit"
                disabled={saving || testing || !keyInput.trim()}
                className="inline-flex items-center gap-1.5 rounded-xl bg-[#76b900] px-4 py-2 text-xs font-semibold text-[#080d03] transition hover:bg-[#8ed90b] disabled:opacity-50"
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <span>Save Key</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
