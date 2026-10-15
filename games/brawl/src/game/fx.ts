import { EXPLOSION_PRESETS, explosionFlashLight, explosionSettings, spawnExplosion, type ExplosionSettings } from "@arcade/kit/fx/explosion"
import { Particles, type ParticleSpec } from "@arcade/kit/fx/particles"
import type { SceneLight } from "@arcade/kit/gpu/scene-frame"
import { Flock } from "@arcade/kit/sim/boids"
import { mulberry32 } from "@arcade/kit/sim/rng"
import { onStage } from "../../shared/arena"
import { APRON, PIT_Y } from "../render/arena-mesh"
import { type FrameParts, SPRITE } from "../render/frame-parts"

type Rgb = readonly [number, number, number]

/** A short-lived ground or air sprite effect: expanding rings, swipes, flashes, poofs, the KO burst. */
type Transient = {
  kind: "ring" | "jagged" | "wedge" | "flash" | "poof" | "ko" | "stars"
  x: number
  y: number
  h: number
  t0: number
  life: number
  size: number
  color: Rgb
  rot: number
  extra: number
}

type Flash = { x: number; y: number; h: number; r: number; color: Rgb; power: number; t0: number; life: number }
type Boom = { x: number; y: number; t0: number; settings: ExplosionSettings }

/** A party blast: a bright fireball, pale smoke that clears fast, no scorch or burning fragments. */
export const PARTY_BLAST = explosionSettings({
  ...EXPLOSION_PRESETS.propane.settings,
  smokeAmount: 0.6,
  smokeDarkness: 0.18,
  smokeColorShift: 1,
  smokeLinger: 1.4,
  fragmentCount: 0,
  secondaryPops: 0,
  scorch: false,
})

const spark: ParticleSpec = { kind: "spark", life: 0.32, size: 0.05, growth: 0, gravity: 9, drag: 2.5, bounce: 0.3, r: 4, g: 3, b: 1.6, alpha: 1 }
const confetti: ParticleSpec = { kind: "debris", life: 1.6, size: 0.07, growth: 0, gravity: 7, drag: 2.2, bounce: 0.2, r: 1, g: 1, b: 1, alpha: 1 }
const chip: ParticleSpec = { kind: "debris", life: 1.3, size: 0.09, growth: 0, gravity: 16, drag: 1.2, bounce: 0.35, r: 0.55, g: 0.34, b: 0.16, alpha: 1 }
const dust: ParticleSpec = { kind: "soft", life: 0.8, size: 0.35, growth: 1.6, gravity: -0.4, drag: 3, bounce: 0, r: 0.95, g: 0.88, b: 0.86, alpha: 0.55 }
const fire: ParticleSpec = { kind: "fire", life: 0.55, size: 0.32, growth: 1.2, gravity: -3, drag: 2.5, bounce: 0, r: 1, g: 0.6, b: 0.2, alpha: 1, temperature: 1.2, turbulence: 0.8 }
const leaf: ParticleSpec = { kind: "debris", life: 1.1, size: 0.08, growth: 0, gravity: 6, drag: 2.6, bounce: 0.2, r: 0.3, g: 0.75, b: 0.25, alpha: 1 }

export const CONFETTI: Rgb[] = [[1, 0.31, 0.6], [0.26, 0.79, 0.75], [1, 0.82, 0.25], [0.56, 0.42, 1], [0.37, 0.83, 0.37], [1, 0.54, 0.24]]

/** Presentation effects: particles, sprite transients, flash lights, explosions and the bee flocks. */
export class Fx {
  readonly particles = new Particles()
  private transients: Transient[] = []
  private flashes: Flash[] = []
  private booms: Boom[] = []
  readonly flocks = new Map<number, { flock: Flock; seen: number; scatter: number; x: number; y: number; vx: number; vy: number }>()
  private rand = mulberry32(17)

  random(): number {
    return this.rand()
  }

  private add(t: Omit<Transient, "rot" | "extra" | "h"> & Partial<Pick<Transient, "rot" | "extra" | "h">>): void {
    this.transients.push({ rot: 0, extra: 0, h: 0.05, ...t })
  }

  sparks(x: number, y: number, h: number, n: number, speed = 6): void {
    for (let i = 0; i < n; i++) {
      const a = this.rand() * Math.PI * 2
      const s = speed * (0.4 + this.rand())
      this.particles.spawn(spark, x, h, y, Math.cos(a) * s, 1 + this.rand() * 4, Math.sin(a) * s, this.rand() * 100)
    }
  }

