import { Mesh } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import { LIGHT_FLOATS } from "@arcade/kit/limits"
import type { Rect } from "@arcade/kit/sim/geom"
import { bodySites } from "../../shared/bodies/bodies"
import { chooseVignettes } from "../../shared/discovery/vignettes"
import { inBuildingFootprint, type Building, type Town } from "../../shared/map"
import { supportHeight } from "../../shared/terrain"
import { housePlan, housePowered } from "../audio/soundscape/houses"
import { currentBloodStains } from "../blood/stains"
import { emitInteriorDecor } from "../interiors/mesh"
import { placeNightLights } from "../night-lights/placement"
import type { OutbreakNightLightSettings } from "../night-lights/settings"
import { furnishedHouses } from "../props/furnish"
import { TABLE_LAMP_CONE_W, tableLampClip } from "../table-lamps"
import { CrowFlocks, type CrowNoise, type CrowPose, type CrowThreat } from "./crows"
import { DistantLife, tvLevel, type LifeSound } from "./life"
import { buildDetailMeshes, TV_LAMP_SLOT } from "./models"
import { Casings, CASINGS_MAX, domeLevel, doorPose, laundryPoses, openDoorOf, placeLaundry, type LaundryLine, type OpenDoor, type Pose, type ShotLike } from "./leftovers"
import { DETAIL_MODELS, placeBuildingDetails, placeCarDetails, placeCrowFlocks, type CruiserSite, type DetailModel, type DetailSite } from "./placement"
import type { OutbreakDetailSettings } from "./settings"
import { LifeTouches, type TouchFrame } from "./touches"

/** Most instances of one detail model drawn in a frame (tape has many short segments). */
export const DETAIL_MODEL_CAP = 96
const TAPE_CAP = 192

const MODEL_INDEX = new Map(DETAIL_MODELS.map((id, i) => [id, i]))

/** Reach (m) of a television's light on its room; the room's walls clip it like a table lamp. */
export const TV_RADIUS = 3.4

/**
 * What the details need from the frame besides the town: time, who scares the crows and what was heard; and for the
 * leftover life, which night it is, the storm's wind, the replicated vehicles and this tick's shots.
 */
export type DetailFrame = {
  dt: number
  time: number
  threats: readonly CrowThreat[]
  noises: readonly CrowNoise[]
  night?: number
  /** Game hours since the run's first midnight (the soundscape's clock), for each house's power. */
  absHour?: number
  storm?: number
  vehicles?: readonly DoorVehicle[]
  shots?: readonly ShotLike[]
}

type DoorVehicle = Parameters<typeof openDoorOf>[1]

type Tv = { x: number; z: number; h: number; phase: number; clip: Rect; site: DetailSite; building: string }

