import type { SceneLight } from "../gpu/scene-frame"
import type { FogLamp } from "../gpu/fog-scatter"
import type { LabControl } from "../lab-panel"
import { lifeRamp, type ParticleSpec, type Particles } from "./particles"
import { flareEnvelope, flareFlicker, flareHash } from "../sim/flare-burn"
import type { ThrownBody } from "../sim/thrown"

export { flareEnvelope, flareFlicker, FLARE_STRIKE, type FlareEnvelope, type FlarePhase } from "../sim/flare-burn"

/**
 * A 1990s handheld road flare (a fusee): strontium-nitrate red with a pinkish-white core, a fast sputtering flicker,
 * sparks, dripping molten slag and a thick column of smoke lit red from below. Any game can use it: the host owns
 * where the flare is (thrown with `@arcade/kit/sim/thrown`, held in a hand or lying on a road) and gives each one a
 * `FlareFx`. `FlareFx.step` writes its particles into a kit `Particles` pool at a fixed 120 Hz, so 30, 60 and 144 fps
 * look the same, and `FlareFx.light` is the light the host adds to its scene (`flareSceneLight`, `flareFogLamp`).
 *
 * The flicker and the burn's phases are pure functions of (seed, age), so every client in a room sees the same flare
 * sputter at the same moment and a scrubbed replay matches.
 */

export type FlareSettings = {
  /** Light output (× the host's scale). */
  intensity: number
  /** Colour temperature of the burning composition (K): lower is a deeper red, higher pinker-orange. */
  temperature: number
  /** Burn time (s). Real fusees are sold as 10, 15 and 30 minute; games want 2–3. */
  burnTime: number
  /** Smoke (× the default column). */
  smoke: number
  /** Sparks thrown per second at full burn. */
  sparkRate: number
  /** Slag drops per second. */
  slagRate: number
  /** Sputter depth (0 steady, 1 a real flare, 2 a wet one). */
  flicker: number
  /** The soft red halo in the air round the flame (0 off). Hosts whose fog already scatters the light keep it low. */
  halo: number
}

export const FLARE_DEFAULTS: Readonly<FlareSettings> = {
  intensity: 1,
  temperature: 1850,
  burnTime: 150,
  smoke: 1,
  sparkRate: 40,
  slagRate: 5,
  flicker: 1,
  halo: 0.3,
}

/** `[min, max, step, unit, label, group]` per setting. */
export const FLARE_RANGES: Readonly<Record<keyof FlareSettings, readonly [number, number, number, string, string, string]>> = {
  intensity: [0, 3, 0.05, "×", "Intensity", "Flare"],
  temperature: [1500, 2400, 10, "K", "Colour temperature", "Flare"],
  burnTime: [10, 300, 5, "s · retrigger", "Burn time", "Flare"],
  flicker: [0, 2, 0.05, "×", "Sputter", "Flare"],
  smoke: [0, 2.5, 0.05, "×", "Smoke density", "Smoke & sparks"],
  sparkRate: [0, 120, 1, "/s", "Spark rate", "Smoke & sparks"],
  slagRate: [0, 12, 0.5, "/s", "Slag drips", "Smoke & sparks"],
  halo: [0, 2, 0.05, "×", "Halo", "Smoke & sparks"],
}

/** Clamped settings from untrusted input (a preset file, a URL). */
export function flareSettings(input: Partial<Record<keyof FlareSettings, unknown>> = {}): FlareSettings {
  const out = { ...FLARE_DEFAULTS }
  for (const key of Object.keys(FLARE_RANGES) as (keyof FlareSettings)[]) {
    const v = Number(input[key])
    if (input[key] === undefined || !Number.isFinite(v)) continue
    const [min, max] = FLARE_RANGES[key]
    out[key] = Math.min(max, Math.max(min, v))
  }
  return out
}

