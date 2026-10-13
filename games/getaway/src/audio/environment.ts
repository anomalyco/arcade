import type { City, Box } from "../../shared/sim/city"
import { CELL, ROAD_HALF } from "../../shared/config"
import type { Surface } from "./drivetrain"

/** Segment/AABB slab test at street height. No rays or render data on the audio thread. */
export function blocked(x: number, z: number, tx: number, tz: number, b: Pick<Box, "x0" | "x1" | "z0" | "z1">) {
  let lo = 0.01, hi = 0.99
  for (const [a, d, min, max] of [[x, tx - x, b.x0, b.x1], [z, tz - z, b.z0, b.z1]]) {
    if (Math.abs(d) < 1e-6) { if (a < min || a > max) return false; continue }
    const p = (min - a) / d, q = (max - a) / d
    lo = Math.max(lo, Math.min(p, q)); hi = Math.min(hi, Math.max(p, q))
    if (lo > hi) return false
  }
  return true
}

export class StreetAcoustics {
  density = 0
  private nearby: Box[] = []
  private next = -1
  constructor(private city?: City) {}
  update(x: number, z: number, t: number) {
    if (!this.city || t < this.next) return
    this.next = t + 0.2
    this.nearby = this.city.boxes.filter(b => b.h > 3 && b.x1 > x - 260 && b.x0 < x + 260 && b.z1 > z - 260 && b.z0 < z + 260)
    let count = 0
    for (const b of this.nearby) if (Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.z0 - z, 0, z - b.z1)) < 28) count++
    this.density = Math.min(1, count / 5)
  }
  occluded(x: number, z: number, tx: number, tz: number) { return this.nearby.some(b => blocked(x, z, tx, tz, b)) }
  surface(x: number, z: number): Surface {
    if (!this.city) return "road"
    if (this.city.parks.some(p => p.kind !== "plaza" && x > p.x0 && x < p.x1 && z > p.z0 && z < p.z1)) return "grass"
    if (this.city.alleys.some(p => x > p.x0 && x < p.x1 && z > p.z0 && z < p.z1)) return "road"
    const edge = (v: number) => Math.abs(((v % CELL) + CELL + CELL / 2) % CELL - CELL / 2)
    const d = Math.min(edge(x), edge(z))
    return d > ROAD_HALF && d < ROAD_HALF + this.city.sidewalk ? "kerb" : "road"
  }
}
