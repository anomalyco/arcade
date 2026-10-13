import type { City } from "../../shared/sim/city"
import { SmokeTrail } from "@arcade/kit/fx/smoke-trail"
import { VehicleEmissions as SharedEmissions } from "@arcade/kit/vehicle/emissions"
export { EmissionState, drivenMask, tyreSlip, launchSlip, vehicleEffects } from "@arcade/kit/vehicle/emissions"

/** Match the lawn inset, crossing paths and fountain paving in render/city/parks.ts. */
export function tyreSurface(city: Pick<City, "parks"> | null, x: number, z: number) {
  if (city) for (const p of city.parks) {
    if (p.kind === "plaza" || x <= p.x0 + 3.2 || x >= p.x1 - 3.2 || z <= p.z0 + 3.2 || z >= p.z1 - 3.2) continue
    const dx = x - (p.x0 + p.x1) / 2, dz = z - (p.z0 + p.z1) / 2
    if (Math.abs(dx) > 1.8 && Math.abs(dz) > 1.8 && dx * dx + dz * dz > 10.5 ** 2) return 0
  }
  return 1
}
export class VehicleEmissions extends SharedEmissions<Pick<City, "parks">> {
  constructor(trail = new SmokeTrail()) { super(tyreSurface, trail) }
}
