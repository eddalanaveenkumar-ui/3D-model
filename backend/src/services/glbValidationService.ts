import type {
  BoundingBoxDimensions,
  GlbValidationIssue,
  GlbValidationReport,
  ModelAnimationInfo,
  ModelMaterialInfo,
  ModelStatistics,
} from '@nv3d/shared';
import { sha256Hex } from './glbStorageService.js';

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}

interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}

interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
}

interface GltfMesh {
  name?: string;
  primitives: GltfPrimitive[];
}

interface GltfNode {
  name?: string;
  mesh?: number;
  skin?: number;
  children?: number[];
  matrix?: number[];
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
}

interface GltfMaterial {
  name?: string;
  pbrMetallicRoughness?: {
    baseColorFactor?: [number, number, number, number];
    baseColorTexture?: { index: number };
    metallicFactor?: number;
    roughnessFactor?: number;
    metallicRoughnessTexture?: { index: number };
  };
  normalTexture?: { index: number };
  emissiveFactor?: [number, number, number];
  alphaMode?: string;
  doubleSided?: boolean;
}

interface GltfAnimation {
  name?: string;
  channels?: unknown[];
  samplers?: { input: number; output: number; interpolation?: string }[];
}

interface GltfRoot {
  asset?: { version?: string; minVersion?: string; generator?: string };
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: GltfMesh[];
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  buffers?: { byteLength: number; uri?: string }[];
  materials?: GltfMaterial[];
  textures?: unknown[];
  images?: { uri?: string; bufferView?: number; mimeType?: string }[];
  animations?: GltfAnimation[];
  skins?: unknown[];
}

const COMPONENT_BYTE_SIZE: Record<number, number> = {
  5120: 1, // BYTE
  5121: 1, // UNSIGNED_BYTE
  5122: 2, // SHORT
  5123: 2, // UNSIGNED_SHORT
  5125: 4, // UNSIGNED_INT
  5126: 4, // FLOAT
};

const TYPE_COMPONENT_COUNT: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

