import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  AlertTriangle,
  Grid3x3,
  Maximize2,
  Minimize2,
  Palette,
  Pause,
  Play,
  RotateCcw,
  RefreshCw,
  Sun,
  Triangle,
  Upload,
} from 'lucide-react';
import type { GeneratedModelRecord } from '@nv3d/shared';
import { attachAuthHeaders } from '../../lib/api';
import { cacheModelGlb, getCachedModelGlb } from '../../lib/localGlbCache';
import { formatCount, formatDimensionMeters } from '../../lib/format';

export interface LiveSceneStats {
  vertices: number;
  triangles: number;
  materials: number;
  meshes: number;
  animations: string[];
  dimensions: { width: number; height: number; depth: number };
}

type LightingPresetId = 'studio' | 'warm' | 'cool-rim' | 'high-key';

interface LightingPreset {
  id: LightingPresetId;
  label: string;
  keyColor: number;
  keyIntensity: number;
  fillColor: number;
  fillIntensity: number;
  rimColor: number;
  rimIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  exposure: number;
}

const LIGHTING_PRESETS: readonly LightingPreset[] = [
  {
    id: 'studio',
    label: 'Studio 3-Point',
    keyColor: 0xfff8ee,
    keyIntensity: 2.3,
    fillColor: 0xb9d4ff,
    fillIntensity: 0.9,
    rimColor: 0xdff5ff,
    rimIntensity: 1.35,
    hemiSky: 0xdce7ff,
    hemiGround: 0x262934,
    hemiIntensity: 0.65,
    exposure: 1.12,
  },
  {
    id: 'warm',
    label: 'Golden Key',
    keyColor: 0xffd59e,
    keyIntensity: 2.7,
    fillColor: 0x8fb3e8,
    fillIntensity: 0.75,
    rimColor: 0xffe6bf,
    rimIntensity: 1.2,
    hemiSky: 0xffe9cc,
    hemiGround: 0x2a2320,
    hemiIntensity: 0.6,
    exposure: 1.15,
  },
  {
    id: 'cool-rim',
    label: 'Cyber Rim',
    keyColor: 0xdbeeff,
    keyIntensity: 2.0,
    fillColor: 0x7aa2f7,
    fillIntensity: 0.95,
    rimColor: 0x9ef01a,
    rimIntensity: 1.9,
    hemiSky: 0xb8d4ff,
    hemiGround: 0x141822,
    hemiIntensity: 0.55,
    exposure: 1.1,
  },
  {
    id: 'high-key',
    label: 'Neutral Inspection',
    keyColor: 0xffffff,
    keyIntensity: 2.1,
    fillColor: 0xffffff,
    fillIntensity: 1.35,
    rimColor: 0xffffff,
    rimIntensity: 1.1,
    hemiSky: 0xffffff,
    hemiGround: 0x6b7280,
    hemiIntensity: 0.95,
    exposure: 1.22,
  },
];

const BG_PRESETS: readonly { id: string; label: string; hex: string; light?: boolean }[] = [
  { id: 'studio-dark', label: 'Studio Dark', hex: '#10141c' },
  { id: 'obsidian', label: 'Obsidian', hex: '#07090d' },
  { id: 'neutral-slate', label: 'Neutral Gray', hex: '#262c38' },
  { id: 'blueprint', label: 'Blueprint', hex: '#0c1624' },
  { id: 'daylight', label: 'Daylight', hex: '#cfd6e2', light: true },
];

type CameraPreset = 'iso' | 'front' | 'side' | 'top';

interface ThreeViewportProps {
  model: GeneratedModelRecord | null;
  onImportGlbFile?: (file: File) => void;
  onSceneStats?: (stats: LiveSceneStats) => void;
  onDownloadClick?: () => void;
}

function disposeObject3D(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry?.dispose();
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const m of mats) {
        if (!m) continue;
        for (const val of Object.values(m)) {
          if (val instanceof THREE.Texture) {
            val.dispose();
          }
        }
        m.dispose();
      }
    }
  });
}

function isLightHex(hex: string): boolean {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return false;
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.58;
}

