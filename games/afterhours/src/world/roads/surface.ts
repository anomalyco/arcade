import * as THREE from "three/webgpu"
import { ACCESS_ROAD, COUNTY_ROAD, FENCE, countyRoadZ } from "../layout"
import { heightAt } from "../height"
import { material } from "../../render/materials"
import { Line, MeshBuilder, decalMaterial, hash, noise1, noise2 } from "./util"

// Road surfaces: crowned asphalt ribbons with broken edges, gravel shoulders, the T-junction flares and the faded
// paint. Everything follows the layout centre lines at terrain height (the terrain is flat at y = 0 along roads).

export const HA = ACCESS_ROAD.width / 2
export const HC = COUNTY_ROAD.width / 2
/** Corner radius of the junction flares. */
const R = 9

export type Junction = {
  /** Access-road arc length where its centre line leaves the county road's north edge. */
  sStart: number
  /** Access-road arc length at the parking lot's south edge (where our asphalt stops). */
  sEnd: number
  /** Access-road arc length at the fence line. */
  sFence: number
  /** Access-road arc length where the flares end and plain road begins. */
  sMouth: number
  /** County-road arc lengths bracketing the junction mouth (flare tips on the north edge). */
  countyGap: [number, number]
}

export const asphaltY = (u: number, half: number, crown: number) => {
  const k = Math.min(Math.abs(u) / half, 1)
  return 0.03 + 0.075 * crown * (1 - k * k)
}

/** How far the asphalt edge is eaten back (negative) or spills out at arc length s. */
function edgeJitter(s: number, seed: number) {
  const bite = Math.max(0, noise1(s / 1.6, seed + 3) - 0.72) * 1.5
  return 0.06 - 0.16 * noise1(s / 2.3, seed) - 0.08 * noise1(s / 0.6, seed + 1) - bite
}

/** Moves (x, z) along (tx, tz) until it lies on the county road's north edge. */
function clipToCountyEdge(x: number, z: number, tx: number, tz: number): [number, number] {
  let k = 0
  for (let i = 0; i < 6; i++) {
    const f = z + tz * k - (countyRoadZ(x + tx * k) - HC)
    k -= f / (tz || -1)
  }
  return [x + tx * k, z + tz * k]
}

function nearestS(line: Line, x: number, z: number) {
  let best = 0
  let bd = Infinity
  for (const p of line.pts) {
    const d = (p.x - x) ** 2 + (p.z - z) ** 2
    if (d < bd) {
      bd = d
      best = p.s
    }
  }
  return best
}

function sAtZ(line: Line, z: number) {
  const p = line.pts
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1]!
    const b = p[i]!
    if ((a.z - z) * (b.z - z) <= 0) return a.s + ((z - a.z) / (b.z - a.z || 1)) * (b.s - a.s)
  }
  return line.length
}

export function junctionFor(access: Line, county: Line): Junction {
  // The access line starts on the county centre line; find where it crosses the north edge.
  let sStart = 0
  for (let s = 0; s < 30; s += 0.05) {
    const p = access.at(s)
    if (p.z <= countyRoadZ(p.x) - HC) {
      sStart = s
      break
    }
  }
  const gap: number[] = []
  for (const sx of [-1, 1]) {
    const p = access.at(sStart)
    const [cx, cz] = clipToCountyEdge(...access.offset(sStart, sx * HA), p.tx, p.tz)
    gap.push(nearestS(county, cx, cz) + sx * R)
  }
  return {
    sStart,
    sMouth: sStart + R,
    sEnd: sAtZ(access, 112),
    sFence: sAtZ(access, FENCE.max[1]),
    countyGap: [Math.min(gap[0]!, gap[1]!), Math.max(gap[0]!, gap[1]!)],
  }
}

type RibbonOpts = {
  half: number
  seed: number
  crown: (s: number) => number
  /** Snap the first row onto the county road's north edge. */
  clipStart?: boolean
}

