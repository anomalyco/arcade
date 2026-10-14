import { isClearWeather, type WeatherSettings } from "./settings"

export type WeatherLight = {
  x: number
  y: number
  z: number
  radius: number
  r: number
  g: number
  b: number
  power: number
  /** Plan unit direction X for spotlights/cones (default 0). */
  dx?: number
  /** Plan unit direction Z for spotlights/cones (default 0). */
  dz?: number
  /** Cosine of half-angle for spotlights/cones (default -1 = omnidirectional). */
  cosHalf?: number
  /** True when the light is a directional cone (flashlight / window / porch spot). */
  isCone?: boolean
}

/** Roof overhang eave segment: [x0, z0, x1, z1, eaveHeight]. */
export type WeatherEave = readonly [x0: number, z0: number, x1: number, z1: number, height: number]

/** Building interior AABB [x0, z0, x1, z1] where precipitation & ground splashes are masked out. */
export type WeatherExcludeRect = readonly [x0: number, z0: number, x1: number, z1: number]

export type WeatherStrike = {
  t: number
  power: number
  bearing: number
  dist: number
  seed: number
}

export const WEATHER_LIGHTNING_PER_MIN = 10
export const WEATHER_LIGHTNING_SLOT = 0.5
export const WEATHER_LIGHTNING_LIFE = 0.92

function hashSlot(seed: number, slot: number, salt: number): number {
  let h =
    Math.imul((seed ^ 0x3c6ef372) >>> 0, 0x9e3779b1) ^
    Math.imul(slot | 0, 0x85ebca6b) ^
    Math.imul(salt + 0x632be5ab, 0xc2b2ae35)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296
}

/** Multi-stroke lightning flash envelope 0..1 at `dt` seconds after strike onset. */
export function weatherStrikeFlash(strike: Readonly<WeatherStrike>, dt: number): number {
  if (dt < 0 || dt > WEATHER_LIGHTNING_LIFE) return 0
  const rise = Math.min(1, dt / 0.015)
  let f = rise * Math.exp(-dt / 0.065)
  const restrikes = 1 + (strike.seed % 3)
  for (let i = 0; i < restrikes; i++) {
    const at = 0.085 + 0.16 * i + 0.045 * (((strike.seed >> (4 + i * 3)) & 7) / 7)
    const d = dt - at
    if (d > 0) {
      f += (0.78 - 0.18 * i) * Math.min(1, d / 0.012) * Math.exp(-d / 0.052)
    }
  }
  return Math.min(1, f * strike.power * Math.min(1, (WEATHER_LIGHTNING_LIFE - dt) / 0.2))
}

const scratchStrike: WeatherStrike = { t: 0, power: 0, bearing: 0, dist: 0, seed: 0 }

/** Deterministic lightning flash 0..1 at simulation time `t` for `seed` and `lightningRate`. */
export function evaluateWeatherLightning(
  seed: number,
  t: number,
  lightningRate: number,
  outStrike?: WeatherStrike,
): number {
  if (lightningRate <= 0.001) return 0
  let best = 0
  const lastSlot = Math.floor(t / WEATHER_LIGHTNING_SLOT)
  const lookback = Math.ceil(WEATHER_LIGHTNING_LIFE / WEATHER_LIGHTNING_SLOT)
  const pSlot = ((lightningRate * WEATHER_LIGHTNING_PER_MIN) / 60) * WEATHER_LIGHTNING_SLOT
  for (let n = lastSlot - lookback; n <= lastSlot; n++) {
    if (hashSlot(seed, n, 7) >= pSlot) continue
    scratchStrike.t = (n + 0.1 + 0.8 * hashSlot(seed, n, 8)) * WEATHER_LIGHTNING_SLOT
    scratchStrike.power = 0.55 + 0.45 * hashSlot(seed, n, 9)
    scratchStrike.bearing = hashSlot(seed, n, 10) * Math.PI * 2
    scratchStrike.dist = 400 + 3500 * Math.pow(hashSlot(seed, n, 11), 1.5)
    scratchStrike.seed = Math.floor(hashSlot(seed, n, 12) * 0xffffff)
    const f = weatherStrikeFlash(scratchStrike, t - scratchStrike.t)
    if (f > best) {
      best = f
      if (outStrike) Object.assign(outStrike, scratchStrike)
    }
  }
  return best
}

/**
 * Coherent wind-gust multiplier [0.15..2.3] at `(x, z, time)` aligned with `windDirDeg`.
 */
