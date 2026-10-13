import { DAY_CYCLE, MOON_PEAK, RoomTime, SUN_PEAK, celestial, elevation, phaseOfHour, skyAt, type Sky } from "../../shared/daycycle"
import type { Atmosphere } from "./atmosphere"
import { FRAME } from "./frame"
import type { Lights } from "./lights"
import type { RelView } from "./ocean-view"
import type { OceanLook } from "./ocean"
import type { Grade } from "./post"
import type { Stars } from "./stars"

type Vec3 = [number, number, number]

/**
 * Time-of-day look (concept/README-time.md, concept/time-*.png): palettes keyed on the true sun elevation, one row of
 * keys for the evening and one for the morning (dawn is cooler and pinker than dusk). The day key is the live sunny
 * base (`atmosphere`, `grade`, ocean look), so between about 08:00 and 16:00 the look is exactly the sunny concept.
 *
 * Colours are linear HDR. `horizon` is the Frame's horizon (the fog colour); the sky paints its low band as horizon ×
 * (0.74, 1.1, 1.55), so warm horizons are given redder than they read. `sun` is the sun colour, which also scales the
 * disc and its glow; `sunI` the light's intensity. Grade and ocean values are factors on the base (warmth and bloom
 * are added). Live-tunable: `carrier.daynight.palette`.
 */
export type DayKey = {
  /** True sun elevation, degrees. */
  e: number
  /** The live base (day) look. Other fields are ignored. */
  base?: true
  zenith?: Vec3
  horizon?: Vec3
  sun?: Vec3
  sunI?: number
  ambient?: number
  exposure?: number
  saturation?: number
  warmth?: number
  bloom?: number
  /** Ocean: sky light on the water body, deep colour tint, glitter, foam colour. */
  bodySky?: number
  deep?: Vec3
  glitter?: number
  foam?: Vec3
  /** Light reaching the seabed (reef shallows stay readable under the moon). */
  bed?: number
  /** Crest subsurface colour tint (no green glow under a violet dusk). */
  scatter?: Vec3
}

const DAY: DayKey = { e: 25, base: true }
const NIGHT: DayKey = {
  e: -15,
  zenith: [0.006, 0.012, 0.048],
  horizon: [0.032, 0.046, 0.085],
  sun: [0, 0, 0],
  sunI: 0,
  ambient: 2.0,
  exposure: 1.85,
  saturation: 0.78,
  warmth: -0.25,
  bloom: 0.14,
  bodySky: 3.4,
  deep: [0.85, 1.15, 1.15],
  scatter: [0.5, 0.7, 1.1],
  glitter: 8,
  foam: [0.78, 0.9, 1.05],
  bed: 2.6,
}

