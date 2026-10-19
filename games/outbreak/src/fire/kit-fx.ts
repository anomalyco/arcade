import { resolveExplosionSettings, spawnExplosion, type ExplosionSettings } from "@arcade/kit/fx/explosion"
import { PARTICLE_STRIDE, type Particles, type ParticleSpec } from "@arcade/kit/fx/particles"
import type { AIAgent } from "@arcade/kit/sim/ai"
import type { StoreState } from "@arcade/kit/sim/ledger"
import {
  blastAge,
  BURN_RING,
  burnZombie,
  burning,
  CRACK_BEAT,
  CRACK_RING,
  crackerAt,
  crackerPops,
  dynamiteAt,
  DYN_RING,
  FIRE_RING,
  fireLit,
  lifeAge,
  ringId,
  SCORCH_RING,
} from "../../shared/fire/fire"
import { nozzle, sprayers, type FireFrame } from "./fx"

/**
 * Outbreak's fire on the kit explosion's look (`@arcade/kit/fx`): every flame is a `fireball` billow (blackbody core
 * that crusts into soot as it ages, warped noise lobes), embers are hot `spark`s, smoke is lit `smoke` billows, scorch
 * is the kit's noise `scorch` decal, and a blast is `spawnExplosion` itself. Births are presentation-only and local
 * (seeded per client); the rules stay in the ledger stores that every client shares.
 *
 * Budgets: the kit pool holds 2,048 particles. At default density the stream keeps about 60 alive, a burning figure
 * about 25, a 1.4 m fire about 40 and a dynamite blast about 150 for a second. Sources outside `RANGE` of the camera
 * emit nothing.
 */

const RANGE = 30

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}

const BURN_BONES = ["torso", "torso", "torso", "head", "pelvis", "pelvis", "left.upperArm", "right.upperArm", "left.foreArm", "right.foreArm", "left.thigh", "right.thigh"] as const

const spec = (): ParticleSpec => ({ kind: "fireball", life: 0.5, size: 0.2, growth: 0, gravity: 0, drag: 0, bounce: 0, r: 1, g: 1, b: 1, alpha: 1, temperature: 1, turbulence: 0.8, ease: 1 })

/** The kit blast for a stick of dynamite: a fuel-barrel fireball sized to the blast radius, no scorch of its own. */
export function dynamiteBlast(radius: number, size: number, flash: number): ExplosionSettings {
  return resolveExplosionSettings("barrel", { scorch: false, size: Math.max(0.4, (radius / 4.8) * size), flash, smoke: 1 })
}

export class FlameFx {
  private readonly s = spec()
  private readonly carry = new Map<string, { c: number; f: number }>()
  /** One-shot events already fired (blasts, molotov bursts, cracker pops), by key, with when they were seen. */
  private readonly fired = new Map<string, number>()
  private frameNo = 0
  private seed = 0x2f6b4c1d
  private readonly random = () => {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0
    return this.seed / 4294967296
  }
  /** Proof readout of the last frame's births. */
  readonly shown = { births: 0, blasts: 0, stamps: 0 }

  reset(): void {
    this.carry.clear()
    this.fired.clear()
  }

  /** Births due this frame for continuous source `key` at `rate` per second (fractions carry over; at most 48). */
  private births(key: string, rate: number, dt: number): number {
    let e = this.carry.get(key)
    if (!e) this.carry.set(key, (e = { c: this.random(), f: 0 }))
    e.f = this.frameNo
    e.c += Math.max(0, rate) * dt
    const n = Math.min(48, Math.floor(e.c))
    e.c -= n
    return n
  }

  private once(key: string, time: number): boolean {
    if (this.fired.has(key)) return false
    this.fired.set(key, time)
    return true
  }

  private spawn(p: Particles, x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    if (p.spawn(this.s, x, y, z, vx, vy, vz, this.random() * 6.283)) this.shown.births++
  }

  /** A flame billow: hot, rising, rolling; `heat` scales its blackbody temperature, `emit` its brightness. */
  private flame(p: Particles, frame: FireFrame, x: number, y: number, z: number, vx: number, vy: number, vz: number, o: { life: number; size: number; grow: number; heat: number; rise?: number; drag?: number }): void {
    const look = frame.look
    const s = this.s
    s.kind = "fireball"
    s.life = o.life
    s.size = o.size * look.flameSize
    s.growth = (o.grow * look.flameSize) / o.life
    s.gravity = -(o.rise ?? 3)
    s.drag = o.drag ?? 3
    s.bounce = 0
    s.r = 0.5 * look.flameBrightness
    s.g = s.b = 1
    s.alpha = 0.86
    s.temperature = o.heat * look.flameHeat
    s.turbulence = (0.75 + 0.4 * this.random()) * look.flameTurbulence
    s.ease = 2.2
    s.trail = 0
    s.pop = 0
    this.spawn(p, x, y, z, vx, vy, vz)
  }

