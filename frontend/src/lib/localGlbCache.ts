// ============================================================================
// Client-side IndexedDB + Memory Cache for Validated User GLB Binaries
// Ensures models generated on zero-DB serverless deployments (Vercel /tmp)
// always load in the Three.js viewport and export cleanly across instances.
// ============================================================================

const DB_NAME = 'nv3d_studio_glb_cache';
const STORE_NAME = 'glb_binaries';
const MAX_MEMORY_ITEMS = 8;

const memoryCache = new Map<string, ArrayBuffer>();

function openCacheDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export function decodeBase64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = window.atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function cacheModelGlb(modelId: string, buffer: ArrayBuffer): Promise<void> {
  if (!modelId || buffer.byteLength < 20) return;
  const copy = buffer.slice(0);
  memoryCache.set(modelId, copy);
  if (memoryCache.size > MAX_MEMORY_ITEMS) {
    const oldest = memoryCache.keys().next().value;
    if (oldest) memoryCache.delete(oldest);
  }

  const db = await openCacheDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(copy, modelId);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

export async function getCachedModelGlb(modelId: string): Promise<ArrayBuffer | null> {
  const mem = memoryCache.get(modelId);
  if (mem) return mem.slice(0);

  const db = await openCacheDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(modelId);
      req.onsuccess = () => {
        db.close();
        const result = req.result;
        if (result instanceof ArrayBuffer && result.byteLength >= 20) {
          memoryCache.set(modelId, result);
          resolve(result.slice(0));
        } else {
          resolve(null);
        }
      };
      req.onerror = () => {
        db.close();
        resolve(null);
      };
    } catch {
      db.close();
      resolve(null);
    }
  });
}

export async function removeCachedModelGlb(modelId: string): Promise<void> {
  memoryCache.delete(modelId);
  const db = await openCacheDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(modelId);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

/**
 * Convert a validated GLB 2.0 ArrayBuffer into a self-contained embedded glTF 2.0 JSON Blob
 * when exporting from client cache on stateless serverless instances.
 */
export function convertCachedGlbToEmbeddedGltf(glbBuffer: ArrayBuffer): Blob {
  const view = new DataView(glbBuffer);
  if (glbBuffer.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) {
    throw new Error('Cached binary is not a valid GLB 2.0 container.');
  }
  const jsonLen = view.getUint32(12, true);
  const jsonType = view.getUint32(16, true);
  if (jsonType !== 0x4e4f534a || 20 + jsonLen > glbBuffer.byteLength) {
    throw new Error('Malformed GLB JSON chunk.');
  }
  const jsonText = new TextDecoder('utf-8').decode(new Uint8Array(glbBuffer, 20, jsonLen));
  const gltf = JSON.parse(jsonText) as {
    buffers?: Array<{ byteLength: number; uri?: string }>;
  };

  const binHeaderOffset = 20 + jsonLen;
  if (
    binHeaderOffset + 8 <= glbBuffer.byteLength &&
    Array.isArray(gltf.buffers) &&
    gltf.buffers.length > 0 &&
    !gltf.buffers[0].uri
  ) {
    const binLen = view.getUint32(binHeaderOffset, true);
    const binBytes = new Uint8Array(
      glbBuffer,
      binHeaderOffset + 8,
      Math.min(binLen, glbBuffer.byteLength - (binHeaderOffset + 8))
    );
    let binStr = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < binBytes.length; i += chunkSize) {
      binStr += String.fromCharCode(...binBytes.subarray(i, i + chunkSize));
    }
    gltf.buffers[0].uri = `data:application/octet-stream;base64,${window.btoa(binStr)}`;
    gltf.buffers[0].byteLength = binBytes.byteLength;
  }

  return new Blob([JSON.stringify(gltf, null, 2)], {
    type: 'model/gltf+json; charset=utf-8',
  });
}