/** Reach (m) of a dome light left on in a car with its door open. */
export const DOME_RADIUS = 2.6

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
  private readonly perBuilding = new Map<string, { key: string; sites: DetailSite[]; laundry: LaundryLine | null }>()
  private lines: LaundryLine[] = []
  private readonly doors = new Map<string, OpenDoor | null>()
  private doorKey = ""
  private readonly pose: Pose = { model: "chair", x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 }
  private readonly domeAt = { x: 0, y: 0, z: 0 }
  private readonly dome = { on: false, x: 0, y: 0, z: 0, phase: 0, d2: 0 }
  readonly casings = new Casings()
  private night = 1
  private absHour = 12
  private decay = true
  /** The hour each house loses power (the soundscape's `housePlan`, so televisions and windows die with the fridge). */
  private readonly power = new Map<string, number>()
  private powerSeed = Number.NaN
  private carKey = ""
  private carSites: DetailSite[] = []
  private frameKey = ""
  private sites: DetailSite[] = []
  private lastStamps: readonly unknown[] | null = null
  private lastBuildings: readonly Building[] | null = null
  private lastIncidents = new Set<string>()
  private incidentKey = ""
  /** Readout for the harness: what the town has and what was drawn last frame. */
  readonly shown = { planned: 0, drawn: 0, turnedOver: 0, buildings: 0, tvs: 0, tvLights: 0, crows: { ground: 0, flying: 0, gone: 0 }, barks: 0, lines: 0, domes: 0, casings: 0 }
  readonly crows = new CrowFlocks()
  readonly life = new DistantLife()
  /** Details · Life: moths, flies, eyes under the trees, breath (`touches.ts`). */
  readonly touches = new LifeTouches()
  private readonly lifeOut = { alpha: 0, add: 0 }
  private crowKey = ""
  private readonly crowPoses: CrowPose[] = []
  private tvs: Tv[] = []
  private tvLevelNow = 0

  constructor(renderer: Pick<Renderer, "addModel">) {
    const meshes = buildDetailMeshes()
    meshes.forEach((m, i) => {
      this.models.push(renderer.addModel(m))
      const id = DETAIL_MODELS[i]
      this.buffers.push(new Float32Array((id === "tape" ? TAPE_CAP : id === "casing" ? CASINGS_MAX : DETAIL_MODEL_CAP) * INST_FLOATS))
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
    const sig = `${town.seed}:${town.houseSeed}:${s.worldDetails}:${s.dtTurnedOver}:${s.dtMail}:${s.dtBoxes}:${s.dtMarks}:${s.dtBloodWriting}:${s.dtBins}:${s.dtMailboxes}:${s.dtStreetJunk}:${s.dtPoliceTape}:${s.dtTvs}:${s.dtSeed}`
    const incidents = this.incidents(town)
    const fk = `${sig}:${o[0]},${o[1]}:${town.buildings.length}:${(town.vehicles ?? []).length}:${this.incidentKey}:${night.nightLights}:${night.nlCruisers}:${night.nlSeed}:${s.dtCrows}:${s.lifeTouches}:${s.lfLaundry}`
    if (fk === this.frameKey) return
    this.frameKey = fk
    const all: DetailSite[] = []
    const live = new Set<string>()
    this.lines = []
    if (town.seed !== this.powerSeed || this.power.size > 256) {
      this.powerSeed = town.seed
      this.power.clear()
    }
    for (const b of town.buildings) {
      if (!this.power.has(b.id)) this.power.set(b.id, housePlan(town, b).powerLoss)
      const turned = incidents.has(b.id)
      const key = `${sig}:${b.rect.join(",")}:${turned}:${s.lifeTouches}:${s.lfLaundry}`
      let hit = this.perBuilding.get(b.id)
      if (!hit || hit.key !== key) {
        hit = { key, sites: placeBuildingDetails(town, b, s, turned, this.avoidIn(town, b)), laundry: placeLaundry(town, b, s) }
        this.perBuilding.set(b.id, hit)
      }
      live.add(b.id)
      for (const d of hit.sites) all.push(d)
      if (hit.laundry) this.lines.push(hit.laundry)
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
        const phase = ((i * 0.618 + d.x * 0.37 + d.z * 0.11) % 1 + 1) % 1
        const building = town.buildings.find((b) => inBuildingFootprint(b, d.x, d.z))?.id ?? ""
        return { x, z, h: d.y + 0.75, phase, clip: tableLampClip({ x, z, h: d.y + 0.75 }, walls, TV_RADIUS), site: d, building }
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
      this.decay = false
      this.shown.planned = 0
      this.shown.tvs = 0
      this.tvs = []
      this.crows.reset()
      this.shown.crows = this.crows.counts()
      this.crowKey = ""
      this.frameKey = ""
      return this.out
    }
    this.plan(town, s, night)
    this.time = frame.time
    this.night = frame.night ?? 1
    this.absHour = frame.absHour ?? 24 * (this.night - 1) + 12
    this.decay = s.lifeTouches && s.lfDecay
    this.tvLevelNow = tvLevel(0.37, frame.time)
    this.crows.step(frame.dt, frame.time, s.dtCrowScare, frame.threats, frame.noises)
    this.shown.crows = this.crows.counts()
    const counts = this.counts
    counts.fill(0)
    const [x0, z0, x1, z1] = view
    for (const d of this.sites) {
      if (d.x < x0 - 2 || d.x > x1 + 2 || d.z < z0 - 2 || d.z > z1 + 2) continue
      this.put(d.model === "tv" && this.tvDead(d) ? "tvOff" : d.model, d.x, d.y, d.z, d.yaw, d.scale, d.pitch, d.roll)
    }
    this.leftovers(town, view, s, frame)
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

  private tvDead(d: DetailSite): boolean {
    if (!this.decay) return false
    for (const tv of this.tvs) if (tv.site === d) return !this.powered(tv.building)
    return false
  }

  /**
   * Whether a building still has mains power ("Town runs down night by night"): each house fails at its own hour, the
   * one its fridge stops humming at in the soundscape, and its television and lit windows go with it.
   */
  readonly powered = (id: string): boolean => {
    if (!this.decay) return true
    this.powerProbe.powerLoss = this.power.get(id) ?? Infinity
    return housePowered(this.powerProbe, this.absHour)
  }

  private readonly powerProbe = { powerLoss: Infinity }

  private readonly emitPose = (model: DetailModel, x: number, y: number, z: number, yaw: number, pitch: number, roll: number): void => {
    this.put(model, x, y, z, yaw, 1, pitch, roll)
  }

  private readonly emitCasing = (x: number, y: number, z: number, yaw: number, roll: number): void => {
    this.put("casing", x, y, z, yaw, 1, 0, roll)
  }

  private readonly ground = (x: number, z: number): number => supportHeight(this.town!, x, z)
  private town: Town | null = null

  /** Washing on the lines, open car doors (and the nearest dome light), and the brass. */
  private leftovers(town: Town, view: Rect, s: OutbreakDetailSettings, frame: DetailFrame): void {
    const [x0, z0, x1, z1] = view
    this.town = town
    this.dome.on = false
    if (!s.lifeTouches) {
      this.casings.reset()
      return
    }
    this.shown.lines = 0
    for (const line of this.lines) {
      if (line.x < x0 - 3 || line.x > x1 + 3 || line.z < z0 - 3 || line.z > z1 + 3) continue
      laundryPoses(line, frame.time, frame.storm ?? 0, this.emitPose)
      this.shown.lines++
    }
    const dk = `${town.seed}:${s.lfOpenDoors}:${s.dtSeed}`
    if (dk !== this.doorKey) {
      this.doorKey = dk
      this.doors.clear()
    }
    const cx = (x0 + x1) / 2
    const cz = (z0 + z1) / 2
    for (const v of frame.vehicles ?? []) {
      if (v.x < x0 - 4 || v.x > x1 + 4 || v.y < z0 - 4 || v.y > z1 + 4) continue
      const key = `${v.id}:${v.spawnX.toFixed(1)},${v.spawnY.toFixed(1)}`
      let door = this.doors.get(key)
      if (door === undefined) {
        door = openDoorOf(town, v, s)
        this.doors.set(key, door)
      }
      // Still where it was left, nobody in it: the door is open.
      if (!door || Math.hypot(v.x - v.spawnX, v.y - v.spawnY) > 0.35 || v.seats.some(Boolean)) continue
      doorPose(v, door, town, this.pose, this.domeAt)
      this.put(this.pose.model, this.pose.x, this.pose.y, this.pose.z, this.pose.yaw, 1, 0, 0)
      const d2 = (this.domeAt.x - cx) ** 2 + (this.domeAt.z - cz) ** 2
      if (this.dome.on && d2 >= this.dome.d2) continue
      const dome = this.dome
      dome.on = true
      dome.x = this.domeAt.x
      dome.y = this.domeAt.y
      dome.z = this.domeAt.z
      dome.phase = door.phase
      dome.d2 = d2
    }
    if (this.doors.size > 256) this.doors.clear()
    if (s.lfCasings) {
      if (frame.shots) this.casings.observe(frame.shots, this.ground)
      this.casings.step(frame.dt, this.ground)
      this.casings.poses(view, this.emitCasing)
    } else this.casings.reset()
    this.shown.casings = this.casings.count
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
    count = this.writeDome(lights, count, max, s, at.night)
    const on = s.worldDetails && this.tvs.length > 0
    const level = this.tvLevelNow
    lampPower[TV_LAMP_SLOT] = on ? (0.35 + 0.9 * level) * Math.min(2, Math.max(0.2, s.dtTvPower)) : 0
    this.shown.tvLights = 0
    if (!on || !at.interior || count >= max || s.dtTvPower <= 0) return count
    let best: Tv | null = null
    let bd = 81
    for (const tv of this.tvs) {
      if (this.decay && !this.powered(tv.building)) continue
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

  /** The nearest open car's dome light (warm, dim, dying night by night), spilling out of the doorway. */
  private writeDome(lights: Float32Array, count: number, max: number, s: OutbreakDetailSettings, night: number): number {
    this.shown.domes = 0
    if (!this.dome.on || !s.worldDetails || !s.lifeTouches || count >= max || this.dome.d2 > 22 * 22) return count
    const level = domeLevel(this.night, this.time, this.dome.phase, this.decay)
    // A small bulb: it only tells once the daylight has gone.
    const p = 0.3 * level * (0.1 + 0.9 * night)
    if (p <= 0.004) return count
    const d = this.dome
    const o = count * LIGHT_FLOATS
    lights.fill(0, o, o + LIGHT_FLOATS)
    lights[o] = d.x
    lights[o + 1] = d.y
    lights[o + 2] = d.z
    lights[o + 3] = DOME_RADIUS
    lights[o + 4] = 1
    lights[o + 5] = 0.74
    lights[o + 6] = 0.44
    lights[o + 7] = p
    lights[o + 14] = 0.25
    lights[o + 15] = -1
    this.shown.domes = 1
    return count + 1
  }

  /**
   * Details · Life sprites into the renderer's alpha and additive buffers (after everything else that writes them);
   * returns the new counts in a reused object.
   */
  writeLife(f: TouchFrame, s: OutbreakDetailSettings, alpha: Float32Array, alphaCount: number, add: Float32Array, addCount: number): { readonly alpha: number; readonly add: number } {
    this.touches.write(f, s, s.worldDetails ? this.sites : [], alpha, alphaCount, add, addCount, this.lifeOut)
    return this.lifeOut
  }

  /** Distant dogs at night (`life.ts`); `play` is the game's audio. */
  stepLife(time: number, s: OutbreakDetailSettings, night: number, listener: { x: number; y: number }, play: (e: LifeSound) => void): void {
    this.life.step(time, s, night, listener, play)
    this.shown.barks = this.life.barks
  }

  reset(): void {
    this.touches.reset()
    this.casings.reset()
    this.doors.clear()
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
