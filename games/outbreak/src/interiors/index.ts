import type { LabControl } from "@arcade/kit/lab-panel"
import { WEAR_DEFAULTS, wearControls, type WearSettings } from "@arcade/kit/gpu/materials/wear"
import { FINISH_SCAN_URLS } from "@arcade/kit/gpu/materials/wear-scans"
import { defaultTextureBaseUrl } from "@arcade/kit/textures/manifest"
import { distToRect } from "@arcade/kit/sim/geom"
import type { Building } from "../../shared/map"
import { buildingStreamSlot, INTERIOR_THEMES, INTERIOR_THEME_LABELS, interiorSettings, planInterior, rugKey, themeIndex, type InteriorTheme } from "./plan"
import { RugPool, type RugRequest } from "./rug-pool"
import { DEFAULT_SCONCE_LIGHT_SETTINGS, SconceLights, type SconceLightSettings } from "./sconces"
import { INTERIOR_UNIFORM_FLOATS, RUG_DIRECTORY_SLOTS } from "./wgsl"

export { collectSconces, emitBuildingRugs, emitInteriorDecor, emitWallCapMoulding } from "./mesh"
export { interiorSettings, planInterior } from "./plan"
export { SCONCE_LAMP_SLOT, SconceLights } from "./sconces"

/** Typed Lab settings for rugs and themed interiors. */
export type InteriorLabSettings = SconceLightSettings & WearSettings & {
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
  /** Moulded wall tops (cove and bead along both faces). */
  wallCaps: number
  /** Interior craft pass (AR-69): 1 craft walls, windows, cabinets and trim; 0 Today. */
  interiorCraft: number
  /** Finished props (`finish.ts`, kit `gpu/finish`): chamfered, baked and worn kitchen cabinetry; 0 Today. */
  propFinish: number
  /** Painted-wall wear (water streaks, rising damp, corner and ceiling shade), 0 off. */
  wallWear: number
  /** Spike (AR-42): Ash's living room and hall floor drawn from a painted plate (0 off, 1 on). */
  paintedPlate: number
  plateBrightness: number
  /** Generated floor plates for every themed house (0 off, 1 on); off falls back to the procedural floors. */
  floorPlates: number
  floorPlateTile: number
  floorPlateBrightness: number
  /** Seeded floor decals: chance of one per 1.7 m cell, and blend strength. */
  decalDensity: number
  decalStrength: number
  skirtingGrime: number
}

export const DEFAULT_INTERIOR_SETTINGS: InteriorLabSettings = {
  rugSource: 0,
  rugResolution: 1024,
  rugLayers: 12,
  rugMipBias: -0.4,
  rugBrightness: 1,
  rugRelief: 0.6,
  interiorTheme: -1,
  rugSeed: 0,
  interiorDecor: 1,
  wainscot: 1,
  wallCaps: 1,
  interiorCraft: 1,
  propFinish: 1,
  wallWear: 1,
  paintedPlate: 1,
  plateBrightness: 1.7,
  floorPlates: 1,
  floorPlateTile: 4,
  floorPlateBrightness: 1,
  decalDensity: 0.35,
  decalStrength: 1,
  skirtingGrime: 0.6,
  ...DEFAULT_SCONCE_LIGHT_SETTINGS,
  ...WEAR_DEFAULTS,
}

