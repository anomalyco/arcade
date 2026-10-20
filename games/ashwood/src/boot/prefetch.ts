import * as THREE from "three/webgpu"
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js"

// Download-ahead for boot assets that are only requested late (the interior asks for the documents atlas seconds into
// the boot, once it builds): `prefetch` starts the downloads right after WebGPU init, and three's FileLoader (used by
// GLTFLoader and KTX2Loader) hands a prefetched URL its bytes instead of requesting it again. Each prefetched buffer is
// used once (KTX2Loader transfers it to its worker); a URL nobody prefetched loads as usual.

const pending = new Map<string, Promise<ArrayBuffer>>()
const abs = (url: string) => new URL(url, document.baseURI).href

/** Starts downloading these URLs now (low priority: first-view assets are already in flight). */
export function prefetch(urls: readonly string[]) {
  for (const u of urls) {
    const key = abs(u)
    if (pending.has(key)) continue
    const p = fetch(key, { priority: "low" } as RequestInit).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status} ${u}`))))
    p.catch(() => pending.delete(key))
    pending.set(key, p)
  }
}

const load = THREE.FileLoader.prototype.load
THREE.FileLoader.prototype.load = function (this: THREE.FileLoader, url, onLoad, onProgress, onError) {
  const key = abs(this.manager.resolveURL((this.path ?? "") + url))
  const p = this.responseType === "arraybuffer" ? pending.get(key) : undefined
  if (!p) return load.call(this, url, onLoad, onProgress, onError)
  pending.delete(key)
  this.manager.itemStart(key)
  p.then(
    (buf) => {
      onLoad?.(buf as never)
      this.manager.itemEnd(key)
    },
    () => {
      // The early download failed: try once more the normal way.
      this.manager.itemEnd(key)
      load.call(this, url, onLoad, onProgress, onError)
    },
  )
  return undefined as never
}

// Meshopt-compressed GLB buffers decode in workers instead of on the main thread (same decoder, same output).
MeshoptDecoder.useWorkers?.(2)
