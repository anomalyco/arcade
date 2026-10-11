import { WORLD_H, WORLD_W, type Mask } from "../../sim/terrain"
import { WEAPONS, type WeaponId } from "../../sim/weapons"
import { glowSprite, mixHex, rgba, smokeSprite } from "./util"

const enum K {
  Spark,
  Ember,
  Debris,
  Smoke,
  Flame,
  Glow,
  Dust,
  Swirl,
  Fireball,
}

interface Particle {
  k: K
  x: number
  y: number
  vx: number
  vy: number
  life: number
  max: number
  size: number
  color: string
  drag: number
  grav: number
  rot: number
  vr: number
  delay: number
  shape: number
  // swirl target
  cx: number
  cy: number
  st?: BoomStyle
}

interface Ring {
  x: number
  y: number
  r0: number
  r1: number
  life: number
  max: number
  color: string
  width: number
  delay: number
  fill: boolean
}

interface Light {
  x: number
  y: number
  r: number
  color: string
  life: number
  max: number
  delay: number
}

interface Text {
  x: number
  y: number
  text: string
  color: string
  size: number
  life: number
  max: number
  sub: string
}

interface Beam {
  x: number
  y: number
  color: string
  life: number
  max: number
}

interface Wall {
  x: number
  y: number
  w: number
  h: number
  life: number
  max: number
  color: string
}

interface Streak {
  x0: number
  y0: number
  x1: number
  y1: number
  life: number
  max: number
  color: string
  delay: number
}

const MAX_PARTICLES = 1800

export interface BoomStyle {
  core: string
  fire: string
  outer: string
  ring: string
  spark: string
}

function style(kind: WeaponId | "bomblet"): BoomStyle {
  switch (kind) {
    case "shell":
      return { core: "#fff1d6", fire: "#ff7a1e", outer: "#e8402a", ring: "#ffb066", spark: "#ffa63a" }
    case "cluster":
    case "bomblet":
      return { core: "#fff0fb", fire: "#ff4fd8", outer: "#b63dff", ring: "#ff8ae6", spark: "#ff6ad5" }
    case "mirv":
      return { core: "#f4f0ff", fire: "#9b8cff", outer: "#5a3dff", ring: "#c5bcff", spark: "#b3a8ff" }
    case "drill":
      return { core: "#eaffff", fire: "#3ee8ff", outer: "#2a7bff", ring: "#9ff4ff", spark: "#6ff2ff" }
    case "napalm":
      return { core: "#fff1c4", fire: "#ff6a1e", outer: "#ff2e1e", ring: "#ffae5a", spark: "#ffcf4a" }
    case "gravity":
      return { core: "#f6e8ff", fire: "#c06bff", outer: "#6a2dff", ring: "#dcaaff", spark: "#d08aff" }
    case "builder":
      return { core: "#f2ffe0", fire: "#a6ff4d", outer: "#3dff7a", ring: "#c8ff8a", spark: "#b6ff6a" }
    case "airstrike":
      return { core: "#fffbe0", fire: "#ffd23a", outer: "#ff8a1f", ring: "#ffe98a", spark: "#ffe16a" }
    case "bouncer":
      return { core: "#eafff6", fire: "#5dffb0", outer: "#1fd0a0", ring: "#a6ffd8", spark: "#7dffc4" }
    case "buster":
      return { core: "#ffe6e6", fire: "#ff3d4e", outer: "#a3001e", ring: "#ff7a8a", spark: "#ff5a6e" }
    default:
      return { core: "#ffffff", fire: WEAPONS[kind]?.color ?? "#ffffff", outer: "#5ac8ff", ring: "#e8f0ff", spark: "#e8f0ff" }
  }
}

export class Fx {
  parts: Particle[] = []
  rings: Ring[] = []
  lights: Light[] = []
  heat: Light[] = []
  texts: Text[] = []
  beams: Beam[] = []
  walls: Wall[] = []
  streaks: Streak[] = []
  mask: Mask | null = null
  // global white flash 0..1 and hazard pulse
  flash = 0
  hazardPulse = 0
  private seed = 1

  private rand(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0
    return this.seed / 4294967296
  }

