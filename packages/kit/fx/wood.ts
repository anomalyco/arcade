import type { LabControl } from "../lab-panel"
import type { ParticleSpec, Particles } from "./particles"

/**
 * Wood and saw effects for felling games: chips and sawdust thrown out of a kerf that bounce and settle on the ground,
 * 2-stroke exhaust that thickens on rev, hinge splinters when a tree goes, twigs snapping off branches, a dust ring
 * when a trunk lands (scaled by its mass), sparks off a chain meeting steel, and blood mist.
 *
 * Fine stuff (sawdust, smoke, dust, sparks, mist) goes into the host's kit `Particles` pool. Chips, splinters and
 * twigs are solid bits the host draws as tiny models: `WoodFx.chips` keeps them, flying and then lying where they
 * landed, until the pool wraps or `woodChipLife` runs out. Plan coordinates are (x, z) with y up, as in `Particles`.
 */

export type WoodSettings = {
  woodChipRate: number
  woodChipSpeed: number
  woodChipSize: number
  woodSawdust: number
  woodChipLife: number
  woodExhaust: number
  woodExhaustRev: number
  woodSplinters: number
  woodBranchSnap: number
  woodDustRing: number
  woodSparks: number
  woodBloodMist: number
}

export const WOOD_DEFAULTS: Readonly<WoodSettings> = {
  woodChipRate: 70,
  woodChipSpeed: 3.6,
  woodChipSize: 1,
  woodSawdust: 45,
  woodChipLife: 90,
  woodExhaust: 6,
  woodExhaustRev: 3,
  woodSplinters: 26,
  woodBranchSnap: 10,
  woodDustRing: 1,
  woodSparks: 14,
  woodBloodMist: 1,
}

/** `[label, min, max, step, unit]` per setting. */
const RANGES: Readonly<Record<keyof WoodSettings, readonly [string, number, number, number, string?]>> = {
  woodChipRate: ["Chips from the kerf", 0, 300, 5, "/s"],
  woodChipSpeed: ["Chip throw", 0.5, 10, 0.1, "m/s"],
  woodChipSize: ["Chip size", 0.3, 3, 0.05, "×"],
  woodSawdust: ["Sawdust", 0, 200, 5, "/s"],
  woodChipLife: ["Chips stay on the ground", 0, 600, 5, "s"],
  woodExhaust: ["Exhaust idle", 0, 40, 0.5, "/s"],
  woodExhaustRev: ["Exhaust on rev", 1, 8, 0.25, "×"],
  woodSplinters: ["Hinge splinters", 0, 120, 1],
  woodBranchSnap: ["Twigs per branch snap", 0, 60, 1],
  woodDustRing: ["Landing dust", 0, 3, 0.05, "×"],
  woodSparks: ["Sparks per clash", 0, 80, 1],
  woodBloodMist: ["Blood mist", 0, 3, 0.05, "×"],
}

export const woodDefaults = (): WoodSettings => ({ ...WOOD_DEFAULTS })

export function woodControls(group = "Wood fx"): LabControl[] {
  return (Object.keys(RANGES) as (keyof WoodSettings)[]).map((key) => {
    const [label, min, max, step, unit] = RANGES[key]
    return { key, label, group, min, max, step, ...(unit ? { unit } : {}) }
  })
}

/** 0: a chip, 1: a long splinter, 2: a twig with needles. */
export type ChipKind = 0 | 1 | 2

export type Chip = {
  kind: ChipKind
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  yaw: number
  pitch: number
  spin: number
  size: number
  /** Brightness of the wood, 0.8–1.15 (fresh sapwood to darker heart). */
  shade: number
  /** Seconds since it came to rest (−1 still flying). */
  rest: number
  live: boolean
}