export const DAYNIGHT_PALETTE: { evening: DayKey[]; morning: DayKey[] } = {
  evening: [
    NIGHT,
    {
      e: -9,
      zenith: [0.012, 0.014, 0.06],
      horizon: [0.09, 0.05, 0.1],
      sun: [0, 0, 0],
      sunI: 0,
      ambient: 1.9,
      exposure: 1.7,
      saturation: 0.9,
      warmth: -0.15,
      bloom: 0.1,
      bodySky: 3,
      deep: [1.0, 0.9, 1.3],
      scatter: [0.6, 0.6, 1.1],
      glitter: 6,
      foam: [0.82, 0.86, 1.0],
      bed: 2.2,
    },
    {
      e: -4,
      zenith: [0.035, 0.016, 0.13],
      horizon: [0.42, 0.08, 0.07],
      sun: [0.6, 0.18, 0.12],
      sunI: 0,
      ambient: 1.0,
      exposure: 1.3,
      saturation: 1.05,
      warmth: -0.05,
      bloom: 0.06,
      bodySky: 2.2,
      deep: [1.2, 0.55, 1.5],
      scatter: [1.0, 0.4, 1.2],
      glitter: 1,
      foam: [0.95, 0.8, 0.95],
    },
    {
      e: 0.5,
      zenith: [0.09, 0.025, 0.26],
      horizon: [0.95, 0.2, 0.07],
      sun: [1.0, 0.36, 0.12],
      sunI: 1.5,
      ambient: 0.45,
      exposure: 1.0,
      saturation: 1.12,
      warmth: 0.12,
      bloom: 0.04,
      bodySky: 1.5,
      deep: [1.3, 0.6, 1.8],
      scatter: [1.6, 0.45, 0.9],
      glitter: 1.6,
      foam: [1.0, 0.82, 0.78],
    },
    {
      e: 8,
      zenith: [0.03, 0.12, 0.62],
      horizon: [1.0, 0.5, 0.13],
      sun: [1.0, 0.58, 0.24],
      sunI: 2.5,
      ambient: 0.42,
      exposure: 0.95,
      saturation: 1.2,
      warmth: 0.2,
      bloom: 0.02,
      bodySky: 0.95,
      deep: [1.0, 0.95, 0.9],
      scatter: [1.3, 0.9, 0.7],
      glitter: 3,
      foam: [1.0, 0.9, 0.78],
    },
    DAY,
  ],
  morning: [
    NIGHT,
    {
      e: -9,
      zenith: [0.016, 0.022, 0.075],
      horizon: [0.12, 0.07, 0.11],
      sun: [0, 0, 0],
      sunI: 0,
      ambient: 1.6,
      exposure: 1.5,
      saturation: 1.0,
      warmth: -0.2,
      bloom: 0.1,
      bodySky: 3,
      deep: [0.95, 1.0, 1.25],
      scatter: [0.6, 0.7, 1.1],
      glitter: 6,
      foam: [0.85, 0.85, 1.0],
      bed: 2.2,
    },
    {
      e: -3,
      zenith: [0.04, 0.08, 0.32],
      horizon: [0.7, 0.26, 0.3],
      sun: [0.9, 0.45, 0.32],
      sunI: 0,
      ambient: 0.6,
      exposure: 1.1,
      saturation: 1.18,
      warmth: -0.08,
      bloom: 0.05,
      bodySky: 1.8,
      deep: [1.1, 0.9, 1.2],
      scatter: [0.9, 0.7, 1.1],
      glitter: 1,
      foam: [1.0, 0.88, 0.92],
    },
    {
      e: 1.5,
      zenith: [0.05, 0.12, 0.42],
      horizon: [0.95, 0.42, 0.24],
      sun: [1.0, 0.58, 0.4],
      sunI: 1.3,
      ambient: 0.55,
      exposure: 1.05,
      saturation: 1.05,
      warmth: 0.05,
      bloom: 0.03,
      bodySky: 1.2,
      deep: [1.15, 0.9, 1.05],
      scatter: [1.1, 0.8, 0.9],
      glitter: 1.4,
      foam: [1.0, 0.9, 0.86],
    },
    {
      e: 8,
      zenith: [0.04, 0.15, 0.58],
      horizon: [0.85, 0.55, 0.32],
      sun: [1.0, 0.76, 0.55],
      sunI: 2.6,
      ambient: 0.55,
      exposure: 1.0,
      saturation: 1.03,
      warmth: 0.08,
      bloom: 0.02,
      bodySky: 0.95,
      deep: [1.05, 0.97, 1.0],
      glitter: 1.2,
      foam: [1.0, 0.95, 0.9],
    },
    DAY,
  ],
}

/** The moon as a light: colour and size of its disc and glow, and the intensity on the scene. */
export const MOON = {
  color: [0.55, 0.7, 1.0] as Vec3,
  /** Scales the sky's disc, halo and horizon glow toward the moon (the sky multiplies the sun colour as is). */
  glow: 0.085,
  /** Light on the scene at full moon: glow × intensity ≈ 0.15. */
  intensity: 1.8,
  /** Sun elevations (degrees) over which the moon takes over as the key light (below the first: none yet). */
  takeover: [-8, -14] as readonly [number, number],
}

/**
 * The look bends the true sky for the concepts: the painted disc (and its glitter path on the sea) sits low, and the
 * light is softer than a real tropical noon. Elevations above the horizon are compressed as top · (e / peak)^k, so the
 * noon sun lands exactly on the sunny base's light and disc elevations (34° and 7.5°): noon in clear weather is the
 * sunny concept look, unchanged. The disc's k < 1 keeps it near the horizon from golden hour on.
 */
