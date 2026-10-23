import type { FrameParts } from "@arcade/kit/gpu/frame-parts"
import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import { CHUNK } from "@arcade/kit/forest/build"
import { drawnTrunk, type DrawnTrunk } from "@arcade/kit/forest/trunk"
import { FOREST_WIND_DIR, forestTrunkSway, forestWindAt } from "@arcade/kit/forest/wind"
import { mulberry } from "@arcade/kit/sim/forest-demo"
import type { Feel, Tape } from "../shared/sim"
import { forestTree } from "../shared/forest-world"
import { terrainHeight, type WoodsWorld } from "../shared/world"

/**
 * Surveyor's flagging tape as drawn: a 2.5 cm fluorescent plastic ribbon pulled round the trunk you see at chest height
 * on a slight diagonal, tied off with a knot a little to one side of whoever tied it, its two ends overlapping under
 * the knot, and two loose tails of different lengths that start a few centimetres apart, splay, twist and move in the
 * forest's wind.
 *
 * - The band follows the drawn trunk (`drawnTrunk` from the forest kit: same rings, lobes, lean, instance transform and
 *   smooth-trunk option) as a taut ribbon does, over the convex hull of the bark along its tilted path, 4 mm off it,
 *   with a little slack where it leaves the knot, on the near or far trunk exactly as the forest picks it per chunk,
 *   and moved with the trunk's own sway.
 * - Tails are verlet strips (gravity, drag towards the forest's travelling gust, length and bend constraints, the
 *   trunk's flare below as a collider) with a twist that flutters down their length, simulated within `SIM_RANGE`.
 * - Contact shadow: a translucent dark strip under and over the band on the bark itself, fitted to the trunk at each of
 *   its vertices' heights, for the nearest `SKIRTS` tapes.
 * - It stays a marker at range: band and tails never draw narrower than `MIN_ANGLE` of view, and the Lab's "tape shine
 *   with distance" raises the fluorescent colour's gain past 4 m. The batch shader (kit MAT.tape) gives it gloss and
 *   lets a torch behind it shine through.
 *
 * Everything is rebuilt into one dynamic model per frame (about 1 k vertices a nearby tape, a few hundred far off).
 */

/** Fluorescent pink flagging, sRGB. */
const PINK: readonly [number, number, number] = [1, 0.2, 0.58]
/** Tie height above the drawn ground (m), ribbon width (m), clearance off the bark (m). */
const TIE_HEIGHT = 1.4
const WIDTH = 0.025
const OFF = 0.004
/** The narrowest the ribbon draws, as an angle of view (rad): ~1.3 px at 1080p. */
const MIN_ANGLE = 0.0018
const SIM_RANGE = 30
const DRAW_RANGE = 100
const KNOT_RANGE = 25
/** Contact shadows: within this range (m), the nearest few tapes, at this opacity. */
const SKIRT_RANGE = 9
const SKIRTS = 4
const SKIRT_ALPHA = 0.4
const TAIL_SEGS = 10
/** How far the band's ends run past each other under the knot (m), and how far its slack reaches from the knot. */
const OVERLAP = 0.035
const SLACK = 0.09
/** Contact-shadow strips: angles round the trunk, and their bottom/top edges relative to the band's centre (m). */
const SKIRT_ANGLES = 48
const SKIRT_EDGES = [[-WIDTH / 2 - 0.006, -WIDTH / 2 + 0.003], [WIDTH / 2 - 0.003, WIDTH / 2 + 0.0025]] as const
/** Collider levels under the knot for the tails: from 10 cm above to 70 cm below, every 5 cm. */
const LEVEL_TOP = 0.1
const LEVEL_STEP = 0.05
const LEVELS = 17
const LEVEL_ANGLES = 32
const STEP = 1 / 120

