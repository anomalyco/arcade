import type { LabControl } from "@arcade/kit/lab-panel"
import { defaultTextureBaseUrl } from "@arcade/kit/textures/manifest"
import { distToRect } from "@arcade/kit/sim/geom"
import type { Building } from "../../shared/map"
import { buildingStreamSlot, INTERIOR_THEMES, INTERIOR_THEME_LABELS, interiorSettings, planInterior, rugKey, themeIndex } from "./plan"
import { RugPool, type RugRequest } from "./rug-pool"
import { DEFAULT_SCONCE_LIGHT_SETTINGS, SconceLights, type SconceLightSettings } from "./sconces"
import { INTERIOR_UNIFORM_FLOATS, RUG_DIRECTORY_SLOTS } from "./wgsl"

export { collectSconces, emitBuildingRugs, emitInteriorDecor } from "./mesh"
export { interiorSettings, planInterior } from "./plan"
export { SCONCE_LAMP_SLOT, SconceLights } from "./sconces"

/** Typed Lab settings for rugs and themed interiors. */
export type InteriorLabSettings = SconceLightSettings & {
  /** 0 procedural bake, 1 the hand-painted manifest rugs, 2 flat placeholder colour. */
  rugSource: number
  rugResolution: number
  rugLayers: number
  rugMipBias: number
  rugBrightness: number
  rugRelief: number
  interiorTheme: number
  rugSeed: number
  interiorDecor: number
  wainscot: number
  /** Spike (AR-42): Ash's living room and hall floor drawn from a painted plate (0 off, 1 on). */
  paintedPlate: number
  plateBrightness: number
}

export const DEFAULT_INTERIOR_SETTINGS: InteriorLabSettings = {
  rugSource: 0,
  rugResolution: 1024,
  rugLayers: 8,
  rugMipBias: -0.4,
  rugBrightness: 1,
  rugRelief: 0.6,
  interiorTheme: -1,
  rugSeed: 0,
  interiorDecor: 1,
  wainscot: 1,
  paintedPlate: 0,
  plateBrightness: 1.7,
  ...DEFAULT_SCONCE_LIGHT_SETTINGS,
}

/** Keys whose change rebuilds static level geometry (rug quads, decor) rather than updating uniforms. */
export const INTERIOR_STRUCTURAL_KEYS = new Set(["interiorTheme", "rugSeed", "interiorDecor", "wainscot"])

export function interiorControls(onStructural: () => void, onPool: () => void, onSource: () => void = () => {}): LabControl[] {
  const group = "Rugs & interiors"
  return [
    { key: "rugSource", label: "Rug source", group, type: "select", options: [{ value: 0, label: "Procedural (baked)" }, { value: 1, label: "Hand-painted textures" }, { value: 2, label: "Flat colour" }], change: onSource },
    { key: "interiorTheme", label: "Interior theme", group, type: "select", options: [{ value: -1, label: "Seeded per building" }, ...INTERIOR_THEMES.map((t, i) => ({ value: i, label: INTERIOR_THEME_LABELS[t] }))], change: onStructural },
    { key: "rugSeed", label: "Rug reroll", group, min: 0, max: 99, step: 1, unit: "", change: onStructural },
    { key: "rugMipBias", label: "Rug sharpness (mip bias)", group, min: -1.5, max: 1, step: 0.05, unit: "" },
    { key: "rugBrightness", label: "Rug brightness", group, min: 0.5, max: 1.6, step: 0.05, unit: "×" },
    { key: "rugRelief", label: "Pile relief", group, min: 0, max: 2, step: 0.05, unit: "×" },
    { key: "interiorDecor", label: "RE dressing", group, type: "toggle", change: onStructural },
    { key: "wainscot", label: "Wainscoting", group, type: "toggle", change: onStructural },
    { key: "sconceLights", label: "Lit sconce pairs", group, type: "select", options: [{ value: -1, label: "Quality tier" }, { value: 0, label: "Off" }, { value: 1, label: "1" }, { value: 2, label: "2" }, { value: 3, label: "3" }, { value: 4, label: "4" }] },
    { key: "sconcePower", label: "Sconce brightness", group, min: 0, max: 3, step: 0.05, unit: "×" },
    { key: "sconceRadius", label: "Sconce reach", group, min: 1.5, max: 5, step: 0.1, unit: "m" },
    { key: "paintedPlate", label: "Painted floor plate (Ash)", group: "Look · Detail", type: "toggle" },
    { key: "plateBrightness", label: "Plate brightness", group: "Look · Detail", min: 0.5, max: 3.5, step: 0.05, unit: "×" },
    { key: "rugResolution", label: "Rug texture size", group, type: "select", folded: true, options: [{ value: 512, label: "512 px" }, { value: 1024, label: "1024 px" }, { value: 2048, label: "2048 px" }], change: onPool },
    { key: "rugLayers", label: "Rug texture layers", group, min: 2, max: 16, step: 1, unit: "", folded: true, change: onPool },
  ]
}

/**
 * The painted floor plate: the Resident Evil mansion paint-over of the entry hall, rectified onto the floor plane
 * through the gameplay camera, cleaned of furniture and light by an image edit (one 1024² pool layer). It covers
 * `PLATE_RECT` in `wgsl.ts`; rugs and furniture draw on top and the live lights light it.
 */
const PLATE_URL = new URL("./plates/ash-hall-floor.webp", import.meta.url).href

const HANDMADE = { persian: "rug_persian_burgundy.webp", sage: "rug_oriental_sage.webp", runner: "rug_braided_runner.webp" }

