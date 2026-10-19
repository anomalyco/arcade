import { Mesh } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import { LIGHT_FLOATS } from "@arcade/kit/limits"
import type { Rect } from "@arcade/kit/sim/geom"
import { bodySites } from "../../shared/bodies/bodies"
import { chooseVignettes } from "../../shared/discovery/vignettes"
import type { Building, Town } from "../../shared/map"
import { supportHeight } from "../../shared/terrain"
import { currentBloodStains } from "../blood/stains"
import { emitInteriorDecor } from "../interiors/mesh"
import { placeNightLights } from "../night-lights/placement"
import type { OutbreakNightLightSettings } from "../night-lights/settings"
import { furnishedHouses } from "../props/furnish"
import { TABLE_LAMP_CONE_W, tableLampClip } from "../table-lamps"
import { CrowFlocks, type CrowNoise, type CrowPose, type CrowThreat } from "./crows"
import { DistantLife, tvLevel, type LifeSound } from "./life"
import { buildDetailMeshes, TV_LAMP_SLOT } from "./models"
import { DETAIL_MODELS, placeBuildingDetails, placeCarDetails, placeCrowFlocks, type CruiserSite, type DetailSite } from "./placement"
import type { OutbreakDetailSettings } from "./settings"

/** Most instances of one detail model drawn in a frame (tape has many short segments). */
export const DETAIL_MODEL_CAP = 96
const TAPE_CAP = 192

const MODEL_INDEX = new Map(DETAIL_MODELS.map((id, i) => [id, i]))

/** Reach (m) of a television's light on its room; the room's walls clip it like a table lamp. */
export const TV_RADIUS = 3.4

/** What the details need from the frame besides the town: time, who scares the crows and what was heard. */
export type DetailFrame = { dt: number; time: number; threats: readonly CrowThreat[]; noises: readonly CrowNoise[] }