  /** A slow ember spiralling up off a fire. */
  private ember(p: Particles, x: number, y: number, z: number, vx: number, vz: number, heat = 1): void {
    const s = this.s
    s.kind = "spark"
    s.life = 0.7 + this.random() * 0.9
    s.size = 0.05 + this.random() * 0.025
    s.growth = -0.02
    s.gravity = -1.1 - this.random() * 0.8
    s.drag = 1.8
    s.bounce = 0
    s.r = 1
    s.g = 0.6
    s.b = 0.2
    s.alpha = 0.9
    s.temperature = (0.8 + this.random() * 0.4) * heat
    s.turbulence = 0
    s.ease = 1
    this.spawn(p, x, y, z, vx + (this.random() - 0.5) * 0.9, 0.6 + this.random() * 1.2, vz + (this.random() - 0.5) * 0.9)
  }

  /** A puff of soot rising off a fire: dark, lit only by the fire under it and whatever else reaches it. */
  private soot(p: Particles, frame: FireFrame, x: number, y: number, z: number, o: { size: number; life: number; alpha: number; shade?: number; vx?: number; vz?: number; rise?: number }): void {
    const s = this.s
    const c = o.shade ?? 0.11
    s.kind = "smoke"
    s.life = o.life * (0.85 + 0.3 * this.random())
    s.size = o.size * (0.85 + 0.3 * this.random())
    s.growth = (o.size * 1.6) / o.life
    s.gravity = -(o.rise ?? 0.5)
    s.drag = 0.9
    s.bounce = 0
    s.r = c
    s.g = c * 0.95
    s.b = c * 0.9
    s.alpha = clamp01(o.alpha * frame.look.fireSmoke)
    s.temperature = 0
    s.turbulence = 0.8
    s.ease = 1.6
    if (s.alpha > 0.01) this.spawn(p, x, y, z, o.vx ?? 0, 0.5 + this.random() * 0.4, o.vz ?? 0)
  }

  /** A decal shown this frame only: the kit's noise scorch, `fresh` with its glowing char while just laid. */
  private scorch(p: Particles, x: number, y: number, z: number, r: number, rot: number, alpha: number, fresh: boolean): void {
    const s = this.s
    s.kind = "scorch"
    s.life = 1e-3
    s.size = r
    s.growth = 0
    s.gravity = 0
    s.drag = 0
    s.bounce = 0
    s.r = 0.035
    s.g = 0.031
    s.b = 0.028
    s.alpha = alpha
    s.temperature = 0
    s.turbulence = 0
    s.ease = 1
    if (!p.spawn(s, x, y, z, 0, 0, 0, rot)) return
    // Pose its age so the kit's scorch fade sits near full (and its fresh char glows) until the next update drops it.
    p.data[(p.count - 1) * PARTICLE_STRIDE + 7] = s.life * (fresh ? 0.07 : 0.16)
    this.shown.stamps++
  }

