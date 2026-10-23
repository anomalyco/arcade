import { bezelUv, COMPASS, floorUv, plateUv } from "./compass-face"
import { MAT, MeshBuilder, OBJ, v3, type V3 } from "./mesh"
import { SHEET } from "./sheet"

/**
 * The held props' geometry. Frames (metres):
 * - sheet: x right, y up the sheet, z out of the printed face; origin at the sheet's centre. The paper is a 136 × 160
 *   grid with a vertex row on every crease, accordion folds (mountain, valley), a curl away from the holding hand, the
 *   top sagging back, curled free corners, a dent where the left hand pinches it and a flat patch under the compass.
 * - compass: plate centre on its underside, x right, y towards the front (direction of travel), z up off the paper.
 * - bezel / needle / bubble: the bezel centre on the plate's top face, rotating about z.
 * - right: the torch lens at the origin, y along the beam, z up; the right glove holds the barrel.
 * The left glove and the lanyard are in the sheet frame (the thumb pins the sheet's edge, fingers behind it).
 */

/** Fold depth, curl, sag, waviness, corner curl and the pinch dent, all in metres. */
export type PaperShape = { fold: number; curl: number; sag: number; wave: number; corners: number; pinch: number }

/** Where the compass lies on the sheet: plate centre (mm from the top-left) and the plate's turn (rad, 0 = front up). */
export const COMPASS_ON_SHEET = { u: 98, v: 258, turn: -0.32 }

/** Where the left thumb pins the sheet (mm from the top-left). */
export const PINCH = { u: 14, v: 300 }

const W = SHEET.w / 1000, H = SHEET.h / 1000

const zig = (x: number, knots: readonly number[], values: readonly number[]) => {
  for (let i = 0; i + 1 < knots.length; i++) if (x <= knots[i + 1]!) {
    const t = (x - knots[i]!) / (knots[i + 1]! - knots[i]!)
    return values[i]! + (values[i + 1]! - values[i]!) * t
  }
  return values[values.length - 1]!
}
/** A crease rounded over about 1.5 mm (paper doesn't fold to a knife edge). */
const soft = (x: number, knots: readonly number[], values: readonly number[]) => (zig(x - 0.75, knots, values) + zig(x, knots, values) * 2 + zig(x + 0.75, knots, values)) / 4

const smooth01 = (t: number) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x) }

/** The unflattened paper surface z at sheet mm (u from the left, v from the top). */
function rawZ(u: number, v: number, s: PaperShape): number {
  const fu = soft(u, [0, SHEET.creasesU[0], SHEET.creasesU[1], SHEET.w], [0, 1, 0, 1]) * s.fold
  const fv = soft(v, [0, SHEET.creasesV[0], SHEET.creasesV[1], SHEET.h], [0.6, 0, 0.6, 0]) * s.fold
  const curl = -s.curl * (u / SHEET.w) ** 2
  const sag = -s.sag * ((SHEET.h - v) / SHEET.h) ** 3 * (0.4 + 0.6 * u / SHEET.w)
  const wave = s.wave * (Math.sin(u * 0.023 + v * 0.011 + 1.3) * 0.6 + Math.sin(v * 0.031 - u * 0.007) * 0.4)
  // Free corners lift towards you (top left, bottom right); the unsupported top right droops away in a soft, wide
  // bend (smooth in both directions, so no stiff diagonal ridge); the held corner stays down.
  let corners = 0
  for (const [cu, cv, reach] of [[0, 0, 70], [SHEET.w, SHEET.h, 80]] as const) {
    const d = Math.max(0, 1 - Math.hypot(u - cu, v - cv) / reach)
    corners += d * d * d
  }
  const sx = smooth01((u / SHEET.w - 0.4) / 0.6), sy = smooth01((1 - v / SHEET.h - 0.45) / 0.55)
  corners -= 2.4 * (sx * sy) ** 1.5
  const pu = (u - PINCH.u) / 34, pv = (v - PINCH.v) / 26
  const pinch = -s.pinch * Math.exp(-(pu * pu + pv * pv))
  return fu + fv + curl + sag + wave + corners * s.corners + pinch
}

