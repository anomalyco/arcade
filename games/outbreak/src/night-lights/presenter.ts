import { MAT, Mesh, type Mat, type Rgb } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import { LIGHT_FLOATS, MAX_MAP_LIGHTS } from "@arcade/kit/limits"
import type { StoreState } from "@arcade/kit/sim/ledger"
import { carStoreId } from "../../shared/discovery/verbs"
import { lampDark, lampStoreId } from "../../shared/lights-out/lights"
import type { Lamp, Town } from "../../shared/map"
import type { SessionView } from "../../shared/session"
import { supportHeight } from "../../shared/terrain"
import { alarmFlashOn, alarmWailing, carPose } from "../discovery/verbs"
import { flareLights } from "../flares/props"
import type { ResolvedLamp } from "../lighting"
import { lampFlickerPhase, lampKey, neonLevel, placeNightLights, sodiumLevel, type NeonColour, type NightSite } from "./placement"
import type { OutbreakNightLightSettings } from "./settings"

/** Map-light fixture slot the lit lenses and neon tubes glow with (MAT.lamp aux). */
export const NIGHT_LAMP_SLOT = MAX_MAP_LIGHTS - 3

const hex = (v: number): Rgb => [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]

const NEON: Record<NeonColour, { tube: number; off: number; light: readonly [number, number, number] }> = {
  green: { tube: 0x38ff78, off: 0x16301e, light: [0.18, 1, 0.38] },
  pink: { tube: 0xff3a9c, off: 0x341626, light: [1, 0.16, 0.5] },
  cyan: { tube: 0x40e4ff, off: 0x12303a, light: [0.2, 0.85, 1] },
  red: { tube: 0xff2a18, off: 0x341410, light: [1, 0.1, 0.06] },
}

type Model = { on: number; off: number }

type Candidate = { d2: number; o: number }

/**
 * Draws and lights the coloured night practicals. Lit lenses and tubes use MAT.lamp on `NIGHT_LAMP_SLOT` (on/off
 * models swapped per frame, so a strobe is a hard flash); their light goes into the frame's map-light range after
 * the table lamps, where `uLampGrid` bins it like any other practical, re-packed every frame so strobes and the
 * beacon's sweep animate. Gated by the hour (`day.lamps`): faint by day, full at night.
 */
export class NightLightsPresenter {
  private readonly models: {
    barBase: number
    red: Model
    blue: Model
    beaconBase: number
    beacon: Model
    led: Model
    board: number
    cross: Model
    bar: Record<Exclude<NeonColour, "green">, Model>
  }
  private readonly pool = new Map<number, { data: Float32Array<ArrayBuffer>; count: number }>()
  private readonly out: Batch[] = []
  private key = ""
  private sites: NightSite[] = []
  private flickerKey = ""
  private readonly flicker = new Map<string, number>()
  private readonly cand: Candidate[] = []
  private readonly candData = new Float32Array(64 * LIGHT_FLOATS)
  /** Road flares among this frame's candidates (they light whether or not the practicals are on). */
  private flares = 0
  /** The ledger as of this frame's `collect`, for lamps shot out or switched off (Lights Out). */
  private stores: ReadonlyMap<string, StoreState> | null = null
  /** Proof readout of the last frame. */
  readonly shown = { sites: 0, lights: 0, alarms: 0, cruisers: 0, beacons: 0, neon: 0, armed: 0, flickering: 0, flares: 0, dark: 0 }