  private add(p: Partial<Particle> & { k: K; x: number; y: number }): void {
    if (this.parts.length >= MAX_PARTICLES) {
      // recycle the oldest smoke/dust first
      const i = this.parts.findIndex((q) => q.k === K.Smoke || q.k === K.Dust)
      this.parts.splice(i >= 0 ? i : 0, 1)
    }
    this.parts.push({
      vx: 0,
      vy: 0,
      life: 1,
      max: 1,
      size: 1,
      color: "#ffffff",
      drag: 0,
      grav: 0,
      rot: 0,
      vr: 0,
      delay: 0,
      shape: 0,
      cx: 0,
      cy: 0,
      ...p,
    })
  }

  ring(x: number, y: number, r0: number, r1: number, life: number, color: string, width: number, delay = 0, fill = false): void {
    this.rings.push({ x, y, r0, r1, life, max: life, color, width, delay, fill })
  }

  light(x: number, y: number, r: number, color: string, life: number, delay = 0): void {
    this.lights.push({ x, y, r, color, life, max: life, delay })
  }

  text(x: number, y: number, text: string, color: string, size: number, sub = ""): void {
    this.texts.push({ x, y, text, color, size, life: 1.5, max: 1.5, sub })
  }

  sparks(x: number, y: number, n: number, color: string, speed: number, opts: { up?: number; life?: number; size?: number; grav?: number; spread?: number; dir?: number } = {}): void {
    for (let i = 0; i < n; i++) {
      const spread = opts.spread ?? Math.PI * 2
      const a = (opts.dir ?? -Math.PI / 2) + (this.rand() - 0.5) * spread
      const s = speed * (0.3 + this.rand() * 0.9)
      const life = (opts.life ?? 0.6) * (0.5 + this.rand() * 0.8)
      this.add({ k: K.Spark, x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - (opts.up ?? 0), life, max: life, size: opts.size ?? 0.9, color, drag: 2.2, grav: opts.grav ?? 180 })
    }
  }

  embers(x: number, y: number, n: number, color: string, speed: number, r: number): void {
    for (let i = 0; i < n; i++) {
      const a = this.rand() * Math.PI * 2
      const s = speed * (0.2 + this.rand())
      const life = 0.8 + this.rand() * 1.6
      this.add({ k: K.Ember, x: x + Math.cos(a) * r * this.rand(), y: y + Math.sin(a) * r * this.rand(), vx: Math.cos(a) * s, vy: Math.sin(a) * s - speed * 0.4, life, max: life, size: 0.5 + this.rand() * 0.9, color, drag: 1.4, grav: 60 })
    }
  }

