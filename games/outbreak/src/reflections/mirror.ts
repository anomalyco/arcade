import { MAT, Mesh, type Mat, type Rgb } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, type Batch, type Renderer } from "@arcade/kit/gpu/renderer"
import type { Town } from "../../shared/map"
import { supportHeight } from "../../shared/terrain"
import { collectMirrors, MIRROR_H, MIRROR_LEAN, MIRROR_W, type MirrorSpot } from "../interiors/mesh"
import { interiorSignature } from "../interiors/plan"
import { MAT_MIRROR, MIRROR_FRAME, MIRROR_GLASS_FOOT, MIRROR_GLASS_HEAD, MIRROR_TOP_OUT } from "./wgsl"

const rgb = (v: number): Rgb => [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
type V3 = [number, number, number]

const WALNUT = rgb(0x2a170c)
const WALNUT_TOP = rgb(0x3a2414)
const GILT = rgb(0x8a6a2a)

/**
 * A leaning floor mirror in model space: the wall face at z 0, the room toward +z, the floor at y 0. The frame's foot
 * stands `MIRROR_LEAN` out from the wall and its top rests `MIRROR_TOP_OUT` off it, so the glass tips back toward the
 * camera above. Carved walnut with a gilt bead and a small crest; the glass is `MAT_MIRROR`, its vertex colour the glass
 * uv (corners only, so the gamma the vertex stage applies leaves it linear) and aux 1 when the plate is cracked.
 */
export function mirrorModel(cracked: boolean): Mesh {
  const m = new Mesh()
  const run = MIRROR_LEAN - MIRROR_TOP_OUT
  const len = MIRROR_H
  const rise = Math.sqrt(len * len - run * run)
  const t: V3 = [0, rise / len, -run / len]
  const n: V3 = [0, run / len, rise / len]
  const at = (u: number, s: number, d: number): number[] => [u, s * t[1] + d * n[1], MIRROR_LEAN + s * t[2] + d * n[2]]
  const face = (a: number[], b: number[], c: number[], d: number[], out: V3, col: Rgb, mat: Mat) => {
    const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!, uz = b[2]! - a[2]!
    const wx = c[0]! - a[0]!, wy = c[1]! - a[1]!, wz = c[2]! - a[2]!
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx
    if (nx * out[0] + ny * out[1] + nz * out[2] >= 0) m.quadAuto(a, b, c, d, col, mat)
    else m.quadAuto(a, d, c, b, col, mat)
  }
  // A box in the frame's own axes (u across, s up the slant, d out of the glass), all faces but the back.
  const slab = (u0: number, u1: number, s0: number, s1: number, d0: number, d1: number, col: Rgb, top: Rgb, mat: Mat) => {
    face(at(u0, s0, d1), at(u1, s0, d1), at(u1, s1, d1), at(u0, s1, d1), n, top, mat)
    face(at(u0, s0, d0), at(u0, s1, d0), at(u0, s1, d1), at(u0, s0, d1), [-1, 0, 0], col, mat)
    face(at(u1, s0, d0), at(u1, s0, d1), at(u1, s1, d1), at(u1, s1, d0), [1, 0, 0], col, mat)
    face(at(u0, s1, d0), at(u1, s1, d0), at(u1, s1, d1), at(u0, s1, d1), t, top, mat)
    face(at(u0, s0, d0), at(u0, s0, d1), at(u1, s0, d1), at(u1, s0, d0), [-t[0], -t[1], -t[2]], col, mat)
  }
  const w = MIRROR_W / 2
  const fw = MIRROR_FRAME
  const foot = MIRROR_GLASS_FOOT
  const head = len - MIRROR_GLASS_HEAD
  slab(-w, -w + fw, 0, len, 0, 0.045, WALNUT, WALNUT_TOP, MAT.timber)
  slab(w - fw, w, 0, len, 0, 0.045, WALNUT, WALNUT_TOP, MAT.timber)
  slab(-w + fw, w - fw, 0, foot, 0, 0.045, WALNUT, WALNUT_TOP, MAT.timber)
  slab(-w + fw, w - fw, head, len, 0, 0.045, WALNUT, WALNUT_TOP, MAT.timber)
  // Crest over the top rail and a gilt bead round the glass, a hair proud of the frame.
  slab(-w * 0.55, w * 0.55, len - 0.01, len + 0.07, 0.005, 0.04, WALNUT, WALNUT_TOP, MAT.timber)
  const bead = 0.012
  slab(-w + fw - bead, -w + fw, foot - bead, head + bead, 0.045, 0.052, GILT, GILT, MAT.shiny)
  slab(w - fw, w - fw + bead, foot - bead, head + bead, 0.045, 0.052, GILT, GILT, MAT.shiny)
  slab(-w + fw, w - fw, foot - bead, foot, 0.045, 0.052, GILT, GILT, MAT.shiny)
  slab(-w + fw, w - fw, head, head + bead, 0.045, 0.052, GILT, GILT, MAT.shiny)
  // The glass, set back in the frame.
  const aux = cracked ? 1 : 0
  const glass = MAT_MIRROR as Mat
  const g = (u: number, v: number) => at(-w + fw + u * (MIRROR_W - 2 * fw), foot + v * (head - foot), 0.02)
  const c = (u: number, v: number): Rgb => [u, v, 0]
  m.vert(g(0, 0), n, c(0, 0), glass, aux)
  m.vert(g(1, 0), n, c(1, 0), glass, aux)
  m.vert(g(1, 1), n, c(1, 1), glass, aux)
  m.vert(g(0, 0), n, c(0, 0), glass, aux)
  m.vert(g(1, 1), n, c(1, 1), glass, aux)
  m.vert(g(0, 1), n, c(0, 1), glass, aux)
  return m
}

/** Max mirrors drawn at once (a few houses' worth on screen). */
const MAX_MIRRORS = 8

/**
 * Draws the houses' mirrors (`collectMirrors`) as two instanced models, intact and cracked, and only the ones the
 * camera's ground rect reaches. `shown` 1 keeps the start house's alone.
 */
export class MirrorPresenter {
  private models: { intact: number; cracked: number } | null = null
  private spots: MirrorSpot[] = []
  private key = ""
  private buildingsRef: unknown = null
  private readonly intact = new Float32Array(MAX_MIRRORS * INST_FLOATS)
  private readonly cracked = new Float32Array(MAX_MIRRORS * INST_FLOATS)
  private readonly batches: Batch[] = []
  /** Mirrors drawn last frame, for automation. */
  readonly drawn: MirrorSpot[] = []

  constructor(private readonly renderer: Pick<Renderer, "addModel">) {}

  /** Every mirror in the town, recomputed when its buildings or the interior settings change. */
  mirrors(town: Town): readonly MirrorSpot[] {
    const key = `${town.seed}:${town.houseSeed}:${town.buildings.length}:${interiorSignature()}`
    if (key !== this.key || town.buildings !== this.buildingsRef) {
      this.key = key
      this.buildingsRef = town.buildings
      this.spots = collectMirrors(town)
    }
    return this.spots
  }

  collect(town: Town, rect: readonly [number, number, number, number], shown: number): readonly Batch[] {
    this.drawn.length = 0
    if (shown <= 0) return []
    this.models ??= { intact: this.renderer.addModel(mirrorModel(false)), cracked: this.renderer.addModel(mirrorModel(true)) }
    let ni = 0
    let nc = 0
    for (const s of this.mirrors(town)) {
      if (shown < 2 && !s.start) continue
      if (s.x < rect[0] - 1 || s.x > rect[2] + 1 || s.z < rect[1] - 2 || s.z > rect[3] + 1) continue
      const data = s.cracked ? this.cracked : this.intact
      const k = s.cracked ? nc : ni
      if (k >= MAX_MIRRORS) continue
      const o = k * INST_FLOATS
      data[o] = s.x
      data[o + 1] = supportHeight(town, s.x, s.z + MIRROR_LEAN)
      data[o + 2] = s.z
      data[o + 3] = 0
      data[o + 4] = 1
      data[o + 5] = 1
      data[o + 6] = 1
      data[o + 7] = 1
      data[o + 8] = 0
      data[o + 9] = 0
      data[o + 10] = 1
      data[o + 11] = 0
      if (s.cracked) nc++
      else ni++
      this.drawn.push(s)
    }
    this.batches.length = 0
    if (ni) this.batches.push({ model: this.models.intact, data: this.intact, count: ni })
    if (nc) this.batches.push({ model: this.models.cracked, data: this.cracked, count: nc })
    return this.batches
  }
}