  /**
   * This frame's births into `p` (call after `p.update`, so this frame's decals survive to the draw). Reads only the
   * ledger stores and the drawn survivors and bones.
   */
  emit(p: Particles, frame: FireFrame, dt: number): void {
    this.frameNo++
    this.shown.births = this.shown.blasts = this.shown.stamps = 0
    const { view, look, support } = frame
    const time = view.time
    const dens = Math.max(0.2, look.flameDensity)
    const embers = Math.max(0, look.fireEmbers)
    const cx = view.player.x
    const cz = view.player.y
    const near = (x: number, z: number) => Math.abs(x - cx) < RANGE && Math.abs(z - cz) < RANGE
    const ledger = view.progression.ledger
    const ring = (prefix: string, size: number, fn: (st: StoreState, k: number) => void) => {
      for (let k = 0; k < size; k++) {
        const st = ledger.store(ringId(prefix, k))
        if (st) fn(st, k)
      }
    }
    const r = this.random

    // ── The stream: a rolling jet, white-hot at the nozzle, slowing, swelling and rising as it licks out ──
    const tan = Math.tan((look.flameCone * Math.PI) / 180)
    for (const { s, reach, since } of sprayers(frame)) {
      const g = support(s.x, s.y)
      const n0 = nozzle(s, g)
      const dx = Math.cos(s.aim)
      const dz = Math.sin(s.aim)
      const len = reach * (0.3 + 0.7 * smooth(0, 0.16, time - since))
      const key = `stream:${s.id}`
      const n = this.births(key, 64 * dens, dt)
      for (let i = 0; i < n; i++) {
        const life = 0.42 + r() * 0.2
        const drag = 2.3
        // Distance travelled under drag is v/drag·(1 − e^(−drag·life)); aim each billow to die about at the reach.
        const v = ((len * (0.7 + 0.35 * r())) * drag) / (1 - Math.exp(-drag * life))
        const lat = (r() - 0.5) * 2 * tan * 0.85
        const ver = (r() - 0.45) * tan * 0.6
        const vx = (dx - dz * lat) * v
        const vz = (dz + dx * lat) * v
        const k = r() * 0.15
        this.flame(p, frame, n0.x + dx * k, n0.y + (r() - 0.5) * 0.04, n0.z + dz * k, vx, ver * v, vz, {
          life,
          size: 0.07 + r() * 0.04,
          grow: 0.34 + 0.22 * r() + len * 0.03,
          heat: 1.2 + 0.25 * r(),
          rise: 3.4,
          drag,
        })
      }
      // The hot throat: small, short, bright billows right out of the nozzle.
      for (let i = this.births(`${key}:core`, 30 * dens, dt); i > 0; i--) {
        const v = 6 + r() * 4
        this.flame(p, frame, n0.x, n0.y, n0.z, dx * v, (r() - 0.5) * 0.4, dz * v, { life: 0.12 + r() * 0.06, size: 0.07, grow: 0.16, heat: 1.6, rise: 0.5, drag: 4 })
      }
      const ex = n0.x + dx * len * 0.85
      const ez = n0.z + dz * len * 0.85
      const eg = support(ex, ez)
      for (let i = this.births(`${key}:ember`, 16 * embers, dt); i > 0; i--) this.ember(p, ex + (r() - 0.5) * len * 0.4, eg + 0.6 + r() * 0.6, ez + (r() - 0.5) * len * 0.4, dx * 1.5, dz * 1.5, 1.1)
      for (let i = this.births(`${key}:smoke`, 9, dt); i > 0; i--) {
        const u = 0.5 + r() * 0.5
        this.soot(p, frame, n0.x + dx * len * u, eg + 1.3 + r() * 0.5, n0.z + dz * len * u, { size: 0.55, life: 2.8, alpha: 0.55, vx: dx * 0.8, vz: dz * 0.8, rise: 0.7 })
      }
    }

    // ── Burning figures: flames licking up the body from its bones, soot and embers off the head ──
    let agents: Map<number, AIAgent> | null = null
    ring("burn", BURN_RING, (st) => {
      const id = burnZombie(st)
      if (id < 0) return
      agents ??= new Map(view.zombies.map((a) => [a.id, a]))
      const z = agents.get(id)
      if (!z || !near(z.x, z.y)) return
      const g = support(z.x, z.y)
      const key = `burn:${id}`
      if (burning(st, time)) {
        const t0 = (st.counts.t ?? 0) / 10
        const until = (st.counts.until ?? 0) / 10
        const lvl = smooth(0, 0.35, time - t0) * clamp01((until - time) / 1.2)
        const bones = frame.bones?.(id)
        const vx = z.vx * 0.8
        const vz = z.vy * 0.8
        for (let i = this.births(key, 38 * dens * lvl, dt); i > 0; i--) {
          const name = BURN_BONES[Math.floor(r() * BURN_BONES.length)]!
          const b = bones?.[name]
          const px = (b ? b.p[0] : z.x) + (r() - 0.5) * 0.18
          const py = (b ? b.p[1] : g + 0.5 + r() * 1.1) + (r() - 0.3) * 0.12
          const pz = (b ? b.p[2] : z.y) + (r() - 0.5) * 0.18
          this.flame(p, frame, px, py, pz, vx + (r() - 0.5) * 0.4, 1.1 + r() * 0.9, vz + (r() - 0.5) * 0.4, {
            life: 0.32 + r() * 0.22,
            size: 0.1 + r() * 0.07,
            grow: 0.28 + r() * 0.12,
            heat: 0.95 + r() * 0.25,
            rise: 3.2,
          })
        }
        const head = bones?.head
        const hy = head ? head.p[1] : g + 1.6
        for (let i = this.births(`${key}:smoke`, 5 * lvl, dt); i > 0; i--) this.soot(p, frame, z.x, hy + 0.3, z.y, { size: 0.4, life: 2.4, alpha: 0.5, vx, vz })
        for (let i = this.births(`${key}:ember`, 4 * embers * lvl, dt); i > 0; i--) this.ember(p, z.x + (r() - 0.5) * 0.3, hy, z.y + (r() - 0.5) * 0.3, vx, vz)
      } else if (st.counts.dead) {
        // Charred and down: a dull red smoulder and a thin smoke for a while.
        const age = time - (st.counts.dead ?? 0) / 10
        if (age < 0 || age > 16) return
        const k = 1 - age / 16
        for (let i = this.births(`${key}:glow`, 3 * k, dt); i > 0; i--) {
          this.flame(p, frame, z.x + (r() - 0.5) * 0.7, g + 0.08, z.y + (r() - 0.5) * 0.7, 0, 0.25, 0, { life: 0.6 + r() * 0.3, size: 0.1, grow: 0.12, heat: 0.42, rise: 0.4, drag: 2 })
        }
        for (let i = this.births(`${key}:smoke`, 1.6 * k, dt); i > 0; i--) this.soot(p, frame, z.x + (r() - 0.5) * 0.5, g + 0.25, z.y + (r() - 0.5) * 0.5, { size: 0.3, life: 3, alpha: 0.4 * k, rise: 0.3 })
      }
    })

    // ── Fire on the ground: molotov pools and the fire the stream lays ──
    ring("fire", FIRE_RING, (st, k) => {
      if (!fireLit(st, time) || !st.at || !near(st.at.x, st.at.y)) return
      const { x, y } = st.at
      const rad = (st.counts.r ?? 0) / 100
      const t0 = (st.counts.t ?? 0) / 10
      const lvl = smooth(0, 0.12, time - t0) * (1 - smooth(0.65, 1, lifeAge(st, time)))
      const g = support(x, y)
      const key = `fire:${k}:${st.counts.t}`
      // A molotov bursting: the kit's small pop, no shock ring or shrapnel, sized to the pool.
      if (st.counts.src === 1 && time - t0 < 0.25 && this.once(key, time)) {
        const burst = resolveExplosionSettings("pop", { shockRing: 0, debrisCount: 0, sparkCount: 18, scorch: false, smoke: 0.6, size: Math.max(0.6, rad * 0.75) * look.flameSize, flash: 0 })
        spawnExplosion(p, null, x, g, y, burst, r)
        this.shown.blasts++
      }
      const rate = (9 + rad * rad * 26) * dens * lvl
      for (let i = this.births(key, rate, dt); i > 0; i--) {
        const rr = Math.sqrt(r()) * rad * 0.85
        const a = r() * Math.PI * 2
        const fx = x + Math.cos(a) * rr
        const fz = y + Math.sin(a) * rr
        const edge = 1 - 0.45 * (rr / Math.max(0.1, rad))
        this.flame(p, frame, fx, support(fx, fz) + 0.05, fz, (r() - 0.5) * 0.3, 0.8 + r() * 0.9 * edge, (r() - 0.5) * 0.3, {
          life: (0.3 + r() * 0.24) * (0.75 + 0.35 * edge),
          size: (0.07 + r() * 0.05) * (0.8 + 0.3 * Math.sqrt(rad)),
          grow: (0.16 + 0.12 * r()) * (0.8 + 0.4 * edge),
          heat: 0.85 + r() * 0.3,
          rise: 3.6,
        })
      }
      for (let i = this.births(`${key}:smoke`, (1 + rad * 2.5) * lvl, dt); i > 0; i--) {
        this.soot(p, frame, x + (r() - 0.5) * rad, g + 0.9 + rad * 0.3, y + (r() - 0.5) * rad, { size: 0.35 + rad * 0.25, life: 2.6 + rad, alpha: 0.45 })
      }
      if (rad > 0.9) for (let i = this.births(`${key}:ember`, 2.5 * rad * embers * lvl, dt); i > 0; i--) this.ember(p, x + (r() - 0.5) * rad, g + 0.4, y + (r() - 0.5) * rad, 0, 0)
    })

    // ── Dynamite: the fuse spitting, then the kit blast ──
    ring("dyn", DYN_RING, (st, k) => {
      if (!st.counts.t || !st.at) return
      const age = blastAge(st, time)
      if (age < 0) {
        const q = dynamiteAt(st, time)
        if (!near(q.x, q.y)) return
        const fy = support(q.x, q.y) + q.h + 0.08
        const s = this.s
        for (let i = this.births(`dyn:${k}:fuse`, 26, dt); i > 0; i--) {
          s.kind = "spark"
          s.life = 0.18 + r() * 0.2
          s.size = 0.045
          s.growth = -0.05
          s.gravity = 6
          s.drag = 1.2
          s.bounce = 0.3
          s.r = 1
          s.g = 0.75
          s.b = 0.3
          s.alpha = 1
          s.temperature = 1.3
          s.turbulence = 0
          s.ease = 1
          const a = r() * Math.PI * 2
          this.spawn(p, q.x, fy, q.y, Math.cos(a) * (0.8 + r()), 0.8 + r() * 1.4, Math.sin(a) * (0.8 + r()))
        }
        for (let i = this.births(`dyn:${k}:spit`, 14, dt); i > 0; i--) this.flame(p, frame, q.x, fy, q.y, 0, 0.3, 0, { life: 0.12, size: 0.05, grow: 0.08, heat: 1.4, rise: 1 })
        return
      }
      const key = `dyn:${k}:${st.counts.t}`
      if (age > 0.5 || !near(st.at.x, st.at.y) || !this.once(key, time)) return
      const g = support(st.at.x, st.at.y)
      spawnExplosion(p, null, st.at.x, g, st.at.y, dynamiteBlast(look.dynRadius, look.blastSize, look.blastFlash), r, 1, 1, { distanceToEye: Math.hypot(st.at.x - cx, st.at.y - cz) })
      // The plume that hangs after the fireball crusts over.
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 + r()
        const out = 0.6 + r() * 1.4
        this.soot(p, frame, st.at.x + Math.cos(a) * out, g + 1 + r() * 1.5, st.at.y + Math.sin(a) * out, { size: 1.1, life: 5 + r() * 2, alpha: 0.6, shade: 0.09, vx: Math.cos(a) * 1.2, vz: Math.sin(a) * 1.2, rise: 0.45 })
      }
      this.shown.blasts++
    })