export default function ThreeViewport({
  model,
  onImportGlbFile,
  onSceneStats,
}: ThreeViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Scene refs
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const modelGroupRef = useRef<THREE.Group | null>(null);
  const gridGroupRef = useRef<THREE.Group | null>(null);
  const shadowPlaneRef = useRef<THREE.Mesh | null>(null);
  const keyLightRef = useRef<THREE.DirectionalLight | null>(null);
  const fillLightRef = useRef<THREE.DirectionalLight | null>(null);
  const rimLightRef = useRef<THREE.DirectionalLight | null>(null);
  const hemiLightRef = useRef<THREE.HemisphereLight | null>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const clipsRef = useRef<THREE.AnimationClip[]>([]);
  const fitRadiusRef = useRef<number>(2);
  const fitCenterRef = useRef<THREE.Vector3>(new THREE.Vector3(0, 0.6, 0));

  // UI state
  const [showGrid, setShowGrid] = useState(true);
  const [wireframe, setWireframe] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [bgColor, setBgColor] = useState('#10141c');
  const [lightingPreset, setLightingPreset] = useState<LightingPresetId>('studio');
  const [exposure, setExposure] = useState(1.12);
  const [keyIntensity, setKeyIntensity] = useState(2.3);
  const [keyAzimuthDeg, setKeyAzimuthDeg] = useState(42);
  const [envIntensity, setEnvIntensity] = useState(0.85);
  const [openPopover, setOpenPopover] = useState<'lighting' | 'background' | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [cssFullscreenFallback, setCssFullscreenFallback] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  // Loading / error / animation state
  const [loadingPct, setLoadingPct] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [webglError, setWebglError] = useState<string | null>(null);
  const [liveStats, setLiveStats] = useState<LiveSceneStats | null>(null);
  const [animPlaying, setAnimPlaying] = useState(true);
  const [activeClipIdx, setActiveClipIdx] = useState(0);

  const animPlayingRef = useRef(animPlaying);
  animPlayingRef.current = animPlaying;

  const isBrightBg = isLightHex(bgColor);

  const positionCameraForPreset = useCallback((preset: CameraPreset) => {
    const cam = cameraRef.current;
    const controls = controlsRef.current;
    if (!cam || !controls) return;

    const r = Math.max(0.4, fitRadiusRef.current);
    const center = fitCenterRef.current;
    const dist = r * 2.45;

    if (preset === 'front') {
      cam.position.set(center.x, center.y + r * 0.22, center.z + dist);
    } else if (preset === 'side') {
      cam.position.set(center.x + dist, center.y + r * 0.22, center.z);
    } else if (preset === 'top') {
      cam.position.set(center.x, center.y + dist * 1.15, center.z + 0.01);
    } else {
      cam.position.set(center.x + dist * 0.72, center.y + dist * 0.5, center.z + dist * 0.82);
    }

    cam.near = Math.max(0.01, r / 100);
    cam.far = Math.max(100, r * 60);
    cam.updateProjectionMatrix();
    controls.target.copy(center);
    controls.minDistance = Math.max(0.12, r * 0.35);
    controls.maxDistance = Math.max(12, r * 14);
    controls.update();
  }, []);

  // Initialize Three.js WebGL Studio Engine once
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: false,
      });
    } catch (err) {
      setWebglError(
        err instanceof Error
          ? `WebGL initialization unavailable: ${err.message}`
          : 'WebGL context could not be initialized on this device.'
      );
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const width = Math.max(1, mount.clientWidth);
    const height = Math.max(1, mount.clientHeight);
    renderer.setSize(width, height);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    mount.innerHTML = '';
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#10141c');

    // Studio IBL environment via PMREM RoomEnvironment (zero external HDR fetch)
    const pmrem = new THREE.PMREMGenerator(renderer);
    const roomEnv = new RoomEnvironment();
    const envRT = pmrem.fromScene(roomEnv, 0.04);
    scene.environment = envRT.texture;
    scene.environmentIntensity = 0.85;
    roomEnv.dispose();
    pmrem.dispose();

    const camera = new THREE.PerspectiveCamera(42, width / height, 0.02, 200);
    camera.position.set(2.4, 1.7, 2.8);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.065;
    controls.enablePan = true;
    controls.enableZoom = true;
    controls.enableRotate = true;
    controls.screenSpacePanning = true;
    controls.target.set(0, 0.65, 0);
    controls.update();

    // Dual-scale studio reference grid + ground contact shadow catcher
    const gridGroup = new THREE.Group();
    const fineGrid = new THREE.GridHelper(16, 64, 0x263042, 0x1a2130);
    const majorGrid = new THREE.GridHelper(16, 16, 0x3b4861, 0x2b3548);
    majorGrid.position.y = 0.001;
    gridGroup.add(fineGrid, majorGrid);
    scene.add(gridGroup);

    const shadowGeo = new THREE.PlaneGeometry(24, 24);
    const shadowMat = new THREE.ShadowMaterial({ opacity: 0.34 });
    const shadowPlane = new THREE.Mesh(shadowGeo, shadowMat);
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.position.y = -0.001;
    shadowPlane.receiveShadow = true;
    scene.add(shadowPlane);

    // 3-Point Studio Lighting Rig + Hemisphere bounce
    const hemiLight = new THREE.HemisphereLight(0xdce7ff, 0x262934, 0.65);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfff8ee, 2.3);
    keyLight.position.set(4.2, 6.5, 4.6);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 25;
    const d = 5;
    keyLight.shadow.camera.left = -d;
    keyLight.shadow.camera.right = d;
    keyLight.shadow.camera.top = d;
    keyLight.shadow.camera.bottom = -d;
    keyLight.shadow.bias = -0.0005;
    keyLight.shadow.normalBias = 0.02;
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xb9d4ff, 0.9);
    fillLight.position.set(-5.0, 3.2, 2.4);
    scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xdff5ff, 1.35);
    rimLight.position.set(-1.5, 4.4, -5.5);
    scene.add(rimLight);

    const modelGroup = new THREE.Group();
    scene.add(modelGroup);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    controlsRef.current = controls;
    modelGroupRef.current = modelGroup;
    gridGroupRef.current = gridGroup;
    shadowPlaneRef.current = shadowPlane;
    keyLightRef.current = keyLight;
    fillLightRef.current = fillLight;
    rimLightRef.current = rimLight;
    hemiLightRef.current = hemiLight;

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = Math.max(1, Math.floor(entry.contentRect.width));
      const h = Math.max(1, Math.floor(entry.contentRect.height));
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    });
    resizeObserver.observe(mount);

    const clock = new THREE.Clock();
    let rafId = 0;
    const animate = () => {
      rafId = window.requestAnimationFrame(animate);
      const delta = Math.min(clock.getDelta(), 0.1);
      if (mixerRef.current && animPlayingRef.current) {
        mixerRef.current.update(delta);
      }
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      window.cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      controls.dispose();
      mixerRef.current?.stopAllAction();
      disposeObject3D(modelGroup);
      shadowGeo.dispose();
      shadowMat.dispose();
      envRT.dispose();
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  // Sync grid visibility
  useEffect(() => {
    if (gridGroupRef.current) gridGroupRef.current.visible = showGrid;
    if (shadowPlaneRef.current) shadowPlaneRef.current.visible = showGrid;
  }, [showGrid]);

  // Sync background & adaptive grid contrast
  useEffect(() => {
    const scene = sceneRef.current;
    const gridGroup = gridGroupRef.current;
    if (!scene) return;
    scene.background = new THREE.Color(bgColor);
    if (gridGroup) {
      const bright = isLightHex(bgColor);
      gridGroup.children.forEach((c, idx) => {
        if (c instanceof THREE.GridHelper) {
          const mat = c.material;
          if (mat instanceof THREE.LineBasicMaterial) {
            mat.color.setHex(
              bright
                ? idx === 0
                  ? 0xb5bfcf
                  : 0x8894a8
                : idx === 0
                ? 0x1d2535
                : 0x334059
            );
          }
        }
      });
    }
  }, [bgColor]);

  // Sync auto-rotate
  useEffect(() => {
    if (controlsRef.current) {
      controlsRef.current.autoRotate = autoRotate;
      controlsRef.current.autoRotateSpeed = 1.6;
    }
  }, [autoRotate]);

  // Sync lighting rig parameters
  useEffect(() => {
    const preset = LIGHTING_PRESETS.find((p) => p.id === lightingPreset) ?? LIGHTING_PRESETS[0];
    if (keyLightRef.current) {
      keyLightRef.current.color.setHex(preset.keyColor);
      keyLightRef.current.intensity = keyIntensity;
      const rad = (keyAzimuthDeg * Math.PI) / 180;
      const radius = 6.2;
      keyLightRef.current.position.set(Math.cos(rad) * radius, 6.4, Math.sin(rad) * radius);
    }
    if (fillLightRef.current) {
      fillLightRef.current.color.setHex(preset.fillColor);
      fillLightRef.current.intensity = preset.fillIntensity;
    }
    if (rimLightRef.current) {
      rimLightRef.current.color.setHex(preset.rimColor);
      rimLightRef.current.intensity = preset.rimIntensity;
    }
    if (hemiLightRef.current) {
      hemiLightRef.current.color.setHex(preset.hemiSky);
      hemiLightRef.current.groundColor.setHex(preset.hemiGround);
      hemiLightRef.current.intensity = preset.hemiIntensity;
    }
    if (rendererRef.current) {
      rendererRef.current.toneMappingExposure = exposure;
    }
    if (sceneRef.current) {
      sceneRef.current.environmentIntensity = envIntensity;
    }
  }, [lightingPreset, exposure, keyIntensity, keyAzimuthDeg, envIntensity]);

  const applyPreset = (id: LightingPresetId) => {
    const p = LIGHTING_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setLightingPreset(id);
    setExposure(p.exposure);
    setKeyIntensity(p.keyIntensity);
  };

  // Sync wireframe state onto loaded meshes
  const applyWireframe = useCallback((root: THREE.Object3D, enabled: boolean) => {
    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (m && 'wireframe' in m) {
            (m as THREE.MeshStandardMaterial).wireframe = enabled;
          }
        }
      }
    });
  }, []);

  useEffect(() => {
    if (modelGroupRef.current) {
      applyWireframe(modelGroupRef.current, wireframe);
    }
  }, [wireframe, applyWireframe]);

  // Switch active animation clip
  useEffect(() => {
    const mixer = mixerRef.current;
    const clips = clipsRef.current;
    if (!mixer || clips.length === 0) return;
    mixer.stopAllAction();
    const target = clips[activeClipIdx] ?? clips[0];
    if (target) {
      const action = mixer.clipAction(target);
      action.reset().play();
    }
  }, [activeClipIdx]);

  // Load actual binary GLB into Three.js via GLTFLoader whenever selected model changes
  useEffect(() => {
    const modelGroup = modelGroupRef.current;
    if (!model) {
      setLiveStats(null);
      setLoadError(null);
      setLoadingPct(null);
      return;
    }
    if (!modelGroup || webglError) {
      // Surface server-validated stats even if WebGL is unavailable in headless device
      setLiveStats({
        vertices: model.statistics.vertices,
        triangles: model.statistics.triangles,
        materials: model.statistics.materialCount,
        meshes: model.statistics.meshCount,
        animations: model.statistics.animations.map((a) => a.name),
        dimensions: {
          width: model.statistics.dimensions.width,
          height: model.statistics.dimensions.height,
          depth: model.statistics.dimensions.depth,
        },
      });
      return;
    }

    let cancelled = false;
    const abortCtrl = new AbortController();
    setLoadingPct(5);
    setLoadError(null);

    const loadGlb = async () => {
      try {
        let arrayBuffer: ArrayBuffer;
        const cached = model.isDemo ? null : await getCachedModelGlb(model.id);

        if (cached) {
          arrayBuffer = cached;
          if (!cancelled) setLoadingPct(92);
        } else {
          const res = await fetch(model.downloadUrl, {
            headers: attachAuthHeaders(new Headers()),
            credentials: 'include',
            signal: abortCtrl.signal,
          });
          if (!res.ok) {
            throw new Error(`Failed to fetch GLB model (HTTP ${res.status}).`);
          }

          const total = Number.parseInt(res.headers.get('content-length') || '0', 10);

          if (res.body && total > 0) {
            const reader = res.body.getReader();
            const parts: Uint8Array[] = [];
            let received = 0;
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) {
                parts.push(value);
                received += value.byteLength;
                if (!cancelled) {
                  setLoadingPct(Math.min(92, Math.round((received / total) * 90)));
                }
              }
            }
            const combined = new Uint8Array(received);
            let offset = 0;
            for (const part of parts) {
              combined.set(part, offset);
              offset += part.byteLength;
            }
            arrayBuffer = combined.buffer;
          } else {
            arrayBuffer = await res.arrayBuffer();
          }

          if (!model.isDemo && arrayBuffer.byteLength <= 15 * 1024 * 1024) {
            void cacheModelGlb(model.id, arrayBuffer);
          }
        }

        if (cancelled) return;

        const loader = new GLTFLoader();
        const gltf = await new Promise<GLTF>((resolve, reject) => {
          loader.parse(arrayBuffer, '', resolve, reject);
        });

        if (cancelled) {
          disposeObject3D(gltf.scene);
          return;
        }

        // Clear previous model cleanly
        mixerRef.current?.stopAllAction();
        mixerRef.current = null;
        clipsRef.current = [];
        while (modelGroup.children.length > 0) {
          const prev = modelGroup.children[0];
          modelGroup.remove(prev);
          disposeObject3D(prev);
        }

        const root = gltf.scene;
        let vertices = 0;
        let triangles = 0;
        let meshes = 0;
        const uniqueMaterials = new Set<THREE.Material>();

        root.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            meshes++;
            obj.castShadow = true;
            obj.receiveShadow = true;
            const geo = obj.geometry as THREE.BufferGeometry;
            const pos = geo.getAttribute('position');
            if (pos) vertices += pos.count;
            const idx = geo.getIndex();
            if (idx) triangles += Math.floor(idx.count / 3);
            else if (pos) triangles += Math.floor(pos.count / 3);

            if (!geo.getAttribute('normal')) {
              geo.computeVertexNormals();
            }

            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (const m of mats) {
              if (m) uniqueMaterials.add(m);
            }
          }
        });

        // Compute true metric bounding box before grounding on the studio floor (y = 0)
        root.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(root);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);

        // Center X/Z at origin and rest bottom cleanly on the studio grid (y = 0)
        if (Number.isFinite(box.min.y)) {
          root.position.set(-center.x, -box.min.y, -center.z);
          root.updateMatrixWorld(true);
        }

        const groundedBox = new THREE.Box3().setFromObject(root);
        const sphere = new THREE.Sphere();
        groundedBox.getBoundingSphere(sphere);

        fitRadiusRef.current = Math.max(0.35, sphere.radius);
        fitCenterRef.current.copy(sphere.center);

        // Adjust key-light shadow frustum to match model scale
        if (keyLightRef.current) {
          const sd = Math.max(2.5, sphere.radius * 2.4);
          keyLightRef.current.shadow.camera.left = -sd;
          keyLightRef.current.shadow.camera.right = sd;
          keyLightRef.current.shadow.camera.top = sd;
          keyLightRef.current.shadow.camera.bottom = -sd;
          keyLightRef.current.shadow.camera.updateProjectionMatrix();
        }

        applyWireframe(root, wireframe);
        modelGroup.add(root);
        positionCameraForPreset('iso');

        // Setup animation playback if GLB contains clips
        if (gltf.animations && gltf.animations.length > 0) {
          const mixer = new THREE.AnimationMixer(root);
          mixerRef.current = mixer;
          clipsRef.current = gltf.animations;
          setActiveClipIdx(0);
          setAnimPlaying(true);
          mixer.clipAction(gltf.animations[0]).play();
        } else {
          clipsRef.current = [];
          setActiveClipIdx(0);
        }

        const computedStats: LiveSceneStats = {
          vertices,
          triangles,
          materials: uniqueMaterials.size,
          meshes,
          animations: (gltf.animations ?? []).map((c, i) => c.name || `Clip_${i + 1}`),
          dimensions: {
            width: Math.round(size.x * 1000) / 1000,
            height: Math.round(size.y * 1000) / 1000,
            depth: Math.round(size.z * 1000) / 1000,
          },
        };
        setLiveStats(computedStats);
        onSceneStats?.(computedStats);
        setLoadingPct(null);
      } catch (err) {
        if (cancelled || (err instanceof Error && err.name === 'AbortError')) return;
        setLoadingPct(null);
        setLoadError(err instanceof Error ? err.message : 'Unable to load GLB in 3D viewer.');
      }
    };

    void loadGlb();

    return () => {
      cancelled = true;
      abortCtrl.abort();
    };
  }, [model?.id, model?.downloadUrl, webglError, positionCameraForPreset, applyWireframe, onSceneStats]);

  // Fullscreen handling (with safe fallback when browser/iframe blocks native Fullscreen API)
  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const toggleFullscreen = async () => {
    const el = containerRef.current;
    if (!el) return;
    if (cssFullscreenFallback) {
      setCssFullscreenFallback(false);
      return;
    }
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }
    try {
      await el.requestFullscreen();
    } catch {
      setCssFullscreenFallback(true);
    }
  };

  const activeFullscreen = isFullscreen || cssFullscreenFallback;

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && onImportGlbFile) {
      onImportGlbFile(file);
    }
  };

  const stats = liveStats ?? (model
    ? {
        vertices: model.statistics.vertices,
        triangles: model.statistics.triangles,
        materials: model.statistics.materialCount,
        meshes: model.statistics.meshCount,
        animations: model.statistics.animations.map((a) => a.name),
        dimensions: model.statistics.dimensions,
      }
    : null);

  return (
    <div
      ref={containerRef}
      onDragOver={(e) => {
        e.preventDefault();
        if (!isDragOver) setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
      onClick={() => {
        if (openPopover) setOpenPopover(null);
      }}
      className={`relative flex h-full w-full flex-col overflow-hidden select-none ${
        activeFullscreen ? 'fixed inset-0 z-50' : ''
      }`}
      style={{ backgroundColor: bgColor }}
    >
      {/* Hidden local GLB import input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".glb,model/gltf-binary"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f && onImportGlbFile) onImportGlbFile(f);
          e.currentTarget.value = '';
        }}
      />

      {/* WebGL Canvas Container */}
      <div ref={mountRef} className="h-full w-full cursor-grab active:cursor-grabbing" />

      {/* Top-Left Model Badge + Animation Controls */}
      <div className="pointer-events-none absolute top-3 left-3 flex max-w-[68%] flex-wrap items-center gap-2">
        {model && (
          <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-[#252d3e]/90 bg-[#0e1219]/88 px-3 py-1.5 backdrop-blur-md">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                model.isDemo
                  ? 'bg-amber-400'
                  : model.sourceType === 'user_import'
                  ? 'bg-sky-400'
                  : 'bg-[#8ed90b]'
              }`}
            />
            <span className="truncate text-xs font-medium text-[#e6eaf2]">{model.name}</span>
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wider uppercase ${
                model.isDemo
                  ? 'border border-amber-500/30 bg-amber-500/12 text-amber-300'
                  : model.sourceType === 'user_import'
                  ? 'border border-sky-500/30 bg-sky-500/12 text-sky-300'
                  : 'border border-[#76b900]/35 bg-[#76b900]/14 text-[#a3e635]'
              }`}
            >
              {model.isDemo
                ? 'Demo Sample GLB'
                : model.sourceType === 'user_import'
                ? 'Imported GLB'
                : 'Generated GLB'}
            </span>
          </div>
        )}

        {stats && stats.animations.length > 0 && !webglError && (
          <div className="pointer-events-auto flex items-center gap-1.5 rounded-lg border border-[#252d3e]/90 bg-[#0e1219]/88 px-2 py-1 backdrop-blur-md">
            <button
              type="button"
              onClick={() => setAnimPlaying((p) => !p)}
              title={animPlaying ? 'Pause animation clip' : 'Play animation clip'}
              className="flex h-6 w-6 items-center justify-center rounded bg-[#1a202c] text-[#8ed90b] transition hover:bg-[#232b3b]"
            >
              {animPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            </button>
            {stats.animations.length > 1 ? (
              <select
                value={activeClipIdx}
                onChange={(e) => setActiveClipIdx(Number(e.target.value))}
                aria-label="Animation clip"
                className="bg-transparent text-[11px] font-medium text-[#cfd6e4] focus:outline-none"
              >
                {stats.animations.map((name, idx) => (
                  <option key={name} value={idx} className="bg-[#11141b]">
                    {name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="pr-1 font-mono-tech text-[11px] text-[#aeb7c9]">
                {stats.animations[0]}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Top-Right Camera Angle Bar */}
      {!webglError && (
        <div className="absolute top-3 right-3 flex items-center gap-1 rounded-lg border border-[#252d3e]/90 bg-[#0e1219]/88 p-1 backdrop-blur-md">
          {(
            [
              ['iso', 'Persp'],
              ['front', 'Front'],
              ['side', 'Side'],
              ['top', 'Top'],
            ] as const
          ).map(([preset, label]) => (
            <button
              key={preset}
              type="button"
              onClick={() => positionCameraForPreset(preset)}
              className="rounded px-2 py-1 text-[11px] font-medium text-[#9aa4b8] transition hover:bg-[#1c2330] hover:text-white"
            >
              {label}
            </button>
          ))}
          <div className="mx-0.5 h-3.5 w-px bg-[#252d3e]" />
          <button
            type="button"
            onClick={() => positionCameraForPreset('iso')}
            title="Reset camera framing"
            className="flex h-6 w-6 items-center justify-center rounded text-[#9aa4b8] transition hover:bg-[#1c2330] hover:text-white"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Streaming Load Overlay */}
      {loadingPct !== null && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#0b0d11]/45 backdrop-blur-[2px]">
          <div className="w-56 rounded-xl border border-[#283144] bg-[#11151d]/95 p-4 shadow-xl">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-[#e6eaf2]">Loading GLB 2.0</span>
              <span className="font-mono-tech text-[#8ed90b]">{loadingPct}%</span>
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[#1d2433]">
              <div
                className="h-full rounded-full bg-[#76b900] transition-all duration-150"
                style={{ width: `${loadingPct}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Error / Headless WebGL Notice */}
      {(loadError || webglError) && (
        <div className="absolute inset-x-4 top-16 mx-auto max-w-md rounded-xl border border-amber-500/35 bg-[#12161f]/95 p-4 backdrop-blur-md">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <div className="text-xs">
              <p className="font-semibold text-[#e6eaf2]">
                {webglError ? 'WebGL Hardware Context Unavailable' : 'Viewport Load Error'}
              </p>
              <p className="mt-1 leading-relaxed text-[#9aa4b8]">{webglError || loadError}</p>
              {model && webglError && (
                <p className="mt-2 text-[11px] text-[#7c879d]">
                  Binary GLB validation, model statistics, and genuine GLB/GLTF downloads remain active in the Inspector panel.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Drag-and-Drop GLB Overlay */}
      {isDragOver && (
        <div className="pointer-events-none absolute inset-3 flex items-center justify-center rounded-xl border-2 border-dashed border-[#8ed90b] bg-[#0b0d11]/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 text-center">
            <Upload className="h-7 w-7 text-[#8ed90b]" />
            <p className="text-sm font-semibold text-white">Drop GLB file to validate and inspect</p>
            <p className="text-xs text-[#9aa4b8]">Binary glTF 2.0 (.glb) with embedded textures</p>
          </div>
        </div>
      )}

      {/* Lighting Popover */}
      {openPopover === 'lighting' && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-16 left-1/2 z-20 w-72 -translate-x-1/2 rounded-xl border border-[#283144] bg-[#11151d]/96 p-3.5 shadow-2xl backdrop-blur-md"
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold tracking-wider text-[#cfd6e4] uppercase">
              Studio Lighting Rig
            </span>
            <button
              type="button"
              onClick={() => {
                applyPreset('studio');
                setKeyAzimuthDeg(42);
                setEnvIntensity(0.85);
              }}
              className="text-[11px] text-[#8ed90b] hover:underline"
            >
              Reset
            </button>
          </div>

          <div className="mt-2.5 grid grid-cols-2 gap-1.5">
            {LIGHTING_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => applyPreset(p.id)}
                className={`rounded-md border px-2.5 py-1.5 text-left text-[11px] font-medium transition ${
                  lightingPreset === p.id
                    ? 'border-[#76b900] bg-[#76b900]/15 text-white'
                    : 'border-[#232b3c] bg-[#161b25] text-[#9aa4b8] hover:border-[#323d54] hover:text-white'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="mt-3 space-y-2.5 text-[11px]">
            <div>
              <div className="mb-1 flex justify-between text-[#9aa4b8]">
                <span>Exposure</span>
                <span className="font-mono-tech text-[#d8deea]">{exposure.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0.4}
                max={2.2}
                step={0.02}
                value={exposure}
                onChange={(e) => setExposure(Number(e.target.value))}
                className="nv-slider w-full"
              />
            </div>

            <div>
              <div className="mb-1 flex justify-between text-[#9aa4b8]">
                <span>Key Light</span>
                <span className="font-mono-tech text-[#d8deea]">{keyIntensity.toFixed(1)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={4.5}
                step={0.1}
                value={keyIntensity}
                onChange={(e) => setKeyIntensity(Number(e.target.value))}
                className="nv-slider w-full"
              />
            </div>

            <div>
              <div className="mb-1 flex justify-between text-[#9aa4b8]">
                <span>Key Angle</span>
                <span className="font-mono-tech text-[#d8deea]">{keyAzimuthDeg} deg</span>
              </div>
              <input
                type="range"
                min={0}
                max={360}
                step={1}
                value={keyAzimuthDeg}
                onChange={(e) => setKeyAzimuthDeg(Number(e.target.value))}
                className="nv-slider w-full"
              />
            </div>

            <div>
              <div className="mb-1 flex justify-between text-[#9aa4b8]">
                <span>Studio IBL</span>
                <span className="font-mono-tech text-[#d8deea]">{envIntensity.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={envIntensity}
                onChange={(e) => setEnvIntensity(Number(e.target.value))}
                className="nv-slider w-full"
              />
            </div>
          </div>
        </div>
      )}

      {/* Background Popover */}
      {openPopover === 'background' && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-16 left-1/2 z-20 w-64 -translate-x-1/2 rounded-xl border border-[#283144] bg-[#11151d]/96 p-3.5 shadow-2xl backdrop-blur-md"
        >
          <span className="text-[11px] font-semibold tracking-wider text-[#cfd6e4] uppercase">
            Viewport Backdrop
          </span>
          <div className="mt-2.5 grid grid-cols-5 gap-2">
            {BG_PRESETS.map((swatch) => (
              <button
                key={swatch.id}
                type="button"
                title={swatch.label}
                onClick={() => setBgColor(swatch.hex)}
                className={`h-8 w-full rounded-md border transition ${
                  bgColor.toLowerCase() === swatch.hex.toLowerCase()
                    ? 'scale-105 border-[#8ed90b] ring-2 ring-[#76b900]/40'
                    : 'border-[#2f394e] hover:border-[#53627f]'
                }`}
                style={{ backgroundColor: swatch.hex }}
              />
            ))}
          </div>
          <label className="mt-3 flex items-center justify-between rounded-md border border-[#232b3c] bg-[#161b25] px-2.5 py-1.5 text-[11px] text-[#aeb7c9]">
            <span>Custom Hex</span>
            <span className="flex items-center gap-2">
              <span className="font-mono-tech uppercase">{bgColor}</span>
              <input
                type="color"
                value={bgColor}
                onChange={(e) => setBgColor(e.target.value)}
                className="h-5 w-6 cursor-pointer rounded border-0 bg-transparent p-0"
              />
            </span>
          </label>
        </div>
      )}

      {/* Bottom Floating Studio Control Dock + Live Geometry Telemetry */}
      <div className="pointer-events-none absolute inset-x-3 bottom-3 flex flex-wrap items-end justify-between gap-2">
        {/* Compact Geometry Readout */}
        {stats ? (
          <div
            className={`hidden items-center gap-3 rounded-lg border px-3 py-1.5 font-mono-tech text-[11px] backdrop-blur-md xl:flex ${
              isBrightBg
                ? 'border-slate-400/50 bg-slate-900/82 text-slate-100'
                : 'border-[#252d3e]/90 bg-[#0e1219]/88 text-[#aeb7c9]'
            }`}
          >
            <span>
              <strong className="font-medium text-white">{formatCount(stats.vertices)}</strong> verts
            </span>
            <span className="text-[#354056]">|</span>
            <span>
              <strong className="font-medium text-white">{formatCount(stats.triangles)}</strong> tris
            </span>
            <span className="text-[#354056]">|</span>
            <span>
              <strong className="font-medium text-white">{stats.materials}</strong> mats
            </span>
            <span className="text-[#354056]">|</span>
            <span>
              {formatDimensionMeters(stats.dimensions.width)} x{' '}
              {formatDimensionMeters(stats.dimensions.height)} x{' '}
              {formatDimensionMeters(stats.dimensions.depth)}
            </span>
          </div>
        ) : (
          <div />
        )}

        {/* Viewport Tool Controls */}
        <div
          onClick={(e) => e.stopPropagation()}
          className="pointer-events-auto mx-auto flex items-center gap-1 rounded-xl border border-[#262f42] bg-[#0e1219]/92 p-1 shadow-xl backdrop-blur-md xl:mx-0"
        >
          <button
            type="button"
            onClick={() => setShowGrid((g) => !g)}
            title="Toggle studio reference grid"
            aria-pressed={showGrid}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition ${
              showGrid
                ? 'bg-[#76b900]/16 text-[#a3e635]'
                : 'text-[#9aa4b8] hover:bg-[#1a212e] hover:text-white'
            }`}
          >
            <Grid3x3 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Grid</span>
          </button>

          <button
            type="button"
            onClick={() => setWireframe((w) => !w)}
            title="Toggle wireframe topology overlay"
            aria-pressed={wireframe}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition ${
              wireframe
                ? 'bg-[#76b900]/16 text-[#a3e635]'
                : 'text-[#9aa4b8] hover:bg-[#1a212e] hover:text-white'
            }`}
          >
            <Triangle className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Wireframe</span>
          </button>

          <button
            type="button"
            onClick={() => setAutoRotate((r) => !r)}
            title="Toggle turntable auto-rotation"
            aria-pressed={autoRotate}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition ${
              autoRotate
                ? 'bg-[#76b900]/16 text-[#a3e635]'
                : 'text-[#9aa4b8] hover:bg-[#1a212e] hover:text-white'
            }`}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Turntable</span>
          </button>

          <div className="mx-0.5 h-4 w-px bg-[#242c3d]" />

          <button
            type="button"
            onClick={() => setOpenPopover((p) => (p === 'lighting' ? null : 'lighting'))}
            title="Studio lighting & exposure controls"
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition ${
              openPopover === 'lighting'
                ? 'bg-[#76b900]/16 text-[#a3e635]'
                : 'text-[#9aa4b8] hover:bg-[#1a212e] hover:text-white'
            }`}
          >
            <Sun className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Lighting</span>
          </button>

          <button
            type="button"
            onClick={() => setOpenPopover((p) => (p === 'background' ? null : 'background'))}
            title="Customize viewport background"
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition ${
              openPopover === 'background'
                ? 'bg-[#76b900]/16 text-[#a3e635]'
                : 'text-[#9aa4b8] hover:bg-[#1a212e] hover:text-white'
            }`}
          >
            <Palette className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Backdrop</span>
          </button>

          {onImportGlbFile && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Import local GLB file into viewer"
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-[#9aa4b8] transition hover:bg-[#1a212e] hover:text-white"
            >
              <Upload className="h-3.5 w-3.5" />
              <span className="hidden md:inline">Import</span>
            </button>
          )}

          <div className="mx-0.5 h-4 w-px bg-[#242c3d]" />

          <button
            type="button"
            onClick={() => void toggleFullscreen()}
            title={activeFullscreen ? 'Exit fullscreen' : 'Fullscreen viewport'}
            aria-label={activeFullscreen ? 'Exit fullscreen' : 'Fullscreen viewport'}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[#9aa4b8] transition hover:bg-[#1a212e] hover:text-white"
          >
            {activeFullscreen ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