  debris(x: number, y: number, n: number, speed: number, hot: string, size = 1): void {
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (this.rand() - 0.5) * Math.PI * 1.5
      const s = speed * (0.35 + this.rand() * 0.8)
      const life = 1.4 + this.rand() * 1.8
      this.add({ k: K.Debris, x: x + (this.rand() - 0.5) * 6, y: y + (this.rand() - 0.5) * 6, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life, max: life, size: (1 + this.rand() * 2.4) * size, color: hot, drag: 0.3, grav: 420, rot: this.rand() * 6, vr: (this.rand() - 0.5) * 14, shape: Math.floor(this.rand() * 4) })
    }
  }

  smoke(x: number, y: number, n: number, r: number, color = "#2a3444", delay = 0.05): void {
    for (let i = 0; i < n; i++) {
      const life = 1.8 + this.rand() * 2
      this.add({ k: K.Smoke, x: x + (this.rand() - 0.5) * r, y: y + (this.rand() - 0.5) * r * 0.6, vx: (this.rand() - 0.5) * 14, vy: -8 - this.rand() * 14, life, max: life, size: r * (0.5 + this.rand() * 0.6), color, drag: 0.6, grav: -4, delay: delay + this.rand() * 0.15, rot: this.rand() * 6, vr: (this.rand() - 0.5) * 0.6 })
    }
  }

  dust(x: number, y: number, n: number, r: number): void {
    for (let i = 0; i < n; i++) {
      const life = 0.7 + this.rand() * 0.8
      const a = -Math.PI / 2 + (this.rand() - 0.5) * 2.6
      const s = 10 + this.rand() * 30
      this.add({ k: K.Dust, x: x + (this.rand() - 0.5) * r, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s * 0.5, life, max: life, size: r * (0.3 + this.rand() * 0.4), color: "#4a5a70", drag: 2.5, grav: -6 })
    }
  }

  flames(x0: number, x1: number, y: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const life = 0.35 + this.rand() * 0.5
      this.add({ k: K.Flame, x: x0 + this.rand() * (x1 - x0), y: y - this.rand() * 2, vx: (this.rand() - 0.5) * 8, vy: -12 - this.rand() * 26, life, max: life, size: 1.6 + this.rand() * 2.4, color: this.rand() < 0.3 ? "#ffd04a" : "#ff6a1e", drag: 1, grav: -10 })
    }
  }

  boom(x: number, y: number, r: number, kind: WeaponId | "bomblet", team: string): void {
    const st = style(kind)
    const R = Math.max(6, r)
    const big = R / 30
    this.light(x, y, R * 4, st.fire, 0.55)
    this.light(x, y, R * 1.1, st.core, 0.15)
    this.heat.push({ x, y, r: R * 4, color: st.fire, life: 2.6, max: 2.6, delay: 0 })
    this.add({ k: K.Glow, x, y, life: 0.28, max: 0.28, size: R * 0.6, color: st.core })
    this.add({ k: K.Glow, x, y, life: 0.12, max: 0.12, size: R * 0.4, color: "#ffffff" })
    this.add({ k: K.Glow, x, y, life: 0.6, max: 0.6, size: R * 1.2, color: st.fire, shape: 1 })
    this.add({ k: K.Glow, x, y, life: 0.9, max: 0.9, size: R * 1.9, color: st.outer, shape: 1 })
    switch (kind) {
      case "gravity": {
        // imploding rings and an inward swirl
        for (let i = 0; i < 3; i++) this.ring(x, y, R * 2.6, R * 0.2, 0.55, st.ring, 1.4, i * 0.12)
        this.ring(x, y, R * 0.4, R * 2.4, 0.5, st.fire, 2.2, 0.45)
        for (let i = 0; i < 70; i++) {
          const a = this.rand() * Math.PI * 2
          const d = R * (1 + this.rand() * 1.6)
          const life = 0.5 + this.rand() * 0.4
          this.add({ k: K.Swirl, x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, cx: x, cy: y, vx: 0, vy: 0, life, max: life, size: 0.8, color: this.rand() < 0.5 ? st.spark : st.core, rot: a, vr: d })
        }
        this.debris(x, y, 10, 160 * big, st.fire)
        this.smoke(x, y, 4, R * 0.9, "#2a2440", 0.5)
        break
      }
      case "drill": {
        this.ring(x, y, R * 0.3, R * 1.6, 0.35, st.ring, 1.2)
        this.sparks(x, y, 50, st.spark, 260, { life: 0.5, size: 0.8 })
        this.embers(x, y, 20, st.fire, 40, R * 0.6)
        this.debris(x, y, 8, 140 * big, st.fire)
        this.smoke(x, y, 3, R * 0.8)
        break
      }
      case "napalm": {
        this.ring(x, y, R * 0.3, R * 2, 0.4, st.ring, 1.5)
        this.flames(x - R * 1.2, x + R * 1.2, y, 50)
        this.fireball(x, y, R * 1.3, st, 8)
        this.sparks(x, y, 30, st.spark, 200, { life: 0.8, grav: 260 })
        this.embers(x, y, 40, st.fire, 50, R)
        this.smoke(x, y, 8, R * 1.2, "#2d2622")
        break
      }
      case "cluster":
      case "bomblet": {
        this.ring(x, y, R * 0.2, R * 2.1, 0.32, st.ring, 1.1)
        this.fireball(x, y, R, st, 4)
        this.sparks(x, y, 18, st.spark, 200, { life: 0.45 })
        this.embers(x, y, 10, st.fire, 40, R * 0.5)
        this.debris(x, y, 4, 120 * big, st.fire, 0.7)
        this.smoke(x, y, 2, R)
        break
      }
      case "airstrike": {
        this.streaks.push({ x0: x + (this.rand() - 0.5) * 30, y0: y - 260, x1: x, y1: y, life: 0.25, max: 0.25, color: st.spark, delay: 0 })
        this.heBlast(x, y, R, st, big)
        break
      }
      case "buster": {
        this.ring(x, y, R * 0.2, R * 3.2, 0.7, st.ring, 3, 0)
        this.ring(x, y, R * 0.2, R * 2.2, 0.5, "#ffffff", 1.2, 0.08)
        this.light(x, y, R * 6, st.outer, 0.9)
        this.heBlast(x, y, R * 1.15, st, big * 1.3)
        this.flash = Math.max(this.flash, 0.2)
        break
      }
      case "builder": {
        this.ring(x, y, R * 0.2, R * 1.6, 0.4, st.ring, 1.2)
        this.sparks(x, y, 20, st.spark, 160, { life: 0.5 })
        break
      }
      default:
        this.heBlast(x, y, R, st, big)
    }
    void team
  }

  fireball(x: number, y: number, R: number, st: BoomStyle, n: number): void {
    for (let i = 0; i < n; i++) {
      const a = this.rand() * Math.PI * 2
      const d = this.rand() * R * 0.35
      const s = R * (1.2 + this.rand() * 2)
      const life = 0.35 + this.rand() * 0.45
      this.add({ k: K.Fireball, x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, vx: Math.cos(a) * s, vy: Math.sin(a) * s - R * 0.6, life, max: life, size: R * (0.35 + this.rand() * 0.35), color: st.fire, drag: 4, grav: -20, shape: i, st })
    }
  }

  private heBlast(x: number, y: number, R: number, st: BoomStyle, big: number): void {
    this.fireball(x, y, R, st, Math.round(10 * Math.min(2, big + 0.4)))
    // concentric shock rings like the concept: several thin rings expanding at staggered speeds
    for (let i = 0; i < 3; i++) this.ring(x, y, R * (0.2 + i * 0.1), R * (2.4 - i * 0.5), 0.45 + i * 0.1, i === 0 ? st.ring : st.fire, i === 0 ? 1.1 : 0.55, i * 0.05)
    this.sparks(x, y, Math.round(40 * Math.min(2, big + 0.3)), st.spark, 340 * Math.sqrt(big), { life: 0.7, size: 1 })
    this.sparks(x, y, 16, st.core, 420 * Math.sqrt(big), { life: 0.3, size: 0.7, spread: Math.PI * 1.2 })
    this.embers(x, y, Math.round(30 * Math.min(2, big + 0.3)), st.fire, 70, R * 0.6)
    this.debris(x, y, Math.round(30 * Math.min(2, big + 0.2)), 280 * Math.sqrt(big), st.fire, 1.2)
    this.debris(x, y, Math.round(14 * Math.min(2, big + 0.2)), 150 * Math.sqrt(big), st.fire, 2)
    this.embers(x, y, Math.round(50 * Math.min(2, big + 0.3)), st.spark, 160, R * 0.4)
    this.smoke(x, y, Math.round(8 * Math.min(2, big + 0.3)), R * 1.1)
  }

  collide(x: number, y: number): void {
    this.light(x, y, 90, "#ffd9a0", 0.4)
    this.add({ k: K.Glow, x, y, life: 0.3, max: 0.3, size: 16, color: "#ffffff" })
    this.add({ k: K.Glow, x, y, life: 0.5, max: 0.5, size: 30, color: "#ff9a3a" })
    this.ring(x, y, 2, 34, 0.35, "#fff2d6", 1.2)
    this.sparks(x, y, 42, "#ffd9a0", 380, { life: 0.6, size: 0.8, grav: 120 })
    this.sparks(x, y, 20, "#7fe8ff", 300, { life: 0.5, size: 0.7, grav: 120 })
    this.embers(x, y, 24, "#ff8a2a", 60, 4)
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + this.rand() * 0.3
      const L = 22 + this.rand() * 30
      this.streaks.push({ x0: x, y0: y, x1: x + Math.cos(a) * L, y1: y + Math.sin(a) * L, life: 0.18, max: 0.18, color: "#fff4e0", delay: 0 })
    }
  }

  carve(x: number, y: number, r: number): void {
    if (r < 3) return
    this.dust(x, y + r * 0.5, Math.min(4, Math.ceil(r / 8)), r * 0.8)
  }

  drillSparks(x: number, y: number): void {
    this.sparks(x, y, 3, "#6ff2ff", 120, { life: 0.35, size: 0.7, grav: 80 })
  }

  unitDeath(x: number, y: number, color: string): void {
    this.light(x, y, 80, "#ff9a3a", 0.7)
    this.add({ k: K.Glow, x, y, life: 0.5, max: 0.5, size: 14, color: "#fff4dc" })
    this.add({ k: K.Glow, x, y, life: 0.9, max: 0.9, size: 24, color: "#ff7a2a", shape: 1 })
    this.ring(x, y, 4, 60, 0.6, mixHex(color, "#ffffff", 0.4), 2)
    this.sparks(x, y, 40, "#ffcf7a", 300, { life: 0.8 })
    this.sparks(x, y, 24, color, 240, { life: 0.7 })
    this.debris(x, y, 12, 220, color, 0.9)
    this.smoke(x, y, 10, 18, "#1f2530")
  }

  absorb(x: number, y: number, color: string): void {
    this.ring(x, y, 10, 26, 0.45, color, 1.6)
    this.ring(x, y, 16, 20, 0.3, "#ffffff", 0.8)
    this.sparks(x, y, 14, color, 160, { life: 0.4, grav: 0 })
  }

  teleport(x0: number, y0: number, x: number, y: number): void {
    this.beams.push({ x: x0, y: y0, color: "#e8f0ff", life: 0.6, max: 0.6 })
    this.beams.push({ x, y, color: "#e8f0ff", life: 0.8, max: 0.8 })
    this.light(x0, y0 - 10, 70, "#bfe6ff", 0.5)
    this.light(x, y - 10, 90, "#ffffff", 0.6)
    this.sparks(x, y - 6, 30, "#e8f0ff", 160, { life: 0.6, grav: -40 })
    this.sparks(x0, y0 - 6, 20, "#9fdcff", 140, { life: 0.5, grav: -40 })
  }

  builder(x: number, y: number, w: number, h: number): void {
    this.walls.push({ x, y, w, h, life: 1.1, max: 1.1, color: "#a6ff4d" })
    this.light(x + w / 2, y + h / 2, Math.max(w, h) * 1.6, "#7dff4a", 0.6)
    this.dust(x + w / 2, y + h, 8, w)
  }

  well(x: number, y: number, r: number): void {
    this.ring(x, y, r * 0.2, r * 1.2, 0.5, "#dcaaff", 1.6)
    this.light(x, y, r * 2.5, "#9b5bff", 0.6)
  }

  crate(x: number, y: number, label: string, color: string): void {
    this.light(x, y, 70, color, 0.5)
    this.ring(x, y, 4, 30, 0.5, color, 1.4)
    this.sparks(x, y, 22, color, 150, { life: 0.6, grav: -30 })
    this.texts.push({ x, y: y - 16, text: label, color, size: 9, life: 1.8, max: 1.8, sub: "" })
  }

  wreckSmoke(x: number, y: number): void {
    const life = 2.4 + this.rand() * 1.5
    this.add({ k: K.Smoke, x: x + (this.rand() - 0.5) * 6, y: y - 6, vx: (this.rand() - 0.5) * 4 + 3, vy: -10 - this.rand() * 6, life, max: life, size: 4 + this.rand() * 4, color: "#1c222c", drag: 0.2, grav: -3, rot: this.rand() * 6, vr: (this.rand() - 0.5) * 0.5 })
    if (this.rand() < 0.3) {
      const l2 = 0.6 + this.rand() * 0.6
      this.add({ k: K.Ember, x: x + (this.rand() - 0.5) * 8, y: y - 5, vx: (this.rand() - 0.5) * 6, vy: -14 - this.rand() * 10, life: l2, max: l2, size: 0.5, color: "#ff7a2a", drag: 1, grav: -5 })
    }
  }

  trailPuff(x: number, y: number, color: string): void {
    const life = 0.5 + this.rand() * 0.4
    this.add({ k: K.Ember, x, y, vx: (this.rand() - 0.5) * 10, vy: (this.rand() - 0.5) * 10, life, max: life, size: 0.45 + this.rand() * 0.4, color, drag: 2, grav: 20 })
  }

  update(dt: number): void {
    if (dt <= 0) return
    const mask = this.mask
    const keep: Particle[] = []
    for (const p of this.parts) {
      if (p.delay > 0) {
        p.delay -= dt
        keep.push(p)
        continue
      }
      p.life -= dt
      if (p.life <= 0) continue
      if (p.k === K.Swirl) {
        // spiral inward toward the vortex center
        p.rot += dt * 7
        p.vr = Math.max(0, p.vr - dt * p.vr * 3.2 - dt * 10)
        p.x = p.cx + Math.cos(p.rot) * p.vr
        p.y = p.cy + Math.sin(p.rot) * p.vr * 0.8
        keep.push(p)
        continue
      }
      const d = Math.exp(-p.drag * dt)
      p.vx *= d
      p.vy = p.vy * d + p.grav * dt
      const nx = p.x + p.vx * dt
      const ny = p.y + p.vy * dt
      if (p.k === K.Debris && mask && solidAt(mask, nx, ny)) {
        // bounce, losing most energy, settle when slow
        if (!solidAt(mask, p.x, ny)) p.vx *= -0.35
        p.vy *= -0.3
        p.vx *= 0.6
        p.vr *= 0.5
        if (Math.abs(p.vy) < 20) {
          p.vy = 0
          p.vx *= 0.5
          p.grav = 0
        }
      } else {
        p.x = nx
        p.y = ny
      }
      p.rot += p.vr * dt
      keep.push(p)
    }
    this.parts = keep
    const tick = <T extends { life: number; delay?: number }>(arr: T[]) =>
      arr.filter((r) => {
        if (r.delay !== undefined && r.delay > 0) {
          r.delay -= dt
          return true
        }
        r.life -= dt
        return r.life > 0
      })
    this.rings = tick(this.rings)
    this.lights = tick(this.lights)
    this.heat = tick(this.heat)
    this.texts = tick(this.texts)
    this.beams = tick(this.beams)
    this.walls = tick(this.walls)
    this.streaks = tick(this.streaks)
    this.flash = Math.max(0, this.flash - dt * 3)
    this.hazardPulse = Math.max(0, this.hazardPulse - dt * 0.8)
  }

  // normal-blend layer: smoke, dust, debris bodies
  drawBase(g: CanvasRenderingContext2D): void {
    for (const p of this.parts) {
      if (p.delay > 0) continue
      const t = 1 - p.life / p.max
      if (p.k === K.Smoke || p.k === K.Dust) {
        const a = p.k === K.Smoke ? Math.sin(Math.min(1, t * 3) * Math.PI * 0.5) * (1 - t) * 0.9 : (1 - t) * 0.5
        const s = p.size * (1 + t * (p.k === K.Smoke ? 2.2 : 1.4))
        g.globalAlpha = a
        g.drawImage(smokeSprite(p.color), p.x - s, p.y - s, s * 2, s * 2)
      }
    }
    g.globalAlpha = 1
  }

  // dark rock chunks drawn over the fireball so they read as silhouettes
  drawDebris(g: CanvasRenderingContext2D): void {
    for (const p of this.parts) {
      if (p.k !== K.Debris || p.delay > 0) continue
      const t = 1 - p.life / p.max
      g.globalAlpha = Math.min(1, p.life / 0.5)
      g.save()
      g.translate(p.x, p.y)
      g.rotate(p.rot)
      debrisPath(g, p.size, p.shape)
      g.fillStyle = "#07090c"
      g.fill()
      const hot = Math.max(0, 1 - t * 1.2)
      g.strokeStyle = hot > 0.05 ? rgba(mixHex(p.color, "#ffe0a0", hot * 0.5), 0.35 + hot * 0.65) : "rgba(110,190,240,0.35)"
      g.lineWidth = 0.5
      g.stroke()
      g.restore()
    }
    g.globalAlpha = 1
  }

  // additive emissive layer; called for the sharp pass and the bloom pass
  drawGlow(g: CanvasRenderingContext2D, bloom: boolean): void {
    g.globalCompositeOperation = "lighter"
    for (const l of this.lights) {
      if (l.delay > 0) continue
      const t = 1 - l.life / l.max
      const a = (1 - t) * (1 - t) * (bloom ? 0.3 : 0.28)
      g.globalAlpha = a
      const r = l.r * (0.7 + t * 0.4)
      g.drawImage(glowSprite(l.color), l.x - r, l.y - r, r * 2, r * 2)
    }
    for (const p of this.parts) {
      if (p.delay > 0) continue
      const t = 1 - p.life / p.max
      switch (p.k) {
        case K.Glow: {
          const s = p.size * (0.55 + Math.sqrt(t) * 0.75)
          g.globalAlpha = (1 - t) * (1 - t) * (bloom ? 0.45 : 0.85) * (p.shape === 1 ? 0.6 : 1)
          g.drawImage(glowSprite(p.color, p.shape === 1 ? 0 : 1), p.x - s, p.y - s, s * 2, s * 2)
          break
        }
        case K.Spark: {
          const a = 1 - t
          const len = 0.022
          g.globalAlpha = a
          g.strokeStyle = t < 0.25 ? mixHex(p.color, "#ffffff", 0.6) : p.color
          g.lineWidth = p.size * (bloom ? 2 : 1)
          g.beginPath()
          g.moveTo(p.x, p.y)
          g.lineTo(p.x - p.vx * len, p.y - p.vy * len)
          g.stroke()
          break
        }
        case K.Ember:
        case K.Swirl: {
          const a = (1 - t) * (0.6 + 0.4 * Math.sin(p.life * 30 + p.x))
          const s = p.size * (bloom ? 3 : 1)
          g.globalAlpha = Math.max(0, a)
          g.fillStyle = p.color
          g.fillRect(p.x - s / 2, p.y - s / 2, s, s)
          break
        }
        case K.Flame: {
          const s = p.size * (1 - t * 0.6) * (bloom ? 2.2 : 1.4)
          g.globalAlpha = (1 - t) * 0.9
          g.drawImage(glowSprite(t < 0.3 ? "#ffe08a" : p.color, 1), p.x - s, p.y - s * 1.4, s * 2, s * 2.8)
          break
        }
        case K.Fireball: {
          const st = p.st
          const col = !st ? p.color : t < 0.4 ? st.fire : st.outer
          const s = p.size * (0.6 + t * 1.2) * (bloom ? 1.2 : 1)
          g.globalAlpha = (1 - t) * 0.28 * (bloom ? 0.5 : 1)
          g.drawImage(glowSprite(col, 0), p.x - s, p.y - s, s * 2, s * 2)
          break
        }
        case K.Debris: {
          const hot = Math.max(0, 1 - t * 1.6)
          if (hot > 0.05) {
            const s = p.size * (bloom ? 3 : 1.8)
            g.globalAlpha = hot * 0.7
            g.drawImage(glowSprite(p.color), p.x - s, p.y - s, s * 2, s * 2)
          }
          break
        }
        default:
          break
      }
    }
    for (const r of this.rings) {
      if (r.delay > 0) continue
      const t = 1 - r.life / r.max
      const e = 1 - (1 - t) * (1 - t) * (1 - t)
      const rad = r.r0 + (r.r1 - r.r0) * e
      g.globalAlpha = (1 - t) * (1 - t) * (bloom ? 0.5 : 0.75)
      g.strokeStyle = r.color
      g.lineWidth = r.width * (1 - t * 0.6) * (bloom ? 2.2 : 1)
      g.beginPath()
      g.arc(r.x, r.y, Math.max(0.1, rad), 0, Math.PI * 2)
      g.stroke()
    }
    for (const s of this.streaks) {
      if (s.delay > 0) continue
      const t = 1 - s.life / s.max
      g.globalAlpha = 1 - t
      g.strokeStyle = s.color
      g.lineWidth = bloom ? 2.4 : 1
      g.beginPath()
      g.moveTo(s.x0 + (s.x1 - s.x0) * t * 0.6, s.y0 + (s.y1 - s.y0) * t * 0.6)
      g.lineTo(s.x1, s.y1)
      g.stroke()
    }
    for (const b of this.beams) {
      const t = 1 - b.life / b.max
      const flick = 0.6 + 0.4 * Math.sin(b.life * 60)
      const w = (bloom ? 10 : 3) * (1 - t)
      g.globalAlpha = (1 - t) * flick
      const grd = g.createLinearGradient(0, b.y - 160, 0, b.y)
      grd.addColorStop(0, rgba(b.color, 0))
      grd.addColorStop(1, rgba(b.color, 1))
      g.fillStyle = grd
      g.fillRect(b.x - w / 2, b.y - 160, w, 160)
    }
    for (const w of this.walls) {
      const t = 1 - w.life / w.max
      const rise = Math.min(1, t * 2.4)
      const a = t < 0.6 ? 1 : (1 - t) / 0.4
      const top = w.y + w.h * (1 - rise)
      g.globalAlpha = a * 0.9
      g.strokeStyle = w.color
      g.lineWidth = bloom ? 2 : 0.6
      g.beginPath()
      for (let x = w.x; x <= w.x + w.w + 0.01; x += 4) {
        g.moveTo(x, top)
        g.lineTo(x, w.y + w.h)
      }
      for (let y = w.y + w.h; y >= top; y -= 4) {
        g.moveTo(w.x, y)
        g.lineTo(w.x + w.w, y)
      }
      g.stroke()
      g.lineWidth = bloom ? 3 : 1.2
      g.strokeStyle = "#eaffd0"
      g.beginPath()
      g.moveTo(w.x - 2, top)
      g.lineTo(w.x + w.w + 2, top)
      g.stroke()
    }
    g.globalAlpha = 1
    g.globalCompositeOperation = "source-over"
  }

  drawTexts(g: CanvasRenderingContext2D): void {
    g.textAlign = "center"
    g.textBaseline = "middle"
    for (const tx of this.texts) {
      const t = 1 - tx.life / tx.max
      const pop = t < 0.12 ? 0.6 + (t / 0.12) * 0.55 : t < 0.22 ? 1.15 - ((t - 0.12) / 0.1) * 0.15 : 1
      const y = tx.y - 14 * Math.sqrt(t)
      const a = t > 0.7 ? (1 - t) / 0.3 : 1
      const size = tx.size * pop
      g.globalAlpha = a
      g.font = `800 ${size}px "Rajdhani","Barlow Condensed","Oswald","Arial Narrow",sans-serif`
      g.lineWidth = size * 0.22
      g.strokeStyle = "rgba(4,8,14,0.85)"
      g.strokeText(tx.text, tx.x, y)
      g.shadowColor = tx.color
      g.shadowBlur = 8
      g.fillStyle = mixHex(tx.color, "#ffffff", 0.35)
      g.fillText(tx.text, tx.x, y)
      g.shadowBlur = 0
      if (tx.sub) {
        g.font = `700 ${size * 0.45}px "Rajdhani","Barlow Condensed","Arial Narrow",sans-serif`
        g.fillStyle = tx.color
        g.fillText(tx.sub, tx.x, y + size * 0.7)
      }
    }
    g.globalAlpha = 1
  }

  // explosion light painted onto terrain edges (caller composites with source-in over the rim mask)
  drawHot(g: CanvasRenderingContext2D): boolean {
    let any = false
    for (const l of this.heat) {
      const t = 1 - l.life / l.max
      g.globalAlpha = Math.min(1, (1 - t) * 1.5)
      const r = l.r * (0.8 + t * 0.3)
      g.drawImage(glowSprite(l.color, 1), l.x - r, l.y - r, r * 2, r * 2)
      any = true
    }
    for (const p of this.parts) {
      if (p.k !== K.Flame || p.delay > 0) continue
      const s = 10
      g.globalAlpha = 0.5 * (p.life / p.max)
      g.drawImage(glowSprite("#ff7a2a"), p.x - s, p.y - s, s * 2, s * 2)
      any = true
    }
    g.globalAlpha = 1
    return any
  }

  busy(): boolean {
    return this.lights.length > 0 || this.rings.length > 0
  }

  // weighted center of recent explosions, for camera framing
  hotspot(): { x: number; y: number; w: number } | null {
    let sx = 0
    let sy = 0
    let w = 0
    for (const l of this.lights) {
      const k = l.life / l.max
      sx += l.x * k
      sy += l.y * k
      w += k
    }
    return w > 0 ? { x: sx / w, y: sy / w, w } : null
  }
}