export const DAYNIGHT_SKY = {
  /** Compression exponents for the light and the painted discs. */
  light: 0.8,
  view: 0.6,
  /** The moon at the top of its path: light and painted disc elevations. */
  moonLight: 33,
  moonView: 11,
  /** Lowest elevation (degrees) the light comes from while it is up, so vertical faces still catch a setting sun. */
  minLight: 1.5,
  /** The painted sun disc sits up to this many degrees above the true sun near the horizon, so it sinks into the sea in
   *  the sunset palette. */
  sunLead: 1.2,
}

const DEG = Math.PI / 180

/** Same azimuth; elevation above the horizon compressed so `peak` maps to `top`, at least `min` degrees. */
function bend(d: readonly number[], k: number, peak: number, top: number, out: Vec3, min = -90, lead = 0): Vec3 {
  const e = elevation(d)
  const el = e + lead * smooth(10, 0, e)
  const eb = Math.max(min, el > 0 ? top * Math.min(1.2, el / peak) ** k : el) * DEG
  const h = Math.hypot(d[0]!, d[2]!) || 1
  out[0] = (d[0]! / h) * Math.cos(eb)
  out[1] = Math.sin(eb)
  out[2] = (d[2]! / h) * Math.cos(eb)
  return out
}

const smooth = (a: number, b: number, x: number) => {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return u * u * (3 - 2 * u)
}
const lerp = (a: number, b: number, u: number) => a + (b - a) * u

type Resolved = Required<Omit<DayKey, "base">>

export type DayBases = { atmosphere: Atmosphere; grade: Grade; ocean: OceanLook }

/** Per-frame outputs other passes read (and the Frame's `extra`). */
export type DayState = {
  /** 0 day .. 1 full night (stars, night foam, cloud dimming). */
  night: number
  /** 0..1: warm twilight (sunrise, sunset, dusk, dawn), when the sky's blue tints relax. */
  dusk: number
  /** 0..1: practical lights (deck, nav, windows); the weather can raise it. */
  lights: number
  /** 0..1: how much the moon is the key light. */
  moonKey: number
  /**
   * Sky brightness against the day (luminance of the horizon over the base's, 0..1): the weather scales its overcast
   * sky colours by it, so a storm at night is dark, not daylight grey.
   */
  daylight: number
}

/**
 * The client side of the day-night cycle: the room's synced clock (`room`, like the weather's), a local manual clock
 * for the TIME tab, and the look for this moment written onto copies of the sunny bases (hand `atmosphere`, `grade`
 * and `ocean` to the weather as its bases). Also the sky geometry the star, moon and light passes draw from.
 */
export class DayNight {
  /** The room's synced clock (the Net's, so overrides from the room apply). */
  room = new RoomTime()
  /** Local manual phase from the TIME tab (null: the room's). Never synced. */
  manual: number | null = null
  /** Manual clock speed (× normal; 0 = frozen). */
  manualSpeed = 0
  palette = DAYNIGHT_PALETTE
  readonly sky: Sky = skyAt(0, 0)
  phase = 0
  /** Shown look: the bases with the time of day applied. */
  readonly atmosphere: Atmosphere & { sunDir: Vec3; sunView: Vec3; sunColor: Vec3; zenith: Vec3; horizon: Vec3 }
  readonly grade: Grade
  readonly ocean: OceanLook
  readonly state: DayState = { night: 0, dusk: 0, lights: 0, moonKey: 0, daylight: 1 }
  /** True sun elevation (degrees). */
  sunElevation = 0
  /** Where the sky's painted sun and moon discs sit (unit vectors), and the sun's light direction. */
  readonly sunView: Vec3 = [0, 0, 1]
  readonly moonView: Vec3 = [0, 0, 1]
  readonly sunLight: Vec3 = [0, 1, 0]
  readonly moonLight: Vec3 = [0, 1, 0]
  /** Where the sun lies as seen from the painted moon (lights its phase): behind the viewer, off by the moon's gap. */
  readonly moonPhaseSun: Vec3 = [0, 0, 1]
  /** Column-major rotation of the star field (celestial → world). */
  readonly stars: number[] = new Array(9).fill(0)
  private key: Resolved = blank()
  private ka: Resolved = blank()
  private kb: Resolved = blank()

