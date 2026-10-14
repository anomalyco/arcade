import { blocked } from "@arcade/kit/audio"
import type { City, Box } from "../../shared/sim/city"
import { CELL, ROAD_HALF } from "../../shared/config"
import type { Surface } from "./drivetrain"

export { blocked }

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
