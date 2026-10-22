/**
 * A lightning strike as data: a branching channel and the timing of its strokes. Pure and seeded, so a strike is the
 * same in a still, a clip and a test.
 *
 * Shape: a stochastic stepped leader. The main channel walks from the cloud toward its ground point in 14–22 steps that
 * each veer up to ~35° off the line to the target; side branches fork from it, thinner and dimmer, and fork again.
 * Every step is then midpoint-displaced three times for the fine tortuosity a photograph shows.
 *
 * Timing (Rakov & Uman, *Lightning: Physics and Effects*): the stepped leader creeps down for ~80–120 ms as a faint
 * flicker; the return stroke lights the whole channel, branches included, and decays in tens of milliseconds; 2–4
 * subsequent strokes reuse the main channel only, 40–120 ms apart, so the flicker lasts 0.2–0.5 s; a faint
 * continuing current and the eye's afterimage linger after it.
 */

export type BoltKind = "ground" | "cloud"
export type Vec3 = [number, number, number]

/** Floats per segment: a.xyz, width, b.xyz, weight, leader time, generation, branch fade, 0. */
export const BOLT_SEGMENT_FLOATS = 12

export type Stroke = {
  /** Seconds after the return stroke. */
  at: number
  peak: number
  /** Decay time constant (s). */
  tau: number
  /** The return stroke also lights the branches. */
  branches: boolean
}

export type BoltShape = { segments: Float32Array; count: number; top: Vec3; ground: Vec3 }

export type Strike = {
  kind: BoltKind
  seed: number
  /** Simulation time of the return stroke (s). */
  t: number
  /** Leader duration before the return stroke (s). */
  leader: number
  strokes: Stroke[]
  shape: BoltShape
  /** Strike point (ground) or channel centre (cloud to cloud). */
  position: Vec3
  /** Horizontal distance from the listener at strike time (m). */
  distance: number
  /** Scene flash pulses allowed by the flash limiter (indices into `strokes`). */
  scenePulses: number[]
  power: number
}

/** Mulberry32. */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const norm = (v: Vec3): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l] }
const add = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2])
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

type Seg = { a: Vec3; b: Vec3; width: number; weight: number; t0: number; t1: number; gen: number; fade0: number; fade1: number }

