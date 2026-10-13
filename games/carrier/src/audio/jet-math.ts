// Pure jet-audio math (no Web Audio, no DOM): distance and air absorption, Doppler, the directional "cone" of a jet
// engine, engine spool, closest-approach prediction and flyby triggering. Unit-tested in tests/audio.test.ts.

export const SPEED_OF_SOUND = 343

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const k = clamp((x - e0) / (e1 - e0), 0, 1)
  return k * k * (3 - 2 * k)
}
/** Share of the way to a target covered in dt by a first-order lag of time constant tau. */
export const ease = (dt: number, tau: number): number => (tau <= 0 ? 1 : 1 - Math.exp(-dt / tau))

/** Inverse-distance gain: 1 within `ref` metres, falling as ref / d beyond it (`rolloff` steepens it). */
export function distanceGain(d: number, ref: number, rolloff = 1): number {
  return ref / (ref + rolloff * Math.max(0, d - ref))
}

/** Air absorption as a low-pass cutoff (Hz): bright up close, about 3.5 kHz at 1 km and 1.4 kHz at 3 km. */
export function airCutoff(d: number): number {
  return clamp(20000 / (1 + Math.max(0, d) / 230), 250, 20000)
}

/**
 * Doppler ratio heard from a source at offset r (source minus listener) moving at relative velocity v (source minus
 * listener velocity): c / (c + receding speed). `amount` is an exponent: 1 physical, below 1 compressed toward no shift
 * (real Doppler at a 250 m/s pass is ×3.7, which turns turbine tones cartoonish). Clamped to 0.35-3.
 */
export function dopplerRatio(rx: number, ry: number, rz: number, vx: number, vy: number, vz: number, amount = 1): number {
  const d = Math.sqrt(rx * rx + ry * ry + rz * rz)
  if (d < 1) return 1
  const recede = (vx * rx + vy * ry + vz * rz) / d
  const ratio = SPEED_OF_SOUND / Math.max(SPEED_OF_SOUND * 0.25, SPEED_OF_SOUND + recede)
  return clamp(ratio ** amount, 0.35, 3)
}

/** How a jet sounds from where the listener is relative to its nose. */
export type Cone = {
  /** Cosine of the angle between the nose and the direction to the listener (1: dead ahead, -1: dead astern). */
  cos: number
  /** Intake weight: turbine whine, fan buzz and intake howl, strongest ahead. */
  front: number
  /** Exhaust weight: roar, crackle and afterburner, strongest about 140° off the nose. */
  rear: number
  /** Overall level: a jet is much quieter coming at you than going away. */
  level: number
}

export const makeCone = (): Cone => ({ cos: 0, front: 0, rear: 0, level: 0 })

/**
 * The directional mix for a jet whose nose points along unit n, heard from unit direction l (from the jet to the
 * listener). Jet mixing noise peaks 30-45° off the exhaust axis (about 140° off the nose); the intake whine radiates
 * forward; everything is a little quieter ahead of the jet.
 */
export function jetCone(nx: number, ny: number, nz: number, lx: number, ly: number, lz: number, out: Cone = makeCone()): Cone {
  const c = clamp(nx * lx + ny * ly + nz * lz, -1, 1)
  out.cos = c
  out.front = 0.22 + 0.78 * smoothstep(-0.35, 0.85, c)
  const lobe = Math.exp(-(((c + 0.77) / 0.38) ** 2))
  out.rear = 0.4 + 0.6 * Math.max(lobe, 0.82 * smoothstep(0.25, -0.55, c))
  out.level = 0.62 + 0.38 * smoothstep(0.5, -0.45, c)
  return out
}

/** Engine core speed (0..1 of military) the throttle asks for: idle sits at about 65%. */
export const rpmFor = (throttle: number): number => 0.64 + 0.36 * clamp(throttle, 0, 1) ** 0.85

/** Spool: the core lags the throttle, slower up than down (s). */
export const SPOOL = { up: 1.05, down: 0.75 }
export function spoolStep(rpm: number, target: number, dt: number): number {
  return rpm + (target - rpm) * ease(dt, target > rpm ? SPOOL.up : SPOOL.down)
}

export type Approach = {
  /** Seconds until the closest approach (negative: already past). */
  t: number
  /** Distance at the closest approach (m). */
  miss: number
  /** Relative speed (m/s). */
  speed: number
}

export const makeApproach = (): Approach => ({ t: 0, miss: 0, speed: 0 })