function asphaltRibbon(mb: MeshBuilder, line: Line, s0: number, s1: number, o: RibbonOpts) {
  const inner = [-4, -3, -2, -1, 0, 1, 2, 3, 4].map((k) => (k / 6) * o.half)
  const stations = line.stations(s0, s1, 0.3)
  let prev: number[] | null = null
  for (let r = 0; r < stations.length; r++) {
    const s = stations[r]!
    const p = line.at(s)
    const crown = o.crown(s)
    const eL = o.half + edgeJitter(s, o.seed)
    const eR = o.half + edgeJitter(s, o.seed + 17)
    const cols: [number, number][] = [
      [-eL, 0.02],
      [-(eL - 0.16), asphaltY(eL - 0.16, o.half, crown) - 0.004],
      ...inner.map((u) => [u, asphaltY(u, o.half, crown)] as [number, number]),
      [eR - 0.16, asphaltY(eR - 0.16, o.half, crown) - 0.004],
      [eR, 0.02],
    ]
    const row: number[] = []
    for (const [u, y] of cols) {
      let x = p.x - p.tz * u
      let z = p.z + p.tx * u
      if (o.clipStart && r === 0) [x, z] = clipToCountyEdge(x, z, p.tx, p.tz)
      // Patchy wear: big blotches, small mottling, darker seepage near the broken edges.
      let c = 0.8 + 0.32 * noise2(x / 9, z / 9, o.seed) + 0.12 * noise2(x / 1.8, z / 1.8, o.seed + 5)
      if (Math.abs(u) > o.half - 0.5) c *= 0.88
      row.push(mb.vert(x, heightAt(x, z) + y, z, u, s, c))
    }
    if (prev) for (let i = 0; i < row.length - 1; i++) mb.quad(prev[i]!, prev[i + 1]!, row[i]!, row[i + 1]!)
    prev = row
  }
}

function shoulderRibbon(mb: MeshBuilder, line: Line, s0: number, s1: number, half: number, width: number, side: -1 | 1, seed: number) {
  const stations = line.stations(s0, s1, 0.5)
  let prev: number[] | null = null
  for (const s of stations) {
    const p = line.at(s)
    const w = width + (noise1(s / 3.1, seed) - 0.5) * 0.7 + (noise1(s / 0.8, seed + 2) - 0.5) * 0.2
    const cols: [number, number][] = [
      [half - 0.7, 0.012],
      [half, 0.002],
      [half + w * 0.6, -0.02],
      [half + w, -0.07],
    ]
    const row: number[] = []
    for (const [uu, y] of cols) {
      const u = uu * side
      const x = p.x - p.tz * u
      const z = p.z + p.tx * u
      row.push(mb.vert(x, heightAt(x, z) + y, z, u, s))
    }
    if (prev) {
      for (let i = 0; i < row.length - 1; i++) {
        if (side > 0) mb.quad(prev[i]!, prev[i + 1]!, row[i]!, row[i + 1]!)
        else mb.quad(prev[i + 1]!, prev[i]!, row[i + 1]!, row[i]!)
      }
    }
    prev = row
  }
}

type StripOpts = {
  half: number
  crown: (s: number) => number
  seed: number
  /** Return false to leave paint out (dashes, passing zones). */
  visible?: (s: number) => boolean
  /** No worn-through gaps (stop line). */
  solid?: boolean
  /** Distance from the centre line to the broken asphalt edge on this side; paint is gone where the edge is. */
  edge?: (s: number) => number
}

/** A worn painted line `w` wide centred `u` metres off the centre line. */
function strip(mb: MeshBuilder, line: Line, u: number, w: number, s0: number, s1: number, o: StripOpts) {
  const step = 0.9
  for (let s = s0; s < s1 - 0.05; s += step) {
    const sb = Math.min(s + step, s1)
    const sm = (s + sb) / 2
    if (o.visible && !o.visible(sm)) continue
    const wear = o.solid ? 0.5 : noise1(sm / 3.3, o.seed)
    if (wear > 0.83) continue
    if (o.edge && Math.abs(u) + w / 2 + 0.04 > Math.min(o.edge(s), o.edge(sb), o.edge(sm))) continue
    const fade = (0.35 + 0.65 * noise1(sm / 14, o.seed + 1)) * (0.8 + 0.2 * hash(Math.floor(sm), o.seed + 2)) * (wear > 0.7 ? 0.6 : 1)
    const ww = w * (0.9 + 0.15 * noise1(sm / 5, o.seed + 3))
    const row = (ss: number) => {
      const p = line.at(ss)
      const uc = u + (noise1(ss / 17, o.seed + 4) - 0.5) * 0.04
      const out: number[] = []
      for (const du of [-ww / 2, ww / 2]) {
        const uu = uc + du
        const x = p.x - p.tz * uu
        const z = p.z + p.tx * uu
        out.push(mb.vert(x, heightAt(x, z) + asphaltY(uu, o.half, o.crown(ss)) + 0.006, z, uu, ss, fade))
      }
      return out
    }
    const a = row(s)
    const b = row(sb)
    mb.quad(a[0]!, a[1]!, b[0]!, b[1]!)
  }
}