export function evaluateWeatherGust(
  time: number,
  x: number,
  z: number,
  windDirDeg: number,
  windGust: number,
): number {
  const rad = (windDirDeg * Math.PI) / 180
  const wx = Math.cos(rad)
  const wz = Math.sin(rad)
  const cx = -wz
  const cz = wx
  const along = x * wx + z * wz
  const across = x * cx + z * cz
  const w1 = Math.sin(time * 1.35 - along * 0.16 + across * 0.08)
  const w2 = Math.sin(time * 2.45 - along * 0.29 - across * 0.21 + 1.7)
  const w3 = Math.cos(time * 0.68 - along * 0.07 + 0.9)
  const raw = 0.68 + (w1 * 0.45 + w2 * 0.30 + w3 * 0.32) * Math.max(0, windGust) * 0.65
  return Math.max(0.15, Math.min(2.3, raw))
}

/**
 * Per-frame weather output state that games and Lab sections feed to their scene shaders,
 * lighting uniforms, foliage wind, and `WeatherRenderer`.
 */
export type WeatherFrameState = {
  active: boolean
  time: number
  /** Current surface wetness 0..1 (darkens porous albedo, lowers roughness). */
  wetness: number
  /** Puddle coverage & mirror reflection strength 0..1.5. */
  puddleCoverage: number
  /** Raindrop concentric ring ripple intensity on puddles 0..1. */
  rippleIntensity: number
  /** Snow / frost surface accumulation 0..1. */
  snowAmount: number
  /** Low-lying mist & fog bank strength 0..1.5. */
  mist: number
  /** Lightning flash envelope 0..1 this frame. */
  flash: number
  /** Unit direction toward active lightning strike. */
  strikeDir: [number, number, number]
  /** Unit wind direction in XZ. */
  windX: number
  windZ: number
  /** Instantaneous wind speed in m/s (including active gust). */
  windSpeedMs: number
  /** Gust envelope multiplier at focus point. */
  gust: number
  /** Sky ambient multiplier (1 = clear, < 1 = overcast dimming). */
  skyScale: number
  /** Direct sun/moon multiplier (1 = clear, < 1 = overcast veiling). */
  sunScale: number
  /** Phase-integrated world-space drop drift (m). */
  driftX: number
  driftY: number
  driftZ: number
  /** Smoothed camera velocity (m/s) for streak motion-blur orientation. */
  camVelX: number
  camVelY: number
  camVelZ: number
}

export class WeatherSimulation {
  seed = 7
  private time = 0
  private driftX = 0
  private driftY = 0
  private driftZ = 0
  private lastEyeX = 0
  private lastEyeY = 0
  private lastEyeZ = 0
  private camVelX = 0
  private camVelY = 0
  private camVelZ = 0
  private hasEye = false
  private forcedStrike: WeatherStrike | null = null
  private activeStrike: WeatherStrike = { t: 0, power: 0, bearing: -0.8, dist: 900, seed: 1 }

  readonly state: WeatherFrameState = {
    active: false,
    time: 0,
    wetness: 0,
    puddleCoverage: 0,
    rippleIntensity: 0,
    snowAmount: 0,
    mist: 0,
    flash: 0,
    strikeDir: [-0.55, 0.45, -0.70],
    windX: 0.88,
    windZ: -0.47,
    windSpeedMs: 2.0,
    gust: 1.0,
    skyScale: 1.0,
    sunScale: 1.0,
    driftX: 0,
    driftY: 0,
    driftZ: 0,
    camVelX: 0,
    camVelY: 0,
    camVelZ: 0,
  }

  constructor(seed = 7) {
    this.seed = seed
  }

  reset(seed = this.seed): void {
    this.seed = seed
    this.time = 0
    this.driftX = 0
    this.driftY = 0
    this.driftZ = 0
    this.camVelX = 0
    this.camVelY = 0
    this.camVelZ = 0
    this.hasEye = false
    this.forcedStrike = null
  }

  /** Forces an immediate lightning strike at the current simulation time. */
  strikeNow(seedOverride?: number): WeatherStrike {
    const s = ((seedOverride ?? Math.floor((this.time * 997 + this.seed * 31) % 0xffffff)) >>> 0) || 1
    const bearing = -0.75 + ((s & 255) / 255 - 0.5) * 1.4
    this.forcedStrike = {
      t: this.time,
      power: 0.95,
      bearing,
      dist: 650,
      seed: s,
    }
    return { ...this.forcedStrike }
  }

