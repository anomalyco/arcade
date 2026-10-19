import type { Mat, Mesh, Rgb } from "@arcade/kit/gpu/mesh"

/**
 * A wall-local frame for fittings (windows, cabinetry): `u` runs along the wall, `d` across it from the room face (0)
 * towards the wall's far side (`out` gives that direction in world), `y` is up. The room is at negative `d`.
 */
export type Frame = {
  alongX: boolean
  /** World coordinate of the room face, and the sign from room to street. */
  inner: number
  out: 1 | -1
}

/** Axis-aligned box in the local frame. */
export function lbox(m: Mesh, f: Frame, u0: number, u1: number, y0: number, y1: number, d0: number, d1: number, col: Rgb, mat: Mat, aux = 0, top?: Rgb): void {
  const a = f.inner + f.out * d0, b = f.inner + f.out * d1
  const n0 = Math.min(a, b), n1 = Math.max(a, b)
  if (f.alongX) m.box(u0, y0, n0, u1, y1, n1, col, mat, aux, top)
  else m.box(n0, y0, u0, n1, y1, u1, col, mat, aux, top)
}

export const world = (f: Frame, u: number, y: number, d: number): number[] => (f.alongX ? [u, y, f.inner + f.out * d] : [f.inner + f.out * d, y, u])

/** A quad in the local frame, wound so its normal faces the room (`towardRoom`) or the street. */
export function lquad(m: Mesh, f: Frame, p: readonly (readonly [number, number, number])[], col: Rgb, mat: Mat, towardRoom: boolean): void {
  const [a, b, c, d] = p.map(q => world(f, q[0], q[1], q[2])) as [number[], number[], number[], number[]]
  const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!, uz = b[2]! - a[2]!
  const wx = c[0]! - a[0]!, wy = c[1]! - a[1]!, wz = c[2]! - a[2]!
  const nx = uy * wz - uz * wy, nz = ux * wy - uy * wx
  // Room side is -d, i.e. -out along the wall normal.
  const along = (f.alongX ? nz : nx) * f.out
  const ok = towardRoom ? along <= 0 : along >= 0
  if (ok) m.quadAuto(a, b, c, d, col, mat)
  else m.quadAuto(a, d, c, b, col, mat)
}