/** Keys whose change rebuilds static level geometry (rug quads, decor) rather than updating uniforms. */
export const INTERIOR_STRUCTURAL_KEYS = new Set(["interiorTheme", "rugSeed", "interiorDecor", "wainscot", "wallCaps", "interiorCraft", "propFinish"])

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
    { key: "interiorCraft", label: "Interior craft", group, type: "select", options: [{ value: 0, label: "Today" }, { value: 1, label: "Craft pass (AR-69)" }], change: onStructural },
    { key: "wallWear", label: "Wall wear (stains, damp, shade)", group, min: 0, max: 1.5, step: 0.05, unit: "×" },
    { key: "propFinish", label: "Finished props", group, type: "select", options: [{ value: 0, label: "Today" }, { value: 1, label: "Chamfered, baked and worn" }], change: onStructural },
    ...wearControls("", group, "Finished props"),
    { key: "wallCaps", label: "Moulded wall tops", group: "Look · Detail", type: "toggle", change: onStructural },
    { key: "sconceLights", label: "Lit sconce pairs", group, type: "select", options: [{ value: -1, label: "Quality tier" }, { value: 0, label: "Off" }, { value: 1, label: "1" }, { value: 2, label: "2" }, { value: 3, label: "3" }, { value: 4, label: "4" }] },
    { key: "sconcePower", label: "Sconce brightness", group, min: 0, max: 3, step: 0.05, unit: "×" },
    { key: "sconceRadius", label: "Sconce reach", group, min: 1.5, max: 5, step: 0.1, unit: "m" },
    { key: "paintedPlate", label: "Painted floor plate (Ash)", group: "Look · Detail", type: "toggle" },
    { key: "plateBrightness", label: "Plate brightness", group: "Look · Detail", min: 0.5, max: 3.5, step: 0.05, unit: "×" },
    { key: "floorPlates", label: "Painted floors (every house)", group: "Look · Detail", type: "toggle" },
    { key: "floorPlateTile", label: "Floor plate size", group: "Look · Detail", min: 2, max: 8, step: 0.25, unit: "m" },
    { key: "floorPlateBrightness", label: "Floor plate brightness", group: "Look · Detail", min: 0.4, max: 2.5, step: 0.05, unit: "×" },
    { key: "decalDensity", label: "Floor decals", group: "Look · Detail", min: 0, max: 1, step: 0.01, unit: "" },
    { key: "decalStrength", label: "Decal strength", group: "Look · Detail", min: 0, max: 1.33, step: 0.01, unit: "×" },
    { key: "skirtingGrime", label: "Grime along skirting", group: "Look · Detail", min: 0, max: 1.5, step: 0.05, unit: "" },
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

/**
 * Generated floor plates by theme (AR-42): gpt-image-2 top-down albedo of a 4 m floor section, flattened (divided
 * by a wrapped blur) so no wear patch repeats, then levelled; `gain` evens them out. Each house picks one by its
 * variant. Station keeps its procedural checker tiles.
 */
const THEME_PLATES: Record<InteriorTheme, readonly { url: string; gain: number }[]> = {
  mansion: [
    { url: new URL("./plates/floor-mansion-a.webp", import.meta.url).href, gain: 1.15 },
    { url: new URL("./plates/floor-mansion-b.webp", import.meta.url).href, gain: 1 },
  ],
  village: [
    { url: new URL("./plates/floor-village-a.webp", import.meta.url).href, gain: 1.15 },
    { url: new URL("./plates/floor-village-b.webp", import.meta.url).href, gain: 1.1 },
  ],
  baker: [
    { url: new URL("./plates/floor-baker-a.webp", import.meta.url).href, gain: 0.85 },
    { url: new URL("./plates/floor-baker-b.webp", import.meta.url).href, gain: 0.85 },
  ],
  plain: [
    { url: new URL("./plates/floor-plain-a.webp", import.meta.url).href, gain: 0.9 },
    { url: new URL("./plates/floor-plain-b.webp", import.meta.url).href, gain: 0.95 },
  ],
  station: [],
}

/** The 4×4 floor decal atlas (gpt-image-2 on a green screen, keyed to alpha); kinds are listed in `wgsl.ts`. */
const DECAL_URL = new URL("./decals/floor-decals.webp", import.meta.url).href

/** The kitchen timber's wood-grain scan (kit wear looks, triplanar): one pool layer while finished props are on. */
const WOOD_SCAN_URL = FINISH_SCAN_URLS["old-wood"]()