    // ── Firecrackers: a hot pop and a spray of sparks on each bang ──
    ring("crack", CRACK_RING, (st, k) => {
      if (!fireLit(st, time) || !st.at) return
      const at = crackerAt(st, time)
      if (!near(at.x, at.y)) return
      const since = time - (st.counts.t ?? 0) / 10
      const beat = Math.floor(since / CRACK_BEAT)
      if (!crackerPops(st.counts.t ?? 0, beat) || !this.once(`crack:${k}:${st.counts.t}:${beat}`, time)) return
      const g = support(at.x, at.y)
      this.flame(p, frame, at.x, g + 0.15, at.y, 0, 0.6, 0, { life: 0.16, size: 0.12, grow: 0.25, heat: 1.5, rise: 1 })
      const s = this.s
      for (let i = 0; i < 9; i++) {
        s.kind = "spark"
        s.life = 0.2 + r() * 0.25
        s.size = 0.045
        s.growth = -0.05
        s.gravity = 9
        s.drag = 1.4
        s.bounce = 0.3
        s.r = 1
        s.g = 0.8
        s.b = 0.4
        s.alpha = 1
        s.temperature = 1.2
        s.turbulence = 0
        s.ease = 1
        const a = r() * Math.PI * 2
        this.spawn(p, at.x, g + 0.12, at.y, Math.cos(a) * (2 + r() * 2.5), 1 + r() * 2, Math.sin(a) * (2 + r() * 2.5))
      }
      this.soot(p, frame, at.x, g + 0.3, at.y, { size: 0.25, life: 1.8, alpha: 0.35, shade: 0.2 })
    })

    // ── Scorch marks and craters: the kit's noise char, redrawn each frame from the scorch stores ──
    if (look.fireChar > 0) {
      ring("scorch", SCORCH_RING, (st, k) => {
        if (!st.at || !st.counts.r || !near(st.at.x, st.at.y)) return
        const rad = (st.counts.r ?? 0) / 100
        const age = time - (st.counts.t ?? 0) / 10
        const grow = Math.min(1, Math.max(0.05, age / 0.35))
        const crater = Boolean(st.counts.crater)
        const rot = (((k * 2654435761) >>> 0) % 6283) / 1000
        this.scorch(p, st.at.x, support(st.at.x, st.at.y) + 0.026 + (k % 8) * 0.0015, st.at.y, rad * (crater ? 1.25 : 1.05) * (0.6 + 0.4 * grow), rot, Math.min(1, look.fireChar * (crater ? 1.1 : 1)), age < 1.2)
      })
    }

    // Forget sources and events that have gone.
    if (this.frameNo % 60 === 0) {
      for (const [key, e] of this.carry) if (this.frameNo - e.f > 30) this.carry.delete(key)
      for (const [key, at] of this.fired) if (time - at > 40 || time < at) this.fired.delete(key)
    }
  }
}
