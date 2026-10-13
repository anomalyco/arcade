import type { Sea } from "../../shared/sea"
import {
  lightningAt,
  makeWeather,
  makeWeatherSea,
  RoomWeather,
  strikeFlash,
  strikesBetween,
  type Strike,
  type Weather,
  type WeatherOverride,
  type WeatherSea,
} from "../../shared/weather"
import type { Atmosphere } from "./atmosphere"
import type { CloudStorm } from "./clouds"
import type { RelView } from "./ocean-view"
import type { Grade } from "./post"
import { Rain } from "./rain"
import type { Renderer } from "./renderer"
import { makeAtmosphere, weatherAtmosphere, weatherGrade, weatherOcean, type WeatherOceanLook } from "./weather-fx"

/** Thunder and ambience hooks (src/audio/weather-audio.ts implements them). */
export type WeatherSound = { update(w: Weather, dt: number): void; strike(s: Strike, delay: number): void }

/**
 * The client side of the weather: the room's override history, the weather-scaled sea (hand `sea` to the ocean and
 * the ship simulation), lightning, the rain pass, and the look mapping onto the atmosphere, grade and ocean look.
 *
 * Per frame: `update(dt, t)` before filling the Frame (it writes `atmosphere`, `grade` and the ocean look), then
 * `draw(dt, t, view, frame)` once the Frame is filled (rain needs its colours).
 */
export class WeatherSystem {
  /** The room's synced weather (the Net's, so overrides from the room apply). */
  room = new RoomWeather()
  readonly rain: Rain
  /** The weather on screen this frame. */
  readonly current: Weather = makeWeather()
  /** Lightning flash 0..1 this frame. */
  flash = 0
  /** The clouds' storm state (hand it to `Clouds.storm`): the overcast deck, darkness and lightning glow. */
  readonly clouds: CloudStorm = { cover: 0, dark: 0, flash: 0, bearing: 0, dist: 0 }
  private strike: Strike = { t: 0, power: 0, bearing: 0, dist: 0, seed: 0 }
  /** Local override from the weather lab (null: the room's weather). Never synced. */
  manual: Weather | null = null
  /** A local strike from the lab's STRIKE NOW (flash and thunder only). */
  forced: Strike | null = null
  sound: WeatherSound | null = null
  view: WeatherSea | null = null
  private wind: [number, number] = [1, 0]
  private manualOverride: WeatherOverride = { at: -1e12, fade: 0, from: makeWeather(), to: makeWeather() }
  private lastT: number | null = null
  private forcedHeard: Strike | null = null
  private atmosphereOut: ReturnType<typeof makeAtmosphere> | null = null
  private shownFlash = 0

  constructor(r: Renderer) {
    this.rain = new Rain(r)
    r.addPass("alpha", this.rain)
  }

  /** Call once the world is known. Returns the weather-scaled sea: give it to the ocean and the ship simulation. */
  setWorld(seed: number, sea: Sea): Sea {
    this.room.seed = seed
    this.view = makeWeatherSea(sea)
    this.wind = [sea.wind[0], sea.wind[1]]
    return this.view.sea
  }

  /** The override lightning and readouts should use (the lab's manual weather as a constant, or the room's). */
  override(t: number): WeatherOverride | null {
    if (!this.manual) return this.room.active(t)
    const o = this.manualOverride
    Object.assign(o.from, this.manual)
    Object.assign(o.to!, this.manual)
    return o
  }

  /**
   * Weather, sea and lightning at sea time t, written onto the look objects: `atmosphere` (from `baseAtmosphere`),
   * `grade` (from `baseGrade`) and an ocean look (from `baseOcean`) when given.
   */
  update(
    dt: number,
    t: number,
    look?: { baseAtmosphere: Atmosphere; atmosphere: Atmosphere; baseGrade: Grade; grade: Grade; baseOcean?: WeatherOceanLook; ocean?: WeatherOceanLook; daylight?: number },
  ): void {
    const w = this.manual ? Object.assign(this.current, this.manual) : this.room.at(t, this.current)
    this.view?.set(w)
    const seed = this.room.seed
    const o = this.override(t)
    let flash = lightningAt(seed, t, o, this.strike)
    if (this.forced) {
      const f = strikeFlash(this.forced, t - this.forced.t)
      if (f > flash) Object.assign(this.strike, this.forced)
      flash = Math.max(flash, f)
      if (t - this.forced.t > 2 || t < this.forced.t - 1) this.forced = null
    }
    this.flash = flash
    // The deck forms from medium cover up (light rain keeps broken cumulus, a little greyer).
    const u = Math.min(1, Math.max(0, (w.cloud - 0.35) / 0.6))
    this.clouds.cover = u * u * (3 - 2 * u)
    this.clouds.dark = w.dark
    // The night grade is lifted: the flash lights the rain and the clouds less, so a night strike is not a white sheet.
    const day = look?.daylight ?? 1
    this.shownFlash = flash * (0.15 + 0.85 * day)
    this.clouds.flash = flash * (0.04 + 0.96 * day)
    this.clouds.bearing = this.strike.bearing
    this.clouds.dist = this.strike.dist
    if (this.sound) {
      this.sound.update(w, dt)
      // New strikes since last frame start their thunder (skip big jumps: a paused or scrubbed clock).
      const last = this.lastT
      if (last !== null && t > last && t - last < 1) for (const s of strikesBetween(seed, last, t, o)) this.sound.strike(s, s.dist / 343)
      if (this.forced && this.forced !== this.forcedHeard) {
        this.forcedHeard = this.forced
        this.sound.strike(this.forced, this.forced.dist / 343)
      }
    }
    this.lastT = t
    if (look) {
      this.atmosphereOut ??= makeAtmosphere(look.baseAtmosphere)
      Object.assign(look.atmosphere, weatherAtmosphere(look.baseAtmosphere, w, flash, this.atmosphereOut, look.daylight))
      weatherGrade(look.baseGrade, w, flash, look.grade, look.daylight)
      if (look.baseOcean && look.ocean) weatherOcean(look.baseOcean, w, look.ocean, this.wind, look.daylight)
    }
  }

  /** Rain and splashes for this frame (after the Frame is filled). */
  draw(dt: number, t: number, view: RelView, frame: Float32Array, fov?: number): void {
    this.rain.update(dt, t, view, this.current, this.wind, this.view?.sea ?? null, frame, this.shownFlash, fov)
  }
}