/** A closed line round the trunk from the knot: points, outward normals, arc length and angle from the knot (0..2π). */
type Path = { x: Float64Array; z: Float64Array; nx: Float64Array; nz: Float64Array; s: Float64Array; ang: Float64Array; length: number }
type Tail = { p: Float64Array; q: Float64Array; seg: number; twist: number; phase: number; ready: boolean }
type Shape = {
  tape: Tape
  trunk: DrawnTrunk
  smooth: boolean
  x: number
  z: number
  /** Band centre height (world y) and the bark's wind share there. */
  y: number
  share: number
  near: Path
  far: Path
  /** The knot's plan angle round the trunk (rad). */
  knot: number
  /** Contact shadow, before sway: per strip, angle and edge, a vertex (x, y, z, nx, nz) on the bark 1.5 mm out. */
  skirt: Float64Array
  tilt: number
  tiltPhase: number
  /** Per collider level: centre x, z, then `LEVEL_ANGLES` radii (bark + clearance). */
  levels: Float64Array
  tails: [Tail, Tail]
  seed: number
}

type Look = { wind: number; gust: number; trunkSway: number; smoothTrunks?: boolean }

/** Andrew's monotone chain: the convex hull, counter-clockwise in (x, z). */
function hull(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: number[], a: number[], b: number[]) => (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!)
  const lo: [number, number][] = [], hi: [number, number][] = []
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2]!, lo[lo.length - 1]!, q) <= 1e-12) lo.pop(); lo.push(q) }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]!; while (hi.length >= 2 && cross(hi[hi.length - 2]!, hi[hi.length - 1]!, q) <= 1e-12) hi.pop(); hi.push(q) }
  return lo.slice(0, -1).concat(hi.slice(0, -1))
}

/** A convex CCW polygon pushed out by `d` along its edge normals. */
function offset(poly: [number, number][], d: number): [number, number][] {
  const n = poly.length
  const normal = (i: number) => {
    const a = poly[i]!, b = poly[(i + 1) % n]!, dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1
    return [dz / l, -dx / l] as const
  }
  return poly.map((p, i) => {
    const n1 = normal((i + n - 1) % n), n2 = normal(i)
    let bx = n1[0] + n2[0], bz = n1[1] + n2[1]
    const l = Math.hypot(bx, bz) || 1
    bx /= l; bz /= l
    const k = d / Math.max(0.2, bx * n1[0] + bz * n1[1])
    return [p[0] + bx * k, p[1] + bz * k]
  })
}

const centroid = (poly: [number, number][]): [number, number] => {
  let x = 0, z = 0
  for (const p of poly) { x += p[0]; z += p[1] }
  return [x / poly.length, z / poly.length]
}

/** Where the ray from `c` at plan angle `a` leaves the convex polygon: edge index and the point. */
function rayHit(poly: [number, number][], c: [number, number], a: number): { edge: number; x: number; z: number; r: number } {
  const dx = Math.cos(a), dz = Math.sin(a)
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!, q = poly[(i + 1) % poly.length]!
    const ex = q[0] - p[0], ez = q[1] - p[1]
    const den = dx * ez - dz * ex
    if (Math.abs(den) < 1e-12) continue
    const wx = p[0] - c[0], wz = p[1] - c[1]
    const r = (wx * ez - wz * ex) / den, u = (wx * dz - wz * dx) / den
    if (r > 0 && u >= -1e-9 && u <= 1 + 1e-9) return { edge: i, x: c[0] + dx * r, z: c[1] + dz * r, r }
  }
  return { edge: 0, x: poly[0]![0], z: poly[0]![1], r: Math.hypot(poly[0]![0] - c[0], poly[0]![1] - c[1]) }
}

/** The band's centreline: once round the hull from the knot back to it, corners kept, no segment over `maxSeg`. */
function bandPath(poly: [number, number][], c: [number, number], knot: number, maxSeg: number): Path {
  const k = rayHit(poly, c, knot)
  const n = poly.length
  const pts: [number, number][] = [[k.x, k.z]]
  for (let i = 1; i <= n; i++) pts.push(poly[(k.edge + i) % n]!)
  pts.push([k.x, k.z])
  const xs: number[] = [], zs: number[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!, b = pts[i + 1]!, l = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (l < 1e-5) continue
    const m = Math.max(1, Math.ceil(l / maxSeg))
    for (let j = 0; j < m; j++) { xs.push(a[0] + ((b[0] - a[0]) * j) / m); zs.push(a[1] + ((b[1] - a[1]) * j) / m) }
  }
  xs.push(k.x); zs.push(k.z)
  const m = xs.length
  return finishPath(xs, zs, c, knot)
}

