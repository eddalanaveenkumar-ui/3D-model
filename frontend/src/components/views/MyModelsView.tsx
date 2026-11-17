import { useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Download,
  Eye,
  FileCode2,
  Loader2,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  ASSET_CATEGORIES,
  type AssetCategory,
  type GeneratedModelRecord,
  type OutputFormat,
} from '@nv3d/shared';
import { ApiClientError, downloadModelWithProgress } from '../../lib/api';
import {
  formatBytes,
  formatCount,
  formatDimensionMeters,
  formatRelativeTime,
  rgbaFactorToHex,
} from '../../lib/format';

interface MyModelsViewProps {
  models: GeneratedModelRecord[];
  onInspectModel: (model: GeneratedModelRecord) => void;
  onDeleteModel: (modelId: string) => Promise<void>;
  onImportGlb: (file: File, optimizeSize: boolean) => Promise<void>;
}

export function MyModelsView({
  models,
  onInspectModel,
  onDeleteModel,
  onImportGlb,
}: MyModelsViewProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [scope, setScope] = useState<'all' | 'mine' | 'demo'>('all');
  const [category, setCategory] = useState<AssetCategory | 'all'>('all');
  const [search, setSearch] = useState('');
  const [optimizeOnImport, setOptimizeOnImport] = useState(true);
  const [importing, setImporting] = useState(false);
  const [activeDownload, setActiveDownload] = useState<{
    id: string;
    format: OutputFormat;
    percent: number;
  } | null>(null);
  const [banner, setBanner] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const userCount = useMemo(() => models.filter((m) => !m.isDemo).length, [models]);
  const demoCount = useMemo(() => models.filter((m) => m.isDemo).length, [models]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return models.filter((m) => {
      if (scope === 'mine' && m.isDemo) return false;
      if (scope === 'demo' && !m.isDemo) return false;
      if (category !== 'all' && m.category !== category) return false;
      if (
        q &&
        !m.name.toLowerCase().includes(q) &&
        !m.description.toLowerCase().includes(q) &&
        !(m.prompt || '').toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [models, scope, category, search]);

  const handleDownload = async (model: GeneratedModelRecord, format: OutputFormat) => {
    if (activeDownload) return;
    setBanner(null);
    setActiveDownload({ id: model.id, format, percent: 0 });
    try {
      const res = await downloadModelWithProgress({
        modelId: model.id,
        format,
        fallbackName: model.name,
        onProgress: (p) => setActiveDownload({ id: model.id, format, percent: p.percent }),
      });
      setBanner({
        type: 'ok',
        text: `Exported ${res.filename} (${formatBytes(res.byteLength)}).`,
      });
    } catch (err) {
      setBanner({
        type: 'err',
        text: err instanceof ApiClientError ? err.message : 'Download failed.',
      });
    } finally {
      setActiveDownload(null);
    }
  };

  const handleFileImport = async (file: File) => {
    setImporting(true);
    setBanner(null);
    try {
      await onImportGlb(file, optimizeOnImport);
    } catch (err) {
      setBanner({
        type: 'err',
        text: err instanceof ApiClientError ? err.message : 'Failed to import GLB file.',
      });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-[#0b0e14]">
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-8">
        <input
          ref={fileRef}
          type="file"
          accept=".glb,model/gltf-binary"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFileImport(f);
            e.currentTarget.value = '';
          }}
        />

        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-white">Model Library</h1>
            <p className="mt-0.5 text-xs text-[#8d97ab]">
              Inspect, validate, and export your generated GLB assets and reference samples.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[#9aa4b8]">
              <input
                type="checkbox"
                checked={optimizeOnImport}
                onChange={(e) => setOptimizeOnImport(e.target.checked)}
                className="accent-[#76b900]"
              />
              <span>Optimize on import</span>
            </label>
            <button
              type="button"
              disabled={importing}
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-2 rounded-xl bg-[#76b900] px-4 py-2 text-xs font-semibold text-[#080d03] transition hover:bg-[#8ed90b] disabled:opacity-50"
            >
              {importing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              <span>{importing ? 'Validating GLB...' : 'Import .GLB'}</span>
            </button>
          </div>
        </div>

        {/* Filter Bar */}
        <div className="flex flex-col gap-3 rounded-xl border border-[#1f2737] bg-[#111520] p-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                ['all', `All (${models.length})`],
                ['mine', `My Models (${userCount})`],
                ['demo', `Demo Samples (${demoCount})`],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setScope(id)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  scope === id
                    ? 'bg-[#76b900]/16 text-[#a3e635]'
                    : 'text-[#8d97ab] hover:bg-[#19202e] hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as AssetCategory | 'all')}
              aria-label="Filter by category"
              className="rounded-lg border border-[#242e42] bg-[#0b0e14] px-2.5 py-1.5 text-xs text-[#d8deea] focus:border-[#76b900] focus:outline-none"
            >
              <option value="all">All Categories</option>
              {ASSET_CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>

            <div className="relative flex-1 sm:w-56">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-[#69748b]" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search models..."
                className="w-full rounded-lg border border-[#242e42] bg-[#0b0e14] py-1.5 pr-3 pl-8 text-xs text-white placeholder-[#5c667a] focus:border-[#76b900] focus:outline-none"
              />
            </div>
          </div>
        </div>

        {banner && (
          <div
            className={`rounded-xl border px-4 py-2.5 text-xs ${
              banner.type === 'ok'
                ? 'border-[#76b900]/35 bg-[#76b900]/10 text-[#d8f3a2]'
                : 'border-rose-500/35 bg-rose-500/10 text-rose-200'
            }`}
          >
            {banner.text}
          </div>
        )}

        {/* Model Grid */}
        {filtered.length === 0 ? (
          <div className="rounded-2xl border border-[#1f2737] bg-[#111520] p-10 text-center">
            <p className="text-sm font-medium text-white">No matching 3D assets</p>
            <p className="mt-1 text-xs text-[#838ea4]">
              {scope === 'mine'
                ? 'Generate a model with a configured 3D provider or import a .glb asset to populate your personal library.'
                : 'Adjust your category or search filters to view available GLB models.'}
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((m) => {
              const dl = activeDownload?.id === m.id ? activeDownload : null;
              return (
                <article
                  key={m.id}
                  className="flex flex-col justify-between rounded-xl border border-[#1f2737] bg-[#111520] p-4 transition hover:border-[#34425c]"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${
                          m.isDemo
                            ? 'border border-amber-500/30 bg-amber-500/10 text-amber-300'
                            : m.sourceType === 'user_import'
                            ? 'border border-sky-500/30 bg-sky-500/10 text-sky-300'
                            : 'border border-[#76b900]/35 bg-[#76b900]/12 text-[#a3e635]'
                        }`}
                      >
                        {m.isDemo
                          ? 'Demo Sample'
                          : m.sourceType === 'user_import'
                          ? 'Imported GLB'
                          : `Generated · ${m.providerId}`}
                      </span>
                      <span className="flex items-center gap-1 font-mono-tech text-[10px] text-[#a3e635]">
                        <CheckCircle2 className="h-3 w-3" />
                        GLB v{m.validationReport.gltfVersion}
                      </span>
                    </div>

                    <h2 className="mt-3 text-sm font-semibold text-white">{m.name}</h2>
                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-[#8d97ab]">
                      {m.description}
                    </p>

                    {/* Swatches + Category */}
                    <div className="mt-3 flex items-center justify-between">
                      <div className="flex items-center gap-1">
                        {m.statistics.materials.slice(0, 6).map((mat, i) => (
                          <span
                            key={i}
                            title={mat.name}
                            className="h-3.5 w-3.5 rounded-full border border-white/15"
                            style={{ backgroundColor: rgbaFactorToHex(mat.baseColorFactor) }}
                          />
                        ))}
                      </div>
                      <span className="text-[11px] text-[#737e94]">
                        {formatRelativeTime(m.createdAt)}
                      </span>
                    </div>

                    {/* Telemetry Table */}
                    <div className="mt-3 grid grid-cols-3 gap-1.5 rounded-lg border border-[#1b2231] bg-[#0c1017] p-2.5 font-mono-tech text-[10px]">
                      <div>
                        <span className="block text-[#69748b]">Vertices</span>
                        <span className="text-[#e6eaf2]">{formatCount(m.statistics.vertices)}</span>
                      </div>
                      <div>
                        <span className="block text-[#69748b]">Triangles</span>
                        <span className="text-[#e6eaf2]">{formatCount(m.statistics.triangles)}</span>
                      </div>
                      <div>
                        <span className="block text-[#69748b]">Size</span>
                        <span className="text-[#e6eaf2]">{formatBytes(m.fileSizeBytes)}</span>
                      </div>
                      <div className="col-span-2">
                        <span className="block text-[#69748b]">Dimensions</span>
                        <span className="text-[#cfd6e4]">
                          {formatDimensionMeters(m.statistics.dimensions.width)} x{' '}
                          {formatDimensionMeters(m.statistics.dimensions.height)} x{' '}
                          {formatDimensionMeters(m.statistics.dimensions.depth)}
                        </span>
                      </div>
                      <div>
                        <span className="block text-[#69748b]">Materials</span>
                        <span className="text-[#e6eaf2]">{m.statistics.materialCount}</span>
                      </div>
                    </div>
                  </div>

                  {dl && (
                    <div className="mt-3">
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#1d2434]">
                        <div
                          className="h-full rounded-full bg-[#8ed90b] transition-all"
                          style={{ width: `${dl.percent}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="mt-4 flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onInspectModel(m)}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#76b900] px-3 py-2 text-xs font-semibold text-[#080d03] transition hover:bg-[#8ed90b]"
                    >
                      <Eye className="h-3.5 w-3.5" />
                      <span>Viewer</span>
                    </button>
                    <button
                      type="button"
                      disabled={!m.validated || Boolean(dl)}
                      onClick={() => void handleDownload(m, 'glb')}
                      title="Download binary GLB"
                      className="flex items-center gap-1 rounded-lg border border-[#2a3448] bg-[#151b28] px-2.5 py-2 text-[11px] font-medium text-[#e6eaf2] transition hover:border-[#8ed90b] disabled:opacity-50"
                    >
                      <Download className="h-3.5 w-3.5 text-[#8ed90b]" />
                      <span>GLB</span>
                    </button>
                    <button
                      type="button"
                      disabled={!m.validated || Boolean(dl)}
                      onClick={() => void handleDownload(m, 'gltf')}
                      title="Export separate GLTF 2.0 JSON"
                      className="flex items-center gap-1 rounded-lg border border-[#2a3448] bg-[#151b28] px-2.5 py-2 text-[11px] font-medium text-[#cfd6e4] transition hover:border-[#8ed90b] disabled:opacity-50"
                    >
                      <FileCode2 className="h-3.5 w-3.5 text-[#9aa4b8]" />
                      <span>GLTF</span>
                    </button>
                    {!m.isDemo && (
                      <button
                        type="button"
                        onClick={() => void onDeleteModel(m.id)}
                        aria-label={`Delete ${m.name}`}
                        title="Delete model"
                        className="flex items-center justify-center rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-rose-300 transition hover:bg-rose-500/20"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
