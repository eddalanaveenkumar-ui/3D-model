import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  DEFAULT_GENERATION_SETTINGS,
  type AssetCategory,
  type GeneratedModelRecord,
  type GenerationJobRecord,
  type GenerationMode,
  type GenerationSettings,
  type ImageViewAngle,
  type StructuredGenerationSpec,
  type SystemStatus,
} from '@nv3d/shared';
import { CreatePanel } from './components/create/CreatePanel';
import type { ErrorDiagnosisState } from './components/inspector/AiAssistantPanel';
import { RightInspector, type InspectorTab } from './components/inspector/RightInspector';
import { LeftSidebar } from './components/layout/LeftSidebar';
import { TopNav, type NavSection } from './components/layout/TopNav';
import { ApiKeyModal } from './components/settings/ApiKeyModal';
import type { LiveSceneStats } from './components/viewer/ThreeViewport';
import { ViewportSkeleton } from './components/viewer/ViewportSkeleton';
import { HistoryView } from './components/views/HistoryView';
import { HomeView } from './components/views/HomeView';
import { MyModelsView } from './components/views/MyModelsView';
import { SettingsView } from './components/views/SettingsView';
import { api, ApiClientError } from './lib/api';
import {
  cacheModelGlb,
  decodeBase64ToArrayBuffer,
  removeCachedModelGlb,
} from './lib/localGlbCache';
import { getStoredNvidiaApiKey, subscribeNimKeyChanges } from './lib/nimKeyStore';

// Lazy-load Three.js + GLTFLoader + OrbitControls in a separate async chunk
const LazyThreeViewport = lazy(() => import('./components/viewer/ThreeViewport'));

const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'provider_unconfigured']);