function finishPath(xs: number[], zs: number[], c: [number, number], knot: number): Path {
  const m = xs.length
  const path: Path = { x: Float64Array.from(xs), z: Float64Array.from(zs), nx: new Float64Array(m), nz: new Float64Array(m), s: new Float64Array(m), ang: new Float64Array(m), length: 0 }
  for (let i = 1; i < m; i++) path.s[i] = path.s[i - 1]! + Math.hypot(xs[i]! - xs[i - 1]!, zs[i]! - zs[i - 1]!)
  path.length = path.s[m - 1]!
  const TAU = Math.PI * 2
  for (let i = 0; i < m; i++) path.ang[i] = ((Math.atan2(zs[i]! - c[1], xs[i]! - c[0]) - knot) % TAU + TAU) % TAU
  path.ang[0] = 0
  path.ang[m - 1] = TAU
  for (let i = 0; i < m; i++) {
    // Outward: the right of the direction of travel (CCW), averaged over the two segments (wrapping at the knot).
    const a = i === 0 ? m - 2 : i - 1, b = i === m - 1 ? 1 : i + 1
    const dx = xs[b]! - xs[a]!, dz = zs[b]! - zs[a]!, l = Math.hypot(dx, dz) || 1
    path.nx[i] = dz / l; path.nz[i] = -dx / l
  }
  return path
}

const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

export class TapeView {
  private shapes = new Map<number, Shape>()
  private mesh = new Mesh()
  private model = -1
  private last = -1
  private sway: [number, number] = [0, 0]
  private edge = new Float64Array(6)
  private skirtMesh = new Mesh()
  private skirts: number[] = []

  constructor(private readonly renderer: Renderer) {}

  /** Drop every cached shape and restart the clock (the world was regenerated). */
  reset(): void { this.shapes.clear(); this.last = -1 }

  private shape(world: WoodsWorld, tape: Tape, smooth: boolean): Shape | null {
    const cached = this.shapes.get(tape.id)
    if (cached && cached.tape.tree === tape.tree && cached.tape.yaw === tape.yaw && cached.smooth === smooth) return cached
    const tree = world.trees[tape.tree]
    if (!tree) return null
    const trunk = drawnTrunk(world.params.seed, (x, z) => terrainHeight(world.terrain, x, z), forestTree(tree), smooth)
    const r = mulberry(((tape.id + 1) * 2654435761 + tree.id * 40503) >>> 0)
    const y = trunk.base + 0.05 + TIE_HEIGHT
    // Tied by hand: the knot a little to one side of the tier, the wrap on a slight diagonal.
    const knot = tape.yaw + (r() < 0.5 ? -1 : 1) * (0.3 + r() * 0.25)
    const tilt = 0.012 + r() * 0.012, tiltPhase = r() * Math.PI * 2
    const tiltAt = (ang: number) => tilt * Math.sin(ang + tiltPhase)
    const c0 = centroid(trunk.section(y, true))
    const angOf = (x: number, z: number) => { const a = (Math.atan2(z - c0[1], x - c0[0]) - knot) % (Math.PI * 2); return a < 0 ? a + Math.PI * 2 : a }
    // The bark the ribbon lies on: section points within its width of its tilted centre line.
    const band = (near: boolean, maxSeg: number) => {
      const pts: [number, number][] = []
      const span = WIDTH / 2 + tilt + 0.004
      for (let k = 0; k <= 10; k++) {
        const h = y - span + (2 * span * k) / 10
        for (const q of trunk.section(h, near)) if (Math.abs(h - y - tiltAt(angOf(q[0], q[1]))) <= WIDTH / 2 + 0.004) pts.push(q)
      }
      const poly = offset(hull(pts), OFF)
      return bandPath(poly, centroid(poly), knot, maxSeg)
    }
    const levels = new Float64Array(LEVELS * (2 + LEVEL_ANGLES))
    for (let k = 0; k < LEVELS; k++) {
      const poly = offset(hull(trunk.section(y + LEVEL_TOP - k * LEVEL_STEP, true)), OFF)
      const c = centroid(poly), o = k * (2 + LEVEL_ANGLES)
      levels[o] = c[0]; levels[o + 1] = c[1]
      for (let i = 0; i < LEVEL_ANGLES; i++) levels[o + 2 + i] = rayHit(poly, c, (i / LEVEL_ANGLES) * Math.PI * 2).r
    }
    // Contact shadow: each vertex on the bark at its own height (the section there, star-shaped about its centroid).
    const skirt = new Float64Array(SKIRT_EDGES.length * (SKIRT_ANGLES + 1) * 2 * 5)
    let o = 0
    for (const edge of SKIRT_EDGES) for (let i = 0; i <= SKIRT_ANGLES; i++) for (const off of edge) {
      const ang = (i / SKIRT_ANGLES) * Math.PI * 2, h = y + tiltAt(ang) + off
      const sec = trunk.section(h, true), c = centroid(sec), a = knot + ang
      const hit = rayHit(sec, c, a), nx = Math.cos(a), nz = Math.sin(a)
      skirt.set([hit.x + nx * 0.0015, h, hit.z + nz * 0.0015, nx, nz], o)
      o += 5
    }
    // Two ends of different lengths; each twists so you see its face, then its edge.
    const long = r() < 0.5 ? 0 : 1
    const tail = (length: number): Tail => ({ p: new Float64Array((TAIL_SEGS + 1) * 3), q: new Float64Array((TAIL_SEGS + 1) * 3), seg: length / TAIL_SEGS, twist: (r() < 0.5 ? -1 : 1) * (0.8 + r() * 0.9), phase: r() * 10, ready: false })
    const lengths = [0.41 + r() * 0.09, 0.29 + r() * 0.07]
    const s: Shape = { tape, trunk, smooth, x: tree.x, z: tree.z, y, share: trunk.swayShare(y), near: band(true, 0.022), far: band(false, 0.07), knot, skirt, tilt, tiltPhase, levels, tails: [tail(lengths[long]!), tail(lengths[1 - long]!)], seed: r() * 100 }
    this.shapes.set(tape.id, s)
    return s
  }

