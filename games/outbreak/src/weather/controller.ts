import { LIGHT_FLOATS } from "@arcade/kit/limits"
import { SPRITE_FLOATS } from "@arcade/kit/gpu/renderer"
import {
  WeatherSimulation,
  isClearWeather,
  weatherDefaults,
  type WeatherEave,
  type WeatherExcludeRect,
  type WeatherFrameState,
  type WeatherLight,
  type WeatherPrepareInput,
  type WeatherSettings,
} from "@arcade/kit/weather"
import type { Town } from "../../shared/map"
import { beamWeatherAir } from "../flashlight-beam"
import { lightningAt, strikeFlash, strikesBetween, type LightningStrike } from "../../shared/weather/lightning"
import { DEFAULT_WEATHER_TUNING, sampleWeather, type WeatherSample } from "../../shared/weather/schedule"
import { cycleWeatherSettings } from "./cycle"
import { toSharedWeatherSettings, type OutbreakWeatherSettings } from "./settings"

/** A near strike's mark on the town: where it landed (snapped to a pole or tree) and when. */
export type StrikeMark = { x: number; z: number; top: number; ground: number; t: number; seed: number }

/** What the scene, the lighting pack, the sight shroud and the reflections read of the weather this frame. */
export type WeatherSurface = {
  /** Ground wetness 0..1 (`OL.u8.y`). */
  wetness: number
  /** Standing water 0..1 (`OL.u8.z`; `outbreakPuddleMask` spreads with it). */
  puddles: number
  /** Raindrop rings on standing water 0..1. */
  ripple: number
  /** Wet gloss in light 0..2 (`OL.art.w`). */
  wetGloss: number
}

const STRIKE_MARK_LIFE = 1.6
const NEAR_STRIKE = 100
const MAX_EAVE_BUILDINGS = 4
const FLASH_COLOUR = [0.78, 0.86, 1.0] as const

/**
 * The weather in the frame (AR-71): runs the shared cycle for this town and sim time (`shared/weather/`), turns it into
 * the kit renderer's rain, wet ground and mist, and lights the town on the cycle's lightning. A near strike lights its
 * pole or tree and throws sparks. The Lab's manual look (fog, snow) replaces the cycle while it is on.
 */
export class OutbreakWeatherController {
  readonly sim = new WeatherSimulation(7)
  /** This frame's cycle sample (rain, storm, wetness, puddles, senses). */
  readonly sample: WeatherSample = sampleWeather(0, 0, 12, { ...DEFAULT_WEATHER_TUNING, weatherCycle: 0 })
  /** The kit settings the renderer drew with this frame. */
  readonly shared: WeatherSettings = { ...weatherDefaults }
  readonly surface: WeatherSurface = { wetness: 0, puddles: 0, ripple: 0, wetGloss: 1 }
  /** Lightning light this frame 0..1 (after brightness). */
  flash = 0
  /** How far the flash lifts the shroud this frame 0..1. */
  shroudLift = 0
  /** Share of the shroud lifted for the dead in line of sight (Vision.skyFlash) 0..1. */
  reveal = 0
  /** Plan direction the light comes from (unit, x/z) and its elevation. */
  readonly strikeDir: [number, number, number] = [-0.55, 0.58, -0.6]
  /** Strikes that began this frame (thunder and marks). */
  readonly strikes: LightningStrike[] = []
  readonly marks: StrikeMark[] = []
  /** Overcast 0..1 (sky dims under rain). */
  overcast = 0
  /** Extra beam air from rain and mist (0..2). */
  air = 0

  private cachedTownSeed = -1
  private excludeRects: WeatherExcludeRect[] = []
  private readonly eaves: WeatherEave[] = []
  private readonly activeLights: WeatherLight[] = []
  private readonly focusScratch: [number, number] = [0, 0]
  private readonly strike: LightningStrike = { t: 0, power: 0, bearing: 0, dist: 0, reflash: 0, id: 0 }
  private forced: LightningStrike | null = null
  private clock = 0
  private lastSimTime = Number.NaN
  private sampleAt = Number.NaN
  private readonly resultScratch: { state: WeatherFrameState; prepareInput: WeatherPrepareInput | null; lightCount: number; spriteCount: number } = {
    state: null as unknown as WeatherFrameState,
    prepareInput: null,
    lightCount: 0,
    spriteCount: 0,
  }

  reset(seed = 7): void {
    this.sim.reset(seed)
    this.forced = null
    this.lastSimTime = Number.NaN
    this.sampleAt = Number.NaN
    this.marks.length = 0
    this.strikes.length = 0
  }

