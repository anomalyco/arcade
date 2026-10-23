import { loadGltf } from "../gpu/gltf"
import type { Renderer } from "../gpu/renderer"
import type { SceneHooks } from "../gpu/shaders"
import { TexturedMeshPass } from "../gpu/textured-mesh"
import { defaultPropBaseUrl, type PropInstance } from "./models"

type Entry = { pass: TexturedMeshPass; asset: Awaited<ReturnType<typeof loadGltf>>; data: Float32Array; count: number }

/** One material draw per prop, regardless of placement count. Games supply the shipped ids and scene lighting. */
export class TexturedPropBatches {
  private readonly entries = new Map<string, Entry>()
  private readonly pending = new Set<string>()
  private disposed = false
  readonly failed = new Set<string>()

  constructor(private readonly renderer: Pick<Renderer, "passContext" | "addPass" | "removePass">,
    private readonly hooks: SceneHooks, private readonly ids: ReadonlySet<string>, private readonly base = defaultPropBaseUrl()) {}

  private load(id: string) {
    if (!this.ids.has(id) || this.pending.has(id) || this.entries.has(id) || this.failed.has(id) || this.disposed) return
    this.pending.add(id)
    void loadGltf(this.renderer.passContext.device, `${this.base}${id}.glb`).then(asset => {
      if (this.disposed) { asset.dispose(); return }
      try {
        const pass = new TexturedMeshPass(this.renderer.passContext,
          asset.primitives.map(p => ({ ...p, instances: new Float32Array(0) })), this.hooks)
        this.renderer.addPass("opaque", pass)
        this.entries.set(id, { pass, asset, data: new Float32Array(0), count: 0 })
      } catch (error) { asset.dispose(); throw error }
    }).catch(error => {
      this.failed.add(id)
      console.warn(`[textured props] ${id}:`, error)
    }).finally(() => this.pending.delete(id))
  }

  /** Call each frame, including off frames. Returns whether a placement is replaced this frame. */
  collect(instances: readonly PropInstance[], enabled: boolean, visible: (p: PropInstance) => boolean): (p: PropInstance) => boolean {
    for (const entry of this.entries.values()) entry.count = 0
    if (enabled) for (const p of instances) {
      if (!visible(p)) continue
      this.load(p.id)
      const entry = this.entries.get(p.id)
      if (!entry) continue
      if (entry.data.length < (entry.count + 1) * 12) {
        const grown = new Float32Array(Math.max(16, (entry.count + 1) * 2) * 12)
        grown.set(entry.data)
        entry.data = grown
      }
      entry.data.set([p.x, p.y, p.z, p.yaw, 1, 1, 1, p.scale, 0, 0, 1, 0], entry.count++ * 12)
    }
    for (const entry of this.entries.values()) entry.pass.setAllInstances(entry.data, entry.count)
    return p => enabled && this.entries.has(p.id)
  }

  stats() { return { loaded: [...this.entries.keys()], pending: [...this.pending], failed: [...this.failed] } }

  dispose() {
    this.disposed = true
    for (const entry of this.entries.values()) {
      this.renderer.removePass(entry.pass)
      entry.pass.dispose()
      entry.asset.dispose()
    }
    this.entries.clear()
  }
}
