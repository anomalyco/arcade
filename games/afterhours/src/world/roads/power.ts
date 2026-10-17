import * as THREE from "three/webgpu"
import { POWER, countyRoadZ } from "../layout"
import type { WorldContext } from "../context"
import { heightAt } from "../height"
import { material } from "../../render/materials"
import { Line, MeshBuilder, Parts, beam, boxM, cylM, rng, tubeInto } from "./util"
import type { Junction } from "./surface"

// Weathered wooden utility poles with crossarms, glass insulators, braces and the odd transformer can, carrying
// three conductors and a lower phone cable that sag between poles. One line runs along the north side of the
// county road; a branch leaves a two-armed corner pole at the junction and runs up the east side of the access road.

const H = POWER.poleHeight
const ARM_Y = H - 0.55
const PHONE_Y = H - 3.1
const INSULATOR_X = [-1.05, -0.38, 1.05]

export type Pole = {
  x: number
  z: number
  /** Pole frame (lean included), origin at ground level. */
  frame: THREE.Matrix4
  /** Per crossarm: the three conductor attachment points in world space. */
  arms: THREE.Vector3[][]
  phone: THREE.Vector3
}

type PoleSpec = { x: number; z: number; arms: [number, number][]; transformer?: boolean; seed: number }

const tmp = new THREE.Vector3()

function armFrame(nx: number, nz: number, dy: number) {
  const X = new THREE.Vector3(nx, 0, nz).normalize()
  const Yv = new THREE.Vector3(0, 1, 0)
  const Z = new THREE.Vector3().crossVectors(X, Yv)
  return new THREE.Matrix4().makeBasis(X, Yv, Z).setPosition(0, dy, 0)
}

function buildPole(parts: Parts, spec: PoleSpec): Pole {
  const r = rng(spec.seed)
  const ground = heightAt(spec.x, spec.z)
  const lean = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(r() - 0.5, 0, r() - 0.5).normalize(),
    (0.4 + r() * 1.1) * (Math.PI / 180),
  )
  const frame = new THREE.Matrix4().compose(new THREE.Vector3(spec.x, ground, spec.z), lean, new THREE.Vector3(1, 1, 1))
  const at = (m: THREE.Matrix4) => frame.clone().multiply(m)

  // Shaft, sunk into the ground, with a slight random height so the line is not ruler straight.
  const top = H + (r() - 0.5) * 0.4
  const shaft = cylM(0.105, 0.15, top + 1.2, 14)
  parts.add("wood_pole", shaft, at(new THREE.Matrix4().makeTranslation(0, (top - 1.2) / 2, 0)))
  // Cap and a ground-line stain band read as weathering in the flashlight.
  parts.add("wood_pole", cylM(0.11, 0.11, 0.06, 14), at(new THREE.Matrix4().makeTranslation(0, top + 0.02, 0)))
  parts.add("bark", cylM(0.153, 0.156, 0.5, 14, true), at(new THREE.Matrix4().makeTranslation(0, 0.2, 0)))

  const arms: THREE.Vector3[][] = []
  spec.arms.forEach(([nx, nz], ai) => {
    const dy = ARM_Y - ai * 1.25 + (top - H)
    const af = at(armFrame(nx, nz, dy))
    const off = 0.17
    parts.add("wood_pole", boxM(2.45, 0.095, 0.12), af.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, off)))
    // Flat steel braces from the arm down to the pole.
    for (const sx of [-1, 1]) {
      const g = beam(new THREE.Vector3(sx * 0.62, -0.03, off - 0.04), new THREE.Vector3(0, -0.66, 0.12), 0.04, 0.008)
      parts.add("metal_galvanized", g, af)
    }
    const pts: THREE.Vector3[] = []
    for (const x of INSULATOR_X) {
      parts.add("metal_galvanized", cylM(0.012, 0.012, 0.12, 5), af.clone().multiply(new THREE.Matrix4().makeTranslation(x, 0.1, off)))
      parts.add("glass_dark", cylM(0.032, 0.06, 0.1, 10), af.clone().multiply(new THREE.Matrix4().makeTranslation(x, 0.16, off)))
      parts.add("glass_dark", cylM(0.045, 0.032, 0.04, 10), af.clone().multiply(new THREE.Matrix4().makeTranslation(x, 0.225, off)))
      pts.push(tmp.set(x, 0.235, off).applyMatrix4(af).clone())
    }
    arms.push(pts)
  })

  // Phone cable on a short bracket on the road side of the pole.
  const pf = at(armFrame(spec.arms[0]![0], spec.arms[0]![1], PHONE_Y))
  parts.add("metal_dark", boxM(0.05, 0.05, 0.25), pf.clone().multiply(new THREE.Matrix4().makeTranslation(-0.12, 0, 0.1)))
  const phone = tmp.set(-0.14, -0.02, 0.22).applyMatrix4(pf).clone()

  if (spec.transformer) {
    const tf = at(armFrame(spec.arms[0]![0], spec.arms[0]![1], ARM_Y - 2.2 + (top - H)))
    const can = (m: THREE.Matrix4) => tf.clone().multiply(m)
    parts.add("metal_painted", cylM(0.25, 0.25, 0.85, 12), can(new THREE.Matrix4().makeTranslation(0, 0, -0.42)))
    parts.add("metal_painted", cylM(0.27, 0.27, 0.05, 12), can(new THREE.Matrix4().makeTranslation(0, 0.45, -0.42)))
    parts.add("metal_dark", cylM(0.22, 0.24, 0.06, 12), can(new THREE.Matrix4().makeTranslation(0, -0.45, -0.42)))
    parts.add("metal_dark", boxM(0.12, 0.6, 0.2), can(new THREE.Matrix4().makeTranslation(0, 0.05, -0.17)))
    parts.add("glass_dark", cylM(0.03, 0.045, 0.16, 8), can(new THREE.Matrix4().makeTranslation(0.1, 0.55, -0.42)))
    parts.add("glass_dark", cylM(0.03, 0.045, 0.12, 8), can(new THREE.Matrix4().makeTranslation(-0.12, 0.52, -0.5)))
  }

  return { x: spec.x, z: spec.z, frame, arms, phone }
}

