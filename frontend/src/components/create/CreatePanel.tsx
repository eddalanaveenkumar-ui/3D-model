import { useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Image as ImageIcon,
  Loader2,
  Shield,
  Sliders,
  Sparkles,
  Type,
  Wand2,
} from 'lucide-react';
import {
  ART_STYLES,
  ASSET_CATEGORIES,
  calculateGenerationCreditCost,
  POLYGON_BUDGET_MAP,
  type AssetCategory,
  type GenerationJobRecord,
  type GenerationMode,
  type GenerationSettings,
  type ImageViewAngle,
  type OutputFormat,
  type PolygonDetail,
  type QualityTier,
  type StructuredGenerationSpec,
  type SystemStatus,
  type TextureResolution,
} from '@nv3d/shared';
import { formatCount } from '../../lib/format';
import { ImageDropSlot } from './ImageDropSlot';
import { JobStatusCard } from './JobStatusCard';

const CATEGORY_PROMPT_PRESETS: Record<AssetCategory, string> = {
  prop: 'Precision field telemetry beacon in brushed titanium with copper induction coils, tempered glass chamber, and glowing emerald core, clean PBR materials',
  car: 'Aerodynamic electric GT coupe with sculpted silver metallic bodywork, flush panoramic glass canopy, carbon rear diffuser, and forged five-spoke alloy wheels',
  furniture: 'Mid-century Nordic lounge armchair with oiled walnut timber frame, curved armrests, charcoal woven boucle cushions, and brushed brass leg ferrules',
  building: 'Modernist architectural courtyard pavilion with cantilevered board-formed concrete roof, warm cedar vertical louvers, floor-to-ceiling glazing, and reflecting pool',
  tree: 'Mature courtyard oak tree with textured gnarled bark trunk, spreading secondary limbs, layered emerald leaf clusters, set in a carved basalt planter',
  human: 'Futuristic deep-space exploration astronaut in clean symmetrical A-pose, ceramic-white pressure suit, anodized joints, gold-tinted visor, unarmed',
  animal: 'Stylized red fox standing alert with warm terracotta fur, cream chest ruff, pointed black-tipped ears, and lush white-tipped tail',
  environment: 'Floating alpine island diorama with faceted basalt cliffs, snow-capped mountain peaks, evergreen pine grove, and clear glacial stream',
};

interface CreatePanelProps {
  mode: GenerationMode;
  onModeChange: (mode: GenerationMode) => void;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  imageFiles: Partial<Record<ImageViewAngle, File>>;
  onImageFileChange: (angle: ImageViewAngle, file: File | null) => void;
  settings: GenerationSettings;
  onSettingsChange: (next: GenerationSettings) => void;
  systemStatus: SystemStatus | null;
  submitting: boolean;
  enhancing: boolean;
  lastSpec: StructuredGenerationSpec | null;
  activeJob: GenerationJobRecord | null;
  formError: string | null;
  onClearError: () => void;
  onEnhancePrompt: () => void;
  onAnalyzeImages: () => void;
  onSubmitGenerate: () => void;
  onOpenSettings: () => void;
  onInspectMatchingDemo: (category: AssetCategory) => void;
  onExplainError: (errorCode: string, errorMessage: string, providerId: string | null) => void;
}