/** Straight-line closest approach of a source at offset r moving at relative velocity v. */
export function closestApproach(rx: number, ry: number, rz: number, vx: number, vy: number, vz: number, out: Approach = makeApproach()): Approach {
  const v2 = vx * vx + vy * vy + vz * vz
  out.speed = Math.sqrt(v2)
  if (v2 < 1e-6) {
    out.t = 0
    out.miss = Math.sqrt(rx * rx + ry * ry + rz * rz)
    return out
  }
  const t = -(rx * vx + ry * vy + rz * vz) / v2
  const mx = rx + vx * t
  const my = ry + vy * t
  const mz = rz + vz * t
  out.t = t
  out.miss = Math.sqrt(mx * mx + my * my + mz * mz)
  return out
}

/** Flyby tuning. Metres, seconds, m/s. */
export const FLYBY = {
  /** A pass is announced when the closest approach is at most this far ahead (covers a take's approach). */
  lead: 2.4,
  /** ...and no sooner than this (a pass already under way is left to the engine voice). */
  minLead: 0.25,
  /** Close enough to count, and fast enough. */
  maxMiss: 170,
  minSpeed: 75,
  /** Per jet, at most one pass this often. */
  cooldown: 5,
  /** A very close, very fast pass: the short violent take. */
  snapMiss: 40,
  snapSpeed: 190,
  /** Beyond this miss distance the distant rolling take. */
  highMiss: 95,
  /** Closing faster than this within `boomMiss`: a crack on top (head-on merges). */
  boomSpeed: 300,
  boomMiss: 60,
}

export type FlybyKind = "snap" | "low" | "burner" | "high"

export type FlybyPlan = {
  kind: FlybyKind
  /** Seconds until the closest approach. */
  t: number
  miss: number
  speed: number
  /** 0..1 loudness for the take. */
  gain: number
  /** Add the crack. */
  boom: boolean
}

export const makeFlybyPlan = (): FlybyPlan => ({ kind: "low", t: 0, miss: 0, speed: 0, gain: 0, boom: false })

/** Which take fits a pass. */
export function flybyKind(miss: number, speed: number, burner: boolean): FlybyKind {
  if (miss > FLYBY.highMiss) return "high"
  if (burner) return "burner"
  if (miss < FLYBY.snapMiss && speed > FLYBY.snapSpeed) return "snap"
  return "low"
}

/** Loudness of a pass from how close and how fast it is (0..1). */
export function flybyGain(miss: number, speed: number): number {
  return clamp((45 / (miss + 30)) * (0.35 + 0.65 * smoothstep(FLYBY.minSpeed, 230, speed)), 0, 1)
}

/** Per-jet pass detector: one pass per cooldown, announced `lead` seconds before the closest approach. */
export class FlybyWatch {
  last = Number.NEGATIVE_INFINITY

  check(now: number, a: Approach, burner: boolean, out: FlybyPlan): FlybyPlan | null {
    if (now - this.last < FLYBY.cooldown) return null
    if (a.t < FLYBY.minLead || a.t > FLYBY.lead) return null
    if (a.miss > FLYBY.maxMiss || a.speed < FLYBY.minSpeed) return null
    this.last = now
    out.kind = flybyKind(a.miss, a.speed, burner)
    out.t = a.t
    out.miss = a.miss
    out.speed = a.speed
    out.gain = flybyGain(a.miss, a.speed)
    out.boom = a.speed > FLYBY.boomSpeed && a.miss < FLYBY.boomMiss
    return out
  }
}

/**
 * Where a one-shot whose loudest moment is `peak` seconds in must start so that moment lands `t` seconds from now:
 * `delay` before starting, `offset` into the take (when the peak is closer than the take's lead-in).
 */
export function alignPeak(t: number, peak: number): { delay: number; offset: number } {
  const start = t - peak
  return start >= 0 ? { delay: start, offset: 0 } : { delay: 0, offset: -start }
}

/** A smoothed velocity estimate from positions (the listener's), reset on teleports. */
export class VelocityTracker {
  x = 0
  y = 0
  z = 0
  private px = 0
  private py = 0
  private pz = 0
  private has = false

  constructor(
    /** Smoothing time constant (s). */
    private tau = 0.12,
    /** Faster than this is a cut or a respawn: reset. */
    private max = 700,
  ) {}

  update(x: number, y: number, z: number, dt: number): void {
    if (!this.has || dt <= 1e-4) {
      this.reset(x, y, z)
      return
    }
    const vx = (x - this.px) / dt
    const vy = (y - this.py) / dt
    const vz = (z - this.pz) / dt
    if (vx * vx + vy * vy + vz * vz > this.max * this.max) {
      this.reset(x, y, z)
      return
    }
    const k = ease(dt, this.tau)
    this.x += (vx - this.x) * k
    this.y += (vy - this.y) * k
    this.z += (vz - this.z) * k
    this.px = x
    this.py = y
    this.pz = z
  }

  reset(x: number, y: number, z: number): void {
    this.x = this.y = this.z = 0
    this.px = x
    this.py = y
    this.pz = z
    this.has = true
  }
}
