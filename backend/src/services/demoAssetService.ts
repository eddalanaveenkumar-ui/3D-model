import crypto from 'node:crypto';
import { Document, NodeIO, type Material, type Mesh, type Node, type Scene, type Texture } from '@gltf-transform/core';
import sharp from 'sharp';
import type { ArtStyle, AssetCategory } from '@nv3d/shared';
import { getDb } from '../db/client.js';
import { saveGlbFile, statStoredFile } from './glbStorageService.js';
import { validateGlbBuffer } from './glbValidationService.js';

interface GeometryData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array | Uint32Array;
}

// ---------- Procedural Manifold Geometry Generators (with Normals & UVs) ----------

function createBox(w: number, h: number, d: number, uvScale = 1): GeometryData {
  const hw = w / 2;
  const hh = h / 2;
  const hd = d / 2;

  const faces: Array<{
    n: [number, number, number];
    corners: Array<[number, number, number]>;
    uvSize: [number, number];
  }> = [
    { n: [0, 0, 1], corners: [[-hw, -hh, hd], [hw, -hh, hd], [hw, hh, hd], [-hw, hh, hd]], uvSize: [w, h] },
    { n: [0, 0, -1], corners: [[hw, -hh, -hd], [-hw, -hh, -hd], [-hw, hh, -hd], [hw, hh, -hd]], uvSize: [w, h] },
    { n: [0, 1, 0], corners: [[-hw, hh, hd], [hw, hh, hd], [hw, hh, -hd], [-hw, hh, -hd]], uvSize: [w, d] },
    { n: [0, -1, 0], corners: [[-hw, -hh, -hd], [hw, -hh, -hd], [hw, -hh, hd], [-hw, -hh, hd]], uvSize: [w, d] },
    { n: [1, 0, 0], corners: [[hw, -hh, hd], [hw, -hh, -hd], [hw, hh, -hd], [hw, hh, hd]], uvSize: [d, h] },
    { n: [-1, 0, 0], corners: [[-hw, -hh, -hd], [-hw, -hh, hd], [-hw, hh, hd], [-hw, hh, -hd]], uvSize: [d, h] },
  ];

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  faces.forEach((f, fi) => {
    const base = fi * 4;
    const [su, sv] = [Math.max(0.2, f.uvSize[0] * uvScale), Math.max(0.2, f.uvSize[1] * uvScale)];
    const faceUvs: Array<[number, number]> = [
      [0, 0],
      [su, 0],
      [su, sv],
      [0, sv],
    ];
    f.corners.forEach((c, ci) => {
      positions.push(c[0], c[1], c[2]);
      normals.push(f.n[0], f.n[1], f.n[2]);
      uvs.push(faceUvs[ci][0], faceUvs[ci][1]);
    });
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices),
  };
}

function createCylinder(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  radialSegments = 24,
  capped = true
): GeometryData {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const halfH = height / 2;
  const slope = (radiusBottom - radiusTop) / Math.max(0.0001, height);

  // Side wall
  for (let y = 0; y <= 1; y++) {
    const v = y;
    const py = y * height - halfH;
    const r = y === 0 ? radiusBottom : radiusTop;
    for (let x = 0; x <= radialSegments; x++) {
      const u = x / radialSegments;
      const theta = u * Math.PI * 2;
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);
      positions.push(r * sinT, py, r * cosT);

      const len = Math.hypot(sinT, slope, cosT) || 1;
      normals.push(sinT / len, slope / len, cosT / len);
      uvs.push(u, 1 - v);
    }
  }

  const stride = radialSegments + 1;
  for (let x = 0; x < radialSegments; x++) {
    const a = x;
    const b = x + stride;
    const c = x + stride + 1;
    const d = x + 1;
    indices.push(a, d, b, b, d, c);
  }

  const addCap = (top: boolean) => {
    const r = top ? radiusTop : radiusBottom;
    if (r <= 0.0001) return;
    const centerIdx = positions.length / 3;
    const py = top ? halfH : -halfH;
    const ny = top ? 1 : -1;
    positions.push(0, py, 0);
    normals.push(0, ny, 0);
    uvs.push(0.5, 0.5);

    const ringStart = positions.length / 3;
    for (let x = 0; x <= radialSegments; x++) {
      const u = x / radialSegments;
      const theta = u * Math.PI * 2;
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);
      positions.push(r * sinT, py, r * cosT);
      normals.push(0, ny, 0);
      uvs.push(cosT * 0.5 + 0.5, sinT * 0.5 + 0.5);
    }

    for (let x = 0; x < radialSegments; x++) {
      const i0 = ringStart + x;
      const i1 = ringStart + x + 1;
      if (top) indices.push(centerIdx, i0, i1);
      else indices.push(centerIdx, i1, i0);
    }
  };

  if (capped) {
    addCap(true);
    addCap(false);
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices),
  };
}

function createSphere(
  radius: number,
  widthSegments = 24,
  heightSegments = 16,
  scale: [number, number, number] = [1, 1, 1]
): GeometryData {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let iy = 0; iy <= heightSegments; iy++) {
    const v = iy / heightSegments;
    const phi = v * Math.PI;
    for (let ix = 0; ix <= widthSegments; ix++) {
      const u = ix / widthSegments;
      const theta = u * Math.PI * 2;

      const ux = -Math.cos(theta) * Math.sin(phi);
      const uy = Math.cos(phi);
      const uz = Math.sin(theta) * Math.sin(phi);

      positions.push(radius * ux * scale[0], radius * uy * scale[1], radius * uz * scale[2]);

      const nx = ux / Math.max(0.001, scale[0]);
      const ny = uy / Math.max(0.001, scale[1]);
      const nz = uz / Math.max(0.001, scale[2]);
      const nLen = Math.hypot(nx, ny, nz) || 1;
      normals.push(nx / nLen, ny / nLen, nz / nLen);
      uvs.push(u, 1 - v);
    }
  }

  const stride = widthSegments + 1;
  for (let iy = 0; iy < heightSegments; iy++) {
    for (let ix = 0; ix < widthSegments; ix++) {
      const a = iy * stride + ix + 1;
      const b = iy * stride + ix;
      const c = (iy + 1) * stride + ix;
      const d = (iy + 1) * stride + ix + 1;
      if (iy !== 0) indices.push(a, b, d);
      if (iy !== heightSegments - 1) indices.push(b, c, d);
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices),
  };
}