/** Branching channel from `top` to `ground` (ground strike) or across the sky (cloud to cloud). */
export function boltShape(seed: number, top: Vec3, ground: Vec3, kind: BoltKind = "ground"): BoltShape {
  const r = rng(seed)
  const jitter = (): Vec3 => norm([r() * 2 - 1, (r() * 2 - 1) * (kind === "cloud" ? 0.5 : 1), r() * 2 - 1])
  const coarse: Seg[] = []
  const total = len(sub(ground, top))
  // One leader: walk toward `target`, veering, until `steps` run out; forks recurse with less of everything.
  const walk = (from: Vec3, target: Vec3 | null, dir0: Vec3, steps: number, stepLen: number, width: number, weight: number, t0: number, gen: number) => {
    let p = from, dir = dir0, t = t0
    for (let i = 0; i < steps; i++) {
      const left = steps - i
      let want = dir
      if (target) {
        const to = sub(target, p)
        if (left === 1) want = norm(to)
        else want = norm(add(norm(to), jitter(), 0.55))
      } else want = norm(add(dir, jitter(), 0.5))
      const step = target ? (left === 1 ? len(sub(target, p)) : (len(sub(target, p)) / left) * (0.7 + 0.6 * r())) : stepLen * (0.6 + 0.8 * r())
      const q = add(p, want, step)
      // Branches stop at the ground; their brightness fades toward their tips.
      if (!target && q[1] < ground[1] + 2) break
      const t1 = t + step / total
      const fade0 = target ? 1 : 1 - i / steps, fade1 = target ? 1 : 1 - (i + 1) / steps
      coarse.push({ a: p, b: q, width, weight, t0: t, t1, gen, fade0, fade1 })
      const forkChance = kind === "cloud" ? 0.42 : gen === 0 ? 0.36 * (1 - 0.6 * (i / steps)) : 0.18
      if (gen < 3 && r() < forkChance) {
        const side = norm(add(want, jitter(), 1.1))
        const down: Vec3 = kind === "cloud" ? [side[0], side[1] * 0.4, side[2]] : [side[0], -Math.abs(side[1]) - 0.35, side[2]]
        walk(q, null, norm(down), 3 + Math.floor(r() * (gen === 0 ? 7 : 4)), step * (0.55 + 0.25 * r()), width * 0.5, weight * 0.55, t1, gen + 1)
      }
      p = q; dir = want; t = t1
    }
  }
  const steps = kind === "cloud" ? 18 + Math.floor(r() * 8) : 14 + Math.floor(r() * 9)
  walk(top, ground, norm(sub(ground, top)), steps, 0, 1, 1, 0, 0)
  // Midpoint displacement: three halvings, offset ⊥ to each piece by up to 16% of its length.
  let segs = coarse
  for (let level = 0; level < 3; level++) {
    const next: Seg[] = []
    for (const s of segs) {
      const d = sub(s.b, s.a), l = len(d), n1 = norm(cross(d, [0.3, 1, 0.2])), n2 = norm(cross(d, n1))
      const k = l * 0.16 * (r() * 2 - 1), k2 = l * 0.16 * (r() * 2 - 1)
      const m = add(add(add(s.a, d, 0.5), n1, k), n2, k2)
      const tm = (s.t0 + s.t1) / 2, fm = (s.fade0 + s.fade1) / 2
      next.push({ ...s, b: m, t1: tm, fade1: fm }, { ...s, a: m, t0: tm, fade0: fm })
    }
    segs = next
  }
  const out = new Float32Array(segs.length * BOLT_SEGMENT_FLOATS)
  segs.forEach((s, i) => {
    out.set([s.a[0], s.a[1], s.a[2], s.width, s.b[0], s.b[1], s.b[2], s.weight, (s.t0 + s.t1) / 2, s.gen, (s.fade0 + s.fade1) / 2, 0], i * BOLT_SEGMENT_FLOATS)
  })
  return { segments: out, count: segs.length, top, ground }
}

/** 2–4 subsequent strokes in the same channel, 40–120 ms apart, after the return stroke. */
export function strokeSchedule(seed: number, kind: BoltKind): Stroke[] {
  const r = rng(seed ^ 0x9e3779b9)
  const strokes: Stroke[] = [{ at: 0, peak: 1, tau: kind === "cloud" ? 0.07 : 0.045, branches: true }]
  const n = kind === "cloud" ? 1 + Math.floor(r() * 3) : 2 + Math.floor(r() * 3)
  let at = 0
  for (let i = 0; i < n; i++) {
    at += 0.04 + 0.08 * r()
    strokes.push({ at, peak: 0.45 + 0.4 * r(), tau: 0.025 + 0.02 * r(), branches: kind === "cloud" })
  }
  return strokes
}

/**
 * WCAG 2.3.1: no more than three flashes in any one second. Each stroke that lights the scene is one flash; a stroke is
 * only allowed to light the scene if fewer than `max` scene pulses fall in the second before it, counting every earlier
 * strike. The rest still light their own channel, which is far smaller than the 2.3.1 area threshold.
 */
export class FlashLimiter {
  private pulses: number[] = []
  constructor(public max = 3, public window = 1) {}
  allow(strokes: readonly Stroke[], t: number, maxForStrike = this.max): number[] {
    const allowed: number[] = []
    strokes.forEach((s, i) => {
      const at = t + s.at
      this.pulses = this.pulses.filter(p => p > at - this.window - 1e-6)
      if (allowed.length < maxForStrike && this.pulses.length < this.max) { this.pulses.push(at); allowed.push(i) }
    })
    return allowed
  }
  /** Scene pulses inside any `window` seconds, for tests. */
  get recent() { return [...this.pulses] }
  reset() { this.pulses = [] }
}

export type StrikeLight = {
  /** Main channel brightness. */
  channel: number
  /** Branch brightness. */
  branches: number
  /** Leader front, 0..1 along the channel; above 1 once the return stroke has fired. */
  front: number
  /** Leader glow while it creeps down. */
  leader: number
  /** Scene flash (lights the lot, clouds and rain). */
  scene: number
  /** Afterimage: a faint violet ghost of the channel. */
  after: number
}

