import { INST_FLOATS, SPRITE_FLOATS, type Batch } from "./renderer"
import type { PushPart } from "../rig"

const MAX_SPRITES = 4096

/** Sprite kinds of the shared sprite shader (`@arcade/kit/gpu/shaders`). */
export const SPRITE = { glow: 0, puff: 1, ring: 2, jagged: 3, line: 4, dashed: 5, disc: 6, mark: 7, wedge: 8 } as const

/** One frame's instanced parts and sprites, packed into the renderer's batches at the end. */
export class FrameParts {
  private parts = new Map<number, number[]>()
  private inst = new Float32Array(4096 * INST_FLOATS)
  readonly alpha = new Float32Array(MAX_SPRITES * SPRITE_FLOATS)
  readonly add = new Float32Array(MAX_SPRITES * SPRITE_FLOATS)
  nAlpha = 0
  nAdd = 0

  begin(): void {
    for (const arr of this.parts.values()) arr.length = 0
    this.nAlpha = 0
    this.nAdd = 0
  }

  /** A part at its own size. */
  readonly push: PushPart = (model, x, y, z, yaw, tint, pitch, roll, flash, alpha = 1) =>
    this.part(model, x, y, z, yaw, tint, pitch, roll, flash, alpha, 1)

  part(
    model: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
    tint: readonly [number, number, number],
    pitch: number,
    roll: number,
    flash: number,
    alpha: number,
    scale: number,
  ): void {
    let arr = this.parts.get(model)
    if (!arr) this.parts.set(model, (arr = []))
    arr.push(x, y, z, yaw, tint[0], tint[1], tint[2], scale, pitch, roll, alpha, flash)
  }

  /** A sink that scales everything pushed through it by `s` about the plan point (ox, oz) on the floor. */
  scaled(s: number, ox: number, oz: number, lift = 0): PushPart {
    if (s === 1 && lift === 0) return this.push
    return (model, x, y, z, yaw, tint, pitch, roll, flash, alpha = 1) =>
      this.part(model, ox + (x - ox) * s, y * s + lift, oz + (z - oz) * s, yaw, tint, pitch, roll, flash, alpha, s)
  }

  sprite(
    add: boolean,
    x: number,
    y: number,
    z: number,
    size: number,
    r: number,
    g: number,
    b: number,
    a: number,
    kind: number,
    rot = 0,
    stretch = 0,
    extra = 0,
  ): void {
    const buf = add ? this.add : this.alpha
    const n = add ? this.nAdd : this.nAlpha
    if (n >= MAX_SPRITES) return
    const o = n * SPRITE_FLOATS
    buf[o] = x
    buf[o + 1] = y
    buf[o + 2] = z
    buf[o + 3] = size
    buf[o + 4] = r
    buf[o + 5] = g
    buf[o + 6] = b
    buf[o + 7] = a
    buf[o + 8] = kind
    buf[o + 9] = rot
    buf[o + 10] = stretch
    buf[o + 11] = extra
    if (add) this.nAdd++
    else this.nAlpha++
  }

  batches(): Batch[] {
    let n = 0
    for (const arr of this.parts.values()) n += arr.length
    if (n > this.inst.length) this.inst = new Float32Array(n * 2)
    const out: Batch[] = []
    let at = 0
    for (const [model, arr] of this.parts) {
      if (!arr.length) continue
      this.inst.set(arr, at)
      const count = arr.length / INST_FLOATS
      // Translucent parts (decoys fading, blinking invulnerability) go through the alpha pipeline.
      let alpha = false
      for (let i = 10; i < arr.length; i += INST_FLOATS) {
        if (arr[i]! < 0.999) {
          alpha = true
          break
        }
      }
      out.push({ model, data: this.inst.subarray(at, at + arr.length) as Float32Array<ArrayBuffer>, count, alpha })
      at += arr.length
    }
    return out
  }
}
