import type { Rect } from "@arcade/kit/sim/geom"

/**
 * Baked lamp pools for the bounce texture: the direct light a room lamp throws on the floor, line-of-sight tested
 * against the walls on the bake grid, so a lamp lights its own room and spills through its doorways but never through
 * a wall. Room accent lamps are not live lights while the camera is inside (only the shadow-casting lamp is), so this
 * is what lights those rooms; the shader scales it with the hour and the room-lamp power, and the flashlight adds on
 * top. Pure and deterministic: the origin town and every streamed chunk bake it the same way, once.
 */

/** A lamp resolved for baking: plan position, height, reach, linear colour × power. */
export type BakeLamp = { x: number; z: number; h: number; r: number; color: readonly [number, number, number]; power: number }

/** Wall cells of a `res × res` grid of `cell`-metre cells from (x0, z0). */
export function wallGrid(walls: readonly Rect[], x0: number, z0: number, res: number, cell: number, out = new Uint8Array(res * res)): Uint8Array {
  for (const r of walls) {
    const a0 = Math.max(0, Math.floor((r[0] - x0) / cell))
    const a1 = Math.min(res - 1, Math.ceil((r[2] - x0) / cell) - 1)
    const b0 = Math.max(0, Math.floor((r[1] - z0) / cell))
    const b1 = Math.min(res - 1, Math.ceil((r[3] - z0) / cell) - 1)
    for (let z = b0; z <= b1; z++) for (let x = a0; x <= a1; x++) out[z * res + x] = 1
  }
  return out
}

/** Whether the segment between two grid points (in cells) crosses no wall cell, sampled every quarter cell. */
export function gridClear(solid: Uint8Array, res: number, ax: number, az: number, bx: number, bz: number): boolean {
  const dx = bx - ax
  const dz = bz - az
  const n = Math.ceil(Math.max(Math.abs(dx), Math.abs(dz)) * 4)
  for (let i = 1; i < n; i++) {
    const t = i / n
    const x = Math.floor(ax + dx * t)
    const z = Math.floor(az + dz * t)
    if (x < 0 || z < 0 || x >= res || z >= res) continue
    if (solid[z * res + x]) return false
  }
  return true
}

/** Share of a lamp's power the pool gets at the foot of the lamp; the shader's Look knob scales the whole bake. */
export const POOL_STRENGTH = 4.0

/**
 * Adds a lamp's floor pool into `acc` (linear rgb per cell): cosine-weighted inverse-square from the bulb at height
 * `h`, normalised to 1 under the lamp and windowed to its reach, only where the cell centre sees the bulb's cell.
 */
export function addLampPool(acc: Float32Array, solid: Uint8Array, res: number, x0: number, z0: number, cell: number, lamp: BakeLamp): void {
  const h2 = lamp.h * lamp.h
  const reach = lamp.r
  let lx = (lamp.x - x0) / cell
  let lz = (lamp.z - z0) / cell
  const lc = (x: number, z: number) => Math.floor(z) * res + Math.floor(x)
  if (lx >= 0 && lz >= 0 && lx < res && lz < res && solid[lc(lx, lz)]) {
    // A lamp against a wall: look from the nearest open cell instead.
    for (const [ox, oz] of [[0, 0.75], [0, -0.75], [0.75, 0], [-0.75, 0]] as const) {
      const nx = lx + ox
      const nz = lz + oz
      if (nx >= 0 && nz >= 0 && nx < res && nz < res && !solid[lc(nx, nz)]) {
        lx = nx
        lz = nz
        break
      }
    }
  }
  const a0 = Math.max(0, Math.floor(lx - reach / cell))
  const a1 = Math.min(res - 1, Math.ceil(lx + reach / cell))
  const b0 = Math.max(0, Math.floor(lz - reach / cell))
  const b1 = Math.min(res - 1, Math.ceil(lz + reach / cell))
  const k = lamp.power * POOL_STRENGTH
  for (let z = b0; z <= b1; z++) {
    for (let x = a0; x <= a1; x++) {
      const i = z * res + x
      if (solid[i]) continue
      const d2 = (((x + 0.5) - lx) ** 2 + ((z + 0.5) - lz) ** 2) * cell * cell
      if (d2 >= reach * reach) continue
      if (!gridClear(solid, res, lx, lz, x + 0.5, z + 0.5)) continue
      const win = 1 - d2 / (reach * reach)
      const cos3 = (h2 / (d2 + h2)) ** 1.5
      const f = k * cos3 * win * win
      acc[i * 3] += lamp.color[0] * f
      acc[i * 3 + 1] += lamp.color[1] * f
      acc[i * 3 + 2] += lamp.color[2] * f
    }
  }
}
