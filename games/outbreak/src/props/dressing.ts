import type { Batch, Renderer } from "@arcade/kit/gpu/renderer"
import { PROP_IDS } from "@arcade/kit/props/catalogue"
import { PropBatches, PropLibrary, PropModels, type PropInstance } from "@arcade/kit/props/models"
import type { QualityProfile } from "@arcade/kit/quality"
import type { Rect } from "@arcade/kit/sim/geom"
import type { Town } from "../../shared/map"
import { furnishedHouses, instancesOf, type HouseFurnishing } from "./furnish"
import type { OutbreakPropSettings } from "./settings"
import { propDressingState } from "./state"

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
  private houses: HouseFurnishing[] = []
  private instances: PropInstance[] = []

  /** `lampAux`: the map light slot lamp shades glow through (Outbreak's `TABLE_LAMP_SLOT`). */
  constructor(renderer: Pick<Renderer, "addModel" | "setModel">, lampAux?: number, library?: PropLibrary) {
    this.models = new PropModels(renderer, library, { lampAux })
    this.batches = new PropBatches(this.models)
    current = this
  }

  get ready(): boolean {
    return PROP_IDS.every(id => this.models.has(id) || this.models.library.failed.has(id))
  }

  /**
   * Per-frame: the prop batches to draw, empty while off, loading, or when the world is purely procedural.
   * Switching props on or off (or falling back if all `.prop` assets fail to load) calls `rebuildLevel` so the level
   * builder drops or restores the box furniture.
   */
  collect(town: Town, view: Rect, s: OutbreakPropSettings, zoom: number, quality: Pick<QualityProfile, "clutterScale" | "minPropLod">, originBuild: boolean, rebuildLevel: () => void): readonly Batch[] {
    if (Boolean(s.propsOn) && originBuild && !this.loading) {
      this.loading = this.models.ensure(PROP_IDS).then(() => {
        if (!PROP_IDS.some(id => this.models.has(id)) && propDressingState.on) {
          propDressingState.on = false
          rebuildLevel()
        }
      })
    }
    const available = !this.ready || PROP_IDS.some(id => this.models.has(id))
    const on = Boolean(s.propsOn) && originBuild && available
    const density = s.propClutter * quality.clutterScale
    const st = propDressingState
    // The level grounds floor clutter and bakes table-lamp pools from the same plan, so a new plan rebuilds it.
    if (st.on !== on || (on && (st.density !== density || st.seed !== s.propSeed))) {
      st.on = on
      st.density = density
      st.seed = s.propSeed
      rebuildLevel()
    }
    if (!on) return NONE
    const mStyle = Math.round((s as { modelStyle?: number }).modelStyle ?? st.modelStyle ?? 0)
    const look =
      mStyle === 1 || mStyle === 2
        ? { brightness: s.propBrightness * 0.94, ao: Math.min(1, Math.max(s.propAO, 0.78)), saturation: s.propSaturation * 1.16 }
        : mStyle === 3
          ? { brightness: s.propBrightness * 0.90, ao: Math.min(1, Math.max(s.propAO, 0.88)), saturation: s.propSaturation * 1.12 }
          : { brightness: s.propBrightness, ao: s.propAO, saturation: s.propSaturation }
    this.models.setLook(look)
    const houses = furnishedHouses(town)
    if (houses !== this.houses) {
      this.houses = houses
      this.instances = houses.flatMap(instancesOf)
    }
    const effectiveLodZoom = mStyle === 1 || mStyle === 2 ? Math.max(s.propLodZoom, 52) : s.propLodZoom
    const lod = Math.max(quality.minPropLod, zoom > effectiveLodZoom ? 1 : 0)
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