/** The compass's resting plane on the sheet: centre point (sheet frame), normal and the plate's axes. */
export function compassRest(s: PaperShape) {
  const c = COMPASS_ON_SHEET
  const z0 = rawZ(c.u, c.v, s)
  const d = 25
  const dzdu = (rawZ(c.u + d, c.v, s) - rawZ(c.u - d, c.v, s)) / (2 * d)
  const dzdv = (rawZ(c.u, c.v + d, s) - rawZ(c.u, c.v - d, s)) / (2 * d)
  // z is in metres, u and v in mm; sheet x = u/1000 − W/2 and y = H/2 − v/1000.
  const n = v3.norm([-dzdu * 1000, dzdv * 1000, 1])
  const front0: V3 = [Math.sin(-c.turn), Math.cos(-c.turn), 0]
  const front = v3.norm(v3.sub(front0, v3.scale(n, v3.dot(front0, n))))
  const right = v3.cross(front, n)
  return { centre: [c.u / 1000 - W / 2, H / 2 - c.v / 1000, z0] as V3, n, front, right, dzdu, dzdv, z0 }
}

/** Paper surface point (sheet frame) at sheet mm, pressed flat under the compass plate. */
export function paperPoint(u: number, v: number, s: PaperShape, rest = compassRest(s)): V3 {
  let z = rawZ(u, v, s)
  const c = COMPASS_ON_SHEET
  const du = u - c.u, dv = -(v - c.v)
  const cs = Math.cos(c.turn), sn = Math.sin(c.turn)
  const px = du * cs + dv * sn, py = -du * sn + dv * cs
  const P = COMPASS.plate
  const ex = Math.max(0, Math.abs(px) - P.w / 2), ey = Math.max(0, Math.abs(py) - P.l / 2)
  const out = Math.hypot(ex, ey)
  // The plate presses the paper flat; it relaxes back to the folds over a few centimetres (a short ramp tears a ridge).
  const k = 1 - Math.min(1, out / 38)
  if (k > 0) {
    const plane = rest.z0 + rest.dzdu * (u - c.u) + rest.dzdv * (v - c.v)
    const m = k * k * (3 - 2 * k)
    z = z + (plane - z) * m
  }
  return [u / 1000 - W / 2, H / 2 - v / 1000, z]
}

/** Catmull-Rom through `pts`, `per` samples per span. */
function spline(pts: V3[], per: number): V3[] {
  const out: V3[] = []
  for (let i = 0; i + 1 < pts.length; i++) {
    const p0 = pts[Math.max(0, i - 1)]!, p1 = pts[i]!, p2 = pts[i + 1]!, p3 = pts[Math.min(pts.length - 1, i + 2)]!
    for (let s = 0; s < per; s++) {
      const t = s / per, t2 = t * t, t3 = t2 * t
      out.push([0, 1, 2].map((k) => 0.5 * (2 * p1[k]! + (-p0[k]! + p2[k]!) * t + (2 * p0[k]! - 5 * p1[k]! + 4 * p2[k]! - p3[k]!) * t2 + (-p0[k]! + 3 * p1[k]! - 3 * p2[k]! + p3[k]!) * t3)) as V3)
    }
  }
  out.push(pts[pts.length - 1]!)
  return out
}

/** The sheet and lanyard (sheet frame), plus the left glove pinching the sheet's lower left edge. */
export function buildSheet(s: PaperShape, shoulder: V3): { opaque: Float32Array<ArrayBuffer> } {
  const m = new MeshBuilder()
  const rest = compassRest(s)
  const nu = 136, nv = 160
  m.grid(nu, nv, (a, b) => paperPoint(a * SHEET.w, b * SHEET.h, s, rest), (a, b) => [a, b], OBJ.sheet, MAT.paper, true)
  lanyard(m, s, rest)
  leftGlove(m, s, shoulder)
  return { opaque: m.build() }
}

/**
 * Lanyard: a soft braided cord out of the plate's hole, lying slack across the paper in a loose S, over the bottom
 * edge and hanging in a loop back to the left wrist.
 */
