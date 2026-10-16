import type { Mesh } from "../gpu/mesh"
import { INST_FLOATS, type Batch } from "../gpu/renderer"
import { PROP_IDS, propSpec } from "./catalogue"
import { decodeProp, propTriangles, type PropAsset, type PropLod } from "./format"
import { DEFAULT_PROP_LOOK, propMesh, type PropLook } from "./mesh"

/** One placed prop: game-space position of its floor pivot, yaw (0 faces +Z), uniform scale. */
export type PropInstance = { id: string; x: number; y: number; z: number; yaw: number; scale: number }

/** Each host serves `packages/kit/props/assets/` under its own prefix-safe `prop-assets/` route (`scripts/prop-assets.ts`). */
export function defaultPropBaseUrl(): string {
  const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env
  const base = env?.BASE_URL ?? "./"
  return `${base.endsWith("/") ? base : `${base}/`}prop-assets/`
}

/** Fetches and decodes `.prop` files once each. */
export class PropLibrary {
  private readonly assets = new Map<string, PropAsset>()
  private readonly pending = new Map<string, Promise<PropAsset | undefined>>()
  readonly failed = new Set<string>()

  constructor(readonly baseUrl = defaultPropBaseUrl(), private readonly fetcher: (url: string) => Promise<Response> = url => fetch(url)) {}

  get(id: string): PropAsset | undefined {
    return this.assets.get(id)
  }

  load(id: string): Promise<PropAsset | undefined> {
    const have = this.assets.get(id)
    if (have) return Promise.resolve(have)
    let p = this.pending.get(id)
    if (!p) {
      p = this.fetcher(`${this.baseUrl}${id}.prop`)
        .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
        .then(buf => {
          const asset = decodeProp(buf)
          this.assets.set(id, asset)
          return asset
        })
        .catch(err => {
          this.failed.add(id)
          console.warn(`[props] ${id}: ${err instanceof Error ? err.message : err}`)
          return undefined
        })
      this.pending.set(id, p)
    }
    return p
  }

  async loadAll(ids: readonly string[] = PROP_IDS): Promise<void> {
    await Promise.all(ids.map(id => this.load(id)))
  }
}

/** The renderer surface props need: register a model, and optionally replace one in place when the look changes. */
export type PropModelHost = { addModel(mesh: Mesh): number; setModel?(index: number, mesh: Mesh): void }

export type PropModelOptions = {
  /**
   * Map light slot for lamp shades (`PropSpec.shade`): their faces draw as `MAT.lamp` with this aux, so they glow and
   * dim with whatever the game drives that slot with. Models are shared by every instance, so one slot serves all.
   * Without it shades are plain lit faces.
   */
  lampAux?: number
}

/** Registers every loaded prop's LODs as instanced models (`Renderer.addModel`) and rebuilds them when the look changes. */
export class PropModels {
  private readonly models = new Map<string, number[]>()
  private look: PropLook = { ...DEFAULT_PROP_LOOK }

  constructor(private readonly host: PropModelHost, readonly library = new PropLibrary(), private readonly options: PropModelOptions = {}) {}

  private mesh(id: string, lod: PropLod): Mesh {
    const shade = propSpec(id).shade
    const aux = this.options.lampAux
    return propMesh(lod, this.look, shade !== undefined && aux !== undefined ? { from: shade * propSpec(id).size[1], aux } : undefined)
  }

  /** Loads and registers the given props; resolves when all that exist are drawable. */
  async ensure(ids: readonly string[]): Promise<void> {
    await this.library.loadAll(ids)
    for (const id of ids) {
      if (this.models.has(id)) continue
      const asset = this.library.get(id)
      if (asset) this.models.set(id, asset.lods.map(lod => this.host.addModel(this.mesh(id, lod))))
    }
  }

  has(id: string): boolean {
    return this.models.has(id)
  }

  /** Model index for a prop at a LOD (clamped to the LODs it has). */
  model(id: string, lod: number): number | undefined {
    const m = this.models.get(id)
    return m ? m[Math.min(lod, m.length - 1)] : undefined
  }

  lodCount(id: string): number {
    return this.models.get(id)?.length ?? 0
  }

  triangles(id: string, lod: number): number {
    const a = this.library.get(id)
    return a ? propTriangles(a.lods[Math.min(lod, a.lods.length - 1)]!) : 0
  }

  setLook(look: PropLook): void {
    if (look.brightness === this.look.brightness && look.ao === this.look.ao && look.saturation === this.look.saturation) return
    this.look = { ...look }
    if (!this.host.setModel) return
    for (const [id, models] of this.models) {
      const asset = this.library.get(id)!
      models.forEach((index, lod) => this.host.setModel!(index, this.mesh(id, asset.lods[lod]!)))
    }
  }
}

/** Packs placed props into one instanced batch per (prop, LOD); reuses its buffers between frames. */
export class PropBatches {
  private readonly buffers = new Map<number, Float32Array<ArrayBuffer>>()
  private readonly counts = new Map<number, number>()
  private readonly out: Batch[] = []
  /** Triangles and draws in the last `collect`. */
  readonly stats = { draws: 0, instances: 0, triangles: 0 }

  constructor(private readonly models: PropModels) {}

  /**
   * `lod` picks the mesh per instance (for example by camera height); `visible` culls (for example against the camera's
   * ground rect). Instances whose prop has not loaded are skipped.
   */
  collect(instances: readonly PropInstance[], lod: (p: PropInstance) => number, visible: (p: PropInstance) => boolean = () => true): readonly Batch[] {
    this.counts.clear()
    this.out.length = 0
    this.stats.draws = this.stats.instances = this.stats.triangles = 0
    for (const p of instances) {
      if (!visible(p)) continue
      const l = lod(p)
      const model = this.models.model(p.id, l)
      if (model === undefined) continue
      const n = this.counts.get(model) ?? 0
      let buf = this.buffers.get(model)
      if (!buf || buf.length < (n + 1) * INST_FLOATS) {
        const grown = new Float32Array(Math.max(16, (n + 1) * 2) * INST_FLOATS)
        if (buf) grown.set(buf.subarray(0, n * INST_FLOATS))
        buf = grown
        this.buffers.set(model, buf)
      }
      const o = n * INST_FLOATS
      buf[o] = p.x; buf[o + 1] = p.y; buf[o + 2] = p.z; buf[o + 3] = p.yaw
      buf[o + 4] = 1; buf[o + 5] = 1; buf[o + 6] = 1; buf[o + 7] = p.scale
      buf[o + 8] = 0; buf[o + 9] = 0; buf[o + 10] = 1; buf[o + 11] = 0
      this.counts.set(model, n + 1)
      this.stats.instances++
      this.stats.triangles += this.models.triangles(p.id, l)
    }
    for (const [model, count] of this.counts) this.out.push({ model, data: this.buffers.get(model)!, count })
    this.stats.draws = this.out.length
    return this.out
  }
}

/** Yaw that turns a prop's front (+Z) toward the direction (dx, dz). Matches the instance shader's rotation. */
export const yawFacing = (dx: number, dz: number): number => Math.atan2(-dx, dz)