/** Tar-sealed cracks: wiggly transverse cracks and longitudinal runs, drawn as thin dark glossy strips. */
function cracks(mb: MeshBuilder, line: Line, s0: number, s1: number, half: number, crown: (s: number) => number, seed: number) {
  const ribbon = (pts: [number, number][], w: number) => {
    let prev: number[] | null = null
    for (let i = 0; i < pts.length; i++) {
      const [s, u] = pts[i]!
      const [s2, u2] = pts[Math.min(i + 1, pts.length - 1)]!
      const [s1_, u1] = pts[Math.max(i - 1, 0)]!
      // Offset perpendicular to the crack direction in (s, u) space.
      let ds = s2 - s1_
      let du = u2 - u1
      const l = Math.hypot(ds, du) || 1
      ds /= l
      du /= l
      const row: number[] = []
      for (const k of [-1, 1]) {
        const ss = s - du * k * w * 0.5
        const uu = u + ds * k * w * 0.5
        const p = line.at(ss)
        const x = p.x - p.tz * uu
        const z = p.z + p.tx * uu
        row.push(mb.vert(x, heightAt(x, z) + asphaltY(uu, half, crown(ss)) + 0.004, z, uu, ss, 0.5 + 0.2 * hash(i, seed)))
      }
      if (prev) {
        triUp(mb, prev[0]!, prev[1]!, row[0]!)
        triUp(mb, prev[1]!, row[1]!, row[0]!)
      }
      prev = row
    }
  }
  let k = 0
  for (let s = s0 + 4; s < s1 - 4; k++) {
    const r = hash(k, seed)
    s += 6 + r * 22
    // Transverse crack across some or all of the road.
    const ua = -half + 0.2 + hash(k, seed + 1) * half * 0.8
    const ub = half - 0.2 - hash(k, seed + 2) * half * 0.8
    const pts: [number, number][] = []
    for (let u = ua; u <= ub; u += 0.25) pts.push([s + (noise1(u * 1.7 + k * 13, seed + 3) - 0.5) * 0.5 + u * 0.05, u])
    if (pts.length > 1) ribbon(pts, 0.035 + hash(k, seed + 4) * 0.03)
    // Occasional longitudinal run along a lane joint.
    if (hash(k, seed + 5) > 0.6) {
      const u0 = (hash(k, seed + 6) > 0.5 ? 1 : -1) * (0.3 + hash(k, seed + 7) * 1.4)
      const len = 4 + hash(k, seed + 8) * 14
      const lp: [number, number][] = []
      for (let t = 0; t <= len && s + t < s1; t += 0.5) lp.push([s + t, u0 + (noise1(t * 0.6 + k * 7, seed + 9) - 0.5) * 0.35])
      if (lp.length > 1) ribbon(lp, 0.04)
    }
  }
}

function triUp(mb: MeshBuilder, a: number, b: number, c: number) {
  const p = mb.pos
  const ax = p[b * 3]! - p[a * 3]!
  const az = p[b * 3 + 2]! - p[a * 3 + 2]!
  const bx = p[c * 3]! - p[a * 3]!
  const bz = p[c * 3 + 2]! - p[a * 3 + 2]!
  // y component of (b - a) × (c - a)
  if (az * bx - ax * bz >= 0) mb.tri(a, b, c)
  else mb.tri(a, c, b)
}

