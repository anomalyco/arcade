/**
 * A storm over the night forest: kit weather's lightning (`weather/lightning.ts`, the stroke timing, channel and WCAG
 * flash limiter) scheduled by `StormStrikes`, rain through the kit weather layer in its light-volume mode (drops show
 * only inside a beam, a lit window or a flash), the eye's flash-then-darker adaptation (`weather/exposure.ts`) and gusts
 * that the trees, the rain and the game's wind sound share. The game steps it once a frame and hands `frame.view` to
 * `ForestView.frame` (`storm`); thunder comes back as events for the game's own positional sound.
 */
import type { LabControl } from "../lab-navigation"
import { EXPOSURE_DEFAULTS, EyeAdaptation, exposureControls, type ExposureSettings } from "../weather/exposure"
import type { Strike, StrikeLight, Vec3 } from "../weather/lightning"
import { RAIN_LIGHTING_DEFAULTS, rainLightingControls, type RainLightingSettings } from "../weather/rain-lighting"
import { weatherDefaults, type WeatherSettings } from "../weather/settings"
import { WeatherSimulation, type WeatherFrameState } from "../weather/state"
import { StormStrikes, type SharedStormClock, type StormFlashes, type StrikeRequest, type ThunderEvent } from "../weather/storm"
import { FOREST_WIND_DIR } from "./wind"

export type ForestStormSettings = {
  // Rain
  /** Rain intensity 0..1 (0 = dry). */
  rain: number
  /** Drops per volume (×). */
  rainDensity: number
  /** Fall speed (m/s). */
  rainSpeed: number
  /** Bark, litter and boards darken and gloss up 0..1. */
  wetness: number
  /** Standing water in the trail's ruts and the hollows 0..1. */
  puddles: number
  /** Drops falling from the lowest branches and the cabin eaves near you (×). */
  drips: number
  /** How brightly drops catch a beam or lamp (×). */
  rainGlow: number
  // Lightning
  /** Strikes a minute. */
  strikes: number
  /** Ground strikes land between these distances (m). */
  strikeNear: number
  strikeFar: number
  /** Share of cloud-to-cloud strikes. */
  strikeCloud: number
  flashes: StormFlashes
  /** Illuminance a strike at full scene light puts on the forest (lux, scene units). */
  flashLux: number
  /** Cloud base luminance at full scene light (cd/m², scene units). */
  flashSky: number
  /** How brightly the mist and rain glow in a flash (×). */
  flashMist: number
  /** Channel brightness (×). */
  boltBrightness: number
  /** Overcast cloud base lit from below by distant towns (cd/m², scene units; 0 = the clear sky). */
  cloudGlow: number
  // Wind
  /** Storm wind on top of the forest's own (×): trees, rain slant and the wind sound. */
  stormWind: number
  /** A gust's peak (× wind) and length (s). */
  gustPeak: number
  gustLength: number
}

export const FOREST_STORM_DEFAULTS: Readonly<ForestStormSettings> = {
  rain: 0, rainDensity: 1, rainSpeed: 9, wetness: 0, puddles: 0, drips: 1, rainGlow: 1,
  strikes: 0, strikeNear: 300, strikeFar: 4000, strikeCloud: 0.25, flashes: "full", flashLux: 0.9, flashSky: 0.1, flashMist: 1, boltBrightness: 1,
  cloudGlow: 0,
  stormWind: 1, gustPeak: 2.2, gustLength: 6,
}

/** Rain in the forest: light-volume mode, short camera-relative streaks (the weather agent's defaults). */
export const FOREST_RAIN_LIGHTING: Readonly<RainLightingSettings> = { ...RAIN_LIGHTING_DEFAULTS, mode: "volume" }
/** The eye after a flash: up to two stops darker, recovering over ~3 s; the forest's own meter holds meanwhile. */
export const FOREST_EYE: Readonly<ExposureSettings> = { ...EXPOSURE_DEFAULTS, mode: "adapt", attack: 0.25, recovery: 3, lossEV: 1.6, glareStrength: 0.25 }

/** What `ForestView.frame` needs from the storm this frame (`ForestFrameInput.storm`). */
export type ForestStormView = {
  /** The channel to draw (or none) and its brightness. */
  bolt: Strike | null
  light: StrikeLight
  /** Channel brightness (×). */
  boltBrightness: number
  /** Illuminance on the forest from the strike (lux, scene units) and the unit direction toward it. */
  flash: number
  flashDir: Vec3
  /** Cloud base luminance from the flash and the overcast's own glow (scene units). */
  flashSky: number
  cloudGlow: number
  /** Mist glow from the flash (scene units). */
  flashMist: number
  /** Eye adaptation multiplier on the final exposure and the bolt's glare 0..1. */
  exposure: number
  glare: number
  /** The forest's own auto exposure waits while a flash is in the meter. */
  holdExposure: boolean
  wetness: number
  puddles: number
  /** Rain for the kit weather layer, or null when dry. */
  rain: { settings: WeatherSettings; state: WeatherFrameState; lighting: RainLightingSettings; drips: number; glow: number } | null
  /** Wind multiplier on the forest's sway this frame (storm wind × the gust now). */
  wind: number
}

