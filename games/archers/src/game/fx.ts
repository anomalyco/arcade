import { type ParticleSpec, Particles } from "@arcade/kit/fx/particles"
import { MAX_LIGHTS } from "../render/shaders"
import { QUAD_FLOATS } from "../render/renderer"

export type Rgb = readonly [number, number, number]

/** Quad kinds (see quadShader). */
export const Q = { glow: 0, ring: 1, diamond: 2, streak: 3, disc: 4, mist: 5, star: 6, bar: 7 } as const

/** A growable list of camera-facing quads. */
export class Quads {
  data = new Float32Array(QUAD_FLOATS * 256)
  count = 0
  reset(): void {
    this.count = 0
  }
  /** Centre, half width, half height, rotation, kind, linear colour and alpha, colour retention, seed. */
  push(x: number, y: number, z: number, hw: number, hh: number, rot: number, kind: number, c: Rgb, a: number, keep = 1, seed = 0): void {
    if ((this.count + 1) * QUAD_FLOATS > this.data.length) {
      const next = new Float32Array(this.data.length * 2)
      next.set(this.data)
      this.data = next
    }
    const o = this.count++ * QUAD_FLOATS
    const d = this.data
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = hw
    d[o + 4] = hh; d[o + 5] = 0; d[o + 6] = rot; d[o + 7] = kind
    d[o + 8] = c[0]; d[o + 9] = c[1]; d[o + 10] = c[2]; d[o + 11] = a
    d[o + 12] = keep; d[o + 13] = 0; d[o + 14] = seed; d[o + 15] = 0
  }
  /** A bar from (x0, y0) to (x1, y1) with half thickness `w`. */
  line(x0: number, y0: number, x1: number, y1: number, z: number, w: number, kind: number, c: Rgb, a: number, keep = 1): void {
    const dx = x1 - x0, dy = y1 - y0
    const l = Math.hypot(dx, dy)
    if (l < 1e-4) return
    this.push((x0 + x1) / 2, (y0 + y1) / 2, z, l / 2, w, Math.atan2(dy, dx), kind, c, a, keep)
  }
}

/** Point lights: position, radius, colour, power, packed as the shaders read them. */
export class Lights {
  data = new Float32Array(MAX_LIGHTS * 8)
  count = 0
  reset(): void {
    this.count = 0
  }
  push(x: number, y: number, z: number, radius: number, c: Rgb, power: number): void {
    if (this.count >= MAX_LIGHTS || power <= 0.001) return
    const o = this.count++ * 8
    this.data.set([x, y, z, radius, c[0], c[1], c[2], power], o)
  }
}

/** Fire is the only warm light in the scene; arrows burn the same colours. */
export const FIRE: Rgb = [1.0, 0.42, 0.1]
export const EMBER: Rgb = [1.0, 0.55, 0.18]

const spec = (s: Partial<ParticleSpec> & Pick<ParticleSpec, "kind">): ParticleSpec => ({
  life: 1, size: 0.1, growth: 0, gravity: 0, drag: 0, bounce: 0, r: 1, g: 1, b: 1, alpha: 1, ...s,
})

/** Particle recipes in tile units (1 tile ≈ 0.75 m). Particles fall along -y, the plane's down. */
export const P = {
  ember: spec({ kind: "spark", life: 1.8, size: 0.018, gravity: -0.6, drag: 0.6, r: 2.2, g: 0.7, b: 0.12, turbulence: 1.4 }),
  spark: spec({ kind: "spark", life: 0.35, size: 0.03, gravity: 14, drag: 1.5, bounce: 0.3, r: 2.4, g: 1.1, b: 0.35 }),
  chip: spec({ kind: "debris", life: 1.1, size: 0.07, gravity: 26, drag: 0.6, bounce: 0.35, r: 0.08, g: 0.08, b: 0.085 }),
  dust: spec({ kind: "soft", life: 0.7, size: 0.22, growth: 0.9, gravity: -0.4, drag: 3, r: 0.32, g: 0.32, b: 0.34, alpha: 0.35 }),
  feather: spec({ kind: "debris", life: 2.6, size: 0.09, gravity: 2.6, drag: 2.4, r: 0.02, g: 0.02, b: 0.022, turbulence: 2.5 }),
  cloth: spec({ kind: "debris", life: 1.8, size: 0.06, gravity: 9, drag: 1.4, bounce: 0.2, r: 0.03, g: 0.03, b: 0.035 }),
  fireball: spec({ kind: "fireball", life: 0.55, size: 0.9, growth: 1.6, gravity: -2, drag: 2, r: 1, g: 1, b: 1, temperature: 1800 }),
  smoke: spec({ kind: "soft", life: 2.2, size: 0.6, growth: 1.4, gravity: -1.2, drag: 1.6, r: 0.06, g: 0.06, b: 0.065, alpha: 0.6 }),
  shock: spec({ kind: "shock", life: 0.35, size: 0.4, growth: 9, r: 1.6, g: 0.8, b: 0.4, alpha: 0.8 }),
  leaf: spec({ kind: "debris", life: 1.6, size: 0.06, gravity: 5, drag: 2, r: 0.03, g: 0.05, b: 0.02, turbulence: 2 }),
}