function lanyard(m: MeshBuilder, s: PaperShape, rest: ReturnType<typeof compassRest>) {
  const R = 0.0011
  const local = (x: number, y: number, z: number): V3 => v3.add(rest.centre, v3.add(v3.add(v3.scale(rest.right, x), v3.scale(rest.front, y)), v3.scale(rest.n, z)))
  const hole = local(0, COMPASS.hole.y / 1000, COMPASS.plate.t / 1000 + R * 0.6)
  const back = local(0.003, (COMPASS.hole.y - 6) / 1000, R)
  const hu = (back[0] + W / 2) * 1000, hv = (H / 2 - back[1]) * 1000
  const ctrl: V3[] = [hole, back]
  const endU = hu - 26, span = SHEET.h - 0.5 - hv
  for (let i = 1; i <= 6; i++) {
    const t = i / 6
    const u = hu + (endU - hu) * t + Math.sin(t * Math.PI * 1.7 + 0.4) * 11
    const v = hv + span * t
    const p = paperPoint(u, v, s, rest)
    ctrl.push([p[0], p[1], p[2] + R])
  }
  const edge = ctrl[ctrl.length - 1]!
  const over: V3 = [edge[0] - 0.002, edge[1] - 0.006, edge[2] - 0.004]
  const wrist: V3 = [-W / 2 - 0.05, H / 2 - (PINCH.v + 95) / 1000, -0.05]
  const loop: V3[] = []
  for (let i = 1; i <= 5; i++) {
    const t = i / 5
    const x = over[0] + (wrist[0] - over[0]) * t, z = over[2] + (wrist[2] - over[2]) * t
    loop.push([x, over[1] + (wrist[1] - over[1]) * t - Math.sin(t * Math.PI) * 0.085, z + Math.sin(t * Math.PI) * 0.012])
  }
  const path = spline([...ctrl, over, ...loop], 10)
  m.tube(path, path.map(() => R), OBJ.sheet, MAT.cord, 10)
}

// ---------------------------------------------------------------- gloves

/**
 * A gloved finger: a chain of phalanges from `base` (the knuckle), each bent from the last about `axis` by its flex
 * angle (rad), starting along `dir`. Joints bulge slightly; uv.y = joint index + share of the segment (creases sit at
 * whole numbers; the tip stops short of the next).
 */
function finger(m: MeshBuilder, base: V3, dir: V3, axis: V3, lens: number[], flex: number[], r0: number, obj: number) {
  const rot = (v: V3, k: V3, a: number): V3 => {
    const c = Math.cos(a), s = Math.sin(a), d = v3.dot(k, v)
    return v3.add(v3.add(v3.scale(v, c), v3.scale(v3.cross(k, v), s)), v3.scale(k, d * (1 - c)))
  }
  const path: V3[] = [], radii: number[] = [], along: number[] = []
  let p = base, d = dir
  const per = 5
  for (let j = 0; j < lens.length; j++) {
    d = v3.norm(rot(d, axis, flex[j]!))
    const end = j === lens.length - 1 ? 0.9 : 1
    for (let k = j ? 1 : 0; k <= per; k++) {
      const t = k / per
      const bend = j + 1 < lens.length ? rot(d, axis, flex[j + 1]! * Math.max(0, t - 0.8) * 2.5) : d
      if (k) p = v3.add(p, v3.scale(v3.norm(v3.add(d, bend)), lens[j]! / per / 1.0))
      const taper = r0 * (1 - 0.16 * (j + t) / lens.length)
      const knuckle = 1 + 0.09 * Math.exp(-((t - (k === per ? 1 : 0)) ** 2) / 0.02) * (j + t < lens.length - 0.2 ? 1 : 0)
      path.push(p); radii.push(taper * knuckle); along.push(j + t * end)
    }
  }
  m.tube(path, radii, obj, MAT.glove, 18, true, along)
}

/** A hand frame: origin, across the knuckles (index → little), along the back of the hand, out of the back. */
type HandFrame = { o: V3; x: V3; y: V3; z: V3 }
const inHand = (f: HandFrame, p: V3): V3 => v3.add(f.o, v3.add(v3.add(v3.scale(f.x, p[0]), v3.scale(f.y, p[1])), v3.scale(f.z, p[2])))

