import type { Camera } from "../render/camera"

type V3 = [number, number, number]

const smooth = (k: number) => k * k * (3 - 2 * k)

function nlerp(a: V3, b: ArrayLike<number>, k: number, out: V3): V3 {
  const x = a[0] + (b[0]! - a[0]) * k
  const y = a[1] + (b[1]! - a[1]) * k
  const z = a[2] + (b[2]! - a[2]) * k
  const l = Math.hypot(x, y, z) || 1
  out[0] = x / l
  out[1] = y / l
  out[2] = z / l
  return out
}

/**
 * Smooth handoff between cameras (seat or ship camera ↔ jet camera). `begin` freezes the view on screen; for the next
 * `time` seconds `apply`, called after the new camera has placed itself, eases from the frozen view onto it: eye,
 * look direction, up and field of view.
 */
export class CamBlend {
  private from = { eye: [0, 0, 0] as V3, forward: [0, 0, -1] as V3, up: [0, 1, 0] as V3, fov: 0 }
  private eye: V3 = [0, 0, 0]
  private fwd: V3 = [0, 0, -1]
  private up: V3 = [0, 1, 0]
  private left = 0
  private time = 1

  /** Starts a handoff from what `cam` shows now, lasting `time` seconds. */
  begin(cam: Camera, time = 1.1): void {
    for (let i = 0; i < 3; i++) {
      this.from.eye[i] = cam.eye[i]!
      this.from.forward[i] = cam.forward[i]!
      this.from.up[i] = cam.upDir[i]!
    }
    this.from.fov = cam.fov
    this.time = time
    this.left = time
  }

  get active(): boolean {
    return this.left > 0
  }

  apply(cam: Camera, dt: number, aspect: number): void {
    if (this.left <= 0) return
    this.left = Math.max(0, this.left - dt)
    const k = smooth(1 - this.left / this.time)
    const f = this.from
    for (let i = 0; i < 3; i++) this.eye[i] = f.eye[i]! + (cam.eye[i]! - f.eye[i]!) * k
    nlerp(f.forward, cam.forward, k, this.fwd)
    nlerp(f.up, cam.upDir, k, this.up)
    cam.lookAlong(this.eye, this.fwd, this.up, f.fov + (cam.fov - f.fov) * k, aspect)
  }
}