  /** Pushes this frame's tapes. `nearDist` is the forest quality's full-detail trunk distance. */
  draw(fp: FrameParts, world: WoodsWorld, tapes: readonly Tape[], t: number, eye: readonly number[], feel: Feel, look: Look, nearDist: number): void {
    if (this.model < 0) this.model = this.renderer.addModel(this.mesh)
    // A new session or world restarts the clock: no step that frame.
    const dt = this.last < 0 || t < this.last ? 0 : Math.min(0.1, t - this.last)
    this.last = t
    const live = new Set<number>()
    const skirts: { s: Shape; d: number; sx: number; sz: number }[] = []
    const v = this.mesh.v
    v.length = 0
    for (const tape of tapes) {
      live.add(tape.id)
      const d = Math.hypot(tape.x - eye[0]!, tape.z - eye[2]!)
      if (d > DRAW_RANGE) continue
      const s = this.shape(world, tape, !!look.smoothTrunks)
      if (!s) continue
      // The forest swaps trunk detail per 16 m chunk by the eye's distance to the chunk's box.
      const cx = Math.floor(s.x / CHUNK) * CHUNK + CHUNK / 2, cz = Math.floor(s.z / CHUNK) * CHUNK + CHUNK / 2
      const dc = Math.hypot(Math.max(Math.abs(eye[0]! - cx) - CHUNK / 2, 0), Math.max(Math.abs(eye[2]! - cz) - CHUNK / 2, 0))
      const width = Math.max(WIDTH, d * MIN_ANGLE)
      const gain = 1 + feel.tapeShine * Math.max(0, d - 4) * 0.3
      forestTrunkSway(s.x, s.z, t, s.share, s.trunk.phase, look, this.sway)
      const path = dc < nearDist ? s.near : s.far
      this.band(s, path, width, gain, d < 30 ? 2 : 1)
      if (d < SKIRT_RANGE) skirts.push({ s, d, sx: this.sway[0], sz: this.sway[1] })
      const knot = this.knotFrame(s, path)
      if (d < KNOT_RANGE) this.knot(knot, gain)
      for (const [i, tail] of s.tails.entries()) {
        // The ends leave the knot a few centimetres apart, one each way along the band.
        const side = i === 0 ? -1 : 1
        const ax = knot.x + knot.nx * 0.012 + knot.tx * 0.014 * side, ay = knot.y - 0.012 + 0.004 * side, az = knot.z + knot.nz * 0.012 + knot.tz * 0.014 * side
        if (!tail.ready) this.hang(s, tail, ax, ay, az)
        if (d < SIM_RANGE && dt > 0) this.simulate(s, tail, ax, ay, az, t, dt, look, knot.tx * side, knot.tz * side)
        this.strip(tail, knot, width, gain, t, look, s, i)
      }
    }
    for (const id of this.shapes.keys()) if (!live.has(id)) this.shapes.delete(id)
    skirts.sort((a, b) => a.d - b.d)
    for (const [i, k] of skirts.slice(0, SKIRTS).entries()) {
      while (this.skirts.length <= i) this.skirts.push(this.renderer.addModel(new Mesh()))
      this.skirtMesh.v.length = 0
      this.skirt(k.s, k.sx, k.sz)
      this.renderer.setModel(this.skirts[i]!, this.skirtMesh)
      // Translucent black darkens the bark behind it; fades out before the mist it would also tint matters.
      fp.push(this.skirts[i]!, 0, 0, 0, 0, [1, 1, 1], 0, 0, 0, SKIRT_ALPHA * (1 - smooth(SKIRT_RANGE * 0.5, SKIRT_RANGE, k.d)))
    }
    if (!v.length) return
    this.renderer.setModel(this.model, this.mesh)
    fp.push(this.model, 0, 0, 0, 0, [1, 1, 1], 0, 0, 0)
  }