type Tv = { x: number; z: number; h: number; phase: number; clip: Rect }

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
  readonly shown = { planned: 0, drawn: 0, turnedOver: 0, buildings: 0, tvs: 0, tvLights: 0, crows: { ground: 0, flying: 0, gone: 0 }, barks: 0 }
  readonly crows = new CrowFlocks()
  readonly life = new DistantLife()
  private crowKey = ""
  private readonly crowPoses: CrowPose[] = []
  private tvs: Tv[] = []
  private tvLevelNow = 0

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
    const walls = town.barriers.filter((w) => w.kind !== "fence").map((w) => w.rect)
    this.tvs = all
      .filter((d) => d.model === "tv")
      .map((d, i) => {
        const x = d.x - Math.sin(d.yaw) * 0.55
        const z = d.z + Math.cos(d.yaw) * 0.55
        return { x, z, h: d.y + 0.75, phase: ((i * 0.618 + d.x * 0.37 + d.z * 0.11) % 1 + 1) % 1, clip: tableLampClip({ x, z, h: d.y + 0.75 }, walls, TV_RADIUS) }
      })
    this.shown.tvs = this.tvs.length
    const bodies = bodySites(town)
    const crowKey = `${sig}:${s.dtCrows}:${o[0]},${o[1]}:${town.buildings.length}:${bodies.length}`
    if (crowKey !== this.crowKey) {
      this.crowKey = crowKey
      this.crows.setFlocks(crowKey, placeCrowFlocks(town, s, bodies))
    }
    this.shown.planned = all.length
    this.shown.turnedOver = incidents.size
    this.shown.buildings = town.buildings.length
  }

  /** This frame's detail batches inside `view` (empty when Details › World details is off). */
  collect(town: Town, view: Rect, s: OutbreakDetailSettings, night: OutbreakNightLightSettings, frame: DetailFrame): readonly Batch[] {
    this.out.length = 0
    this.shown.drawn = 0
    if (!s.worldDetails) {
      this.shown.planned = 0
      this.tvs = []
      this.crows.reset()
      this.crowKey = ""
      return this.out
    }
    this.plan(town, s, night)
    this.time = frame.time
    this.tvLevelNow = tvLevel(0.37, frame.time)
    this.crows.step(frame.dt, frame.time, s.dtCrowScare, frame.threats, frame.noises)
    this.shown.crows = this.crows.counts()
    const counts = this.counts
    counts.fill(0)
    const [x0, z0, x1, z1] = view
    for (const d of this.sites) {
      if (d.x < x0 - 2 || d.x > x1 + 2 || d.z < z0 - 2 || d.z > z1 + 2) continue
      this.put(d.model, d.x, d.y, d.z, d.yaw, d.scale, d.pitch, d.roll)
    }
    for (const c of this.crows.poses(frame.time, view, this.crowPoses)) {
      const model = c.wings === "folded" ? "crowSit" : c.wings === "up" ? "crowUp" : "crowDown"
      this.put(model, c.x, supportHeight(town, c.x, c.z) + c.y, c.z, c.yaw, 1, c.pitch, 0)
    }
    for (let m = 0; m < this.models.length; m++) {
      const count = counts[m]!
      if (!count) continue
      this.shown.drawn += count
      this.out.push({ model: this.models[m]!, data: this.buffers[m]!, count })
    }
    return this.out
  }

  private put(model: (typeof DETAIL_MODELS)[number], x: number, y: number, z: number, yaw: number, scale: number, pitch: number, roll: number): void {
    const m = MODEL_INDEX.get(model)!
    const buf = this.buffers[m]!
    const c = this.counts[m]!
    if ((c + 1) * INST_FLOATS > buf.length) return
    this.counts[m] = c + 1
    const o = c * INST_FLOATS
    buf[o] = x
    buf[o + 1] = y
    buf[o + 2] = z
    buf[o + 3] = yaw
    buf[o + 4] = 1
    buf[o + 5] = 1
    buf[o + 6] = 1
    buf[o + 7] = scale
    buf[o + 8] = pitch
    buf[o + 9] = roll
    buf[o + 10] = 1
    buf[o + 11] = 0
  }

  /**
   * The screens' glow, and the nearest television's flicker on its room (clipped to the room like a table lamp)
   * while the camera is inside a house. `night` is the hour's lamp level. Returns the next light slot.
   */
  writeLights(lights: Float32Array, count: number, max: number, lampPower: Float32Array, s: OutbreakDetailSettings, at: { cutX: number; cutY: number; interior: boolean; night: number }): number {
    const on = s.worldDetails && this.tvs.length > 0
    const level = this.tvLevelNow
    lampPower[TV_LAMP_SLOT] = on ? (0.35 + 0.9 * level) * Math.min(2, Math.max(0.2, s.dtTvPower)) : 0
    this.shown.tvLights = 0
    if (!on || !at.interior || count >= max || s.dtTvPower <= 0) return count
    let best: Tv | null = null
    let bd = 81
    for (const tv of this.tvs) {
      const d = (tv.x - at.cutX) ** 2 + (tv.z - at.cutY) ** 2
      if (d < bd) {
        bd = d
        best = tv
      }
    }
    if (!best) return count
    const p = (0.5 * (0.3 + 0.7 * at.night) * s.dtTvPower * tvLevel(best.phase, this.time)) || 0
    if (p <= 0.002) return count
    const c = best.clip
    lights.set([best.x, best.h, best.z, TV_RADIUS, 0.72, 0.8, 0.92, p, c[0], c[1], c[2], TABLE_LAMP_CONE_W, c[3], -1, 0.08, 0], count * LIGHT_FLOATS)
    this.shown.tvLights = 1
    return count + 1
  }

  private time = 0

  /** Distant dogs at night (`life.ts`); `play` is the game's audio. */
  stepLife(time: number, s: OutbreakDetailSettings, night: number, listener: { x: number; y: number }, play: (e: LifeSound) => void): void {
    this.life.step(time, s, night, listener, play)
    this.shown.barks = this.life.barks
  }

  reset(): void {
    this.crows.reset()
    this.crowKey = ""
    this.life.reset()
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
