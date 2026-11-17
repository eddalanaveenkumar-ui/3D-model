// ============================================================================
// @nv3d/shared — Canonical TypeScript Types & Constants for NV3D Studio
// ============================================================================

export type AssetCategory =
  | 'human'
  | 'animal'
  | 'car'
  | 'building'
  | 'furniture'
  | 'prop'
  | 'tree'
  | 'environment';

export const ASSET_CATEGORIES: readonly { id: AssetCategory; label: string; hint: string }[] = [
  { id: 'human', label: 'Human', hint: 'Characters, astronauts, athletes, sculpted figures' },
  { id: 'animal', label: 'Animal', hint: 'Wildlife, creatures, stylized companions, birds' },
  { id: 'car', label: 'Vehicle', hint: 'Cars, EVs, rovers, aircraft, transit vehicles' },
  { id: 'building', label: 'Building', hint: 'Architecture, pavilions, towers, facades, cabins' },
  { id: 'furniture', label: 'Furniture', hint: 'Chairs, desks, sofas, lighting fixtures, shelving' },
  { id: 'prop', label: 'Prop', hint: 'Weapons-free gadgets, tools, vessels, instruments' },
  { id: 'tree', label: 'Tree', hint: 'Oaks, pines, bonsai, botanical flora, planters' },
  { id: 'environment', label: 'Environment', hint: 'Dioramas, islands, terrain tiles, interior sets' },
] as const;

export type ArtStyle =
  | 'realistic-pbr'
  | 'stylized'
  | 'hard-surface'
  | 'architectural'
  | 'low-poly'
  | 'sculpted';

export const ART_STYLES: readonly { id: ArtStyle; label: string }[] = [
  { id: 'realistic-pbr', label: 'Realistic PBR' },
  { id: 'stylized', label: 'Stylized' },
  { id: 'hard-surface', label: 'Hard-Surface' },
  { id: 'architectural', label: 'Architectural' },
  { id: 'low-poly', label: 'Low-Poly' },
  { id: 'sculpted', label: 'Sculpted Clay' },
] as const;

export type QualityTier = 'draft' | 'standard' | 'high';
export type PolygonDetail = 'low' | 'medium' | 'high';
export type TextureResolution = '1k' | '2k' | '4k';
export type OutputFormat = 'glb' | 'gltf';
export type GenerationMode = 'text' | 'image';
export type ImageViewAngle = 'front' | 'side' | 'back';

export interface GenerationSettings {
  category: AssetCategory;
  style: ArtStyle;
  quality: QualityTier;
  polygonDetail: PolygonDetail;
  textureResolution: TextureResolution;
  outputFormat: OutputFormat;
  pbr: boolean;
  rigging: boolean;
  animation: boolean;
  optimizeSize: boolean;
}

export const DEFAULT_GENERATION_SETTINGS: GenerationSettings = {
  category: 'prop',
  style: 'realistic-pbr',
  quality: 'standard',
  polygonDetail: 'medium',
  textureResolution: '2k',
  outputFormat: 'glb',
  pbr: true,
  rigging: false,
  animation: false,
  optimizeSize: true,
};

export const POLYGON_BUDGET_MAP: Record<PolygonDetail, number> = {
  low: 8000,
  medium: 30000,
  high: 80000,
};

export const TEXTURE_RESOLUTION_PX: Record<TextureResolution, number> = {
  '1k': 1024,
  '2k': 2048,
  '4k': 4096,
};

export function calculateGenerationCreditCost(settings: GenerationSettings, mode: GenerationMode): number {
  const qualityBase: Record<QualityTier, number> = {
    draft: 5,
    standard: 12,
    high: 25,
  };
  let cost = qualityBase[settings.quality];
  if (mode === 'image') cost += 3;
  if (settings.textureResolution === '4k') cost += 6;
  else if (settings.textureResolution === '2k') cost += 2;
  if (settings.polygonDetail === 'high') cost += 4;
  if (settings.rigging) cost += 8;
  if (settings.animation) cost += 6;
  return cost;
}