  /** Contact shadow: the shape's bark-fitted strips, moved by (sx, sz), the trunk's sway this frame. */
  private skirt(s: Shape, sx: number, sz: number) {
    const k = s.skirt, v = this.skirtMesh.v, row = (SKIRT_ANGLES + 1) * 2
    for (let e = 0; e < SKIRT_EDGES.length; e++) for (let i = 0; i < SKIRT_ANGLES; i++) {
      const at = (j: number, top: number) => (e * row + j * 2 + top) * 5
      for (const o of [at(i, 0), at(i + 1, 0), at(i + 1, 1), at(i, 0), at(i + 1, 1), at(i, 1)]) v.push(k[o]! + sx, k[o + 1]!, k[o + 2]! + sz, k[o + 3]!, 0, k[o + 4]!, 0, 0, 0, MAT.lit, 0)
    }
  }

  private vtx(x: number, y: number, z: number, nx: number, ny: number, nz: number, shade: number, gain: number) {
    const l = Math.hypot(nx, ny, nz) || 1
    this.mesh.v.push(x, y, z, nx / l, ny / l, nz / l, PINK[0] * shade, PINK[1] * shade, PINK[2] * shade, MAT.tape, gain)
  }

  /** Height of the band's centre off level at `ang` round from the knot. */
  private tiltAt(s: Shape, ang: number): number {
    return s.tilt * Math.sin(ang + s.tiltPhase)
  }

  /**
   * The band: from under the knot round the trunk and back past it by `OVERLAP`, the returning end lying over the
   * first and lifting a little off the bark with slack either side of the knot. Close up it has a centre row, its edges
   * a shade darker where the ribbon meets the bark; past 30 m one quad spans it.
   */
  private band(s: Shape, p: Path, width: number, gain: number, rows: number) {
    const m = p.s.length, L = p.length, sx = this.sway[0], sz = this.sway[1]
    // Points along the band: the closed path, then its first `OVERLAP` again as the end that crosses over.
    let extra = 0
    while (extra + 1 < m && p.s[extra + 1]! <= OVERLAP) extra++
    const row = (i: number, k: number) => {
      const j = i < m ? i : i - m + 1, over = i >= m
      const along = over ? L + p.s[j]! : p.s[j]!
      const u = Math.min(along, Math.abs(L - along))
      const slack = 0.006 * (1 - smooth(0, SLACK, u))
      // The returning end rises over the first and climbs across it on its way under the knot.
      const lift = slack + 0.0025 * smooth(L - 0.02, L, along)
      const y = s.y + this.tiltAt(s, p.ang[j]!) + (over ? (p.s[j]! / OVERLAP) * 0.006 : 0) + (k / rows - 0.5) * width
      // Crinkles: the normal rocks up and down along the ribbon, so a torch's highlight breaks into creases.
      const ny = 0.22 * Math.sin(along * 53 + s.seed) * Math.sin(along * 11 + s.seed * 1.7) + (k / rows - 0.5) * 0.3
      return [p.x[j]! + p.nx[j]! * lift + sx, y, p.z[j]! + p.nz[j]! * lift + sz, p.nx[j]!, ny, p.nz[j]!, rows > 1 && (k === 0 || k === rows) ? 0.8 : 1] as const
    }
    for (let i = 0; i < m - 1 + extra; i++) {
      for (let k = 0; k < rows; k++) {
        const a = row(i, k), b = row(i + 1, k), c = row(i + 1, k + 1), d = row(i, k + 1)
        for (const q of [a, b, c, a, c, d]) this.vtx(q[0], q[1], q[2], q[3], q[4], q[5], q[6], gain)
      }
    }
  }

