import { Mesh } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import type { Rect } from "@arcade/kit/sim/geom"
import { chooseVignettes } from "../../shared/discovery/vignettes"
import type { Building, Town } from "../../shared/map"
import { currentBloodStains } from "../blood/stains"
import { emitInteriorDecor } from "../interiors/mesh"
import { placeNightLights } from "../night-lights/placement"
import type { OutbreakNightLightSettings } from "../night-lights/settings"
import { furnishedHouses } from "../props/furnish"
import { buildDetailMeshes } from "./models"
import { DETAIL_MODELS, placeBuildingDetails, placeCarDetails, type CruiserSite, type DetailSite } from "./placement"
import type { OutbreakDetailSettings } from "./settings"

/** Most instances of one detail model drawn in a frame (tape has many short segments). */
export const DETAIL_MODEL_CAP = 96
const TAPE_CAP = 192

const MODEL_INDEX = new Map(DETAIL_MODELS.map((id, i) => [id, i]))

/**
 * Draws the world details (`placement.ts`): plans each building's and car's details once per town, settings and
 * reroll, keeps them per building id so the streaming window can move without replanning, and packs one instanced
 * draw per model each frame for what is in view. Indoor pieces sit under the roofs like the furniture and show when
 * the roof is cut away.
 */
export class DetailsPresenter {
  private readonly models: number[] = []
  private readonly buffers: Float32Array<ArrayBuffer>[] = []
  private readonly counts: Int32Array
  private readonly out: Batch[] = []
  private readonly perBuilding = new Map<string, { key: string; sites: DetailSite[] }>()
  private carKey = ""
  private carSites: DetailSite[] = []
  private frameKey = ""
  private sites: DetailSite[] = []
  private lastStamps: readonly unknown[] | null = null
  private lastBuildings: readonly Building[] | null = null
  private lastIncidents = new Set<string>()
  private incidentKey = ""
  /** Readout for the harness: what the town has and what was drawn last frame. */
  readonly shown = { planned: 0, drawn: 0, turnedOver: 0, buildings: 0 }

  constructor(renderer: Pick<Renderer, "addModel">) {
    const meshes = buildDetailMeshes()
    meshes.forEach((m, i) => {
      this.models.push(renderer.addModel(m))
      this.buffers.push(new Float32Array((DETAIL_MODELS[i] === "tape" ? TAPE_CAP : DETAIL_MODEL_CAP) * INST_FLOATS))
    })
    this.counts = new Int32Array(meshes.length)
  }

  /** Buildings where something happened: the broken-into vignettes and every house Blood put prints on the walls of. */
  private incidents(town: Town): Set<string> {
    const stamps = currentBloodStains()?.ambientStamps() ?? []
    if (stamps === this.lastStamps && town.buildings === this.lastBuildings) return this.lastIncidents
    this.lastStamps = stamps
    this.lastBuildings = town.buildings
    const out = (this.lastIncidents = new Set<string>())
    for (const v of chooseVignettes(town)) if (v.kind === "broken-in") out.add(v.target)
    for (const st of stamps) {
      if (!st.wall) continue
      for (const b of town.buildings) {
        const r = b.rect
        if (st.x > r[0] - 0.3 && st.x < r[2] + 0.3 && st.z > r[1] - 0.3 && st.z < r[3] + 0.3) out.add(b.id)
      }
    }
    this.incidentKey = [...out].sort().join(",")
    return out
  }

  /** Floor the RE dressing and the furniture library already stand on in a building (fireplaces, clocks, desks, clutter). */
  private avoidIn(town: Town, b: Building): Rect[] {
    const rects: Rect[] = []
    emitInteriorDecor(new Mesh(), b, town, undefined, undefined, rects)
    for (const h of furnishedHouses(town)) {
      if (h.building !== b.id) continue
      for (const p of [...h.anchors, ...h.clutter]) if (p.y < 0.05) rects.push(p.footprint)
    }
    return rects
  }