/** Palm and back of the hand: a rounded box, and the soft heel of the thumb. Knuckle line at y = 0. */
function palm(m: MeshBuilder, f: HandFrame, obj: number) {
  m.superellipsoid(inHand(f, [0.002, -0.044, -0.004]), [0.043, 0.05, 0.015], [f.x, f.y, f.z], 0.55, obj, MAT.glove)
  m.superellipsoid(inHand(f, [-0.024, -0.062, -0.014]), [0.016, 0.03, 0.014], [f.x, f.y, f.z], 0.8, obj, MAT.glove)
}

/** Cuff and jacket sleeve from the wrist towards the shoulder. */
function cuffAndSleeve(m: MeshBuilder, wrist: V3, heel: V3, shoulder: V3, obj: number) {
  const towards = v3.norm(v3.sub(shoulder, wrist))
  const cuffEnd = v3.add(wrist, v3.scale(towards, 0.075))
  m.tube([heel, wrist, cuffEnd], [0.032, 0.035, 0.044], obj, MAT.glove, 24, true, [10, 10.25, 11])
  m.tube([v3.add(wrist, v3.scale(towards, 0.06)), v3.add(wrist, v3.scale(towards, 0.17)), v3.add(wrist, v3.scale(towards, 0.34))], [0.046, 0.052, 0.056], obj, MAT.sleeve, 24)
}

const FINGERS = [
  { x: -0.03, y: 0.002, lens: [0.047, 0.027, 0.024], r: 0.0104 },
  { x: -0.01, y: 0.005, lens: [0.051, 0.031, 0.025], r: 0.0107 },
  { x: 0.01, y: 0.002, lens: [0.048, 0.03, 0.025], r: 0.0101 },
  { x: 0.029, y: -0.008, lens: [0.038, 0.023, 0.022], r: 0.0091 },
] as const

/**
 * Left glove: the hand behind the sheet's lower-left edge, palm towards the paper's back, fingers spread flat behind
 * it; the thumb comes round the edge and pins the face (the orienteering pinch), then the cuff and the sleeve.
 */
const sheetAt = (u: number, v: number, z: number): V3 => [u / 1000 - W / 2, H / 2 - v / 1000, z]

/** The left hand's frame: fingers right and a little up behind the paper, the back of the hand away (−z). */
function leftFrame(): HandFrame {
  const y = v3.norm([0.9, 0.38, -0.1])
  const z = v3.norm(v3.sub([-0.25, 0, -1], v3.scale(y, v3.dot([-0.25, 0, -1], y))))
  let x = v3.cross(y, z)
  if (x[1] > 0) x = v3.scale(x, -1)
  return { o: sheetAt(PINCH.u - 26, PINCH.v + 30, -0.03), x, y, z }
}

/** The left thumb's centre line (sheet frame): from the heel, round the edge, the pad on the face, tip towards the compass. */
export function leftThumb(s: PaperShape): V3[] {
  return thumbShape(s).path
}

/** The thumb: centre line, radii, joint parameter and how flat it presses (sheet frame). */
function thumbShape(s: PaperShape) {
  const f = leftFrame()
  const R = [0.0118, 0.0114, 0.011, 0.0104, 0.0097, 0.009]
  const K = [1, 0.95, 0.85, 0.74, 0.72, 0.74]
  // On the paper the pad flattens: its centre sits at the squashed half-height above the surface.
  const on = (u: number, v: number, i: number) => sheetAt(u, v, rawZ(u, v, s) + R[i]! * K[i]! * 0.92)
  const ctrl: V3[] = [inHand(f, [-0.034, -0.05, -0.016]), inHand(f, [-0.046, -0.024, -0.024]), sheetAt(PINCH.u - 16, PINCH.v + 2, 0.007), on(PINCH.u - 2, PINCH.v - 6, 3), on(PINCH.u + 12, PINCH.v - 15, 4), on(PINCH.u + 24, PINCH.v - 24, 5)]
  const path = spline(ctrl, 8)
  const at = (arr: number[], i: number) => { const t = (i / (path.length - 1)) * (arr.length - 1), j = Math.min(arr.length - 2, Math.floor(t)); return arr[j]! + (arr[j + 1]! - arr[j]!) * (t - j) }
  const along = path.map((_, i) => 0.3 + 2.55 * (i / (path.length - 1)))
  // The leather pinches in at each joint and the knuckle swells just before it.
  const joint = (a: number) => [1, 2].reduce((r, j) => r * (1 - 0.07 * Math.exp(-((a - j) ** 2) / 0.004) + 0.04 * Math.exp(-((a - j + 0.12) ** 2) / 0.006)), 1)
  return { path, radii: path.map((_, i) => at(R, i) * joint(along[i]!)), k: path.map((_, i) => at(K, i)), along }
}

