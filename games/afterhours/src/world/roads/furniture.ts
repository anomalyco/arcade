import * as THREE from "three/webgpu"
import { ACCESS_ROAD, COUNTY_ROAD } from "../layout"
import type { WorldContext } from "../context"
import { heightAt } from "../height"
import { Line, MeshBuilder, Parts, boxM, cylM, hash, rng } from "./util"
import { HA, HC, type Junction } from "./surface"

// Road furniture: a blank stop sign and a blank guide sign at the junction, a weathered blank notice on the access
// road, white delineator posts, a culvert with headwalls and W-beam guardrail, and a drainage grate. No text anywhere.

function signMaterial(color: number, roughness: number) {
  const m = new THREE.MeshStandardNodeMaterial({ color, roughness, metalness: 0.15 })
  m.name = "sign_face"
  return m
}

/** Frame at ground (x, z) whose +Z (the sign face) points along (nx, nz). */
function facing(x: number, z: number, nx: number, nz: number, yawJitter = 0) {
  const a = Math.atan2(nx, nz) + yawJitter
  return new THREE.Matrix4().makeRotationY(a).setPosition(x, heightAt(x, z), z)
}

const T = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z)

function stopSign(parts: Parts, red: THREE.Material, white: THREE.Material, m: THREE.Matrix4) {
  parts.add("metal_galvanized", boxM(0.05, 2.7, 0.03), m.clone().multiply(T(0, 0.95, -0.03)))
  const oct = (r: number, d: number) => {
    const g = cylM(r, r, d, 8)
    g.rotateY(Math.PI / 8)
    g.rotateX(Math.PI / 2)
    return g
  }
  parts.add(white, oct(0.395, 0.012), m.clone().multiply(T(0, 2.05, -0.01)))
  parts.add(red, oct(0.365, 0.012), m.clone().multiply(T(0, 2.05, -0.004)))
  parts.add("metal_dark", oct(0.395, 0.01), m.clone().multiply(T(0, 2.05, -0.02)))
}

function guideSign(parts: Parts, green: THREE.Material, white: THREE.Material, m: THREE.Matrix4) {
  for (const x of [-0.5, 0.5]) parts.add("wood_pole", boxM(0.1, 2.6, 0.1), m.clone().multiply(T(x, 0.9, -0.07)))
  parts.add(white, boxM(1.6, 0.82, 0.02), m.clone().multiply(T(0, 2.0, -0.012)))
  parts.add(green, boxM(1.52, 0.74, 0.025), m.clone().multiply(T(0, 2.0, 0)))
  // A plain arrow pointing to the viewer's left (towards the facility); deliberately no lettering.
  const s = new THREE.Shape()
  s.moveTo(-0.55, 0)
  s.lineTo(-0.3, 0.2)
  s.lineTo(-0.3, 0.07)
  s.lineTo(0.5, 0.07)
  s.lineTo(0.5, -0.07)
  s.lineTo(-0.3, -0.07)
  s.lineTo(-0.3, -0.2)
  s.closePath()
  parts.add(white, new THREE.ShapeGeometry(s), m.clone().multiply(T(0, 2.0, 0.0135)))
}

function noticeSign(parts: Parts, face: THREE.Material, m: THREE.Matrix4) {
  parts.add("metal_galvanized", boxM(0.05, 2.5, 0.03), m.clone().multiply(T(0, 0.85, -0.03)))
  const tilt = new THREE.Matrix4().makeRotationZ(0.06)
  parts.add(face, boxM(0.6, 0.76, 0.015), m.clone().multiply(T(0, 1.75, 0)).multiply(tilt))
  parts.add("metal_dark", boxM(0.6, 0.12, 0.016), m.clone().multiply(T(0, 1.75, 0)).multiply(tilt).multiply(T(0, -0.33, 0.001)))
}

function delineator(parts: Parts, m: THREE.Matrix4) {
  parts.add("road_line_white", boxM(0.08, 1.45, 0.02), m.clone().multiply(T(0, 0.4, 0)))
  parts.add("plastic_orange", boxM(0.06, 0.15, 0.026), m.clone().multiply(T(0, 1.0, 0)))
}