  /**
   * Steps the continuous weather simulation by `dt` seconds and updates `this.state`.
   */
  step(
    dt: number,
    settings: Readonly<WeatherSettings>,
    eye: readonly [number, number, number] | Float32Array = [0, 10, 0],
    focusXZ?: readonly [number, number],
  ): WeatherFrameState {
    const clampedDt = Math.max(0, Math.min(dt, 0.1))
    this.time += clampedDt

    const ex = eye[0] ?? 0
    const ey = eye[1] ?? 10
    const ez = eye[2] ?? 0
    if (this.hasEye && clampedDt > 1e-4) {
      const alpha = 1 - Math.exp(-clampedDt / 0.12)
      const vx = (ex - this.lastEyeX) / clampedDt
      const vy = (ey - this.lastEyeY) / clampedDt
      const vz = (ez - this.lastEyeZ) / clampedDt
      this.camVelX = Math.abs(vx) > 80 ? 0 : this.camVelX + (vx - this.camVelX) * alpha
      this.camVelY = Math.abs(vy) > 80 ? 0 : this.camVelY + (vy - this.camVelY) * alpha
      this.camVelZ = Math.abs(vz) > 80 ? 0 : this.camVelZ + (vz - this.camVelZ) * alpha
    } else if (!this.hasEye) {
      this.camVelX = 0
      this.camVelY = 0
      this.camVelZ = 0
    }
    this.hasEye = true
    this.lastEyeX = ex
    this.lastEyeY = ey
    this.lastEyeZ = ez

    const rad = (settings.windDir * Math.PI) / 180
    const wx = Math.cos(rad)
    const wz = Math.sin(rad)
    const fx = focusXZ ? focusXZ[0] : ex
    const fz = focusXZ ? focusXZ[1] : ez
    const gust = evaluateWeatherGust(this.time, fx, fz, settings.windDir, settings.windGust)
    const windSpeedMs = settings.windSpeed * (0.65 + 0.35 * gust)
    const fallSpeed = settings.snowMode ? Math.min(settings.dropSpeed, 4.2) : settings.dropSpeed

    // Carry 62% of horizontal wind into falling drops; integrate continuously so slider edits never jump phase.
    const dropCarry = settings.snowMode ? 0.78 : 0.58
    const vxDrop = wx * windSpeedMs * dropCarry
    const vzDrop = wz * windSpeedMs * dropCarry
    this.driftX = (this.driftX + vxDrop * clampedDt) % 10000
    this.driftY = (this.driftY - fallSpeed * clampedDt) % 10000
    this.driftZ = (this.driftZ + vzDrop * clampedDt) % 10000

    // Evaluate seeded + manual lightning flash
    let flash = evaluateWeatherLightning(this.seed, this.time, settings.lightningRate, this.activeStrike)
    if (this.forcedStrike) {
      const f = weatherStrikeFlash(this.forcedStrike, this.time - this.forcedStrike.t)
      if (f > flash) {
        flash = f
        Object.assign(this.activeStrike, this.forcedStrike)
      }
      if (this.time - this.forcedStrike.t > WEATHER_LIGHTNING_LIFE + 0.1) {
        this.forcedStrike = null
      }
    }

    const active = !isClearWeather(settings) || flash > 0.001
    const effWetness = Math.max(0, Math.min(1, settings.wetness))
    const effPuddles = Math.max(0, Math.min(1.5, settings.puddleCoverage))
    const rainActive = settings.snowMode ? 0 : Math.max(0, Math.min(1, settings.intensity * Math.min(1.5, settings.density)))
    const rippleIntensity = Math.min(1, rainActive * Math.max(0.35, settings.splashRate * 0.75) * (0.35 + 0.65 * effWetness))
    const snowAmount = settings.snowMode ? Math.max(0, Math.min(1, settings.intensity * 0.92)) : 0
    const overcast = Math.max(0, Math.min(1, settings.intensity * 0.75 + settings.mist * 0.25))

    const st = this.state
    st.active = active
    st.time = this.time
    st.wetness = effWetness
    st.puddleCoverage = effPuddles
    st.rippleIntensity = rippleIntensity
    st.snowAmount = snowAmount
    st.mist = Math.max(0, settings.mist)
    st.flash = flash
    st.strikeDir[0] = Math.sin(this.activeStrike.bearing) * 0.8
    st.strikeDir[1] = 0.58
    st.strikeDir[2] = -Math.cos(this.activeStrike.bearing) * 0.8
    st.windX = wx
    st.windZ = wz
    st.windSpeedMs = windSpeedMs
    st.gust = gust
    st.skyScale = Math.max(0.45, 1 - overcast * 0.32) + flash * 1.45
    st.sunScale = Math.max(0.12, 1 - overcast * 0.78) + flash * 1.85
    st.driftX = this.driftX
    st.driftY = this.driftY
    st.driftZ = this.driftZ
    st.camVelX = this.camVelX
    st.camVelY = this.camVelY
    st.camVelZ = this.camVelZ
    return st
  }
}