  constructor(bases: DayBases) {
    const a = bases.atmosphere
    this.atmosphere = {
      ...a,
      sunDir: [...a.sunDir],
      sunView: [...(a.sunView ?? a.sunDir)],
      sunColor: [...a.sunColor],
      zenith: [...a.zenith],
      horizon: [...a.horizon],
    }
    this.grade = { ...bases.grade }
    this.ocean = { ...bases.ocean, deep: [...bases.ocean.deep], scatter: [...bases.ocean.scatter], foam: [...bases.ocean.foam] }
  }

  /** Sets the room's seed (call once the world is known). */
  setWorld(seed: number): void {
    this.room.seed = seed
  }

  /** The phase shown at sea time t (the TIME tab's manual clock, or the room's). */
  phaseAt(t: number): number {
    return this.manual ?? this.room.phase(t)
  }

  /** Local manual clock: show clock hour h (keeping the current day), running at `speed` × normal. */
  setManual(hour: number | null, speed = 0): void {
    if (hour === null) {
      this.manual = null
      return
    }
    this.manual = Math.floor(this.phase) + phaseOfHour(hour)
    this.manualSpeed = speed
  }

  /**
   * The look at sea time t from the sunny bases: writes `atmosphere`, `grade`, `ocean` (the weather's bases) and the
   * sky geometry. `look` is the live ocean look: the fields the weather never writes (body sky light, foam colour) go
   * straight onto it.
   */
  update(dt: number, t: number, bases: DayBases, look?: OceanLook): void {
    if (this.manual !== null) this.manual += (dt * this.manualSpeed) / DAY_CYCLE
    this.phase = this.phaseAt(t)
    const sky = skyAt(this.room.seed, this.phase, this.sky)
    const e = (this.sunElevation = elevation(sky.sun))
    celestial(sky.starAngle, undefined, this.stars)
    const B = DAYNIGHT_SKY
    const base = bases.atmosphere
    bend(sky.sun, B.view, SUN_PEAK, elevation(base.sunView ?? base.sunDir), this.sunView, -90, B.sunLead)
    bend(sky.moon, B.view, MOON_PEAK, B.moonView, this.moonView)
    bend(sky.sun, B.light, SUN_PEAK, elevation(base.sunDir), this.sunLight, B.minLight)
    bend(sky.moon, B.light, MOON_PEAK, B.moonLight, this.moonLight, B.minLight)
    phaseLight(this.moonView, this.sunView, Math.acos(Math.min(1, Math.max(-1, 2 * sky.moonLit - 1))), this.moonPhaseSun)

    // Palette: the two keys around the sun's elevation on this side of noon.
    const keys = sky.hour < 12 ? this.palette.morning : this.palette.evening
    let i = 0
    while (i < keys.length - 2 && e > keys[i + 1]!.e) i++
    const a = keys[i]!
    const b = keys[i + 1]!
    const u = smooth(a.e, b.e, e)
    resolve(a, bases, this.ka)
    resolve(b, bases, this.kb)
    mixKey(this.ka, this.kb, u, this.key)
    const k = this.key

    // Key light: the sun, until the sun is well down and the moon (if up) takes over.
    const moonUp = smooth(-2, 8, elevation(sky.moon))
    const moonKey = smooth(MOON.takeover[0], MOON.takeover[1], e) * moonUp
    const out = this.atmosphere
    const useMoon = e < MOON.takeover[0] && moonUp > 0
    const lit = 0.35 + 0.65 * sky.moonLit
    if (useMoon) {
      out.sunDir = copy3(this.moonLight, out.sunDir)
      out.sunView = copy3(this.moonView, out.sunView)
      for (let c = 0; c < 3; c++) out.sunColor[c] = k.sun[c]! + MOON.color[c]! * MOON.glow * moonKey
      out.sunIntensity = MOON.intensity * lit
    } else {
      out.sunDir = copy3(this.sunLight, out.sunDir)
      out.sunView = copy3(this.sunView, out.sunView)
      copy3(k.sun, out.sunColor)
      out.sunIntensity = k.sunI
    }
    copy3(k.zenith, out.zenith)
    copy3(k.horizon, out.horizon)
    out.ambient = k.ambient
    out.fog = bases.atmosphere.fog
    out.overcast = bases.atmosphere.overcast

    const g = bases.grade
    this.grade.exposure = g.exposure * k.exposure
    this.grade.saturation = g.saturation * k.saturation
    this.grade.warmth = Math.max(0, g.warmth + k.warmth)
    this.grade.bloom = g.bloom + k.bloom
    this.grade.threshold = g.threshold
    this.grade.vignette = g.vignette
    this.grade.grain = g.grain

    const a0 = bases.atmosphere
    const o = bases.ocean
    const { deep, scatter, foam } = this.ocean
    Object.assign(this.ocean, o)
    this.ocean.deep = deep
    this.ocean.scatter = scatter
    this.ocean.foam = foam
    for (let c = 0; c < 3; c++) {
      deep[c] = o.deep[c]! * k.deep[c]!
      scatter[c] = o.scatter[c]! * k.scatter[c]!
      foam[c] = o.foam[c]! * k.foam[c]!
    }
    this.ocean.glitter = o.glitter * k.glitter
    this.ocean.bedSun = o.bedSun * k.bed
    if (look) {
      look.bedSun = this.ocean.bedSun
      look.bodySky = this.ocean.bodySky = o.bodySky * k.bodySky
      for (let c = 0; c < 3; c++) look.foam[c] = foam[c]!
    }

    const s = this.state
    s.night = smooth(-4, -13, e)
    s.dusk = Math.max(0, 1 - Math.abs(e - 1) / 22) * (1 - s.night)
    s.lights = smooth(5, -2, e)
    s.moonKey = useMoon ? moonKey : 0
    const lum = (c: readonly number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
    s.daylight = Math.min(1, lum(k.horizon) / Math.max(1e-4, lum(a0.horizon)))
  }

  /** Writes the Frame's `extra`: night, warm twilight, practical lights, moon as key light (all 0 by day). */
  fill(frame: Float32Array): void {
    const s = this.state
    frame[FRAME.extra] = s.night
    frame[FRAME.extra + 1] = s.dusk
    frame[FRAME.extra + 2] = s.lights
    frame[FRAME.extra + 3] = s.moonKey
  }

  /**
   * Per frame once the Frame is filled: the star field and moon (hidden under the overcast), and the practical lights
   * (a storm switches them on early when it darkens the dusk). `storm` is the weather's cloud × darkness, 0..1.
   */
  passes(view: RelView, stars: Stars, lights: Lights, o: { fov: number; height: number; overcast: number; storm: number }): void {
    const s = this.state
    const a = this.atmosphere
    const veil = 1 - o.overcast
    stars.update(view, {
      rot: this.stars,
      stars: s.night,
      moonView: this.moonView,
      sun: this.moonPhaseSun,
      moonBright: 1.1 * (0.5 + 0.5 * s.night),
      // The moon shows from late dusk (it rises near the sunset's bearing and would sit beside the sun).
      moonAlpha: Math.min(1, Math.max(0, (this.moonView[1] + 0.02) * 30)) * smooth(-3, -11, this.sunElevation) * veil * veil,
      moonDark: [a.zenith[0] * 2 + 0.004, a.zenith[1] * 2 + 0.006, a.zenith[2] * 2 + 0.012],
      fov: o.fov,
      height: o.height,
    })
    const dark = 1 - s.daylight
    lights.upload(Math.max(s.lights, o.storm * 0.8 * dark), Math.max(s.night, o.storm * 0.7 * dark), o.fov, o.height)
  }
}

/** Light for the moon's phase: from behind the viewer (full), turned by `gap` toward the sun's side of the sky. */
function phaseLight(moon: readonly number[], sun: readonly number[], gap: number, out: Vec3): Vec3 {
  const d = moon[0]! * sun[0]! + moon[1]! * sun[1]! + moon[2]! * sun[2]!
  let sx = sun[0]! - moon[0]! * d
  let sy = sun[1]! - moon[1]! * d
  let sz = sun[2]! - moon[2]! * d
  const l = Math.hypot(sx, sy, sz)
  if (l < 1e-5) {
    sx = 0
    sy = -1
    sz = 0
  } else {
    sx /= l
    sy /= l
    sz /= l
  }
  const c = Math.cos(gap)
  const s = Math.sin(gap)
  out[0] = -moon[0]! * c + sx * s
  out[1] = -moon[1]! * c + sy * s
  out[2] = -moon[2]! * c + sz * s
  return out
}

function blank(): Resolved {
  return { e: 0, zenith: [0, 0, 0], horizon: [0, 0, 0], sun: [0, 0, 0], sunI: 0, ambient: 0, exposure: 1, saturation: 1, warmth: 0, bloom: 0, bodySky: 1, deep: [1, 1, 1], glitter: 1, foam: [1, 1, 1], bed: 1, scatter: [1, 1, 1] }
}

const copy3 = (src: readonly number[], dst: Vec3): Vec3 => {
  dst[0] = src[0]!
  dst[1] = src[1]!
  dst[2] = src[2]!
  return dst
}

/** A key with the base filled in (the day key reads the live sunny look). */
function resolve(k: DayKey, bases: DayBases, out: Resolved): Resolved {
  const a = bases.atmosphere
  out.e = k.e
  if (k.base) {
    copy3(a.zenith, out.zenith)
    copy3(a.horizon, out.horizon)
    copy3(a.sunColor, out.sun)
    out.sunI = a.sunIntensity
    out.ambient = a.ambient
    out.exposure = 1
    out.saturation = 1
    out.warmth = 0
    out.bloom = 0
    out.bodySky = 1
    copy3([1, 1, 1], out.deep)
    out.glitter = 1
    copy3([1, 1, 1], out.foam)
    out.bed = 1
    copy3([1, 1, 1], out.scatter)
    return out
  }
  copy3(k.zenith ?? a.zenith, out.zenith)
  copy3(k.horizon ?? a.horizon, out.horizon)
  copy3(k.sun ?? a.sunColor, out.sun)
  out.sunI = k.sunI ?? a.sunIntensity
  out.ambient = k.ambient ?? a.ambient
  out.exposure = k.exposure ?? 1
  out.saturation = k.saturation ?? 1
  out.warmth = k.warmth ?? 0
  out.bloom = k.bloom ?? 0
  out.bodySky = k.bodySky ?? 1
  copy3(k.deep ?? [1, 1, 1], out.deep)
  out.glitter = k.glitter ?? 1
  copy3(k.foam ?? [1, 1, 1], out.foam)
  out.bed = k.bed ?? 1
  copy3(k.scatter ?? [1, 1, 1], out.scatter)
  return out
}

function mixKey(a: Resolved, b: Resolved, u: number, out: Resolved): Resolved {
  for (let c = 0; c < 3; c++) {
    out.zenith[c] = lerp(a.zenith[c]!, b.zenith[c]!, u)
    out.horizon[c] = lerp(a.horizon[c]!, b.horizon[c]!, u)
    out.sun[c] = lerp(a.sun[c]!, b.sun[c]!, u)
    out.deep[c] = lerp(a.deep[c]!, b.deep[c]!, u)
    out.foam[c] = lerp(a.foam[c]!, b.foam[c]!, u)
    out.scatter[c] = lerp(a.scatter[c]!, b.scatter[c]!, u)
  }
  out.sunI = lerp(a.sunI, b.sunI, u)
  out.ambient = lerp(a.ambient, b.ambient, u)
  out.exposure = lerp(a.exposure, b.exposure, u)
  out.saturation = lerp(a.saturation, b.saturation, u)
  out.warmth = lerp(a.warmth, b.warmth, u)
  out.bloom = lerp(a.bloom, b.bloom, u)
  out.bodySky = lerp(a.bodySky, b.bodySky, u)
  out.glitter = lerp(a.glitter, b.glitter, u)
  out.bed = lerp(a.bed, b.bed, u)
  return out
}