  private knotFrame(s: Shape, p: Path) {
    const nx = p.nx[0]!, nz = p.nz[0]!
    // Direction of travel round the trunk at the knot (the band leaves it this way and comes back from the other).
    // Proud of the slack and the overlapping end.
    const out = 0.0085
    return { x: p.x[0]! + nx * out + this.sway[0], y: s.y + this.tiltAt(s, 0) + 0.003, z: p.z[0]! + nz * out + this.sway[1], nx, nz, tx: -nz, tz: nx }
  }

  /** The knot: two wraps of ribbon crossing over the gathered ends, an overhand pulled tight. */
  private knot(f: ReturnType<TapeView["knotFrame"]>, gain: number) {
    const loop = (alpha: number, rn: number, rv: number, ww: number, on: number, ov: number, ot: number, shade: number) => {
      const ca = Math.cos(alpha), sa = Math.sin(alpha)
      // Axis a (through the loop) tilts from the band's direction towards up; v is the loop's long direction.
      const ax = f.tx * ca, ay = sa, az = f.tz * ca
      const vx = -f.tx * sa, vy = ca, vz = -f.tz * sa
      const cx = f.x + f.nx * (0.006 + on) + f.tx * ot, cy = f.y + ov, cz = f.z + f.nz * (0.006 + on) + f.tz * ot
      const n = 14
      const at = (j: number, side: number) => {
        const ph = (j / n) * Math.PI * 2, c = Math.cos(ph), s = Math.sin(ph)
        return [
          cx + f.nx * rn * c + vx * rv * s + ax * ww * 0.5 * side, cy + vy * rv * s + ay * ww * 0.5 * side, cz + f.nz * rn * c + vz * rv * s + az * ww * 0.5 * side,
          f.nx * c / rn + vx * s / rv, vy * s / rv, f.nz * c / rn + vz * s / rv,
        ] as const
      }
      for (let j = 0; j < n; j++) {
        const a = at(j, -1), b = at(j, 1), c = at(j + 1, 1), d = at(j + 1, -1)
        for (const q of [a, b, c, a, c, d]) this.vtx(q[0], q[1], q[2], q[3], q[4], q[5], shade, gain)
      }
    }
    loop(0.55, 0.009, 0.02, 0.02, 0, 0.002, -0.003, 0.78)
    loop(-0.85, 0.011, 0.015, 0.018, 0.0025, -0.004, 0.004, 0.95)
  }

  /** Collider: pushes (x, y, z) out of the trunk below the knot (with clearance). */
  private collide(s: Shape, p: Float64Array, o: number) {
    const f = Math.max(0, Math.min(LEVELS - 1.001, (s.y + LEVEL_TOP - p[o + 1]!) / LEVEL_STEP))
    const k = Math.floor(f), w = f - k, L = s.levels, a = k * (2 + LEVEL_ANGLES), b = a + 2 + LEVEL_ANGLES
    const cx = L[a]! + (L[b]! - L[a]!) * w + this.sway[0], cz = L[a + 1]! + (L[b + 1]! - L[a + 1]!) * w + this.sway[1]
    const dx = p[o]! - cx, dz = p[o + 2]! - cz, r = Math.hypot(dx, dz)
    let ang = Math.atan2(dz, dx) / (Math.PI * 2)
    if (ang < 0) ang += 1
    const fi = ang * LEVEL_ANGLES, i0 = Math.floor(fi) % LEVEL_ANGLES, i1 = (i0 + 1) % LEVEL_ANGLES, wi = fi - Math.floor(fi)
    const ra = L[a + 2 + i0]! + (L[a + 2 + i1]! - L[a + 2 + i0]!) * wi, rb = L[b + 2 + i0]! + (L[b + 2 + i1]! - L[b + 2 + i0]!) * wi
    const R = ra + (rb - ra) * w + 0.002
    if (r < R && r > 1e-6) { p[o] = cx + (dx / r) * R; p[o + 2] = cz + (dz / r) * R }
  }