/** W-beam rail: a corrugated profile extruded along a path of posts. */
function wBeam(mb: MeshBuilder, path: THREE.Vector3[], outward: THREE.Vector3[]) {
  const profile: [number, number][] = [
    [0, 0.17],
    [0.05, 0.12],
    [0.015, 0.055],
    [0.015, -0.055],
    [0.05, -0.12],
    [0, -0.17],
  ]
  let prev: number[] | null = null
  let along = 0
  for (let i = 0; i < path.length; i++) {
    const p = path[i]!
    const o = outward[i]!
    if (i > 0) along += p.distanceTo(path[i - 1]!)
    const row = profile.map(([d, y]) => mb.vert(p.x - o.x * d, p.y + y, p.z - o.z * d, y, along))
    if (prev) for (let k = 0; k < row.length - 1; k++) mb.quad(prev[k]!, prev[k + 1]!, row[k]!, row[k + 1]!)
    prev = row
  }
}

export function buildFurniture(
  ctx: WorldContext,
  parts: Parts,
  access: Line,
  county: Line,
  j: Junction,
  avoid: readonly { x: number; z: number }[],
) {
  const red = signMaterial(0x5e1712, 0.6)
  const white = signMaterial(0x8e8f88, 0.55)
  const green = signMaterial(0x1b3326, 0.6)
  const notice = signMaterial(0x7c7d74, 0.7)
  const post = (x: number, z: number, r = 0.12) => {
    const g = heightAt(x, z)
    ctx.colliders.push({ min: [x - r, g, z - r], max: [x + r, g + 2.4, z + r] })
  }

  // Stop sign for traffic leaving the facility, on the west side of the access road just short of the county road.
  {
    const s = j.sStart + 3.8
    const p = access.at(s)
    const [x, z] = access.offset(s, -(HA + 1.5))
    stopSign(parts, red, white, facing(x, z, p.tx, p.tz, 0.08))
    post(x, z)
  }
  // Guide sign for eastbound traffic, west of the junction on the north shoulder, arrow pointing north.
  {
    const s = j.countyGap[0] - 38
    const p = county.at(s)
    const [x, z] = county.offset(s, -(HC + COUNTY_ROAD.shoulder + 0.9))
    guideSign(parts, green, white, facing(x, z, -p.tx, -p.tz, -0.12))
    post(x, z, 0.6)
  }
  // A weathered blank notice for northbound traffic on the access road.
  {
    const s = j.sMouth + 16
    const p = access.at(s)
    const [x, z] = access.offset(s, HA + ACCESS_ROAD.shoulder + 0.5)
    noticeSign(parts, notice, facing(x, z, -p.tx, -p.tz, 0.2))
    post(x, z)
  }

  // Delineators along the access road (both sides) and flanking the junction on the county road.
  for (let s = j.sMouth + 6, i = 0; s < j.sFence - 30; s += 34, i++) {
    const p = access.at(s)
    for (const side of [-1, 1]) {
      const ss = s + side * 6 + (hash(i, side) - 0.5) * 4
      const [x, z] = access.offset(ss, side * (HA + ACCESS_ROAD.shoulder + 0.35))
      if (hash(i * 3 + side, 9) < 0.12) continue
      const lean = new THREE.Matrix4().makeRotationZ((hash(i, side + 4) - 0.5) * 0.12)
      delineator(parts, facing(x, z, -p.tx, -p.tz).multiply(lean))
    }
  }
  for (const off of [-30, -15, 15, 30]) {
    const s = (j.countyGap[0] + j.countyGap[1]) / 2 + off
    const p = county.at(s)
    const [x, z] = county.offset(s, HC + COUNTY_ROAD.shoulder + 0.35)
    delineator(parts, facing(x, z, p.tz, -p.tx))
  }

  // Culvert under the access road with headwalls and guardrail on both sides.
  {
    // Near z = 300, between two utility poles.
    let s300 = j.sStart
    for (const p of access.pts) if (p.z >= 300) s300 = p.s
    let sc = s300
    let best = -1
    for (let s = s300 - 20; s <= s300 + 20; s += 1) {
      const [x, z] = access.offset(s, HA)
      const d = Math.min(...avoid.map((a) => Math.hypot(a.x - x, a.z - z)))
      if (d > best) {
        best = d
        sc = s
      }
    }
    const rail = new MeshBuilder()
    const r = rng(77)
    for (const side of [-1, 1] as const) {
      const u = side * (HA + ACCESS_ROAD.shoulder + 0.25)
      const path: THREE.Vector3[] = []
      const outward: THREE.Vector3[] = []
      const len = 26
      const posts = Math.round(len / 1.905)
      for (let i = -2; i <= posts + 2; i++) {
        const s = sc - len / 2 + Math.min(Math.max(i, 0), posts) * (len / posts) + (i < 0 ? i * 1.9 : i > posts ? (i - posts) * 1.9 : 0)
        const p = access.at(s)
        const flareOut = i < 0 ? -i * 0.35 : i > posts ? (i - posts) * 0.35 : 0
        const [x, z] = access.offset(s, u + side * flareOut)
        const g = heightAt(x, z)
        // Turned-down ends.
        const y = g + 0.6 - (i < 0 ? -i * 0.26 : i > posts ? (i - posts) * 0.26 : 0)
        path.push(new THREE.Vector3(x, y, z))
        outward.push(new THREE.Vector3(-p.tz * side, 0, p.tx * side))
        if (i >= 0 && i <= posts) {
          const pm = facing(x, z, -p.tz * side, p.tx * side, (r() - 0.5) * 0.06)
          parts.add("wood_pole", boxM(0.15, 1.3, 0.2), pm.clone().multiply(T(0, 0.2, 0.2)))
          parts.add("wood_pole", boxM(0.15, 0.36, 0.14), pm.clone().multiply(T(0, 0.6, 0.06)))
          ctx.colliders.push({ min: [x - 0.25, g, z - 0.25], max: [x + 0.25, g + 0.8, z + 0.25] })
        }
      }
      wBeam(rail, path, outward)
      // Concrete headwall and corrugated pipe mouth beyond the rail.
      const p = access.at(sc)
      const [hx, hz] = access.offset(sc, side * (HA + ACCESS_ROAD.shoulder + 1.9))
      const hm = facing(hx, hz, -p.tz * side, p.tx * side)
      parts.add("concrete_dark", boxM(3.2, 0.75, 0.3), hm.clone().multiply(T(0, 0.02, 0)))
      for (const wx of [-1.6, 1.6]) parts.add("concrete_dark", boxM(0.3, 0.6, 1.1), hm.clone().multiply(T(wx, -0.05, 0.5)))
      const pipe = cylM(0.46, 0.46, 0.7, 14, true)
      pipe.rotateX(Math.PI / 2)
      parts.add("metal_galvanized", pipe, hm.clone().multiply(T(0, -0.22, 0.3)))
      const hole = new THREE.CircleGeometry(0.45, 14)
      parts.add("metal_dark", hole, hm.clone().multiply(T(0, -0.22, 0.12)))
    }
    parts.add("metal_galvanized", rail.geometry())
    const railBack = rail.geometry()
    const idx = railBack.index!
    for (let i = 0; i < idx.count; i += 3) {
      const a = idx.getX(i)
      idx.setX(i, idx.getX(i + 1))
      idx.setX(i + 1, a)
    }
    railBack.computeVertexNormals()
    parts.add("metal_galvanized", railBack)
  }

  // Drainage grate in the gravel at the north-west corner of the junction.
  {
    const s = j.countyGap[0] - 4
    const p = county.at(s)
    const [x, z] = county.offset(s, -(HC + 0.7))
    const m = facing(x, z, p.tz, -p.tx)
    parts.add("concrete_dark", boxM(1.1, 0.12, 0.8), m.clone().multiply(T(0, 0.0, 0)))
    parts.add("glass_dark", boxM(0.9, 0.02, 0.6), m.clone().multiply(T(0, 0.055, 0)))
    for (let k = 0; k < 9; k++) parts.add("metal_dark", boxM(0.035, 0.03, 0.62), m.clone().multiply(T(-0.4 + k * 0.1, 0.07, 0)))
  }

}
