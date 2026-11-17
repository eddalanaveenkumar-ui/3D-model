import { z } from 'zod';
import {
  POLYGON_BUDGET_MAP,
  type ArtStyle,
  type AssetCategory,
  type ConnectivityCheckResult,
  type GenerationSettings,
  type ImageViewAngle,
  type StructuredGenerationSpec,
} from '@nv3d/shared';
import { getConfig } from '../config/env.js';
import { AppError } from './authService.js';
import type { StoredImageWithBuffer } from './imageUploadService.js';
import { checkWeaponsFreePolicy, sanitizePlainText } from './safetyService.js';

const MaterialSchema = z.object({
  name: z.string().min(1).max(80),
  surfaceType: z.string().min(1).max(80),
  baseColorHex: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .catch('#8A94A6'),
  roughness: z.number().min(0).max(1).catch(0.5),
  metalness: z.number().min(0).max(1).catch(0.1),
  notes: z.string().max(240).optional(),
});

const NimStructuredResponseSchema = z.object({
  title: z.string().min(1).max(100),
  category: z
    .enum(['human', 'animal', 'car', 'building', 'furniture', 'prop', 'tree', 'environment'])
    .catch('prop'),
  enhancedPrompt: z.string().min(10).max(2000),
  negativePrompt: z.string().max(1000).default('low quality, broken topology, non-manifold geometry, weapons'),
  artStyle: z
    .enum(['realistic-pbr', 'stylized', 'hard-surface', 'architectural', 'low-poly', 'sculpted'])
    .catch('realistic-pbr'),
  geometryGuidance: z.object({
    targetPolycount: z.number().int().min(500).max(500000),
    topology: z.enum(['quad-dominant', 'triangulated']).catch('quad-dominant'),
    symmetry: z.enum(['bilateral', 'radial', 'asymmetric']).catch('bilateral'),
    silhouetteNotes: z.string().max(500),
    scaleMeters: z.object({
      width: z.number().min(0.01).max(500).catch(1),
      height: z.number().min(0.01).max(500).catch(1),
      depth: z.number().min(0.01).max(500).catch(1),
    }),
  }),
  materials: z.array(MaterialSchema).min(1).max(8),
  riggingRecommended: z.boolean().default(false),
  riggingNotes: z.string().max(400).default('Static mesh recommended.'),
  animationNotes: z.string().max(400).default('No skeletal clip required.'),
  weaponsFreeVerified: z.boolean().default(true),
  referenceAnalysis: z
    .object({
      primarySubject: z.string().max(300),
      occludedSurfaceInference: z.string().max(500),
      lightingCompensation: z.string().max(400),
      proportionNotes: z.string().max(400),
    })
    .optional(),
  warnings: z.array(z.string().max(300)).max(6).default([]),
});

interface NimChatMessage {
  role: 'system' | 'user' | 'assistant';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >;
}

interface NimChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    message?: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
    };
    finish_reason?: string;
  }>;
  error?: { message?: string; type?: string; code?: string };
}

export function isNimConfigured(): boolean {
  return getConfig().nim.apiKey.length > 0;
}

function extractJsonObject(raw: string): unknown {
  // Strip optional <think>...</think> reasoning tags emitted by reasoning-capable NIM models
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = stripped.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : stripped;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error('Model response did not contain a valid JSON object.');
  }
}