function sag(a: THREE.Vector3, b: THREE.Vector3, amount: number, n: number) {
  const pts: THREE.Vector3[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    pts.push(new THREE.Vector3().lerpVectors(a, b, t).setY(a.y + (b.y - a.y) * t - amount * 4 * t * (1 - t)))
  }
  return pts
}

/** Finds where the access line (east offset) crosses the county line (north offset). */
function cornerPoint(access: Line, j: Junction): [number, number] {
  let best: [number, number] = access.offset(j.sStart, POWER.offset)
  let bd = Infinity
  for (let s = j.sStart; s < j.sStart + 30; s += 0.1) {
    const [x, z] = access.offset(s, POWER.offset)
    const d = Math.abs(countyRoadZ(x) - POWER.offset - z)
    if (d < bd) {
      bd = d
      best = [x, z]
    }
  }
  return best
}

export function buildPower(ctx: WorldContext, root: THREE.Object3D, parts: Parts, access: Line, j: Junction) {
  const corner = cornerPoint(access, j)
  const countyNormal = (x: number): [number, number] => {
    const dz = (9 / 140) * Math.cos(x / 140)
    const l = Math.hypot(1, dz)
    return [-dz / l, 1 / l]
  }
  const accessNormalAt = (s: number) => {
    const p = access.at(s)
    return [-p.tz, p.tx] as [number, number]
  }

  // Access branch: the last pole stands short of the guard booth; spans divide the run evenly.
  const sCorner = (() => {
    let best = j.sStart
    let bd = Infinity
    for (let s = j.sStart; s < j.sStart + 30; s += 0.1) {
      const [x, z] = access.offset(s, POWER.offset)
      const d = Math.hypot(x - corner[0], z - corner[1])
      if (d < bd) {
        bd = d
        best = s
      }
    }
    return best
  })()
  let sLast = sCorner
  for (const p of access.pts) if (p.z >= 136) sLast = p.s
  const nAccess = Math.max(1, Math.round((sLast - sCorner) / POWER.spacing))
  const accessSpecs: PoleSpec[] = []
  for (let i = 1; i <= nAccess; i++) {
    const s = sCorner + ((sLast - sCorner) * i) / nAccess
    const [x, z] = access.offset(s, POWER.offset)
    accessSpecs.push({ x, z, arms: [accessNormalAt(s)], transformer: i === nAccess || i === 3, seed: 500 + i })
  }

  // County line: poles every spacing metres along x, one of them the corner pole.
  const countySpecs: PoleSpec[] = []
  let cornerIndex = 0
  for (let k = -17; k <= 17; k++) {
    const x = corner[0] + k * POWER.spacing + (k === 0 ? 0 : Math.sin(k * 3.7) * 2)
    if (Math.abs(x) > 690) continue
    const [nx, nz] = countyNormal(x)
    const z = k === 0 ? corner[1] : countyRoadZ(x) - POWER.offset
    if (k === 0) cornerIndex = countySpecs.length
    countySpecs.push({
      x,
      z,
      arms: k === 0 ? [[nx, nz], accessNormalAt(sCorner)] : [[nx, nz]],
      transformer: k === 0 || k % 5 === 2,
      seed: 100 + k,
    })
  }

  const countyPoles = countySpecs.map((s) => buildPole(parts, s))
  const accessPoles = [countyPoles[cornerIndex]!, ...accessSpecs.map((s) => buildPole(parts, s))]

  // Conductors and phone cable.
  const wires = new MeshBuilder()
  const string = (poles: Pole[], arm: (i: number) => number) => {
    for (let i = 0; i < poles.length - 1; i++) {
      const a = poles[i]!
      const b = poles[i + 1]!
      const span = Math.hypot(b.x - a.x, b.z - a.z)
      const n = Math.max(8, Math.round(span / 3))
      for (let w = 0; w < 3; w++) {
        const pa = a.arms[arm(i)]![w]!
        const pb = b.arms[arm(i + 1)]![w]!
        tubeInto(wires, sag(pa, pb, span * (0.017 + w * 0.001), n), 0.011)
      }
      tubeInto(wires, sag(a.phone, b.phone, span * 0.026, n), 0.017)
    }
  }
  string(countyPoles, () => 0)
  string(accessPoles, (i) => (i === 0 ? 1 : 0))

  // Transformer drop leads up to the nearest conductor.
  for (const spec of [...countySpecs, ...accessSpecs]) {
    if (!spec.transformer) continue
    const pole = [...countyPoles, ...accessPoles].find((p) => p.x === spec.x && p.z === spec.z)!
    const af = pole.frame.clone().multiply(armFrame(spec.arms[0]![0], spec.arms[0]![1], ARM_Y - 2.2))
    const from = new THREE.Vector3(0.1, 0.63, -0.42).applyMatrix4(af)
    const to = pole.arms[0]![2]!
    tubeInto(wires, sag(from, to, 0.15, 6), 0.008)
  }

  // Dead-end guy wire and anchor on the last access pole.
  const last = accessPoles[accessPoles.length - 1]!
  const prevPole = accessPoles[accessPoles.length - 2]!
  const dx = last.x - prevPole.x
  const dz = last.z - prevPole.z
  const dl = Math.hypot(dx, dz)
  const anchor = new THREE.Vector3(last.x + (dx / dl) * 5.5, 0, last.z + (dz / dl) * 5.5)
  anchor.y = heightAt(anchor.x, anchor.z) + 0.15
  const guyTop = new THREE.Vector3(0, ARM_Y - 0.3, 0).applyMatrix4(last.frame)
  tubeInto(wires, [guyTop, anchor], 0.008)
  parts.add("metal_galvanized", cylM(0.03, 0.03, 0.4, 6), new THREE.Matrix4().makeTranslation(anchor.x, anchor.y - 0.1, anchor.z))
  const guyDir = guyTop.clone().sub(anchor).normalize()
  parts.add("plastic_orange", beam(anchor.clone().addScaledVector(guyDir, 0.2), anchor.clone().addScaledVector(guyDir, 2.6), 0.05, 0.05))

  const wireGeo = wires.geometry()
  wireGeo.computeBoundingSphere()
  const wireMesh = new THREE.Mesh(wireGeo, material("metal_dark"))
  wireMesh.name = "power:wires"
  wireMesh.matrixAutoUpdate = false
  root.add(wireMesh)

  for (const p of [...countyPoles, ...accessPoles.slice(1)]) {
    const g = heightAt(p.x, p.z)
    ctx.colliders.push({ min: [p.x - 0.2, g - 1, p.z - 0.2], max: [p.x + 0.2, g + H, p.z + 0.2] })
  }

  return { countyPoles, accessPoles, corner: countyPoles[cornerIndex]! }
}
