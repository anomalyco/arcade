import * as THREE from "three/webgpu"
import { uniform } from "three/tsl"
import { BUILDING } from "../layout"
import type { Lamp, WorldContext } from "../context"
import { Batch } from "./geo"
import { MAIN_ROOF_Y } from "./shell"

// The rooftop radio telescope: a rooftop plant-room plinth, a flared concrete pedestal, a steel turntable and yoke
// that turn with azimuth, and the 17 m parabolic reflector with its radial back trusses, quadrupod feed legs and
// feed cabin, tilted about the elevation axle. A red aircraft obstruction light blinks on the top of the rim.
//
// Orientation: `dish.tilt` is the boresight's angle from vertical, `dish.yaw` follows the viewpoint convention
// (0 looks north, positive turns towards -X), so yaw π faces the reflector south, over the car park.

const D = BUILDING.dish
const R = D.diameter / 2
const F = R * 0.73
const DEPTH = (R * R) / (4 * F)
/** Vertex of the reflector in front of the elevation axle (dish-local +Y). */
const VERTEX = 1.6
export const PENTHOUSE = { min: [-12, -14] as const, max: [22, 7] as const, top: MAIN_ROOF_Y + 2.6 }
/** The 17 m layout dish read as a toy on top of the five-storey block; the mount and dish scale up together. */
export const DISH_SCALE = 1.5
const PED_TOP_WORLD = MAIN_ROOF_Y + 8.2
// Mount dimensions below are authored at 17 m scale, relative to a pedestal top at PED_TOP.
const PED_TOP = 11.6
const AXIS_Y = PED_TOP + 3.4
const TURN_TOP = PED_TOP + 0.3
const HOUSING_TOP = AXIS_Y - 1.1

export type DishControls = { tilt: number; yaw: number }

function orient(g: THREE.BufferGeometry, wantY: 1 | -1) {
  const n = g.attributes.normal!
  let sum = 0
  for (let i = 0; i < n.count; i++) sum += n.getY(i)
  if (Math.sign(sum) === wantY) return g
  const idx = g.index!
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i + 1)
    idx.setX(i + 1, idx.getX(i + 2))
    idx.setX(i + 2, a)
  }
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i))
  return g
}

const profileY = (r: number) => VERTEX + (r * r) / (4 * F)

