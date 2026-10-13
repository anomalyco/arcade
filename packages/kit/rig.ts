/**
 * Small 3D helpers for posing the soldier. World space is x east, y up, z = plan y (south). A Frame is a position
 * plus the world images of a part's model axes: x forward, y up, z to the right.
 */
export type V3 = [number, number, number]
export type Frame = { p: V3; x: V3; y: V3; z: V3 }

/** Human proportions shared by the procedural mesh and planted-foot IK. Metres. */
export const RIG = { hipW: .11, thigh: .42, shin: .41, ankle: .085, waist: .1, shoulderY: .43, shoulderW: .235, neckY: .5, upper: .29, fore: .27 }
export const HIP = .86
export const SHOULDER = 1.38

export const v3 = (x = 0, y = 0, z = 0): V3 => [x, y, z]
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s]
export const madd = (a: V3, b: V3, s: number): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2])
export const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
export const dist = (a: V3, b: V3): number => len(sub(a, b))
export function norm(a: V3): V3 {
  const l = len(a) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

/** Upright frame at p facing plan angle yaw. */
export function yawFrame(p: V3, yaw: number): Frame {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  return { p, x: [c, 0, s], y: [0, 1, 0], z: [-s, 0, c] }
}

/** Rotates v about the unit axis k by angle a (Rodrigues). */
export function rot(v: V3, k: V3, a: number): V3 {
  const c = Math.cos(a)
  const s = Math.sin(a)
  const kv = cross(k, v)
  const d = dot(k, v) * (1 - c)
  return [v[0] * c + kv[0] * s + k[0] * d, v[1] * c + kv[1] * s + k[1] * d, v[2] * c + kv[2] * s + k[2] * d]
}

/** Rotates a frame's axes about a world axis. */
export function turn(f: Frame, k: V3, a: number): Frame {
  if (Math.abs(a) < 1e-6) return f
  return { p: f.p, x: rot(f.x, k, a), y: rot(f.y, k, a), z: rot(f.z, k, a) }
}

/** Pitch about the frame's own z (positive lifts +x), roll about its own x, yaw about its own y. */
export const pitch = (f: Frame, a: number) => turn(f, f.z, a)
export const roll = (f: Frame, a: number) => turn(f, f.x, a)
export const yawBy = (f: Frame, a: number) => turn(f, f.y, -a)

/** A point given in a frame's local coordinates, in world space. */
export function at(f: Frame, x: number, y: number, z: number): V3 {
  return [f.p[0] + f.x[0] * x + f.y[0] * y + f.z[0] * z, f.p[1] + f.x[1] * x + f.y[1] * y + f.z[1] * z, f.p[2] + f.x[2] * x + f.y[2] * y + f.z[2] * z]
}

/** A world direction in a frame's local axes. */
export const dirIn = (f: Frame, x: number, y: number, z: number): V3 => sub(at(f, x, y, z), f.p)

export const moved = (f: Frame, p: V3): Frame => ({ p, x: f.x, y: f.y, z: f.z })

/**
 * Frame for a limb hanging from `origin` toward `end` (model -y runs down the limb), with model +x as close to `ref`
 * as possible; falls back to `ref2` when the limb runs along `ref`.
 */
export function limb(origin: V3, end: V3, ref: V3, ref2: V3): Frame {
  const y = norm(sub(origin, end))
  let x = madd(ref, y, -dot(ref, y))
  if (len(x) < 0.25) x = madd(ref2, y, -dot(ref2, y))
  x = norm(x)
  return { p: origin, x, y, z: cross(x, y) }
}

/** Frame whose +x points along `dir`, with +y as close to `up` as possible. */
export function aimFrame(p: V3, dir: V3, up: V3): Frame {
  const x = norm(dir)
  let y = madd(up, x, -dot(up, x))
  if (len(y) < 0.2) y = madd([0, 1, 0], x, -x[1])
  y = norm(y)
  return { p, x, y, z: cross(x, y) }
}

/**
 * Two-bone IK: the middle joint for a chain of lengths l1, l2 from `a` reaching for `t`, bending toward `pole`.
 * Returns the joint and the reachable end.
 */
export function ik(a: V3, t: V3, l1: number, l2: number, pole: V3): [V3, V3] {
  const d0 = sub(t, a)
  const dl = len(d0) || 1e-4
  const dir = scale(d0, 1 / dl)
  const d = Math.max(Math.abs(l1 - l2) + 1e-3, Math.min(l1 + l2 - 1e-3, dl))
  const ca = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)
  const sa = Math.sqrt(Math.max(0, 1 - ca * ca))
  let perp = madd(pole, dir, -dot(pole, dir))
  if (len(perp) < 1e-4) perp = madd([0, -1, 0], dir, -dir[1])
  perp = norm(perp)
  const mid = add(a, add(scale(dir, l1 * ca), scale(perp, l1 * sa)))
  return [mid, madd(a, dir, d)]
}

/** Instanced part sink: model, position, yaw, tint, pitch, roll, hit flash, alpha. */
export type PushPart = (model: number, x: number, y: number, z: number, yaw: number, tint: readonly [number, number, number], pitch: number, roll: number, flash: number, alpha?: number) => void

/**
 * Emits a part in a frame. The instance shader rotates by pitch about z, roll about x, then yaw about y (with plan
 * yaw sign), so the frame's basis is decomposed into those three angles.
 */
export function emit(push: PushPart, model: number, f: Frame, tint: readonly [number, number, number], flash: number, alpha = 1): void {
  const { x, y, z } = f
  const sb = Math.max(-1, Math.min(1, -z[1]))
  const b = Math.asin(sb)
  let a: number
  let c: number
  if (Math.abs(sb) > 0.99999) {
    c = 0
    a = Math.atan2(-x[2], x[0])
  } else {
    c = Math.atan2(x[1], y[1])
    a = Math.atan2(z[0], z[2])
  }
  push(model, f.p[0], f.p[1], f.p[2], -a, tint, c, b, flash, alpha)
}

/** Critically-ish damped spring toward zero; `x` is the offset, `v` its velocity. */
export type Spring = { x: number; v: number }
export const spring = (): Spring => ({ x: 0, v: 0 })

/** Steps a spring with stiffness k and damping ratio z toward `target`. */
export function stepSpring(s: Spring, k: number, z: number, dt: number, target = 0): void {
  const c = 2 * Math.sqrt(k) * z
  const n = Math.max(1, Math.ceil(dt / (1 / 240)))
  const h = dt / n
  for (let i = 0; i < n; i++) {
    s.v += (-(s.x - target) * k - s.v * c) * h
    s.x += s.v * h
  }
}

/** Kicks a spring: an instant partial jump plus velocity, so it snaps out and springs back. */
export function kick(s: Spring, amount: number, k: number): void {
  s.x += amount * 0.55
  s.v += amount * Math.sqrt(k) * 0.9
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
export const smooth = (t: number) => {
  const u = clamp(t, 0, 1)
  return u * u * (3 - 2 * u)
}
export const smoother = (t: number) => {
  const u = clamp(t, 0, 1)
  return u * u * u * (u * (u * 6 - 15) + 10)
}
