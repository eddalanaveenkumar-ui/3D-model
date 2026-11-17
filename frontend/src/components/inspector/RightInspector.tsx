import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Download,
  FileCheck2,
  Info,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type {
  GeneratedModelRecord,
  GenerationSettings,
  OutputFormat,
  StructuredGenerationSpec,
  SystemStatus,
} from '@nv3d/shared';
import {
  api,
  ApiClientError,
  downloadModelWithProgress,
  type DownloadProgressState,
} from '../../lib/api';
import {
  formatBytes,
  formatCount,
  formatDimensionMeters,
  formatRelativeTime,
  rgbaFactorToHex,
} from '../../lib/format';
import type { LiveSceneStats } from '../viewer/ThreeViewport';
import { AiAssistantPanel, type ErrorDiagnosisState } from './AiAssistantPanel';

export type InspectorTab = 'inspector' | 'export' | 'assistant';

interface RightInspectorProps {
  activeTab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  model: GeneratedModelRecord | null;
  demoModels: GeneratedModelRecord[];
  liveStats: LiveSceneStats | null;
  systemStatus: SystemStatus | null;
  currentPrompt: string;
  settings: GenerationSettings;
  lastSpec: StructuredGenerationSpec | null;
  diagnosis: ErrorDiagnosisState | null;
  onSelectModel: (model: GeneratedModelRecord) => void;
  onModelValidated: (modelId: string) => void;
  onDeleteModel: (modelId: string) => void;
  onApplySpec: (spec: StructuredGenerationSpec) => void;
  onOpenSettings: () => void;
}

