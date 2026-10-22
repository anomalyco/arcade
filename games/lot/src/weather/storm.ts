import type { Renderer } from "@arcade/kit/gpu/renderer"
import { WEATHER_PRESETS, WeatherSimulation, weatherDefaults, evaluateWeatherGust, type WeatherFrameState, type WeatherLight, type WeatherPrepareInput, type WeatherSettings, type WeatherNumericKey, weatherRanges } from "@arcade/kit/weather"
import { BoltPass, BOLT_LOOK } from "@arcade/kit/weather/lightning-pass"
import { FlashLimiter, makeStrike, pickStrikeLights, rng, strikeEnd, type BoltKind, type Strike, type StrikeLight, type StrikePlan } from "@arcade/kit/weather/lightning"
import { LOT_WEATHER, type LotWeatherSettings } from "./settings"
import { EAVES, SHELTER_RECTS } from "./shelter"

/** Sky dome height: the channel disappears into the cloud below it. */
const CEILING = 210
const SPEED_OF_SOUND = 343

export type StormLamp = { x: number; y: number; z: number; color: readonly number[]; power: number; range: number; axis?: readonly number[]; cosOuter?: number }

export type StormInput = {
  dt: number
  settings: LotWeatherSettings
  eye: readonly number[]
  direction: readonly number[]
  fovY: number
  width: number
  height: number
  groundY: number
  inside: boolean
  lamps: readonly StormLamp[]
  /** The lot's height fog: density (1/m), falloff (1/m). */
  fog: readonly [number, number]
  frame: Float32Array
}

/** A strike as the sound needs it: when its thunder arrives and from where. */
export type ThunderEvent = { id: number; kind: BoltKind; distance: number; bearing: number; arrives: number; power: number }

export type StormFrame = {
  active: boolean
  /** 0 Today … 1 the full preset, eased so switching never jumps. */
  amount: number
  /** Rain intensity 0..1. */
  rain: number
  weather: WeatherPrepareInput | null
  /** Scene flash irradiance and the unit direction toward the strike. */
  flash: number
  flashDir: [number, number, number]
  /** Fog and sky brightness multiplier during a flash. */
  skyBoost: number
  wetness: number
  puddles: number
  glass: number
  /** Tree sway: amplitude (m at 20 m), wind direction, gust 0..2. */
  sway: [number, number, number, number]
  time: number
  gust: number
  windSpeed: number
  thunder: readonly ThunderEvent[]
  light: StrikeLight
  strike: Strike | null
}

const NUMERIC = Object.keys(weatherRanges) as WeatherNumericKey[]
const ease = (dt: number, tau: number) => 1 - Math.exp(-dt / tau)

export class LotStorm {
  readonly sim = new WeatherSimulation(11)
  readonly kit: WeatherSettings = { ...weatherDefaults }
  readonly bolt: BoltPass
  readonly limiter = new FlashLimiter()
  private time = 0
  private amount = 0
  private strikes: Strike[] = []
  private serial = 0
  private nextAt = 4
  private pending: Partial<StrikePlan> | null = null
  private thunder: ThunderEvent[] = []
  private lastMode = ""
  private readonly lights: WeatherLight[] = []

  constructor(renderer: Renderer) {
    this.bolt = new BoltPass(renderer.passContext)
    renderer.addPass("alpha", this.bolt)
  }

  /** "Strike now": a ground strike in view, 220–420 m out, on the next frame (after its leader). */
  strikeNow(plan: Partial<StrikePlan> = {}) { this.pending = plan }

  get strikeLog() { return this.strikes }