/** Asphalt and gravel for one curb-return flare of the T-junction. */
function flare(asphalt: MeshBuilder, gravel: MeshBuilder, access: Line, county: Line, j: Junction, sx: -1 | 1) {
  const p = access.at(j.sStart)
  const C = clipToCountyEdge(...access.offset(j.sStart, sx * HA), p.tx, p.tz)
  const A = access.offset(j.sMouth, sx * HA)
  const B = county.offset(sx > 0 ? j.countyGap[1] : j.countyGap[0], -HC)
  const n = 18
  const curve: [number, number][] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const a = (1 - t) * (1 - t)
    const b = 2 * (1 - t) * t
    const c = t * t
    curve.push([a * A[0] + b * C[0] + c * B[0], a * A[1] + b * C[1] + c * B[1]])
  }
  // Fan from the corner; the curved edge is broken up like the road edges.
  const centre = asphalt.vert(C[0], heightAt(C[0], C[1]) + 0.032, C[1], C[0], C[1], 0.9)
  const ring: number[] = []
  const gIn: number[] = []
  const gOut: number[] = []
  for (let i = 0; i <= n; i++) {
    const [qx, qz] = curve[i]!
    const prev = curve[Math.max(i - 1, 0)]!
    const next = curve[Math.min(i + 1, n)]!
    let nx = -(next[1] - prev[1])
    let nz = next[0] - prev[0]
    const l = Math.hypot(nx, nz) || 1
    nx /= l
    nz /= l
    if (nx * (qx - C[0]) + nz * (qz - C[1]) < 0) {
      nx = -nx
      nz = -nz
    }
    const taper = Math.sin((i / n) * Math.PI)
    const e = edgeJitter(i * 0.9 + 40, 91 + sx) * taper
    const ex = qx + nx * e
    const ez = qz + nz * e
    ring.push(asphalt.vert(ex, heightAt(ex, ez) + 0.022, ez, ex, ez, 0.85))
    const w = COUNTY_ROAD.shoulder * (0.8 + 0.5 * noise1(i / 3, 7 + sx))
    const ix = qx - nx * 0.6
    const iz = qz - nz * 0.6
    const ox = qx + nx * w
    const oz = qz + nz * w
    gIn.push(gravel.vert(ix, heightAt(ix, iz) + 0.01, iz, ix, iz))
    gOut.push(gravel.vert(ox, heightAt(ox, oz) - 0.07, oz, ox, oz))
  }
  for (let i = 0; i < n; i++) {
    triUp(asphalt, centre, ring[i]!, ring[i + 1]!)
    triUp(gravel, gIn[i]!, gOut[i]!, gIn[i + 1]!)
    triUp(gravel, gIn[i + 1]!, gOut[i]!, gOut[i + 1]!)
  }
}

function tarMaterial() {
  const m = decalMaterial("asphalt", true) as THREE.MeshStandardNodeMaterial
  m.roughness = Math.max(0.05, (m.roughness ?? 0.35) * 0.45)
  m.name = "asphalt_tar"
  return m
}

