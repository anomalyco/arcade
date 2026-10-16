import * as THREE from "three/webgpu"
import { ACCESS_ROAD, COUNTY_ROAD } from "../layout"
import type { WorldContext } from "../context"
import { heightAt } from "../height"
import { Line, MeshBuilder, Parts, cylM, boxM, tubeInto } from "./util"
import { HA, HC, type Junction } from "./surface"
import type { Pole } from "./power"

// Sodium "cobra head" streetlights: two at the junction (one on a mast arm off the corner utility pole, one on its
// own wooden pole across the county road) and two on galvanised davit poles along the last stretch to the gate.

const SODIUM: readonly [number, number, number] = [1.0, 0.55, 0.18]

/** Horizontal frame at (x, y, z) whose +X points along (dx, dz). */
function frameAt(x: number, y: number, z: number, dx: number, dz: number) {
  const X = new THREE.Vector3(dx, 0, dz).normalize()
  const Yv = new THREE.Vector3(0, 1, 0)
  const Z = new THREE.Vector3().crossVectors(X, Yv)
  return new THREE.Matrix4().makeBasis(X, Yv, Z).setPosition(x, y, z)
}

/** Cobra-head luminaire at the end of an arm; `m` points +X away from the pole. Returns the lens centre. */
function cobraHead(parts: Parts, m: THREE.Matrix4) {
  const at = (t: THREE.Matrix4) => m.clone().multiply(t)
  const rotZ = new THREE.Matrix4().makeRotationZ(Math.PI / 2)
  // Slip fitter over the arm end.
  parts.add("metal_painted", cylM(0.04, 0.045, 0.22, 8), at(new THREE.Matrix4().makeTranslation(0.08, 0, 0).multiply(rotZ)))
  // Housing: a long shallow dome, lens below it.
  const dome = new THREE.SphereGeometry(1, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2)
  parts.add("metal_painted", dome, at(new THREE.Matrix4().makeTranslation(0.52, -0.01, 0).scale(new THREE.Vector3(0.4, 0.13, 0.18))))
  parts.add("metal_dark", cylM(0.18, 0.18, 0.03, 16), at(new THREE.Matrix4().makeTranslation(0.52, -0.02, 0).scale(new THREE.Vector3(2.2, 1, 1))))
  const lens = new THREE.SphereGeometry(1, 16, 5, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2)
  parts.add("emissive_sodium", lens, at(new THREE.Matrix4().makeTranslation(0.55, -0.03, 0).scale(new THREE.Vector3(0.3, 0.07, 0.13))))
  return new THREE.Vector3(0.55, -0.08, 0).applyMatrix4(m)
}

function addLamp(ctx: WorldContext, p: THREE.Vector3, shadow: boolean) {
  ctx.lamps.push({
    kind: "sodium",
    position: [p.x, p.y, p.z],
    direction: [0, -1, 0],
    color: SODIUM,
    intensity: 5200,
    range: 35,
    angle: 1.0,
    penumbra: 0.55,
    shadow,
    size: 0.5,
  })
}