/** Typed LabPanel rows for a `FlareSettings` object bound to the panel (keys prefixed with `prefix`). */
export function flareControls(change?: (key: keyof FlareSettings) => void, prefix = "", visible?: LabControl["visible"]): LabControl[] {
  return (Object.keys(FLARE_RANGES) as (keyof FlareSettings)[]).map((key): LabControl => {
    const [min, max, step, unit, label, group] = FLARE_RANGES[key]
    return {
      key: prefix + key,
      ...(prefix ? { field: key } : {}),
      label,
      group,
      type: "range",
      min,
      max,
      step,
      unit,
      ...(visible ? { visible } : {}),
      change: () => change?.(key),
    }
  })
}

/** Linear sRGB of a blackbody at `k` kelvin (Tanner Helland's fit), brightest channel 1. */
export function blackbody(k: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const t = k / 100
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592)
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492)
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307
  const lin = (v: number) => Math.pow(Math.max(0, Math.min(255, v)) / 255, 2.2)
  out[0] = lin(r); out[1] = lin(g); out[2] = lin(b)
  const m = Math.max(out[0], out[1], out[2], 1e-6)
  out[0] /= m; out[1] /= m; out[2] /= m
  return out
}

/**
 * The flare's light colour, linear, red channel 1. Strontium burns in lines at 606–680 nm, not as a blackbody, so the
 * temperature is read through the blackbody ramp and then filtered: the green the blackbody has at that temperature
 * is cut to a third and a little of the magnesium/chlorine blue line comes in with it. 1850 K gives (1, 0.08, 0.07):
 * deep red with a magenta edge. `heat` (0..1) warms it towards the slag's orange as the flare gutters.
 */
export function flareColor(k: number, heat = 0, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const bb = blackbody(k, out)
  const g = bb[1]
  out[0] = 1
  out[1] = 0.35 * g + heat * 0.16
  out[2] = 0.05 + 0.3 * g * g - heat * 0.03
  return out
}

/** One flare's light this frame: where it is, linear colour (red 1) and output (× settings.intensity, × flicker). */
export type FlareLight = { x: number; y: number; z: number; r: number; g: number; b: number; level: number }

const STEP = 1 / 120
const MAX_STEPS = 24

const sparkSpec: ParticleSpec = { kind: "spark", life: 0.5, size: 0.016, growth: -0.01, gravity: 9.81, drag: 1.4, bounce: 0.3, r: 1, g: 0.5, b: 0.2, alpha: 1, temperature: 1.25 }
const slagSpec: ParticleSpec = { kind: "spark", life: 2, size: 0.016, growth: -0.004, gravity: 9.81, drag: 0.3, bounce: 0.05, r: 1, g: 0.45, b: 0.12, alpha: 1, temperature: 1 }
const flameSpec: ParticleSpec = { kind: "flare", life: 0.16, size: 0.05, growth: 0.6, gravity: -5, drag: 2.2, bounce: 0, r: 1, g: 0.08, b: 0.07, alpha: 1, temperature: 1.2, turbulence: 1 }
const coreSpec: ParticleSpec = { kind: "flare", life: 0.05, size: 0.03, growth: 0.2, gravity: 0, drag: 6, bounce: 0, r: 1, g: 0.08, b: 0.07, alpha: 1, temperature: 1.45, turbulence: 0.5 }
/**
 * Smoke darkens and thins as it ages, and since it rises steadily its age is its height: warm and lit at the base, cool
 * and dark higher up, whatever the host light's falloff is.
 */
const smokeRamp = () => lifeRamp("fx.flare.smoke", () => {
  const n = 16, tint = new Float32Array(n * 3), opacity = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1), k = 0.14 + 0.86 * Math.exp(-t * 4)
    tint[i * 3] = k; tint[i * 3 + 1] = k; tint[i * 3 + 2] = k * 1.03
    opacity[i] = 1 - 0.6 * t
  }
  return { tint, size: null, opacity }
})
const smokeSpec: ParticleSpec = { kind: "smoke", life: 7, size: 0.04, growth: 0.13, gravity: -0.35, drag: 0.45, bounce: 0, r: 0.5, g: 0.49, b: 0.48, alpha: 0.16, turbulence: 1.4, ease: 1.4, temperature: 1 }
const haloSpec: ParticleSpec = { kind: "glow", life: 0.3, size: 0.35, growth: 0.2, gravity: 0, drag: 0, bounce: 0, r: 1, g: 0.08, b: 0.07, alpha: 0.05 }