  constructor(renderer: Pick<Renderer, "addModel">) {
    const lens = (build: (m: Mesh, col: Rgb, mat: Mat, aux: number) => void, on: number, off: number): Model => {
      const a = new Mesh()
      build(a, hex(on), MAT.lamp, NIGHT_LAMP_SLOT)
      const b = new Mesh()
      build(b, hex(off), MAT.lit, 0)
      return { on: renderer.addModel(a), off: renderer.addModel(b) }
    }
    // Light bar across the roof (car frame: +X forward, the bar spans Z), red on the driver's side, blue the other.
    const barBase = new Mesh()
    barBase.box(-0.1, 0, -0.52, 0.1, 0.05, 0.52, hex(0x15171b), MAT.lit)
    const red = lens((m, c, mat, aux) => m.box(-0.085, 0.05, -0.5, 0.085, 0.13, -0.04, c, mat, aux), 0xff2412, 0x3a100c)
    const blue = lens((m, c, mat, aux) => m.box(-0.085, 0.05, 0.04, 0.085, 0.13, 0.5, c, mat, aux), 0x2a5cff, 0x101a36)
    // Shop alarm beacon: a squat red dome on a bracket above the door (front faces +Z).
    const beaconBase = new Mesh()
    beaconBase.box(-0.11, -0.06, -0.09, 0.11, 0.0, 0.09, hex(0x24262a), MAT.lit)
    beaconBase.box(-0.03, -0.06, -0.1, 0.03, 0.0, -0.02, hex(0x24262a), MAT.lit)
    const beacon = lens((m, c, mat, aux) => m.prism(0, 0, 0.085, 0.06, 0.0, 0.16, 10, c, mat, aux), 0xff2010, 0x40100c)
    const led = lens((m, c, mat, aux) => m.box(-0.03, 0, -0.03, 0.03, 0.04, 0.03, c, mat, aux), 0xff1408, 0x2a0806)
    // Neon on a dark board, tubes facing +Z.
    const board = new Mesh()
    board.box(-0.7, -0.26, -0.03, 0.7, 0.26, 0.0, hex(0x15161a), MAT.lit)
    const cross = lens(
      (m, c, mat, aux) => {
        m.box(-0.07, -0.22, 0.0, 0.07, 0.22, 0.04, c, mat, aux)
        m.box(-0.22, -0.07, 0.0, 0.22, 0.07, 0.04, c, mat, aux)
      },
      NEON.green.tube,
      NEON.green.off,
    )
    const barSign = (colour: Exclude<NeonColour, "green">) =>
      lens(
        (m, c, mat, aux) => {
          m.box(-0.6, 0.08, 0.0, 0.6, 0.13, 0.04, c, mat, aux)
          m.box(-0.6, -0.13, 0.0, 0.25, -0.08, 0.04, c, mat, aux)
          for (const x of [-0.6, -0.22, 0.25]) m.box(x - 0.025, -0.13, 0.0, x + 0.025, 0.13, 0.04, c, mat, aux)
        },
        NEON[colour].tube,
        NEON[colour].off,
      )
    this.models = {
      barBase: renderer.addModel(barBase),
      red,
      blue,
      beaconBase: renderer.addModel(beaconBase),
      beacon,
      led,
      board: renderer.addModel(board),
      cross,
      bar: { pink: barSign("pink"), cyan: barSign("cyan"), red: barSign("red") },
    }
  }

  private ensureSites(town: Town, s: OutbreakNightLightSettings): void {
    const o = town.windowOrigin ?? [0, 0]
    const key = `${town.seed}:${o[0]},${o[1]}:${town.buildings.length}:${(town.vehicles ?? []).length}:${s.nightLights}:${s.nlCruisers}:${s.nlBeacons}:${s.nlNeon}:${s.nlArmedLeds}:${s.nlSeed}`
    if (key === this.key) return
    this.key = key
    this.sites = placeNightLights(town, s)
  }

  /**
   * Called per lamp before it is packed: a lamp shot out or switched off (Lights Out, from the ledger) gives no light
   * and its bulb goes dark; a dying sodium lamp dims the resolved light and its bulb in step.
   */
  trimLamp(town: Town, s: OutbreakNightLightSettings, lamp: Lamp, resolved: ResolvedLamp, time: number): void {
    if ((lamp.kind === "street" || lamp.kind === "porch") && this.stores && lampDark(this.stores.get(lampStoreId(lamp)))) {
      resolved.power = 0
      resolved.fixtureBrightness = 0
      this.shown.dark++
      return
    }
    if (lamp.kind !== "street") return
    const fk = `${town.seed}:${s.nightLights}:${s.nlSodiumFlicker}:${s.nlSeed}`
    if (fk !== this.flickerKey) {
      this.flickerKey = fk
      this.flicker.clear()
    }
    const key = lampKey(lamp)
    let phase = this.flicker.get(key)
    if (phase === undefined) this.flicker.set(key, (phase = lampFlickerPhase(town, s, lamp)))
    if (phase < 0) return
    const k = sodiumLevel(phase, time)
    resolved.power *= k
    resolved.fixtureBrightness *= k
    this.shown.flickering++
  }

  private put(model: number, x: number, y: number, z: number, yaw: number): void {
    let v = this.pool.get(model)
    if (!v) this.pool.set(model, (v = { data: new Float32Array(32 * INST_FLOATS), count: 0 }))
    if ((v.count + 1) * INST_FLOATS > v.data.length) {
      const grown = new Float32Array(v.data.length * 2)
      grown.set(v.data)
      v.data = grown
    }
    v.data.set([x, y, z, yaw, 1, 1, 1, 1, 0, 0, 1, 0], v.count++ * INST_FLOATS)
  }

