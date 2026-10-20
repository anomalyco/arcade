import * as THREE from "three/webgpu"
import { foliageAtlas, mipChain, paintImpostors, undergrowthAtlas, type ImpostorInput, type Level } from "./paint"
import { placeTrees, type Trees } from "./placement"
import type { Request, Response } from "./atlas.worker"

// Forest generation client. Texture painting, mip chains and placement (~200 ms of CPU) run in a Worker that starts
// as soon as this module is imported, so boot never blocks on them; if Workers or OffscreenCanvas are unavailable
// the same code runs here instead.

export { CELL, FOLIAGE, UNDER, cellRect } from "./paint"

export const FOREST_SEED = 1984
export const FOREST_DENSITY = 1

/** Wraps a precomputed mip chain in a texture (sRGB colour, straight alpha). */
export function levelsTexture(levels: Level[]) {
  const base = levels[0]!
  const tex = new THREE.DataTexture(base.data, base.width, base.height, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.mipmaps = levels as unknown as THREE.DataTexture["mipmaps"]
  tex.generateMipmaps = false
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.anisotropy = 4
  tex.colorSpace = THREE.SRGBColorSpace
  tex.flipY = false
  tex.needsUpdate = true
  return tex
}

type Kind = Response["kind"]
type Of<K extends Kind> = Extract<Response, { kind: K }>

/** A forest worker with one pending reply per request kind. */
class Gen {
  private waiting = new Map<Kind, (r: Response) => void>()
  readonly worker: Worker

  constructor() {
    this.worker = new Worker(new URL("./atlas.worker.ts", import.meta.url), { type: "module", name: "forest" })
    this.worker.onmessage = (e: MessageEvent<Response>) => {
      const r = e.data
      if (r.kind === "error") this.failAll(r.error)
      else this.waiting.get(r.kind)?.(r)
    }
    this.worker.onerror = (e) => this.failAll(e.message || "worker failed to load")
  }

  private failAll(error: string) {
    for (const w of this.waiting.values()) w({ kind: "error", error })
    this.waiting.clear()
  }

  ask<K extends Exclude<Kind, "error">>(req: Request & { kind: K }): Promise<Of<K>> {
    return new Promise((resolve, reject) => {
      this.waiting.set(req.kind, (r) => (r.kind === req.kind ? resolve(r as Of<K>) : reject(new Error(`forest worker: ${"error" in r ? r.error : r.kind}`))))
      this.worker.postMessage(req)
    })
  }
}

function start() {
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") return null
  try {
    // Two workers in parallel: atlases (and later impostors) in one, placement in the other.
    const tex = new Gen()
    const place = new Gen()
    const textures = tex.ask({ kind: "textures" })
    const trees = place.ask({ kind: "trees", seed: FOREST_SEED, density: FOREST_DENSITY })
    trees.finally(() => place.worker.terminate()).catch(() => {})
    textures.catch(() => tex.worker.terminate())
    return { tex, textures, trees }
  } catch {
    return null
  }
}
const jobs = start()

const fallback = <T>(what: string, local: () => T) => (e: unknown) => {
  console.warn(`${e}; generating forest ${what} on the main thread`)
  return local()
}

/** Foliage and undergrowth atlases plus tree placement. */
export async function forestBase() {
  const noWorker = Promise.reject(new Error("no worker"))
  noWorker.catch(() => {})
  const [t, p] = await Promise.all([
    (jobs?.textures ?? noWorker).catch(
      fallback("textures", (): Of<"textures"> => ({ kind: "textures", foliage: mipChain(foliageAtlas()), undergrowth: mipChain(undergrowthAtlas()), ms: 0 })),
    ),
    (jobs?.trees ?? noWorker).catch(fallback("placement", (): Of<"trees"> => ({ kind: "trees", trees: placeTrees({ seed: FOREST_SEED, density: FOREST_DENSITY }), ms: 0 }))),
  ])
  return { foliage: levelsTexture(t.foliage), undergrowth: levelsTexture(t.undergrowth), trees: p.trees as Trees, workerMs: { textures: t.ms, trees: p.ms } }
}

/** The far-tree impostor atlas, painted from the given tree models. */
export async function forestImpostors(impostors: ImpostorInput[]) {
  const local = () => levelsTexture(mipChain(paintImpostors(impostors, foliageAtlas())))
  if (!jobs) return local()
  // Same worker as the atlases, so it reuses the painted foliage.
  const r = await jobs.tex.ask({ kind: "impostors", impostors }).catch(() => null)
  jobs.tex.worker.terminate()
  return r ? levelsTexture(r.impostors) : fallback("impostors", local)("worker failed")
}
