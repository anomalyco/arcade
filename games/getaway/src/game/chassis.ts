import { CELL, GRID, ROAD_HALF } from "../../shared/config"
import { rampSurface, type City } from "../../shared/sim/city"
import type { CarView } from "../../shared/sim/world"
import { KERB_H } from "../render/city/streets"
import { Chassis as SharedChassis, type AxlePoint } from "@arcade/kit/vehicle/chassis"
export { chassisSettings, springStep, wheelRotation, type ChassisSettings, type Spring, type AxlePoint, type WheelRotation } from "@arcade/kit/vehicle/chassis"

/** Rounded sidewalk and park height, matching the city mesh. */
export function curbHeight(city: City, x: number, z: number) {
  const ix = Math.floor(x / CELL), iz = Math.floor(z / CELL)
  if (ix < 0 || iz < 0 || ix >= GRID || iz >= GRID) return 0
  const a = x - ix * CELL - ROAD_HALF, b = z - iz * CELL - ROAD_HALF
  const width = CELL - ROAD_HALF * 2
  if (a < 0 || b < 0 || a > width || b > width) return 0
  const dx = Math.max(3 - a, a - (width - 3), 0), dz = Math.max(3 - b, b - (width - 3), 0)
  if (dx * dx + dz * dz > 9) return 0
  if (city.alleys.some(g => x > g.x0 && x < g.x1 && z > g.z0 && z < g.z1)) return 0
  return city.parks.some(p => x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1) || Math.min(a, b, width - a, width - b) <= city.sidewalk ? KERB_H : 0
}

/** Same rounded sidewalk footprint as the city mesh, plus the shared ramp profile. */
export function contactHeight(city: City, x: number, z: number) {
  let y = curbHeight(city, x, z)
  for (const ramp of city.ramps) y = Math.max(y, rampSurface(ramp, x, z)?.y ?? 0)
  return y
}
export class Chassis extends SharedChassis<City> {
  constructor(c: CarView, axles: readonly AxlePoint[]) { super(c, axles, contactHeight) }
}
