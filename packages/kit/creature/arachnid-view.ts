/**
 * Draws an `ArachnidPose` with the shared renderer's instanced models: smooth tapered tubes for the leg segments with
 * a small knuckle at each joint, and an ellipsoid cephalothorax and abdomen. Everything is matte (`MAT.lit`, diffuse
 * only): lamplight found GGX on chitin read as plastic. Tubes wind counter-clockwise seen from outside, so their
 * normals face out (lamplight's first pass had them inverted).
 *
 * Models are built in metres for one shape (size, hip shrink, leg radius); `setShape` rebuilds them in place.
 */
import { FrameParts } from "../gpu/frame-parts"
import { MAT, Mesh, type Rgb } from "../gpu/mesh"
import type { Batch, Renderer } from "../gpu/renderer"
import { aimFrame, cross, emit, len, limb, norm, sub, type Frame, type V3 } from "../rig"
import { ARACHNID_FOOT, arachnidLocal, legLengths, type ArachnidPose } from "./arachnid-legs"

export type ArachnidLook = {
  /** Metres per creature unit (the legs' scale) and body/hip shrink (`ArachnidShape.hips`). */
  size: number
  hips: number
  /** Femur radius at the hip, metres; the tibia and tarsus taper from it. */
  legRadius: number
  color: Rgb
}

/** Dark, slightly warm chitin. */
export const ARACHNID_COLOR: Rgb = [0.085, 0.07, 0.055]
const SIDES = 7
/** Radius at each joint as a share of the hip radius: hip, knee, ankle, foot. */
const TAPER = [1, 0.78, 0.5, 0.18]

function tube(m: Mesh, length: number, r0: number, r1: number, color: Rgb): void {
  // Model −y runs down the limb from the origin (rig `limb`). Slope term tilts normals for the taper.
  const slope = (r0 - r1) / Math.max(1e-6, length)
  const ring = (y: number, r: number, k: number): [number[], number[]] => {
    const a = (k / SIDES) * Math.PI * 2
    const c = Math.cos(a), s = Math.sin(a)
    const n = norm([c, slope, s])
    return [[c * r, y, s * r], n]
  }
  for (let k = 0; k < SIDES; k++) {
    const [a0, na0] = ring(0, r0, k), [a1, na1] = ring(0, r0, k + 1)
    const [b0, nb0] = ring(-length, r1, k), [b1, nb1] = ring(-length, r1, k + 1)
    // Counter-clockwise seen from outside.
    m.vert(a0, na0, color, MAT.lit); m.vert(a1, na1, color, MAT.lit); m.vert(b1, nb1, color, MAT.lit)
    m.vert(a0, na0, color, MAT.lit); m.vert(b1, nb1, color, MAT.lit); m.vert(b0, nb0, color, MAT.lit)
  }
}

/** Ellipsoid with semi-axes (rx along +x, ry, rz), smooth normals, outward winding. */
function ellipsoid(m: Mesh, cx: number, rx: number, ry: number, rz: number, color: Rgb, lat = 6, lon = 10): void {
  const point = (i: number, j: number): [number[], number[]] => {
    const t = (i / lat) * Math.PI, p = (j / lon) * Math.PI * 2
    const x = Math.cos(t), y = Math.sin(t) * Math.cos(p), z = Math.sin(t) * Math.sin(p)
    return [[cx + x * rx, y * ry, z * rz], norm([x / rx, y / ry, z / rz])]
  }
  for (let i = 0; i < lat; i++) for (let j = 0; j < lon; j++) {
    const [a, na] = point(i, j), [b, nb] = point(i + 1, j), [c, nc] = point(i + 1, j + 1), [d, nd] = point(i, j + 1)
    m.vert(a, na, color, MAT.lit); m.vert(b, nb, color, MAT.lit); m.vert(c, nc, color, MAT.lit)
    m.vert(a, na, color, MAT.lit); m.vert(c, nc, color, MAT.lit); m.vert(d, nd, color, MAT.lit)
  }
}