  private plan(town: Town, s: OutbreakDetailSettings, night: OutbreakNightLightSettings): void {
    const o = town.windowOrigin ?? [0, 0]
    const sig = `${town.seed}:${town.houseSeed}:${s.worldDetails}:${s.dtTurnedOver}:${s.dtMail}:${s.dtBoxes}:${s.dtMarks}:${s.dtBins}:${s.dtMailboxes}:${s.dtStreetJunk}:${s.dtPoliceTape}:${s.dtSeed}`
    const incidents = this.incidents(town)
    const fk = `${sig}:${o[0]},${o[1]}:${town.buildings.length}:${(town.vehicles ?? []).length}:${this.incidentKey}:${night.nightLights}:${night.nlCruisers}:${night.nlSeed}`
    if (fk === this.frameKey) return
    this.frameKey = fk
    const all: DetailSite[] = []
    const live = new Set<string>()
    for (const b of town.buildings) {
      const turned = incidents.has(b.id)
      const key = `${sig}:${b.rect.join(",")}:${turned}`
      let hit = this.perBuilding.get(b.id)
      if (!hit || hit.key !== key) {
        hit = { key, sites: placeBuildingDetails(town, b, s, turned, this.avoidIn(town, b)) }
        this.perBuilding.set(b.id, hit)
      }
      live.add(b.id)
      for (const d of hit.sites) all.push(d)
    }
    // Forget buildings that streamed out a while ago (keep the nearest few dozen for walking back).
    if (this.perBuilding.size > 64) for (const id of this.perBuilding.keys()) if (!live.has(id) && this.perBuilding.size > 48) this.perBuilding.delete(id)
    const cruisers: CruiserSite[] = s.dtPoliceTape
      ? placeNightLights(town, night).flatMap((n) => (n.kind === "cruiser" ? [{ key: n.key, x: n.x, z: n.z, yaw: n.yaw }] : []))
      : []
    const ck = `${sig}:${o[0]},${o[1]}:${(town.vehicles ?? []).map((v) => v.join(",")).join("|")}:${cruisers.map((c) => c.key).join(",")}`
    if (ck !== this.carKey) {
      this.carKey = ck
      this.carSites = placeCarDetails(town, s, cruisers)
    }
    for (const d of this.carSites) all.push(d)
    this.sites = all
    this.shown.planned = all.length
    this.shown.turnedOver = incidents.size
    this.shown.buildings = town.buildings.length
  }

  /** This frame's detail batches inside `view` (empty when Details › World details is off). */
  collect(town: Town, view: Rect, s: OutbreakDetailSettings, night: OutbreakNightLightSettings): readonly Batch[] {
    this.out.length = 0
    this.shown.drawn = 0
    if (!s.worldDetails) {
      this.shown.planned = 0
      return this.out
    }
    this.plan(town, s, night)
    const counts = this.counts
    counts.fill(0)
    const [x0, z0, x1, z1] = view
    for (const d of this.sites) {
      if (d.x < x0 - 2 || d.x > x1 + 2 || d.z < z0 - 2 || d.z > z1 + 2) continue
      const m = MODEL_INDEX.get(d.model)!
      const buf = this.buffers[m]!
      const c = counts[m]!
      if ((c + 1) * INST_FLOATS > buf.length) continue
      counts[m] = c + 1
      const o = c * INST_FLOATS
      buf[o] = d.x
      buf[o + 1] = d.y
      buf[o + 2] = d.z
      buf[o + 3] = d.yaw
      buf[o + 4] = 1
      buf[o + 5] = 1
      buf[o + 6] = 1
      buf[o + 7] = d.scale
      buf[o + 8] = d.pitch
      buf[o + 9] = d.roll
      buf[o + 10] = 1
      buf[o + 11] = 0
    }
    for (let m = 0; m < this.models.length; m++) {
      const count = counts[m]!
      if (!count) continue
      this.shown.drawn += count
      this.out.push({ model: this.models[m]!, data: this.buffers[m]!, count })
    }
    return this.out
  }

  reset(): void {
    this.perBuilding.clear()
    this.lastStamps = null
    this.frameKey = ""
    this.carKey = ""
  }
}

let current: DetailsPresenter | null = null

export function setCurrentDetails(p: DetailsPresenter): void {
  current = p
}

export const currentDetails = (): DetailsPresenter | null => current