function solidAt(mask: Mask, x: number, y: number): boolean {
  const ix = x | 0
  const iy = y | 0
  if (ix < 0 || ix >= WORLD_W || iy < 0) return false
  if (iy >= WORLD_H) return true
  return mask[iy * WORLD_W + ix] === 1
}

function debrisPath(g: CanvasRenderingContext2D, s: number, shape: number): void {
  g.beginPath()
  switch (shape) {
    case 0:
      g.moveTo(-s, -s * 0.6)
      g.lineTo(s * 0.8, -s)
      g.lineTo(s, s * 0.5)
      g.lineTo(-s * 0.4, s)
      break
    case 1:
      g.moveTo(-s, 0)
      g.lineTo(0, -s)
      g.lineTo(s, -s * 0.2)
      g.lineTo(s * 0.5, s * 0.8)
      g.lineTo(-s * 0.6, s * 0.7)
      break
    case 2:
      g.moveTo(-s * 0.7, -s * 0.7)
      g.lineTo(s * 0.9, -s * 0.4)
      g.lineTo(s * 0.2, s)
      break
    default:
      g.moveTo(-s, -s * 0.3)
      g.lineTo(-s * 0.2, -s)
      g.lineTo(s, -s * 0.6)
      g.lineTo(s * 0.7, s * 0.6)
      g.lineTo(-s * 0.5, s * 0.9)
  }
  g.closePath()
}