  frame(i: StormInput): StormFrame {
    const s = i.settings, dt = Math.min(0.1, Math.max(0, i.dt))
    this.time += dt
    const on = s.weather !== "today"
    const target = WEATHER_PRESETS[s.weather === "today" ? "clear" : s.weather].settings
    if (s.weather !== this.lastMode) { this.lastMode = s.weather; this.kit.preset = target.preset }
    // Rain arrives over ~1.5 s and the ground soaks more slowly; Today eases back to dry air.
    this.amount += ((on ? 1 : 0) - this.amount) * ease(dt, 1.2)
    for (const k of NUMERIC) this.kit[k] += (target[k] - this.kit[k]) * ease(dt, k === "wetness" || k === "puddleCoverage" ? 2.5 : 1.2)
    this.kit.lightningRate = 0
    this.kit.litOnly = 0.94
    const windScale = on ? s.wind / Math.max(0.01, presetWind(s.weather)) : 1
    const kit: WeatherSettings = { ...this.kit, windSpeed: this.kit.windSpeed * windScale, mist: this.kit.mist * (on ? s.mist / Math.max(0.01, presetMist(s.weather)) : 1) }
    const eye = i.eye as [number, number, number]
    const state = this.sim.step(dt, kit, eye, [eye[0], eye[2]])
    const bearingView = Math.atan2(i.direction[0]!, -i.direction[2]!)

    // Lightning: Poisson arrivals at the slider's rate, at least 6 s apart (Reduced: a third of the rate, 15 s apart).
    const reduce = s.flashes === "reduced", dark = s.flashes === "off"
    const rate = on ? s.strikes * (reduce ? 0.35 : 1) : 0
    if (this.pending) {
      const r = rng(0x51ed + this.serial * 7919)
      this.addStrike({ seed: (this.serial + 1) * 2654435761 >>> 0, kind: "ground", bearing: bearingView + (r() - 0.5) * 0.7, distance: 220 + 200 * r(), power: 1, ...this.pending }, eye, i.groundY, reduce)
      this.pending = null
    } else if (rate > 0 && this.time >= this.nextAt) {
      const r = rng(0xa11 + this.serial * 104729)
      const cloud = r() < s.cloud, far = !cloud && r() < 0.3
      const inView = r() < 0.6
      const bearing = inView ? bearingView + (r() - 0.5) * 1.6 : r() * Math.PI * 2
      const distance = cloud ? 250 + 300 * r() : far ? 1500 + 4500 * r() : 180 + 460 * r() ** 1.3
      this.addStrike({ seed: (this.serial + 1) * 2246822519 >>> 0, kind: cloud ? "cloud" : "ground", bearing, distance, power: far ? 0.45 : 0.75 + 0.25 * r() }, eye, i.groundY, reduce)
    }
    if (rate > 0 && this.time >= this.nextAt) {
      const r = rng(0xbeef + this.serial * 31)
      this.nextAt = this.time + Math.max(reduce ? 15 : 6, -Math.log(1 - r() * 0.999) * 60 / rate)
    } else if (rate <= 0) this.nextAt = this.time + 2
    this.strikes = this.strikes.filter(k => strikeEnd(k) > this.time)

    const pick = pickStrikeLights(this.strikes, this.time, reduce)
    const strike = pick.bolt
    let light = pick.light
    const visible = strike && strike.distance < 900 && !dark
    const look = reduce ? { ...BOLT_LOOK, coreIntensity: BOLT_LOOK.coreIntensity * 0.45, glowIntensity: BOLT_LOOK.glowIntensity * 0.45 } : BOLT_LOOK
    this.bolt.frame(visible ? strike : null, light, look, [i.fog[0], i.fog[1], 0], i.fovY)
    let flash = 0, dir: [number, number, number] = [0, 1, 0]
    if (pick.scene && pick.sceneLight > 0 && !dark) {
      const k = pick.scene, p = k.position, mid: [number, number, number] = [p[0] - eye[0], (k.kind === "cloud" ? p[1] : 160) - eye[1], p[2] - eye[2]]
      const l = Math.hypot(...mid) || 1
      dir = [mid[0] / l, mid[1] / l, mid[2] / l]
      flash = pick.sceneLight * s.flash * (reduce ? 0.5 : 1)
    }
    const st: WeatherFrameState = { ...state, flash: Math.min(1, flash) }
    const rain = Math.min(1, this.kit.intensity)
    const active = this.amount > 0.002 || this.strikes.length > 0
    const lights = this.weatherLights(i.lamps)
    const forward = [eye[0] + i.direction[0]! * 14, eye[2] + i.direction[2]! * 14] as const
    const weather: WeatherPrepareInput | null = rain > 0.005 ? {
      settings: kit, state: st, viewProj: i.frame, eye: i.eye, focusXZ: forward, viewportWidth: i.width, viewportHeight: i.height,
      fovYRad: i.fovY, groundY: i.groundY, ambientLum: 0.06, lights, excludeRects: SHELTER_RECTS, eaves: EAVES, cameraDist: 10,
    } : null
    light = { ...light, scene: dark ? 0 : pick.sceneLight }
    const gust = evaluateWeatherGust(this.time, eye[0], eye[2], kit.windDir, kit.windGust)
    const swayAmp = this.amount * (on ? s.wind : 0) * 0.35
    return {
      active, amount: this.amount, rain, weather, flash, flashDir: dir, skyBoost: 1 + 0.9 * flash,
      wetness: this.kit.wetness, puddles: this.amount * (on ? s.puddles : 0),
      glass: this.amount * (on ? s.glass : 0), sway: [swayAmp, state.windX, state.windZ, gust], time: this.time, gust, windSpeed: state.windSpeedMs,
      thunder: this.thunder, light, strike,
    }
  }