export function App() {
  // Navigation & responsive layout state
  const [section, setSection] = useState<NavSection>('create');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<'create' | 'viewport' | 'inspector'>('viewport');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('inspector');
  const [apiKeyModalOpen, setApiKeyModalOpen] = useState(false);
  const [storedNimKey, setStoredNimKey] = useState<string>(() => getStoredNvidiaApiKey());

  // Backend state
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [models, setModels] = useState<GeneratedModelRecord[]>([]);
  const [activeModel, setActiveModel] = useState<GeneratedModelRecord | null>(null);
  const [liveStats, setLiveStats] = useState<LiveSceneStats | null>(null);

  // Create workflow state
  const [mode, setMode] = useState<GenerationMode>('text');
  const [prompt, setPrompt] = useState('');
  const [imageFiles, setImageFiles] = useState<Partial<Record<ImageViewAngle, File>>>({});
  const [settings, setSettings] = useState<GenerationSettings>({
    ...DEFAULT_GENERATION_SETTINGS,
  });
  const [submitting, setSubmitting] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [lastSpec, setLastSpec] = useState<StructuredGenerationSpec | null>(null);
  const [activeJob, setActiveJob] = useState<GenerationJobRecord | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [diagnosis, setDiagnosis] = useState<ErrorDiagnosisState | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => {
      setToast((curr) => (curr === msg ? null : curr));
    }, 3600);
  }, []);

  const refreshSystemStatus = useCallback(async () => {
    const res = await api.getSystemStatus();
    setSystemStatus(res.status);
  }, []);

  const refreshModels = useCallback(async (selectFirstIfEmpty = false) => {
    const res = await api.listModels({ includeDemo: true });
    setModels(res.models);
    if (selectFirstIfEmpty && res.models.length > 0) {
      // Prefer first user model if present, else Chrono Core Telemetry Beacon showcase
      const preferred =
        res.models.find((m) => !m.isDemo) ??
        res.models.find((m) => m.category === 'prop' && m.isDemo) ??
        res.models[0];
      setActiveModel((curr) => curr ?? preferred);
    }
    return res.models;
  }, []);

  // Keep browser localStorage NVIDIA NIM key synchronized (including across tabs)
  useEffect(() => {
    return subscribeNimKeyChanges(() => {
      setStoredNimKey(getStoredNvidiaApiKey());
    });
  }, []);

  // Initial zero-login bootstrap (provisions an isolated anonymous workspace session automatically)
  useEffect(() => {
    let active = true;
    const init = async () => {
      try {
        await api.getMe();
        if (!active) return;
        await Promise.all([refreshSystemStatus(), refreshModels(true)]);
      } catch (err) {
        if (!active) return;
        setFormError(
          err instanceof Error ? err.message : 'Unable to connect to NV3D Studio backend.'
        );
      }
    };
    void init();
    return () => {
      active = false;
    };
  }, [refreshModels, refreshSystemStatus]);

  // Derived collections
  const userModels = useMemo(() => models.filter((m) => !m.isDemo), [models]);
  const demoModels = useMemo(() => models.filter((m) => m.isDemo), [models]);
  const activeJobRunning = Boolean(activeJob && !TERMINAL_JOB_STATUSES.has(activeJob.status));

  // Asynchronous non-blocking polling loop for running generation jobs
  useEffect(() => {
    if (!activeJob || TERMINAL_JOB_STATUSES.has(activeJob.status)) return;

    let cancelled = false;
    const jobId = activeJob.id;

    const timer = window.setInterval(async () => {
      try {
        const res = await api.getJob(jobId);
        if (cancelled) return;
        setActiveJob(res.job);
        if (res.job.structuredSpec) {
          setLastSpec(res.job.structuredSpec);
        }

        if (res.job.status === 'succeeded' && res.job.modelId) {
          const [modelRes] = await Promise.all([
            api.getModel(res.job.modelId),
            refreshModels(false),
          ]);
          if (cancelled) return;
          setActiveModel(modelRes.model);
          setLiveStats(null);
          setMobilePane('viewport');
          showToast(`Loaded "${modelRes.model.name}" into 3D viewport.`);
        }
      } catch {
        // Transient network hiccup; continue polling
      }
    }, 2200);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeJob, refreshModels, showToast]);

  const handleImageFileChange = (angle: ImageViewAngle, file: File | null) => {
    setImageFiles((prev) => {
      const next = { ...prev };
      if (file) next[angle] = file;
      else delete next[angle];
      return next;
    });
  };

  const handleSubmitGenerate = async () => {
    setSubmitting(true);
    setFormError(null);
    setDiagnosis(null);

    try {
      const res =
        mode === 'text'
          ? await api.generateFromText(prompt, settings)
          : await api.generateFromImages({ files: imageFiles, prompt, settings });

      setActiveJob(res.job);
      if (res.job.structuredSpec) {
        setLastSpec(res.job.structuredSpec);
      }
      // Handle immediate synchronous completion (e.g. NVIDIA NIM 3D on Vercel serverless runtime)
      if (res.job.status === 'succeeded' && res.job.modelId) {
        if (res.job.inlineGlbBase64) {
          await cacheModelGlb(
            res.job.modelId,
            decodeBase64ToArrayBuffer(res.job.inlineGlbBase64)
          );
        }
        let createdModel = res.job.model ?? null;
        if (!createdModel) {
          const modelRes = await api.getModel(res.job.modelId);
          createdModel = modelRes.model;
        }
        const fetchedList = await refreshModels(false).catch(() => [] as GeneratedModelRecord[]);
        if (createdModel && !fetchedList.some((m) => m.id === createdModel!.id)) {
          setModels((prev) =>
            prev.some((m) => m.id === createdModel!.id) ? prev : [createdModel!, ...prev]
          );
        }
        setActiveModel(createdModel);
        setLiveStats(null);
        setMobilePane('viewport');
        showToast(`Loaded "${createdModel.name}" into 3D viewport.`);
      }
    } catch (err) {
      if (err instanceof ApiClientError) {
        // Structured Demo Mode halt includes the honest job record + prompt spec
        const jobPayload = err.payload?.job as GenerationJobRecord | undefined;
        if (err.code === 'PROVIDER_NOT_CONFIGURED' && jobPayload) {
          setActiveJob(jobPayload);
          if (jobPayload.structuredSpec) {
            setLastSpec(jobPayload.structuredSpec);
          }
        } else {
          setFormError(err.message);
        }
      } else {
        setFormError('Failed to submit 3D generation request.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleEnhancePrompt = async () => {
    if (prompt.trim().length < 3 || enhancing) return;
    setEnhancing(true);
    setFormError(null);
    try {
      const res = await api.enhancePrompt(prompt, settings);
      setLastSpec(res.spec);
      setSettings((prev) => ({
        ...prev,
        category: res.spec.category,
        style: res.spec.artStyle,
      }));
      showToast('MiniMax M3.1 Flash generated structured specification.');
    } catch (err) {
      setFormError(
        err instanceof ApiClientError ? err.message : 'Prompt enhancement failed.'
      );
    } finally {
      setEnhancing(false);
    }
  };

  const handleAnalyzeImages = async () => {
    if (!imageFiles.front || enhancing) return;
    setEnhancing(true);
    setFormError(null);
    try {
      const res = await api.analyzeReferenceImages({ files: imageFiles, prompt, settings });
      setLastSpec(res.spec);
      showToast('Reference image analysis complete.');
    } catch (err) {
      setFormError(
        err instanceof ApiClientError ? err.message : 'Reference image analysis failed.'
      );
    } finally {
      setEnhancing(false);
    }
  };

  const handleExplainError = async (
    errorCode: string,
    errorMessage: string,
    providerId: string | null
  ) => {
    try {
      const res = await api.explainError({ errorCode, errorMessage, providerId });
      setDiagnosis(res.diagnosis);
      setInspectorTab('assistant');
      setMobilePane('inspector');
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : 'Unable to diagnose error.');
    }
  };

  const handleInspectModel = useCallback((model: GeneratedModelRecord) => {
    setActiveModel(model);
    setLiveStats(null);
    setSection('create');
    setMobilePane('viewport');
    setInspectorTab('inspector');
  }, []);

  const handleOpenModelById = useCallback(
    async (modelId: string) => {
      try {
        const res = await api.getModel(modelId);
        handleInspectModel(res.model);
      } catch (err) {
        setFormError(err instanceof ApiClientError ? err.message : 'Model no longer exists.');
      }
    },
    [handleInspectModel]
  );

  const handleInspectMatchingDemo = useCallback(
    (category: AssetCategory) => {
      const match = demoModels.find((m) => m.category === category) ?? demoModels[0];
      if (match) {
        setActiveModel(match);
        setLiveStats(null);
        setMobilePane('viewport');
        showToast(`Loaded Demo Sample "${match.name}" in 3D viewer.`);
      }
    },
    [demoModels, showToast]
  );

  const handleImportGlb = useCallback(
    async (file: File, optimizeSize = false) => {
      try {
        const res = await api.importGlb(file, optimizeSize);
        await refreshModels(false);
        setActiveModel(res.model);
        setLiveStats(null);
        setSection('create');
        setMobilePane('viewport');
        setInspectorTab('inspector');
        showToast(`Imported & validated "${res.model.name}".`);
      } catch (err) {
        const msg =
          err instanceof ApiClientError
            ? err.message
            : 'Invalid GLB file. Only Khronos binary glTF 2.0 (.glb) files are accepted.';
        setFormError(msg);
        showToast(msg);
        throw err;
      }
    },
    [refreshModels, showToast]
  );

  const handleModelValidated = useCallback(
    async (modelId: string) => {
      const res = await api.getModel(modelId);
      setActiveModel(res.model);
      await refreshModels(false);
      showToast(`GLB validation verified (${res.model.validationReport.valid ? 'PASS' : 'FAIL'}).`);
    },
    [refreshModels, showToast]
  );

  const handleDeleteModel = useCallback(
    async (modelId: string) => {
      await api.deleteModel(modelId).catch(() => undefined);
      await removeCachedModelGlb(modelId);
      const updated = await refreshModels(false);
      if (activeModel?.id === modelId) {
        setActiveModel(updated[0] ?? null);
        setLiveStats(null);
      }
      showToast('Model deleted from storage.');
    },
    [activeModel?.id, refreshModels, showToast]
  );

  const handleApplySpec = useCallback((spec: StructuredGenerationSpec) => {
    setPrompt(spec.enhancedPrompt);
    setSettings((prev) => ({
      ...prev,
      category: spec.category,
      style: spec.artStyle,
    }));
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#0b0d11] text-[#e6eaf2]">
      {/* Top Navigation (No Sign-Up / Login — Direct LocalStorage NVIDIA API Key) */}
      <TopNav
        activeSection={section}
        onNavigate={setSection}
        systemStatus={systemStatus}
        storedNimKey={storedNimKey}
        onOpenApiKey={() => setApiKeyModalOpen(true)}
        mobileMenuOpen={mobileMenuOpen}
        onToggleMobileMenu={() => setMobileMenuOpen((o) => !o)}
      />

      {/* Studio Body */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left Navigation Rail */}
        <LeftSidebar
          activeSection={section}
          onNavigate={setSection}
          userModelCount={userModels.length}
          activeJobRunning={activeJobRunning}
          mobileOpen={mobileMenuOpen}
          onCloseMobile={() => setMobileMenuOpen(false)}
        />

        {/* Active Workspace View */}
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {section === 'create' && (
            <>
              {/* Mobile Studio Pane Switcher */}
              <div className="grid shrink-0 grid-cols-3 gap-1 border-b border-[#1f2634] bg-[#0e1118] p-1.5 lg:hidden">
                {(
                  [
                    ['create', 'Input'],
                    ['viewport', '3D Viewer'],
                    ['inspector', 'Inspector'],
                  ] as const
                ).map(([paneId, label]) => (
                  <button
                    key={paneId}
                    type="button"
                    onClick={() => setMobilePane(paneId)}
                    className={`rounded-lg py-1.5 text-xs font-semibold transition ${
                      mobilePane === paneId
                        ? 'bg-[#76b900] text-[#080d03]'
                        : 'text-[#8d97ab] hover:text-white'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* 3-Column DCC Studio Workspace */}
              <div className="flex min-h-0 flex-1 overflow-hidden">
                {/* Left Input & Settings Panel */}
                <section
                  aria-label="Generation Input and Settings"
                  className={`h-full shrink-0 border-r border-[#1f2634] ${
                    mobilePane === 'create' ? 'block w-full' : 'hidden'
                  } lg:block lg:w-[336px] xl:w-[356px]`}
                >
                  <CreatePanel
                    mode={mode}
                    onModeChange={setMode}
                    prompt={prompt}
                    onPromptChange={setPrompt}
                    imageFiles={imageFiles}
                    onImageFileChange={handleImageFileChange}
                    settings={settings}
                    onSettingsChange={setSettings}
                    systemStatus={systemStatus}
                    submitting={submitting}
                    enhancing={enhancing}
                    lastSpec={lastSpec}
                    activeJob={activeJob}
                    formError={formError}
                    onClearError={() => setFormError(null)}
                    onEnhancePrompt={() => void handleEnhancePrompt()}
                    onAnalyzeImages={() => void handleAnalyzeImages()}
                    onSubmitGenerate={() => void handleSubmitGenerate()}
                    onOpenSettings={() => setApiKeyModalOpen(true)}
                    onInspectMatchingDemo={handleInspectMatchingDemo}
                    onExplainError={(code, msg, prov) => void handleExplainError(code, msg, prov)}
                  />
                </section>

                {/* Central Three.js 3D Viewport */}
                <section
                  aria-label="Interactive Three.js 3D Viewport"
                  className={`min-h-0 min-w-0 flex-1 ${
                    mobilePane === 'viewport' ? 'block' : 'hidden'
                  } lg:block`}
                >
                  <Suspense fallback={<ViewportSkeleton />}>
                    <LazyThreeViewport
                      model={activeModel}
                      onImportGlbFile={(file) => {
                        void handleImportGlb(file, false).catch(() => undefined);
                      }}
                      onSceneStats={setLiveStats}
                      onDownloadClick={() => {
                        setInspectorTab('export');
                        setMobilePane('inspector');
                      }}
                    />
                  </Suspense>
                </section>

                {/* Right Model Properties, Export & AI Assistant Sidebar */}
                <section
                  aria-label="Model Properties and GLB Export"
                  className={`h-full shrink-0 border-l border-[#1f2634] ${
                    mobilePane === 'inspector' ? 'block w-full' : 'hidden'
                  } lg:block lg:w-[304px] xl:w-[324px]`}
                >
                  <RightInspector
                    activeTab={inspectorTab}
                    onTabChange={setInspectorTab}
                    model={activeModel}
                    demoModels={demoModels}
                    liveStats={liveStats}
                    systemStatus={systemStatus}
                    currentPrompt={prompt}
                    settings={settings}
                    lastSpec={lastSpec}
                    diagnosis={diagnosis}
                    onSelectModel={(m) => {
                      setActiveModel(m);
                      setLiveStats(null);
                    }}
                    onModelValidated={(id) => void handleModelValidated(id)}
                    onDeleteModel={(id) => void handleDeleteModel(id)}
                    onApplySpec={handleApplySpec}
                    onOpenSettings={() => setApiKeyModalOpen(true)}
                  />
                </section>
              </div>
            </>
          )}

          {section === 'home' && (
            <HomeView
              systemStatus={systemStatus}
              userModels={userModels}
              demoModels={demoModels}
              onStartCreate={(nextMode) => {
                setMode(nextMode);
                setSection('create');
                setMobilePane('create');
              }}
              onInspectModel={handleInspectModel}
              onImportGlb={(f) => {
                void handleImportGlb(f, false).catch(() => undefined);
              }}
              onOpenSettings={() => setApiKeyModalOpen(true)}
            />
          )}

          {section === 'models' && (
            <MyModelsView
              models={models}
              onInspectModel={handleInspectModel}
              onDeleteModel={handleDeleteModel}
              onImportGlb={handleImportGlb}
            />
          )}

          {section === 'history' && <HistoryView onOpenModelById={(id) => void handleOpenModelById(id)} />}

          {section === 'settings' && (
            <SettingsView
              systemStatus={systemStatus}
              storedNimKey={storedNimKey}
              onRefreshStatus={refreshSystemStatus}
            />
          )}

          {/* Subtle Studio Notification Toast */}
          {toast && (
            <div
              role="status"
              className="pointer-events-none fixed right-4 bottom-4 z-50 max-w-sm rounded-xl border border-[#76b900]/40 bg-[#111621]/96 px-4 py-2.5 text-xs font-medium text-[#e6eaf2] shadow-2xl backdrop-blur-md"
            >
              {toast}
            </div>
          )}
        </main>
      </div>

      {/* Browser LocalStorage NVIDIA NIM API Key Modal */}
      <ApiKeyModal
        open={apiKeyModalOpen}
        onClose={() => setApiKeyModalOpen(false)}
        onKeyUpdated={refreshSystemStatus}
      />
    </div>
  );
}