// Sawdust is mostly flecks that fall and settle where they land, with a faint haze of the finest dust over them.
const sawdustSpec: ParticleSpec = { kind: "debris", life: 2.4, size: 0.011, growth: 0, gravity: 5, drag: 4.5, bounce: 0, r: 0.66, g: 0.52, b: 0.33, alpha: 1 }
const hazeSpec: ParticleSpec = { kind: "soft", life: 1.1, size: 0.05, growth: 0.45, gravity: 0.3, drag: 3.6, bounce: 0, r: 0.6, g: 0.5, b: 0.36, alpha: 0.12 }
const exhaustSpec: ParticleSpec = { kind: "smoke", life: 1.3, size: 0.04, growth: 0.16, gravity: -0.4, drag: 1.6, bounce: 0, r: 0.42, g: 0.5, b: 0.68, alpha: 0.08, turbulence: 1.2, ease: 1.4 }
const dustSpec: ParticleSpec = { kind: "soft", life: 2.2, size: 0.5, growth: 1.4, gravity: -0.1, drag: 2.6, bounce: 0, r: 0.4, g: 0.35, b: 0.27, alpha: 0.17 }
const needleSpec: ParticleSpec = { kind: "debris", life: 2, size: 0.05, growth: 0, gravity: 3, drag: 2.8, bounce: 0.1, r: 0.2, g: 0.4, b: 0.15, alpha: 1 }
const sparkSpec: ParticleSpec = { kind: "spark", life: 0.35, size: 0.014, growth: -0.01, gravity: 9.81, drag: 1.2, bounce: 0.35, r: 1, g: 0.62, b: 0.25, alpha: 1, temperature: 1.3 }
const mistSpec: ParticleSpec = { kind: "soft", life: 0.4, size: 0.04, growth: 0.6, gravity: 1.5, drag: 4, bounce: 0, r: 0.2, g: 0.012, b: 0.01, alpha: 0.32 }
const dropSpec: ParticleSpec = { kind: "debris", life: 1.6, size: 0.02, growth: 0, gravity: 12, drag: 0.8, bounce: 0, r: 0.17, g: 0.008, b: 0.006, alpha: 1 }

export class WoodFx {
  readonly chips: Chip[]
  private next = 0
  private seed: number
  private carry = new Map<string, number>()

  constructor(public settings: WoodSettings = woodDefaults(), capacity = 2400, seed = 1) {
    this.seed = seed >>> 0
    this.chips = Array.from({ length: capacity }, () => ({ kind: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, spin: 0, size: 0, shade: 1, rest: -1, live: false }))
  }

  reset(): void {
    for (const c of this.chips) c.live = false
    this.carry.clear()
  }

