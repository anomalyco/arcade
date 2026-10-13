import { CELL, GRID, ROAD_HALF } from "../../shared/config"
import { rampSurface, type City } from "../../shared/sim/city"
import type { CarView } from "../../shared/sim/world"
import { KERB_H } from "../render/city/streets"
import { Chassis as SharedChassis, type AxlePoint } from "@arcade/kit/vehicle/chassis"
export { chassisSettings, springStep, wheelRotation, type ChassisSettings, type Spring, type AxlePoint, type WheelRotation } from "@arcade/kit/vehicle/chassis"

/** Same rounded sidewalk footprint as the city mesh, plus the shared ramp profile. */
export function contactHeight(city: City, x: number, z: number) {
  let y = 0
  const ix = Math.floor(x / CELL), iz = Math.floor(z / CELL)
  if (ix >= 0 && iz >= 0 && ix < GRID && iz < GRID) {
    const a = x - ix * CELL - ROAD_HALF, b = z - iz * CELL - ROAD_HALF
    const width = CELL - ROAD_HALF * 2
    const dx = Math.max(3 - a, a - (width - 3), 0), dz = Math.max(3 - b, b - (width - 3), 0)
    if (a >= 0 && b >= 0 && a <= width && b <= width && dx * dx + dz * dz <= 9 &&
      !city.alleys.some(g => x > g.x0 && x < g.x1 && z > g.z0 && z < g.z1)) {
      if (city.parks.some(p => x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1) || Math.min(a, b, width - a, width - b) <= city.sidewalk) y = KERB_H
    }
  }
  for (const ramp of city.ramps) y = Math.max(y, rampSurface(ramp, x, z)?.y ?? 0)
  return y
}
export class Chassis extends SharedChassis<City> {
  constructor(c: CarView, axles: readonly AxlePoint[]) { super(c, axles, contactHeight) }
}
