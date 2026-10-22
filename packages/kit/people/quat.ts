import type { V3 } from "../rig"

/** Unit quaternion `[x, y, z, w]`. */
export type Q = [number, number, number, number]

export const qId = (): Q => [0, 0, 0, 1]

export function qMul(a: Q, b: Q): Q {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]
}

export const qConj = (q: Q): Q => [-q[0], -q[1], -q[2], q[3]]

export function qNorm(q: Q): Q {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]
}

export function qRot(q: Q, v: V3): V3 {
  const [x, y, z, w] = q
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0])
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)]
}

export function qAxisAngle(axis: V3, angle: number): Q {
  const l = Math.hypot(axis[0], axis[1], axis[2]) || 1, s = Math.sin(angle / 2) / l
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)]
}

/** Rotation whose matrix columns are the orthonormal axes `a`, `b`, `c` (right-handed). */
export function qBasis(a: V3, b: V3, c: V3): Q {
  const m00 = a[0], m10 = a[1], m20 = a[2], m01 = b[0], m11 = b[1], m21 = b[2], m02 = c[0], m12 = c[1], m22 = c[2]
  const tr = m00 + m11 + m22
  let q: Q
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]
  }
  return qNorm(q)
}

/** Shortest rotation taking unit `a` to unit `b`. */
export function qFromTo(a: V3, b: V3): Q {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  if (d < -0.999999) {
    const axis: V3 = Math.abs(a[0]) < 0.9 ? [0, -a[2], a[1]] : [-a[2], 0, a[0]]
    return qAxisAngle(axis, Math.PI)
  }
  return qNorm([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0], 1 + d])
}

export function qSlerp(a: Q, b: Q, t: number): Q {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
  const s = d < 0 ? -1 : 1
  d *= s
  if (d > 0.9995) return qNorm([a[0] + (b[0] * s - a[0]) * t, a[1] + (b[1] * s - a[1]) * t, a[2] + (b[2] * s - a[2]) * t, a[3] + (b[3] * s - a[3]) * t])
  const th = Math.acos(d), sn = Math.sin(th), wa = Math.sin((1 - t) * th) / sn, wb = (Math.sin(t * th) / sn) * s
  return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb, a[3] * wa + b[3] * wb]
}

/** Angle of a rotation (radians, 0..π). */
export const qAngle = (q: Q) => 2 * Math.acos(Math.min(1, Math.abs(q[3])))

/** Writes a column-major 4×4 rigid transform (rotation q, translation p) times `post` (column-major) into `out` at `o`. */
export function writeMatrix(out: Float32Array, o: number, q: Q, p: V3, post: ArrayLike<number>, po: number): void {
  const [x, y, z, w] = q
  const r00 = 1 - 2 * (y * y + z * z), r01 = 2 * (x * y - z * w), r02 = 2 * (x * z + y * w)
  const r10 = 2 * (x * y + z * w), r11 = 1 - 2 * (x * x + z * z), r12 = 2 * (y * z - x * w)
  const r20 = 2 * (x * z - y * w), r21 = 2 * (y * z + x * w), r22 = 1 - 2 * (x * x + y * y)
  for (let c = 0; c < 4; c++) {
    const b0 = post[po + c * 4]!, b1 = post[po + c * 4 + 1]!, b2 = post[po + c * 4 + 2]!, b3 = post[po + c * 4 + 3]!
    out[o + c * 4] = r00 * b0 + r01 * b1 + r02 * b2 + p[0] * b3
    out[o + c * 4 + 1] = r10 * b0 + r11 * b1 + r12 * b2 + p[1] * b3
    out[o + c * 4 + 2] = r20 * b0 + r21 * b1 + r22 * b2 + p[2] * b3
    out[o + c * 4 + 3] = b3
  }
}