  private rand(): number {
    this.seed = (this.seed + 0x6d2b79f5) >>> 0
    let t = this.seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** How many to emit this step at `rate` per second, carrying the fraction under `key`. */
  private count(key: string, rate: number, dt: number): number {
    const c = (this.carry.get(key) ?? 0) + Math.max(0, rate) * dt
    const n = Math.floor(c)
    this.carry.set(key, c - n)
    return n
  }

  private chip(kind: ChipKind, x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number): void {
    const c = this.chips[this.next]!
    this.next = (this.next + 1) % this.chips.length
    c.kind = kind
    c.x = x
    c.y = y
    c.z = z
    c.vx = vx
    c.vy = vy
    c.vz = vz
    c.yaw = this.rand() * Math.PI * 2
    c.pitch = this.rand() * Math.PI * 2
    c.spin = (this.rand() - 0.5) * 30
    c.size = size
    c.shade = 0.82 + this.rand() * 0.33
    c.rest = -1
    c.live = true
  }

  /**
   * A bar biting a trunk at (x, y, z), cutting along (ax, az) (the way the saw points): chips spray out of the
   * kerf's throat sideways and back towards the cutter, sawdust puffs with them. `key` keeps each cut's emission
   * clock separate; `bite` (0..1+) scales it, e.g. by revs.
   */
  kerf(pool: Particles, dt: number, key: string, x: number, y: number, z: number, ax: number, az: number, bite = 1): void {
    const s = this.settings
    const l = Math.hypot(ax, az) || 1
    ax /= l
    az /= l
    // The chain runs over the bar's top and throws out of the bottom, back at the cutter and off to the right side.
    const sx = -az
    const sz = ax
    for (let i = this.count(`${key}.chips`, s.woodChipRate * bite, dt); i > 0; i--) {
      const side = 0.6 + this.rand() * 0.8
      const back = -0.2 - this.rand() * 0.9
      const sp = s.woodChipSpeed * (0.5 + this.rand())
      this.chip(0, x + sx * 0.05, y + (this.rand() - 0.5) * 0.04, z + sz * 0.05, (sx * side + ax * back) * sp, (0.3 + this.rand() * 0.9) * sp * 0.6, (sz * side + az * back) * sp, (0.018 + this.rand() * 0.02) * s.woodChipSize)
    }
    for (let i = this.count(`${key}.dust`, s.woodSawdust * bite, dt); i > 0; i--) {
      const sp = 0.6 + this.rand() * 1.8
      pool.spawn(sawdustSpec, x, y, z, (sx * 0.8 - ax * 0.4 + (this.rand() - 0.5)) * sp, 0.2 + this.rand() * 0.6, (sz * 0.8 - az * 0.4 + (this.rand() - 0.5)) * sp, this.rand() * 100)
      if (this.rand() < 0.25) pool.spawn(hazeSpec, x, y, z, (sx * 0.5 - ax * 0.3) * sp, 0.1 + this.rand() * 0.3, (sz * 0.5 - az * 0.3) * sp, this.rand() * 100)
    }
  }

  /** An axe stroke: a handful of bigger chips knocked out of the notch. */
  chop(x: number, y: number, z: number, ax: number, az: number): void {
    const l = Math.hypot(ax, az) || 1
    for (let i = 0; i < 5; i++) {
      const a = Math.atan2(-az / l, -ax / l) + (this.rand() - 0.5) * 2
      const sp = this.settings.woodChipSpeed * (0.4 + this.rand() * 0.7)
      this.chip(0, x, y, z, Math.cos(a) * sp, 1 + this.rand() * 2, Math.sin(a) * sp, (0.035 + this.rand() * 0.03) * this.settings.woodChipSize)
    }
  }

  /**
   * A motor's exhaust at (x, y, z), blowing out along (dx, dz): thin blue-grey 2-stroke smoke at idle, thick when
   * revved (`rev` 0..1).
   */
  exhaust(pool: Particles, dt: number, key: string, x: number, y: number, z: number, dx: number, dz: number, rev: number): void {
    const s = this.settings
    const k = 1 + (s.woodExhaustRev - 1) * Math.max(0, Math.min(1, rev))
    for (let i = this.count(`${key}.exhaust`, s.woodExhaust * k, dt); i > 0; i--) {
      const sp = 0.4 + this.rand() * 0.8 * k
      exhaustSpec.alpha = 0.05 + 0.03 * k
      exhaustSpec.size = 0.035 + 0.012 * k
      pool.spawn(exhaustSpec, x, y, z, dx * sp + (this.rand() - 0.5) * 0.3, 0.15 + this.rand() * 0.3, dz * sp + (this.rand() - 0.5) * 0.3, this.rand() * 100)
    }
  }

  /** The hinge tearing as a tree goes over on (fx, fz): long splinters burst off the stump, mostly on the fall side. */
  splinters(x: number, y: number, z: number, fx: number, fz: number, trunkR: number): void {
    const n = Math.round(this.settings.woodSplinters)
    for (let i = 0; i < n; i++) {
      const a = Math.atan2(fz, fx) + (this.rand() - 0.5) * 2.6
      const sp = 1 + this.rand() * 3.5
      const kind: ChipKind = this.rand() < 0.45 ? 1 : 0
      this.chip(kind, x + Math.cos(a) * trunkR * 0.8, y + this.rand() * 0.1, z + Math.sin(a) * trunkR * 0.8, Math.cos(a) * sp, 1.5 + this.rand() * 3, Math.sin(a) * sp, kind === 1 ? 0.12 + this.rand() * 0.18 : 0.03 + this.rand() * 0.03)
    }
  }

  /** A branch snapping at (x, y, z) (on the ground or against another tree): twigs and a puff of needles. */
  branches(pool: Particles, x: number, y: number, z: number, strength = 1): void {
    const n = Math.round(this.settings.woodBranchSnap * strength)
    for (let i = 0; i < n; i++) {
      const a = this.rand() * Math.PI * 2
      const sp = (1 + this.rand() * 4) * strength
      if (i % 2 === 0) this.chip(2, x, y, z, Math.cos(a) * sp, 1 + this.rand() * 3, Math.sin(a) * sp, 0.18 + this.rand() * 0.3)
      pool.spawn(needleSpec, x + (this.rand() - 0.5), y + this.rand(), z + (this.rand() - 0.5), Math.cos(a) * sp * 1.4, this.rand() * 3, Math.sin(a) * sp * 1.4, this.rand() * 100)
    }
  }

  /**
   * A trunk landing from (x, z) along (fx, fz), `length` long with a crown `crownR` wide over its last
   * `crownShare`: a dust wave rolls out to both sides, a ring bursts round the crown, needles and twigs fly. `mass`
   * (≈ 1 for a 25 m conifer) scales it all. Returns the number of puffs, for the host's budget.
   */
  landing(pool: Particles, x: number, z: number, fx: number, fz: number, length: number, crownR: number, crownShare: number, mass: number): number {
    const s = this.settings
    const k = Math.max(0, mass) * s.woodDustRing
    const n = Math.round(34 * k)
    const px = -fz
    const pz = fx
    for (let i = 0; i < n; i++) {
      const along = Math.sqrt(this.rand()) * length
      const side = this.rand() < 0.5 ? -1 : 1
      const out = (2 + this.rand() * 4.5) * (0.6 + 0.4 * k)
      const crown = along > length * (1 - crownShare)
      const w = crown ? crownR * (0.4 + this.rand() * 0.7) : 0.3
      pool.spawn(dustSpec, x + fx * along + px * side * w, 0.25, z + fz * along + pz * side * w, px * side * out + (this.rand() - 0.5), 0.4 + this.rand() * 1.2, pz * side * out + (this.rand() - 0.5), this.rand() * 100)
    }
    // The ring round where the crown slams.
    const cx = x + fx * length * (1 - crownShare * 0.5)
    const cz = z + fz * length * (1 - crownShare * 0.5)
    const ring = Math.round(22 * k)
    for (let i = 0; i < ring; i++) {
      const a = (i / Math.max(1, ring)) * Math.PI * 2 + this.rand() * 0.3
      const sp = 3 + this.rand() * 3.5
      pool.spawn(dustSpec, cx + Math.cos(a) * crownR, 0.3, cz + Math.sin(a) * crownR, Math.cos(a) * sp, 0.6 + this.rand(), Math.sin(a) * sp, this.rand() * 100)
    }
    for (let i = 0; i < 3; i++) {
      const along = length * (0.55 + this.rand() * 0.45)
      this.branches(pool, x + fx * along, 0.6, z + fz * along, Math.min(1.5, 0.5 + k * 0.5))
    }
    return n + ring
  }

  /** Chain on steel (two bars meeting): a spray of sparks round `dir` (radians, plan). */
  sparks(pool: Particles, x: number, y: number, z: number, dir: number, scale = 1): void {
    const n = Math.round(this.settings.woodSparks * scale)
    for (let i = 0; i < n; i++) {
      const a = dir + Math.PI / 2 * (this.rand() < 0.5 ? -1 : 1) + (this.rand() - 0.5) * 1.6
      const sp = 3 + this.rand() * 7
      pool.spawn(sparkSpec, x, y, z, Math.cos(a) * sp, 1 + this.rand() * 4, Math.sin(a) * sp, this.rand() * 100)
    }
  }

  /** A saw in flesh: a red mist and fine droplets thrown along `dir`. */
  bloodMist(pool: Particles, x: number, y: number, z: number, dir: number, amount = 1): void {
    const k = amount * this.settings.woodBloodMist
    for (let i = 0; i < Math.round(5 * k); i++) {
      const a = dir + (this.rand() - 0.5) * 1.4
      const sp = 0.8 + this.rand() * 2.2
      pool.spawn(mistSpec, x, y, z, Math.cos(a) * sp, 0.2 + this.rand() * 0.8, Math.sin(a) * sp, this.rand() * 100)
    }
    for (let i = 0; i < Math.round(14 * k); i++) {
      const a = dir + (this.rand() - 0.5) * 2
      const sp = 2 + this.rand() * 5
      pool.spawn(dropSpec, x, y, z, Math.cos(a) * sp, 1 + this.rand() * 3, Math.sin(a) * sp, this.rand() * 100)
    }
  }

  /** Flies, tumbles, bounces and settles the solid bits on `ground(x, z)`; settled ones age out after `woodChipLife`. */
  step(dt: number, ground: (x: number, z: number) => number = () => 0): void {
    const life = this.settings.woodChipLife
    for (const c of this.chips) {
      if (!c.live) continue
      if (c.rest >= 0) {
        c.rest += dt
        if (c.rest > life) c.live = false
        continue
      }
      const drag = c.kind === 2 ? 2.2 : c.kind === 1 ? 0.6 : 1.4
      const f = Math.exp(-drag * dt)
      c.vx *= f
      c.vz *= f
      c.vy = c.vy * f - 9.81 * dt
      c.x += c.vx * dt
      c.y += c.vy * dt
      c.z += c.vz * dt
      c.yaw += c.spin * dt
      c.pitch += c.spin * 0.7 * dt
      const g = ground(c.x, c.z)
      if (c.y > g) continue
      c.y = g
      if (c.vy < -1.2) {
        // Bounce: lose most of it, skid, keep tumbling a little.
        c.vy = -c.vy * 0.3
        c.vx *= 0.55
        c.vz *= 0.55
        c.spin *= 0.5
      } else {
        c.vx = c.vy = c.vz = 0
        c.rest = 0
        // Lying flat (a chip) or on its side (a splinter, a twig).
        c.pitch = c.kind === 0 ? (this.rand() < 0.5 ? 0 : Math.PI) : Math.PI / 2
      }
    }
  }

  get liveCount(): number {
    let n = 0
    for (const c of this.chips) if (c.live) n++
    return n
  }
}