export type ForestStormFrame = {
  view: ForestStormView
  /** Thunder emitted this frame: schedule each once (`arrives` is on `clock`). */
  thunder: readonly ThunderEvent[]
  clock: number
  /** Gust envelope 0..1 now (a triggered gust), and the wind multiplier the sound should follow. */
  gust: number
  wind: number
  /** Rain intensity actually falling 0..1 (eased). */
  rain: number
}

export type ForestStormInput = {
  dt: number
  eye: readonly number[]
  /** View yaw (rad, 0 looks along −z): strikes asked for land in view. */
  yaw: number
  /** Ground height under the eye. */
  groundY: number
  /** The forest look's wind (×): the rain slants with the trees. */
  forestWind: number
  /** A room's shared clock and anchor: scheduled strikes then match on every client (`SharedStormClock`). */
  shared?: SharedStormClock
}

const ease = (dt: number, tau: number) => 1 - Math.exp(-dt / tau)

export class ForestStorm {
  readonly settings: ForestStormSettings
  readonly eye: ExposureSettings = { ...FOREST_EYE }
  readonly rainLighting: RainLightingSettings = { ...FOREST_RAIN_LIGHTING }
  readonly strikes: StormStrikes
  private readonly sim: WeatherSimulation
  private readonly adapt = new EyeAdaptation()
  private readonly weather: WeatherSettings = { ...weatherDefaults }
  private rain = 0
  private wet = 0
  private puddles = 0
  private gustAt = -1e9
  private holdUntil = 0
  private asked = 0
  private lastFrame: ForestStormFrame | null = null

  constructor(settings: Partial<ForestStormSettings> = {}, seed = 7) {
    this.settings = { ...FOREST_STORM_DEFAULTS, ...settings }
    this.strikes = new StormStrikes(seed)
    this.sim = new WeatherSimulation(seed)
  }

  /** A strike on the next frame: `near`, `mid` or `far` place it in view at those distances, or give a full request. */
  strike(at: "near" | "mid" | "far" | StrikeRequest = "mid"): void {
    if (typeof at !== "string") { this.strikes.request(at); return }
    const n = ++this.asked, u = (Math.sin(n * 12.9898) * 43758.5453) % 1
    const distance = { near: 320 + 120 * Math.abs(u), mid: 900 + 500 * Math.abs(u), far: 2600 + 1800 * Math.abs(u) }[at]
    this.strikes.request({ kind: "ground", distance, power: at === "far" ? 0.5 : at === "mid" ? 0.8 : 1 })
  }

  /** Thunder from a strike you don't see: behind the hills, `distance` m off (default 1.2–2 km). */
  thunder(distance?: number): void {
    const n = ++this.asked, u = Math.abs((Math.sin(n * 78.233) * 43758.5453) % 1)
    this.strikes.request({ kind: "ground", distance: distance ?? 1200 + 800 * u, bearing: u * Math.PI * 2, power: 0.8, dark: true })
  }

  /** A gust front through the trees now. */
  gust(): void { this.gustAt = this.strikes.clock }

  get last(): ForestStormFrame | null { return this.lastFrame }

  /** Snap the eased rain and wet surfaces to the settings (a cut, or automation comparing still frames). */
  settle(): void {
    this.rain = this.settings.rain
    this.wet = this.settings.wetness
    this.puddles = this.settings.puddles
    this.adapt.reset()
    this.holdUntil = 0
  }

