import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Eye,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import type { GenerationHistoryEntry, GenerationJobRecord } from '@nv3d/shared';
import { api } from '../../lib/api';
import { formatRelativeTime } from '../../lib/format';

interface HistoryViewProps {
  onOpenModelById: (modelId: string) => void;
}

export function HistoryView({ onOpenModelById }: HistoryViewProps) {
  const [history, setHistory] = useState<GenerationHistoryEntry[]>([]);
  const [jobs, setJobs] = useState<GenerationJobRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getHistory(80);
      setHistory(res.history);
      setJobs(res.jobs);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="h-full overflow-y-auto bg-[#0b0e14]">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-8">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-white">Generation History</h1>
            <p className="mt-0.5 text-xs text-[#8d97ab]">
              Complete timeline of Text-to-3D jobs, Image-to-3D reconstructions, structured MiniMax
              specs, and GLB imports.
            </p>
          </div>
          <button
            type="button"
            disabled={loading}
            onClick={() => void load()}
            className="flex items-center gap-1.5 rounded-xl border border-[#263044] bg-[#131824] px-3.5 py-2 text-xs font-medium text-[#d8deea] transition hover:border-[#3c4b68] hover:text-white disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>

        {loading && history.length === 0 ? (
          <div className="flex items-center justify-center rounded-2xl border border-[#1f2737] bg-[#111520] p-12 text-xs text-[#8d97ab]">
            <Loader2 className="mr-2 h-4 w-4 animate-spin text-[#8ed90b]" />
            Loading history from PostgreSQL...
          </div>
        ) : history.length === 0 && jobs.length === 0 ? (
          <div className="rounded-2xl border border-[#1f2737] bg-[#111520] p-12 text-center">
            <Clock className="mx-auto h-7 w-7 text-[#69748b]" />
            <p className="mt-3 text-sm font-medium text-white">No workflow activity yet</p>
            <p className="mt-1 text-xs text-[#838ea4]">
              Submit a Text-to-3D prompt, upload reference images, or import a GLB file to record
              your studio timeline.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Generation Jobs Table */}
            {jobs.length > 0 && (
              <section>
                <h2 className="mb-3 text-xs font-semibold tracking-wider text-[#cfd6e4] uppercase">
                  Generation Jobs ({jobs.length})
                </h2>
                <div className="space-y-2.5">
                  {jobs.map((job) => {
                    const expanded = expandedJobId === job.id;
                    return (
                      <div
                        key={job.id}
                        className="rounded-xl border border-[#1f2737] bg-[#111520] p-4 text-xs"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span
                                className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${
                                  job.status === 'succeeded'
                                    ? 'bg-[#76b900]/15 text-[#a3e635]'
                                    : job.status === 'provider_unconfigured'
                                    ? 'bg-amber-500/12 text-amber-300'
                                    : job.status === 'failed'
                                    ? 'bg-rose-500/12 text-rose-300'
                                    : 'bg-sky-500/12 text-sky-300'
                                }`}
                              >
                                {job.status.replace('_', ' ')}
                              </span>
                              <span className="rounded bg-[#1a2130] px-2 py-0.5 text-[10px] font-medium text-[#cfd6e4] uppercase">
                                {job.mode}-to-3d
                              </span>
                              <span className="font-mono-tech text-[10px] text-[#6d788e]">
                                #{job.id.slice(0, 8)} · {formatRelativeTime(job.createdAt)}
                              </span>
                            </div>

                            <p className="mt-2 text-xs text-[#e6eaf2]">
                              {job.prompt ||
                                `Reference reconstruction (${job.uploadedImages.length} image view${
                                  job.uploadedImages.length === 1 ? '' : 's'
                                })`}
                            </p>

                            {job.errorMessage && (
                              <p className="mt-1 text-[11px] text-[#95a0b5]">{job.errorMessage}</p>
                            )}
                          </div>

                          <div className="flex items-center gap-2">
                            {job.structuredSpec && (
                              <button
                                type="button"
                                onClick={() => setExpandedJobId(expanded ? null : job.id)}
                                className="rounded-lg border border-[#283247] bg-[#161c28] px-2.5 py-1.5 text-[11px] font-medium text-[#cfd6e4] hover:text-white"
                              >
                                {expanded ? 'Hide Spec' : 'View Spec'}
                              </button>
                            )}
                            {job.modelId && (
                              <button
                                type="button"
                                onClick={() => onOpenModelById(job.modelId!)}
                                className="flex items-center gap-1 rounded-lg bg-[#76b900] px-3 py-1.5 text-[11px] font-semibold text-[#080d03] hover:bg-[#8ed90b]"
                              >
                                <Eye className="h-3.5 w-3.5" />
                                <span>Open GLB</span>
                              </button>
                            )}
                          </div>
                        </div>

                        {expanded && job.structuredSpec && (
                          <pre className="mt-3 max-h-56 overflow-auto rounded-lg border border-[#1d2536] bg-[#090c12] p-3 font-mono-tech text-[10px] leading-relaxed text-[#9aa4b8]">
                            {JSON.stringify(job.structuredSpec, null, 2)}
                          </pre>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Audit Events */}
            {history.length > 0 && (
              <section>
                <h2 className="mb-3 text-xs font-semibold tracking-wider text-[#cfd6e4] uppercase">
                  Activity Log ({history.length})
                </h2>
                <div className="divide-y divide-[#1b2231] rounded-xl border border-[#1f2737] bg-[#111520]">
                  {history.map((entry) => (
                    <div
                      key={entry.id}
                      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs"
                    >
                      <div className="flex min-w-0 items-start gap-2.5">
                        {entry.status === 'succeeded' ? (
                          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#8ed90b]" />
                        ) : (
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                        )}
                        <div className="min-w-0">
                          <p className="text-[#e6eaf2]">{entry.summary}</p>
                          <p className="mt-0.5 font-mono-tech text-[10px] text-[#737e94]">
                            {entry.action} · {formatRelativeTime(entry.createdAt)}
                            {entry.durationMs !== null
                              ? ` · ${(entry.durationMs / 1000).toFixed(1)}s`
                              : ''}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2.5">
                        <span
                          className={`font-mono-tech text-[11px] ${
                            entry.creditsDelta < 0
                              ? 'text-amber-300'
                              : entry.creditsDelta > 0
                              ? 'text-[#a3e635]'
                              : 'text-[#6d788e]'
                          }`}
                        >
                          {entry.creditsDelta === 0
                            ? '0 CR'
                            : `${entry.creditsDelta > 0 ? '+' : ''}${entry.creditsDelta} CR`}
                        </span>
                        {entry.modelId && (
                          <button
                            type="button"
                            onClick={() => onOpenModelById(entry.modelId!)}
                            className="rounded-md border border-[#283247] px-2 py-1 text-[11px] text-[#cfd6e4] hover:border-[#8ed90b] hover:text-white"
                          >
                            View
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
