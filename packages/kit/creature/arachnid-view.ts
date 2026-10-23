/**
 * Draws an `ArachnidPose` with the shared renderer's instanced models, as a harvestman: one fused oval body
 * (cephalothorax and abdomen together) with a small eye turret on top, and legs read as segments rather than rods: a
 * thick coxa and trochanter at the top, the femur, a short patella and the tibia separated by small joint bumps with
 * faint pale rings, a subtle swelling at the knee, and a long thin tarsus that curls slightly so the foot meets the
 * ground at a shallow angle instead of stabbing it.
 *
 * The shell is `MAT.chitin`: dark brown-black cuticle, glossy enough for a narrow highlight to run along the legs in
 * a beam, with a moonlit rim on its edges (the vertex aux carries the sheen). Vertex colours are sRGB and become
 * linear albedo through pow 2.2: 0.085 was 0.4% (coal, invisible past a few metres), 0.12 is about 1%. Tubes wind
 * counter-clockwise seen from outside, so their normals face out (lamplight's first pass had them inverted).
 *
 * Models are built in metres for one shape (size, hip shrink, leg radius, colour, sheen); `setShape` rebuilds them in
 * place.
 */
import { FrameParts } from "../gpu/frame-parts"
import { MAT, Mesh, type Rgb } from "../gpu/mesh"
import type { Batch, Renderer } from "../gpu/renderer"
import { cross, emit, len, limb, norm, sub, type Frame, type V3 } from "../rig"
import { ARACHNID_FOOT, arachnidLocal, legLengths, type ArachnidPose } from "./arachnid-legs"
import { arachnidScale, type ArachnidSettings } from "./arachnid-settings"

export type ArachnidLook = {
  /** Metres per creature unit (the legs' scale) and body/hip shrink (`ArachnidShape.hips`). */
  size: number
  hips: number
  /** Femur radius at the hip, metres; the tibia and tarsus taper from it. */
  legRadius: number
  /** sRGB vertex colour of the legs; the body and the joint rings are drawn relative to it. */
  color: Rgb
  /** Moonlit rim on the shell's edges, 0–1. */
  sheen: number
}

/** Dark brown-black leg chitin, sRGB (about 1% linear albedo). */
export const ARACHNID_COLOR: Rgb = [0.12, 0.1, 0.085]
/** The body is a shade lighter and warmer than the legs; the joint rings paler again (shares of the leg colour). */
const BODY_TONE: Rgb = [1.15, 1.1, 1.05]
const RING_TONE: Rgb = [2.6, 2.5, 2.3]

/** The look for a settings object. */
export const arachnidLook = (s: ArachnidSettings): ArachnidLook => ({
  size: arachnidScale(s), hips: s.hips, legRadius: s.legRadius, sheen: s.sheen,
  color: ARACHNID_COLOR.map(c => Math.min(1, c * s.shell)) as unknown as Rgb,
})

const SIDES = 8
/** A ring along a segment: share of its length, radius as a share of the hip radius, and how pale (0–1). */
type Ring = readonly [t: number, radius: number, pale: number]
/** Femur (coxa and trochanter, then the femur into the knee), patella and tibia, then the tarsus. */
const PROFILE: readonly (readonly Ring[])[] = [
  [[0, 1.3, 0], [0.05, 1.32, 0], [0.085, 0.95, 0.6], [0.11, 1.02, 0], [0.84, 0.8, 0], [0.95, 0.87, 0], [1, 0.85, 0.45]],
  [[0, 0.85, 0.45], [0.09, 0.82, 0], [0.135, 0.66, 0.7], [0.165, 0.74, 0], [0.92, 0.5, 0], [1, 0.54, 0.4]],
  [[0, 0.46, 0.4], [0.08, 0.4, 0], [0.25, 0.33, 0], [0.5, 0.26, 0], [0.75, 0.2, 0], [0.9, 0.15, 0], [1, 0.11, 0]],
]
/** The tarsus bows inward and down by this share of its length, so it leaves the ankle steep and lands shallow. */
const CURL = 0.1
/** Knee and ankle fill the bend just proud of the segments: a swelling, not a ball. */
const KNEE = 0.9
const ANKLE = 0.57

const mix = (a: Rgb, k: Rgb, t: number): Rgb => [a[0] * (1 + (k[0] - 1) * t), a[1] * (1 + (k[1] - 1) * t), a[2] * (1 + (k[2] - 1) * t)].map(v => Math.min(1, v)) as unknown as Rgb