// --- Structured MiniMax M3.1 Flash Generation Instructions ---

export type OrchestratorSource = 'nvidia-nim-minimax' | 'local-deterministic-fallback';

export interface MaterialSpecification {
  name: string;
  surfaceType: string;
  baseColorHex: string;
  roughness: number;
  metalness: number;
  notes?: string;
}

export interface StructuredGenerationSpec {
  orchestrator: OrchestratorSource;
  modelId: string;
  title: string;
  category: AssetCategory;
  enhancedPrompt: string;
  negativePrompt: string;
  artStyle: ArtStyle;
  geometryGuidance: {
    targetPolycount: number;
    topology: 'quad-dominant' | 'triangulated';
    symmetry: 'bilateral' | 'radial' | 'asymmetric';
    silhouetteNotes: string;
    scaleMeters: { width: number; height: number; depth: number };
  };
  materials: MaterialSpecification[];
  textureResolution: TextureResolution;
  pbrEnabled: boolean;
  riggingRecommended: boolean;
  riggingNotes: string;
  animationNotes: string;
  weaponsFreeVerified: boolean;
  referenceAnalysis?: {
    viewsProvided: ImageViewAngle[];
    primarySubject: string;
    occludedSurfaceInference: string;
    lightingCompensation: string;
    proportionNotes: string;
  };
  warnings: string[];
}

// --- Provider Types ---

export type ProviderId = 'nim-trellis' | 'meshy' | 'tripo' | 'custom';
export type NimKeySource = 'browser-storage' | 'server-env' | 'none';

export interface ProviderCapabilities {
  textTo3D: boolean;
  imageTo3D: boolean;
  multiViewImageTo3D: boolean;
  supportedViews: ImageViewAngle[];
  maxTextureResolution: TextureResolution;
  pbrMaterials: boolean;
  rigging: boolean;
  animation: boolean;
  gltfExport: boolean;
  webhooks: boolean;
}

export interface ProviderSummary {
  id: ProviderId;
  displayName: string;
  configured: boolean;
  active: boolean;
  requiredEnvVars: string[];
  capabilities: ProviderCapabilities;
}

export interface ConnectivityCheckResult {
  service: string;
  configured: boolean;
  reachable: boolean;
  latencyMs: number | null;
  statusCode: number | null;
  message: string;
  checkedAt: string;
  endpoint?: string;
  modelId?: string;
}

export interface SystemStatus {
  appName: string;
  version: string;
  demoMode: boolean;
  demoReason: string | null;
  nim: {
    configured: boolean;
    keySource?: NimKeySource;
    endpoint: string;
    modelId: string;
    visionModelId: string;
    nim3dEndpoint?: string;
  };
  activeProvider: ProviderSummary | null;
  providers: ProviderSummary[];
  database: {
    engine: 'postgresql' | 'pglite-postgresql';
    connected: boolean;
    tables: string[];
  };
  limits: {
    maxUploadMb: number;
    maxGlbImportMb: number;
    acceptedImageTypes: string[];
    generationRateLimitPerMin: number;
  };
  security: {
    serverSideSecrets: boolean;
    fileAccessRestrictedByUser: boolean;
    rateLimitingActive: boolean;
    webhookSignatureVerification: boolean;
    cspEnabled: boolean;
    weaponsFreePolicy: boolean;
  };
}

// --- GLB Validation & Statistics ---

export interface BoundingBoxDimensions {
  width: number;
  height: number;
  depth: number;
  min: [number, number, number];
  max: [number, number, number];
}

export interface ModelMaterialInfo {
  name: string;
  baseColorFactor: [number, number, number, number];
  metallicFactor: number;
  roughnessFactor: number;
  emissiveFactor: [number, number, number];
  doubleSided: boolean;
  alphaMode: string;
  hasBaseColorTexture: boolean;
  hasMetallicRoughnessTexture: boolean;
  hasNormalTexture: boolean;
}

