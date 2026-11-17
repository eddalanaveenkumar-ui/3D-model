import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, simplify, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import {
  POLYGON_BUDGET_MAP,
  TEXTURE_RESOLUTION_PX,
  type PolygonDetail,
  type TextureResolution,
} from '@nv3d/shared';
import { AppError } from './authService.js';

function createNodeIO(): NodeIO {
  return new NodeIO().registerExtensions(ALL_EXTENSIONS);
}

export interface OptimizeGlbOptions {
  optimizeSize: boolean;
  textureResolution: TextureResolution;
  polygonDetail?: PolygonDetail;
  enforcePolygonBudget?: boolean;
}

/**
 * Optimize a real GLB binary: compress & resize embedded textures with sharp,
 * deduplicate accessors/materials, prune unused graph nodes, weld duplicate vertices,
 * and optionally run MeshoptSimplifier — preserving UVs, PBR textures, and animations.
 */
export async function optimizeGlbBuffer(rawGlb: Buffer, options: OptimizeGlbOptions): Promise<Buffer> {
  const io = createNodeIO();
  const doc = await io.readBinary(new Uint8Array(rawGlb));
  const maxTexDim = TEXTURE_RESOLUTION_PX[options.textureResolution] ?? 2048;

  // Compress and cap embedded texture dimensions while preserving alpha & UV layouts
  for (const texture of doc.getRoot().listTextures()) {
    const imgBytes = texture.getImage();
    const mime = texture.getMimeType();
    if (!imgBytes || imgBytes.byteLength === 0) continue;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) continue;

    try {
      const pipeline = sharp(Buffer.from(imgBytes));
      const meta = await pipeline.metadata();
      const needsResize =
        (meta.width && meta.width > maxTexDim) || (meta.height && meta.height > maxTexDim);

      if (!needsResize && !options.optimizeSize) continue;

      let resized = needsResize
        ? pipeline.resize(maxTexDim, maxTexDim, { fit: 'inside', withoutEnlargement: true })
        : pipeline;

      let outBuf: Buffer;
      if (mime === 'image/jpeg') {
        outBuf = await resized.jpeg({ quality: 86, mozjpeg: true }).toBuffer();
      } else if (mime === 'image/webp') {
        outBuf = await resized.webp({ quality: 86 }).toBuffer();
      } else {
        outBuf = await resized.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
      }

      if (needsResize || outBuf.byteLength < imgBytes.byteLength) {
        texture.setImage(new Uint8Array(outBuf));
      }
    } catch {
      // Keep original embedded texture untouched if custom channel encoding blocks recompression
    }
  }

  if (options.optimizeSize) {
    await doc.transform(
      dedup(),
      weld(),
      prune({ keepAttributes: true, keepLeaves: false })
    );

    if (options.enforcePolygonBudget && options.polygonDetail) {
      const targetTris = POLYGON_BUDGET_MAP[options.polygonDetail];
      let currentTris = 0;
      for (const mesh of doc.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          const idx = prim.getIndices();
          const pos = prim.getAttribute('POSITION');
          if (idx) currentTris += Math.floor(idx.getCount() / 3);
          else if (pos) currentTris += Math.floor(pos.getCount() / 3);
        }
      }
      if (currentTris > targetTris * 1.25 && currentTris > 0) {
        await MeshoptSimplifier.ready;
        const ratio = Math.max(0.15, Math.min(0.95, targetTris / currentTris));
        await doc.transform(
          simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.01, lockBorder: true })
        );
      }
    }
  }

  const outBinary = await io.writeBinary(doc);
  return Buffer.from(outBinary);
}

/**
 * Convert a binary GLB 2.0 container into a genuine, self-contained glTF 2.0 JSON (.gltf)
 * with embedded RFC-2397 data URI binary buffer so textures, geometry, UVs, materials,
 * and animations all remain 100% intact in a single downloadable .gltf file.
 */
export async function convertGlbToEmbeddedGltf(glbBuffer: Buffer): Promise<Buffer> {
  if (glbBuffer.byteLength < 20 || glbBuffer.readUInt32LE(0) !== 0x46546c67) {
    throw new AppError(400, 'INVALID_GLB', 'Cannot convert invalid GLB binary to GLTF.');
  }

  const io = createNodeIO();
  const doc = await io.readBinary(new Uint8Array(glbBuffer));
  const jsonDoc = await io.writeJSON(doc);

  const gltfJson = structuredClone(jsonDoc.json) as {
    buffers?: { uri?: string; byteLength: number }[];
    images?: { uri?: string; mimeType?: string; bufferView?: number }[];
  };

  for (const buf of gltfJson.buffers ?? []) {
    if (buf.uri && jsonDoc.resources[buf.uri]) {
      const bytes = Buffer.from(jsonDoc.resources[buf.uri]);
      buf.uri = `data:application/octet-stream;base64,${bytes.toString('base64')}`;
      buf.byteLength = bytes.byteLength;
    }
  }

  for (const img of gltfJson.images ?? []) {
    if (img.uri && jsonDoc.resources[img.uri]) {
      const bytes = Buffer.from(jsonDoc.resources[img.uri]);
      const mime = img.mimeType || 'image/png';
      img.uri = `data:${mime};base64,${bytes.toString('base64')}`;
    }
  }

  return Buffer.from(JSON.stringify(gltfJson, null, 2), 'utf8');
}