type Flash = { x: number; y: number; z: number; r: number; c: Rgb; p: number; decay: number }
type Ring = { x: number; y: number; t: number; dur: number; r0: number; r1: number; c: Rgb; a: number; kind: number }
type Beam = { pts: number[]; t: number; c: Rgb }

/**
 * Presentation effects: kit particles (embers, sparks, stone chips, feathers, dust, fire), short light flashes, rings
 * and laser beams. Nothing here touches the sim.
 */
export class Fx {
  readonly particles = new Particles()
  private flashes: Flash[] = []
  private rings: Ring[] = []
  private beams: Beam[] = []
  private seed = 1

  constructor() {
    this.particles.windX = 0.3
    this.particles.windZ = 0
  }

  rnd(): number {
    this.seed = (this.seed * 16807) % 2147483647
    return (this.seed - 1) / 2147483646
  }

  spawn(s: ParticleSpec, x: number, y: number, z: number, vx = 0, vy = 0, vz = 0): void {
    this.particles.spawn(s, x, y, z, vx, vy, vz, this.rnd() * 1000)
  }

  burst(s: ParticleSpec, n: number, x: number, y: number, z: number, speed: number, dirX = 0, dirY = 0, spread = 1): void {
    for (let i = 0; i < n; i++) {
      const a = this.rnd() * Math.PI * 2
      const v = speed * (0.35 + this.rnd() * 0.65)
      this.spawn(s, x, y, z + (this.rnd() - 0.5) * 0.3, dirX * speed + Math.cos(a) * v * spread, dirY * speed + Math.sin(a) * v * spread, (this.rnd() - 0.5) * speed * 0.3)
    }
  }

  flash(x: number, y: number, r: number, c: Rgb, p: number, decay = 10, z = 0.4): void {
    this.flashes.push({ x, y, z, r, c, p, decay })
  }

  ring(x: number, y: number, r0: number, r1: number, dur: number, c: Rgb, a = 1, kind: number = Q.ring): void {
    this.rings.push({ x, y, t: 0, dur, r0, r1, c, a, kind })
  }

  beam(pts: number[], c: Rgb): void {
    this.beams.push({ pts, t: 0, c })
  }

  update(dt: number): void {
    this.particles.update(dt, [], () => -1e6)
    for (const f of this.flashes) f.p *= Math.exp(-dt * f.decay)
    this.flashes = this.flashes.filter((f) => f.p > 0.02)
    for (const r of this.rings) r.t += dt
    this.rings = this.rings.filter((r) => r.t < r.dur)
    for (const b of this.beams) b.t += dt
    this.beams = this.beams.filter((b) => b.t < 0.35)
  }

  emit(add: Quads, lights: Lights): void {
    for (const f of this.flashes) {
      lights.push(f.x, f.y, f.z, f.r, f.c, f.p)
      add.push(f.x, f.y, f.z + 0.3, f.r * 0.22, f.r * 0.22, 0, Q.glow, f.c, Math.min(0.55, f.p * 0.07), 1)
    }
    for (const r of this.rings) {
      const u = r.t / r.dur
      const e = 1 - (1 - u) * (1 - u)
      const rad = r.r0 + (r.r1 - r.r0) * e
      add.push(r.x, r.y, 0.5, rad, rad, 0, r.kind, r.c, r.a * (1 - u), 1)
    }
    for (const b of this.beams) {
      const k = 1 - b.t / 0.35
      for (let i = 0; i + 3 < b.pts.length; i += 2) {
        const x0 = b.pts[i]!, y0 = b.pts[i + 1]!, x1 = b.pts[i + 2]!, y1 = b.pts[i + 3]!
        if (Number.isNaN(x0) || Number.isNaN(x1)) continue
        add.line(x0, y0, x1, y1, 0.3, 0.05 * k + 0.02, Q.bar, [3 * b.c[0], 3 * b.c[1], 3 * b.c[2]], k, 1)
        add.line(x0, y0, x1, y1, 0.3, 0.28 * k, Q.bar, b.c, 0.35 * k, 1)
        const mx = (x0 + x1) / 2, my = (y0 + y1) / 2
        if (i % 4 === 0) lights.push(mx, my, 0.6, 3, b.c, 2 * k)
      }
    }
  }
}