/** Galvanised davit pole with a shepherd's-crook arm reaching (dx, dz) over the road. */
function davit(ctx: WorldContext, parts: Parts, x: number, z: number, dx: number, dz: number, shadow: boolean) {
  const g = heightAt(x, z)
  const base = frameAt(x, g, z, dx, dz)
  const h = 8.2
  parts.add("metal_galvanized", cylM(0.065, 0.11, h, 10), base.clone().multiply(new THREE.Matrix4().makeTranslation(0, h / 2, 0)))
  parts.add("concrete_dark", cylM(0.26, 0.3, 0.5, 10), base.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0.05, 0)))
  parts.add("metal_galvanized", cylM(0.16, 0.16, 0.05, 10), base.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0.32, 0)))
  parts.add("metal_dark", boxM(0.07, 0.16, 0.02), base.clone().multiply(new THREE.Matrix4().makeTranslation(-0.1, 0.9, 0)))
  const curve = new THREE.CubicBezierCurve3(
    new THREE.Vector3(0, h - 0.4, 0),
    new THREE.Vector3(0, h + 0.75, 0),
    new THREE.Vector3(0.6, h + 0.95, 0),
    new THREE.Vector3(2.5, h + 0.75, 0),
  )
  const arm = new MeshBuilder()
  tubeInto(arm, curve.getPoints(18), 0.045, 8)
  parts.add("metal_galvanized", arm.geometry(), base)
  const head = cobraHead(parts, base.clone().multiply(frameAt(2.5, h + 0.75, 0, 1, 0)))
  addLamp(ctx, head, shadow)
  ctx.colliders.push({ min: [x - 0.3, g, z - 0.3], max: [x + 0.3, g + h, z + 0.3] })
}

/** Straight mast arm with a brace on a wooden pole frame `pole` (origin at ground, +X towards the road). */
function mastArm(ctx: WorldContext, parts: Parts, pole: THREE.Matrix4, y: number, reach: number, shadow: boolean) {
  const arm = new MeshBuilder()
  tubeInto(arm, [new THREE.Vector3(0.12, y, 0), new THREE.Vector3(reach, y + 0.3, 0)], 0.04, 8)
  tubeInto(arm, [new THREE.Vector3(0.14, y - 0.8, 0), new THREE.Vector3(reach * 0.55, y + 0.16, 0)], 0.022, 6)
  parts.add("metal_galvanized", arm.geometry(), pole)
  parts.add("metal_galvanized", boxM(0.06, 1.0, 0.16), pole.clone().multiply(new THREE.Matrix4().makeTranslation(0.13, y - 0.4, 0)))
  const head = cobraHead(parts, pole.clone().multiply(frameAt(reach, y + 0.3, 0, 1, 0)))
  addLamp(ctx, head, shadow)
}

export function buildLights(ctx: WorldContext, parts: Parts, access: Line, county: Line, j: Junction, corner: Pole) {

  // J1: mast arm off the corner utility pole, reaching towards the middle of the junction.
  const mid = access.at(j.sStart - 1.5)
  {
    const dx = mid.x - corner.x
    const dz = mid.z - corner.z
    const f = corner.frame.clone().multiply(frameAt(0, 0, 0, dx, dz))
    mastArm(ctx, parts, f, 6.5, 3.6, false)
  }

  // J2: its own wooden pole on the south side of the county road, facing the mouth of the access road.
  {
    const sc = (j.countyGap[0] + j.countyGap[1]) / 2 - 6
    const [x, z] = county.offset(sc, HC + COUNTY_ROAD.shoulder + 1.3)
    const g = heightAt(x, z)
    const p = county.at(sc)
    const f = frameAt(x, g, z, p.tz, -p.tx)
    parts.add("wood_pole", cylM(0.1, 0.14, 10, 9), f.clone().multiply(new THREE.Matrix4().makeTranslation(0, 4, 0)))
    parts.add("wood_pole", cylM(0.105, 0.105, 0.05, 9), f.clone().multiply(new THREE.Matrix4().makeTranslation(0, 9.02, 0)))
    mastArm(ctx, parts, f, 7.6, 3.4, false)
    ctx.colliders.push({ min: [x - 0.2, g, z - 0.2], max: [x + 0.2, g + 9, z + 0.2] })
  }

  // Davits along the approach to the gate on the west side; the guard booth's own lamp (compound) lights the gate.
  for (const zTarget of [190, 158]) {
    let s = j.sStart
    for (const p of access.pts) if (p.z >= zTarget) s = p.s
    const p = access.at(s)
    const [x, z] = access.offset(s, -(HA + ACCESS_ROAD.shoulder + 0.9))
    davit(ctx, parts, x, z, -p.tz, p.tx, true)
  }
}
