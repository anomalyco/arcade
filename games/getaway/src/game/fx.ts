import { SPRITE_FLOATS } from "../render/renderer"

type Particle = {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  life: number
  max: number
  size: number
  grow: number
  r: number
  g: number
  b: number
  a: number
  kind: number
  rot: number
  stretch: number
  seed: number
  gravity: number
  drag: number
}

/** Pooled particles split into alpha-blended (smoke, skids) and additive (sparks, flames) lists. */
export class Fx {
  /** Reserved for solid debris; tire smoke uses the soft lit sprite path. */
  puffs: Particle[] = []
  alpha: Particle[] = []
  add: Particle[] = []
  skids: Particle[] = []

  smoke(x: number, z: number, vx: number, vz: number, intensity: number) {
    this.alpha.push({
      x: x + (Math.random() - 0.5) * 0.6,
      y: 0.5,
      z: z + (Math.random() - 0.5) * 0.6,
      vx: vx * 0.15 + (Math.random() - 0.5) * 1.5,
      vy: 0.8 + Math.random() * 0.6,
      vz: vz * 0.15 + (Math.random() - 0.5) * 1.5,
      life: 0,
      max: 1.1 + Math.random() * 0.8,
      size: 0.35 + Math.random() * 0.25,
      grow: 1.5 * (0.6 + intensity * 0.6),
      r: 0.62,
      g: 0.63,
      b: 0.68,
      a: 0.42 * intensity,
      kind: 1,
      rot: Math.random() * Math.PI * 2,
      stretch: 1,
      seed: Math.random(),
      gravity: 0,
      drag: 1.6,
    })
  }

  skid(x: number, z: number, h: number, alpha: number) {
    this.skids.push({ x, y: 0.03, z, vx: 0, vy: 0, vz: 0, life: 0, max: 9, size: 0.18, grow: 0, r: 0.02, g: 0.02, b: 0.025, a: alpha, kind: 4, rot: h + Math.PI / 2, stretch: 5, seed: 0, gravity: 0, drag: 0 })
    if (this.skids.length > 1600) this.skids.splice(0, this.skids.length - 1600)
  }

  skidSegment(ax: number, az: number, bx: number, bz: number, alpha: number, y = 0.03) {
    const length = Math.hypot(bx - ax, bz - az)
    // Teleports and resets must not leave a streak across town.
    if (length < 0.015 || length > 8) return
    this.skids.push({ x: (ax + bx) / 2, y, z: (az + bz) / 2, vx: 0, vy: 0, vz: 0, life: 0, max: 9, size: 0.16, grow: 0, r: 0.02, g: 0.02, b: 0.025, a: alpha, kind: 4, rot: Math.atan2(bx - ax, bz - az), stretch: (length / 2 + 0.025) / 0.16, seed: 0, gravity: 0, drag: 0 })
    if (this.skids.length > 1600) this.skids.splice(0, this.skids.length - 1600)
  }

  backfire(x: number, y: number, z: number, vx: number, vz: number) {
    for (const blue of [false, true]) this.add.push({ x, y, z, vx, vy: 0, vz, life: 0, max: 0.07, size: blue ? 0.25 : 0.5, grow: -2, r: blue ? 0.2 : 1, g: blue ? 0.55 : 0.5, b: blue ? 1 : 0.08, a: 2.8, kind: 0, rot: 0, stretch: 1, seed: 0, gravity: 0, drag: 2 })
  }

  /** A burst of sparks flying out along (nx, nz); `y` is how high they start (a bare rim on the road: low). */
  sparks(x: number, z: number, nx: number, nz: number, n: number, y = 0.6) {
    for (let i = 0; i < n; i++) {
      const a = Math.atan2(nz, nx) + (Math.random() - 0.5) * 2.2
      const sp = 6 + Math.random() * 14
      this.add.push({
        x,
        y: y + Math.random() * 0.5,
        z,
        vx: Math.cos(a) * sp,
        vy: 2 + Math.random() * 5,
        vz: Math.sin(a) * sp,
        life: 0,
        max: 0.25 + Math.random() * 0.4,
        size: 0.12 + Math.random() * 0.1,
        grow: -0.1,
        r: 1,
        g: 0.62 + Math.random() * 0.25,
        b: 0.25,
        a: 3,
        kind: 6,
        rot: 0,
        stretch: 1,
        seed: 0,
        gravity: 22,
        drag: 0.8,
      })
    }
  }