  /** A tail at rest: straight down from its anchor, draped over the trunk. */
  private hang(s: Shape, tail: Tail, ax: number, ay: number, az: number) {
    for (let j = 0; j <= TAIL_SEGS; j++) {
      const o = j * 3
      tail.p[o] = ax; tail.p[o + 1] = ay - j * tail.seg; tail.p[o + 2] = az
      this.collide(s, tail.p, o)
    }
    tail.q.set(tail.p)
    tail.ready = true
  }

  /** One frame of a tail: verlet under gravity and air drag; (sx, sz) is the way the knot pushes this end apart. */
  private simulate(s: Shape, tail: Tail, ax: number, ay: number, az: number, t: number, dt: number, look: Look, sx: number, sz: number) {
    const p = tail.p, q = tail.q, n = TAIL_SEGS
    const [wx, wz] = FOREST_WIND_DIR
    const steps = Math.min(8, Math.max(1, Math.round(dt / STEP)))
    const h = dt / steps
    for (let k = 0; k < steps; k++) {
      const tk = t - dt + (k + 1) * h
      const U = 0.9 * forestWindAt(s.x, s.z, tk, look.wind, look.gust)
      for (let j = 1; j <= n; j++) {
        const o = j * 3, ph = tail.phase + j * 0.55
        // Air: the gust downwind, eddies across and up, all travelling down the tail.
        const airX = wx * U * (1 + 0.35 * Math.sin(tk * 1.7 + ph)) - wz * U * 0.5 * Math.sin(tk * 2.9 + ph)
        const airZ = wz * U * (1 + 0.35 * Math.sin(tk * 1.7 + ph)) + wx * U * 0.5 * Math.sin(tk * 2.9 + ph)
        const airY = U * 0.3 * Math.sin(tk * 4.1 + ph * 1.3)
        for (let c = 0; c < 3; c++) {
          const x = p[o + c]!, vel = (x - q[o + c]!) / h
          const air = c === 0 ? airX : c === 1 ? airY : airZ
          // The knot's stiffness splays the two ends apart near the top.
          const spread = j < 4 ? 2.2 * (1 - j / 4) : 0
          const acc = 4.5 * (air - vel) + (c === 1 ? -9.8 : c === 0 ? sx * spread : sz * spread)
          q[o + c] = x
          p[o + c] = x + vel * h * 0.996 + acc * h * h
        }
      }
      p[0] = ax; p[1] = ay; p[2] = az; q[0] = ax; q[1] = ay; q[2] = az
      for (let it = 0; it < 4; it++) {
        for (let j = 0; j < n; j++) {
          const a = j * 3, b = a + 3
          const dx = p[b]! - p[a]!, dy = p[b + 1]! - p[a + 1]!, dz = p[b + 2]! - p[a + 2]!
          const l = Math.hypot(dx, dy, dz) || 1e-9, e = (l - tail.seg) / l
          const wa = j === 0 ? 0 : 0.5, wb = j === 0 ? 1 : 0.5
          p[a] = p[a]! + dx * e * wa; p[a + 1] = p[a + 1]! + dy * e * wa; p[a + 2] = p[a + 2]! + dz * e * wa
          p[b] = p[b]! - dx * e * wb; p[b + 1] = p[b + 1]! - dy * e * wb; p[b + 2] = p[b + 2]! - dz * e * wb
        }
        // A little bending stiffness: two links apart never fold closer than 1.6 links.
        for (let j = 0; j < n - 1; j++) {
          const a = j * 3, b = a + 6
          const dx = p[b]! - p[a]!, dy = p[b + 1]! - p[a + 1]!, dz = p[b + 2]! - p[a + 2]!
          const l = Math.hypot(dx, dy, dz) || 1e-9, min = tail.seg * 1.6
          if (l >= min) continue
          const e = ((l - min) / l) * 0.25, wa = j === 0 ? 0 : 0.5, wb = j === 0 ? 1 : 0.5
          p[a] = p[a]! + dx * e * wa; p[a + 1] = p[a + 1]! + dy * e * wa; p[a + 2] = p[a + 2]! + dz * e * wa
          p[b] = p[b]! - dx * e * wb; p[b + 1] = p[b + 1]! - dy * e * wb; p[b + 2] = p[b + 2]! - dz * e * wb
        }
        for (let j = 1; j <= n; j++) this.collide(s, p, j * 3)
      }
    }
  }