  private addStrike(plan: StrikePlan, eye: readonly number[], groundY: number, reduce: boolean) {
    this.serial++
    const leader = 0.1
    // Keep visible channels inside the sky dome (±699 m).
    let p = plan
    if (plan.distance < 900) {
      const gx = eye[0]! + Math.sin(plan.bearing) * plan.distance, gz = eye[2]! - Math.cos(plan.bearing) * plan.distance
      const over = Math.max(Math.abs(gx), Math.abs(gz)) / 560
      if (over > 1) p = { ...plan, distance: plan.distance / over }
    }
    // One scene-light pulse per strike in every mode; the shared limiter also keeps overlapping strikes to three a second.
    // Reduced: a strike only lights the scene once the last swell has faded (3 s), so swells never stack and dip.
    const k = makeStrike(p, this.time + leader, eye[0]!, eye[2]!, groundY, CEILING, this.limiter, 1, reduce ? 3 : 0)
    this.strikes.push(k)
    // Sound: the crack leaves the channel's nearest point, the roll follows from its farther reaches.
    const slant = Math.hypot(p.distance, k.kind === "cloud" ? CEILING * 0.85 : 60)
    this.thunder = [...this.thunder.filter(t => t.arrives > this.time - 30), { id: this.serial, kind: k.kind, distance: slant, bearing: p.bearing, arrives: k.t + slant / SPEED_OF_SOUND, power: p.power }]
  }

  private weatherLights(lamps: readonly StormLamp[]) {
    const out = this.lights
    out.length = 0
    for (const l of lamps) {
      if (out.length >= 12) break
      const cone = l.axis && l.cosOuter !== undefined && Math.hypot(l.axis[0]!, l.axis[2]!) > 0.2
      out.push({ x: l.x, y: l.y, z: l.z, radius: Math.min(l.range, 26), r: l.color[0]!, g: l.color[1]!, b: l.color[2]!, power: l.power,
        ...(cone ? { dx: l.axis![0]! / Math.hypot(l.axis![0]!, l.axis![2]!), dz: l.axis![2]! / Math.hypot(l.axis![0]!, l.axis![2]!), cosHalf: l.cosOuter, isCone: true } : {}) })
    }
    return out
  }
}

const presetWind = (m: LotWeatherSettings["weather"]) => m === "today" ? 1 : LOT_WEATHER[m].wind
const presetMist = (m: LotWeatherSettings["weather"]) => m === "today" ? 1 : LOT_WEATHER[m].mist
