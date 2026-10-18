import type { Batch, Renderer } from "@arcade/kit/gpu/renderer"
import { PROP_IDS } from "@arcade/kit/props/catalogue"
import { PropBatches, PropLibrary, PropModels, type PropInstance } from "@arcade/kit/props/models"
import type { QualityProfile } from "@arcade/kit/quality"
import type { Rect } from "@arcade/kit/sim/geom"
import type { Town } from "../../shared/map"
import { furnishedHouses, instancesOf, usedPropIds, type HouseFurnishing } from "./furnish"
import type { OutbreakPropSettings } from "./settings"
import { propDressingState } from "./state"

const NONE: readonly Batch[] = []
let current: PropDressing | null = null
/** Telemetry of the live dressing (the harness reads it as `state().props`). */
export const propDressingStats = (): Record<string, unknown> | null => current?.stats() ?? null

/**
 * Draws the start block's houses furnished from `@arcade/kit/props`: loads the start-house props first and defers the
 * rest of the catalogue until after the first furnished frame, plans each house once per (town, clutter, seed), and
 * packs one instanced draw per prop and LOD each frame (falling back to timber boxes until each anchor prop is ready).
 */
export class PropDressing {
  readonly models: PropModels
  private readonly batches: PropBatches
  private loading: Promise<void> | null = null
  private releaseStage2: (() => void) | null = null
  private houses: HouseFurnishing[] = []
  private instances: PropInstance[] = []
  private usedIds: string[] = []

  /** `lampAux`: the map light slot lamp shades glow through (Outbreak's `TABLE_LAMP_SLOT`). */
  constructor(renderer: Pick<Renderer, "addModel" | "setModel">, lampAux?: number, library?: PropLibrary) {
    this.models = new PropModels(renderer, library, { lampAux, boxFallback: true })
    this.batches = new PropBatches(this.models)
    current = this
  }

  /** True once every prop used by the start houses (`furnishedHouses`) has loaded or failed. */
  get furnishedReady(): boolean {
    return this.usedIds.length > 0 && this.usedIds.every(id => this.models.has(id) || this.models.library.failed.has(id))
  }

  get ready(): boolean {
    return PROP_IDS.every(id => this.models.has(id) || this.models.library.failed.has(id))
  }

  /**
   * Per-frame: the prop batches to draw, empty while off or when the world is purely procedural.
   * Switching props on or off (or falling back if all `.prop` assets fail to load) calls `rebuildLevel` so the level
   * builder drops or restores the box furniture.
   */
  collect(town: Town, view: Rect, s: OutbreakPropSettings, zoom: number, quality: Pick<QualityProfile, "clutterScale" | "minPropLod">, originBuild: boolean, rebuildLevel: () => void): readonly Batch[] {
    const settled = this.furnishedReady || this.ready
    const available = !settled || this.usedIds.some(id => this.models.has(id)) || PROP_IDS.some(id => this.models.has(id))
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
      this.usedIds = usedPropIds(houses)
      if (this.loading) {
        const missing = this.usedIds.filter(id => !this.models.has(id) && !this.models.library.failed.has(id))
        if (missing.length) void this.models.ensure(missing)
      }
    }
    if (!this.loading) {
      const stage1 = this.usedIds.length ? [...this.usedIds] : PROP_IDS
      this.loading = this.models.ensure(stage1).then(async () => {
        if (!stage1.some(id => this.models.has(id)) && propDressingState.on) {
          propDressingState.on = false
          rebuildLevel()
        }
        // Defer unused catalogue props until after the first furnished frame renders (or idle fallback).
        await new Promise<void>(r => {
          this.releaseStage2 = r
          setTimeout(r, 12)
        })
        this.releaseStage2 = null
        const rest = PROP_IDS.filter(id => !this.models.has(id) && !this.models.library.failed.has(id))
        if (rest.length) await this.models.ensure(rest)
      })
    } else if (this.releaseStage2 && this.furnishedReady) {
      const release = this.releaseStage2
      this.releaseStage2 = null
      queueMicrotask(release)
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
      furnishedReady: this.furnishedReady,
      ready: this.ready,
      usedProps: this.usedIds.length,
      failed: [...this.models.library.failed],
      houses: this.houses.map(h => ({ building: h.building, anchors: h.anchors.length, clutter: h.clutter.length, trianglesLod0: h.triangles })),
      lastFrame: propDressingState.on ? { ...this.batches.stats } : null,
    }
  }
}