function createTorus(
  radius: number,
  tube: number,
  radialSegments = 16,
  tubularSegments = 36
): GeometryData {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let j = 0; j <= radialSegments; j++) {
    for (let i = 0; i <= tubularSegments; i++) {
      const u = (i / tubularSegments) * Math.PI * 2;
      const v = (j / radialSegments) * Math.PI * 2;

      const px = (radius + tube * Math.cos(v)) * Math.cos(u);
      const py = tube * Math.sin(v);
      const pz = (radius + tube * Math.cos(v)) * Math.sin(u);
      positions.push(px, py, pz);

      const cx = radius * Math.cos(u);
      const cz = radius * Math.sin(u);
      const nx = px - cx;
      const ny = py;
      const nz = pz - cz;
      const len = Math.hypot(nx, ny, nz) || 1;
      normals.push(nx / len, ny / len, nz / len);
      uvs.push(i / tubularSegments, j / radialSegments);
    }
  }

  const stride = tubularSegments + 1;
  for (let j = 1; j <= radialSegments; j++) {
    for (let i = 1; i <= tubularSegments; i++) {
      const a = stride * j + i - 1;
      const b = stride * (j - 1) + i - 1;
      const c = stride * (j - 1) + i;
      const d = stride * j + i;
      indices.push(a, d, b, b, d, c);
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices),
  };
}