  confetti(x: number, y: number, h: number, n: number, speed = 5): void {
    for (let i = 0; i < n; i++) {
      const c = CONFETTI[i % CONFETTI.length]!
      const a = this.rand() * Math.PI * 2
      const s = speed * (0.3 + this.rand())
      this.particles.spawn({ ...confetti, r: c[0], g: c[1], b: c[2], life: confetti.life * (0.7 + this.rand() * 0.6) }, x, h, y, Math.cos(a) * s, 3 + this.rand() * 5, Math.sin(a) * s, this.rand() * 100)
    }
  }

  chips(x: number, y: number, n: number, color: Rgb = [0.55, 0.34, 0.16]): void {
    for (let i = 0; i < n; i++) {
      const a = this.rand() * Math.PI * 2
      const s = 2 + this.rand() * 5
      this.particles.spawn({ ...chip, r: color[0], g: color[1], b: color[2] }, x, 0.4 + this.rand() * 0.5, y, Math.cos(a) * s, 2 + this.rand() * 5, Math.sin(a) * s, this.rand() * 100)
    }
  }

  dust(x: number, y: number, n: number, radius = 0.6): void {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + this.rand()
      this.particles.spawn(dust, x + Math.cos(a) * radius * 0.4, 0.15, y + Math.sin(a) * radius * 0.4, Math.cos(a) * radius * 3, 0.4, Math.sin(a) * radius * 3, this.rand() * 100)
    }
  }

  fire(x: number, y: number, radius: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const a = this.rand() * Math.PI * 2
      const r = Math.sqrt(this.rand()) * radius
      this.particles.spawn(fire, x + Math.cos(a) * r, 0.25, y + Math.sin(a) * r, Math.cos(a) * 1.5, 1.5 + this.rand() * 2, Math.sin(a) * 1.5, this.rand() * 100)
    }
  }

  leaves(x: number, y: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const a = this.rand() * Math.PI * 2
      const s = 1 + this.rand() * 3
      this.particles.spawn(leaf, x, 0.3, y, Math.cos(a) * s, 2 + this.rand() * 3, Math.sin(a) * s, this.rand() * 100)
    }
  }

  ring(t: number, x: number, y: number, size: number, color: Rgb, life = 0.35, jagged = false): void {
    this.add({ kind: jagged ? "jagged" : "ring", x, y, t0: t, life, size, color })
  }

  swipe(t: number, x: number, y: number, aim: number, range: number, color: Rgb): void {
    this.add({ kind: "wedge", x, y, t0: t, life: 0.18, size: range, color, rot: aim, extra: 0.75 })
  }

  flash(t: number, x: number, y: number, h: number, size: number, color: Rgb, life = 0.15): void {
    this.add({ kind: "flash", x, y, h, t0: t, life, size, color })
  }

  poof(t: number, x: number, y: number, color: Rgb, size = 1): void {
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2
      this.add({ kind: "poof", x: x + Math.cos(a) * 0.3 * size, y: y + Math.sin(a) * 0.3 * size, h: 0.5 + this.rand() * 0.9, t0: t, life: 0.5 + this.rand() * 0.2, size: (0.35 + this.rand() * 0.2) * size, color, rot: a, extra: this.rand() * 6 })
    }
    this.flash(t, x, y, 1, 1.5 * size, [color[0] * 2, color[1] * 2, color[2] * 2], 0.2)
  }

  ko(t: number, x: number, y: number, dir: number, color: Rgb): void {
    this.add({ kind: "ko", x, y, t0: t, life: 0.95, size: 9.5, color, rot: dir })
    this.ring(t, x, y, 3.2, [color[0] * 3, color[1] * 3, color[2] * 3], 0.45, true)
    this.ring(t + 0.04, x, y, 2.2, [4, 3.6, 2.5], 0.35)
    this.light(t, x, y, 2.2, 18, color, 8, 0.65)
    this.sparks(x, y, 0.9, 28, 12)
    this.confetti(x, y, 0.6, 45, 11)
  }

  /** Streak of smoke and sparks behind a launched fighter. */
  launchTrail(t: number, x: number, y: number, vx: number, vy: number, color: Rgb): void {
    const sp = Math.hypot(vx, vy)
    if (sp < 5 || this.rand() > 0.65) return
    const ux = -vx / sp, uy = -vy / sp
    this.add({
      kind: "poof",
      x: x + ux * 0.35 + (this.rand() - 0.5) * 0.2,
      y: y + uy * 0.35 + (this.rand() - 0.5) * 0.2,
      h: 0.55 + this.rand() * 0.35,
      t0: t,
      life: 0.26 + this.rand() * 0.12,
      size: Math.min(0.65, 0.24 + sp * 0.018),
      color: [0.45 + color[0] * 0.55, 0.45 + color[1] * 0.55, 0.45 + color[2] * 0.55],
      rot: Math.atan2(uy, ux),
      extra: this.rand() * 6,
    })
    if (sp > 9.5 && this.rand() < 0.45) {
      this.particles.spawn(spark, x + ux * 0.3, 0.7, y + uy * 0.3, ux * 3 + (this.rand() - 0.5) * 2, 1.5 + this.rand() * 2, uy * 3 + (this.rand() - 0.5) * 2, this.rand() * 100)
    }
  }

  light(t: number, x: number, y: number, h: number, r: number, color: Rgb, power: number, life: number): void {
    this.flashes.push({ x, y, h, r, color, power, t0: t, life })
  }

  explode(t: number, x: number, y: number, settings: ExplosionSettings = PARTY_BLAST, scale = 1): void {
    spawnExplosion(this.particles, null, x, 0, y, settings, this.rand, scale)
    this.booms.push({ x, y, t0: t, settings })
    this.confetti(x, y, 0.6, 50, 10)
  }

  /** Stars circling a stunned head. */
  stars(fp: FrameParts, t: number, x: number, y: number, h: number): void {
    for (let i = 0; i < 3; i++) {
      const a = t * 5 + (i * Math.PI * 2) / 3
      fp.sprite(true, x + Math.cos(a) * 0.32, h + Math.sin(t * 7 + i) * 0.05, y + Math.sin(a) * 0.32, 0.12, 3, 2.6, 0.6, 1, SPRITE.glow)
    }
  }

  /** The lights this frame's effects cast. */
  lights(t: number, out: SceneLight[]): void {
    this.flashes = this.flashes.filter((f) => t - f.t0 < f.life)
    for (const f of this.flashes) out.push({ x: f.x, y: f.y, h: f.h, r: f.r, color: f.color, power: f.power * (1 - (t - f.t0) / f.life), size: 0.3 })
    this.booms = this.booms.filter((b) => t - b.t0 < 1.5)
    for (const b of this.booms) {
      const fl = explosionFlashLight(b.x, 0, b.y, t - b.t0, b.settings)
      if (fl) out.push({ x: fl.x, y: fl.z, h: fl.y, r: fl.radius, color: [fl.r, fl.g, fl.b], power: fl.power * 0.5, size: 0.3 })
    }
  }

  step(dt: number): void {
    this.particles.update(dt, [], (x, z) => (onStage(x, z, APRON) ? 0 : PIT_Y))
  }

  /** Draws the transients and drops the finished ones. */
  draw(fp: FrameParts, t: number): void {
    this.transients = this.transients.filter((e) => t - e.t0 < e.life)
    for (const e of this.transients) {
      const u = (t - e.t0) / e.life
      const [r, g, b] = e.color
      switch (e.kind) {
        case "ring":
        case "jagged": {
          const s = e.size * (0.25 + 0.75 * (1 - (1 - u) ** 3))
          fp.sprite(true, e.x, e.h, e.y, s, r, g, b, 1 - u, e.kind === "ring" ? SPRITE.ring : SPRITE.jagged, 0, 0.12 * (1 - u) + 0.02, u * 3)
          break
        }
        case "wedge":
          fp.sprite(true, e.x, 0.6, e.y, e.size, r, g, b, (1 - u) * 0.9, SPRITE.wedge, e.rot, 0, e.extra)
          break
        case "flash":
          fp.sprite(true, e.x, e.h, e.y, e.size * (0.6 + u * 0.6), r, g, b, 1 - u, SPRITE.glow)
          break
        case "poof": {
          const k = 1 - u
          fp.sprite(false, e.x + Math.cos(e.rot) * u * 0.6, e.h + u * 0.5, e.y + Math.sin(e.rot) * u * 0.6, e.size * (0.6 + u * 0.8), r, g, b, k * k, SPRITE.puff, 0, 0, e.extra)
          break
        }
        case "ko": {
          // A star burst of rays from where the fighter left the stage, Smash style.
          for (let i = 0; i < 13; i++) {
            const a = e.rot + (i - 6) * 0.17
            const len = e.size * (0.35 + 0.65 * Math.min(1, u * 3.4)) * (0.55 + 0.45 * ((i * 7) % 3) / 2)
            fp.sprite(true, e.x + Math.cos(a) * len * 0.5, 1.2, e.y + Math.sin(a) * len * 0.5, len * 0.5, r * 3.4, g * 3.4, b * 3.4, (1 - u) ** 1.4, SPRITE.line, a, 0.075, 0)
          }
          fp.sprite(true, e.x, 1.2, e.y, 3.6 * (1 - u) + 0.6, 4, 4, 4, (1 - u) ** 1.8, SPRITE.glow)
          break
        }
        case "stars":
          break
      }
    }
  }
}