  frame(i: ForestStormInput): ForestStormFrame {
    const s = this.settings, dt = Math.max(0, Math.min(0.1, i.dt))
    const bearing = -i.yaw
    const strikes = this.strikes.step(dt, { rate: s.strikes, cloud: s.strikeCloud, near: s.strikeNear, far: s.strikeFar, flashes: s.flashes }, i.eye, bearing, i.groundY, i.shared)
    const t = strikes.time

    // Rain arrives over a couple of seconds; the forest soaks more slowly and dries slower still.
    this.rain += (s.rain - this.rain) * ease(dt, 2)
    this.wet += (s.wetness - this.wet) * ease(dt, s.wetness > this.wet ? 4 : 20)
    this.puddles += (s.puddles - this.puddles) * ease(dt, s.puddles > this.puddles ? 8 : 30)

    // A gust: a rise, a hold and a long fall, shared by the sway, the rain slant and the wind sound.
    const g = t - this.gustAt, L = Math.max(1, s.gustLength)
    const gust = g < 0 || g > L ? 0 : g < 1.2 ? (g / 1.2) ** 2 : Math.exp(-(((g - 1.2) / (L * 0.35)) ** 2))
    const wind = s.stormWind * (1 + (s.gustPeak - 1) * gust)

    // Flash: the eye takes it (and darkens for a few seconds after), the forest's meter waits until it has passed.
    const flash = strikes.scene
    if (flash > 0.002) this.holdUntil = t + 0.4
    const adapted = this.adapt.step({ dt, luminance: 1 + flash * 40, referenceLuminance: 1, glare: Math.min(1, flash * (strikes.bolt ? 1.2 : 0.6)) }, this.eye)

    let rain: ForestStormView["rain"] = null
    if (this.rain > 0.004) {
      const w = this.weather
      const [dx, dz] = FOREST_WIND_DIR
      Object.assign(w, {
        preset: "rain", intensity: Math.min(1, this.rain), density: s.rainDensity * (0.35 + 0.65 * this.rain) * 1.6, dropSize: 0.9, dropLength: 1.1,
        dropSpeed: s.rainSpeed, litOnly: 1, splashRate: 0.8 + 1.2 * this.rain, wetness: this.wet, puddleCoverage: this.puddles,
        windSpeed: 1.5 + 3.5 * i.forestWind * wind, windDir: (Math.atan2(dz, dx) * 180) / Math.PI, windGust: 0.4 + 0.6 * gust, mist: 0, lightningRate: 0, snowMode: false,
      } satisfies Partial<WeatherSettings>)
      const state = this.sim.step(dt, w, [i.eye[0]!, i.eye[1]!, i.eye[2]!])
      rain = { settings: w, state: { ...state, flash: Math.min(1, flash) }, lighting: this.rainLighting, drips: s.drips, glow: s.rainGlow }
    }

    const view: ForestStormView = {
      bolt: strikes.bolt, light: strikes.light, boltBrightness: s.boltBrightness,
      flash: flash * s.flashLux, flashDir: strikes.dir, flashSky: flash * s.flashSky, cloudGlow: s.cloudGlow, flashMist: flash * s.flashSky * 0.04 * s.flashMist,
      exposure: adapted.multiplier, glare: adapted.glare, holdExposure: t < this.holdUntil,
      wetness: this.wet, puddles: this.puddles, rain, wind,
    }
    this.lastFrame = { view, thunder: strikes.thunder, clock: t, gust, wind, rain: this.rain }
    return this.lastFrame
  }
}

/** Typed LabPanel rows for the storm (keys `prefix + field`), grouped and sub-headed under `group`. */
export function forestStormControls(group = "Weather", prefix = "woods.storm."): LabControl[] {
  const range = (k: keyof ForestStormSettings, label: string, min: number, max: number, step: number, unit: string, subsection: string): LabControl =>
    ({ key: prefix + k, field: k, label, group, subsection, min, max, step, unit })
  return [
    range("rain", "Rain", 0, 1, 0.01, "", "Rain"),
    range("rainDensity", "Drop density", 0, 3, 0.05, "×", "Rain"),
    range("rainSpeed", "Fall speed", 3, 14, 0.1, "m/s", "Rain"),
    range("drips", "Drips from branches and eaves", 0, 3, 0.05, "×", "Rain"),
    range("rainGlow", "Drops in the beams", 0, 4, 0.05, "×", "Rain"),
    range("wetness", "Wet bark and ground", 0, 1, 0.01, "", "Wet surfaces"),
    range("puddles", "Standing water", 0, 1, 0.01, "", "Wet surfaces"),
    range("strikes", "Strikes", 0, 12, 0.1, "/min", "Lightning"),
    { ...range("strikeNear", "Nearest strike", 120, 3000, 10, "m", "Lightning"), pair: { key: prefix + "strikeFar", label: "Strike distance" } },
    range("strikeFar", "Farthest strike", 200, 8000, 50, "m", "Lightning"),
    range("strikeCloud", "Cloud to cloud", 0, 1, 0.05, "share", "Lightning"),
    { key: prefix + "flashes", field: "flashes", label: "Lightning flashes", group, subsection: "Lightning", type: "select", options: [{ value: "full", label: "Full" }, { value: "reduced", label: "Reduced" }, { value: "off", label: "Off (thunder only)" }] },
    range("flashLux", "Flash on the forest", 0, 8, 0.05, "lx", "Flash"),
    range("flashSky", "Flash on the clouds", 0, 2, 0.01, "cd/m²", "Flash"),
    range("flashMist", "Flash in the mist", 0, 3, 0.05, "×", "Flash"),
    range("boltBrightness", "Channel brightness", 0, 3, 0.05, "×", "Flash"),
    range("cloudGlow", "Overcast glow", 0, 0.004, 0.0001, "cd/m²", "Sky"),
    range("stormWind", "Storm wind", 0, 4, 0.05, "×", "Wind"),
    range("gustPeak", "Gust peak", 1, 4, 0.05, "× wind", "Wind"),
    range("gustLength", "Gust length", 2, 15, 0.5, "s", "Wind"),
  ]
}

/** The eye's flash adaptation and the rain's light-volume look, as the weather agent's own rows. */
export function forestStormEyeControls(group = "Weather", prefix = "woods.eye."): LabControl[] {
  return exposureControls(group, prefix)
}
export function forestRainLightControls(group = "Weather", prefix = "woods.rainLight."): LabControl[] {
  return rainLightingControls(group, prefix).map(c => ({ ...c, subsection: "Rain" }))
}
