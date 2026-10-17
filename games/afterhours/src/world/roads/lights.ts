import * as THREE from "three/webgpu"
import { ACCESS_ROAD, COUNTY_ROAD, countyRoadZ } from "../layout"
import type { WorldContext } from "../context"
import { heightAt } from "../height"
import { Line, MeshBuilder, Parts, cylM, boxM, poleWood, tubeInto } from "./util"
import { HA, HC, type Junction } from "./surface"
import { sag, type Pole } from "./power"
import type { Wires } from "./wires"

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
  const dome = new THREE.SphereGeometry(1, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2)
  parts.add("metal_painted", dome, at(new THREE.Matrix4().makeTranslation(0.52, -0.01, 0).scale(new THREE.Vector3(0.4, 0.13, 0.18))))
  parts.add("metal_dark", cylM(0.18, 0.18, 0.03, 16), at(new THREE.Matrix4().makeTranslation(0.52, -0.02, 0).scale(new THREE.Vector3(2.2, 1, 1))))
  const lens = new THREE.SphereGeometry(1, 24, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2)
  parts.add("emissive_sodium", lens, at(new THREE.Matrix4().makeTranslation(0.55, -0.03, 0).scale(new THREE.Vector3(0.3, 0.028, 0.13))))
  return new THREE.Vector3(0.55, -0.07, 0).applyMatrix4(m)
}

// Full cut-off heads: flat glass under the housing, a tight cone, so the light pools on the road and the verge stays
// dark; seen from afar each head is a small crisp point in a receding row (r3-05 / r5-04).
function addLamp(ctx: WorldContext, p: THREE.Vector3, shadow: boolean, intensity = 2600) {
  ctx.lamps.push({
    kind: "sodium",
    position: [p.x, p.y, p.z],
    direction: [0, -1, 0],
    color: SODIUM,
    intensity,
    range: 20,
    angle: 0.46,
    penumbra: 0.3,
    shadow,
    size: 0.28,
  })
}

