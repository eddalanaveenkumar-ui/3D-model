import { z } from 'zod';
import { DEFAULT_GENERATION_SETTINGS, type GenerationSettings } from '@nv3d/shared';

export const GenerationSettingsSchema = z.object({
  category: z
    .enum(['human', 'animal', 'car', 'building', 'furniture', 'prop', 'tree', 'environment'])
    .default(DEFAULT_GENERATION_SETTINGS.category),
  style: z
    .enum(['realistic-pbr', 'stylized', 'hard-surface', 'architectural', 'low-poly', 'sculpted'])
    .default(DEFAULT_GENERATION_SETTINGS.style),
  quality: z.enum(['draft', 'standard', 'high']).default(DEFAULT_GENERATION_SETTINGS.quality),
  polygonDetail: z
    .enum(['low', 'medium', 'high'])
    .default(DEFAULT_GENERATION_SETTINGS.polygonDetail),
  textureResolution: z
    .enum(['1k', '2k', '4k'])
    .default(DEFAULT_GENERATION_SETTINGS.textureResolution),
  outputFormat: z.enum(['glb', 'gltf']).default(DEFAULT_GENERATION_SETTINGS.outputFormat),
  pbr: z.boolean().default(DEFAULT_GENERATION_SETTINGS.pbr),
  rigging: z.boolean().default(DEFAULT_GENERATION_SETTINGS.rigging),
  animation: z.boolean().default(DEFAULT_GENERATION_SETTINGS.animation),
  optimizeSize: z.boolean().default(DEFAULT_GENERATION_SETTINGS.optimizeSize),
});

export function parseSettingsInput(raw: unknown): GenerationSettings {
  if (!raw) return { ...DEFAULT_GENERATION_SETTINGS };
  if (typeof raw === 'string') {
    const parsed = JSON.parse(raw) as unknown;
    return GenerationSettingsSchema.parse(parsed);
  }
  return GenerationSettingsSchema.parse(raw);
}