function leftGlove(m: MeshBuilder, s: PaperShape, shoulder: V3) {
  const f = leftFrame()
  palm(m, f, OBJ.left)
  FINGERS.forEach((g, i) => finger(m, inHand(f, [g.x, g.y, 0]), f.y, f.x, [...g.lens], [0.02 + i * 0.02, 0.18, 0.14], g.r, OBJ.left))
  const t = thumbShape(s)
  m.tube(t.path, t.radii, OBJ.left, MAT.glove, 24, true, t.along, { up: [0, 0, 1], k: t.k })
  const wrist = inHand(f, [0.004, -0.115, -0.006])
  cuffAndSleeve(m, wrist, inHand(f, [0.002, -0.085, -0.004]), shoulder, OBJ.left)
}

// ---------------------------------------------------------------- compass

/** The compass: plate (transparent, bevelled), bezel, floor, needle, pivot, glass and bubble in their own frames. */
export function buildCompass(): { opaque: Float32Array<ArrayBuffer>; clear: Float32Array<ArrayBuffer> } {
  const o = new MeshBuilder(), c = new MeshBuilder()
  const P = COMPASS.plate, mm = 0.001
  // Plate outline (rounded rectangle), counter-clockwise from +z, inset by `d` mm.
  const outlineAt = (d: number) => {
    const pts: [number, number][] = []
    const r = P.r - d
    const corners: [number, number, number][] = [[P.w / 2 - P.r, P.l / 2 - P.r, 0], [-P.w / 2 + P.r, P.l / 2 - P.r, 1], [-P.w / 2 + P.r, -P.l / 2 + P.r, 2], [P.w / 2 - P.r, -P.l / 2 + P.r, 3]]
    for (const [cx, cy, q] of corners) for (let i = 0; i <= 8; i++) {
      const a = (q * Math.PI) / 2 + (i / 8) * (Math.PI / 2)
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
    }
    pts.push(pts[0]!)
    return pts
  }
  const BEV = 0.8
  const outer = outlineAt(0), inner = outlineAt(BEV)
  const topZ = P.t * mm, bevZ = (P.t - BEV * 0.75) * mm
  const topPts = inner.map(([x, y]) => [x * mm, y * mm, topZ] as V3)
  const bevPts = outer.map(([x, y]) => [x * mm, y * mm, bevZ] as V3)
  const lowPts = outer.map(([x, y]) => [x * mm, y * mm, 0] as V3)
  const outward = (p: V3): V3 => {
    const x = p[0] / mm, y = p[1] / mm
    const cx = Math.max(-P.w / 2 + P.r, Math.min(P.w / 2 - P.r, x)), cy = Math.max(-P.l / 2 + P.r, Math.min(P.l / 2 - P.r, y))
    return v3.norm([x - cx, y - cy, 0])
  }
  c.fan(topPts.slice(0, -1), [0, 0, 1], (p) => plateUv(p[0] / mm, p[1] / mm), OBJ.compass, MAT.acrylic)
  // The bevel (a 45° chamfer that catches the torch) and the polished side wall.
  c.wall(bevPts, topPts, OBJ.compass, MAT.plateEdge, (p) => { const q = outward(p); return v3.norm([q[0], q[1], 1.1]) }, (i, t) => [i / outer.length, t ? 2 : 1.5])
  c.wall(lowPts, bevPts, OBJ.compass, MAT.plateEdge, outward, (i, t) => [i / outer.length, t ? 1 : 0])

  // Bezel ring (its own frame: centre on the plate top): a thin ridged black ring.
  const B = COMPASS.bezel, rIn = B.inner * mm, rOut = B.outer * mm, h = B.h * mm
  const zFloor = 0.9 * mm
  o.grid(180, 4, (a, b) => { const r = rIn + (rOut - 0.35 * mm - rIn) * b, t = a * Math.PI * 2; return [Math.cos(t) * r, Math.sin(t) * r, h] }, (a, b) => {
    const r = B.inner + (B.outer - 0.35 - B.inner) * b, t = a * Math.PI * 2
    return bezelUv(Math.cos(t) * r, Math.sin(t) * r)
  }, OBJ.bezel, MAT.bezelTop, true)
  // Outer wall: real ridges (120 round the ring) between a bottom chamfer and a rounded top edge.
  const RIDGES = 120
  const prof: [number, number][] = [[rOut - 0.25 * mm, 0], [rOut, 0.35 * mm], [rOut, h - 0.7 * mm], [rOut - 0.35 * mm, h]]
  o.grid(RIDGES * 6, prof.length - 1, (a, v) => {
    const k = v * (prof.length - 1), i = Math.min(prof.length - 2, Math.floor(k)), f = k - i
    const r = prof[i]![0] + (prof[i + 1]![0] - prof[i]![0]) * f, z = prof[i]![1] + (prof[i + 1]![1] - prof[i]![1]) * f
    const t = a * Math.PI * 2
    const ridge = (i === 1 ? 1 : f * (i === 0 ? 1 : 0) + (i === 2 ? 1 - f : 0)) * 0.22 * mm * (0.5 + 0.5 * Math.cos(t * RIDGES))
    return [Math.cos(t) * (r + ridge), Math.sin(t) * (r + ridge), z]
  }, (a, v) => [a, v], OBJ.bezel, MAT.bezelSide)
  // Inner wall down to the floor (smooth: uv.y ≥ 2).
  o.lathe([[rIn, h], [rIn, zFloor]], 96, OBJ.bezel, MAT.bezelSide, (p) => [p[0], -p[2], p[1]], undefined, (a, k) => [a, 3 - k])
  // Capsule floor (meridians and orienting arrow; the map shows through it, refracted).
  o.grid(96, 8, (a, b) => { const r = rIn * b, t = -a * Math.PI * 2; return [Math.cos(t) * r, Math.sin(t) * r, zFloor] }, (a, b) => {
    const r = B.inner * b, t = -a * Math.PI * 2
    return floorUv(Math.cos(t) * r, Math.sin(t) * r)
  }, OBJ.bezel, MAT.floor)
  // Pivot post and its jewel.
  o.lathe([[0.001, zFloor], [0.0008, zFloor + 1.9 * mm], [0.0004, zFloor + 2.5 * mm], [0, zFloor + 2.6 * mm]], 16, OBJ.bezel, MAT.metal, (p) => [p[0], -p[2], p[1]])
  // Glass top, slightly domed.
  c.grid(96, 8, (a, b) => { const r = rIn * b, t = -a * Math.PI * 2; return [Math.cos(t) * r, Math.sin(t) * r, h - 0.4 * mm + 0.4 * mm * (1 - b * b)] }, (a, b) => [a, b], OBJ.bezel, MAT.glass)

  // Needle: a ridged lozenge, north half red, south half white (uv.y −1..1 along it, uv.x across), on a hub.
  const L = COMPASS.needle.len * mm, w = COMPASS.needle.w * mm / 2, ridge = 0.35 * mm, base = -0.15 * mm
  for (const dir of [1, -1]) {
    const tip: V3 = [0, dir * L, 0], left: V3 = [-w, 0, 0], right: V3 = [w, 0, 0], top: V3 = [0, 0, ridge]
    const tipTop: V3 = [0, dir * L, ridge * 0.2]
    for (const [a, b] of [[left, top], [top, right]] as const) {
      const n = v3.norm(v3.cross(v3.sub(b, a), v3.sub(tip, a)))
      const nn = n[2] < 0 ? v3.scale(n, -1) : n
      for (const p of [a, b, tipTop]) o.vertex(p, nn, [p[0] / w, p[1] / L], [0, dir, 0], OBJ.needle, MAT.needle)
    }
    for (const p of [left, tip, right]) o.vertex([p[0], p[1], base], [0, 0, -1], [p[0] / w, p[1] / L], [0, dir, 0], OBJ.needle, MAT.needle)
    for (const [a, b] of [[left, tip], [tip, right]] as const) {
      const q: V3[] = [[a[0], a[1], base], [b[0], b[1], base], [b[0], b[1], ridge * 0.1], [a[0], a[1], ridge * 0.1]]
      const n = v3.norm([(a[1] - b[1]) * dir, (b[0] - a[0]) * dir, 0])
      for (const k of [0, 1, 2, 0, 2, 3]) o.vertex(q[k]!, n, [q[k]![0] / w, q[k]![1] / L], [0, dir, 0], OBJ.needle, MAT.needle)
    }
  }
  o.lathe([[0.0018, -0.3 * mm], [0.0018, 0.45 * mm], [0.0008, 0.7 * mm], [0, 0.75 * mm]], 20, OBJ.needle, MAT.jewel, (p) => [p[0], -p[2], p[1]])

  // Bubble (its own frame, just under the glass).
  c.ellipsoid([0, 0, 0], [1.2 * mm, 1.2 * mm, 0.8 * mm], [[1, 0, 0], [0, 1, 0], [0, 0, 1]], OBJ.bubble, MAT.bubble, 16, 10)
  return { opaque: o.build(), clear: c.build() }
}