export function buildSurface(scene: THREE.Object3D, access: Line, county: Line, j: Junction) {
  const asphalt = new MeshBuilder()
  const gravel = new MeshBuilder()
  const yellow = new MeshBuilder()
  const white = new MeshBuilder()

  const flat = () => 1
  const accessCrown = (s: number) => {
    const t = Math.min(Math.max((s - j.sStart) / 12, 0), 1)
    return t * t * (3 - 2 * t)
  }

  // County road.
  asphaltRibbon(asphalt, county, 0, county.length, { half: HC, seed: 3, crown: flat })
  const [g0, g1] = j.countyGap
  shoulderRibbon(gravel, county, 0, g0 + 0.5, HC, COUNTY_ROAD.shoulder, -1, 11)
  shoulderRibbon(gravel, county, g1 - 0.5, county.length, HC, COUNTY_ROAD.shoulder, -1, 12)
  shoulderRibbon(gravel, county, 0, county.length, HC, COUNTY_ROAD.shoulder, 1, 13)

  // Access road: from the county edge to the parking lot; shoulders stop at the fence.
  asphaltRibbon(asphalt, access, j.sStart, j.sEnd, { half: HA, seed: 5, crown: accessCrown, clipStart: true })
  shoulderRibbon(gravel, access, j.sMouth, j.sFence + 0.4, HA, ACCESS_ROAD.shoulder, -1, 21)
  shoulderRibbon(gravel, access, j.sMouth, j.sFence + 0.4, HA, ACCESS_ROAD.shoulder, 1, 22)
  flare(asphalt, gravel, access, county, j, -1)
  flare(asphalt, gravel, access, county, j, 1)

  // County paint: double yellow with passing-zone dashes away from the junction, white edge lines broken at the mouth.
  const sJ = (g0 + g1) / 2
  const cOpts = { half: HC, crown: flat }
  strip(yellow, county, -0.11, 0.1, 0, county.length, { ...cOpts, seed: 31 })
  strip(yellow, county, 0.11, 0.1, 0, county.length, {
    ...cOpts,
    seed: 32,
    visible: (s) => Math.abs(s - sJ) < 160 || ((s % 12) + 12) % 12 < 3,
  })
  const cL = (s: number) => HC + edgeJitter(s, 3)
  const cR = (s: number) => HC + edgeJitter(s, 3 + 17)
  strip(white, county, -(HC - 0.28), 0.1, 0, g0 - 1, { ...cOpts, seed: 33, edge: cL })
  strip(white, county, -(HC - 0.28), 0.1, g1 + 1, county.length, { ...cOpts, seed: 34, edge: cL })
  strip(white, county, HC - 0.28, 0.1, 0, county.length, { ...cOpts, seed: 35, edge: cR })

  // Access paint: stop line for southbound traffic, double yellow and edge lines up to just short of the gate.
  const sStop = j.sStart + 2.4
  const sPaintEnd = j.sFence - 5
  const aOpts = { half: HA, crown: accessCrown }
  strip(yellow, access, -0.11, 0.1, sStop, sPaintEnd, { ...aOpts, seed: 41 })
  strip(yellow, access, 0.11, 0.1, sStop, sPaintEnd, { ...aOpts, seed: 42 })
  const aL = (s: number) => HA + edgeJitter(s, 5)
  const aR = (s: number) => HA + edgeJitter(s, 5 + 17)
  strip(white, access, -(HA - 0.28), 0.1, j.sMouth, sPaintEnd, { ...aOpts, seed: 43, edge: aL })
  strip(white, access, HA - 0.28, 0.1, j.sMouth, sPaintEnd, { ...aOpts, seed: 44, edge: aR })
  const stopCols = 7
  for (let k = 0; k < stopCols - 1; k++) {
    const u0 = -0.24 - ((HA - 0.5) * k) / (stopCols - 1)
    const u1 = -0.24 - ((HA - 0.5) * (k + 1)) / (stopCols - 1)
    strip(white, access, (u0 + u1) / 2, Math.abs(u1 - u0) + 0.01, sStop, sStop + 0.45, { ...aOpts, seed: 45 + k, solid: true })
  }

  const tar = new MeshBuilder()
  cracks(tar, county, 0, county.length, HC, flat, 61)
  cracks(tar, access, j.sMouth, j.sFence, HA, accessCrown, 62)

  const asphaltMat = material("asphalt").clone()
  asphaltMat.vertexColors = true
  asphaltMat.name = "asphalt_road"
  const meshes: [MeshBuilder, THREE.Material, boolean][] = [
    [asphalt, asphaltMat, true],
    [gravel, material("gravel"), false],
    [yellow, decalMaterial("road_line_yellow", true), true],
    [white, decalMaterial("road_line_white", true), true],
    [tar, tarMaterial(), true],
  ]
  for (const [mb, mat, colors] of meshes) {
    const geo = mb.geometry(colors)
    geo.computeBoundingSphere()
    const mesh = new THREE.Mesh(geo, mat)
    mesh.name = `roads:${mat.name}`
    mesh.receiveShadow = true
    mesh.matrixAutoUpdate = false
    scene.add(mesh)
  }
}