  /** The tail's ribbon: a frame carried down the strip from the trunk's tangent at the knot, twisted as it flutters. */
  private strip(tail: Tail, f: ReturnType<TapeView["knotFrame"]>, width: number, gain: number, t: number, look: Look, s: Shape, index: number) {
    const p = tail.p, n = TAIL_SEGS
    const U = forestWindAt(s.x, s.z, t, look.wind, look.gust)
    // Width direction at the knot: along the trunk's surface; carried down by parallel transport.
    let rx = f.tx, ry = 0, rz = f.tz
    const rows: number[][] = []
    for (let j = 0; j <= n; j++) {
      const a = Math.max(0, j - 1) * 3, b = Math.min(n, j + 1) * 3
      let tx = p[b]! - p[a]!, ty = p[b + 1]! - p[a + 1]!, tz = p[b + 2]! - p[a + 2]!
      const tl = Math.hypot(tx, ty, tz) || 1
      tx /= tl; ty /= tl; tz /= tl
      const dot = rx * tx + ry * ty + rz * tz
      rx -= tx * dot; ry -= ty * dot; rz -= tz * dot
      const rl = Math.hypot(rx, ry, rz) || 1
      rx /= rl; ry /= rl; rz /= rl
      const share = j / n
      const twist = tail.twist * share + (0.25 + 0.8 * Math.min(U, 2)) * share * Math.sin(t * 4.3 + tail.phase - j * 0.8) + 0.12 * Math.sin(t * 9.7 + tail.phase * 2 + j) * share
      // Rodrigues about the tangent: w = r cos θ + (t × r) sin θ.
      const cx = ty * rz - tz * ry, cy = tz * rx - tx * rz, cz = tx * ry - ty * rx
      const c = Math.cos(twist), sn = Math.sin(twist)
      const wx = rx * c + cx * sn, wy = ry * c + cy * sn, wz = rz * c + cz * sn
      const nx = ty * wz - tz * wy, ny = tz * wx - tx * wz, nz = tx * wy - ty * wx
      const o = j * 3, hw = width * 0.5, e = this.edge
      // Each edge of a twisted ribbon stays out of the bark too.
      e[0] = p[o]! - wx * hw; e[1] = p[o + 1]! - wy * hw; e[2] = p[o + 2]! - wz * hw
      e[3] = p[o]! + wx * hw; e[4] = p[o + 1]! + wy * hw; e[5] = p[o + 2]! + wz * hw
      if (j > 0) { this.collide(s, e, 0); this.collide(s, e, 3) }
      rows.push([e[0], e[1], e[2], e[3], e[4], e[5], nx, ny, nz])
    }
    const shade = index === 0 ? 1 : 0.94
    for (let j = 0; j < n; j++) {
      const a = rows[j]!, b = rows[j + 1]!
      const v0 = [a[0]!, a[1]!, a[2]!, a[6]!, a[7]!, a[8]!], v1 = [a[3]!, a[4]!, a[5]!, a[6]!, a[7]!, a[8]!]
      const v2 = [b[3]!, b[4]!, b[5]!, b[6]!, b[7]!, b[8]!], v3 = [b[0]!, b[1]!, b[2]!, b[6]!, b[7]!, b[8]!]
      for (const q of [v0, v1, v2, v0, v2, v3]) this.vtx(q[0]!, q[1]!, q[2]!, q[3]!, q[4]!, q[5]!, shade, gain)
    }
  }
}