export function CreatePanel({
  mode,
  onModeChange,
  prompt,
  onPromptChange,
  imageFiles,
  onImageFileChange,
  settings,
  onSettingsChange,
  systemStatus,
  submitting,
  enhancing,
  lastSpec,
  activeJob,
  formError,
  onClearError,
  onEnhancePrompt,
  onAnalyzeImages,
  onSubmitGenerate,
  onOpenSettings,
  onInspectMatchingDemo,
  onExplainError,
}: CreatePanelProps) {
  const [multiViewOpen, setMultiViewOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [localImgErr, setLocalImgErr] = useState<string | null>(null);

  const creditCost = calculateGenerationCreditCost(settings, mode);
  const maxUploadMb = systemStatus?.limits.maxUploadMb ?? 15;
  const activeCaps = systemStatus?.activeProvider?.capabilities;
  const multiViewSupported = activeCaps ? activeCaps.multiViewImageTo3D : true;
  const riggingSupported = activeCaps ? activeCaps.rigging : false;
  const animationSupported = activeCaps ? activeCaps.animation : false;
  const isDemoMode = systemStatus?.demoMode ?? true;
  const nimConfigured = systemStatus?.nim.configured ?? false;

  const isJobActive = activeJob
    ? ['queued', 'enhancing', 'submitting', 'processing', 'downloading', 'optimizing', 'validating'].includes(
        activeJob.status
      )
    : false;

  const updateSetting = <K extends keyof GenerationSettings>(
    key: K,
    value: GenerationSettings[K]
  ) => {
    onSettingsChange({ ...settings, [key]: value });
  };

  return (
    <div className="flex h-full flex-col bg-[#11141c]">
      {/* Mode Switch Header */}
      <div className="shrink-0 border-b border-[#1f2634] p-3">
        <div className="grid grid-cols-2 gap-1 rounded-xl border border-[#232b3c] bg-[#0b0e14] p-1">
          <button
            type="button"
            onClick={() => {
              onModeChange('text');
              onClearError();
              setLocalImgErr(null);
            }}
            className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition ${
              mode === 'text'
                ? 'bg-[#1a2130] text-white shadow-xs'
                : 'text-[#838ea4] hover:text-[#cfd6e4]'
            }`}
          >
            <Type className="h-3.5 w-3.5 text-[#8ed90b]" />
            <span>Text to 3D</span>
          </button>
          <button
            type="button"
            onClick={() => {
              onModeChange('image');
              onClearError();
              setLocalImgErr(null);
            }}
            className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition ${
              mode === 'image'
                ? 'bg-[#1a2130] text-white shadow-xs'
                : 'text-[#838ea4] hover:text-[#cfd6e4]'
            }`}
          >
            <ImageIcon className="h-3.5 w-3.5 text-[#8ed90b]" />
            <span>Image to 3D</span>
          </button>
        </div>
      </div>

      {/* Scrollable Controls */}
      <div className="flex-1 space-y-4 overflow-y-auto p-3.5">
        {/* Explicit Demo Mode / Set NVIDIA API Key Banner */}
        {isDemoMode && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 px-3 py-2.5 text-[11px] leading-relaxed text-amber-200/90">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-amber-300">Add NVIDIA NIM API Key</span>
              <button
                type="button"
                onClick={onOpenSettings}
                className="font-medium text-amber-300 underline decoration-amber-400/50 underline-offset-2 hover:text-white"
              >
                Paste key
              </button>
            </div>
            <p className="mt-0.5 text-[#b9c2d4]">
              Paste your <code className="font-mono-tech text-[#dfe5f0]">nvapi-...</code> key (saved
              in browser localStorage — no login needed) to generate 3D models, or inspect the 8
              validated Demo Sample GLBs.
            </p>
          </div>
        )}

        {mode === 'text' ? (
          <>
            {/* Text Prompt Input */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label
                  htmlFor="nv3d-text-prompt"
                  className="text-[11px] font-semibold tracking-wider text-[#cfd6e4] uppercase"
                >
                  Prompt
                </label>
                <button
                  type="button"
                  disabled={enhancing || prompt.trim().length < 3}
                  onClick={onEnhancePrompt}
                  title={
                    nimConfigured
                      ? 'Enhance and structure prompt via NVIDIA NIM MiniMax M3.1 Flash'
                      : 'Requires NVIDIA_NIM_API_KEY configured on backend'
                  }
                  className="flex items-center gap-1 rounded-md border border-[#283247] bg-[#161c28] px-2 py-1 text-[11px] font-medium text-[#a3e635] transition hover:border-[#76b900]/50 hover:bg-[#76b900]/12 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {enhancing ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Wand2 className="h-3 w-3" />
                  )}
                  <span>Enhance (MiniMax)</span>
                </button>
              </div>

              <textarea
                id="nv3d-text-prompt"
                rows={5}
                maxLength={2000}
                value={prompt}
                onChange={(e) => {
                  onPromptChange(e.target.value);
                  if (formError) onClearError();
                }}
                placeholder="Describe your 3D model: subject, form, materials, surface finish, and pose (e.g., sculpted walnut lounge chair with charcoal boucle cushions and brass feet)..."
                className="w-full resize-none rounded-xl border border-[#242d40] bg-[#0b0e14] p-3 text-xs leading-relaxed text-[#e6eaf2] placeholder-[#596377] transition focus:border-[#76b900] focus:outline-none"
              />

              <div className="mt-1 flex items-center justify-between text-[10px] text-[#6d788e]">
                <span className="flex items-center gap-1">
                  <Shield className="h-3 w-3 text-[#76b900]" />
                  Weapons-free asset studio
                </span>
                <span className="font-mono-tech">{prompt.length}/2000</span>
              </div>
            </div>

            {/* Category Selector + Quick Sample Prompt */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[11px] font-semibold tracking-wider text-[#cfd6e4] uppercase">
                  Asset Category
                </span>
                <button
                  type="button"
                  onClick={() => onPromptChange(CATEGORY_PROMPT_PRESETS[settings.category])}
                  className="text-[11px] text-[#8ed90b] hover:underline"
                >
                  Sample prompt
                </button>
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {ASSET_CATEGORIES.map((cat) => {
                  const selected = settings.category === cat.id;
                  return (
                    <button
                      key={cat.id}
                      type="button"
                      title={cat.hint}
                      onClick={() => updateSetting('category', cat.id)}
                      className={`rounded-lg border px-2 py-1.5 text-[11px] font-medium transition ${
                        selected
                          ? 'border-[#76b900] bg-[#76b900]/15 text-white'
                          : 'border-[#21293a] bg-[#0e121a] text-[#8d97ab] hover:border-[#313c54] hover:text-[#d8deea]'
                      }`}
                    >
                      {cat.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        ) : (
          <>
            {/* Image-to-3D Upload Zone */}
            <ImageDropSlot
              angle="front"
              label="Primary / Front Reference"
              required
              file={imageFiles.front ?? null}
              maxUploadMb={maxUploadMb}
              onSelect={(f) => {
                setLocalImgErr(null);
                onClearError();
                onImageFileChange('front', f);
              }}
              onValidationError={(msg) => setLocalImgErr(msg)}
            />

            {/* Multi-View Front/Side/Back Accordion */}
            <div className="rounded-xl border border-[#21293a] bg-[#0e121a] p-2.5">
              <button
                type="button"
                onClick={() => setMultiViewOpen((o) => !o)}
                className="flex w-full items-center justify-between text-left text-[11px] font-medium text-[#cfd6e4]"
              >
                <span>
                  Side & Back Views{' '}
                  <span className="text-[#737e94]">
                    ({multiViewSupported ? 'optional multi-view' : 'provider uses front only'})
                  </span>
                </span>
                {multiViewOpen ? (
                  <ChevronUp className="h-3.5 w-3.5 text-[#838ea4]" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 text-[#838ea4]" />
                )}
              </button>

              {multiViewOpen && (
                <div className="mt-2.5 grid grid-cols-2 gap-2">
                  <ImageDropSlot
                    angle="side"
                    label="Side View"
                    compact
                    file={imageFiles.side ?? null}
                    maxUploadMb={maxUploadMb}
                    onSelect={(f) => {
                      setLocalImgErr(null);
                      onImageFileChange('side', f);
                    }}
                    onValidationError={(msg) => setLocalImgErr(msg)}
                  />
                  <ImageDropSlot
                    angle="back"
                    label="Back View"
                    compact
                    file={imageFiles.back ?? null}
                    maxUploadMb={maxUploadMb}
                    onSelect={(f) => {
                      setLocalImgErr(null);
                      onImageFileChange('back', f);
                    }}
                    onValidationError={(msg) => setLocalImgErr(msg)}
                  />
                </div>
              )}
            </div>

            {/* Optional Guidance & Multimodal Analysis */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label
                  htmlFor="nv3d-image-notes"
                  className="text-[11px] font-medium text-[#aeb7c9]"
                >
                  Reconstruction Notes (optional)
                </label>
                <button
                  type="button"
                  disabled={enhancing || !imageFiles.front}
                  onClick={onAnalyzeImages}
                  className="flex items-center gap-1 rounded-md border border-[#283247] bg-[#161c28] px-2 py-1 text-[11px] font-medium text-[#a3e635] transition hover:border-[#76b900]/50 hover:bg-[#76b900]/12 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {enhancing ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Sparkles className="h-3 w-3" />
                  )}
                  <span>Analyze Reference</span>
                </button>
              </div>
              <textarea
                id="nv3d-image-notes"
                rows={2}
                maxLength={1000}
                value={prompt}
                onChange={(e) => onPromptChange(e.target.value)}
                placeholder="Surface hints, unseen back geometry notes, or desired material finish..."
                className="w-full resize-none rounded-xl border border-[#242d40] bg-[#0b0e14] p-2.5 text-xs text-[#e6eaf2] placeholder-[#596377] focus:border-[#76b900] focus:outline-none"
              />
            </div>
          </>
        )}

        {/* Art Style */}
        <div>
          <label
            htmlFor="nv3d-art-style"
            className="mb-1.5 block text-[11px] font-semibold tracking-wider text-[#cfd6e4] uppercase"
          >
            Surface Style
          </label>
          <select
            id="nv3d-art-style"
            value={settings.style}
            onChange={(e) => updateSetting('style', e.target.value as GenerationSettings['style'])}
            className="w-full rounded-xl border border-[#242d40] bg-[#0b0e14] px-3 py-2 text-xs font-medium text-[#e6eaf2] focus:border-[#76b900] focus:outline-none"
          >
            {ART_STYLES.map((st) => (
              <option key={st.id} value={st.id} className="bg-[#11141c]">
                {st.label}
              </option>
            ))}
          </select>
        </div>

        {/* MiniMax Enhanced Spec Preview (when run standalone) */}
        {lastSpec && lastSpec.orchestrator === 'nvidia-nim-minimax' && (
          <div className="rounded-xl border border-[#76b900]/35 bg-[#76b900]/8 p-3 text-[11px]">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-[#a3e635]">
                MiniMax Spec: {lastSpec.title}
              </span>
              <button
                type="button"
                onClick={() => onPromptChange(lastSpec.enhancedPrompt)}
                className="font-medium text-white underline underline-offset-2 hover:text-[#a3e635]"
              >
                Use prompt
              </button>
            </div>
            <p className="mt-1 line-clamp-3 text-[#c8d0df]">{lastSpec.enhancedPrompt}</p>
          </div>
        )}

        {/* Generation Settings Section */}
        <div className="rounded-xl border border-[#202838] bg-[#0d1118]">
          <button
            type="button"
            onClick={() => setSettingsOpen((o) => !o)}
            className="flex w-full items-center justify-between px-3 py-2.5 text-left"
          >
            <span className="flex items-center gap-2 text-[11px] font-semibold tracking-wider text-[#cfd6e4] uppercase">
              <Sliders className="h-3.5 w-3.5 text-[#8ed90b]" />
              Generation Settings
            </span>
            {settingsOpen ? (
              <ChevronUp className="h-3.5 w-3.5 text-[#7e899f]" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 text-[#7e899f]" />
            )}
          </button>

          {settingsOpen && (
            <div className="space-y-3 border-t border-[#1c2332] px-3 py-3 text-xs">
              {/* Quality */}
              <div>
                <span className="mb-1 block text-[11px] text-[#9aa4b8]">Quality</span>
                <div className="grid grid-cols-3 gap-1">
                  {(['draft', 'standard', 'high'] as QualityTier[]).map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => updateSetting('quality', q)}
                      className={`rounded-lg border py-1.5 text-[11px] font-medium capitalize transition ${
                        settings.quality === q
                          ? 'border-[#76b900] bg-[#76b900]/16 text-white'
                          : 'border-[#202838] bg-[#121722] text-[#8d97ab] hover:text-white'
                      }`}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>

              {/* Polygon Detail */}
              <div>
                <div className="mb-1 flex items-center justify-between text-[11px]">
                  <span className="text-[#9aa4b8]">Polygon Detail</span>
                  <span className="font-mono-tech text-[10px] text-[#78839a]">
                    ~{formatCount(POLYGON_BUDGET_MAP[settings.polygonDetail])} tris
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-1">
                  {(['low', 'medium', 'high'] as PolygonDetail[]).map((pd) => (
                    <button
                      key={pd}
                      type="button"
                      onClick={() => updateSetting('polygonDetail', pd)}
                      className={`rounded-lg border py-1.5 text-[11px] font-medium capitalize transition ${
                        settings.polygonDetail === pd
                          ? 'border-[#76b900] bg-[#76b900]/16 text-white'
                          : 'border-[#202838] bg-[#121722] text-[#8d97ab] hover:text-white'
                      }`}
                    >
                      {pd}
                    </button>
                  ))}
                </div>
              </div>

              {/* Texture Resolution */}
              <div>
                <span className="mb-1 block text-[11px] text-[#9aa4b8]">Texture Resolution</span>
                <div className="grid grid-cols-3 gap-1">
                  {(['1k', '2k', '4k'] as TextureResolution[]).map((tr) => (
                    <button
                      key={tr}
                      type="button"
                      onClick={() => updateSetting('textureResolution', tr)}
                      className={`rounded-lg border py-1.5 font-mono-tech text-[11px] font-medium uppercase transition ${
                        settings.textureResolution === tr
                          ? 'border-[#76b900] bg-[#76b900]/16 text-white'
                          : 'border-[#202838] bg-[#121722] text-[#8d97ab] hover:text-white'
                      }`}
                    >
                      {tr}
                    </button>
                  ))}
                </div>
              </div>

              {/* Preferred Output Format */}
              <div>
                <span className="mb-1 block text-[11px] text-[#9aa4b8]">Output Format</span>
                <div className="grid grid-cols-2 gap-1">
                  {(
                    [
                      ['glb', 'GLB 2.0 (Binary)'],
                      ['gltf', 'GLB + GLTF 2.0'],
                    ] as Array<[OutputFormat, string]>
                  ).map(([fmt, lbl]) => (
                    <button
                      key={fmt}
                      type="button"
                      onClick={() => updateSetting('outputFormat', fmt)}
                      className={`rounded-lg border py-1.5 text-[11px] font-medium transition ${
                        settings.outputFormat === fmt
                          ? 'border-[#76b900] bg-[#76b900]/16 text-white'
                          : 'border-[#202838] bg-[#121722] text-[#8d97ab] hover:text-white'
                      }`}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
              </div>

              {/* Boolean Pipeline Switches */}
              <div className="space-y-2 border-t border-[#1c2332] pt-2.5">
                {(
                  [
                    {
                      key: 'pbr' as const,
                      label: 'PBR Materials',
                      sub: 'Metallic, roughness & normal channels',
                    },
                    {
                      key: 'optimizeSize' as const,
                      label: 'Optimize Model Size',
                      sub: 'Weld vertices & compress textures',
                    },
                    {
                      key: 'rigging' as const,
                      label: 'Auto-Rigging',
                      sub: riggingSupported
                        ? 'Supported by active provider'
                        : 'Where supported (Tripo3D / Custom)',
                    },
                    {
                      key: 'animation' as const,
                      label: 'Idle Animation',
                      sub: animationSupported
                        ? 'Supported by active provider'
                        : 'Where supported (Tripo3D / Custom)',
                    },
                  ] as const
                ).map((item) => {
                  const checked = settings[item.key];
                  return (
                    <label
                      key={item.key}
                      className="flex cursor-pointer items-center justify-between gap-2 py-0.5"
                    >
                      <div>
                        <p className="text-[11px] font-medium text-[#d8deea]">{item.label}</p>
                        <p className="text-[10px] text-[#6d788e]">{item.sub}</p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={checked}
                        aria-label={item.label}
                        onClick={() => updateSetting(item.key, !checked)}
                        className={`relative h-5 w-9 shrink-0 rounded-full transition ${
                          checked ? 'bg-[#76b900]' : 'bg-[#252e40]'
                        }`}
                      >
                        <span
                          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                            checked ? 'translate-x-4.5' : 'translate-x-0.5'
                          }`}
                        />
                      </button>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Inline Validation / Policy Error */}
        {(localImgErr || formError) && (
          <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 p-3 text-xs text-rose-200">
            {localImgErr || formError}
          </div>
        )}

        {/* Active / Most Recent Generation Job Card */}
        {activeJob && (
          <JobStatusCard
            job={activeJob}
            onOpenSettings={onOpenSettings}
            onInspectMatchingDemo={onInspectMatchingDemo}
            onExplainError={onExplainError}
          />
        )}
      </div>

      {/* Sticky Generate Action Footer */}
      <div className="shrink-0 border-t border-[#1f2634] bg-[#0e1118] p-3">
        <button
          type="button"
          disabled={
            submitting ||
            isJobActive ||
            (mode === 'text' ? prompt.trim().length < 3 : !imageFiles.front)
          }
          onClick={onSubmitGenerate}
          className="flex w-full items-center justify-between rounded-xl bg-[#76b900] px-4 py-2.5 text-xs font-semibold text-[#080d03] shadow-sm transition hover:bg-[#8ed90b] disabled:cursor-not-allowed disabled:bg-[#252e3f] disabled:text-[#6e7990]"
        >
          <span className="flex items-center gap-2">
            {submitting || isJobActive ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            <span>
              {isJobActive
                ? 'Generating 3D Asset...'
                : submitting
                ? 'Submitting Job...'
                : mode === 'text'
                ? 'Generate 3D Model'
                : 'Reconstruct 3D Model'}
            </span>
          </span>
          <span className="rounded bg-black/15 px-2 py-0.5 font-mono-tech text-[11px]">
            {isDemoMode
              ? 'Demo'
              : systemStatus?.nim.keySource === 'browser-storage'
              ? 'Local Key'
              : `${creditCost} CR`}
          </span>
        </button>
      </div>
    </div>
  );
}