const unit = (v: V3, fallback: V3): V3 => (len(v) > 1e-6 ? norm(v) : fallback)

export class ArachnidView {
  private fp = new FrameParts()
  private segments: number[] = []
  private knuckles: number[] = []
  private head = -1
  private abdomen = -1
  private look: ArachnidLook | null = null

  constructor(private readonly renderer: Renderer, look: ArachnidLook) {
    this.setShape(look)
  }

  /** Rebuilds the models for a new size, hip shrink, leg radius or colour (in place, same model ids). */
  setShape(look: ArachnidLook): void {
    const old = this.look
    if (old && old.size === look.size && old.hips === look.hips && old.legRadius === look.legRadius && old.color.every((c, i) => c === look.color[i])) return
    this.look = { ...look, color: [...look.color] as unknown as Rgb }
    const put = (slot: number, mesh: Mesh) => {
      if (slot < 0) return this.renderer.addModel(mesh)
      this.renderer.setModel(slot, mesh)
      return slot
    }
    const r = look.legRadius
    for (let pair = 0; pair < 4; pair++) for (let seg = 0; seg < 3; seg++) {
      const m = new Mesh()
      // The tarsus runs on past the foot point by the foot's radius, so its tip touches the ground.
      const length = legLengths(pair)[seg]! + (seg === 2 ? ARACHNID_FOOT : 0)
      tube(m, length * look.size, r * TAPER[seg]!, r * TAPER[seg + 1]!, look.color)
      const k = pair * 3 + seg
      this.segments[k] = put(this.segments[k] ?? -1, m)
    }
    for (let j = 0; j < 2; j++) {
      const m = new Mesh()
      const kr = r * TAPER[j + 1]! * 1.12
      ellipsoid(m, 0, kr, kr, kr, look.color, 4, 6)
      this.knuckles[j] = put(this.knuckles[j] ?? -1, m)
    }
    const b = look.size * look.hips
    const head = new Mesh()
    ellipsoid(head, 0.1 * b, 0.13 * b, 0.07 * b, 0.11 * b, look.color)
    this.head = put(this.head, head)
    // Hangs back from the pedicel (the model origin), so the abdomen pitches about its waist.
    const abdomen = new Mesh()
    ellipsoid(abdomen, -0.17 * b, 0.17 * b, 0.12 * b, 0.13 * b, look.color)
    this.abdomen = put(this.abdomen, abdomen)
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
    const body: Frame = aimFrame(p.body, forward, up)
    emit(push, this.head, body, tint, 0)
    const waist = arachnidLocal(p, [-0.03 * p.hips, 0.005 * p.hips, 0])
    const c = Math.cos(p.abdomenPitch), s = Math.sin(p.abdomenPitch)
    const aForward: V3 = [body.x[0] * c + body.y[0] * s, body.x[1] * c + body.y[1] * s, body.x[2] * c + body.y[2] * s]
    emit(push, this.abdomen, aimFrame(waist, aForward, body.y), tint, 0)
    for (let i = 0; i < 8; i++) {
      const j = p.legs[i]!.joints
      const pair = i % 4
      // Bend plane: the segment's model +x stays in the leg's plane, so tubes don't spin between frames.
      const plane = cross(sub(j[2], j[0]), sub(j[1], j[0]))
      for (let seg = 0; seg < 3; seg++) {
        const dir = sub(j[seg + 1]!, j[seg]!)
        // limb() expects a unit reference (it drops one shorter than 0.25); raw, this cross scales with size³.
        emit(push, this.segments[pair * 3 + seg]!, limb(j[seg]!, j[seg + 1]!, unit(cross(plane, dir), [0, 1, 0]), [0, 1, 0]), tint, 0)
      }
      emit(push, this.knuckles[0]!, { p: j[1], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }, tint, 0)
      emit(push, this.knuckles[1]!, { p: j[2], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }, tint, 0)
    }
  }
}
