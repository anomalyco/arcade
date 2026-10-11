import { WORLD_H, WORLD_W } from "../../sim/terrain"
import { clamp } from "./util"

// maximum amount of the world bottom (deep rock) we crop on ultra-wide screens before letterboxing sideways
const MAX_BOTTOM_CROP = 0.16

export class Camera {
  // css px
  w = 1
  h = 1
  dpr = 1
  // base fit
  s = 1
  bcx = WORLD_W / 2
  bcy = WORLD_H / 2
  // live camera (world center, zoom multiplier)
  cx = WORLD_W / 2
  cy = WORLD_H / 2
  z = 1
  // targets
  tcx = WORLD_W / 2
  tcy = WORLD_H / 2
  tz = 1
  // shake
  trauma = 0
  sx = 0
  sy = 0
  private t = 0

  resize(w: number, h: number, dpr: number): void {
    this.w = Math.max(1, w)
    this.h = Math.max(1, h)
    this.dpr = dpr
    let s = this.w / WORLD_W
    if (WORLD_H * s > this.h * (1 + MAX_BOTTOM_CROP)) s = (this.h * (1 + MAX_BOTTOM_CROP)) / WORLD_H
    this.s = s
    // bottom aligned when the world is shorter than the screen (sky extends up), otherwise top aligned and the deep rock crops
    const worldH = WORLD_H * s
    const oy = worldH <= this.h ? this.h - worldH : 0
    this.bcx = WORLD_W / 2
    this.bcy = (this.h / 2 - oy) / s
    if (this.cx === WORLD_W / 2 && this.cy === WORLD_H / 2 && this.z === 1) {
      this.cx = this.bcx
      this.cy = this.bcy
    }
    this.tcx = this.bcx
    this.tcy = this.bcy
  }

  // focus on a world point at zoom multiplier z (1 = full fit)
  focus(x: number, y: number, z: number): void {
    this.tz = clamp(z, 1, 2.2)
    this.tcx = x
    this.tcy = y
  }

  reset(): void {
    this.tz = 1
    this.tcx = this.bcx
    this.tcy = this.bcy
  }

  addShake(a: number): void {
    this.trauma = Math.min(1, this.trauma + a)
  }

  update(dt: number): void {
    this.t += dt
    const k = 1 - Math.exp(-dt * 2.6)
    this.z += (this.tz - this.z) * k
    const S = this.s * this.z
    const hw = this.w / 2 / S
    const hh = this.h / 2 / S
    // keep the view inside the world horizontally and above the world bottom
    const lim = (tx: number, ty: number) => {
      const x = hw >= WORLD_W / 2 ? WORLD_W / 2 : clamp(tx, hw, WORLD_W - hw)
      const maxY = Math.max(WORLD_H - hh, this.bcy)
      const y = Math.min(ty, maxY)
      return { x, y }
    }
    const want = lim(this.tcx, this.tcy)
    this.cx += (want.x - this.cx) * k
    this.cy += (want.y - this.cy) * k
    const c = lim(this.cx, this.cy)
    this.cx = c.x
    this.cy = c.y
    this.trauma = Math.max(0, this.trauma - dt * 1.6)
    const sh = this.trauma * this.trauma * 14
    this.sx = sh * (Math.sin(this.t * 71.3) * 0.6 + Math.sin(this.t * 43.1 + 1.3) * 0.4)
    this.sy = sh * (Math.sin(this.t * 61.7 + 2.1) * 0.6 + Math.sin(this.t * 37.9 + 0.4) * 0.4)
  }

  scale(): number {
    return this.s * this.z
  }

  // transform for a parallax layer (p = 1 world locked, 0 = fixed to base framing)
  layer(p: number): { S: number; cx: number; cy: number } {
    const S = this.s * (1 + (this.z - 1) * p)
    return { S, cx: this.bcx + (this.cx - this.bcx) * p, cy: this.bcy + (this.cy - this.bcy) * p }
  }

  apply(g: CanvasRenderingContext2D, p = 1, shake = true): void {
    const { S, cx, cy } = this.layer(p)
    const d = this.dpr
    const ox = this.w / 2 + (shake ? this.sx * (0.4 + 0.6 * p) : 0)
    const oy = this.h / 2 + (shake ? this.sy * (0.4 + 0.6 * p) : 0)
    g.setTransform(S * d, 0, 0, S * d, (ox - cx * S) * d, (oy - cy * S) * d)
  }

  // visible world rect for a layer
  view(p = 1): { x0: number; y0: number; x1: number; y1: number } {
    const { S, cx, cy } = this.layer(p)
    const hw = this.w / 2 / S + 20
    const hh = this.h / 2 / S + 20
    return { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh }
  }

  toScreen(x: number, y: number): { x: number; y: number } {
    const S = this.scale()
    return { x: (x - this.cx) * S + this.w / 2, y: (y - this.cy) * S + this.h / 2 }
  }

  toWorld(x: number, y: number): { x: number; y: number } {
    const S = this.scale()
    return { x: (x - this.w / 2) / S + this.cx, y: (y - this.h / 2) / S + this.cy }
  }
}
