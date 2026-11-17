import { useEffect, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Cpu,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RotateCcw,
  Server,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react';
import type { ConnectivityCheckResult, ProviderId, SystemStatus } from '@nv3d/shared';
import { api, ApiClientError } from '../../lib/api';
import {
  clearStoredNvidiaApiKey,
  DEFAULT_NIM_3D_ENDPOINT,
  DEFAULT_NIM_MODEL_ID,
  getStoredNimSettings,
  maskNvidiaApiKey,
  NVIDIA_API_KEY_STORAGE_KEY,
  setStoredNimSettings,
  setStoredNvidiaApiKey,
} from '../../lib/nimKeyStore';

interface SettingsViewProps {
  systemStatus: SystemStatus | null;
  storedNimKey: string;
  onRefreshStatus: () => Promise<void>;
}

export function SettingsView({
  systemStatus,
  storedNimKey,
  onRefreshStatus,
}: SettingsViewProps) {
  const [keyInput, setKeyInput] = useState(storedNimKey);
  const [revealKey, setRevealKey] = useState(false);
  const [modelId, setModelId] = useState(() => getStoredNimSettings().modelId);
  const [nim3dEndpoint, setNim3dEndpoint] = useState(() => getStoredNimSettings().nim3dEndpoint);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  const [nimCheck, setNimCheck] = useState<ConnectivityCheckResult | null>(null);
  const [testingNim, setTestingNim] = useState(false);
  const [providerChecks, setProviderChecks] = useState<
    Partial<Record<ProviderId, ConnectivityCheckResult>>
  >({});
  const [testingProvider, setTestingProvider] = useState<ProviderId | null>(null);
  const [switchingProvider, setSwitchingProvider] = useState<ProviderId | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    setKeyInput(storedNimKey);
    const s = getStoredNimSettings();
    setModelId(s.modelId);
    setNim3dEndpoint(s.nim3dEndpoint);
  }, [storedNimKey]);

  const handleSaveBrowserKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSaveNotice(null);
    const cleaned = keyInput.trim();
    if (cleaned.length < 8 || !/^[\x21-\x7E]+$/.test(cleaned)) {
      setErrorMsg('Please enter a valid NVIDIA NIM API key (starts with nvapi-..., no spaces).');
      return;
    }
    setStoredNvidiaApiKey(cleaned);
    setStoredNimSettings({
      modelId: modelId.trim() || DEFAULT_NIM_MODEL_ID,
      nim3dEndpoint: nim3dEndpoint.trim() || DEFAULT_NIM_3D_ENDPOINT,
    });
    await onRefreshStatus();
    setSaveNotice(
      `Saved ${maskNvidiaApiKey(cleaned)} in browser localStorage (${NVIDIA_API_KEY_STORAGE_KEY}).`
    );
  };

  const handleClearBrowserKey = async () => {
    clearStoredNvidiaApiKey();
    setKeyInput('');
    setNimCheck(null);
    setProviderChecks({});
    setErrorMsg(null);
    setSaveNotice('Cleared NVIDIA NIM API key from browser localStorage.');
    await onRefreshStatus();
  };

  const handleResetEndpoints = async () => {
    setModelId(DEFAULT_NIM_MODEL_ID);
    setNim3dEndpoint(DEFAULT_NIM_3D_ENDPOINT);
    setStoredNimSettings({
      modelId: DEFAULT_NIM_MODEL_ID,
      nim3dEndpoint: DEFAULT_NIM_3D_ENDPOINT,
    });
    await onRefreshStatus();
  };

  const handleTestNim = async () => {
    setTestingNim(true);
    setErrorMsg(null);
    try {
      if (keyInput.trim() && keyInput.trim() !== storedNimKey) {
        setStoredNvidiaApiKey(keyInput.trim());
        setStoredNimSettings({ modelId, nim3dEndpoint });
        await onRefreshStatus();
      }
      const res = await api.testNimConnectivity();
      setNimCheck(res.result);
    } catch (err) {
      setErrorMsg(err instanceof ApiClientError ? err.message : 'NIM connectivity check failed.');
    } finally {
      setTestingNim(false);
    }
  };

  const handleTestProvider = async (id: ProviderId) => {
    setTestingProvider(id);
    setErrorMsg(null);
    try {
      const res = await api.testProviderConnectivity(id);
      setProviderChecks((prev) => ({ ...prev, [id]: res.result }));
    } catch (err) {
      setErrorMsg(err instanceof ApiClientError ? err.message : 'Provider check failed.');
    } finally {
      setTestingProvider(null);
    }
  };

  const handleSelectProvider = async (id: ProviderId) => {
    setSwitchingProvider(id);
    setErrorMsg(null);
    try {
      await api.selectProvider(id);
      await onRefreshStatus();
    } catch (err) {
      setErrorMsg(err instanceof ApiClientError ? err.message : 'Failed to switch provider.');
    } finally {
      setSwitchingProvider(null);
    }
  };

  const keySourceLabel =
    systemStatus?.nim.keySource === 'browser-storage'
      ? 'Saved in Browser localStorage'
      : systemStatus?.nim.keySource === 'server-env'
      ? 'Server Environment Key'
      : 'Not Set';

  return (
    <div className="h-full overflow-y-auto bg-[#0b0e14]">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-8">
        <div>
          <h1 className="text-xl font-bold text-white">API Key & Pipeline Diagnostics</h1>
          <p className="mt-0.5 text-xs text-[#8d97ab]">
            Use NV3D Studio directly with no sign-up or login. Paste your NVIDIA NIM API key below
            to save it in your browser localStorage and unlock MiniMax M3.1 Flash + NVIDIA NIM 3D.
          </p>
        </div>

        {errorMsg && (
          <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 px-4 py-3 text-xs text-rose-200">
            {errorMsg}
          </div>
        )}

        {/* 1. Browser LocalStorage NVIDIA NIM API Key Card */}
        <section className="rounded-2xl border border-[#76b900]/35 bg-[#111520] p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <KeyRound className="h-4 w-4 text-[#8ed90b]" />
                <h2 className="text-sm font-semibold text-white">
                  NVIDIA NIM API Key (Browser Local Storage)
                </h2>
                <span
                  className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${
                    systemStatus?.nim.configured
                      ? 'bg-[#76b900]/16 text-[#a3e635]'
                      : 'bg-amber-500/12 text-amber-300'
                  }`}
                >
                  {keySourceLabel}
                </span>
              </div>
              <p className="mt-1.5 text-xs text-[#8d97ab]">
                Only your <code className="font-mono-tech text-[#cfd6e4]">nvapi-...</code> key is
                needed — no <code className="font-mono-tech text-[#cfd6e4]">.env</code> file, no
                Meshy/Tripo key, no database setup, and no account login required. Stored only in{' '}
                <code className="font-mono-tech text-[#cfd6e4]">
                  localStorage[&quot;{NVIDIA_API_KEY_STORAGE_KEY}&quot;]
                </code>
                .
              </p>
            </div>

            <a
              href="https://build.nvidia.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-xl border border-[#2c374e] bg-[#171d2b] px-3 py-1.5 text-xs font-medium text-[#a3e635] transition hover:border-[#8ed90b]"
            >
              <span>Get Free Key at build.nvidia.com</span>
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>

          <form onSubmit={(e) => void handleSaveBrowserKey(e)} className="mt-4 space-y-3.5">
            <div className="flex flex-col gap-2.5 sm:flex-row">
              <div className="relative flex-1">
                <input
                  type={revealKey ? 'text' : 'password'}
                  autoComplete="off"
                  spellCheck={false}
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder="Paste your NVIDIA NIM API key (nvapi-...)"
                  aria-label="NVIDIA NIM API Key"
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

              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="submit"
                  disabled={!keyInput.trim()}
                  className="rounded-xl bg-[#76b900] px-4 py-2.5 text-xs font-semibold text-[#080d03] transition hover:bg-[#8ed90b] disabled:opacity-50"
                >
                  Save to Browser
                </button>

                {storedNimKey && (
                  <button
                    type="button"
                    onClick={() => void handleClearBrowserKey()}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-rose-500/35 bg-rose-500/10 px-3 py-2.5 text-xs font-medium text-rose-300 transition hover:bg-rose-500/20"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>Clear</span>
                  </button>
                )}
              </div>
            </div>

            {/* Editable NIM Model + 3D Endpoint saved in localStorage */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-[10px] font-semibold tracking-wider text-[#7e899f] uppercase">
                  Orchestration Model (NVIDIA NIM Chat)
                </label>
                <input
                  type="text"
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  className="w-full rounded-xl border border-[#1f2839] bg-[#0c1017] px-3 py-2 font-mono-tech text-xs text-[#a3e635] focus:border-[#8ed90b] focus:outline-none"
                />
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-[10px] font-semibold tracking-wider text-[#7e899f] uppercase">
                    3D Mesh Generation Endpoint (NVIDIA NIM 3D)
                  </label>
                  <button
                    type="button"
                    onClick={() => void handleResetEndpoints()}
                    className="inline-flex items-center gap-1 text-[10px] text-[#7e899f] hover:text-white"
                  >
                    <RotateCcw className="h-2.5 w-2.5" />
                    <span>Defaults</span>
                  </button>
                </div>
                <input
                  type="url"
                  value={nim3dEndpoint}
                  onChange={(e) => setNim3dEndpoint(e.target.value)}
                  className="w-full rounded-xl border border-[#1f2839] bg-[#0c1017] px-3 py-2 font-mono-tech text-xs text-[#d8deea] focus:border-[#8ed90b] focus:outline-none"
                />
              </div>
            </div>
          </form>

          {saveNotice && (
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-[#76b900]/35 bg-[#76b900]/10 px-3.5 py-2.5 text-xs text-[#d8f3a2]">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-[#8ed90b]" />
              <span>{saveNotice}</span>
            </div>
          )}
        </section>

        {/* 2. NVIDIA NIM Orchestration Diagnostics */}
        <section className="rounded-2xl border border-[#1f2737] bg-[#111520] p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-[#8ed90b]" />
                <h2 className="text-sm font-semibold text-white">
                  AI Intelligence & Orchestration — MiniMax M3.1 Flash
                </h2>
              </div>
              <p className="mt-1.5 text-xs text-[#8d97ab]">
                Enhances prompts, inspects reference images, produces structured JSON geometry & PBR
                material instructions, and powers the AI Studio Assistant via{' '}
                <code className="font-mono-tech text-[#cfd6e4]">
                  {systemStatus?.nim.endpoint ??
                    'https://integrate.api.nvidia.com/v1/chat/completions'}
                </code>
                .
              </p>
            </div>

            <button
              type="button"
              disabled={testingNim}
              onClick={() => void handleTestNim()}
              className="flex items-center gap-1.5 rounded-xl border border-[#2c374e] bg-[#171d2b] px-3.5 py-2 text-xs font-medium text-white transition hover:border-[#8ed90b] disabled:opacity-50"
            >
              {testingNim ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[#8ed90b]" />
              ) : (
                <Activity className="h-3.5 w-3.5 text-[#8ed90b]" />
              )}
              <span>Test NIM Connectivity</span>
            </button>
          </div>

          {nimCheck && (
            <div
              className={`mt-3 flex items-start gap-2 rounded-xl border p-3 text-xs ${
                nimCheck.reachable
                  ? 'border-[#76b900]/35 bg-[#76b900]/10 text-[#d8f3a2]'
                  : 'border-amber-500/35 bg-amber-500/10 text-amber-200'
              }`}
            >
              {nimCheck.reachable ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#8ed90b]" />
              ) : (
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
              )}
              <span>{nimCheck.message}</span>
            </div>
          )}
        </section>

        {/* 3. Modular Replaceable 3D Generation Providers */}
        <section className="rounded-2xl border border-[#1f2737] bg-[#111520] p-5">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-[#8ed90b]" />
            <h2 className="text-sm font-semibold text-white">
              3D Generation Provider Adapters
            </h2>
          </div>
          <p className="mt-1 text-xs text-[#8d97ab]">
            {systemStatus?.demoMode
              ? systemStatus.demoReason
              : `Active live 3D mesh generator: ${systemStatus?.activeProvider?.displayName}.`}
          </p>

          <div className="mt-4 grid gap-3.5 sm:grid-cols-2">
            {(systemStatus?.providers ?? []).map((p) => {
              const check = providerChecks[p.id];
              return (
                <div
                  key={p.id}
                  className={`flex flex-col justify-between rounded-xl border p-4 ${
                    p.active
                      ? 'border-[#76b900]/55 bg-[#76b900]/8'
                      : 'border-[#1f2737] bg-[#0c1017]'
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-xs font-semibold text-white">{p.displayName}</h3>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                          p.active
                            ? 'bg-[#76b900] text-[#080d03]'
                            : p.configured
                            ? 'bg-sky-500/15 text-sky-300'
                            : 'bg-[#1b2232] text-[#838ea4]'
                        }`}
                      >
                        {p.active ? 'Active' : p.configured ? 'Ready' : 'Optional'}
                      </span>
                    </div>

                    <p className="mt-1.5 font-mono-tech text-[10px] text-[#78839a]">
                      {p.id === 'nim-trellis'
                        ? 'Uses your browser NVIDIA NIM API key (no extra key needed)'
                        : `Optional server env: ${p.requiredEnvVars.join(', ')}`}
                    </p>

                    <div className="mt-3 flex flex-wrap gap-1 text-[10px]">
                      {p.capabilities.textTo3D && (
                        <span className="rounded bg-[#161c28] px-1.5 py-0.5 text-[#b9c3d6]">
                          Text-to-3D
                        </span>
                      )}
                      {p.capabilities.imageTo3D && (
                        <span className="rounded bg-[#161c28] px-1.5 py-0.5 text-[#b9c3d6]">
                          Image-to-3D
                        </span>
                      )}
                      {p.capabilities.multiViewImageTo3D && (
                        <span className="rounded bg-[#161c28] px-1.5 py-0.5 text-[#b9c3d6]">
                          Multi-View
                        </span>
                      )}
                      {p.capabilities.pbrMaterials && (
                        <span className="rounded bg-[#161c28] px-1.5 py-0.5 text-[#b9c3d6]">
                          PBR {p.capabilities.maxTextureResolution.toUpperCase()}
                        </span>
                      )}
                      {p.capabilities.gltfExport && (
                        <span className="rounded bg-[#161c28] px-1.5 py-0.5 text-[#b9c3d6]">
                          GLB + GLTF
                        </span>
                      )}
                    </div>

                    {check && (
                      <p
                        className={`mt-2.5 rounded-lg border p-2 text-[11px] ${
                          check.reachable
                            ? 'border-[#76b900]/30 bg-[#76b900]/10 text-[#d8f3a2]'
                            : 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                        }`}
                      >
                        {check.message}
                      </p>
                    )}
                  </div>

                  <div className="mt-3.5 flex items-center gap-2">
                    <button
                      type="button"
                      disabled={!p.configured || testingProvider === p.id}
                      onClick={() => void handleTestProvider(p.id)}
                      className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-[#263044] bg-[#141925] py-1.5 text-[11px] font-medium text-[#d8deea] transition hover:border-[#3c4b68] hover:text-white disabled:opacity-40"
                    >
                      {testingProvider === p.id && (
                        <Loader2 className="h-3 w-3 animate-spin text-[#8ed90b]" />
                      )}
                      <span>Test Endpoint</span>
                    </button>

                    {p.configured && !p.active && (
                      <button
                        type="button"
                        disabled={switchingProvider === p.id}
                        onClick={() => void handleSelectProvider(p.id)}
                        className="rounded-lg bg-[#76b900] px-2.5 py-1.5 text-[11px] font-semibold text-[#080d03] transition hover:bg-[#8ed90b] disabled:opacity-50"
                      >
                        Activate
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* 4. Storage & Privacy Controls */}
        <section className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-[#1f2737] bg-[#111520] p-5">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-[#8ed90b]" />
              <h2 className="text-sm font-semibold text-white">Zero-Config Storage Runtime</h2>
            </div>
            <p className="mt-1.5 text-xs text-[#8d97ab]">
              Engine:{' '}
              <span className="font-mono-tech text-white">
                {systemStatus?.database.engine === 'postgresql'
                  ? 'PostgreSQL / Supabase'
                  : 'Embedded PostgreSQL 16 (No DATABASE_URL needed)'}
              </span>
            </p>
            <p className="mt-1 text-[11px] text-[#7e899f]">
              Max upload: {systemStatus?.limits.maxUploadMb ?? 15} MB · Max GLB import:{' '}
              {systemStatus?.limits.maxGlbImportMb ?? 50} MB
            </p>
          </div>

          <div className="rounded-2xl border border-[#1f2737] bg-[#111520] p-5">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-[#8ed90b]" />
              <h2 className="text-sm font-semibold text-white">Key Privacy & Asset Safety</h2>
            </div>
            <ul className="mt-2 space-y-1 text-xs text-[#b9c3d6]">
              <li>• No sign-up, email, or password required</li>
              <li>• API key lives only in your browser localStorage (never stored in DB or logs)</li>
              <li>• Khronos glTF 2.0 binary validation before every GLB/GLTF export</li>
              <li>• Strictly weapons-free asset generation policy</li>
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}