/**
 * One burning flare. The host moves it (`x, y, z` is the burning end, `dx, dy, dz` the unit axis the flame jets
 * along: out of the stick, tilted up a little when it lies on the ground) and sets `age` each frame, or lets
 * `step` advance it. Nothing here allocates per frame.
 */
export class FlareFx {
  x = 0
  y = 0
  z = 0
  dx = 0
  dy = 1
  dz = 0
  /** Seconds since the strike (negative: not struck yet). */
  age = -1
  /** Host velocity of the flare (m/s), inherited by what it throws off. */
  vx = 0
  vy = 0
  vz = 0
  readonly settings: FlareSettings
  private tick = 0
  private carry = 0
  private sparks = 0
  private slag = 0
  private flame = 0
  private core = 0
  private smokeCarry = 0
  private halo = 0
  private random = 0
  private readonly colour: [number, number, number] = [1, 0, 0]

  /** Seed of the flicker and the emission's random stream; set it before `strike` to retrigger as another flare. */
  constructor(public seed: number, settings: Partial<FlareSettings> = {}) {
    this.settings = { ...FLARE_DEFAULTS, ...settings }
  }

  get lit(): boolean {
    const p = flareEnvelope(this.age, this.settings.burnTime).phase
    return p !== "unlit" && p !== "out"
  }

  /** Strikes it now (age 0) or puts it at `age` (a joiner, a scrub), clearing the emission clock. */
  strike(age = 0) {
    this.age = age
    this.carry = 0
    this.sparks = this.slag = this.flame = this.core = this.smokeCarry = this.halo = 0
    this.tick = Math.floor(Math.max(0, age) / STEP)
  }

  /**
   * Advances by `dt` (when `advance`; a host that sets `age` from its own clock passes false) and emits into `pool`
   * on fixed 1/120 s ticks. A hitch longer than 0.2 s just skips emission, it never bursts.
   */
  step(dt: number, pool: Particles, advance = true) {
    if (advance) this.age += dt
    if (this.age < 0) return
    this.carry += Math.max(0, dt)
    let n = 0
    while (this.carry >= STEP && n < MAX_STEPS) {
      this.carry -= STEP
      this.emitTick(pool, this.age - this.carry)
      this.tick++
      n++
    }
    if (n === MAX_STEPS) this.carry = 0
  }

  /** This frame's light (colour red 1). `level` 0 when unlit or out. */
  light(out: FlareLight = { x: 0, y: 0, z: 0, r: 1, g: 0, b: 0, level: 0 }): FlareLight {
    const s = this.settings
    const env = flareEnvelope(this.age, s.burnTime)
    flareColor(s.temperature, env.heat, this.colour)
    // The light sits out along the flame and a hand above it: the flame plume and the brightly lit smoke just over it
    // are what light the ground, so a pool spreads round it instead of a grazing glint, and trunks near it cast long
    // shadows.
    out.x = this.x + this.dx * 0.06
    out.y = this.y + Math.max(0, this.dy * 0.06) + 0.22
    out.z = this.z + this.dz * 0.06
    out.r = this.colour[0]
    out.g = this.colour[1]
    out.b = this.colour[2]
    out.level = env.level <= 0 ? 0 : env.level * s.intensity * flareFlicker(this.seed, this.age, s.flicker * env.sputter)
    return out
  }

  private rand() {
    this.random = (this.random + 1) | 0
    return flareHash(this.seed * 7919 + this.tick, this.random)
  }

