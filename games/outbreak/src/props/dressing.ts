import type { Batch, Renderer } from "@arcade/kit/gpu/renderer"
import { PROP_IDS } from "@arcade/kit/props/catalogue"
import { PropBatches, PropModels, type PropInstance } from "@arcade/kit/props/models"
import type { Rect } from "@arcade/kit/sim/geom"
import type { Town } from "../../shared/map"
import { furnishHouse, instancesOf, type HouseFurnishing } from "./furnish"
import type { OutbreakPropSettings } from "./settings"
import { furnishedHouse, propDressingState } from "./state"

const NONE: readonly Batch[] = []
let current: PropDressing | null = null
/** Telemetry of the live dressing (the harness reads it as `state().props`). */
export const propDressingStats = (): Record<string, unknown> | null => current?.stats() ?? null

/**
 * Draws the start block's houses furnished from `@arcade/kit/props`: loads the library on first use, plans each house
 * once per (town, clutter, seed), and packs one instanced draw per prop and LOD each frame.
 */
export class PropDressing {
  readonly models: PropModels
  private readonly batches: PropBatches
  private loading: Promise<void> | null = null
  private key = ""
  private houses: HouseFurnishing[] = []
  private instances: PropInstance[] = []

  constructor(renderer: Pick<Renderer, "addModel" | "setModel">) {
    this.models = new PropModels(renderer)
    this.batches = new PropBatches(this.models)
    current = this
  }

  get ready(): boolean {
    return PROP_IDS.every(id => this.models.has(id) || this.models.library.failed.has(id))
  }

  /**
   * Per-frame: the prop batches to draw, empty while off, loading, or when the level on screen is a streamed one.
   * Switching props on or off calls `rebuildLevel` so the level builder drops or restores the box furniture.
   */
  collect(town: Town, view: Rect, s: OutbreakPropSettings, zoom: number, clutterScale: number, originBuild: boolean, rebuildLevel: () => void): readonly Batch[] {
    const on = Boolean(s.propsOn)
    if (propDressingState.on !== on) {
      propDressingState.on = on
      rebuildLevel()
    }
    if (!on || !originBuild) return NONE
    if (!this.loading) this.loading = this.models.ensure(PROP_IDS)
    this.models.setLook({ brightness: s.propBrightness, ao: s.propAO, saturation: s.propSaturation })
    const density = s.propClutter * clutterScale
    const key = `${town.seed}/${town.houseSeed}/${density}/${s.propSeed}/${town.buildings.length}`
    if (key !== this.key) {
      this.key = key
      this.houses = town.buildings.filter(furnishedHouse).map(b => furnishHouse(b, town, density, s.propSeed))
      this.instances = this.houses.flatMap(instancesOf)
    }
    const lod = zoom > s.propLodZoom ? 1 : 0
    const [x0, z0, x1, z1] = view
    return this.batches.collect(this.instances, () => lod, p => p.x > x0 - 2 && p.x < x1 + 2 && p.z > z0 - 2 && p.z < z1 + 2)
  }

  /** Telemetry for the harness and proofs. */
  stats(): Record<string, unknown> {
    return {
      on: propDressingState.on,
      ready: this.ready,
      failed: [...this.models.library.failed],
      houses: this.houses.map(h => ({ building: h.building, anchors: h.anchors.length, clutter: h.clutter.length, trianglesLod0: h.triangles })),
      lastFrame: propDressingState.on ? { ...this.batches.stats } : null,
    }
  }
}