export interface ModelAnimationInfo {
  name: string;
  channels: number;
  samplers: number;
  durationSeconds: number;
}

export interface ModelStatistics {
  vertices: number;
  triangles: number;
  meshCount: number;
  primitiveCount: number;
  nodeCount: number;
  materialCount: number;
  textureCount: number;
  animationCount: number;
  skinCount: number;
  hasUVs: boolean;
  hasNormals: boolean;
  hasPbrMaterials: boolean;
  dimensions: BoundingBoxDimensions;
  fileSizeBytes: number;
  materials: ModelMaterialInfo[];
  animations: ModelAnimationInfo[];
}

export interface GlbValidationIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
}

export interface GlbValidationReport {
  valid: boolean;
  format: 'glb';
  gltfVersion: string;
  generator: string | null;
  headerMagicValid: boolean;
  declaredByteLength: number;
  actualByteLength: number;
  jsonChunkBytes: number;
  binChunkBytes: number;
  sha256: string;
  validatedAt: string;
  issues: GlbValidationIssue[];
  statistics: ModelStatistics;
}

// --- Jobs, Models, Images, History, Auth ---

export type JobStatus =
  | 'queued'
  | 'enhancing'
  | 'submitting'
  | 'processing'
  | 'downloading'
  | 'optimizing'
  | 'validating'
  | 'succeeded'
  | 'failed'
  | 'provider_unconfigured';

export interface UploadedImageRecord {
  id: string;
  viewAngle: ImageViewAngle;
  originalName: string;
  mimeType: string;
  fileSizeBytes: number;
  width: number;
  height: number;
  previewUrl: string;
  createdAt: string;
}

export interface GenerationJobRecord {
  id: string;
  userId: string;
  mode: GenerationMode;
  status: JobStatus;
  stageLabel: string;
  progress: number;
  prompt: string | null;
  enhancedPrompt: string | null;
  structuredSpec: StructuredGenerationSpec | null;
  settings: GenerationSettings;
  providerId: string | null;
  externalJobId: string | null;
  modelId: string | null;
  model?: GeneratedModelRecord;
  inlineGlbBase64?: string;
  uploadedImages: UploadedImageRecord[];
  creditsCharged: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type ModelSourceType = 'generated' | 'demo_sample' | 'user_import';

export interface GeneratedModelRecord {
  id: string;
  userId: string | null;
  jobId: string | null;
  name: string;
  description: string;
  category: AssetCategory;
  style: ArtStyle;
  sourceType: ModelSourceType;
  isDemo: boolean;
  providerId: string;
  prompt: string | null;
  structuredSpec: StructuredGenerationSpec | null;
  settings: GenerationSettings | null;
  fileSizeBytes: number;
  sha256: string;
  gltfExportSupported: boolean;
  validated: boolean;
  validationReport: GlbValidationReport;
  statistics: ModelStatistics;
  downloadUrl: string;
  gltfDownloadUrl: string;
  createdAt: string;
}

export interface GenerationHistoryEntry {
  id: string;
  userId: string;
  jobId: string | null;
  modelId: string | null;
  action: string;
  mode: GenerationMode | 'import' | 'system';
  status: string;
  summary: string;
  prompt: string | null;
  providerId: string | null;
  creditsDelta: number;
  durationMs: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  isGuest: boolean;
  credits: number;
  totalGenerated: number;
  createdAt: string;
}

export interface CreditLedgerEntry {
  id: string;
  balance: number;
  lastTransactionDelta: number;
  lastTransactionReason: string;
  lifetimeGranted: number;
  lifetimeSpent: number;
  updatedAt: string;
}

export interface AiAssistantMessage {
  role: 'user' | 'assistant';
  content: string;
  structuredSpec?: StructuredGenerationSpec | null;
  timestamp: string;
}
