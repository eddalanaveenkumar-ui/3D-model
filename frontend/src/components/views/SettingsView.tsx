import { useEffect, useState } from 'react';
import {
  Activity,
  Check,
  CheckCircle2,
  Copy,
  Cpu,
  Database,
  Loader2,
  Server,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import type {
  ConnectivityCheckResult,
  CreditLedgerEntry,
  ProviderId,
  SystemStatus,
  UserProfile,
} from '@nv3d/shared';
import { api, ApiClientError } from '../../lib/api';

interface SettingsViewProps {
  systemStatus: SystemStatus | null;
  user: UserProfile | null;
  onRefreshStatus: () => Promise<void>;
}

const ENV_SNIPPET = `# Server-side .env configuration (never exposed to browser JS)
NVIDIA_NIM_ENDPOINT=https://integrate.api.nvidia.com/v1/chat/completions
NVIDIA_NIM_MODEL=minimaxai/minimax-m3.1-flash
NVIDIA_NIM_API_KEY=<your-nvidia-nim-api-key>

# Configure one or more replaceable 3D generation providers:
PROVIDER_3D=auto
MESHY_API_KEY=<your-meshy-api-key>
TRIPO_API_KEY=<your-tripo-api-key>
CUSTOM_3D_PROVIDER_URL=https://your-3d-gateway.example.com

# PostgreSQL / Supabase connection string (uses embedded Postgres 16 if omitted):
DATABASE_URL=postgresql://postgres:<password>@db.example.com:5432/nv3d_studio`;

export function SettingsView({
  systemStatus,
  user,
  onRefreshStatus,
}: SettingsViewProps) {
  const [nimCheck, setNimCheck] = useState<ConnectivityCheckResult | null>(null);
  const [testingNim, setTestingNim] = useState(false);
  const [providerChecks, setProviderChecks] = useState<
    Partial<Record<ProviderId, ConnectivityCheckResult>>
  >({});
  const [testingProvider, setTestingProvider] = useState<ProviderId | null>(null);
  const [switchingProvider, setSwitchingProvider] = useState<ProviderId | null>(null);
  const [credits, setCredits] = useState<CreditLedgerEntry | null>(null);
  const [copied, setCopied] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    api
      .getCredits()
      .then((r) => setCredits(r.credits))
      .catch(() => undefined);
  }, [user?.credits]);

  const handleTestNim = async () => {
    setTestingNim(true);
    setErrorMsg(null);
    try {
      const res = await api.testNimConnectivity();
      setNimCheck(res.result);
    } catch (err) {
      setErrorMsg(err instanceof ApiClientError ? err.message : 'NIM check failed.');
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

  const handleCopyEnv = async () => {
    await navigator.clipboard?.writeText(ENV_SNIPPET).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="h-full overflow-y-auto bg-[#0b0e14]">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-8">
        <div>
          <h1 className="text-xl font-bold text-white">Studio Settings & Pipeline Diagnostics</h1>
          <p className="mt-0.5 text-xs text-[#8d97ab]">
            Verify server-side NVIDIA NIM MiniMax M3.1 Flash orchestration, replaceable 3D provider
            adapters, PostgreSQL persistence, and security policies.
          </p>
        </div>

        {errorMsg && (
          <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 px-4 py-3 text-xs text-rose-200">
            {errorMsg}
          </div>
        )}

        {/* 1. NVIDIA NIM Orchestration Model */}
        <section className="rounded-2xl border border-[#1f2737] bg-[#111520] p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-[#8ed90b]" />
                <h2 className="text-sm font-semibold text-white">
                  AI Intelligence & Orchestration — NVIDIA NIM
                </h2>
                <span
                  className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${
                    systemStatus?.nim.configured
                      ? 'bg-[#76b900]/16 text-[#a3e635]'
                      : 'bg-amber-500/12 text-amber-300'
                  }`}
                >
                  {systemStatus?.nim.configured ? 'Configured' : 'API Key Not Set'}
                </span>
              </div>
              <p className="mt-1.5 text-xs text-[#8d97ab]">
                Used exclusively on the backend to interpret prompts, analyze reference images, emit
                structured JSON 3D specifications, and explain errors. API keys are never exposed to
                browser JavaScript.
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

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-[#1c2332] bg-[#0c1017] p-3">
              <span className="text-[10px] tracking-wider text-[#6d788e] uppercase">Endpoint</span>
              <p className="mt-1 truncate font-mono-tech text-xs text-[#d8deea]">
                {systemStatus?.nim.endpoint ??
                  'https://integrate.api.nvidia.com/v1/chat/completions'}
              </p>
            </div>
            <div className="rounded-xl border border-[#1c2332] bg-[#0c1017] p-3">
              <span className="text-[10px] tracking-wider text-[#6d788e] uppercase">Model ID</span>
              <p className="mt-1 font-mono-tech text-xs text-[#a3e635]">
                {systemStatus?.nim.modelId ?? 'minimaxai/minimax-m3.1-flash'}
              </p>
            </div>
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

        {/* 2. Modular Replaceable 3D Generation Providers */}
        <section className="rounded-2xl border border-[#1f2737] bg-[#111520] p-5">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-[#8ed90b]" />
            <h2 className="text-sm font-semibold text-white">
              3D Generation Provider Adapters (Replaceable Backend Layer)
            </h2>
          </div>
          <p className="mt-1 text-xs text-[#8d97ab]">
            {systemStatus?.demoMode
              ? systemStatus.demoReason
              : `Active live synthesis adapter: ${systemStatus?.activeProvider?.displayName}.`}
          </p>

          <div className="mt-4 grid gap-3.5 md:grid-cols-3">
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
                        {p.active ? 'Active' : p.configured ? 'Ready' : 'Unconfigured'}
                      </span>
                    </div>

                    <p className="mt-1.5 font-mono-tech text-[10px] text-[#78839a]">
                      Env: {p.requiredEnvVars.join(', ')}
                    </p>

                    {/* Capabilities */}
                    <div className="mt-3 flex flex-wrap gap-1 text-[10px]">
                      {p.capabilities.textTo3D && (
                        <span className="rounded bg-[#171d2a] px-1.5 py-0.5 text-[#cfd6e4]">
                          Text-3D
                        </span>
                      )}
                      {p.capabilities.imageTo3D && (
                        <span className="rounded bg-[#171d2a] px-1.5 py-0.5 text-[#cfd6e4]">
                          Image-3D
                        </span>
                      )}
                      {p.capabilities.multiViewImageTo3D && (
                        <span className="rounded bg-[#171d2a] px-1.5 py-0.5 text-[#cfd6e4]">
                          Front/Side/Back
                        </span>
                      )}
                      {p.capabilities.pbrMaterials && (
                        <span className="rounded bg-[#171d2a] px-1.5 py-0.5 text-[#cfd6e4]">
                          PBR {p.capabilities.maxTextureResolution.toUpperCase()}
                        </span>
                      )}
                      {p.capabilities.rigging && (
                        <span className="rounded bg-[#76b900]/15 px-1.5 py-0.5 text-[#a3e635]">
                          Rig + Anim
                        </span>
                      )}
                      {p.capabilities.webhooks && (
                        <span className="rounded bg-[#171d2a] px-1.5 py-0.5 text-[#9aa4b8]">
                          HMAC Webhook
                        </span>
                      )}
                    </div>

                    {check && (
                      <p
                        className={`mt-2.5 rounded-lg border p-2 text-[10px] leading-relaxed ${
                          check.reachable
                            ? 'border-[#76b900]/35 bg-[#76b900]/10 text-[#d8f3a2]'
                            : 'border-amber-500/30 bg-amber-500/8 text-amber-200'
                        }`}
                      >
                        {check.message}
                      </p>
                    )}
                  </div>

                  <div className="mt-4 flex gap-1.5">
                    <button
                      type="button"
                      disabled={testingProvider === p.id}
                      onClick={() => void handleTestProvider(p.id)}
                      className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-[#273146] bg-[#141a26] py-1.5 text-[11px] font-medium text-[#d8deea] transition hover:border-[#8ed90b] hover:text-white disabled:opacity-50"
                    >
                      {testingProvider === p.id && (
                        <Loader2 className="h-3 w-3 animate-spin text-[#8ed90b]" />
                      )}
                      <span>Test</span>
                    </button>
                    {p.configured && !p.active && (
                      <button
                        type="button"
                        disabled={switchingProvider === p.id}
                        onClick={() => void handleSelectProvider(p.id)}
                        className="flex flex-1 items-center justify-center rounded-lg bg-[#76b900] py-1.5 text-[11px] font-semibold text-[#080d03] hover:bg-[#8ed90b] disabled:opacity-50"
                      >
                        Activate
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Copyable .env template */}
          <div className="mt-4 rounded-xl border border-[#1d2536] bg-[#090c12] p-3.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-[#cfd6e4]">
                Server Environment Quick Setup (.env)
              </span>
              <button
                type="button"
                onClick={() => void handleCopyEnv()}
                className="flex items-center gap-1 rounded-md border border-[#263044] px-2 py-1 text-[10px] font-medium text-[#aeb7c9] hover:text-white"
              >
                {copied ? (
                  <Check className="h-3 w-3 text-[#8ed90b]" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
            <pre className="mt-2 overflow-x-auto font-mono-tech text-[10px] leading-relaxed text-[#8d97ab]">
              {ENV_SNIPPET}
            </pre>
          </div>
        </section>

        {/* 3. Database, Credits & Security */}
        <div className="grid gap-4 md:grid-cols-2">
          <section className="rounded-2xl border border-[#1f2737] bg-[#111520] p-5">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-[#8ed90b]" />
              <h2 className="text-sm font-semibold text-white">PostgreSQL / Supabase Schema</h2>
            </div>
            <p className="mt-1 font-mono-tech text-[11px] text-[#9aa4b8]">
              Engine: {systemStatus?.database.engine ?? 'postgresql'}
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {(systemStatus?.database.tables ?? []).map((tbl) => (
                <span
                  key={tbl}
                  className="rounded-md border border-[#242e42] bg-[#0c1017] px-2 py-1 font-mono-tech text-[10px] text-[#a3e635]"
                >
                  {tbl}
                </span>
              ))}
            </div>
            {credits && (
              <div className="mt-4 border-t border-[#1d2536] pt-3 text-xs">
                <div className="flex justify-between">
                  <span className="text-[#838ea4]">Credit Balance</span>
                  <span className="font-mono-tech font-semibold text-white">
                    {credits.balance} CR
                  </span>
                </div>
                <div className="mt-1 flex justify-between text-[11px]">
                  <span className="text-[#6d788e]">Lifetime Granted / Spent</span>
                  <span className="font-mono-tech text-[#9aa4b8]">
                    {credits.lifetimeGranted} / {credits.lifetimeSpent} CR
                  </span>
                </div>
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-[#1f2737] bg-[#111520] p-5">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-[#8ed90b]" />
              <h2 className="text-sm font-semibold text-white">Active Security Controls</h2>
            </div>
            <ul className="mt-3 space-y-2 text-xs text-[#aeb7c9]">
              <li className="flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[#8ed90b]" />
                <span>Server-side API credentials (zero secrets in browser bundle)</span>
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[#8ed90b]" />
                <span>
                  Magic-byte PNG/JPG/WEBP validation + EXIF strip (max{' '}
                  {systemStatus?.limits.maxUploadMb ?? 15} MB)
                </span>
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[#8ed90b]" />
                <span>Per-user isolated storage & model/upload ownership checks</span>
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[#8ed90b]" />
                <span>
                  Rate limiting ({systemStatus?.limits.generationRateLimitPerMin ?? 12} gen/min) &
                  HMAC-SHA256 webhook verification
                </span>
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[#8ed90b]" />
                <span>Strict CSP, XSS input sanitization, and weapons-free policy</span>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
