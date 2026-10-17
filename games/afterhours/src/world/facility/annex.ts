import * as THREE from "three/webgpu"
import { ANNEX_DOOR, BUILDING } from "../layout"
import type { WorldContext } from "../context"
import { Batch, SKIP_BOTTOM } from "./geo"

// The annex interior behind the ground-floor door from the main block (building program: Facilities & Plant, the
// night janitor's home base). A short block corridor east from the door into the plant room: boiler with its flue,
// two circulating pumps, pipe runs under the ceiling, the electrical cabinets and the janitor's shelves (models placed
// by props.ts). The rest of the annex is closed off; its windows keep their fake rooms.

const FY = BUILDING.floorY
const CEIL = 4.2
const WT = 0.2
const DZ = ANNEX_DOOR.z
export const ANNEX_CORRIDOR = { x0: BUILDING.annex.min[0], x1: 44, z0: DZ - 1.1, z1: DZ + 1.1 }
export const ANNEX_PLANT = { x0: 44 + WT, x1: 54, z0: -16, z1: -2 }

export function buildAnnex(ctx: WorldContext, b: Batch) {
  const C = ANNEX_CORRIDOR
  const R = ANNEX_PLANT
  const wall = (x0: number, z0: number, x1: number, z1: number) => {
    b.box("concrete_block", x0, FY, z0, x1, CEIL, z1, SKIP_BOTTOM)
    ctx.colliders.push({ min: [x0, -0.5, z0], max: [x1, CEIL, z1] })
  }
  // Corridor walls (the main block's east wall closes the west end; the door is there).
  wall(C.x0, C.z0 - WT, C.x1 + WT, C.z0)
  wall(C.x0, C.z1, C.x1 + WT, C.z1 + WT)
  // Plant room: west wall with an open doorway from the corridor, then north, east and south walls.
  wall(R.x0 - WT, R.z0, R.x0, C.z0 - WT)
  wall(R.x0 - WT, C.z1 + WT, R.x0, R.z1)
  wall(R.x0 - WT, R.z0 - WT, R.x1 + WT, R.z0)
  wall(R.x0 - WT, R.z1, R.x1 + WT, R.z1 + WT)
  wall(R.x1, R.z0, R.x1 + WT, R.z1)
  b.box("concrete_block", R.x0 - WT, 2.3, C.z0, R.x0, CEIL, C.z1)
  // Dry sealed floor and a plain concrete ceiling over both.
  b.box("concrete_floor_dry", C.x0, FY, C.z0, R.x0, FY + 0.004, C.z1)
  b.box("concrete_floor_dry", R.x0, FY, R.z0, R.x1, FY + 0.004, R.z1)
  b.box("concrete_dark", C.x0, CEIL, C.z0 - WT, R.x0, CEIL + 0.1, C.z1 + WT)
  b.box("concrete_dark", R.x0 - WT, CEIL, R.z0 - WT, R.x1 + WT, CEIL + 0.1, R.z1 + WT)

  // Fluorescent strips: one in the corridor, two over the plant.
  const tube = (x: number, z: number, along: "x" | "z", flicker = 0) => {
    const [hx, hz] = along === "x" ? [0.62, 0.08] : [0.08, 0.62]
    b.box("metal_painted", x - hx, CEIL - 0.08, z - hz, x + hx, CEIL, z + hz)
    b.box("emissive_fluorescent", x - hx + 0.03, CEIL - 0.1, z - hz + 0.02, x + hx - 0.03, CEIL - 0.08, z + hz - 0.02)
    ctx.lamps.push({ kind: "fluorescent", position: [x, CEIL - 0.12, z], direction: [0, -1, 0], color: [0.92, 1, 0.95], intensity: 55, range: 9, angle: 1.3, penumbra: 0.8, size: 1.2, flicker })
  }
  tube(39.5, DZ, "x")
  tube(47.5, -10, "z", 0.25)
  tube(51.5, -6, "z")

  // Boiler: insulated casing on a plinth, burner box, flue to the ceiling, gauges.
  {
    const [x, z] = [49.5, -13.6]
    b.box("concrete_dark", x - 1.5, FY, z - 1.1, x + 1.5, FY + 0.15, z + 1.1)
    b.box("metal_painted", x - 1.3, FY + 0.15, z - 0.9, x + 1.3, FY + 2.1, z + 0.9)
    for (const dx of [-0.8, 0, 0.8]) b.box("metal_dark", x + dx - 0.02, FY + 0.2, z + 0.9, x + dx + 0.02, FY + 2.05, z + 0.92)
    b.box("metal_dark", x - 1.65, FY + 0.5, z - 0.4, x - 1.3, FY + 1.3, z + 0.4)
    b.cylinder("metal_galvanized", x + 0.7, FY + 2.1, z, 0.22, CEIL - FY - 2.1, 14)
    for (const dx of [-0.6, -0.35]) {
      const g = new THREE.CylinderGeometry(0.06, 0.06, 0.03, 14)
      g.rotateX(Math.PI / 2)
      g.translate(x + dx, FY + 1.6, z + 0.93)
      b.add("chrome", g)
    }
    ctx.colliders.push({ min: [x - 1.65, -0.5, z - 1.1], max: [x + 1.5, FY + 2.2, z + 1.1] })
    // Supply and return headers along the north wall, up and across under the ceiling.
    for (const [dz, r] of [[1.25, 0.08], [1.5, 0.06]] as const) {
      b.strut("metal_painted", new THREE.Vector3(x - 1.0, FY + 2.1, z + dz - 2.3), new THREE.Vector3(x - 1.0, CEIL - 0.35, z + dz - 2.3), r * 2, true)
      b.strut("metal_painted", new THREE.Vector3(R.x0 + 0.3, CEIL - 0.35, z + dz - 2.3), new THREE.Vector3(R.x1 - 0.3, CEIL - 0.35, z + dz - 2.3), r * 2, true)
    }
  }
  // Two circulating pumps on a shared plinth with their valves.
  {
    const [x, z] = [52.2, -9]
    b.box("concrete_dark", x - 0.7, FY, z - 1.4, x + 0.7, FY + 0.12, z + 1.4)
    for (const dz of [-0.7, 0.7]) {
      const motor = new THREE.CylinderGeometry(0.2, 0.2, 0.55, 16)
      motor.rotateZ(Math.PI / 2)
      motor.translate(x + 0.15, FY + 0.45, z + dz)
      b.add("metal_painted", motor)
      b.box("metal_dark", x - 0.35, FY + 0.12, z + dz - 0.18, x - 0.05, FY + 0.6, z + dz + 0.18)
      b.cylinder("metal_painted", x - 0.2, FY + 0.6, z + dz, 0.07, CEIL - 0.35 - FY - 0.6, 12)
      b.cylinder("metal_dark", x - 0.2, FY + 1.4, z + dz, 0.11, 0.08, 12)
    }
    ctx.colliders.push({ min: [x - 0.7, -0.5, z - 1.4], max: [x + 0.7, FY + 0.8, z + 1.4] })
  }
}
