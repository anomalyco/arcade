const SPRITE_FLOATS = 12
import { spriteMotionKeys } from "../gpu/sprite-motion"
import { vehicleEffectSettings as settings } from "./effect-settings"

type Particle = { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; max: number; size: number; r: number; g: number; b: number; rot: number; stretch: number }

/** Sparks and bounded ground ribbons. Tyre smoke and exhaust live in VehicleEmissions. */
export class Fx {
  add: Particle[] = []
  private readonly skids = new Float32Array(1600 * 13)
  skidCount = 0
  private nextSkid = 0
  private readonly sparkKeys = new WeakMap<Particle, object[]>()
  clearSkids() { this.skidCount = this.nextSkid = 0 }

  static write(out: Float32Array, n: number, p: { x: number; y: number; z: number; size: number; r: number; g: number; b: number; a: number; kind: number; rot: number; stretch: number; seed: number }) {
    let keys=spriteMotionKeys.get(out)
    if(!keys)spriteMotionKeys.set(out,keys=[])
    keys[n]=p
    const i = n * SPRITE_FLOATS
    out[i] = p.x; out[i + 1] = p.y; out[i + 2] = p.z; out[i + 3] = p.size
    out[i + 4] = p.r; out[i + 5] = p.g; out[i + 6] = p.b; out[i + 7] = p.a
    out[i + 8] = p.kind; out[i + 9] = p.rot; out[i + 10] = p.stretch; out[i + 11] = p.seed
  }

  skidSegment(ax: number, az: number, bx: number, bz: number, alpha: number, y = 0.03) {
    const length = Math.hypot(bx - ax, bz - az)
    if (length < 0.015 || length > 8) return
    const o = this.nextSkid * 13, p = this.skids
    this.nextSkid = (this.nextSkid + 1) % 1600
    this.skidCount = Math.min(1600, this.skidCount + 1)
    const width = Math.max(.01,settings.skids.width)
    p[o] = (ax + bx) / 2; p[o + 1] = y; p[o + 2] = (az + bz) / 2; p[o + 3] = width
    p[o + 4] = 0.02; p[o + 5] = 0.02; p[o + 6] = 0.025; p[o + 7] = alpha
    p[o + 8] = 4; p[o + 9] = Math.atan2(bx - ax, bz - az); p[o + 10] = (length / 2 + 0.025) / width
    p[o + 11] = 0; p[o + 12] = settings.skids.life
  }

  sparks(x: number, z: number, nx: number, nz: number, n: number, y = 0.6) {
    for (let i = 0; i < n; i++) {
      const a = Math.atan2(nz, nx) + (Math.random() - 0.5) * 2.2, sp = settings.sparks.speed + Math.random() * settings.sparks.speedSpread
      this.add.push({ x, y: y + Math.random() * 0.5, z, vx: Math.cos(a) * sp, vy: 2 + Math.random() * 5, vz: Math.sin(a) * sp,
        life: 0, max: settings.sparks.life + Math.random() * settings.sparks.lifeSpread, size: settings.sparks.size + Math.random() * settings.sparks.sizeSpread, r: 1, g: 0.62 + Math.random() * 0.25, b: 0.25, rot: 0, stretch: 1 })
    }
  }

  update(dt: number) {
    for (let i = 0; i < this.skidCount; i++) this.skids[i * 13 + 12] = Math.max(0, this.skids[i * 13 + 12]! - dt)
    let w = 0
    const drag = Math.exp(-settings.sparks.drag * dt)
    for (const p of this.add) {
      p.life += dt
      if (p.life >= p.max) continue
      p.vx *= drag; p.vz *= drag; p.vy = p.vy * drag - settings.sparks.gravity * dt
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt
      if (p.y < 0.05) { p.y = 0.05; p.vy = -p.vy * settings.sparks.bounce }
      p.rot = Math.atan2(p.vz, p.vx)
      p.stretch = 1 + Math.min(7, Math.hypot(p.vx, p.vz) * 0.28)
      p.size = Math.max(0.02, p.size - 0.1 * dt)
      this.add[w++] = p
    }
    this.add.length = w
  }

  private writeSpark(out: Float32Array, n: number, p: Particle, tail = 0) {
    let parts=this.sparkKeys.get(p)
    if(!parts)this.sparkKeys.set(p,parts=Array.from({length:5},()=>({})))
    let keys=spriteMotionKeys.get(out)
    if(!keys)spriteMotionKeys.set(out,keys=[])
    keys[n]=parts[Math.round(tail*4)]!
    const i = n * SPRITE_FLOATS, speed = Math.hypot(p.vx, p.vz) || 1, length = p.size * (p.stretch - 1)
    out[i] = p.x - p.vx / speed * length * tail; out[i + 1] = p.y; out[i + 2] = p.z - p.vz / speed * length * tail
    out[i + 3] = p.size * (1 - tail * 0.6)
    out[i + 4] = p.r; out[i + 5] = p.g; out[i + 6] = p.b; out[i + 7] = 3 * (1 - p.life / p.max) * (1 - tail * 0.75)
    out[i + 8] = 6; out[i + 9] = p.rot; out[i + 10] = p.stretch; out[i + 11] = 0
  }

  emit(alpha: Float32Array, ai: number, add: Float32Array, di: number, max: number, skidsVisible = true) {
    for (let n = 0; skidsVisible && n < this.skidCount && ai < max; n++) {
      const i = n * 13, remaining = this.skids[i + 12]!
      if (remaining <= 0) continue
      for (let j = 0; j < 12; j++) alpha[ai * 12 + j] = this.skids[i + j]!
      alpha[ai * 12 + 7] *= Math.min(1, remaining / 2.5)
      ai++
    }
    for (const p of this.add) {
      if (di >= max) break
      this.writeSpark(add, di++, p)
      for (let j = 1; j <= 4 && di < max; j++) this.writeSpark(add, di++, p, j / 4)
    }
    return { alpha: ai, add: di }
  }
}