function eulerToQuat(rx: number, ry: number, rz: number): [number, number, number, number] {
  const c1 = Math.cos(rx / 2);
  const c2 = Math.cos(ry / 2);
  const c3 = Math.cos(rz / 2);
  const s1 = Math.sin(rx / 2);
  const s2 = Math.sin(ry / 2);
  const s3 = Math.sin(rz / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

// ---------- Embedded PBR Texture Generators ----------

async function generatePatternPng(
  kind: 'brushed-metal' | 'woodgrain' | 'fabric' | 'concrete' | 'bark',
  size = 256
): Promise<Uint8Array> {
  const raw = Buffer.alloc(size * size * 3);
  const hash = (x: number, y: number): number => {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 3;
      const n = hash(x, y);
      let r = 128;
      let g = 128;
      let b = 128;

      if (kind === 'brushed-metal') {
        const streak = Math.sin(y * 0.9) * 8 + (hash(0, y) - 0.5) * 22 + (n - 0.5) * 8;
        const grid = x % 64 === 0 || y % 64 === 0 ? -18 : 0;
        const base = Math.max(40, Math.min(230, 142 + streak + grid));
        r = base - 4;
        g = base;
        b = base + 8;
      } else if (kind === 'woodgrain') {
        const ring = Math.sin((y * 0.22 + Math.sin(x * 0.045) * 3.2) * 1.4) * 0.5 + 0.5;
        const fine = (hash(x >> 1, y) - 0.5) * 14;
        r = Math.max(40, Math.min(220, 92 + ring * 48 + fine));
        g = Math.max(28, Math.min(180, 58 + ring * 32 + fine * 0.7));
        b = Math.max(18, Math.min(140, 34 + ring * 20 + fine * 0.5));
      } else if (kind === 'fabric') {
        const weave = ((x >> 1) + (y >> 1)) % 2 === 0 ? 10 : -8;
        const slub = Math.sin(x * 0.5) * 4 + Math.cos(y * 0.5) * 4 + (n - 0.5) * 12;
        const v = Math.max(35, Math.min(180, 68 + weave + slub));
        r = v;
        g = v + 2;
        b = v + 6;
      } else if (kind === 'concrete') {
        const board = y % 32 === 0 ? -22 : 0;
        const mottle =
          Math.sin(x * 0.09) * Math.cos(y * 0.09) * 12 + (n - 0.5) * 18 + board;
        const v = Math.max(80, Math.min(230, 178 + mottle));
        r = v;
        g = v - 1;
        b = v - 4;
      } else {
        // bark
        const ridge = Math.sin(x * 0.38 + Math.sin(y * 0.08) * 2.4) * 20 + (n - 0.5) * 18;
        r = Math.max(35, Math.min(170, 96 + ridge));
        g = Math.max(25, Math.min(140, 68 + ridge * 0.75));
        b = Math.max(18, Math.min(110, 46 + ridge * 0.55));
      }

      raw[idx] = Math.round(r);
      raw[idx + 1] = Math.round(g);
      raw[idx + 2] = Math.round(b);
    }
  }

  const png = await sharp(raw, { raw: { width: size, height: size, channels: 3 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return new Uint8Array(png);
}

// ---------- glTF Document Assembly Helper ----------

class GlbSceneBuilder {
  readonly doc = new Document();
  readonly buffer = this.doc.createBuffer('main');
  readonly scene: Scene;

  constructor(sceneName: string) {
    this.doc.getRoot().getAsset().generator = 'NV3D Studio Procedural Showcase Builder v1.0';
    this.scene = this.doc.createScene(sceneName);
  }

  async addTexture(name: string, kind: 'brushed-metal' | 'woodgrain' | 'fabric' | 'concrete' | 'bark'): Promise<Texture> {
    const bytes = await generatePatternPng(kind, 256);
    return this.doc.createTexture(name).setMimeType('image/png').setImage(bytes);
  }

  addMaterial(
    name: string,
    opts: {
      color: [number, number, number, number?];
      metallic?: number;
      roughness?: number;
      emissive?: [number, number, number];
      texture?: Texture;
      alphaBlend?: boolean;
      doubleSided?: boolean;
    }
  ): Material {
    const mat = this.doc
      .createMaterial(name)
      .setBaseColorFactor([
        opts.color[0],
        opts.color[1],
        opts.color[2],
        opts.color[3] ?? 1,
      ])
      .setMetallicFactor(opts.metallic ?? 0.1)
      .setRoughnessFactor(opts.roughness ?? 0.55)
      .setDoubleSided(opts.doubleSided ?? false);

    if (opts.emissive) mat.setEmissiveFactor(opts.emissive);
    if (opts.texture) mat.setBaseColorTexture(opts.texture);
    if (opts.alphaBlend) mat.setAlphaMode('BLEND');
    return mat;
  }

  createMesh(name: string, geo: GeometryData, material: Material): Mesh {
    const posAcc = this.doc.createAccessor(`${name}_pos`).setType('VEC3').setArray(geo.positions).setBuffer(this.buffer);
    const normAcc = this.doc.createAccessor(`${name}_norm`).setType('VEC3').setArray(geo.normals).setBuffer(this.buffer);
    const uvAcc = this.doc.createAccessor(`${name}_uv`).setType('VEC2').setArray(geo.uvs).setBuffer(this.buffer);
    const idxAcc = this.doc.createAccessor(`${name}_idx`).setType('SCALAR').setArray(geo.indices).setBuffer(this.buffer);

    const prim = this.doc
      .createPrimitive()
      .setAttribute('POSITION', posAcc)
      .setAttribute('NORMAL', normAcc)
      .setAttribute('TEXCOORD_0', uvAcc)
      .setIndices(idxAcc)
      .setMaterial(material);

    return this.doc.createMesh(name).addPrimitive(prim);
  }

  addPart(
    name: string,
    geo: GeometryData,
    material: Material,
    opts: {
      parent?: Node;
      pos?: [number, number, number];
      rot?: [number, number, number];
      scale?: [number, number, number];
    } = {}
  ): Node {
    const mesh = this.createMesh(name, geo, material);
    const node = this.doc.createNode(name).setMesh(mesh);
    if (opts.pos) node.setTranslation(opts.pos);
    if (opts.rot) node.setRotation(eulerToQuat(opts.rot[0], opts.rot[1], opts.rot[2]));
    if (opts.scale) node.setScale(opts.scale);
    if (opts.parent) opts.parent.addChild(node);
    else this.scene.addChild(node);
    return node;
  }

  addGroup(name: string, pos: [number, number, number] = [0, 0, 0], parent?: Node): Node {
    const node = this.doc.createNode(name).setTranslation(pos);
    if (parent) parent.addChild(node);
    else this.scene.addChild(node);
    return node;
  }

  addSpinYAnimation(animName: string, target: Node, durationSec = 4, hoverAmp = 0, baseY = 0): void {
    const times = new Float32Array([0, durationSec * 0.25, durationSec * 0.5, durationSec * 0.75, durationSec]);
    const rots = new Float32Array([
      ...eulerToQuat(0, 0, 0),
      ...eulerToQuat(0, Math.PI * 0.5, 0),
      ...eulerToQuat(0, Math.PI, 0),
      ...eulerToQuat(0, Math.PI * 1.5, 0),
      ...eulerToQuat(0, Math.PI * 2, 0),
    ]);

    const tAcc = this.doc.createAccessor(`${animName}_t`).setType('SCALAR').setArray(times).setBuffer(this.buffer);
    const rAcc = this.doc.createAccessor(`${animName}_r`).setType('VEC4').setArray(rots).setBuffer(this.buffer);

    const anim = this.doc.createAnimation(animName);
    const rotSampler = this.doc.createAnimationSampler().setInput(tAcc).setOutput(rAcc).setInterpolation('LINEAR');
    const rotChannel = this.doc
      .createAnimationChannel()
      .setTargetNode(target)
      .setTargetPath('rotation')
      .setSampler(rotSampler);
    anim.addSampler(rotSampler).addChannel(rotChannel);

    if (hoverAmp > 0) {
      const base = target.getTranslation();
      const translations = new Float32Array([
        base[0], baseY, base[2],
        base[0], baseY + hoverAmp, base[2],
        base[0], baseY, base[2],
        base[0], baseY - hoverAmp, base[2],
        base[0], baseY, base[2],
      ]);
      const pAcc = this.doc.createAccessor(`${animName}_p`).setType('VEC3').setArray(translations).setBuffer(this.buffer);
      const posSampler = this.doc.createAnimationSampler().setInput(tAcc).setOutput(pAcc).setInterpolation('LINEAR');
      const posChannel = this.doc
        .createAnimationChannel()
        .setTargetNode(target)
        .setTargetPath('translation')
        .setSampler(posSampler);
      anim.addSampler(posSampler).addChannel(posChannel);
    }
  }

  async toGlb(): Promise<Buffer> {
    const io = new NodeIO();
    const bin = await io.writeBinary(this.doc);
    return Buffer.from(bin);
  }
}

// ---------- 8 Category Showcase Asset Definitions ----------

async function buildChronoBeacon(): Promise<Buffer> {
  const b = new GlbSceneBuilder('ChronoCoreBeacon');
  const metalTex = await b.addTexture('BrushedTitanium_Albedo', 'brushed-metal');

  const titanium = b.addMaterial('Brushed_Titanium', { color: [0.68, 0.72, 0.78], metallic: 0.85, roughness: 0.28, texture: metalTex });
  const darkAlloy = b.addMaterial('Anodized_Graphite', { color: [0.16, 0.18, 0.22], metallic: 0.72, roughness: 0.38 });
  const copper = b.addMaterial('Induction_Copper', { color: [0.84, 0.48, 0.28], metallic: 0.92, roughness: 0.22 });
  const nvCore = b.addMaterial('NV_Emissive_Core', { color: [0.52, 0.88, 0.08], metallic: 0.1, roughness: 0.18, emissive: [0.46, 0.76, 0.02] });
  const glass = b.addMaterial('Containment_Glass', { color: [0.72, 0.92, 0.98, 0.28], metallic: 0.05, roughness: 0.08, alphaBlend: true });

  // Lower pedestal & chamfered rings
  b.addPart('Base_Plinth', createCylinder(0.46, 0.52, 0.12, 32), darkAlloy, { pos: [0, 0.06, 0] });
  b.addPart('Base_Bevel', createCylinder(0.38, 0.45, 0.1, 32), titanium, { pos: [0, 0.17, 0] });
  b.addPart('Lower_Copper_Coil', createTorus(0.36, 0.032, 16, 36), copper, { pos: [0, 0.25, 0] });
  b.addPart('Lower_Socket', createCylinder(0.28, 0.34, 0.16, 28), darkAlloy, { pos: [0, 0.33, 0] });

  // Upper crown assembly
  b.addPart('Upper_Socket', createCylinder(0.34, 0.28, 0.16, 28), darkAlloy, { pos: [0, 1.15, 0] });
  b.addPart('Upper_Copper_Coil', createTorus(0.36, 0.032, 16, 36), copper, { pos: [0, 1.23, 0] });
  b.addPart('Top_Cap', createCylinder(0.22, 0.38, 0.14, 32), titanium, { pos: [0, 1.32, 0] });
  b.addPart('Top_Emitter_Ring', createTorus(0.16, 0.018, 12, 28), nvCore, { pos: [0, 1.4, 0] });

  // 4 radial structural struts + cooling fins
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2;
    const r = 0.36;
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    b.addPart(`Strut_${i + 1}`, createBox(0.055, 0.94, 0.09), titanium, {
      pos: [x, 0.74, z],
      rot: [0, -angle + Math.PI / 2, 0],
    });
    b.addPart(`Fin_Accent_${i + 1}`, createBox(0.02, 0.62, 0.03), nvCore, {
      pos: [Math.cos(angle) * 0.405, 0.74, Math.sin(angle) * 0.405],
      rot: [0, -angle + Math.PI / 2, 0],
    });
  }

  // Animated floating gyroscope core
  const coreGroup = b.addGroup('Gyro_Core_Assembly', [0, 0.74, 0]);
  b.addPart('Energy_Sphere', createSphere(0.14, 28, 20), nvCore, { parent: coreGroup });
  b.addPart('Outer_Gyro_Ring', createTorus(0.23, 0.018, 14, 36), copper, {
    parent: coreGroup,
    rot: [0.55, 0, 0.35],
  });
  b.addPart('Inner_Gyro_Ring', createTorus(0.185, 0.014, 12, 32), titanium, {
    parent: coreGroup,
    rot: [-0.6, 0.4, -0.3],
  });
  b.addSpinYAnimation('Core_Orbit_Cycle', coreGroup, 5.0, 0.035, 0.74);

  // Translucent glass cylinder chamber
  b.addPart('Chamber_Glass', createCylinder(0.3, 0.3, 0.72, 32, false), glass, { pos: [0, 0.74, 0] });

  return b.toGlb();
}

async function buildAeroGtCoupe(): Promise<Buffer> {
  const b = new GlbSceneBuilder('AeroGtCoupe');
  const metalTex = await b.addTexture('BodyMetallic_Tex', 'brushed-metal');

  const paint = b.addMaterial('Silver_Emerald_Metallic', { color: [0.76, 0.8, 0.84], metallic: 0.88, roughness: 0.18, texture: metalTex });
  const carbon = b.addMaterial('Carbon_Aero_Trim', { color: [0.11, 0.12, 0.14], metallic: 0.35, roughness: 0.42 });
  const cabinGlass = b.addMaterial('Tinted_Canopy_Glass', { color: [0.08, 0.12, 0.16, 0.76], metallic: 0.15, roughness: 0.08, alphaBlend: true });
  const rubber = b.addMaterial('Performance_Tire', { color: [0.09, 0.09, 0.1], metallic: 0.04, roughness: 0.82 });
  const alloy = b.addMaterial('Forged_Alloy_Rim', { color: [0.82, 0.84, 0.88], metallic: 0.92, roughness: 0.2 });
  const headLight = b.addMaterial('DRL_Headlight', { color: [0.92, 0.98, 1.0], metallic: 0.1, roughness: 0.1, emissive: [0.7, 0.9, 1.0] });
  const tailLight = b.addMaterial('LED_Taillight', { color: [0.98, 0.18, 0.14], metallic: 0.1, roughness: 0.15, emissive: [0.85, 0.1, 0.08] });

  const car = b.addGroup('Coupe_Root', [0, 0, 0]);
  // Underbody splitter & lower chassis
  b.addPart('Aero_Floor', createBox(1.82, 0.12, 4.18), carbon, { parent: car, pos: [0, 0.22, 0] });
  b.addPart('Main_Body', createBox(1.78, 0.44, 3.92), paint, { parent: car, pos: [0, 0.48, 0] });
  b.addPart('Sculpted_Hood', createSphere(0.9, 24, 16, [0.94, 0.24, 1.25]), paint, { parent: car, pos: [0, 0.66, 0.88] });
  b.addPart('Rear_Haunch', createSphere(0.9, 24, 16, [0.98, 0.28, 1.15]), paint, { parent: car, pos: [0, 0.68, -0.95] });
  b.addPart('Cabin_Canopy', createSphere(0.82, 26, 18, [0.88, 0.46, 1.38]), cabinGlass, { parent: car, pos: [0, 0.84, -0.15] });
  b.addPart('Roof_Spine', createBox(0.95, 0.06, 1.15), paint, { parent: car, pos: [0, 1.18, -0.22] });

  // Rear wing & diffuser
  b.addPart('Rear_Spoiler_Blade', createBox(1.64, 0.045, 0.28), carbon, { parent: car, pos: [0, 0.96, -1.86], rot: [0.1, 0, 0] });
  b.addPart('Spoiler_Pylon_L', createBox(0.05, 0.2, 0.2), carbon, { parent: car, pos: [-0.46, 0.84, -1.82] });
  b.addPart('Spoiler_Pylon_R', createBox(0.05, 0.2, 0.2), carbon, { parent: car, pos: [0.46, 0.84, -1.82] });

  // Signature LED lighting
  b.addPart('Front_DRL_L', createBox(0.46, 0.045, 0.08), headLight, { parent: car, pos: [-0.6, 0.56, 1.96] });
  b.addPart('Front_DRL_R', createBox(0.46, 0.045, 0.08), headLight, { parent: car, pos: [0.6, 0.56, 1.96] });
  b.addPart('Rear_Lightbar', createBox(1.62, 0.055, 0.06), tailLight, { parent: car, pos: [0, 0.64, -1.96] });

  // 4 wheels with rims
  const wheelCoords: Array<[string, number, number]> = [
    ['FL', -0.88, 1.24],
    ['FR', 0.88, 1.24],
    ['RL', -0.88, -1.24],
    ['RR', 0.88, -1.24],
  ];
  for (const [tag, wx, wz] of wheelCoords) {
    b.addPart(`Tire_${tag}`, createCylinder(0.34, 0.34, 0.26, 28), rubber, {
      parent: car,
      pos: [wx, 0.34, wz],
      rot: [0, 0, Math.PI / 2],
    });
    b.addPart(`Rim_${tag}`, createCylinder(0.22, 0.22, 0.275, 20), alloy, {
      parent: car,
      pos: [wx, 0.34, wz],
      rot: [0, 0, Math.PI / 2],
    });
  }

  b.addSpinYAnimation('Showroom_Turntable', car, 12.0);
  return b.toGlb();
}

async function buildNordicChair(): Promise<Buffer> {
  const b = new GlbSceneBuilder('NordicLoungeChair');
  const woodTex = await b.addTexture('Walnut_Woodgrain', 'woodgrain');
  const fabricTex = await b.addTexture('Charcoal_Boucle', 'fabric');

  const walnut = b.addMaterial('Oiled_Walnut', { color: [0.95, 0.88, 0.82], metallic: 0.04, roughness: 0.42, texture: woodTex });
  const fabric = b.addMaterial('Woven_Charcoal_Fabric', { color: [0.85, 0.88, 0.92], metallic: 0.02, roughness: 0.88, texture: fabricTex });
  const brass = b.addMaterial('Brushed_Brass_Ferrule', { color: [0.88, 0.72, 0.36], metallic: 0.9, roughness: 0.26 });

  // 4 angled tapered legs + brass ferrules
  const legs: Array<[string, number, number, number, number]> = [
    ['FL', -0.32, 0.28, -0.1, 0.06],
    ['FR', 0.32, 0.28, -0.1, -0.06],
    ['BL', -0.32, -0.28, 0.14, 0.06],
    ['BR', 0.32, -0.28, 0.14, -0.06],
  ];
  for (const [tag, lx, lz, rx, rz] of legs) {
    b.addPart(`Leg_${tag}`, createCylinder(0.026, 0.017, 0.42, 18), walnut, {
      pos: [lx, 0.21, lz],
      rot: [rx, 0, rz],
    });
    b.addPart(`Ferrule_${tag}`, createCylinder(0.0185, 0.0165, 0.06, 16), brass, {
      pos: [lx * 1.04, 0.03, lz * 1.07],
      rot: [rx, 0, rz],
    });
  }

  // Seat rails & armrests
  b.addPart('Seat_Base_Deck', createBox(0.68, 0.055, 0.62), walnut, { pos: [0, 0.39, 0], rot: [-0.08, 0, 0] });
  b.addPart('Armrest_L', createBox(0.065, 0.04, 0.64), walnut, { pos: [-0.35, 0.58, -0.02], rot: [-0.04, 0, 0] });
  b.addPart('Armrest_R', createBox(0.065, 0.04, 0.64), walnut, { pos: [0.35, 0.58, -0.02], rot: [-0.04, 0, 0] });
  b.addPart('ArmPost_L', createCylinder(0.02, 0.022, 0.2, 14), walnut, { pos: [-0.35, 0.48, 0.22] });
  b.addPart('ArmPost_R', createCylinder(0.02, 0.022, 0.2, 14), walnut, { pos: [0.35, 0.48, 0.22] });
  b.addPart('Back_Shell', createBox(0.68, 0.52, 0.045), walnut, { pos: [0, 0.67, -0.31], rot: [-0.26, 0, 0] });

  // Plush cushions
  b.addPart('Seat_Cushion', createBox(0.62, 0.11, 0.58, 2), fabric, { pos: [0, 0.46, 0.02], rot: [-0.08, 0, 0] });
  b.addPart('Back_Cushion', createBox(0.62, 0.48, 0.1, 2), fabric, { pos: [0, 0.69, -0.25], rot: [-0.26, 0, 0] });
  b.addPart('Lumbar_Bolster', createCylinder(0.055, 0.055, 0.54, 20), fabric, {
    pos: [0, 0.55, -0.16],
    rot: [0, 0, Math.PI / 2],
  });

  return b.toGlb();
}

async function buildSolsticePavilion(): Promise<Buffer> {
  const b = new GlbSceneBuilder('SolsticePavilion');
  const concreteTex = await b.addTexture('Architectural_Concrete', 'concrete');
  const timberTex = await b.addTexture('Cedar_Timber', 'woodgrain');

  const concrete = b.addMaterial('Board_Formed_Concrete', { color: [0.92, 0.92, 0.9], metallic: 0.03, roughness: 0.78, texture: concreteTex });
  const cedar = b.addMaterial('Warm_Cedar_Timber', { color: [1.0, 0.9, 0.8], metallic: 0.04, roughness: 0.55, texture: timberTex });
  const steel = b.addMaterial('Matte_Black_Steel', { color: [0.14, 0.15, 0.18], metallic: 0.82, roughness: 0.34 });
  const glazing = b.addMaterial('LowE_Architectural_Glass', { color: [0.62, 0.84, 0.92, 0.38], metallic: 0.12, roughness: 0.06, alphaBlend: true });
  const water = b.addMaterial('Reflecting_Pool', { color: [0.12, 0.48, 0.58, 0.82], metallic: 0.15, roughness: 0.05, alphaBlend: true });
  const warmGlow = b.addMaterial('Interior_Warm_Light', { color: [1.0, 0.86, 0.62], metallic: 0, roughness: 0.3, emissive: [0.65, 0.48, 0.22] });

  // Courtyard plinth, steps & reflecting pool
  b.addPart('Main_Plinth', createBox(3.4, 0.18, 2.4, 0.6), concrete, { pos: [0, 0.09, 0] });
  b.addPart('Timber_Deck', createBox(2.1, 0.04, 1.8, 1.2), cedar, { pos: [-0.45, 0.19, 0] });
  b.addPart('Pool_Basin', createBox(0.95, 0.05, 1.85), water, { pos: [1.1, 0.19, 0] });
  b.addPart('Entry_Step', createBox(1.1, 0.09, 0.35), concrete, { pos: [-0.45, 0.045, 1.35] });

  // Structural core wall, steel columns & cantilevered roof slab
  b.addPart('Shear_Wall_Back', createBox(1.9, 1.25, 0.14, 0.8), concrete, { pos: [-0.55, 0.82, -0.78] });
  b.addPart('Shear_Wall_Left', createBox(0.14, 1.25, 1.45, 0.8), concrete, { pos: [-1.42, 0.82, -0.12] });
  b.addPart('Interior_Ceiling_Soffit', createBox(2.4, 0.03, 1.7), warmGlow, { pos: [-0.25, 1.42, -0.05] });
  b.addPart('Cantilever_Roof_Slab', createBox(3.1, 0.14, 2.05, 0.6), concrete, { pos: [-0.1, 1.5, -0.05] });

  // Slim steel columns
  for (const [cx, cz] of [[0.45, 0.68], [1.15, 0.68], [1.15, -0.72]] as const) {
    b.addPart(`Steel_Column_${cx}_${cz}`, createCylinder(0.032, 0.032, 1.26, 14), steel, { pos: [cx, 0.82, cz] });
  }

  // Curtain glass walls
  b.addPart('Front_Glass_Wall', createBox(1.75, 1.2, 0.03), glazing, { pos: [-0.45, 0.82, 0.62] });
  b.addPart('Side_Glass_Wall', createBox(0.03, 1.2, 1.36), glazing, { pos: [0.42, 0.82, -0.08] });

  // Vertical cedar privacy louvers
  for (let i = 0; i < 7; i++) {
    b.addPart(`Cedar_Louver_${i + 1}`, createBox(0.035, 1.22, 0.11), cedar, {
      pos: [0.58 + i * 0.085, 0.82, -0.76],
    });
  }

  return b.toGlb();
}

async function buildCourtyardTree(): Promise<Buffer> {
  const b = new GlbSceneBuilder('CourtyardOakTree');
  const barkTex = await b.addTexture('Oak_Bark', 'bark');
  const stoneTex = await b.addTexture('Planter_Stone', 'concrete');

  const bark = b.addMaterial('Natural_Oak_Bark', { color: [0.95, 0.88, 0.82], metallic: 0.02, roughness: 0.9, texture: barkTex });
  const leafDeep = b.addMaterial('Canopy_Deep_Emerald', { color: [0.16, 0.42, 0.18], metallic: 0.02, roughness: 0.72 });
  const leafMid = b.addMaterial('Canopy_Sunlit_Leaf', { color: [0.26, 0.56, 0.2], metallic: 0.02, roughness: 0.66 });
  const leafBright = b.addMaterial('Canopy_Fresh_Shoot', { color: [0.42, 0.68, 0.22], metallic: 0.02, roughness: 0.62 });
  const planter = b.addMaterial('Carved_Basalt_Planter', { color: [0.42, 0.44, 0.48], metallic: 0.08, roughness: 0.76, texture: stoneTex });

  // Planter & moss mound
  b.addPart('Planter_Base', createCylinder(0.56, 0.44, 0.28, 24), planter, { pos: [0, 0.14, 0] });
  b.addPart('Planter_Rim', createTorus(0.55, 0.035, 12, 28), planter, { pos: [0, 0.28, 0] });
  b.addPart('Moss_Mound', createSphere(0.5, 20, 12, [1, 0.22, 1]), leafDeep, { pos: [0, 0.27, 0] });

  // Trunk & branching limbs
  b.addPart('Primary_Trunk', createCylinder(0.11, 0.19, 0.95, 18), bark, { pos: [0, 0.72, 0], rot: [0.05, 0, -0.06] });
  b.addPart('Branch_Left', createCylinder(0.055, 0.095, 0.68, 14), bark, { pos: [-0.24, 1.32, 0.08], rot: [0.18, 0, 0.58] });
  b.addPart('Branch_Right', createCylinder(0.05, 0.09, 0.64, 14), bark, { pos: [0.25, 1.36, -0.06], rot: [-0.15, 0, -0.55] });
  b.addPart('Branch_Back', createCylinder(0.045, 0.08, 0.58, 14), bark, { pos: [0.02, 1.4, -0.22], rot: [-0.52, 0, 0.08] });

  // Layered canopy domes
  const crowns: Array<[number, [number, number, number], [number, number, number], Material]> = [
    [0.52, [0, 1.82, 0], [1.15, 0.72, 1.1], leafMid],
    [0.44, [-0.46, 1.58, 0.16], [1.1, 0.68, 1.0], leafDeep],
    [0.42, [0.48, 1.62, -0.1], [1.08, 0.66, 1.04], leafDeep],
    [0.38, [0.06, 1.64, -0.42], [1.05, 0.68, 1.0], leafMid],
    [0.34, [-0.18, 1.68, 0.38], [1.0, 0.65, 0.95], leafBright],
    [0.32, [0.22, 2.02, 0.1], [1.05, 0.62, 1.0], leafBright],
  ];
  crowns.forEach(([r, pos, scale, mat], i) => {
    b.addPart(`Canopy_Cluster_${i + 1}`, createSphere(r, 20, 14, scale), mat, { pos });
  });

  return b.toGlb();
}

async function buildAtlasMannequin(): Promise<Buffer> {
  const b = new GlbSceneBuilder('AtlasStudioFigure');
  const armorTex = await b.addTexture('TitaniumShell_Tex', 'brushed-metal');

  const shell = b.addMaterial('Ceramic_Titanium_Shell', { color: [0.84, 0.86, 0.9], metallic: 0.45, roughness: 0.3, texture: armorTex });
  const joint = b.addMaterial('Carbon_Actuator_Joint', { color: [0.16, 0.18, 0.22], metallic: 0.65, roughness: 0.42 });
  const visor = b.addMaterial('Obsidian_Visor', { color: [0.06, 0.09, 0.12], metallic: 0.9, roughness: 0.08 });
  const accent = b.addMaterial('Studio_Status_LED', { color: [0.48, 0.82, 0.05], metallic: 0.1, roughness: 0.2, emissive: [0.42, 0.7, 0.02] });

  const figure = b.addGroup('Humanoid_APose_Root', [0, 0, 0]);

  // Head & neck
  b.addPart('Cranium', createSphere(0.115, 22, 16, [0.92, 1.12, 1.0]), shell, { parent: figure, pos: [0, 1.64, 0] });
  b.addPart('Visor_Shield', createSphere(0.105, 20, 14, [0.9, 0.55, 0.7]), visor, { parent: figure, pos: [0, 1.64, 0.045] });
  b.addPart('Neck_Column', createCylinder(0.048, 0.058, 0.1, 16), joint, { parent: figure, pos: [0, 1.5, 0] });

  // Torso & pelvis
  b.addPart('Chest_Cuirass', createCylinder(0.19, 0.145, 0.34, 22), shell, { parent: figure, pos: [0, 1.3, 0], scale: [1.05, 1, 0.68] });
  b.addPart('Chest_Core_Node', createCylinder(0.036, 0.036, 0.02, 18), accent, {
    parent: figure,
    pos: [0, 1.33, 0.125],
    rot: [Math.PI / 2, 0, 0],
  });
  b.addPart('Abdomen_Core', createCylinder(0.135, 0.13, 0.16, 18), joint, { parent: figure, pos: [0, 1.07, 0], scale: [1, 1, 0.72] });
  b.addPart('Pelvis_Frame', createCylinder(0.15, 0.125, 0.16, 20), shell, { parent: figure, pos: [0, 0.93, 0], scale: [1.05, 1, 0.74] });

  // Symmetrical arms (neutral rigging A-pose) & legs
  for (const side of [-1, 1] as const) {
    const tag = side < 0 ? 'L' : 'R';
    b.addPart(`Shoulder_${tag}`, createSphere(0.072, 16, 12), shell, { parent: figure, pos: [side * 0.24, 1.41, 0] });
    b.addPart(`UpperArm_${tag}`, createCylinder(0.052, 0.044, 0.28, 16), shell, {
      parent: figure,
      pos: [side * 0.31, 1.26, 0],
      rot: [0, 0, side * 0.36],
    });
    b.addPart(`Elbow_${tag}`, createSphere(0.045, 14, 10), joint, { parent: figure, pos: [side * 0.37, 1.12, 0] });
    b.addPart(`Forearm_${tag}`, createCylinder(0.044, 0.036, 0.26, 16), shell, {
      parent: figure,
      pos: [side * 0.42, 0.98, 0.02],
      rot: [-0.1, 0, side * 0.28],
    });
    b.addPart(`Hand_${tag}`, createBox(0.05, 0.09, 0.07), joint, { parent: figure, pos: [side * 0.46, 0.83, 0.04] });

    b.addPart(`HipJoint_${tag}`, createSphere(0.062, 14, 10), joint, { parent: figure, pos: [side * 0.1, 0.85, 0] });
    b.addPart(`Thigh_${tag}`, createCylinder(0.074, 0.056, 0.38, 18), shell, { parent: figure, pos: [side * 0.105, 0.65, 0] });
    b.addPart(`Knee_${tag}`, createSphere(0.055, 14, 10), joint, { parent: figure, pos: [side * 0.105, 0.45, 0.01] });
    b.addPart(`Shin_${tag}`, createCylinder(0.055, 0.042, 0.37, 18), shell, { parent: figure, pos: [side * 0.105, 0.25, 0] });
    b.addPart(`Boot_${tag}`, createBox(0.095, 0.075, 0.21), shell, { parent: figure, pos: [side * 0.105, 0.038, 0.045] });
  }

  return b.toGlb();
}

async function buildOrigamiFox(): Promise<Buffer> {
  const b = new GlbSceneBuilder('StylizedRedFox');

  const coat = b.addMaterial('Terracotta_Fox_Coat', { color: [0.84, 0.34, 0.12], metallic: 0.02, roughness: 0.68 });
  const cream = b.addMaterial('Cream_Undercoat', { color: [0.96, 0.92, 0.84], metallic: 0.02, roughness: 0.72 });
  const obsidian = b.addMaterial('Obsidian_Points', { color: [0.1, 0.1, 0.12], metallic: 0.08, roughness: 0.32 });

  // Torso & chest ruff
  b.addPart('Torso', createSphere(0.22, 20, 14, [0.85, 0.82, 1.65]), coat, { pos: [0, 0.44, 0] });
  b.addPart('Chest_Ruff', createSphere(0.17, 18, 14, [0.9, 1.05, 0.85]), cream, { pos: [0, 0.48, 0.28] });
  b.addPart('Neck', createCylinder(0.11, 0.14, 0.22, 16), coat, { pos: [0, 0.6, 0.28], rot: [0.3, 0, 0] });

  // Head, snout, ears & eyes
  b.addPart('Head', createSphere(0.155, 20, 14, [1.05, 0.92, 1.05]), coat, { pos: [0, 0.74, 0.36] });
  b.addPart('Snout', createCylinder(0.028, 0.095, 0.22, 16), coat, { pos: [0, 0.71, 0.52], rot: [Math.PI / 2 + 0.12, 0, 0] });
  b.addPart('Snout_Under', createCylinder(0.022, 0.075, 0.18, 14), cream, { pos: [0, 0.685, 0.5], rot: [Math.PI / 2 + 0.12, 0, 0] });
  b.addPart('Nose', createSphere(0.028, 12, 10), obsidian, { pos: [0, 0.7, 0.63] });

  for (const side of [-1, 1] as const) {
    const tag = side < 0 ? 'L' : 'R';
    b.addPart(`Ear_${tag}`, createCylinder(0.008, 0.058, 0.17, 12), coat, {
      pos: [side * 0.095, 0.9, 0.34],
      rot: [0.12, 0, -side * 0.2],
    });
    b.addPart(`Ear_Tip_${tag}`, createCylinder(0.005, 0.026, 0.06, 10), obsidian, {
      pos: [side * 0.107, 0.96, 0.348],
      rot: [0.12, 0, -side * 0.2],
    });
    b.addPart(`Eye_${tag}`, createSphere(0.02, 12, 10), obsidian, {
      pos: [side * 0.078, 0.76, 0.47],
    });
  }

  // 4 paws/legs
  for (const [tag, lx, lz] of [['FL', -0.1, 0.24], ['FR', 0.1, 0.24], ['BL', -0.11, -0.24], ['BR', 0.11, -0.24]] as const) {
    b.addPart(`UpperLeg_${tag}`, createCylinder(0.048, 0.034, 0.24, 14), coat, { pos: [lx, 0.26, lz] });
    b.addPart(`LowerPaw_${tag}`, createCylinder(0.033, 0.028, 0.15, 14), obsidian, { pos: [lx, 0.075, lz] });
  }

  // Bushy white-tipped tail
  b.addPart('Tail_Main', createSphere(0.13, 18, 14, [0.78, 0.78, 2.1]), coat, {
    pos: [0, 0.46, -0.52],
    rot: [0.42, 0, 0],
  });
  b.addPart('Tail_Tip', createCylinder(0.01, 0.088, 0.22, 14), cream, {
    pos: [0, 0.56, -0.78],
    rot: [-Math.PI / 2 + 0.42, 0, 0],
  });

  return b.toGlb();
}

async function buildAlpineIsland(): Promise<Buffer> {
  const b = new GlbSceneBuilder('FloatingAlpineDiorama');
  const rockTex = await b.addTexture('Basalt_Cliff', 'concrete');

  const basalt = b.addMaterial('Alpine_Basalt_Rock', { color: [0.46, 0.48, 0.54], metallic: 0.05, roughness: 0.88, texture: rockTex });
  const meadow = b.addMaterial('Alpine_Meadow_Grass', { color: [0.24, 0.58, 0.24], metallic: 0.02, roughness: 0.78 });
  const snow = b.addMaterial('Glacier_Snow', { color: [0.95, 0.97, 1.0], metallic: 0.02, roughness: 0.52 });
  const pine = b.addMaterial('Evergreen_Pine', { color: [0.12, 0.36, 0.2], metallic: 0.02, roughness: 0.74 });
  const trunk = b.addMaterial('Pine_Trunk', { color: [0.38, 0.24, 0.14], metallic: 0.02, roughness: 0.86 });
  const stream = b.addMaterial('Glacial_Stream', { color: [0.22, 0.68, 0.88, 0.85], metallic: 0.1, roughness: 0.08, alphaBlend: true });

  const island = b.addGroup('Floating_Island_Root', [0, 0.95, 0]);

  // Inverted rocky cliff & meadow deck
  b.addPart('Cliff_Core', createCylinder(1.25, 0.12, 0.9, 9), basalt, { parent: island, pos: [0, -0.45, 0] });
  b.addPart('Meadow_Cap', createCylinder(1.28, 1.24, 0.14, 9), meadow, { parent: island, pos: [0, 0.06, 0] });
  b.addPart('Glacial_River', createBox(0.28, 0.05, 2.2), stream, { parent: island, pos: [0.12, 0.12, 0.05], rot: [0, 0.22, 0] });

  // Twin mountains with snow caps
  b.addPart('Main_Peak', createCylinder(0.04, 0.58, 0.96, 8), basalt, { parent: island, pos: [-0.36, 0.58, -0.34] });
  b.addPart('Main_Snow_Cap', createCylinder(0.035, 0.28, 0.44, 8), snow, { parent: island, pos: [-0.36, 0.86, -0.34] });
  b.addPart('Secondary_Peak', createCylinder(0.03, 0.42, 0.68, 7), basalt, { parent: island, pos: [0.42, 0.44, -0.42] });
  b.addPart('Secondary_Snow_Cap', createCylinder(0.025, 0.2, 0.3, 7), snow, { parent: island, pos: [0.42, 0.64, -0.42] });

  // Miniature pine grove
  const pines: Array<[number, number, number]> = [
    [-0.68, 0.32, 1.0],
    [-0.48, 0.58, 0.82],
    [0.64, 0.28, 0.95],
    [0.52, 0.56, 0.76],
    [0.78, -0.05, 0.85],
  ];
  pines.forEach(([px, pz, s], i) => {
    b.addPart(`Pine_Trunk_${i + 1}`, createCylinder(0.022 * s, 0.032 * s, 0.14 * s, 8), trunk, {
      parent: island,
      pos: [px, 0.19 * s, pz],
    });
    b.addPart(`Pine_Lower_${i + 1}`, createCylinder(0.015, 0.14 * s, 0.28 * s, 8), pine, {
      parent: island,
      pos: [px, 0.34 * s, pz],
    });
    b.addPart(`Pine_Upper_${i + 1}`, createCylinder(0.01, 0.105 * s, 0.24 * s, 8), pine, {
      parent: island,
      pos: [px, 0.48 * s, pz],
    });
  });

  b.addSpinYAnimation('Diorama_Drift', island, 16.0, 0.05, 0.95);
  return b.toGlb();
}

interface DemoAssetSpec {
  slug: string;
  name: string;
  description: string;
  category: AssetCategory;
  style: ArtStyle;
  build: () => Promise<Buffer>;
}

const DEMO_ASSET_SPECS: readonly DemoAssetSpec[] = [
  {
    slug: 'demo-chrono-beacon',
    name: 'Chrono Core Telemetry Beacon',
    description:
      'Demo Sample Asset — Precision industrial sci-fi prop with embedded brushed-titanium PBR texture, copper induction coils, containment glass, and animated gyroscope energy core.',
    category: 'prop',
    style: 'hard-surface',
    build: buildChronoBeacon,
  },
  {
    slug: 'demo-aero-gt-coupe',
    name: 'Aero GT Electric Coupe',
    description:
      'Demo Sample Asset — Aerodynamic electric grand tourer with metallic clearcoat body, carbon splitter & spoiler, tinted canopy glass, LED lightbars, forged alloy rims, and turntable clip.',
    category: 'car',
    style: 'realistic-pbr',
    build: buildAeroGtCoupe,
  },
  {
    slug: 'demo-nordic-chair',
    name: 'Nordic Walnut Lounge Chair',
    description:
      'Demo Sample Asset — Mid-century sculpted furniture piece featuring embedded oiled-walnut woodgrain and woven charcoal bouclé PBR textures with brushed brass leg ferrules.',
    category: 'furniture',
    style: 'realistic-pbr',
    build: buildNordicChair,
  },
  {
    slug: 'demo-solstice-pavilion',
    name: 'Solstice Courtyard Pavilion',
    description:
      'Demo Sample Asset — Modernist architectural study with cantilevered board-formed concrete roof, warm cedar privacy louvers, curtain-wall glazing, and reflecting pool.',
    category: 'building',
    style: 'architectural',
    build: buildSolsticePavilion,
  },
  {
    slug: 'demo-courtyard-oak',
    name: 'Courtyard Oak Tree',
    description:
      'Demo Sample Asset — Botanical specimen with carved basalt planter, embedded oak-bark PBR trunk texture, diverging limbs, and layered emerald foliage canopy.',
    category: 'tree',
    style: 'stylized',
    build: buildCourtyardTree,
  },
  {
    slug: 'demo-atlas-figure',
    name: 'Atlas Articulated Figure',
    description:
      'Demo Sample Asset — Symmetrical humanoid robotics/artist reference figure in rigging-ready A-pose with ceramic-titanium shell, carbon joints, and obsidian visor.',
    category: 'human',
    style: 'hard-surface',
    build: buildAtlasMannequin,
  },
  {
    slug: 'demo-stylized-fox',
    name: 'Stylized Red Fox',
    description:
      'Demo Sample Asset — Alert quadruped character in terracotta, cream, and obsidian PBR materials with balanced stance and white-tipped tail.',
    category: 'animal',
    style: 'stylized',
    build: buildOrigamiFox,
  },
  {
    slug: 'demo-alpine-diorama',
    name: 'Floating Alpine Diorama',
    description:
      'Demo Sample Asset — Environment island featuring basalt cliffs, snow-capped twin peaks, translucent glacial stream, evergreen pine grove, and floating animation.',
    category: 'environment',
    style: 'low-poly',
    build: buildAlpineIsland,
  },
];

/**
 * Idempotently build, validate, and seed all 8 genuine Demo Sample GLB assets.
 * Every seeded model is explicitly flagged `is_demo = TRUE` and `source_type = 'demo_sample'`.
 */
export async function ensureDemoShowcaseModels(): Promise<void> {
  const db = getDb();

  for (const spec of DEMO_ASSET_SPECS) {
    const existing = await db.query<{ id: string; storage_key: string }>(
      'SELECT id, storage_key FROM generated_models WHERE demo_slug = $1',
      [spec.slug]
    );

    if (existing.rows.length > 0) {
      try {
        await statStoredFile(existing.rows[0].storage_key);
        continue;
      } catch {
        // Re-materialize missing binary on disk
        const glb = await spec.build();
        const report = validateGlbBuffer(glb);
        const saved = await saveGlbFile({
          ownerScope: 'demo-showcase',
          modelId: existing.rows[0].id,
          buffer: glb,
        });
        await db.query(
          `UPDATE generated_models
           SET storage_key = $1, file_size_bytes = $2, sha256 = $3,
               validated = $4, validation_report = $5::jsonb, statistics = $6::jsonb
           WHERE id = $7`,
          [
            saved.storageKey,
            saved.fileSizeBytes,
            saved.sha256,
            report.valid,
            JSON.stringify(report),
            JSON.stringify(report.statistics),
            existing.rows[0].id,
          ]
        );
        continue;
      }
    }

    const modelId = crypto.randomUUID();
    const glbBuffer = await spec.build();
    const report = validateGlbBuffer(glbBuffer);
    if (!report.valid) {
      throw new Error(`Demo asset "${spec.slug}" failed GLB validation: ${JSON.stringify(report.issues)}`);
    }

    const saved = await saveGlbFile({
      ownerScope: 'demo-showcase',
      modelId,
      buffer: glbBuffer,
    });

    await db.query(
      `INSERT INTO generated_models (
         id, user_id, job_id, demo_slug, name, description, category, style,
         source_type, is_demo, provider_id, prompt, structured_spec, settings,
         storage_key, file_size_bytes, sha256, gltf_export_supported,
         validated, validation_report, statistics
       ) VALUES (
         $1, NULL, NULL, $2, $3, $4, $5, $6,
         'demo_sample', TRUE, 'nv3d-demo-showcase', NULL, NULL, NULL,
         $7, $8, $9, TRUE,
         $10, $11::jsonb, $12::jsonb
       )`,
      [
        modelId,
        spec.slug,
        spec.name,
        spec.description,
        spec.category,
        spec.style,
        saved.storageKey,
        saved.fileSizeBytes,
        saved.sha256,
        report.valid,
        JSON.stringify(report),
        JSON.stringify(report.statistics),
      ]
    );
  }
}

/**
 * Helper exported for automated test suites to produce a genuine, minimal valid PBR GLB binary.
 */
export async function buildTestFixtureGlb(): Promise<Buffer> {
  return buildChronoBeacon();
}