/** Galvanised davit pole with a shepherd's-crook arm reaching (dx, dz) over the road. */
function davit(ctx: WorldContext, parts: Parts, x: number, z: number, dx: number, dz: number, shadow: boolean) {
  const g = heightAt(x, z)
  const base = frameAt(x, g, z, dx, dz)
  const h = 8.2
  parts.add("metal_galvanized", cylM(0.065, 0.11, h, 16), base.clone().multiply(new THREE.Matrix4().makeTranslation(0, h / 2, 0)))
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

/** Upswept mast arm on a wooden pole frame `pole` (origin at ground, +X towards the road), with its cobra head. */
function mastArm(ctx: WorldContext, parts: Parts, pole: THREE.Matrix4, y: number, reach: number, shadow: boolean) {
  const curve = new THREE.CubicBezierCurve3(
    new THREE.Vector3(0.12, y, 0),
    new THREE.Vector3(reach * 0.45, y + 0.02, 0),
    new THREE.Vector3(reach * 0.6, y + 0.5, 0),
    new THREE.Vector3(reach, y + 0.55, 0),
  )
  const arm = new MeshBuilder()
  tubeInto(arm, curve.getPoints(14), 0.035, 8)
  tubeInto(arm, [new THREE.Vector3(0.14, y - 0.7, 0), new THREE.Vector3(reach * 0.42, y + 0.02, 0)], 0.018, 6)
  parts.add("metal_galvanized", arm.geometry(), pole)
  parts.add("metal_galvanized", boxM(0.06, 1.0, 0.16), pole.clone().multiply(new THREE.Matrix4().makeTranslation(0.13, y - 0.35, 0)))
  const head = cobraHead(parts, pole.clone().multiply(frameAt(reach, y + 0.55, 0, 1, 0)))
  addLamp(ctx, head, shadow)
}

/** The lit stretch of county road either side of the junction (x range). */
export const LIT = [-290, 150] as const
const SOUTH_OFFSET = HC + COUNTY_ROAD.shoulder + 1.6

export function buildLights(
  ctx: WorldContext,
  parts: Parts,
  wires: Wires,
  access: Line,
  county: Line,
  j: Junction,
  corner: Pole,
  countyPoles: readonly Pole[],
) {
  // Junction: mast arm off the corner utility pole, reaching towards the middle of the junction.
  const mid = access.at(j.sStart - 1.5)
  {
    const f = corner.frame.clone().multiply(frameAt(0, 0, 0, mid.x - corner.x, mid.z - corner.z))
    mastArm(ctx, parts, f, 6.5, 3.6, false)
  }

  // North side: arms on the utility poles through the lit stretch.
  const countyNormal = (x: number): [number, number] => {
    const dz = (9 / 140) * Math.cos(x / 140)
    const l = Math.hypot(1, dz)
    return [-dz / l, 1 / l]
  }
  for (const p of countyPoles) {
    if (p === corner || p.x < LIT[0] || p.x > LIT[1]) continue
    const [nx, nz] = countyNormal(p.x)
    mastArm(ctx, parts, p.frame.clone().multiply(frameAt(0, 0, 0, nx, nz)), 6.9, 4.6, false)
  }

  // South side: a staggered row of wooden streetlight poles carrying a two-wire secondary line (r3-05).
  const south: { x: number; z: number; tops: THREE.Vector3[] }[] = []
  for (let x = corner.x + 21 - 42 * 8; x <= LIT[1] + 21; x += 42) {
    if (x < LIT[0] - 21) continue
    const xx = x + Math.sin(x * 0.37) * 1.5
    const z = countyRoadZ(xx) + SOUTH_OFFSET
    const g = heightAt(xx, z)
    const [nx, nz] = countyNormal(xx)
    const f = frameAt(xx, g, z, -nx, -nz)
    const top = 9.2 + Math.sin(x) * 0.2
    parts.add(poleWood(), cylM(0.1, 0.145, top + 1.2, 14), f.clone().multiply(new THREE.Matrix4().makeTranslation(0, (top - 1.2) / 2, 0)))
    parts.add(poleWood(), cylM(0.105, 0.105, 0.05, 14), f.clone().multiply(new THREE.Matrix4().makeTranslation(0, top + 0.02, 0)))
    // Short crossarm along the road normal with two insulators.
    const arm = f.clone().multiply(new THREE.Matrix4().makeTranslation(0, top - 0.45, 0.15))
    parts.add(poleWood(), boxM(1.5, 0.09, 0.11), arm)
    const tops: THREE.Vector3[] = []
    for (const ix of [-0.6, 0.6]) {
      parts.add("glass_dark", cylM(0.03, 0.055, 0.1, 10), arm.clone().multiply(new THREE.Matrix4().makeTranslation(ix, 0.1, 0)))
      tops.push(new THREE.Vector3(ix, 0.17, 0).applyMatrix4(arm))
    }
    south.push({ x: xx, z, tops })
    mastArm(ctx, parts, f, 7.2, 4.6, false)
    ctx.colliders.push({ min: [xx - 0.2, g, z - 0.2], max: [xx + 0.2, g + top, z + 0.2] })
  }
  for (let i = 0; i < south.length - 1; i++) {
    const a = south[i]!
    const b = south[i + 1]!
    const span = Math.hypot(b.x - a.x, b.z - a.z)
    for (let w = 0; w < 2; w++) wires.add(sag(a.tops[w]!, b.tops[w]!, span * (0.016 + 0.004 * Math.abs(Math.sin(i * 2.3 + w))), Math.round(span / 3)), 0.0068)
  }

  // One davit on the approach (west side, behind the r5-03 view); the guard booth's own lamp (compound) lights the gate.
  {
    let s = j.sStart
    for (const p of access.pts) if (p.z >= 206) s = p.s
    const p = access.at(s)
    const [x, z] = access.offset(s, -(HA + ACCESS_ROAD.shoulder + 0.9))
    davit(ctx, parts, x, z, -p.tz, p.tx, true)
  }
}