  private emitTick(pool: Particles, age: number) {
    const s = this.settings
    const env = flareEnvelope(age, s.burnTime)
    if (env.phase === "unlit" || env.phase === "out") return
    this.random = 0
    const flick = flareFlicker(this.seed, age, s.flicker * env.sputter)
    const out = env.level * flick
    const c = flareColor(s.temperature, env.heat, this.colour)
    const { x, y, z, dx, dy, dz } = this
    const burning = env.phase !== "embers"

    // A frame for the flame: the axis and two perpendiculars to spread things round it.
    let px = -dz, pz = dx
    const pl = Math.hypot(px, pz)
    if (pl < 1e-4) { px = 1; pz = 0 } else { px /= pl; pz /= pl }
    const qx = dy * pz, qy = dz * px - dx * pz, qz = -dy * px

    if (burning) {
      // The flame tongue: short puffs jetting out of the end, buoyant, hottest in the core.
      this.flame += STEP * 140 * Math.min(1.6, out)
      while (this.flame >= 1) {
        this.flame--
        const speed = 0.8 + 0.9 * this.rand()
        const a = this.rand() * 2 - 1, b = this.rand() * 2 - 1
        flameSpec.r = c[0]; flameSpec.g = c[1]; flameSpec.b = c[2]
        flameSpec.temperature = (0.6 + 0.35 * this.rand()) * Math.min(1.25, 0.55 + 0.45 * out) * (1 - 0.35 * env.heat)
        flameSpec.life = 0.12 + 0.12 * this.rand()
        flameSpec.alpha = 1.4 * Math.min(2, out) * s.intensity
        pool.spawn(flameSpec, x, y, z,
          this.vx + dx * speed + (px * a + qx * b) * 0.35,
          this.vy + dy * speed + qy * b * 0.35 + 0.3,
          this.vz + dz * speed + (pz * a + qz * b) * 0.35,
          this.rand() * 6.283)
      }
      this.core += STEP * 70
      while (this.core >= 1) {
        this.core--
        coreSpec.r = c[0]; coreSpec.g = c[1]; coreSpec.b = c[2]
        coreSpec.temperature = 1.45 * Math.min(1.3, out) * (1 - 0.3 * env.heat)
        coreSpec.alpha = 0.7 * Math.min(2, out) * s.intensity
        pool.spawn(coreSpec, x + dx * 0.01, y + dy * 0.01, z + dz * 0.01, this.vx + dx * 0.4, this.vy + dy * 0.4, this.vz + dz * 0.4, this.rand() * 6.283)
      }
      // Sparks: a spray round the axis, more in the strike and as it gutters.
      this.sparks += STEP * s.sparkRate * (env.phase === "strike" ? 5 : 1) * (0.5 + 0.5 * out) * (1 + env.heat)
      while (this.sparks >= 1) {
        this.sparks--
        const speed = 1.5 + 3.5 * this.rand()
        const a = (this.rand() * 2 - 1) * 0.9, b = (this.rand() * 2 - 1) * 0.9
        sparkSpec.life = 0.2 + 0.45 * this.rand()
        pool.spawn(sparkSpec, x, y, z,
          this.vx + (dx + px * a + qx * b) * speed,
          this.vy + (dy + qy * b) * speed + 0.8,
          this.vz + (dz + pz * a + qz * b) * speed,
          this.rand() * 6.283)
      }
      // Molten slag: drops that fall off the end and cool orange to dull red where they land.
      this.slag += STEP * s.slagRate * (0.6 + 0.8 * env.heat)
      while (this.slag >= 1) {
        this.slag--
        slagSpec.life = 1.4 + 1.6 * this.rand()
        slagSpec.size = 0.012 + 0.01 * this.rand()
        pool.spawn(slagSpec, x - dx * 0.02, y - dy * 0.02, z - dz * 0.02,
          this.vx + dx * 0.25 + (this.rand() - 0.5) * 0.3, this.vy - 0.1, this.vz + dz * 0.25 + (this.rand() - 0.5) * 0.3,
          this.rand() * 6.283)
      }
      if (s.halo > 0) {
        this.halo += STEP * 24
        while (this.halo >= 1) {
          this.halo--
          haloSpec.r = c[0]; haloSpec.g = c[1]; haloSpec.b = c[2]
          haloSpec.alpha = 0.05 * s.halo * Math.min(2, out) * s.intensity
          pool.spawn(haloSpec, x + dx * 0.05, y + dy * 0.05 + 0.04, z + dz * 0.05, this.vx, this.vy + 0.05, this.vz, this.rand() * 6.283)
        }
      }
    }
    // Smoke: a thick column from the flame's tip, hot and fast at first, slowing and spreading as it cools.
    this.smokeCarry += STEP * 42 * s.smoke * env.smoke
    if (this.smokeCarry >= 1) smokeSpec.ramp = smokeRamp()
    while (this.smokeCarry >= 1) {
      this.smokeCarry--
      smokeSpec.life = 5.5 + 3 * this.rand()
      smokeSpec.alpha = Math.min(0.35, 0.16 * Math.sqrt(Math.max(s.smoke, 0.01)))
      smokeSpec.size = 0.035 + 0.03 * this.rand()
      const a = this.rand() * 2 - 1, b = this.rand() * 2 - 1
      pool.spawn(smokeSpec, x + dx * 0.14, y + dy * 0.14 + 0.04, z + dz * 0.14,
        this.vx * 0.5 + dx * 0.35 + a * 0.05, this.vy * 0.5 + 0.75 + 0.25 * this.rand(), this.vz * 0.5 + dz * 0.35 + b * 0.05,
        this.rand() * 6.283)
    }
  }
}