async function callNvidiaNim(params: {
  messages: NimChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  timeoutMs?: number;
}): Promise<{ content: string; model: string }> {
  const config = getConfig();
  if (!config.nim.apiKey) {
    throw new AppError(
      503,
      'NIM_NOT_CONFIGURED',
      'NVIDIA NIM API key is not configured. Set NVIDIA_NIM_API_KEY in server environment variables to enable MiniMax M3.1 Flash orchestration.'
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    params.timeoutMs ?? config.nim.timeoutMs
  );

  try {
    const body: Record<string, unknown> = {
      model: params.model ?? config.nim.model,
      messages: params.messages,
      temperature: params.temperature ?? 0.3,
      top_p: 0.9,
      max_tokens: params.maxTokens ?? 1400,
      stream: false,
    };
    if (params.jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const res = await fetch(config.nim.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${config.nim.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    let parsed: NimChatCompletionResponse = {};
    try {
      parsed = JSON.parse(text) as NimChatCompletionResponse;
    } catch {
      // Handle non-JSON upstream error cleanly
    }

    if (!res.ok) {
      const upstreamMsg = parsed.error?.message || `HTTP ${res.status} from NVIDIA NIM endpoint`;
      throw new AppError(
        res.status === 401 || res.status === 403 ? 502 : 502,
        'NIM_UPSTREAM_ERROR',
        `NVIDIA NIM request failed (${res.status}): ${sanitizePlainText(upstreamMsg, 280)}`
      );
    }

    const content = parsed.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') {
      throw new AppError(502, 'NIM_EMPTY_RESPONSE', 'NVIDIA NIM returned an empty completion payload.');
    }

    return {
      content: content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim(),
      model: parsed.model || params.model || config.nim.model,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AppError(504, 'NIM_TIMEOUT', 'NVIDIA NIM API request timed out.');
    }
    throw new AppError(
      502,
      'NIM_NETWORK_ERROR',
      `Unable to reach NVIDIA NIM endpoint: ${err instanceof Error ? err.message : 'network error'}`
    );
  } finally {
    clearTimeout(timeout);
  }
}

export function inferCategoryFromPrompt(prompt: string, fallback: AssetCategory): AssetCategory {
  const p = prompt.toLowerCase();
  if (/\b(car|coupe|sedan|suv|truck|vehicle|rover|van|bus|ev|sports\s*car|automobile)\b/.test(p)) return 'car';
  if (/\b(chair|armchair|sofa|couch|table|desk|lamp|bookshelf|cabinet|stool|bed|furniture)\b/.test(p)) return 'furniture';
  if (/\b(house|building|pavilion|tower|cabin|villa|temple|architecture|cottage|skyscraper|facade)\b/.test(p)) return 'building';
  if (/\b(tree|oak|pine|bonsai|maple|willow|palm|birch|cedar|foliage|plant)\b/.test(p)) return 'tree';
  if (/\b(human|person|character|astronaut|robot|mannequin|athlete|pilot|diver|humanoid|figure)\b/.test(p)) return 'human';
  if (/\b(fox|wolf|dog|cat|horse|bird|eagle|owl|deer|bear|lion|tiger|rabbit|whale|animal|creature)\b/.test(p)) return 'animal';
  if (/\b(island|environment|diorama|landscape|terrain|courtyard|forest|mountain|valley|biome|scene)\b/.test(p)) return 'environment';
  if (/\b(beacon|lantern|camera|drone|compass|vase|helmet|backpack|tool|console|prop|crate|canister)\b/.test(p)) return 'prop';
  return fallback;
}

const DEFAULT_CATEGORY_SCALES: Record<AssetCategory, { width: number; height: number; depth: number }> = {
  human: { width: 0.65, height: 1.78, depth: 0.38 },
  animal: { width: 0.45, height: 0.72, depth: 1.05 },
  car: { width: 1.92, height: 1.28, depth: 4.45 },
  building: { width: 8.5, height: 4.2, depth: 6.5 },
  furniture: { width: 0.82, height: 0.86, depth: 0.84 },
  prop: { width: 0.42, height: 0.58, depth: 0.42 },
  tree: { width: 2.8, height: 3.6, depth: 2.8 },
  environment: { width: 6.0, height: 3.4, depth: 6.0 },
};

const STYLE_DESCRIPTORS: Record<ArtStyle, string> = {
  'realistic-pbr': 'physically based realistic materials, accurate micro-surface roughness, balanced neutral studio albedo without baked shadows',
  stylized: 'clean stylized hand-crafted forms, bold readable silhouette, cohesive color harmony, subtle edge highlights',
  'hard-surface': 'precision industrial hard-surface bevels, crisp panel seams, machined anodized metals and matte polymers',
  architectural: 'clean architectural massing, true-to-scale structural proportions, crisp glazing, concrete and warm timber finishes',
  'low-poly': 'clean faceted geometric topology, efficient triangle distribution, crisp flat-to-smooth shading groups',
  sculpted: 'high-definition digital sculpture form clarity, clean primary and secondary anatomical/structural planes',
};

/**
 * Honest deterministic parameter formatter used ONLY as an explicitly labeled
 * fallback when NVIDIA_NIM_API_KEY is not configured. Never claims to be MiniMax output.
 */
export function buildDeterministicFallbackSpec(params: {
  prompt: string;
  settings: GenerationSettings;
  viewsProvided?: ImageViewAngle[];
  fallbackReason: string;
}): StructuredGenerationSpec {
  const cleanPrompt = sanitizePlainText(params.prompt, 1500);
  const category = inferCategoryFromPrompt(cleanPrompt, params.settings.category);
  const targetPolycount = POLYGON_BUDGET_MAP[params.settings.polygonDetail];
  const scale = DEFAULT_CATEGORY_SCALES[category];
  const riggingSuitable = category === 'human' || category === 'animal';

  const words = cleanPrompt.split(/\s+/).filter(Boolean).slice(0, 6);
  const title =
    words.length > 0
      ? words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
      : `${category.charAt(0).toUpperCase() + category.slice(1)} 3D Asset`;

  const pbrClause = params.settings.pbr
    ? `full PBR metallic-roughness workflow at ${params.settings.textureResolution.toUpperCase()} UV-unwrapped resolution`
    : 'clean diffuse albedo textures with uniform UV islands';

  const poseClause =
    category === 'human'
      ? ', neutral symmetrical A-pose for clean rigging and full limb separation'
      : category === 'animal'
      ? ', balanced four-point neutral stance with clear limb separation'
      : ', centered at world origin on ground plane';

  const enhancedPrompt = `${cleanPrompt}. Single isolated watertight 3D ${category} asset${poseClause}, ${STYLE_DESCRIPTORS[params.settings.style]}, ${pbrClause}, clean manifold geometry targeting ~${targetPolycount.toLocaleString()} triangles, unobstructed 360-degree exterior, strictly weapons-free.`;

  return {
    orchestrator: 'local-deterministic-fallback',
    modelId: 'none (NVIDIA_NIM_API_KEY not configured)',
    title: title.slice(0, 80),
    category,
    enhancedPrompt,
    negativePrompt:
      'cropped, floating fragments, non-manifold edges, inverted normals, baked harsh shadows, blurry textures, background clutter, text watermarks, weapons, firearms, blades',
    artStyle: params.settings.style,
    geometryGuidance: {
      targetPolycount,
      topology: params.settings.polygonDetail === 'low' ? 'triangulated' : 'quad-dominant',
      symmetry: category === 'tree' || category === 'environment' ? 'asymmetric' : 'bilateral',
      silhouetteNotes: `Maintain clean watertight ${category} silhouette suitable for ${params.settings.quality} quality GLB export.`,
      scaleMeters: scale,
    },
    materials: [
      {
        name: 'Primary_Surface',
        surfaceType: params.settings.pbr ? 'PBR Metallic-Roughness' : 'Standard Albedo',
        baseColorHex: '#8E99A8',
        roughness: params.settings.style === 'hard-surface' ? 0.35 : 0.58,
        metalness: params.settings.style === 'hard-surface' || category === 'car' ? 0.65 : 0.08,
        notes: 'De-lit base color for accurate studio IBL shading',
      },
    ],
    textureResolution: params.settings.textureResolution,
    pbrEnabled: params.settings.pbr,
    riggingRecommended: riggingSuitable && params.settings.rigging,
    riggingNotes: riggingSuitable
      ? 'Compatible with humanoid/quadruped skeletal rigging when supported by the active 3D provider.'
      : 'Static hierarchy recommended for this asset category.',
    animationNotes: params.settings.animation
      ? 'Request provider animation clip only if supported by the active adapter.'
      : 'Static rest pose.',
    weaponsFreeVerified: true,
    referenceAnalysis: params.viewsProvided
      ? {
          viewsProvided: params.viewsProvided,
          primarySubject: cleanPrompt || 'Uploaded reference subject',
          occludedSurfaceInference:
            params.viewsProvided.length > 1
              ? `Multi-view input (${params.viewsProvided.join(', ')}) reduces back-side ambiguity.`
              : 'Single-view input; provider will infer rear and side geometry.',
          lightingCompensation: 'Normalize specular highlights into neutral PBR baseColor and roughness maps.',
          proportionNotes: 'Preserve reference silhouette aspect ratio.',
        }
      : undefined,
    warnings: [params.fallbackReason],
  };
}

const ORCHESTRATION_SYSTEM_PROMPT = `You are the 3D Asset Orchestration Engine inside NV3D Studio, powered by MiniMax M3.1 Flash on NVIDIA NIM.
You DO NOT generate 3D mesh vertices yourself. Your job is to analyze user prompts or reference images and produce a rigorous JSON specification that a downstream Text-to-3D or Image-to-3D generation provider will consume to synthesize a watertight GLB 2.0 asset.

STRICT RULES:
1. Enforce a strict weapons-free policy. If the user requests firearms, guns, bombs, explosives, missiles, swords, combat knives, or lethal weapons, set "weaponsFreeVerified": false and explain in "warnings".
2. Supported categories: "human", "animal", "car", "building", "furniture", "prop" (weapons-free), "tree", "environment".
3. Write "enhancedPrompt" specifically for 3D mesh synthesis: specify watertight manifold geometry, complete 360-degree structure, unlit/de-lit PBR albedo (no harsh baked cast shadows), clean UV unwrapping, neutral A-pose for humans, and clear material separation.
4. Respond ONLY with a single valid JSON object matching this exact structure (no markdown commentary):
{
  "title": "Concise asset title",
  "category": "human|animal|car|building|furniture|prop|tree|environment",
  "enhancedPrompt": "Detailed 3D generation prompt...",
  "negativePrompt": "Artifacts to avoid...",
  "artStyle": "realistic-pbr|stylized|hard-surface|architectural|low-poly|sculpted",
  "geometryGuidance": {
    "targetPolycount": 30000,
    "topology": "quad-dominant|triangulated",
    "symmetry": "bilateral|radial|asymmetric",
    "silhouetteNotes": "Form and proportion guidance",
    "scaleMeters": { "width": 1.0, "height": 1.0, "depth": 1.0 }
  },
  "materials": [
    { "name": "MaterialName", "surfaceType": "metal|wood|fabric|glass|skin|foliage|stone|polymer", "baseColorHex": "#7A828E", "roughness": 0.45, "metalness": 0.2, "notes": "PBR detail note" }
  ],
  "riggingRecommended": false,
  "riggingNotes": "Rigging suitability note",
  "animationNotes": "Animation guidance",
  "weaponsFreeVerified": true,
  "referenceAnalysis": {
    "primarySubject": "Only include for image-to-3D",
    "occludedSurfaceInference": "How back/side surfaces should reconstruct",
    "lightingCompensation": "How to neutralize reference photo lighting",
    "proportionNotes": "Depth-to-width proportion estimate"
  },
  "warnings": []
}`;

/**
 * Use NVIDIA NIM MiniMax M3.1 Flash to enhance and structure a Text-to-3D request.
 * If `requireLiveNim` is true, throws 503 when NVIDIA_NIM_API_KEY is missing rather
 * than using deterministic fallback.
 */
export async function structureTextPrompt(
  rawPrompt: string,
  settings: GenerationSettings,
  options: { requireLiveNim?: boolean } = {}
): Promise<StructuredGenerationSpec> {
  const prompt = sanitizePlainText(rawPrompt, 2000);
  if (prompt.length < 3) {
    throw new AppError(400, 'INVALID_PROMPT', 'Prompt must be at least 3 characters long.');
  }

  const policy = checkWeaponsFreePolicy(prompt);
  if (!policy.allowed) {
    throw new AppError(422, 'POLICY_VIOLATION', policy.reason!);
  }

  const config = getConfig();
  if (!config.nim.apiKey) {
    if (options.requireLiveNim) {
      throw new AppError(
        503,
        'NIM_NOT_CONFIGURED',
        'NVIDIA NIM API key (NVIDIA_NIM_API_KEY) is not configured on the server. Add your key in .env to run live MiniMax M3.1 Flash prompt enhancement.'
      );
    }
    return buildDeterministicFallbackSpec({
      prompt,
      settings,
      fallbackReason:
        'NVIDIA_NIM_API_KEY is not configured; using local deterministic prompt structuring instead of live MiniMax M3.1 Flash.',
    });
  }

  const targetPoly = POLYGON_BUDGET_MAP[settings.polygonDetail];
  const userInstruction = JSON.stringify({
    task: 'text-to-3d-orchestration',
    userPrompt: prompt,
    requestedSettings: {
      category: settings.category,
      style: settings.style,
      quality: settings.quality,
      polygonDetail: settings.polygonDetail,
      targetPolycount: targetPoly,
      textureResolution: settings.textureResolution,
      outputFormat: settings.outputFormat,
      pbr: settings.pbr,
      rigging: settings.rigging,
      animation: settings.animation,
      optimizeSize: settings.optimizeSize,
    },
  });

  const completion = await callNvidiaNim({
    model: config.nim.model,
    messages: [
      { role: 'system', content: ORCHESTRATION_SYSTEM_PROMPT },
      { role: 'user', content: userInstruction },
    ],
    temperature: 0.25,
    maxTokens: 1400,
    jsonMode: true,
  });

  let rawJson: unknown;
  try {
    rawJson = extractJsonObject(completion.content);
  } catch {
    throw new AppError(
      502,
      'NIM_INVALID_JSON',
      'MiniMax M3.1 Flash returned an unstructured response. Please retry.'
    );
  }

  const parsed = NimStructuredResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new AppError(
      502,
      'NIM_SCHEMA_MISMATCH',
      `MiniMax structured output failed schema validation: ${parsed.error.issues[0]?.message ?? 'invalid schema'}`
    );
  }

  if (!parsed.data.weaponsFreeVerified) {
    throw new AppError(
      422,
      'POLICY_VIOLATION',
      parsed.data.warnings[0] ||
        'Prompt blocked by NV3D Studio weapons-free policy during MiniMax safety review.'
    );
  }

  return {
    orchestrator: 'nvidia-nim-minimax',
    modelId: completion.model,
    title: sanitizePlainText(parsed.data.title, 100),
    category: parsed.data.category,
    enhancedPrompt: sanitizePlainText(parsed.data.enhancedPrompt, 2000),
    negativePrompt: sanitizePlainText(parsed.data.negativePrompt, 1000),
    artStyle: parsed.data.artStyle,
    geometryGuidance: parsed.data.geometryGuidance,
    materials: parsed.data.materials,
    textureResolution: settings.textureResolution,
    pbrEnabled: settings.pbr,
    riggingRecommended: parsed.data.riggingRecommended,
    riggingNotes: sanitizePlainText(parsed.data.riggingNotes, 400),
    animationNotes: sanitizePlainText(parsed.data.animationNotes, 400),
    weaponsFreeVerified: true,
    warnings: parsed.data.warnings.map((w) => sanitizePlainText(w, 300)),
  };
}

/**
 * Analyze one or more reference images (front, optional side & back) using the
 * configured NVIDIA NIM multimodal model to produce structured 3D generation instructions.
 */
export async function analyzeReferenceImages(
  images: StoredImageWithBuffer[],
  promptHint: string | undefined,
  settings: GenerationSettings,
  options: { requireLiveNim?: boolean } = {}
): Promise<StructuredGenerationSpec> {
  const cleanHint = promptHint ? sanitizePlainText(promptHint, 1500) : '';
  if (cleanHint) {
    const policy = checkWeaponsFreePolicy(cleanHint);
    if (!policy.allowed) {
      throw new AppError(422, 'POLICY_VIOLATION', policy.reason!);
    }
  }

  const viewsProvided = images.map((img) => img.viewAngle);
  const config = getConfig();

  if (!config.nim.apiKey) {
    if (options.requireLiveNim) {
      throw new AppError(
        503,
        'NIM_NOT_CONFIGURED',
        'NVIDIA NIM API key (NVIDIA_NIM_API_KEY) is not configured on the server. Configure it in .env to run live multimodal reference image analysis.'
      );
    }
    const imageSummary = images
      .map((i) => `${i.viewAngle} (${i.width}x${i.height} ${i.mimeType.replace('image/', '').toUpperCase()})`)
      .join(', ');
    return buildDeterministicFallbackSpec({
      prompt: cleanHint || `3D reconstruction from uploaded reference views: ${imageSummary}`,
      settings,
      viewsProvided,
      fallbackReason:
        'NVIDIA_NIM_API_KEY is not configured; skipped live multimodal vision analysis and prepared direct image-to-3D parameters.',
    });
  }

  const contentParts: Array<
    { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
  > = [
    {
      type: 'text',
      text: JSON.stringify({
        task: 'image-to-3d-reference-analysis',
        viewsProvided,
        userNotes: cleanHint || 'Reconstruct faithful watertight 3D model from reference image(s).',
        requestedSettings: {
          category: settings.category,
          style: settings.style,
          quality: settings.quality,
          polygonDetail: settings.polygonDetail,
          targetPolycount: POLYGON_BUDGET_MAP[settings.polygonDetail],
          textureResolution: settings.textureResolution,
          pbr: settings.pbr,
          rigging: settings.rigging,
          animation: settings.animation,
        },
      }),
    },
  ];

  for (const img of images) {
    contentParts.push({
      type: 'text',
      text: `Reference view: ${img.viewAngle.toUpperCase()} (${img.width}x${img.height})`,
    });
    contentParts.push({
      type: 'image_url',
      image_url: { url: img.dataUrl },
    });
  }

  const completion = await callNvidiaNim({
    model: config.nim.visionModel,
    messages: [
      { role: 'system', content: ORCHESTRATION_SYSTEM_PROMPT },
      { role: 'user', content: contentParts },
    ],
    temperature: 0.2,
    maxTokens: 1500,
    jsonMode: true,
  });

  let rawJson: unknown;
  try {
    rawJson = extractJsonObject(completion.content);
  } catch {
    throw new AppError(
      502,
      'NIM_INVALID_JSON',
      'Multimodal reference analysis returned an unstructured response.'
    );
  }

  const parsed = NimStructuredResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new AppError(
      502,
      'NIM_SCHEMA_MISMATCH',
      `Reference analysis output failed schema validation: ${parsed.error.issues[0]?.message ?? 'invalid schema'}`
    );
  }

  if (!parsed.data.weaponsFreeVerified) {
    throw new AppError(
      422,
      'POLICY_VIOLATION',
      parsed.data.warnings[0] ||
        'Reference image blocked by NV3D Studio weapons-free asset policy.'
    );
  }

  return {
    orchestrator: 'nvidia-nim-minimax',
    modelId: completion.model,
    title: sanitizePlainText(parsed.data.title, 100),
    category: parsed.data.category,
    enhancedPrompt: sanitizePlainText(parsed.data.enhancedPrompt, 2000),
    negativePrompt: sanitizePlainText(parsed.data.negativePrompt, 1000),
    artStyle: parsed.data.artStyle,
    geometryGuidance: parsed.data.geometryGuidance,
    materials: parsed.data.materials,
    textureResolution: settings.textureResolution,
    pbrEnabled: settings.pbr,
    riggingRecommended: parsed.data.riggingRecommended,
    riggingNotes: sanitizePlainText(parsed.data.riggingNotes, 400),
    animationNotes: sanitizePlainText(parsed.data.animationNotes, 400),
    weaponsFreeVerified: true,
    referenceAnalysis: {
      viewsProvided,
      primarySubject: sanitizePlainText(
        parsed.data.referenceAnalysis?.primarySubject ?? parsed.data.title,
        300
      ),
      occludedSurfaceInference: sanitizePlainText(
        parsed.data.referenceAnalysis?.occludedSurfaceInference ??
          'Inferred symmetric back-facing surfaces from visible contours.',
        500
      ),
      lightingCompensation: sanitizePlainText(
        parsed.data.referenceAnalysis?.lightingCompensation ??
          'Neutralize directional highlights for studio PBR relighting.',
        400
      ),
      proportionNotes: sanitizePlainText(
        parsed.data.referenceAnalysis?.proportionNotes ??
          'Matched silhouette proportions to reference image.',
        400
      ),
    },
    warnings: parsed.data.warnings.map((w) => sanitizePlainText(w, 300)),
  };
}

/**
 * Interactive AI Assistant powered by NVIDIA NIM MiniMax M3.1 Flash.
 * Never fabricates responses when unconfigured.
 */
export async function runAiAssistantChat(params: {
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  context?: {
    currentPrompt?: string;
    mode?: string;
    activeModelName?: string;
    lastError?: string;
    settings?: Partial<GenerationSettings>;
  };
}): Promise<{ reply: string; modelId: string }> {
  const cleanMessage = sanitizePlainText(params.message, 2000);
  if (!cleanMessage) {
    throw new AppError(400, 'EMPTY_MESSAGE', 'Assistant message cannot be empty.');
  }

  const systemPrompt = `You are the NV3D Studio AI Technical Director powered by MiniMax M3.1 Flash on NVIDIA NIM.
You assist 3D artists with prompt engineering for Text-to-3D and Image-to-3D workflows, PBR material setup, topology/polycount budgets, rigging readiness, GLB/GLTF export optimization, and troubleshooting provider errors.
Be transparent that you orchestrate and structure prompts while the configured 3D generation provider synthesizes the GLB mesh. Enforce a strict weapons-free asset policy. Give concise, practical, studio-grade guidance.`;

  const priorMessages: NimChatMessage[] = (params.history ?? []).slice(-8).map((m) => ({
    role: m.role,
    content: sanitizePlainText(m.content, 1500),
  }));

  const contextBlock = params.context
    ? `\n\n[Workspace Context]: ${JSON.stringify(params.context)}`
    : '';

  const completion = await callNvidiaNim({
    messages: [
      { role: 'system', content: systemPrompt },
      ...priorMessages,
      { role: 'user', content: `${cleanMessage}${contextBlock}` },
    ],
    temperature: 0.4,
    maxTokens: 900,
  });

  return {
    reply: sanitizePlainText(completion.content, 4000),
    modelId: completion.model,
  };
}

/**
 * Explain a generation or validation error. Uses MiniMax M3.1 Flash when configured,
 * and otherwise provides a clearly labeled system diagnostic rulebook lookup (never posing as AI).
 */
export async function explainGenerationError(params: {
  errorCode: string;
  errorMessage: string;
  providerId?: string | null;
}): Promise<{
  source: 'nvidia-nim-minimax' | 'system-diagnostic';
  modelId: string | null;
  explanation: string;
  recommendedActions: string[];
}> {
  const code = sanitizePlainText(params.errorCode || 'UNKNOWN_ERROR', 80);
  const message = sanitizePlainText(params.errorMessage || 'Unspecified error', 600);

  if (isNimConfigured()) {
    try {
      const completion = await callNvidiaNim({
        messages: [
          {
            role: 'system',
            content:
              'You diagnose errors in NV3D Studio (an AI 3D generation platform using NVIDIA NIM MiniMax M3.1 Flash + modular 3D providers). Return JSON: {"explanation":"...","recommendedActions":["..."]}.',
          },
          {
            role: 'user',
            content: JSON.stringify({ errorCode: code, errorMessage: message, providerId: params.providerId }),
          },
        ],
        temperature: 0.2,
        maxTokens: 500,
        jsonMode: true,
      });
      const parsed = z
        .object({
          explanation: z.string().min(5).max(1200),
          recommendedActions: z.array(z.string().max(300)).min(1).max(5),
        })
        .parse(extractJsonObject(completion.content));

      return {
        source: 'nvidia-nim-minimax',
        modelId: completion.model,
        explanation: sanitizePlainText(parsed.explanation, 1200),
        recommendedActions: parsed.recommendedActions.map((a) => sanitizePlainText(a, 300)),
      };
    } catch {
      // Fall through to deterministic system diagnostic if NIM itself is the failing component
    }
  }

  const rulebook: Record<string, { explanation: string; actions: string[] }> = {
    PROVIDER_NOT_CONFIGURED: {
      explanation:
        'No live 3D mesh generation provider API key is configured on the server, so NV3D Studio is running in explicit Demo Mode and refused to fake a model generation.',
      actions: [
        'Add MESHY_API_KEY, TRIPO_API_KEY, or CUSTOM_3D_PROVIDER_URL to your server .env file and restart the backend.',
        'Open Settings -> 3D Generation Provider and run Test Connectivity to confirm live access.',
        'To test the Three.js viewport, validator, and GLB/GLTF export right now, open any labeled Demo Sample GLB or import a local .glb file.',
      ],
    },
    NIM_NOT_CONFIGURED: {
      explanation:
        'NVIDIA_NIM_API_KEY is not present in the backend environment, so live MiniMax M3.1 Flash inference is disabled.',
      actions: [
        'Set NVIDIA_NIM_API_KEY in .env on the server (never in browser code).',
        'Verify NVIDIA_NIM_ENDPOINT=https://integrate.api.nvidia.com/v1/chat/completions and NVIDIA_NIM_MODEL=minimaxai/minimax-m3.1-flash.',
        'Use Settings -> Test NIM Connectivity to verify credentials.',
      ],
    },
    INVALID_IMAGE_TYPE: {
      explanation:
        'The uploaded reference file failed binary magic-byte inspection. Only authentic PNG, JPEG, and WEBP images are accepted.',
      actions: [
        'Export the reference image as .png, .jpg, or .webp from an image editor.',
        'Ensure the file size is under the configured MAX_UPLOAD_MB limit and at least 32x32 pixels.',
      ],
    },
    POLICY_VIOLATION: {
      explanation:
        'The prompt was blocked by NV3D Studio safety rules, which prohibit weapons, firearms, blades, and explosives.',
      actions: [
        'Rephrase the prompt around supported categories: humans, animals, vehicles, buildings, furniture, weapons-free props, trees, or environments.',
      ],
    },
    GLB_VALIDATION_FAILED: {
      explanation:
        'The retrieved 3D binary failed Khronos glTF 2.0 container validation (corrupted header, chunk length mismatch, or invalid accessor bounds).',
      actions: [
        'Retry the generation job; your reserved credits are automatically refunded on validation failure.',
        'Check provider status in Settings if corrupted outputs persist.',
      ],
    },
  };

  const match = rulebook[code] ?? {
    explanation: `Pipeline reported ${code}: ${message}`,
    actions: [
      'Check Settings -> Pipeline Diagnostics to verify NVIDIA NIM and 3D provider connectivity.',
      'Inspect server logs for upstream HTTP status codes or rate limits, then retry the job.',
    ],
  };

  return {
    source: 'system-diagnostic',
    modelId: null,
    explanation: match.explanation,
    recommendedActions: match.actions,
  };
}

/**
 * Verify live connectivity to NVIDIA NIM MiniMax M3.1 Flash without inventing results.
 */
export async function checkNimConnectivity(): Promise<ConnectivityCheckResult> {
  const config = getConfig();
  const checkedAt = new Date().toISOString();

  if (!config.nim.apiKey) {
    return {
      service: 'NVIDIA NIM (MiniMax M3.1 Flash)',
      configured: false,
      reachable: false,
      latencyMs: null,
      statusCode: null,
      message: 'Not configured. Set NVIDIA_NIM_API_KEY in server environment variables.',
      checkedAt,
      endpoint: config.nim.endpoint,
      modelId: config.nim.model,
    };
  }

  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(config.nim.timeoutMs, 12_000));

  try {
    const res = await fetch(config.nim.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${config.nim.apiKey}`,
      },
      body: JSON.stringify({
        model: config.nim.model,
        messages: [{ role: 'user', content: 'Reply with the single word READY.' }],
        max_tokens: 16,
        temperature: 0,
      }),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - start;
    if (res.ok) {
      return {
        service: 'NVIDIA NIM (MiniMax M3.1 Flash)',
        configured: true,
        reachable: true,
        latencyMs,
        statusCode: res.status,
        message: `Connected to ${config.nim.model} (${latencyMs} ms).`,
        checkedAt,
        endpoint: config.nim.endpoint,
        modelId: config.nim.model,
      };
    }

    const errBody = await res.text().catch(() => '');
    return {
      service: 'NVIDIA NIM (MiniMax M3.1 Flash)',
      configured: true,
      reachable: false,
      latencyMs,
      statusCode: res.status,
      message: `NVIDIA NIM returned HTTP ${res.status}${errBody ? `: ${sanitizePlainText(errBody, 180)}` : ''}`,
      checkedAt,
      endpoint: config.nim.endpoint,
      modelId: config.nim.model,
    };
  } catch (err) {
    return {
      service: 'NVIDIA NIM (MiniMax M3.1 Flash)',
      configured: true,
      reachable: false,
      latencyMs: Date.now() - start,
      statusCode: null,
      message: `Connection failed: ${err instanceof Error ? err.message : 'network unreachable'}`,
      checkedAt,
      endpoint: config.nim.endpoint,
      modelId: config.nim.model,
    };
  } finally {
    clearTimeout(timeout);
  }
}