  private light(camX: number, camY: number, x: number, h: number, z: number, r: number, c: readonly [number, number, number], power: number, cone?: { dx: number; dz: number; cos: number }): void {
    if (power <= 0.002 || this.cand.length >= 64) return
    const o = this.cand.length * LIGHT_FLOATS
    const d = this.candData
    d[o] = x
    d[o + 1] = h
    d[o + 2] = z
    d[o + 3] = r
    d[o + 4] = c[0]
    d[o + 5] = c[1]
    d[o + 6] = c[2]
    d[o + 7] = power
    d[o + 8] = cone ? cone.dx : 0
    d[o + 9] = cone ? cone.dz : 0
    d[o + 10] = cone ? cone.cos : 0
    // Points: cone.w -1 keeps them out of rooms in the interior view, like the porch lights. Beacons: a cone.
    d[o + 11] = cone ? 1 : -1
    d[o + 12] = 0
    d[o + 13] = 0
    d[o + 14] = 0.12
    d[o + 15] = -1
    this.cand.push({ d2: (x - camX) ** 2 + (z - camY) ** 2, o })
  }

  /**
   * Builds this frame's meshes and light candidates; `writeLights` then packs the nearest into the light buffer.
   * `night` is the hour's lamp level (0 day .. 1 night).
   */
  collect(view: SessionView, s: OutbreakNightLightSettings, rect: readonly [number, number, number, number], camX: number, camY: number, night: number): readonly Batch[] {
    for (const v of this.pool.values()) v.count = 0
    this.out.length = 0
    this.cand.length = 0
    const sh = this.shown
    sh.lights = sh.alarms = sh.cruisers = sh.beacons = sh.neon = sh.armed = 0
    sh.flickering = sh.dark = 0
    const { town, time, progression } = view
    this.stores = progression.ledger.stores
    this.flares = flareLights(view, camX, camY, s, (x, z) => supportHeight(town, x, z), (x, h, z, r, c, power) => this.light(camX, camY, x, h, z, r, c, power))
    sh.flares = this.flares
    this.ensureSites(town, s)
    sh.sites = this.sites.length
    if (!s.nightLights) return this.out
    const [x0, y0, x1, y1] = rect
    const m = 6
    const inView = (x: number, z: number) => x > x0 - m && x < x1 + m && z > y0 - m && z < y1 + m
    const pw = Math.max(0, s.nlPower)
    const strobe = 0.35 + 0.65 * night
    const rate = Math.max(0.05, s.nlStrobeRate)
    const ledger = progression.ledger
    const M = this.models

    if (s.nlAlarmCars) {
      for (const car of progression.verbs.cars) {
        if (!car.alarm || !inView(car.x, car.y)) continue
        const st = ledger.store(carStoreId(car.key))
        if (!st || !alarmWailing(st, time)) continue
        sh.alarms++
        if (!alarmFlashOn(st, time)) continue
        const pose = carPose(car.rect)
        const c = Math.cos(pose.yaw)
        const sn = Math.sin(pose.yaw)
        const g = supportHeight(town, pose.x, pose.z)
        // Headlights throw warm white ahead (tinted by the indicators), the tail lights red behind.
        const nose = pose.halfLength + 1.1
        const tail = pose.halfLength + 0.45
        this.light(camX, camY, pose.x + c * nose, g + 0.7, pose.z + sn * nose, 6, [1, 0.74, 0.42], 0.4 * pw * strobe)
        this.light(camX, camY, pose.x - c * tail, g + 0.65, pose.z - sn * tail, 5.2, [1, 0.07, 0.04], 0.36 * pw * strobe)
      }
    }

    for (const site of this.sites) {
      if (!inView(site.x, site.z)) continue
      if (site.kind === "cruiser") {
        sh.cruisers++
        const g = supportHeight(town, site.x, site.z)
        const y = g + site.roof
        // Two quick flashes per side, alternating red and blue.
        const t = (time * 2.2 * rate + site.phase) % 1
        const redOn = (t < 0.1 || (t > 0.18 && t < 0.28)) as boolean
        const blueOn = ((t > 0.5 && t < 0.6) || (t > 0.68 && t < 0.78)) as boolean
        this.put(M.barBase, site.x, y, site.z, site.yaw)
        this.put(redOn ? M.red.on : M.red.off, site.x, y, site.z, site.yaw)
        this.put(blueOn ? M.blue.on : M.blue.off, site.x, y, site.z, site.yaw)
        const c = Math.cos(site.yaw)
        const sn = Math.sin(site.yaw)
        // Model +Z after yaw: (-sin, cos). Red is on -Z, blue on +Z.
        if (redOn) this.light(camX, camY, site.x + sn * 0.9, y + 0.15, site.z - c * 0.9, 7, [1, 0.06, 0.04], 0.5 * pw * strobe)
        if (blueOn) this.light(camX, camY, site.x - sn * 0.9, y + 0.15, site.z + c * 0.9, 7, [0.12, 0.3, 1], 0.6 * pw * strobe)
      } else if (site.kind === "armed") {
        const st = ledger.store(carStoreId(site.car))
        if (st) continue
        sh.armed++
        const g = supportHeight(town, site.x, site.z)
        const on = (time * 0.8 * rate + site.phase) % 1 < 0.08
        this.put(on ? M.led.on : M.led.off, site.x, g + 0.78, site.z, site.yaw)
        if (on) this.light(camX, camY, site.x, g + 1.0, site.z, 1.7, [1, 0.05, 0.03], 0.1 * pw * night)
      } else if (site.kind === "beacon") {
        sh.beacons++
        const g = supportHeight(town, site.x, site.z)
        const y = g + site.h
        const yaw = Math.atan2(-site.nx, site.nz)
        this.put(M.beaconBase, site.x, y, site.z, yaw)
        this.put(M.beacon.on, site.x, y, site.z, yaw)
        // A rotating mirror: the beam sweeps the street in front; the wall blocks the half facing into the shop.
        const a = (time * 3.4 * rate + site.phase * 6.283) % 6.283
        const dx = Math.cos(a)
        const dz = Math.sin(a)
        const front = dx * site.nx + dz * site.nz
        if (front > 0.05) this.light(camX, camY, site.x + site.nx * 0.25, y + 0.08, site.z + site.nz * 0.25, 9, [1, 0.06, 0.03], 0.95 * pw * strobe * Math.min(1, front * 2.5), { dx, dz, cos: Math.cos(0.42) })
        // A soft red wash at the door so the fixture itself reads.
        this.light(camX, camY, site.x + site.nx * 0.4, y - 0.3, site.z + site.nz * 0.4, 2.6, [1, 0.08, 0.04], 0.14 * pw * strobe)
      } else {
        sh.neon++
        const g = supportHeight(town, site.x, site.z)
        const y = g + site.h
        const yaw = Math.atan2(-site.nx, site.nz)
        const lvl = neonLevel(site.broken, site.phase, time)
        const lit = lvl > 0.3
        this.put(M.board, site.x, y, site.z, yaw)
        const model = site.colour === "green" ? M.cross : M.bar[site.colour]
        this.put(lit ? model.on : model.off, site.x, y, site.z, yaw)
        if (lit) this.light(camX, camY, site.x + site.nx * 0.5, y - 0.2, site.z + site.nz * 0.5, 4.2, NEON[site.colour].light, 0.26 * pw * lvl * (0.25 + 0.75 * night))
      }
    }
    for (const [model, v] of this.pool) if (v.count) this.out.push({ model, data: v.data, count: v.count })
    return this.out
  }

  /**
   * Packs the nearest candidates into `lights` from slot `count`, up to `nlMaxLights` practicals plus the burning
   * road flares; returns the new count.
   */
  writeLights(lights: Float32Array, count: number, max: number, lampPower: Float32Array, s: OutbreakNightLightSettings): number {
    lampPower[NIGHT_LAMP_SLOT] = s.nightLights ? 0.9 * Math.min(1.5, Math.max(0.2, s.nlPower)) : 0
    if (!s.nightLights && !this.flares) return count
    this.cand.sort((a, b) => a.d2 - b.d2)
    const cap = (s.nightLights ? Math.max(0, Math.round(s.nlMaxLights)) : 0) + Math.min(4, this.flares)
    const n = Math.min(this.cand.length, cap, Math.max(0, max - count))
    for (let i = 0; i < n; i++) {
      const src = this.cand[i]!.o
      lights.set(this.candData.subarray(src, src + LIGHT_FLOATS), (count + i) * LIGHT_FLOATS)
    }
    this.shown.lights = n
    return count + n
  }
}

let current: NightLightsPresenter | null = null

export function setCurrentNightLights(p: NightLightsPresenter): void {
  current = p
}

export const currentNightLights = (): NightLightsPresenter | null => current