/** Heights in the bezel frame (m) the pass and the shader share. */
export const CAPSULE = { floor: 0.0009, needle: 0.0009 + 2.45 * 0.001, glass: COMPASS.bezel.h * 0.001 - 0.0004 }

// ---------------------------------------------------------------- torch

/** The torch in the right glove (frame `right`: lens at the origin, beam along +y, z up). */
export function buildTorch(shoulder: V3): Float32Array<ArrayBuffer> {
  const m = new MeshBuilder()
  m.lathe([[0, -0.137], [0.0112, -0.1362], [0.0124, -0.1335], [0.0124, -0.112], [0.0127, -0.11], [0.0127, -0.046], [0.0124, -0.044], [0.0176, -0.017], [0.0178, -0.004], [0.017, 0]], 48, OBJ.right, MAT.torch, (p) => p, undefined, (a, k) => [a, k])
  m.grid(48, 6, (a, b) => { const r = 0.0168 * b, t = -a * Math.PI * 2; return [Math.cos(t) * r, 0.0002, -Math.sin(t) * r] }, (a, b) => [a, b], OBJ.right, MAT.lens)
  // Fist round the barrel: the back of the hand on the right (+x), fingers down and round under the barrel, the thumb
  // along the top towards the head.
  const f: HandFrame = { o: [0.034, -0.079, 0.003], x: [0, -1, 0], y: v3.norm([-0.83, 0, -0.55]), z: v3.norm([0.55, 0, -0.83]) }
  palm(m, f, OBJ.right)
  FINGERS.forEach((g, i) => finger(m, inHand(f, [g.x * 0.92, g.y, 0]), f.y, f.x, [...g.lens], [-0.12, -1.5 + i * 0.04, -1.2], g.r, OBJ.right))
  const thumb = spline([inHand(f, [-0.034, -0.05, -0.016]), [0.024, -0.058, 0.02], [0.01, -0.05, 0.026], [-0.001, -0.04, 0.022]], 4)
  m.tube(thumb, thumb.map((_, i) => 0.0128 - 0.0024 * (i / (thumb.length - 1))), OBJ.right, MAT.glove, 20, true, thumb.map((_, i) => 0.3 + 2.55 * (i / (thumb.length - 1))))
  cuffAndSleeve(m, inHand(f, [0.004, -0.115, -0.006]), inHand(f, [0.002, -0.085, -0.004]), shoulder, OBJ.right)
  return m.build()
}