/**
 * Puts `fx` on a thrown body (`sim/thrown`): tumbling in flight, or lying along its throw at rest with the flame jetting
 * out of the end, propped up a little by the stick and litter. `stick` is how far the burning end is from the body's
 * centre (m).
 */
export function flareOnBody(fx: FlareFx, b: ThrownBody, stick = 0.11): void {
  let ax: number, ay: number, az: number
  if (b.rest) {
    const sign = b.spin % (2 * Math.PI) < Math.PI ? 1 : -1
    ax = b.ax * sign; ay = 0.3; az = b.az * sign
  } else {
    const c = Math.cos(b.spin), s = Math.sin(b.spin)
    ax = b.ax * c; ay = s; az = b.az * c
  }
  const l = Math.hypot(ax, ay, az)
  fx.dx = ax / l; fx.dy = ay / l; fx.dz = az / l
  fx.x = b.x + fx.dx * stick; fx.y = b.y + Math.max(0, fx.dy * stick); fx.z = b.z + fx.dz * stick
  fx.vx = b.vx; fx.vy = b.vy; fx.vz = b.vz
}

/**
 * A `SceneLight` for a flare (y and h swapped into the scene's plan convention). `power` is the host's full-burn
 * light power and `radius` its reach (m); trunks near it cast polar shadows unless `shadowed` is false.
 */
export function flareSceneLight(l: FlareLight, power: number, radius: number, shadowed = true, id?: number): SceneLight {
  return {
    x: l.x,
    y: l.z,
    h: Math.max(0.05, l.y),
    r: radius,
    color: [l.r, l.g, l.b],
    power: power * l.level,
    size: 0.08,
    ...(shadowed ? {} : { unshadowed: true }),
    ...(id === undefined ? {} : { id }),
  }
}

/** An omni `FogLamp` for a flare: its glow in the mist. `intensity` is the host's numerator over d² at full burn. */
export function flareFogLamp(l: FlareLight, intensity: number, range: number, id?: number): FogLamp {
  return {
    x: l.x,
    y: l.y,
    z: l.z,
    range,
    color: [l.r, l.g, l.b],
    intensity: intensity * l.level,
    size: 0.1,
    visibility: l.level > 0 ? 1 : 0,
    ...(id === undefined ? {} : { id }),
  }
}
