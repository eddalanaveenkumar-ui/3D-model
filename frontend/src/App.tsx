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
  type UserProfile,
} from '@nv3d/shared';
import { AuthModal } from './components/auth/AuthModal';
import { CreatePanel } from './components/create/CreatePanel';
import type { ErrorDiagnosisState } from './components/inspector/AiAssistantPanel';
import { RightInspector, type InspectorTab } from './components/inspector/RightInspector';
import { LeftSidebar } from './components/layout/LeftSidebar';
import { TopNav, type NavSection } from './components/layout/TopNav';
import type { LiveSceneStats } from './components/viewer/ThreeViewport';
import { ViewportSkeleton } from './components/viewer/ViewportSkeleton';
import { HistoryView } from './components/views/HistoryView';
import { HomeView } from './components/views/HomeView';
import { MyModelsView } from './components/views/MyModelsView';
import { SettingsView } from './components/views/SettingsView';
import { api, ApiClientError } from './lib/api';

// Lazy-load Three.js + GLTFLoader + OrbitControls in a separate async chunk
const LazyThreeViewport = lazy(() => import('./components/viewer/ThreeViewport'));

const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'provider_unconfigured']);

export function App() {
  // Navigation & responsive layout state
  const [section, setSection] = useState<NavSection>('create');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<'create' | 'viewport' | 'inspector'>('viewport');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('inspector');
  const [authModalOpen, setAuthModalOpen] = useState(false);

  // Backend state
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
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

  const refreshUser = useCallback(async () => {
    const res = await api.getMe();
    setUser(res.user);
  }, []);

  // Initial bootstrap (establish session first so requests carry single session cookie)
  useEffect(() => {
    let active = true;
    const init = async () => {
      try {
        const meRes = await api.getMe();
        if (!active) return;
        setUser(meRes.user);
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
            refreshUser(),
          ]);
          if (cancelled) return;
          setActiveModel(modelRes.model);
          setLiveStats(null);
          setMobilePane('viewport');
          showToast(`Loaded "${modelRes.model.name}" into 3D viewport.`);
        } else if (res.job.status === 'failed') {
          await refreshUser();
        }
      } catch {
        // Transient network hiccup; continue polling
      }
    }, 2200);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeJob, refreshModels, refreshUser, showToast]);

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
      await refreshUser();
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
        await Promise.all([refreshModels(false), refreshUser()]);
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
    [refreshModels, refreshUser, showToast]
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
      await api.deleteModel(modelId);
      const updated = await refreshModels(false);
      await refreshUser();
      if (activeModel?.id === modelId) {
        setActiveModel(updated[0] ?? null);
        setLiveStats(null);
      }
      showToast('Model deleted from storage.');
    },
    [activeModel?.id, refreshModels, refreshUser, showToast]
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
      {/* Top Navigation */}
      <TopNav
        activeSection={section}
        onNavigate={setSection}
        systemStatus={systemStatus}
        user={user}
        onOpenAuth={() => setAuthModalOpen(true)}
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
                    onOpenSettings={() => setSection('settings')}
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
                    onOpenSettings={() => setSection('settings')}
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
              onOpenSettings={() => setSection('settings')}
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
              user={user}
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

      {/* Authentication Modal */}
      <AuthModal
        open={authModalOpen}
        user={user}
        onClose={() => setAuthModalOpen(false)}
        onUserChange={(nextUser) => {
          setUser(nextUser);
          void refreshModels(false);
        }}
      />
    </div>
  );
}