export function RightInspector({
  activeTab,
  onTabChange,
  model,
  demoModels,
  liveStats,
  systemStatus,
  currentPrompt,
  settings,
  lastSpec,
  diagnosis,
  onSelectModel,
  onModelValidated,
  onDeleteModel,
  onApplySpec,
  onOpenSettings,
}: RightInspectorProps) {
  const [validating, setValidating] = useState(false);
  const [downloadingFmt, setDownloadingFmt] = useState<OutputFormat | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgressState | null>(null);
  const [exportNotice, setExportNotice] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleRevalidate = async () => {
    if (!model || validating) return;
    setValidating(true);
    setExportNotice(null);
    try {
      await api.validateModel(model.id);
      onModelValidated(model.id);
    } catch (err) {
      setExportNotice({
        type: 'error',
        text: err instanceof ApiClientError ? err.message : 'Validation check failed.',
      });
    } finally {
      setValidating(false);
    }
  };

  const handleExport = async (format: OutputFormat) => {
    if (!model || !model.validated || downloadingFmt) return;
    setDownloadingFmt(format);
    setDownloadProgress({ loadedBytes: 0, totalBytes: model.fileSizeBytes, percent: 0 });
    setExportNotice(null);

    try {
      const result = await downloadModelWithProgress({
        modelId: model.id,
        format,
        fallbackName: model.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        onProgress: (state) => setDownloadProgress(state),
      });
      setExportNotice({
        type: 'success',
        text: `Downloaded ${result.filename} (${formatBytes(result.byteLength)}) — binary integrity verified.`,
      });
    } catch (err) {
      setExportNotice({
        type: 'error',
        text: err instanceof ApiClientError ? err.message : 'Export download failed.',
      });
    } finally {
      setDownloadingFmt(null);
    }
  };

  const handleDelete = async () => {
    if (!model || model.isDemo || deleting) return;
    setDeleting(true);
    try {
      onDeleteModel(model.id);
    } finally {
      setDeleting(false);
    }
  };

  const verts = liveStats?.vertices ?? model?.statistics.vertices ?? 0;
  const tris = liveStats?.triangles ?? model?.statistics.triangles ?? 0;
  const matCount = liveStats?.materials ?? model?.statistics.materialCount ?? 0;
  const dims = liveStats?.dimensions ?? model?.statistics.dimensions ?? {
    width: 0,
    height: 0,
    depth: 0,
  };

  return (
    <div className="flex h-full flex-col bg-[#11141c]">
      {/* Top Tabs */}
      <div className="shrink-0 border-b border-[#1f2634] p-3">
        <div className="grid grid-cols-3 gap-1 rounded-xl border border-[#232b3c] bg-[#0b0e14] p-1">
          {(
            [
              { id: 'inspector', label: 'Properties' },
              { id: 'export', label: 'Export' },
              { id: 'assistant', label: 'AI Assist' },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onTabChange(t.id)}
              className={`flex items-center justify-center gap-1 rounded-lg py-1.5 text-[11px] font-semibold transition ${
                activeTab === t.id
                  ? 'bg-[#1a2130] text-white'
                  : 'text-[#838ea4] hover:text-[#cfd6e4]'
              }`}
            >
              {t.id === 'assistant' && <Cpu className="h-3 w-3 text-[#8ed90b]" />}
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === 'assistant' ? (
        <AiAssistantPanel
          systemStatus={systemStatus}
          currentPrompt={currentPrompt}
          settings={settings}
          activeModelName={model?.name ?? null}
          lastSpec={lastSpec ?? model?.structuredSpec ?? null}
          diagnosis={diagnosis}
          onApplySpec={onApplySpec}
          onOpenSettings={onOpenSettings}
        />
      ) : activeTab === 'export' ? (
        <div className="flex-1 space-y-4 overflow-y-auto p-3.5 text-xs">
          {!model ? (
            <div className="rounded-xl border border-[#21293a] bg-[#0d1118] p-4 text-center text-[#838ea4]">
              Select or generate a validated 3D model to unlock genuine GLB and GLTF downloads.
            </div>
          ) : (
            <>
              {/* Asset Export Summary */}
              <div className="rounded-xl border border-[#222a3c] bg-[#0d1118] p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-xs font-semibold text-white">{model.name}</h3>
                    <p className="mt-0.5 text-[11px] text-[#838ea4]">
                      {model.isDemo
                        ? 'Demo Sample Asset (Real GLB 2.0)'
                        : model.sourceType === 'user_import'
                        ? 'User-Imported GLB 2.0'
                        : `Generated via ${model.providerId}`}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                      model.validated
                        ? 'border border-[#76b900]/40 bg-[#76b900]/14 text-[#a3e635]'
                        : 'border border-rose-500/40 bg-rose-500/12 text-rose-300'
                    }`}
                  >
                    {model.validated ? 'Validated' : 'Invalid'}
                  </span>
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-[#1c2332] pt-3 text-[11px]">
                  <div>
                    <dt className="text-[#737e94]">Binary Size</dt>
                    <dd className="mt-0.5 font-mono-tech font-medium text-white">
                      {formatBytes(model.fileSizeBytes)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[#737e94]">glTF Spec</dt>
                    <dd className="mt-0.5 font-mono-tech font-medium text-white">
                      v{model.validationReport.gltfVersion}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[#737e94]">UVs / PBR</dt>
                    <dd className="mt-0.5 font-mono-tech text-[#d8deea]">
                      {model.statistics.hasUVs ? 'UV0' : 'No UV'} /{' '}
                      {model.statistics.hasPbrMaterials ? 'PBR' : 'Basic'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[#737e94]">Animations</dt>
                    <dd className="mt-0.5 font-mono-tech text-[#d8deea]">
                      {model.statistics.animationCount} clip
                      {model.statistics.animationCount === 1 ? '' : 's'}
                    </dd>
                  </div>
                </dl>
              </div>

              {/* Primary GLB Export */}
              <div className="space-y-2.5">
                <button
                  type="button"
                  disabled={!model.validated || downloadingFmt !== null}
                  onClick={() => void handleExport('glb')}
                  className="flex w-full items-center justify-between rounded-xl bg-[#76b900] px-4 py-3 text-xs font-semibold text-[#080d03] transition hover:bg-[#8ed90b] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="flex items-center gap-2">
                    {downloadingFmt === 'glb' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                    <span>Download GLB</span>
                  </span>
                  <span className="rounded bg-black/15 px-2 py-0.5 font-mono-tech text-[11px]">
                    {formatBytes(model.fileSizeBytes)}
                  </span>
                </button>

                {/* Separate GLTF 2.0 JSON Export */}
                {model.gltfExportSupported && (
                  <button
                    type="button"
                    disabled={!model.validated || downloadingFmt !== null}
                    onClick={() => void handleExport('gltf')}
                    className="flex w-full items-center justify-between rounded-xl border border-[#2a3448] bg-[#161c28] px-4 py-2.5 text-xs font-medium text-[#e6eaf2] transition hover:border-[#3e4c68] hover:bg-[#1c2434] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="flex items-center gap-2">
                      {downloadingFmt === 'gltf' ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-[#8ed90b]" />
                      ) : (
                        <Download className="h-3.5 w-3.5 text-[#8ed90b]" />
                      )}
                      <span>Export Separate GLTF (.gltf)</span>
                    </span>
                    <span className="font-mono-tech text-[10px] text-[#8d97ab]">Embedded 2.0</span>
                  </button>
                )}

                {/* Re-run Binary Validator */}
                <button
                  type="button"
                  disabled={validating}
                  onClick={() => void handleRevalidate()}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-[#222a3c] bg-[#0e121a] px-3 py-2 text-[11px] font-medium text-[#aeb7c9] transition hover:border-[#333f57] hover:text-white disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${validating ? 'animate-spin' : ''}`} />
                  <span>{validating ? 'Validating GLB Binary...' : 'Re-Run GLB Validation'}</span>
                </button>
              </div>

              {/* Streaming Download Progress Bar */}
              {downloadProgress && (
                <div className="rounded-xl border border-[#242e42] bg-[#0d1118] p-3">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-[#cfd6e4]">Transfer Progress</span>
                    <span className="font-mono-tech text-[#a3e635]">
                      {downloadProgress.percent}% ({formatBytes(downloadProgress.loadedBytes)} /{' '}
                      {formatBytes(downloadProgress.totalBytes)})
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[#1c2434]">
                    <div
                      className="h-full rounded-full bg-[#8ed90b] transition-all duration-150"
                      style={{ width: `${downloadProgress.percent}%` }}
                    />
                  </div>
                </div>
              )}

              {exportNotice && (
                <div
                  className={`flex items-start gap-2 rounded-xl border p-3 text-[11px] ${
                    exportNotice.type === 'success'
                      ? 'border-[#76b900]/35 bg-[#76b900]/10 text-[#d8f3a2]'
                      : 'border-rose-500/35 bg-rose-500/10 text-rose-200'
                  }`}
                >
                  {exportNotice.type === 'success' ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#8ed90b]" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" />
                  )}
                  <span>{exportNotice.text}</span>
                </div>
              )}

              {/* Preserved Channels Note */}
              <div className="rounded-xl border border-[#1e2536] bg-[#0c0f16] p-3 text-[11px] leading-relaxed text-[#838ea4]">
                <p className="font-medium text-[#b9c2d4]">Preserved Asset Channels</p>
                <p className="mt-1">
                  Exports preserve indexed mesh geometry, vertex normals, TEXCOORD_0 UVs, embedded
                  PBR textures, metallic-roughness factors, and keyframe animations. SHA-256:{' '}
                  <span className="font-mono-tech text-[#9aa4b8]">
                    {model.sha256.slice(0, 16)}...
                  </span>
                </p>
              </div>

              {!model.isDemo && (
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => void handleDelete()}
                  className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-rose-500/30 bg-rose-500/8 px-3 py-2 text-[11px] font-medium text-rose-300 transition hover:bg-rose-500/16 disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Delete Model</span>
                </button>
              )}
            </>
          )}
        </div>
      ) : (
        /* Properties / Inspector Tab */
        <div className="flex-1 space-y-4 overflow-y-auto p-3.5 text-xs">
          {model ? (
            <>
              {/* Title & Provenance */}
              <div>
                <h3 className="text-sm font-semibold text-white">{model.name}</h3>
                <p className="mt-1 text-[11px] leading-relaxed text-[#8d97ab]">
                  {model.description}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
                  <span className="rounded border border-[#242e42] bg-[#151b26] px-2 py-0.5 font-medium text-[#cfd6e4] capitalize">
                    {model.category}
                  </span>
                  <span className="rounded border border-[#242e42] bg-[#151b26] px-2 py-0.5 font-medium text-[#9aa4b8] capitalize">
                    {model.style}
                  </span>
                  <span className="font-mono-tech text-[#6c778d]">
                    {formatRelativeTime(model.createdAt)}
                  </span>
                </div>
              </div>

              {/* Model Statistics Grid */}
              <div>
                <span className="mb-1.5 block text-[11px] font-semibold tracking-wider text-[#cfd6e4] uppercase">
                  Geometry Statistics
                </span>
                <div className="grid grid-cols-2 gap-1.5">
                  {(
                    [
                      ['Vertices', formatCount(verts)],
                      ['Triangles', formatCount(tris)],
                      ['Materials', formatCount(matCount)],
                      ['GLB Size', formatBytes(model.fileSizeBytes)],
                    ] as const
                  ).map(([label, value]) => (
                    <div
                      key={label}
                      className="rounded-xl border border-[#202838] bg-[#0d1118] px-3 py-2"
                    >
                      <span className="text-[10px] text-[#737e94]">{label}</span>
                      <p className="mt-0.5 font-mono-tech text-xs font-semibold text-white">
                        {value}
                      </p>
                    </div>
                  ))}
                </div>

                {/* Dimensions */}
                <div className="mt-1.5 rounded-xl border border-[#202838] bg-[#0d1118] px-3 py-2">
                  <span className="text-[10px] text-[#737e94]">Bounding Dimensions (W x H x D)</span>
                  <p className="mt-0.5 font-mono-tech text-xs font-semibold text-white">
                    {formatDimensionMeters(dims.width)} x {formatDimensionMeters(dims.height)} x{' '}
                    {formatDimensionMeters(dims.depth)}
                  </p>
                </div>
              </div>

              {/* PBR Material Swatches */}
              {model.statistics.materials.length > 0 && (
                <div>
                  <span className="mb-1.5 block text-[11px] font-semibold tracking-wider text-[#cfd6e4] uppercase">
                    PBR Materials ({model.statistics.materials.length})
                  </span>
                  <div className="space-y-1.5">
                    {model.statistics.materials.map((mat, idx) => (
                      <div
                        key={`${mat.name}-${idx}`}
                        className="flex items-center justify-between gap-2 rounded-lg border border-[#1f2737] bg-[#0d1118] px-2.5 py-1.5"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className="h-4 w-4 shrink-0 rounded border border-white/15"
                            style={{ backgroundColor: rgbaFactorToHex(mat.baseColorFactor) }}
                          />
                          <span className="truncate text-[11px] text-[#d8deea]">{mat.name}</span>
                        </div>
                        <span className="shrink-0 font-mono-tech text-[10px] text-[#78839a]">
                          M:{mat.metallicFactor.toFixed(2)} R:{mat.roughnessFactor.toFixed(2)}
                          {mat.hasBaseColorTexture ? ' TEX' : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Binary GLB Validation Card */}
              <div className="rounded-xl border border-[#202838] bg-[#0d1118] p-3">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold text-white">
                    <FileCheck2 className="h-3.5 w-3.5 text-[#8ed90b]" />
                    GLB 2.0 Validation
                  </span>
                  <span
                    className={`font-mono-tech text-[10px] font-semibold ${
                      model.validationReport.valid ? 'text-[#a3e635]' : 'text-rose-400'
                    }`}
                  >
                    {model.validationReport.valid ? 'PASS' : 'FAIL'}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-1 font-mono-tech text-[10px] text-[#838ea4]">
                  <span>JSON: {formatBytes(model.validationReport.jsonChunkBytes)}</span>
                  <span>BIN: {formatBytes(model.validationReport.binChunkBytes)}</span>
                  <span>Textures: {model.statistics.textureCount}</span>
                  <span>Meshes: {model.statistics.meshCount}</span>
                </div>
                {model.validationReport.issues.slice(0, 2).map((issue, idx) => (
                  <p
                    key={idx}
                    className="mt-2 flex items-start gap-1.5 border-t border-[#1c2332] pt-2 text-[10px] leading-relaxed text-[#9aa4b8]"
                  >
                    <Info className="mt-0.5 h-3 w-3 shrink-0 text-[#8ed90b]" />
                    <span>{issue.message}</span>
                  </p>
                ))}
              </div>
            </>
          ) : (
            <div className="rounded-xl border border-[#202838] bg-[#0d1118] p-4 text-center text-[#838ea4]">
              No active model loaded in viewport.
            </div>
          )}

          {/* Quick Demo Showcase Switcher */}
          {demoModels.length > 0 && (
            <div className="border-t border-[#1f2634] pt-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] font-semibold tracking-wider text-[#cfd6e4] uppercase">
                  Demo Sample GLBs
                </span>
                <span className="text-[10px] text-amber-300/90">Sample Assets</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {demoModels.map((dm) => {
                  const isCurrent = model?.id === dm.id;
                  return (
                    <button
                      key={dm.id}
                      type="button"
                      onClick={() => onSelectModel(dm)}
                      className={`rounded-lg border px-2.5 py-2 text-left transition ${
                        isCurrent
                          ? 'border-[#76b900] bg-[#76b900]/14 text-white'
                          : 'border-[#1f2737] bg-[#0d1118] text-[#9aa4b8] hover:border-[#313d56] hover:text-white'
                      }`}
                    >
                      <p className="truncate text-[11px] font-medium">{dm.name}</p>
                      <p className="mt-0.5 font-mono-tech text-[10px] text-[#6d788e] capitalize">
                        {dm.category} · {formatCount(dm.statistics.triangles)}t
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