  /** A lightning strike now (Lab, `arcade cmd weather.flash`); near puts it within 100 m so it hits something. */
  flashNow(opts: { seed?: number; near?: boolean; bearing?: number; dist?: number } = {}): LightningStrike {
    const seed = ((opts.seed ?? Math.floor(this.clock * 997 + 31)) >>> 0) % 0xffffff
    const near = opts.near ?? true
    const s: LightningStrike = {
      t: this.clock,
      power: 1,
      bearing: opts.bearing ?? ((seed % 360) * Math.PI) / 180,
      dist: opts.dist ?? (near ? 30 + (seed % 50) : 600 + (seed % 1500)),
      reflash: 0.14,
      id: -1 - seed,
    }
    this.forced = s
    this.strikes.push(s)
    return { ...s }
  }

  /** The older name for `flashNow`. */
  strikeNow(seed?: number): LightningStrike {
    return this.flashNow({ seed })
  }

  private ensureTownGeometry(town: Town): void {
    if (this.cachedTownSeed === town.seed && this.excludeRects.length === town.buildings.length) return
    this.cachedTownSeed = town.seed
    this.excludeRects = town.buildings.map((b) => b.rect)
  }

  /** Eaves of the buildings nearest the survivor: front and back drip lines just outside the walls. */
  private nearestEaves(town: Town, x: number, y: number): void {
    this.eaves.length = 0
    const near = town.buildings
      .map((b) => ({ b, d: Math.hypot((b.rect[0] + b.rect[2]) / 2 - x, (b.rect[1] + b.rect[3]) / 2 - y) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_EAVE_BUILDINGS)
    for (const { b } of near) {
      const [x0, z0, x1, z1] = b.rect
      this.eaves.push([x0 - 0.35, z1 + 0.35, x1 + 0.35, z1 + 0.35, 2.78])
      this.eaves.push([x0 - 0.35, z0 - 0.35, x1 + 0.35, z0 - 0.35, 2.78])
    }
  }

  /** The cycle's weather for this frame (cheap; the wetness window is walked at most once a sim second). */
  sampleCycle(seed: number, simTime: number, hour: number, settings: Readonly<OutbreakWeatherSettings>): WeatherSample {
    if (Math.floor(simTime) !== this.sampleAt || settings.weatherOverride >= 0 || !(settings.weatherCycle >= 1)) {
      this.sampleAt = Math.floor(simTime)
      sampleWeather(seed, simTime, hour, settings, this.sample)
    }
    return this.sample
  }

  stepAndPrepare(input: {
    dt: number
    town: Town
    settings: Readonly<OutbreakWeatherSettings>
    viewProj: Float32Array
    eye: readonly [number, number, number] | Float32Array
    playerX: number
    playerY: number
    playerGroundY: number
    canvasWidth: number
    canvasHeight: number
    zoom: number
    lights: Float32Array
    lightCount: number
    maxLights: number
    ambientLum: number
    particleScale?: number
    /** Sim seconds and hour from the session view (co-op snapshots carry both). */
    simTime: number
    hour: number
    /** Additive sprites for strike sparks; `spriteCount` is where to start writing. */
    sprites?: Float32Array
    spriteCount?: number
    support?: (x: number, z: number) => number
    /** The vegetation gust field's wind direction (degrees from +x toward +z) when it is on, so rain slants with the trees. */
    windDirDeg?: number
  }): { state: WeatherFrameState; prepareInput: WeatherPrepareInput | null; lightCount: number; spriteCount: number } {
    const s = input.settings
    const dt = Math.max(0, Math.min(0.1, input.dt))
    this.clock += dt
    this.ensureTownGeometry(input.town)
    this.focusScratch[0] = input.playerX
    this.focusScratch[1] = input.playerY
    const manual = s.weatherEnabled
    const scale = input.particleScale ?? 1
    const seed = input.town.seed
    if (manual) {
      Object.assign(this.shared, toSharedWeatherSettings(s, scale))
      this.sample.rain = this.shared.intensity
      this.sample.storm = this.shared.lightningRate
      this.sample.wetness = this.shared.wetness
      this.sample.puddles = Math.min(1, this.shared.puddleCoverage)
    } else {
      this.sampleCycle(seed, input.simTime, input.hour, s)
      cycleWeatherSettings(this.sample, s, scale, this.shared)
      if (input.windDirDeg !== undefined) this.shared.windDir = input.windDirDeg
    }

    // Strikes the clock passed this frame (the cycle's, from sim time, so every client sees the same ones).
    if (!manual && Number.isFinite(this.lastSimTime) && input.simTime > this.lastSimTime) {
      for (const k of strikesBetween(seed, this.lastSimTime, input.simTime, input.hour, s)) this.strikes.push(k)
    }
    this.lastSimTime = input.simTime
    let flash = manual ? 0 : lightningAt(seed, input.simTime, input.hour, s, this.strike)
    if (this.forced) {
      const f = strikeFlash(this.forced, this.clock - this.forced.t)
      if (f > flash) {
        flash = f
        Object.assign(this.strike, this.forced)
      }
      if (this.clock - this.forced.t > 0.5) this.forced = null
    }
    for (const k of this.strikes) this.markStrike(k, input.town, input.playerX, input.playerY, input.support)

    const st = this.sim.step(dt, this.shared, input.eye, this.focusScratch)
    if (!manual) {
      // The kit's own lightning is off; the cycle's strikes light the rain and the sky.
      flash = Math.min(1, flash * s.weatherFlashBrightness)
      st.flash = flash
      st.skyScale += flash * 1.45
      st.sunScale += flash * 1.85
      st.active = st.active || flash > 0.001
    } else {
      flash = st.flash
    }
    const b = this.strike.bearing
    this.strikeDir[0] = Math.cos(b) * 0.7
    this.strikeDir[1] = 0.72
    this.strikeDir[2] = Math.sin(b) * 0.7
    st.strikeDir[0] = this.strikeDir[0]
    st.strikeDir[1] = this.strikeDir[1]
    st.strikeDir[2] = this.strikeDir[2]
    this.flash = flash
    this.shroudLift = flash * Math.max(0, Math.min(1, s.weatherFlashLift))
    this.reveal = s.weatherFlashReveal >= 1 ? Math.min(1, flash * 1.6) : 0
    const rain = this.shared.intensity
    this.overcast = Math.min(1, rain * 0.75 + this.shared.mist * 0.2)
    this.air = beamWeatherAir({ intensity: rain, mist: this.shared.mist })
    this.surface.wetness = st.wetness
    this.surface.puddles = Math.min(1, st.puddleCoverage)
    this.surface.ripple = st.rippleIntensity
    this.surface.wetGloss = s.weatherWetGloss

    const lightCount = input.lightCount
    let spriteCount = input.spriteCount ?? 0
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const m = this.marks[i]!
      const age = this.clock - m.t
      if (age > STRIKE_MARK_LIFE) {
        this.marks.splice(i, 1)
        continue
      }
      if (input.sprites) spriteCount = this.writeMarkSprites(m, age, input.sprites, spriteCount)
    }

    this.resultScratch.lightCount = lightCount
    this.resultScratch.spriteCount = spriteCount
    this.resultScratch.state = st
    if (isClearWeather(this.shared) && st.flash <= 0.001) {
      this.resultScratch.prepareInput = null
      return this.resultScratch
    }
    this.nearestEaves(input.town, input.playerX, input.playerY)

    // Rain catches the scene's lights (slot 0 is the sight light).
    this.activeLights.length = 0
    for (let i = 1; i < lightCount && this.activeLights.length < 12; i++) {
      const base = i * LIGHT_FLOATS
      const power = input.lights[base + 7]!
      if (power <= 0.01) continue
      const hasCone = input.lights[base + 11]! > 0.5
      this.activeLights.push({
        x: input.lights[base]!,
        y: input.lights[base + 1]!,
        z: input.lights[base + 2]!,
        radius: input.lights[base + 3]!,
        r: input.lights[base + 4]!,
        g: input.lights[base + 5]!,
        b: input.lights[base + 6]!,
        power: hasCone ? power * 2.2 : power * 1.25,
        dx: input.lights[base + 8]!,
        dz: input.lights[base + 9]!,
        cosHalf: input.lights[base + 10]!,
        isCone: hasCone,
      })
    }

    this.resultScratch.prepareInput = {
      settings: this.shared,
      state: st,
      viewProj: input.viewProj,
      eye: input.eye,
      focusXZ: this.focusScratch,
      viewportWidth: input.canvasWidth,
      viewportHeight: input.canvasHeight,
      fovYRad: 0.52,
      groundY: input.playerGroundY,
      ambientLum: input.ambientLum,
      lights: this.activeLights,
      excludeRects: this.excludeRects,
      eaves: this.eaves,
      cameraDist: input.zoom,
    }
    return this.resultScratch
  }

  /**
   * Near strikes' lights (flash, then smoulder) packed with the map's extra lights, before the lamp grid is built so
   * the scene shades them. They trail the strike by a frame. Returns the new count.
   */
  writeLights(lights: Float32Array, count: number, max: number): number {
    for (const m of this.marks) {
      const age = this.clock - m.t
      if (age <= STRIKE_MARK_LIFE) count = this.writeMarkLight(m, age, lights, count, max)
    }
    return count
  }

  /** A near strike lands on the street lamp or tree nearest where it fell, within 14 m, else on open ground. */
  private markStrike(k: LightningStrike, town: Town, px: number, py: number, support?: (x: number, z: number) => number): void {
    if (k.dist > NEAR_STRIKE || this.marks.some((m) => m.seed === k.id)) return
    let x = px + Math.cos(k.bearing) * k.dist
    let z = py + Math.sin(k.bearing) * k.dist
    let top = 5.5
    let best = 14 * 14
    for (const l of town.lamps) {
      if (l.kind !== "street") continue
      const d = (l.x - x) ** 2 + (l.y - z) ** 2
      if (d < best) {
        best = d
        x = l.x
        z = l.y
        top = l.h + 0.4
      }
    }
    for (const p of town.props) {
      if (p.kind !== "tree") continue
      const d = (p.x - x) ** 2 + (p.y - z) ** 2
      if (d < best) {
        best = d
        x = p.x
        z = p.y
        top = 6.2
      }
    }
    const ground = support ? support(x, z) : 0
    this.marks.push({ x, z, top: ground + top, ground, t: this.clock, seed: k.id })
    if (this.marks.length > 4) this.marks.shift()
  }

  /** The strike's light: a hard blue-white flash on the spot, then a dim orange smoulder where it hit. */
  private writeMarkLight(m: StrikeMark, age: number, lights: Float32Array, count: number, max: number): number {
    if (count >= max) return count
    const flash = age < 0.32 ? Math.exp(-age / 0.06) + (age > 0.12 ? 0.6 * Math.exp(-(age - 0.12) / 0.05) : 0) : 0
    const smoulder = age > 0.05 ? 0.35 * Math.exp(-(age - 0.05) / 0.5) * (0.75 + 0.25 * Math.sin(age * 41 + m.seed)) : 0
    const power = flash * 9 + smoulder
    if (power <= 0.01) return count
    const w = flash * 9 > smoulder ? 1 : 0
    const o = count * LIGHT_FLOATS
    lights.fill(0, o, o + LIGHT_FLOATS)
    lights[o] = m.x
    lights[o + 1] = m.top - 0.6
    lights[o + 2] = m.z
    lights[o + 3] = 9 + 9 * w
    lights[o + 4] = w ? FLASH_COLOUR[0] : 1.0
    lights[o + 5] = w ? FLASH_COLOUR[1] : 0.48
    lights[o + 6] = w ? FLASH_COLOUR[2] : 0.16
    lights[o + 7] = power
    lights[o + 11] = -1
    lights[o + 14] = 0.12
    lights[o + 15] = -1
    return count + 1
  }

  /** The bolt (a jagged column of glows from the sky to the hit) for the flash, then sparks falling. */
  private writeMarkSprites(m: StrikeMark, age: number, sprites: Float32Array, start: number): number {
    const max = Math.floor(sprites.length / SPRITE_FLOATS)
    let n = start
    const push = (x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number) => {
      if (n >= max || a <= 0.003) return
      const o = n++ * SPRITE_FLOATS
      sprites[o] = x
      sprites[o + 1] = y
      sprites[o + 2] = z
      sprites[o + 3] = size
      sprites[o + 4] = r
      sprites[o + 5] = g
      sprites[o + 6] = b
      sprites[o + 7] = a
      sprites[o + 8] = 0
      sprites[o + 9] = 0
      sprites[o + 10] = 1
      sprites[o + 11] = 0
    }
    const hash = (i: number, salt: number) => {
      const v = Math.sin((m.seed % 9973) * 12.9898 + i * 78.233 + salt * 37.719) * 43758.5453
      return v - Math.floor(v)
    }
    const boltA = age < 0.07 ? 1 : age > 0.12 && age < 0.2 ? 0.7 : 0
    if (boltA > 0) {
      let x = m.x
      let z = m.z
      const segs = 18
      for (let i = segs; i >= 0; i--) {
        const y = m.top + i * 1.4
        x = m.x + (hash(i, 1) - 0.5) * 1.6 * (i / segs)
        z = m.z + (hash(i, 2) - 0.5) * 1.6 * (i / segs)
        push(x, y, z, 0.32, FLASH_COLOUR[0], FLASH_COLOUR[1], FLASH_COLOUR[2], boltA)
        push(x, y, z, 1.3, 0.5, 0.6, 1.0, boltA * 0.25)
      }
    }
    if (age < 1.1) {
      for (let i = 0; i < 26; i++) {
        const life = 0.45 + 0.6 * hash(i, 3)
        if (age > life) continue
        const u = age / life
        const ang = hash(i, 4) * Math.PI * 2
        const sp = 1.5 + 3.5 * hash(i, 5)
        const x = m.x + Math.cos(ang) * sp * age
        const z = m.z + Math.sin(ang) * sp * age
        const y = Math.max(m.ground + 0.05, m.top - 0.4 + (2.2 * hash(i, 6)) * age - 4.9 * age * age)
        push(x, y, z, 0.07 + 0.05 * (1 - u), 1.0, 0.72 - 0.3 * u, 0.32 - 0.25 * u, (1 - u) * 0.95)
      }
    }
    return n
  }

  /** Clears this frame's strikes once the frame (and its audio) has used them. */
  endFrame(): void {
    this.strikes.length = 0
  }
}