/** Brightness of every part of `strike` at simulation time `t`; `smooth` (Reduce flashing) merges the strokes. */
export function strikeLight(strike: Strike, t: number, smooth = false): StrikeLight {
  const out: StrikeLight = { channel: 0, branches: 0, front: 0, leader: 0, scene: 0, after: 0 }
  const dt = t - strike.t
  if (dt < -strike.leader || dt > 3) return out
  if (dt < 0) {
    // Stepped leader: the front advances in ~50 m steps, each step a brief brightening.
    const p = (dt + strike.leader) / strike.leader
    const steps = 24, k = p * steps, frac = k - Math.floor(k)
    out.front = Math.floor(k) / steps
    out.leader = smooth ? 0.05 : 0.05 + 0.1 * Math.exp(-frac * 6)
    return out
  }
  out.front = 2
  const last = strike.strokes[strike.strokes.length - 1]!
  if (smooth) {
    // One soft rise and fall spanning every stroke: no dips, so the strike is one flash.
    const span = last.at + 0.06
    const env = dt < span ? Math.min(1, dt / 0.08) : Math.exp(-(dt - span) / 0.3)
    out.channel = env * 0.6
    out.branches = env * 0.3 * Math.exp(-dt / 0.2)
    out.scene = strike.scenePulses.length ? env * 0.35 : 0
  } else {
    strike.strokes.forEach((s, i) => {
      const d = dt - s.at
      if (d < 0) return
      const e = s.peak * Math.exp(-d / s.tau)
      out.channel += e
      if (s.branches) out.branches += e * Math.exp(-d / 0.02)
      if (strike.scenePulses.includes(i)) out.scene += e
    })
    // Continuing current: a dim glow for ~100 ms after the last stroke.
    const dl = dt - last.at
    if (dl > 0) out.channel += 0.12 * Math.exp(-dl / 0.12)
  }
  out.after = 0.035 * Math.exp(-Math.max(0, dt - last.at) / 0.7) * Math.min(1, dt / 0.05)
  out.channel *= strike.power; out.branches *= strike.power; out.scene *= strike.power
  return out
}

/** The strike's whole life, leader to afterimage (s). */
export const strikeEnd = (s: Strike) => s.t + s.strokes[s.strokes.length - 1]!.at + 3

export type StrikePlan = { seed: number; kind: BoltKind; bearing: number; distance: number; power: number }

/**
 * Builds a strike around a listener at `(x, z)`: ground strikes land on the treeline or out past it, cloud-to-cloud
 * strikes run across the sky. `ceiling` is where the channel disappears into the cloud (the sky dome's height).
 */
export function makeStrike(plan: StrikePlan, t: number, x: number, z: number, groundY: number, ceiling: number, limiter: FlashLimiter, maxScene = 3): Strike {
  const r = rng(plan.seed)
  const gx = x + Math.sin(plan.bearing) * plan.distance, gz = z - Math.cos(plan.bearing) * plan.distance
  const kind = plan.kind
  let top: Vec3, ground: Vec3
  if (kind === "cloud") {
    const across = plan.bearing + Math.PI / 2, half = 160 + 220 * r(), h = ceiling * (0.78 + 0.15 * r())
    top = [gx - Math.sin(across) * half, h, gz + Math.cos(across) * half]
    ground = [gx + Math.sin(across) * half, h - 25 + 50 * r(), gz - Math.cos(across) * half]
  } else {
    // The cloud end leans: real channels rarely drop straight down.
    const lean = (r() - 0.5) * 0.6 * ceiling
    top = [gx + Math.cos(plan.bearing) * lean, ceiling + 15, gz + Math.sin(plan.bearing) * lean]
    ground = [gx, groundY, gz]
  }
  const strokes = strokeSchedule(plan.seed, kind)
  return {
    kind, seed: plan.seed, t, leader: kind === "cloud" ? 0.06 : 0.08 + 0.05 * r(), strokes,
    shape: boltShape(plan.seed, top, ground, kind), position: kind === "cloud" ? [gx, top[1], gz] : ground,
    distance: plan.distance, power: plan.power, scenePulses: limiter.allow(strokes, t, maxScene),
  }
}
