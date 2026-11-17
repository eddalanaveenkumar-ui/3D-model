import { useRef, useState } from 'react';
import {
  ArrowRight,
  Box,
  Cpu,
  Download,
  Eye,
  Image as ImageIcon,
  Play,
  Settings,
  Type,
  Upload,
} from 'lucide-react';
import type {
  GeneratedModelRecord,
  GenerationMode,
  SystemStatus,
} from '@nv3d/shared';
import { downloadModelWithProgress } from '../../lib/api';
import {
  formatBytes,
  formatCount,
  formatDimensionMeters,
  rgbaFactorToHex,
} from '../../lib/format';

interface HomeViewProps {
  systemStatus: SystemStatus | null;
  userModels: GeneratedModelRecord[];
  demoModels: GeneratedModelRecord[];
  onStartCreate: (mode: GenerationMode) => void;
  onInspectModel: (model: GeneratedModelRecord) => void;
  onImportGlb: (file: File) => void;
  onOpenSettings: () => void;
}

export function HomeView({
  systemStatus,
  userModels,
  demoModels,
  onStartCreate,
  onInspectModel,
  onImportGlb,
  onOpenSettings,
}: HomeViewProps) {
  const importRef = useRef<HTMLInputElement | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const handleQuickDownload = async (model: GeneratedModelRecord) => {
    if (downloadingId) return;
    setDownloadingId(model.id);
    try {
      await downloadModelWithProgress({
        modelId: model.id,
        format: 'glb',
        fallbackName: model.name,
      });
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-[#0b0e14]">
      <div className="mx-auto max-w-6xl space-y-8 px-4 py-6 sm:px-8 sm:py-8">
        <input
          ref={importRef}
          type="file"
          accept=".glb,model/gltf-binary"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onImportGlb(f);
            e.currentTarget.value = '';
          }}
        />

        {/* Workspace Launch Hero */}
        <section className="rounded-2xl border border-[#1f2737] bg-gradient-to-br from-[#121722] via-[#10141e] to-[#0c1018] p-6 sm:p-8">
          <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
            <div className="max-w-2xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-[#76b900]/35 bg-[#76b900]/10 px-3 py-1 text-[11px] font-medium text-[#a3e635]">
                <Cpu className="h-3.5 w-3.5" />
                <span>NVIDIA NIM MiniMax M3.1 Flash Orchestration + Modular 3D Pipeline</span>
              </div>
              <h1 className="mt-3.5 text-2xl font-bold tracking-tight text-white sm:text-3xl">
                Generate, inspect, and export production GLB 3D assets
              </h1>
              <p className="mt-2.5 text-sm leading-relaxed text-[#95a0b5]">
                Transform text descriptions or multi-view reference images into validated glTF 2.0
                models with studio PBR lighting, wireframe inspection, mesh statistics, and genuine
                GLB/GLTF downloads.
              </p>
            </div>

            {/* Pipeline Readiness Indicator */}
            {systemStatus && (
              <button
                type="button"
                onClick={onOpenSettings}
                className="flex shrink-0 items-center gap-3 self-start rounded-xl border border-[#242e42] bg-[#0c1017] px-4 py-3 text-left transition hover:border-[#384663] lg:self-auto"
              >
                <div>
                  <div className="flex items-center gap-2 text-xs font-semibold text-white">
                    <span
                      className={`h-2 w-2 rounded-full ${
                        systemStatus.demoMode ? 'bg-amber-400' : 'bg-[#8ed90b]'
                      }`}
                    />
                    <span>
                      {systemStatus.demoMode
                        ? 'Demo Mode (Provider Unconfigured)'
                        : `${systemStatus.activeProvider?.displayName} Connected`}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-[#7e899f]">
                    NIM:{' '}
                    {systemStatus.nim.configured ? 'Configured' : 'Set NVIDIA_NIM_API_KEY'} · DB:{' '}
                    {systemStatus.database.tables.length} tables active
                  </p>
                </div>
                <Settings className="h-4 w-4 text-[#838ea4]" />
              </button>
            )}
          </div>

          {/* 3 Primary Studio Workflows */}
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <button
              type="button"
              onClick={() => onStartCreate('text')}
              className="group flex flex-col justify-between rounded-xl border border-[#76b900]/40 bg-[#76b900]/10 p-4 text-left transition hover:border-[#8ed90b] hover:bg-[#76b900]/16"
            >
              <div className="flex items-center justify-between">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#76b900] text-[#080d03]">
                  <Type className="h-4 w-4" />
                </span>
                <ArrowRight className="h-4 w-4 text-[#a3e635] transition-transform group-hover:translate-x-0.5" />
              </div>
              <div className="mt-4">
                <h2 className="text-sm font-semibold text-white">Text to 3D</h2>
                <p className="mt-1 text-xs text-[#aeb7c9]">
                  MiniMax enhances prompts for humans, animals, cars, architecture, furniture, props, trees & scenes.
                </p>
              </div>
            </button>

            <button
              type="button"
              onClick={() => onStartCreate('image')}
              className="group flex flex-col justify-between rounded-xl border border-[#242e42] bg-[#131926] p-4 text-left transition hover:border-[#3c4b68] hover:bg-[#171f2f]"
            >
              <div className="flex items-center justify-between">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#2d3850] bg-[#0e131d] text-[#8ed90b]">
                  <ImageIcon className="h-4 w-4" />
                </span>
                <ArrowRight className="h-4 w-4 text-[#78839a] transition-transform group-hover:translate-x-0.5 group-hover:text-white" />
              </div>
              <div className="mt-4">
                <h2 className="text-sm font-semibold text-white">Image to 3D</h2>
                <p className="mt-1 text-xs text-[#8d97ab]">
                  Drag & drop PNG, JPG, or WEBP references with front, side, and back multi-view support.
                </p>
              </div>
            </button>

            <button
              type="button"
              onClick={() => importRef.current?.click()}
              className="group flex flex-col justify-between rounded-xl border border-[#242e42] bg-[#131926] p-4 text-left transition hover:border-[#3c4b68] hover:bg-[#171f2f]"
            >
              <div className="flex items-center justify-between">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#2d3850] bg-[#0e131d] text-[#8ed90b]">
                  <Upload className="h-4 w-4" />
                </span>
                <ArrowRight className="h-4 w-4 text-[#78839a] transition-transform group-hover:translate-x-0.5 group-hover:text-white" />
              </div>
              <div className="mt-4">
                <h2 className="text-sm font-semibold text-white">Validate & Inspect GLB</h2>
                <p className="mt-1 text-xs text-[#8d97ab]">
                  Import any existing binary .glb file to verify chunks, inspect PBR topology, and export GLTF.
                </p>
              </div>
            </button>
          </div>
        </section>

        {/* User's Own Models (if any) */}
        {userModels.length > 0 && (
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">
                Your Recent 3D Models ({userModels.length})
              </h2>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {userModels.slice(0, 4).map((m) => (
                <div
                  key={m.id}
                  className="flex flex-col justify-between rounded-xl border border-[#232c3f] bg-[#111621] p-4 transition hover:border-[#394764]"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="rounded bg-[#76b900]/14 px-2 py-0.5 text-[10px] font-semibold text-[#a3e635] uppercase">
                        {m.sourceType === 'user_import' ? 'Imported' : 'Generated'}
                      </span>
                      <span className="font-mono-tech text-[10px] text-[#78839a]">
                        {formatBytes(m.fileSizeBytes)}
                      </span>
                    </div>
                    <h3 className="mt-2.5 truncate text-xs font-semibold text-white">{m.name}</h3>
                    <p className="mt-1 font-mono-tech text-[10px] text-[#838ea4]">
                      {formatCount(m.statistics.vertices)} verts ·{' '}
                      {formatCount(m.statistics.triangles)} tris
                    </p>
                  </div>
                  <div className="mt-3 flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => onInspectModel(m)}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#1b2232] py-1.5 text-[11px] font-medium text-white transition hover:bg-[#76b900] hover:text-[#080d03]"
                    >
                      <Eye className="h-3.5 w-3.5" />
                      <span>Inspect</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleQuickDownload(m)}
                      title="Download GLB"
                      className="flex items-center justify-center rounded-lg border border-[#2a3448] px-2.5 py-1.5 text-[#aeb7c9] transition hover:border-[#8ed90b] hover:text-white"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Validated Demo Sample GLB Showcase (All 8 Supported Categories) */}
        <section>
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-white">
                Demo Sample GLB Library — Interactive Viewer & Export Showcase
              </h2>
              <p className="mt-0.5 text-xs text-[#838ea4]">
                Genuine, binary-validated glTF 2.0 sample assets with PBR materials, UVs, textures,
                and animations across all 8 studio categories (clearly labeled as demo samples).
              </p>
            </div>
          </div>

          <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
            {demoModels.map((model) => (
              <article
                key={model.id}
                className="group flex flex-col justify-between rounded-xl border border-[#1f2737] bg-[#111520] p-4 transition hover:border-[#364460] hover:bg-[#141926]"
              >
                <div>
                  {/* Visual Preview Header */}
                  <div className="relative flex h-24 items-center justify-center rounded-lg border border-[#1d2535] bg-gradient-to-b from-[#171d2b] to-[#0d1118]">
                    <Box className="h-8 w-8 text-[#8ed90b]/80 transition-transform duration-200 group-hover:scale-110" />
                    <span className="absolute top-2 left-2 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold tracking-wider text-amber-300 uppercase">
                      Demo Sample
                    </span>
                    {model.statistics.animationCount > 0 && (
                      <span className="absolute top-2 right-2 flex items-center gap-0.5 rounded border border-[#76b900]/35 bg-[#76b900]/12 px-1.5 py-0.5 text-[9px] font-semibold text-[#a3e635]">
                        <Play className="h-2.5 w-2.5" />
                        Anim
                      </span>
                    )}
                    {/* Material Color Swatches */}
                    <div className="absolute right-2 bottom-2 flex items-center gap-1">
                      {model.statistics.materials.slice(0, 5).map((mat, i) => (
                        <span
                          key={i}
                          title={mat.name}
                          className="h-3 w-3 rounded-full border border-white/20"
                          style={{ backgroundColor: rgbaFactorToHex(mat.baseColorFactor) }}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="mt-3">
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="font-semibold tracking-wider text-[#8ed90b] uppercase">
                        {model.category}
                      </span>
                      <span className="font-mono-tech text-[#78839a]">
                        {formatBytes(model.fileSizeBytes)}
                      </span>
                    </div>
                    <h3 className="mt-1 truncate text-xs font-semibold text-white">{model.name}</h3>
                    <p className="mt-1 font-mono-tech text-[10px] text-[#838ea4]">
                      {formatCount(model.statistics.triangles)} tris ·{' '}
                      {formatDimensionMeters(model.statistics.dimensions.width)} x{' '}
                      {formatDimensionMeters(model.statistics.dimensions.height)} x{' '}
                      {formatDimensionMeters(model.statistics.dimensions.depth)}
                    </p>
                  </div>
                </div>

                <div className="mt-3.5 flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => onInspectModel(model)}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#1a2130] px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-[#76b900] hover:text-[#080d03]"
                  >
                    <Eye className="h-3.5 w-3.5" />
                    <span>Open in 3D</span>
                  </button>
                  <button
                    type="button"
                    disabled={downloadingId === model.id}
                    onClick={() => void handleQuickDownload(model)}
                    title={`Download ${model.name} (.glb)`}
                    className="flex items-center justify-center rounded-lg border border-[#283247] bg-[#0e121a] px-2.5 py-1.5 text-[11px] font-medium text-[#cfd6e4] transition hover:border-[#8ed90b] hover:text-white disabled:opacity-50"
                  >
                    <Download className="h-3.5 w-3.5" />
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