export function buildDish(ctx: WorldContext, root: THREE.Object3D, staticBatch: Batch) {
  // Plinth on the roof (plant room) with its own coping, and the flared pedestal.
  const P = PENTHOUSE
  staticBatch.box("concrete_wall", P.min[0], MAIN_ROOF_Y - 0.1, P.min[1], P.max[0], P.top, P.max[1])
  staticBatch.box("concrete_dark", P.min[0] - 0.06, P.top, P.min[1] - 0.06, P.max[0] + 0.06, P.top + 0.12, P.max[1] + 0.06)
  staticBatch.box("door_steel", P.max[0] + 0.001, MAIN_ROOF_Y, -6.5, P.max[0] + 0.05, MAIN_ROOF_Y + 2.05, -5.5)
  const S = DISH_SCALE
  const ped = new THREE.CylinderGeometry((3.9 * S) / Math.SQRT2, (8.4 * S) / Math.SQRT2, PED_TOP_WORLD - P.top, 4, 1)
  ped.rotateY(Math.PI / 4)
  ped.translate(D.x, (P.top + PED_TOP_WORLD) / 2 + 0.06, D.z)
  staticBatch.add("concrete_wall", ped, undefined, [6, 2.5])
  staticBatch.box("concrete_dark", D.x - 1.95 * S, PED_TOP_WORLD, D.z - 1.95 * S, D.x + 1.95 * S, PED_TOP_WORLD + 0.08 * S, D.z + 1.95 * S)
  // Service ladder up the plinth.
  for (const dx of [-0.25, 0.25]) staticBatch.box("metal_galvanized", P.max[0], MAIN_ROOF_Y, -9 + dx - 0.025, P.max[0] + 0.17, P.top + 1.0, -9 + dx + 0.025)
  for (let y = MAIN_ROOF_Y + 0.3; y < P.top + 0.9; y += 0.3) staticBatch.box("metal_galvanized", P.max[0] + 0.12, y, -9.25, P.max[0] + 0.17, y + 0.03, -8.75)

  // Azimuth group: turntable, elevation housing and yoke arms.
  const mount = new THREE.Group()
  mount.position.set(D.x, PED_TOP_WORLD, D.z)
  mount.scale.setScalar(S)
  root.add(mount)
  const az = new THREE.Group()
  const azPivot = new THREE.Group()
  azPivot.position.y = -PED_TOP
  mount.add(az)
  az.add(azPivot)
  const ab = new Batch()
  {
    const g = new THREE.CylinderGeometry(2.3, 2.3, TURN_TOP - PED_TOP - 0.08, 32)
    g.translate(0, (PED_TOP + 0.08 + TURN_TOP) / 2, 0)
    ab.add("metal_dark", g, undefined, [14, 1])
    ab.box("metal_painted", -1.9, TURN_TOP, -1.6, 1.9, HOUSING_TOP, 1.6)
    ab.box("metal_dark", -1.95, HOUSING_TOP - 0.7, -1.65, 1.95, HOUSING_TOP - 0.6, 1.65)
    // Yoke arms each side of the hub, bearings on the elevation axle.
    for (const s of [-1, 1]) {
      ab.box("metal_painted", s * 1.45 - 0.3, HOUSING_TOP, -1.0, s * 1.45 + 0.3, AXIS_Y + 0.55, 1.0)
      const bearing = new THREE.CylinderGeometry(0.55, 0.55, 0.3, 16)
      bearing.rotateZ(Math.PI / 2)
      bearing.translate(s * 1.9, AXIS_Y, 0)
      ab.add("metal_dark", bearing)
    }
    // Cable wrap and a little access platform with rails.
    const pt = HOUSING_TOP - 2
    ab.box("metal_galvanized", -1.9, pt - 0.04, 1.6, 1.9, pt, 2.6)
    for (const x of [-1.9, 1.9]) ab.box("metal_galvanized", x - 0.025, pt, 2.55, x + 0.025, pt + 1.05, 2.6)
    ab.box("metal_galvanized", -1.9, pt + 1.0, 2.55, 1.9, pt + 1.05, 2.6)
    ab.box("metal_galvanized", -1.9, pt + 0.5, 2.55, 1.9, pt + 0.53, 2.6)
  }
  ab.flush(azPivot, { name: "dish-yoke" })

  // Elevation group: everything that tilts with the reflector. Local +Y is the boresight, origin on the axle.
  const el = new THREE.Group()
  el.position.set(0, AXIS_Y, 0)
  azPivot.add(el)
  const eb = new Batch()
  const segs = 64
  const rings = 16
  const front: THREE.Vector2[] = []
  const back: THREE.Vector2[] = []
  for (let i = 0; i <= rings; i++) {
    const r = 0.9 + (R - 0.9) * (i / rings)
    front.push(new THREE.Vector2(r, profileY(r)))
    back.push(new THREE.Vector2(r, profileY(r) - 0.07))
  }
  eb.add("metal_painted", orient(new THREE.LatheGeometry(front, segs), 1), undefined, [Math.PI * 2 * R, R])
  eb.add("metal_dark", orient(new THREE.LatheGeometry(back, segs), -1), undefined, [Math.PI * 2 * R, R])
  // Rolled rim edge.
  const rim = new THREE.TorusGeometry(R, 0.07, 6, segs)
  rim.rotateX(Math.PI / 2)
  rim.translate(0, profileY(R) - 0.03, 0)
  eb.add("metal_painted", rim)
  // Hub: drum behind the vertex, axle tube through it.
  const hub = new THREE.CylinderGeometry(1.25, 1.35, 2.1, 20)
  hub.translate(0, VERTEX - 1.05, 0)
  eb.add("metal_dark", hub)
  const hubCap = new THREE.CylinderGeometry(0.95, 0.95, 0.1, 20)
  hubCap.translate(0, VERTEX + 0.05, 0)
  eb.add("metal_painted", hubCap)
  const axle = new THREE.CylinderGeometry(0.32, 0.32, 3.9, 12)
  axle.rotateZ(Math.PI / 2)
  eb.add("metal_dark", axle)
  // Counterweight arm hanging behind the hub.
  eb.box("metal_dark", -0.6, -2.6, -0.5, 0.6, -0.4, 0.5)

  // Radial back trusses: an outer chord following the reflector, an inner chord from the hub to the rim, webbed.
  const ribs = 24
  const v = (r: number, y: number, a: number) => new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r)
  const steps = 7
  const ringPts: THREE.Vector3[][] = []
  for (let k = 0; k < ribs; k++) {
    const a = (k / ribs) * Math.PI * 2
    const outer: THREE.Vector3[] = []
    const inner: THREE.Vector3[] = []
    for (let s = 0; s <= steps; s++) {
      const r = 1.3 + (R - 0.05 - 1.3) * (s / steps)
      outer.push(v(r, profileY(r) - 0.12, a))
      const depth = 1.9 * (1 - s / steps) + 0.25
      inner.push(v(r * 0.97, profileY(r) - 0.12 - depth, a))
    }
    for (let s = 0; s < steps; s++) {
      eb.strut("metal_painted", outer[s]!, outer[s + 1]!, 0.12)
      eb.strut("metal_painted", inner[s]!, inner[s + 1]!, 0.12)
      eb.strut("metal_painted", s % 2 ? outer[s]! : inner[s]!, s % 2 ? inner[s + 1]! : outer[s + 1]!, 0.07)
      eb.strut("metal_painted", outer[s + 1]!, inner[s + 1]!, 0.07)
    }
    eb.strut("metal_painted", v(1.25, VERTEX - 1.9, a), inner[0]!, 0.12)
    ringPts.push(inner)
  }
  // Hoop rings tying the ribs together, with zig-zag bracing in the outer bay (the lattice seen past the rim).
  for (let k = 0; k < ribs; k++) {
    const a = ringPts[k]!
    const c = ringPts[(k + 1) % ribs]!
    for (const s of [2, 4, steps]) eb.strut("metal_painted", a[s]!, c[s]!, 0.08)
    eb.strut("metal_painted", a[steps]!, c[steps - 2]!, 0.06)
    eb.strut("metal_painted", a[steps - 2]!, c[steps]!, 0.06)
  }

  // Quadrupod feed legs to the feed cabin hanging below the focus.
  const apex = new THREE.Vector3(0, VERTEX + F - 0.5, 0)
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4
    const foot = v(R * 0.66, profileY(R * 0.66) + 0.05, a)
    eb.strut("metal_painted", foot, apex.clone().add(v(0.4, -0.2, a)), 0.16, true)
    // Bracing tie partway up each leg.
    const mid = foot.clone().lerp(apex, 0.45)
    const next = v(R * 0.66, profileY(R * 0.66) + 0.05, a + Math.PI / 2).lerp(apex, 0.45)
    eb.strut("metal_galvanized", mid, next, 0.05, true)
  }
  eb.box("metal_painted", -0.55, apex.y - 0.6, -0.55, 0.55, apex.y + 0.55, 0.55)
  const horn = new THREE.CylinderGeometry(0.22, 0.55, 0.9, 16, 1, true)
  horn.translate(0, apex.y - 1.05, 0)
  eb.add("metal_dark", horn)
  eb.flush(el, { name: "dish" })

  // Obstruction light on the top of the rim (dish-local -Z rim point is highest when tilted).
  const beaconMat = new THREE.MeshStandardNodeMaterial({ color: 0x200404, roughness: 0.4 })
  const beaconLevel = uniform(1)
  beaconMat.emissiveNode = uniform(new THREE.Color(3.0, 0.08, 0.04)).mul(beaconLevel)
  beaconMat.name = "facility_beacon"
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 8), beaconMat)
  const beaconLocal = new THREE.Vector3(0, profileY(R) + 0.45, -R - 0.05)
  beacon.position.copy(beaconLocal)
  el.add(beacon)
  const lamp: Lamp = {
    kind: "warning",
    position: [0, 0, 0],
    color: [1, 0.05, 0.03],
    intensity: 6,
    range: 10,
    size: 0.3,
  }
  ctx.lamps.push(lamp)

  const world = new THREE.Vector3()
  const apply = (c: DishControls) => {
    az.rotation.y = c.yaw + Math.PI
    el.rotation.x = c.tilt
    mount.updateMatrixWorld(true)
    world.copy(beaconLocal)
    el.localToWorld(world)
    ;(lamp as unknown as { position: [number, number, number] }).position = [world.x, world.y + 0.05, world.z]
  }
  apply({ tilt: D.tilt, yaw: D.yaw })

  let last = { tilt: D.tilt, yaw: D.yaw }
  return {
    lamp,
    update(time: number, c: DishControls, period: number) {
      if (c.tilt !== last.tilt || c.yaw !== last.yaw) {
        apply(c)
        last = { ...c }
      }
      // Slow obstruction blink: about a second on, then a dim tail.
      const phase = (time % period) / period
      const on = phase < 0.45 ? 1 : Math.max(0.04, 1 - (phase - 0.45) * 8)
      beaconLevel.value = on
      lamp.intensity = 6 * on
    },
  }
}