/**
 * A tube down model −y from the origin (rig `limb`), its rings at `profile`, its centreline bowed toward −x by
 * `bow` × length (a parabola, so both ends stay on the joint points).
 */
function tube(m: Mesh, length: number, radius: number, profile: readonly Ring[], color: Rgb, sheen: number, bow = 0): void {
  const ring = (t: number, r: number, k: number, slope: number): [number[], number[]] => {
    const cx = -bow * length * 4 * t * (1 - t), dcx = -bow * length * 4 * (1 - 2 * t)
    // Tangent (dcx, −length) in the x–y plane; the ring's in-plane axis is its perpendicular.
    const tl = Math.hypot(dcx, length), px = length / tl, py = dcx / tl
    const a = (k / SIDES) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a)
    const out = [px * c, py * c, s]
    // The taper tilts the normal up the limb (toward the origin) by its slope.
    return [[cx + out[0]! * r, -t * length + out[1]! * r, out[2]! * r], norm([out[0]! - (dcx / tl) * slope, out[1]! + (length / tl) * slope, out[2]!])]
  }
  const rings: Ring[] = []
  // A bowed tube needs rings between the profile's for a smooth curve.
  for (let i = 0; i < profile.length; i++) {
    rings.push(profile[i]!)
    const next = profile[i + 1]
    if (bow && next) for (let j = 1; j < 3; j++) {
      const u = j / 3
      rings.push([profile[i]![0] + (next[0] - profile[i]![0]) * u, profile[i]![1] + (next[1] - profile[i]![1]) * u, 0])
    }
  }
  for (let i = 0; i + 1 < rings.length; i++) {
    const [t0, k0, p0] = rings[i]!, [t1, k1, p1] = rings[i + 1]!
    const r0 = k0 * radius, r1 = k1 * radius
    const slope = (r0 - r1) / Math.max(1e-6, (t1 - t0) * length)
    const c0 = mix(color, RING_TONE, p0), c1 = mix(color, RING_TONE, p1)
    for (let k = 0; k < SIDES; k++) {
      const [a0, na0] = ring(t0, r0, k, slope), [a1, na1] = ring(t0, r0, k + 1, slope)
      const [b0, nb0] = ring(t1, r1, k, slope), [b1, nb1] = ring(t1, r1, k + 1, slope)
      // Counter-clockwise seen from outside.
      m.vert(a0, na0, c0, MAT.chitin, sheen); m.vert(a1, na1, c0, MAT.chitin, sheen); m.vert(b1, nb1, c1, MAT.chitin, sheen)
      m.vert(a0, na0, c0, MAT.chitin, sheen); m.vert(b1, nb1, c1, MAT.chitin, sheen); m.vert(b0, nb0, c1, MAT.chitin, sheen)
    }
  }
}

/**
 * Ellipsoid centred at (cx, cy) with semi-axes (rx along +x, ry, rz), smooth normals, outward winding. `taper` widens
 * the rear (−x) and narrows the front; `belly` flattens the underside (share of ry kept below the middle).
 */
function ellipsoid(m: Mesh, cx: number, cy: number, rx: number, ry: number, rz: number, color: Rgb, sheen: number, lat = 8, lon = 14, taper = 0, belly = 1): void {
  const point = (i: number, j: number): [number[], number[]] => {
    const t = (i / lat) * Math.PI, p = (j / lon) * Math.PI * 2
    const x = Math.cos(t), y = Math.sin(t) * Math.cos(p), z = Math.sin(t) * Math.sin(p)
    const w = 1 - taper * x, h = y < 0 ? belly : 1
    return [[cx + x * rx, cy + y * ry * h, z * rz * w], norm([x / rx, y / (ry * h), z / (rz * w)])]
  }
  for (let i = 0; i < lat; i++) for (let j = 0; j < lon; j++) {
    const [a, na] = point(i, j), [b, nb] = point(i + 1, j), [c, nc] = point(i + 1, j + 1), [d, nd] = point(i, j + 1)
    m.vert(a, na, color, MAT.chitin, sheen); m.vert(b, nb, color, MAT.chitin, sheen); m.vert(c, nc, color, MAT.chitin, sheen)
    m.vert(a, na, color, MAT.chitin, sheen); m.vert(c, nc, color, MAT.chitin, sheen); m.vert(d, nd, color, MAT.chitin, sheen)
  }
}

const unit = (v: V3, fallback: V3): V3 => (len(v) > 1e-6 ? norm(v) : fallback)

