import { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Eye,
  HelpCircle,
  Loader2,
  RotateCcw,
  Settings,
} from 'lucide-react';
import type { AssetCategory, GenerationJobRecord } from '@nv3d/shared';

interface JobStatusCardProps {
  job: GenerationJobRecord;
  onOpenSettings: () => void;
  onRetry?: () => void;
  onInspectMatchingDemo: (category: AssetCategory) => void;
  onExplainError: (errorCode: string, errorMessage: string, providerId: string | null) => void;
}

export function JobStatusCard({
  job,
  onOpenSettings,
  onRetry,
  onInspectMatchingDemo,
  onExplainError,
}: JobStatusCardProps) {
  const [showSpec, setShowSpec] = useState(false);

  const isRunning = [
    'queued',
    'enhancing',
    'submitting',
    'processing',
    'downloading',
    'optimizing',
    'validating',
  ].includes(job.status);

  const isUnconfigured = job.status === 'provider_unconfigured';
  const isFailed = job.status === 'failed';
  const isSucceeded = job.status === 'succeeded';

  return (
    <div
      className={`rounded-xl border p-3 text-xs ${
        isSucceeded
          ? 'border-[#76b900]/40 bg-[#76b900]/8'
          : isUnconfigured
          ? 'border-amber-500/35 bg-amber-500/8'
          : isFailed
          ? 'border-rose-500/35 bg-rose-500/8'
          : 'border-[#2a3448] bg-[#141925]'
      }`}
    >
      <div className="flex items-start gap-2.5">
        {isRunning && <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[#8ed90b]" />}
        {isSucceeded && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#8ed90b]" />}
        {isUnconfigured && <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />}
        {isFailed && <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />}

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-white">{job.stageLabel}</span>
            {isRunning && (
              <span className="font-mono-tech text-[11px] text-[#a3e635]">{job.progress}%</span>
            )}
          </div>

          {isRunning && (
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[#1e2636]">
              <div
                className="h-full rounded-full bg-[#8ed90b] transition-all duration-300"
                style={{ width: `${Math.max(6, job.progress)}%` }}
              />
            </div>
          )}

          {(isFailed || isUnconfigured) && job.errorMessage && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-[#c6cedd]">{job.errorMessage}</p>
          )}

          {isUnconfigured && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={onOpenSettings}
                className="flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/15 px-2.5 py-1 text-[11px] font-medium text-amber-200 transition hover:bg-amber-500/25"
              >
                <Settings className="h-3 w-3" />
                <span>Set NVIDIA API Key</span>
              </button>
              <button
                type="button"
                onClick={() =>
                  onInspectMatchingDemo(job.structuredSpec?.category ?? job.settings.category)
                }
                className="flex items-center gap-1 rounded-md border border-[#2d374d] bg-[#171d2a] px-2.5 py-1 text-[11px] font-medium text-[#d8deea] transition hover:border-[#3e4c68] hover:text-white"
              >
                <Eye className="h-3 w-3 text-[#8ed90b]" />
                <span>Load Demo Sample GLB</span>
              </button>
            </div>
          )}

          {isFailed && job.errorCode && job.errorMessage && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="flex items-center gap-1 rounded-md border border-[#76b900]/45 bg-[#76b900]/16 px-2.5 py-1 text-[11px] font-medium text-[#d8f3a2] transition hover:bg-[#76b900]/26"
                >
                  <RotateCcw className="h-3 w-3" />
                  <span>Retry</span>
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  onExplainError(job.errorCode!, job.errorMessage!, job.providerId)
                }
                className="flex items-center gap-1 rounded-md border border-rose-500/35 bg-rose-500/12 px-2.5 py-1 text-[11px] font-medium text-rose-200 transition hover:bg-rose-500/20"
              >
                <HelpCircle className="h-3 w-3" />
                <span>Diagnose Error</span>
              </button>
            </div>
          )}

          {job.structuredSpec && (
            <div className="mt-2.5 border-t border-[#263044] pt-2">
              <button
                type="button"
                onClick={() => setShowSpec((s) => !s)}
                className="flex w-full items-center justify-between text-[11px] font-medium text-[#9aa4b8] hover:text-white"
              >
                <span>
                  Structured Generation Spec (
                  {job.structuredSpec.orchestrator === 'nvidia-nim-minimax'
                    ? 'MiniMax M3.1 Flash'
                    : 'Local Fallback'}
                  )
                </span>
                {showSpec ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </button>
              {showSpec && (
                <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-[#1f2737] bg-[#0b0e14] p-2 font-mono-tech text-[10px] leading-relaxed text-[#aeb7c9]">
                  {JSON.stringify(job.structuredSpec, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