/**
 * Owns the rug texture pool for a renderer: decides which rugs near the survivor are baked, and packs the rug
 * directory, rug config and per-building themes into the game's uniform block.
 */
export class InteriorPresenter {
  pool: RugPool
  readonly sconces = new SconceLights()
  private lastPlan = 0
  private lastKey = ""
  private lastBuildingsRef: readonly Building[] | null = null
  private lastBuildingsIds = ""

  constructor(private readonly device: GPUDevice, private readonly bind: (view: GPUTextureView) => void, readonly settings: InteriorLabSettings = { ...DEFAULT_INTERIOR_SETTINGS }) {
    this.syncShared()
    this.pool = this.makePool()
  }

  private makePool(): RugPool {
    const pool = new RugPool(this.device, { size: this.settings.rugResolution, rugLayers: this.settings.rugLayers })
    this.bind(pool.view)
    return pool
  }

  /** Copies the structural Lab settings into the module state the mesh builders read. */
  syncShared(): void {
    interiorSettings.theme = this.settings.interiorTheme
    interiorSettings.rugSeed = this.settings.rugSeed
    interiorSettings.decor = this.settings.interiorDecor
    interiorSettings.wainscot = this.settings.wainscot
  }

  /** Applies one changed setting; returns what the host must do ("structural" rebuilds the level). */
  apply(key: string): "structural" | "pool" | "live" {
    if (INTERIOR_STRUCTURAL_KEYS.has(key)) {
      this.syncShared()
      return "structural"
    }
    if (key === "rugResolution" || key === "rugLayers") {
      this.rebuildPool()
      return "pool"
    }
    if (key === "rugSource") this.lastKey = ""
    return "live"
  }

  /** Recreates the pool after a size or layer-count change. */
  rebuildPool(): void {
    this.pool.destroy()
    this.pool = this.makePool()
    this.lastKey = ""
  }

  /** Chooses the rugs to bake (nearest rooms first). Call every frame; replanning is throttled. */
  update(
    buildings: readonly Building[],
    houseSeed: number,
    px: number,
    py: number,
    now = performance.now(),
    deferStep = false,
  ): void {
    if (buildings !== this.lastBuildingsRef) {
      this.lastBuildingsRef = buildings
      let ids = ""
      for (let i = 0; i < buildings.length; i++) {
        if (i > 0) ids += ","
        ids += buildings[i]!.id
      }
      this.lastBuildingsIds = ids
    }
    const key = `${houseSeed}|${this.lastBuildingsIds}|${Math.round(px / 3)},${Math.round(py / 3)}|${this.settings.rugSource}|${interiorSettings.rugSeed}|${interiorSettings.theme}|${this.settings.paintedPlate}`
    if (key !== this.lastKey || (!deferStep && now - this.lastPlan > 1000)) {
      this.lastKey = key
      this.lastPlan = now
      const reqs: RugRequest[] = []
      if (this.settings.paintedPlate) reqs.push({ dirKey: -1, priority: -1, imageUrl: PLATE_URL })
      if (this.settings.rugSource !== 2) {
        for (const b of buildings) {
          const plan = planInterior(b, houseSeed)
          if (!plan.rugs.length) continue
          const slot = buildingStreamSlot(b)
          const d = distToRect(px, py, b.rect)
          for (const r of plan.rugs) {
            const priority = d + distToRect(px, py, r.rect) * 0.25
            const imageUrl = this.settings.rugSource === 1 ? this.handmadeUrl(r.spec.style, r.room, r.spec.seed) : undefined
            reqs.push({ dirKey: rugKey(slot, r.idx), spec: r.spec, priority, imageUrl })
          }
        }
      }
      this.pool.setRequests(reqs)
    }
    if (!deferStep) {
      this.pool.step()
    }
  }

  private handmadeUrl(style: string, room: string, seed: number): string {
    const file = room === "hall" || room === "kitchen" ? HANDMADE.runner : style === "persian" && seed & 1 ? HANDMADE.persian : HANDMADE.sage
    return new URL(`${defaultTextureBaseUrl()}${file}`, location.href).href
  }

  /** Writes rugDir (36), rugCfg (4) and bldTheme (8) at `offset`; `buildings` must match the uniform's building order. */
  pack(out: Float32Array, offset: number, buildings: readonly Building[], houseSeed: number): void {
    out.set(this.pool.directory.subarray(0, RUG_DIRECTORY_SLOTS * 4), offset)
    const c = offset + RUG_DIRECTORY_SLOTS * 4
    out[c] = this.settings.rugMipBias
    out[c + 1] = this.settings.rugBrightness
    out[c + 2] = this.settings.rugRelief
    // Plate layer in the integer part, brightness / 4 in the fraction; 0 when off or not yet resident.
    const plate = this.settings.paintedPlate ? this.pool.layerOf(PLATE_URL) : 0
    out[c + 3] = plate > 0 ? plate + Math.min(0.999, this.settings.plateBrightness / 4) : 0
    for (let i = 0; i < 8; i++) {
      const b = buildings[i]
      if (!b) { out[c + 4 + i] = 0; continue }
      const plan = planInterior(b, houseSeed)
      out[c + 4 + i] = themeIndex(plan.theme) + plan.variant * 0.45
    }
  }

  get uniformFloats(): number {
    return INTERIOR_UNIFORM_FLOATS
  }

  destroy(): void {
    this.pool.destroy()
  }
}
