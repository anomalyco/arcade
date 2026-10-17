import * as THREE from "three/webgpu"
import type { WorldContext } from "../context"
import { material } from "../../render/materials"
import { Batch, box, cyl, matrix, rod, sphere } from "./geo"
import { flat } from "./mats"

// Small procedural outdoor clutter with no model in the library: bollards and a bare flagpole. One merged batch.
// The modelled props (dumpsters, hydrant, bench, wet-floor sign, ...) are in compound/models.ts.

/** Top of the facility's perimeter walk (facility/grounds.ts), where props by the building stand. */
export const FACILITY_WALK_Y = 0.03

const safetyYellow = () => flat(0x9a7e18, 0.65, 0.2)

function bollard(b: Batch, x: number, z: number, y = 0) {
  b.at(safetyYellow(), cyl(0.08, 0.08, 1.0, 18), x, y + 0.5, z)
  b.at(safetyYellow(), sphere(0.08, 18, 6, 0, Math.PI / 2), x, y + 1.0, z)
  b.at(flat(0x2a2a26, 0.7), cyl(0.081, 0.081, 0.08, 18, true), x, y + 0.82, z)
}

function flagpole(b: Batch) {
  const h = 10
  b.at(material("concrete_wall"), box(1.2, 0.2, 1.2), 0, 0.1, 0)
  b.at(material("metal_galvanized"), cyl(0.04, 0.075, h, 10), 0, 0.2 + h / 2, 0)
  b.at(flat(0x8a7a40, 0.35, 0.8), sphere(0.08, 10, 8), 0, 0.2 + h + 0.06, 0)
  b.at(material("metal_dark"), cyl(0.07, 0.07, 0.08, 8), 0, 0.2 + h - 0.1, 0)
  // Halyard slack against the pole down to a cleat.
  b.add(flat(0xb0aa98, 0.9), rod({ x: 0.06, y: 0.2 + h - 0.12, z: 0 }, { x: 0.09, y: 1.25, z: 0.02 }, 0.004, 3))
  b.add(flat(0xb0aa98, 0.9), rod({ x: 0.04, y: 0.2 + h - 0.12, z: 0.03 }, { x: 0.08, y: 1.25, z: 0.03 }, 0.004, 3))
  b.at(material("metal_dark"), box(0.03, 0.18, 0.05), 0.085, 1.25, 0)
}

export function buildProps(ctx: WorldContext, root: THREE.Object3D, walkY: number) {
  const batch = new Batch()
  const at = (x: number, y: number, z: number, yaw = 0) => batch.child(matrix(x, y, z, yaw))

  // Bollards at the head of the entrance walk and beside the booth.
  for (const x of [-3.0, 3.0]) {
    bollard(batch, x, 36.6, walkY)
    ctx.colliders.push({ min: [x - 0.1, 0, 36.5], max: [x + 0.1, 1.1, 36.7] })
  }
  for (const z of [126.3, 128.7]) {
    bollard(batch, 6.85, z, 0.12)
    ctx.colliders.push({ min: [6.75, 0, z - 0.1], max: [6.95, 1.1, z + 0.1] })
  }

  // Flagpole without a flag on the lawn west of the apron.
  flagpole(at(-13, 0, 29.5))
  ctx.colliders.push({ min: [-13.6, 0, 28.9], max: [-12.4, 10, 30.1] })
  ctx.floors.push({ min: [-13.6, 28.9], max: [-12.4, 30.1], y: 0.2 })

  batch.build(root, { castShadow: true, name: "props" })
}