export class ArachnidView {
  private fp = new FrameParts()
  private segments: number[] = []
  private knuckles: number[] = []
  private body = -1
  private look: ArachnidLook | null = null

  constructor(private readonly renderer: Renderer, look: ArachnidLook) {
    this.setShape(look)
  }

  /** Rebuilds the models for a new size, hip shrink, leg radius, colour or sheen (in place, same model ids). */
  setShape(look: ArachnidLook): void {
    const old = this.look
    if (old && old.size === look.size && old.hips === look.hips && old.legRadius === look.legRadius && old.sheen === look.sheen && old.color.every((c, i) => c === look.color[i])) return
    this.look = { ...look, color: [...look.color] as unknown as Rgb }
    const put = (slot: number, mesh: Mesh) => {
      if (slot < 0) return this.renderer.addModel(mesh)
      this.renderer.setModel(slot, mesh)
      return slot
    }
    const r = look.legRadius, sheen = look.sheen
    for (let pair = 0; pair < 4; pair++) for (let seg = 0; seg < 3; seg++) {
      const m = new Mesh()
      // The tarsus runs on past the foot point by the foot's radius, so its tip touches the ground.
      const length = legLengths(pair)[seg]! + (seg === 2 ? ARACHNID_FOOT : 0)
      tube(m, length * look.size, r, PROFILE[seg]!, look.color, sheen, seg === 2 ? CURL : 0)
      const k = pair * 3 + seg
      this.segments[k] = put(this.segments[k] ?? -1, m)
    }
    for (let j = 0; j < 2; j++) {
      const m = new Mesh()
      const kr = r * (j === 0 ? KNEE : ANKLE)
      ellipsoid(m, 0, 0, kr, kr, kr, look.color, sheen, 6, 10)
      this.knuckles[j] = put(this.knuckles[j] ?? -1, m)
    }
    // One fused oval, wider behind and flatter beneath, round the hip ring (the model origin); the eye turret sits
    // on top over the front legs.
    const b = look.size * look.hips
    const body = new Mesh()
    const tone = mix(look.color, BODY_TONE, 1)
    ellipsoid(body, -0.05 * b, 0.01 * b, 0.25 * b, 0.1 * b, 0.165 * b, tone, sheen, 10, 18, 0.14, 0.7)
    ellipsoid(body, 0.13 * b, 0.105 * b, 0.032 * b, 0.03 * b, 0.026 * b, tone, sheen, 5, 8)
    this.body = put(this.body, body)
  }

  /** Batches for one pose (`reactive` keeps it out of TAA history, so a moving thin leg smears rather than ghosts). */
  frame(poses: readonly ArachnidPose[], tint: Rgb = [1, 1, 1]): Batch[] {
    this.fp.begin()
    for (const pose of poses) this.pose(pose, tint)
    return this.fp.batches().map(b => ({ ...b, reactive: true }))
  }

  private pose(p: ArachnidPose, tint: Rgb): void {
    const push = this.fp.push
    const forward = unit(sub(arachnidLocal(p, [1, 0, 0]), p.body), [1, 0, 0])
    const up = unit(sub(arachnidLocal(p, [0, 1, 0]), p.body), [0, 1, 0])
    const side = cross(forward, up)
    emit(push, this.body, { p: p.body, x: forward, y: up, z: side }, tint, 0)
    for (let i = 0; i < 8; i++) {
      const j = p.legs[i]!.joints
      const pair = i % 4
      // Bend plane: the segment's model +x stays in the leg's plane, so tubes don't spin between frames.
      const plane = cross(sub(j[2], j[0]), sub(j[1], j[0]))
      for (let seg = 0; seg < 2; seg++) {
        const dir = sub(j[seg + 1]!, j[seg]!)
        // limb() expects a unit reference (it drops one shorter than 0.25); raw, this cross scales with size³.
        emit(push, this.segments[pair * 3 + seg]!, limb(j[seg]!, j[seg + 1]!, unit(cross(plane, dir), [0, 1, 0]), [0, 1, 0]), tint, 0)
      }
      // The tarsus's +x points away from the body, so its bow (−x) falls inward and down under the ankle.
      const out = unit([j[3][0] - j[0][0], 0, j[3][2] - j[0][2]], forward)
      emit(push, this.segments[pair * 3 + 2]!, limb(j[2], j[3], out, [0, 1, 0]), tint, 0)
      emit(push, this.knuckles[0]!, { p: j[1], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }, tint, 0)
      emit(push, this.knuckles[1]!, { p: j[2], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }, tint, 0)
    }
  }
}