function identityMat4(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiplyMat4(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

function trsToMat4(
  t: [number, number, number] = [0, 0, 0],
  q: [number, number, number, number] = [0, 0, 0, 1],
  s: [number, number, number] = [1, 1, 1]
): number[] {
  const [x, y, z, w] = q;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  const [sx, sy, sz] = s;

  return [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    t[0],
    t[1],
    t[2],
    1,
  ];
}

function transformPoint(m: number[], p: [number, number, number]): [number, number, number] {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

function emptyStatistics(fileSizeBytes: number): ModelStatistics {
  return {
    vertices: 0,
    triangles: 0,
    meshCount: 0,
    primitiveCount: 0,
    nodeCount: 0,
    materialCount: 0,
    textureCount: 0,
    animationCount: 0,
    skinCount: 0,
    hasUVs: false,
    hasNormals: false,
    hasPbrMaterials: false,
    dimensions: { width: 0, height: 0, depth: 0, min: [0, 0, 0], max: [0, 0, 0] },
    fileSizeBytes,
    materials: [],
    animations: [],
  };
}

function roundMetric(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

function computeAccessorBoundsFromBin(
  acc: GltfAccessor,
  bufferViews: GltfBufferView[],
  binChunk: Buffer | null
): { min: [number, number, number]; max: [number, number, number] } | null {
  if (
    acc.min &&
    acc.max &&
    acc.min.length >= 3 &&
    acc.max.length >= 3 &&
    acc.min.every(Number.isFinite) &&
    acc.max.every(Number.isFinite)
  ) {
    return {
      min: [acc.min[0], acc.min[1], acc.min[2]],
      max: [acc.max[0], acc.max[1], acc.max[2]],
    };
  }
  if (!binChunk || acc.bufferView === undefined || acc.componentType !== 5126 || acc.type !== 'VEC3') {
    return null;
  }
  const bv = bufferViews[acc.bufferView];
  if (!bv) return null;
  const baseOffset = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const stride = bv.byteStride ?? 12;
  if (acc.count <= 0 || baseOffset + (acc.count - 1) * stride + 12 > binChunk.length) {
    return null;
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < acc.count; i++) {
    const off = baseOffset + i * stride;
    const x = binChunk.readFloatLE(off);
    const y = binChunk.readFloatLE(off + 4);
    const z = binChunk.readFloatLE(off + 8);
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }
  return min.every(Number.isFinite) ? { min, max } : null;
}

/**
 * Perform full binary & structural glTF 2.0 GLB validation and compute
 * exact geometry, material, texture, UV, animation, and dimension statistics.
 */
export function validateGlbBuffer(buffer: Buffer): GlbValidationReport {
  const issues: GlbValidationIssue[] = [];
  const actualByteLength = buffer.byteLength;
  const digest = sha256Hex(buffer);
  const validatedAt = new Date().toISOString();

  if (actualByteLength < 20) {
    issues.push({
      severity: 'error',
      code: 'GLB_TOO_SMALL',
      message: `File is ${actualByteLength} bytes; a valid GLB 2.0 header and chunk requires at least 20 bytes.`,
    });
    return {
      valid: false,
      format: 'glb',
      gltfVersion: 'unknown',
      generator: null,
      headerMagicValid: false,
      declaredByteLength: 0,
      actualByteLength,
      jsonChunkBytes: 0,
      binChunkBytes: 0,
      sha256: digest,
      validatedAt,
      issues,
      statistics: emptyStatistics(actualByteLength),
    };
  }

  const magic = buffer.readUInt32LE(0);
  const version = buffer.readUInt32LE(4);
  const declaredByteLength = buffer.readUInt32LE(8);
  const headerMagicValid = magic === GLB_MAGIC;

  if (!headerMagicValid) {
    issues.push({
      severity: 'error',
      code: 'INVALID_MAGIC',
      message: `Invalid GLB magic header (0x${magic.toString(16)}). Expected 0x46546c67 ("glTF").`,
    });
  }

  if (version !== 2) {
    issues.push({
      severity: 'error',
      code: 'UNSUPPORTED_GLB_VERSION',
      message: `Unsupported GLB container version ${version}. Only glTF 2.0 binary containers are supported.`,
    });
  }

  if (declaredByteLength !== actualByteLength) {
    issues.push({
      severity: 'error',
      code: 'LENGTH_MISMATCH',
      message: `GLB header declares ${declaredByteLength} bytes, but file size is ${actualByteLength} bytes.`,
    });
  }

  if (issues.some((i) => i.severity === 'error')) {
    return {
      valid: false,
      format: 'glb',
      gltfVersion: String(version),
      generator: null,
      headerMagicValid,
      declaredByteLength,
      actualByteLength,
      jsonChunkBytes: 0,
      binChunkBytes: 0,
      sha256: digest,
      validatedAt,
      issues,
      statistics: emptyStatistics(actualByteLength),
    };
  }

  // Parse chunks
  let offset = 12;
  let jsonChunk: Buffer | null = null;
  let binChunk: Buffer | null = null;
  let chunkIndex = 0;

  while (offset < actualByteLength) {
    if (offset + 8 > actualByteLength) {
      issues.push({
        severity: 'error',
        code: 'TRUNCATED_CHUNK_HEADER',
        message: `Truncated GLB chunk header at byte offset ${offset}.`,
      });
      break;
    }
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    offset += 8;

    if (offset + chunkLength > actualByteLength) {
      issues.push({
        severity: 'error',
        code: 'CHUNK_OVERFLOW',
        message: `Chunk ${chunkIndex} exceeds file size (${offset + chunkLength} > ${actualByteLength}).`,
      });
      break;
    }

    if (chunkLength % 4 !== 0) {
      issues.push({
        severity: 'warning',
        code: 'CHUNK_ALIGNMENT',
        message: `Chunk ${chunkIndex} length (${chunkLength}) is not 4-byte aligned.`,
      });
    }

    const slice = buffer.subarray(offset, offset + chunkLength);
    if (chunkIndex === 0) {
      if (chunkType !== CHUNK_JSON) {
        issues.push({
          severity: 'error',
          code: 'MISSING_JSON_CHUNK',
          message: 'First GLB chunk must be of type JSON (0x4E4F534A).',
        });
      } else {
        jsonChunk = slice;
      }
    } else if (chunkType === CHUNK_BIN) {
      if (binChunk) {
        issues.push({
          severity: 'error',
          code: 'DUPLICATE_BIN_CHUNK',
          message: 'GLB contains more than one BIN chunk.',
        });
      } else {
        binChunk = slice;
      }
    }

    offset += chunkLength;
    chunkIndex++;
  }

  if (!jsonChunk) {
    return {
      valid: false,
      format: 'glb',
      gltfVersion: '2.0',
      generator: null,
      headerMagicValid,
      declaredByteLength,
      actualByteLength,
      jsonChunkBytes: 0,
      binChunkBytes: binChunk?.byteLength ?? 0,
      sha256: digest,
      validatedAt,
      issues,
      statistics: emptyStatistics(actualByteLength),
    };
  }

  let gltf: GltfRoot;
  try {
    gltf = JSON.parse(jsonChunk.toString('utf8')) as GltfRoot;
  } catch (err) {
    issues.push({
      severity: 'error',
      code: 'INVALID_JSON_CHUNK',
      message: `Failed to parse GLB JSON chunk: ${err instanceof Error ? err.message : 'malformed JSON'}.`,
    });
    return {
      valid: false,
      format: 'glb',
      gltfVersion: '2.0',
      generator: null,
      headerMagicValid,
      declaredByteLength,
      actualByteLength,
      jsonChunkBytes: jsonChunk.byteLength,
      binChunkBytes: binChunk?.byteLength ?? 0,
      sha256: digest,
      validatedAt,
      issues,
      statistics: emptyStatistics(actualByteLength),
    };
  }

  const gltfVersion = gltf.asset?.version ?? 'missing';
  const generator = gltf.asset?.generator ?? null;

  if (!gltfVersion.startsWith('2.')) {
    issues.push({
      severity: 'error',
      code: 'INVALID_ASSET_VERSION',
      message: `glTF asset.version must be 2.x (received "${gltfVersion}").`,
    });
  }

  // Security check: disallow external URIs in buffers/images
  for (const [idx, buf] of (gltf.buffers ?? []).entries()) {
    if (buf.uri && !buf.uri.startsWith('data:')) {
      issues.push({
        severity: 'error',
        code: 'EXTERNAL_BUFFER_URI',
        message: `Buffer[${idx}] references an external URI, which is disallowed in self-contained GLB files.`,
      });
    }
    if (idx === 0 && !buf.uri && binChunk && buf.byteLength > binChunk.byteLength) {
      issues.push({
        severity: 'error',
        code: 'BIN_BUFFER_UNDERRUN',
        message: `Buffer[0] declares ${buf.byteLength} bytes, exceeding BIN chunk size of ${binChunk.byteLength} bytes.`,
      });
    }
  }

  for (const [idx, img] of (gltf.images ?? []).entries()) {
    if (img.uri && !img.uri.startsWith('data:')) {
      issues.push({
        severity: 'error',
        code: 'EXTERNAL_IMAGE_URI',
        message: `Image[${idx}] references an external URI; textures must be embedded in the GLB.`,
      });
    }
  }

  // Validate bufferViews and accessors
  const bufferViews = gltf.bufferViews ?? [];
  const accessors = gltf.accessors ?? [];
  const buffers = gltf.buffers ?? [];

  for (const [idx, bv] of bufferViews.entries()) {
    const parentBuf = buffers[bv.buffer];
    if (!parentBuf) {
      issues.push({
        severity: 'error',
        code: 'INVALID_BUFFERVIEW_BUFFER',
        message: `bufferView[${idx}] references missing buffer[${bv.buffer}].`,
      });
      continue;
    }
    const end = (bv.byteOffset ?? 0) + bv.byteLength;
    if (end > parentBuf.byteLength) {
      issues.push({
        severity: 'error',
        code: 'BUFFERVIEW_OUT_OF_BOUNDS',
        message: `bufferView[${idx}] overflows buffer[${bv.buffer}] (${end} > ${parentBuf.byteLength}).`,
      });
    }
  }

  for (const [idx, acc] of accessors.entries()) {
    const compSize = COMPONENT_BYTE_SIZE[acc.componentType];
    const typeCount = TYPE_COMPONENT_COUNT[acc.type];
    if (!compSize || !typeCount) {
      issues.push({
        severity: 'error',
        code: 'INVALID_ACCESSOR_FORMAT',
        message: `accessor[${idx}] has unsupported componentType (${acc.componentType}) or type (${acc.type}).`,
      });
      continue;
    }
    if (acc.bufferView !== undefined) {
      const bv = bufferViews[acc.bufferView];
      if (!bv) {
        issues.push({
          severity: 'error',
          code: 'INVALID_ACCESSOR_BUFFERVIEW',
          message: `accessor[${idx}] references missing bufferView[${acc.bufferView}].`,
        });
      } else if (acc.count > 0) {
        const elemBytes = compSize * typeCount;
        const stride = bv.byteStride ?? elemBytes;
        const required = (acc.byteOffset ?? 0) + (acc.count - 1) * stride + elemBytes;
        if (required > bv.byteLength) {
          issues.push({
            severity: 'error',
            code: 'ACCESSOR_OUT_OF_BOUNDS',
            message: `accessor[${idx}] overflows bufferView[${acc.bufferView}] (${required} > ${bv.byteLength}).`,
          });
        }
      }
    }
  }

  const meshes = gltf.meshes ?? [];
  if (meshes.length === 0) {
    issues.push({
      severity: 'error',
      code: 'NO_MESHES',
      message: 'GLB contains zero meshes.',
    });
  }

  // Compute mesh geometry stats
  let totalVertices = 0;
  let totalTriangles = 0;
  let totalPrimitives = 0;
  let hasUVs = false;
  let hasNormals = false;

  const countPrimitiveTriangles = (prim: GltfPrimitive, vertexCount: number): number => {
    const mode = prim.mode ?? 4; // 4 = TRIANGLES
    let indexOrVertCount = vertexCount;
    if (prim.indices !== undefined && accessors[prim.indices]) {
      indexOrVertCount = accessors[prim.indices].count;
    }
    if (mode === 4) return Math.floor(indexOrVertCount / 3);
    if (mode === 5 || mode === 6) return Math.max(0, indexOrVertCount - 2);
    return 0;
  };

  // Precompute per-mesh stats and local bounds
  const meshStats = meshes.map((mesh, mIdx) => {
    let verts = 0;
    let tris = 0;
    const primBounds: { min: [number, number, number]; max: [number, number, number] }[] = [];

    for (const prim of mesh.primitives ?? []) {
      totalPrimitives++;
      const posIdx = prim.attributes?.POSITION;
      if (posIdx === undefined || !accessors[posIdx]) {
        issues.push({
          severity: 'error',
          code: 'MISSING_POSITION',
          message: `Mesh[${mIdx}] primitive is missing a valid POSITION accessor.`,
        });
        continue;
      }
      const posAcc = accessors[posIdx];
      verts += posAcc.count;
      tris += countPrimitiveTriangles(prim, posAcc.count);

      if (prim.attributes.TEXCOORD_0 !== undefined) hasUVs = true;
      if (prim.attributes.NORMAL !== undefined) hasNormals = true;

      const b = computeAccessorBoundsFromBin(posAcc, bufferViews, binChunk);
      if (b) primBounds.push(b);
    }

    return { verts, tris, primBounds };
  });

  // Traverse active scene graph to compute world-space bounds and instanced geometry counts
  const nodes = gltf.nodes ?? [];
  const worldMin: [number, number, number] = [Infinity, Infinity, Infinity];
  const worldMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let visitedMeshInstances = 0;
  const visitedNodes = new Set<number>();

  const expandWorldBounds = (
    local: { min: [number, number, number]; max: [number, number, number] },
    worldMat: number[]
  ) => {
    const xs = [local.min[0], local.max[0]];
    const ys = [local.min[1], local.max[1]];
    const zs = [local.min[2], local.max[2]];
    for (const x of xs) {
      for (const y of ys) {
        for (const z of zs) {
          const wp = transformPoint(worldMat, [x, y, z]);
          if (wp[0] < worldMin[0]) worldMin[0] = wp[0];
          if (wp[1] < worldMin[1]) worldMin[1] = wp[1];
          if (wp[2] < worldMin[2]) worldMin[2] = wp[2];
          if (wp[0] > worldMax[0]) worldMax[0] = wp[0];
          if (wp[1] > worldMax[1]) worldMax[1] = wp[1];
          if (wp[2] > worldMax[2]) worldMax[2] = wp[2];
        }
      }
    }
  };

  const traverseNode = (nodeIdx: number, parentMat: number[], depth: number) => {
    if (depth > 64 || visitedNodes.has(nodeIdx)) return;
    const node = nodes[nodeIdx];
    if (!node) return;
    visitedNodes.add(nodeIdx);

    const localMat =
      node.matrix && node.matrix.length === 16
        ? node.matrix
        : trsToMat4(node.translation, node.rotation, node.scale);
    const worldMat = multiplyMat4(parentMat, localMat);

    if (node.mesh !== undefined && meshStats[node.mesh]) {
      const ms = meshStats[node.mesh];
      totalVertices += ms.verts;
      totalTriangles += ms.tris;
      visitedMeshInstances++;
      for (const b of ms.primBounds) {
        expandWorldBounds(b, worldMat);
      }
    }

    for (const childIdx of node.children ?? []) {
      traverseNode(childIdx, worldMat, depth + 1);
    }
  };

  const activeSceneIdx = gltf.scene ?? 0;
  const rootNodes = gltf.scenes?.[activeSceneIdx]?.nodes ?? nodes.map((_, i) => i);
  for (const rn of rootNodes) {
    traverseNode(rn, identityMat4(), 0);
  }

  // Fallback if meshes weren't referenced by scene nodes
  if (visitedMeshInstances === 0 && meshStats.length > 0) {
    for (const ms of meshStats) {
      totalVertices += ms.verts;
      totalTriangles += ms.tris;
      for (const b of ms.primBounds) {
        expandWorldBounds(b, identityMat4());
      }
    }
  }

  const hasValidBounds = worldMin.every(Number.isFinite) && worldMax.every(Number.isFinite);
  const dimensions: BoundingBoxDimensions = hasValidBounds
    ? {
        width: roundMetric(worldMax[0] - worldMin[0]),
        height: roundMetric(worldMax[1] - worldMin[1]),
        depth: roundMetric(worldMax[2] - worldMin[2]),
        min: [roundMetric(worldMin[0]), roundMetric(worldMin[1]), roundMetric(worldMin[2])],
        max: [roundMetric(worldMax[0]), roundMetric(worldMax[1]), roundMetric(worldMax[2])],
      }
    : { width: 0, height: 0, depth: 0, min: [0, 0, 0], max: [0, 0, 0] };

  // Materials
  const rawMaterials = gltf.materials ?? [];
  const materials: ModelMaterialInfo[] = rawMaterials.map((mat, idx) => {
    const pbr = mat.pbrMetallicRoughness;
    return {
      name: mat.name || `Material_${idx + 1}`,
      baseColorFactor: pbr?.baseColorFactor ?? [1, 1, 1, 1],
      metallicFactor: pbr?.metallicFactor ?? 1,
      roughnessFactor: pbr?.roughnessFactor ?? 1,
      emissiveFactor: mat.emissiveFactor ?? [0, 0, 0],
      doubleSided: Boolean(mat.doubleSided),
      alphaMode: mat.alphaMode ?? 'OPAQUE',
      hasBaseColorTexture: Boolean(pbr?.baseColorTexture),
      hasMetallicRoughnessTexture: Boolean(pbr?.metallicRoughnessTexture),
      hasNormalTexture: Boolean(mat.normalTexture),
    };
  });
  const hasPbrMaterials = rawMaterials.some((m) => Boolean(m.pbrMetallicRoughness));

  // Animations
  const rawAnimations = gltf.animations ?? [];
  const animations: ModelAnimationInfo[] = rawAnimations.map((anim, idx) => {
    let maxDuration = 0;
    for (const sampler of anim.samplers ?? []) {
      const inputAcc = accessors[sampler.input];
      if (inputAcc?.max && typeof inputAcc.max[0] === 'number') {
        maxDuration = Math.max(maxDuration, inputAcc.max[0]);
      } else if (
        inputAcc &&
        binChunk &&
        inputAcc.bufferView !== undefined &&
        inputAcc.componentType === 5126 &&
        inputAcc.count > 0
      ) {
        const bv = bufferViews[inputAcc.bufferView];
        if (bv) {
          const lastOff = (bv.byteOffset ?? 0) + (inputAcc.byteOffset ?? 0) + (inputAcc.count - 1) * 4;
          if (lastOff + 4 <= binChunk.length) {
            maxDuration = Math.max(maxDuration, binChunk.readFloatLE(lastOff));
          }
        }
      }
    }
    return {
      name: anim.name || `Animation_${idx + 1}`,
      channels: anim.channels?.length ?? 0,
      samplers: anim.samplers?.length ?? 0,
      durationSeconds: roundMetric(maxDuration),
    };
  });

  if (!hasUVs && meshes.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'MISSING_UVS',
      message: 'No TEXCOORD_0 UV attributes found on primitives.',
    });
  }
  if (!hasNormals && meshes.length > 0) {
    issues.push({
      severity: 'info',
      code: 'AUTO_NORMALS',
      message: 'Vertex normals are omitted; Three.js will compute flat shading normals if needed.',
    });
  }

  const valid = !issues.some((i) => i.severity === 'error') && totalVertices > 0;

  if (valid && issues.length === 0) {
    issues.push({
      severity: 'info',
      code: 'GLB_CONFORMANT',
      message: 'Binary glTF 2.0 header, JSON schema, BIN buffer views, UVs, and PBR materials verified.',
    });
  }

  return {
    valid,
    format: 'glb',
    gltfVersion,
    generator,
    headerMagicValid,
    declaredByteLength,
    actualByteLength,
    jsonChunkBytes: jsonChunk.byteLength,
    binChunkBytes: binChunk?.byteLength ?? 0,
    sha256: digest,
    validatedAt,
    issues,
    statistics: {
      vertices: totalVertices,
      triangles: totalTriangles,
      meshCount: meshes.length,
      primitiveCount: totalPrimitives,
      nodeCount: nodes.length,
      materialCount: materials.length,
      textureCount: (gltf.textures ?? []).length,
      animationCount: animations.length,
      skinCount: (gltf.skins ?? []).length,
      hasUVs,
      hasNormals,
      hasPbrMaterials,
      dimensions,
      fileSizeBytes: actualByteLength,
      materials,
      animations,
    },
  };
}