  flame(x: number, y: number, z: number, vx: number, vz: number) {
    this.add.push({ x, y, z, vx: vx * 0.4, vy: 0.2, vz: vz * 0.4, life: 0, max: 0.18, size: 0.55, grow: -1.5, r: 0.35, g: 0.6, b: 1, a: 2.2, kind: 0, rot: 0, stretch: 1, seed: 0, gravity: 0, drag: 2 })
  }

  update(dt: number) {
    for (const list of [this.puffs, this.alpha, this.add, this.skids]) {
      let w = 0
      for (const p of list) {
        p.life += dt
        if (p.life >= p.max) continue
        const d = Math.exp(-p.drag * dt)
        p.vx *= d
        p.vz *= d
        p.vy = p.vy * d - p.gravity * dt
        p.x += p.vx * dt
        p.y += p.vy * dt
        if (p.gravity && p.y < 0.05) {
          p.y = 0.05
          p.vy = p.kind === 6 ? -p.vy * 0.48 : 0
        }
        p.z += p.vz * dt
        if (p.kind === 6) {
          p.rot = Math.atan2(p.vz, p.vx)
          p.stretch = 1 + Math.min(7, Math.hypot(p.vx, p.vz) * 0.28)
        }
        p.size = Math.max(0.02, p.size + p.grow * dt)
        list[w++] = p
      }
      list.length = w
    }
  }

  static write(out: Float32Array, i: number, p: { x: number; y: number; z: number; size: number; r: number; g: number; b: number; a: number; kind: number; rot: number; stretch: number; seed: number }, fade = 1) {
    const o = i * SPRITE_FLOATS
    out[o] = p.x
    out[o + 1] = p.y
    out[o + 2] = p.z
    out[o + 3] = p.size
    out[o + 4] = p.r
    out[o + 5] = p.g
    out[o + 6] = p.b
    out[o + 7] = p.a * fade
    out[o + 8] = p.kind
    out[o + 9] = p.rot
    out[o + 10] = p.stretch
    out[o + 11] = p.seed
  }

  /** Puff instances for the instanced lit pipeline: grow then shrink away, slowly tumbling. */
  puffInstances(): number[] {
    const out: number[] = []
    for (const p of this.puffs) {
      const t = p.life / p.max
      const scale = p.size * Math.min(1, t * 8) * (1 - t * t)
      if (scale < 0.03) continue
      out.push(p.x, p.y, p.z, p.rot + t * 1.5, 0.3 * t, 0.2, -1, 0, 1, 1, 1, scale)
    }
    return out
  }

  /** Writes particles into the sprite arrays and returns the counts. */
  emit(alphaOut: Float32Array, alphaStart: number, addOut: Float32Array, addStart: number, max: number) {
    let ai = alphaStart
    for (const p of this.skids) {
      if (ai >= max) break
      Fx.write(alphaOut, ai++, p, Math.min(1, (p.max - p.life) / 2.5))
    }
    for (const p of this.alpha) {
      if (ai >= max) break
      const t = p.life / p.max
      Fx.write(alphaOut, ai++, p, Math.min(1, t * 6) * (1 - t))
    }
    let di = addStart
    for (const p of this.add) {
      if (di >= max) break
      Fx.write(addOut, di++, p, 1 - p.life / p.max)
      // Kind 6 uses the existing glow shader. A short velocity-aligned ribbon of overlapping
      // instances makes its stretch visible without changing the renderer's sprite contract.
      if (p.kind === 6) {
        const speed = Math.hypot(p.vx, p.vz) || 1
        const length = p.size * (p.stretch - 1)
        for (let j = 1; j <= 4 && di < max; j++) {
          const t = j / 4
          Fx.write(addOut, di++, { ...p, x: p.x - p.vx / speed * length * t, z: p.z - p.vz / speed * length * t, size: p.size * (1 - t * 0.6) }, (1 - p.life / p.max) * (1 - t * 0.75))
        }
      }
    }
    return { alpha: ai, add: di }
  }
}