/** The library plate a building's floor uses, or null for themes that keep procedural floors. */
export function floorPlateFor(b: Building, houseSeed: number): { url: string; gain: number } | null {
  const plan = planInterior(b, houseSeed)
  const lib = THEME_PLATES[plan.theme]
  return lib.length ? lib[Math.min(lib.length - 1, Math.floor(plan.variant * lib.length))]! : null
}

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
  /** Last packed floor plate per window building (layer + brightness / 4) and decal atlas layer, for automation. */
  readonly floorLayers = { plates: [0, 0, 0, 0, 0, 0, 0, 0], decals: 0 }

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
    interiorSettings.wallCaps = this.settings.wallCaps
    interiorSettings.craft = this.settings.interiorCraft
    interiorSettings.finish = this.settings.propFinish
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
    const key = `${houseSeed}|${this.lastBuildingsIds}|${Math.round(px / 3)},${Math.round(py / 3)}|${this.settings.rugSource}|${interiorSettings.rugSeed}|${interiorSettings.theme}|${this.settings.paintedPlate}|${this.settings.floorPlates}|${this.settings.decalDensity > 0}|${this.woodScan}`
    if (key !== this.lastKey || (!deferStep && now - this.lastPlan > 1000)) {
      this.lastKey = key
      this.lastPlan = now
      const reqs: RugRequest[] = []
      if (this.settings.paintedPlate) reqs.push({ dirKey: -1, priority: -1, imageUrl: PLATE_URL })
      if (this.settings.decalDensity > 0) reqs.push({ dirKey: -1, priority: -1, imageUrl: DECAL_URL, keepAlpha: true })
      if (this.woodScan) reqs.push({ dirKey: -1, priority: -1, imageUrl: WOOD_SCAN_URL })
      if (this.settings.floorPlates) {
        // A plate floors the whole house, so it outranks that house's rugs; one request per distinct plate.
        const plates = new Map<string, number>()
        for (const b of buildings) {
          const plate = floorPlateFor(b, houseSeed)
          if (!plate) continue
          const priority = distToRect(px, py, b.rect) - 0.5
          plates.set(plate.url, Math.min(plates.get(plate.url) ?? Infinity, priority))
        }
        for (const [imageUrl, priority] of plates) reqs.push({ dirKey: -1, priority, imageUrl })
      }
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

  private get woodScan(): boolean {
    return this.settings.propFinish > 0 && this.settings.finishWear && this.settings.finishScan > 0
  }

  /** Detail-array layer of the wear looks' scans that are resident (for kit `packWear`'s `scanLayers`). */
  get scanLayers(): { "old-wood": number } {
    const layer = this.woodScan ? this.pool.layerOf(WOOD_SCAN_URL) : 0
    this.scans["old-wood"] = layer > 0 ? layer : -1
    return this.scans
  }
  private readonly scans = { "old-wood": -1 }

  private handmadeUrl(style: string, room: string, seed: number): string {
    const file = room === "hall" || room === "kitchen" ? HANDMADE.runner : style === "persian" && seed & 1 ? HANDMADE.persian : HANDMADE.sage
    return new URL(`${defaultTextureBaseUrl()}${file}`, location.href).href
  }

  /**
   * Writes rugDir (36), rugCfg (4), bldTheme (8), bldPlate (8), floorCfg (4) and floorCfg2 (4) at `offset`;
   * `buildings` must match the uniform's building order.
   */
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
    for (let i = 0; i < 8; i++) {
      const b = buildings[i]
      const plate = b && this.settings.floorPlates ? floorPlateFor(b, houseSeed) : null
      const layer = plate ? this.pool.layerOf(plate.url) : 0
      out[c + 12 + i] = layer > 0 ? layer + Math.min(0.999, (plate!.gain * this.settings.floorPlateBrightness) / 4) : 0
      this.floorLayers.plates[i] = out[c + 12 + i]!
    }
    const decals = this.settings.decalDensity > 0 ? this.pool.layerOf(DECAL_URL) : 0
    this.floorLayers.decals = decals
    out[c + 20] = this.settings.floorPlateTile
    out[c + 21] = this.settings.decalDensity
    out[c + 22] = this.settings.decalStrength
    out[c + 23] = decals
    out[c + 24] = this.settings.skirtingGrime
    out[c + 25] = (interiorSettings.rugSeed * 0x9e37 + 0x2c1b) & 0xffff
    // Wall wear only rides with the craft pass, so Today is one setting away.
    out[c + 26] = this.settings.interiorCraft ? this.settings.wallWear : 0
    out[c + 27] = 0
  }

  get uniformFloats(): number {
    return INTERIOR_UNIFORM_FLOATS
  }

  destroy(): void {
    this.pool.destroy()
  }
}
