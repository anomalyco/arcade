import type { VehicleSpec, PartMap } from "../intro/car"
import PARTS from "./truck-parts.json"

// Truck 2: the station's field pickup, a compact two-door early-80s pickup (the shared `car_pickup` model, "Conquer '89
// Pickup" by Daniel Zhabotinsky, CC BY 4.0, credited in public/models/CREDITS.md). Same split / lights / seat pipeline
// as the intro sedan (src/game/intro/car.ts), from its own part map (`bun scripts/intro/car-parts.ts car_pickup`).
// Model space: metres, front -Z, driver on the left (-X).

export const TRUCK: VehicleSpec = {
  model: "car_pickup",
  parts: PARTS as PartMap,
  size: { width: 1.789, height: 1.746, length: 4.5 },
  seats: [
    { id: "driver", eye: [-0.3, 1.37, 0.08], door: "door_fl", driver: true },
    { id: "passenger", eye: [0.3, 1.36, 0.06], door: null, driver: false },
  ],
  head: [
    [-0.5, 0.74, -2.13],
    [0.5, 0.74, -2.13],
  ],
  tail: [
    [-0.62, 0.74, 2.17],
    [0.62, 0.74, 2.17],
  ],
  dash: [-0.3, 1.03, -0.8],
  // Door card inner face x ≈ -0.545, its top (the window sill) y ≈ 1.05 (truck-parts.json `nodes`).
  rig: { hip: [-0.3, 0.715, -0.06], handle: [-0.53, 0.93, -0.62], edge: [-0.53, 1.0, -0.05] },
  // 0.151 outer.
  rim: { radius: 0.135, tube: 0.016, cut: 0.115 },
  steerRatio: 17,
  beam: [0, 0.74, -2.35],
}
