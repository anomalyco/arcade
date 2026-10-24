// The lumberjack's first-person saw, drawn in the world in front of the eye (the forest's lights and beams light it
// like anything else). A worn two-stroke saw: dark crankcase and handles under an orange cover scuffed pale at the
// edges, a starter cover with its pull grip, a sooty muffler, the chain brake guard and wrap handle, the clutch cover
// and a bar whose chain runs while it revs (two moving parts, the top run to the nose and the bottom back). The arms
// on it are the lumberjack's Rocketbox person (`TimberPeople.arms`), with gloves here for while it loads.
//
// Modelled in a saw frame (x along the bar, y up, z right, the rear grip at the origin), then placed in eye space
// (x forward, y up, z right, the eye at the origin); one part per frame at the eye with its yaw, pitch and roll.
import type { FrameParts } from "@arcade/kit/gpu/frame-parts"
import { FLOATS_PER_VERT, MAT, type Mat, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"

type V3 = [number, number, number]

const ORANGE: Rgb = [0.5, 0.14, 0.022]
const ORANGE_WORN: Rgb = [0.6, 0.33, 0.16]
const DARK: Rgb = [0.032, 0.031, 0.033]
const DARK_WORN: Rgb = [0.12, 0.115, 0.11]
const GREY: Rgb = [0.18, 0.18, 0.19]
const STEEL: Rgb = [0.5, 0.52, 0.55]
const BAR: Rgb = [0.1, 0.1, 0.11]
const CHAIN: Rgb = [0.2, 0.2, 0.22]
const CUTTER: Rgb = [0.62, 0.63, 0.66]
const SOOT: Rgb = [0.035, 0.028, 0.024]
const DECAL: Rgb = [0.46, 0.42, 0.32]
const GLOVE: Rgb = [0.26, 0.17, 0.09]
const PLAID_B: Rgb = [0.05, 0.03, 0.03]

/** The saw frame in eye space: the rear grip's place, and the saw turned in (yaw), nose down (pitch), canted (roll). */
// Canted hard over (its top to the left), so the bar and its chain run out to the right of the guard and your left
// hand rather than behind them.
const AT: V3 = [0.34, -0.28, 0.2]
const TURN = { yaw: -0.08, pitch: 0.12, roll: -0.7 }
/** Points on the saw, saw frame: where the hands close, the muffler's outlet and its way out, the bar's nose. */
const GRIP_R: V3 = [0.005, 0, 0]
const GRIP_L: V3 = [0.343, 0.153, -0.075]
const EXHAUST: V3 = [0.405, -0.115, -0.12]
const EXHAUST_DIR: V3 = [0.55, 0.15, -0.82]
const NOSE: V3 = [0.83, -0.105, 0]
/** The chain: its runs along the bar's top and bottom edges, and the repeat of its cutters (m). */
const RUN_X0 = 0.36
const RUN_X1 = 0.8
const LINK = 0.02
const REPEAT = LINK * 2

/** Rotates `p` as the part shader does: pitch about z (positive lifts +x), roll about x, then yaw about y. */
export function turn(p: readonly number[], yaw: number, pitch: number, roll: number): V3 {
  const cp = Math.cos(pitch), sp = Math.sin(pitch)
  const x = p[0]! * cp - p[1]! * sp
  let y = p[0]! * sp + p[1]! * cp
  let z = p[2]!
  const cr = Math.cos(roll), sr = Math.sin(roll)
  const y2 = y * cr - z * sr
  z = y * sr + z * cr
  y = y2
  const c = Math.cos(yaw), s = Math.sin(yaw)
  return [x * c - z * s, y, x * s + z * c]
}

/** Saw frame to eye space. */
const toEye = (p: readonly number[]): V3 => {
  const q = turn(p, TURN.yaw, TURN.pitch, TURN.roll)
  return [q[0] + AT[0], q[1] + AT[1], q[2] + AT[2]]
}

const unit = (v: readonly number[]): V3 => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1
  return [v[0]! / l, v[1]! / l, v[2]! / l]
}
const dirToEye = (v: readonly number[]) => unit(turn(v, TURN.yaw, TURN.pitch, TURN.roll))

/** A hand on a handle, eye space: where it closes, the way its knuckles point (wrist to knuckles) and its palm faces. */
export type SawHand = { p: V3; dir: V3; palm: V3 }

/**
 * Where the hands close on the saw: the left over the top of the wrap handle, palm down and knuckles forward; the right
 * round the rear grip from above and outside, knuckles in to the left.
 */
export const SAW_HANDS: { l: SawHand; r: SawHand } = {
  l: { p: toEye(GRIP_L), dir: dirToEye([0.85, -0.35, 0.25]), palm: dirToEye([0.3, -1, 0]) },
  r: { p: toEye(GRIP_R), dir: dirToEye([0.8, -0.15, -0.5]), palm: dirToEye([0, -0.7, -0.7]) },
}

const hash = (x: number, y: number, z: number) => {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453
  return h - Math.floor(h)
}

/** A builder over one mesh: convex faces turned outwards, worn plastic mottled face by face. */
class Saw {
  constructor(readonly m: Mesh) {}

  /** One convex face, its points in order either way round, facing away from `centre`. */
  face(pts: number[][], col: Rgb, mat: Mat, centre: readonly number[], mottle = 0.07): void {
    let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!, b = pts[(i + 1) % pts.length]!
      nx += (a[1]! - b[1]!) * (a[2]! + b[2]!)
      ny += (a[2]! - b[2]!) * (a[0]! + b[0]!)
      nz += (a[0]! - b[0]!) * (a[1]! + b[1]!)
      cx += a[0]! / pts.length
      cy += a[1]! / pts.length
      cz += a[2]! / pts.length
    }
    const out = nx * (cx - centre[0]!) + ny * (cy - centre[1]!) + nz * (cz - centre[2]!)
    const p = out < 0 ? [...pts].reverse() : pts
    const k = 1 + (hash(cx, cy, cz) - 0.5) * 2 * mottle
    const c: Rgb = [col[0] * k, col[1] * k, col[2] * k]
    for (let i = 1; i + 1 < p.length; i++) this.m.facet(p[0]!, p[i]!, p[i + 1]!, c, mat)
  }

  /** A box with every edge and corner chamfered by `b`, the chamfers in `edge` (where plastic wears pale). */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col: Rgb, b = 0, edge: Rgb = col, mat: Mat = MAT.lit): void {
    const lo = [x0, y0, z0], hi = [x1, y1, z1]
    const centre = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]
    b = Math.min(b, (x1 - x0) / 2.2, (y1 - y0) / 2.2, (z1 - z0) / 2.2)
    /** A point: on the face of axis `a` (side `s`), inset by b on the others where `ins`. */
    const pt = (sx: number, sy: number, sz: number, full: number): number[] => {
      const s = [sx, sy, sz]
      return [0, 1, 2].map((i) => (s[i]! > 0 ? hi[i]! - (i === full ? 0 : b) : lo[i]! + (i === full ? 0 : b)))
    }
    for (let a = 0; a < 3; a++) {
      const u = (a + 1) % 3, v = (a + 2) % 3
      for (const s of [-1, 1]) {
        const at = (su: number, sv: number) => {
          const sg = [0, 0, 0]
          sg[a] = s
          sg[u] = su
          sg[v] = sv
          return pt(sg[0]!, sg[1]!, sg[2]!, a)
        }
        this.face([at(1, 1), at(1, -1), at(-1, -1), at(-1, 1)], col, mat, centre)
      }
    }
    if (b <= 0) return
    // Edge strips between faces a and u, along v.
    for (let a = 0; a < 3; a++) {
      const u = (a + 1) % 3, v = (a + 2) % 3
      for (const sa of [-1, 1])
        for (const su of [-1, 1]) {
          const at = (sv: number, full: number) => {
            const sg = [0, 0, 0]
            sg[a] = sa
            sg[u] = su
            sg[v] = sv
            return pt(sg[0]!, sg[1]!, sg[2]!, full)
          }
          this.face([at(1, a), at(-1, a), at(-1, u), at(1, u)], edge, mat, centre, 0.12)
        }
    }
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) this.face([pt(sx, sy, sz, 0), pt(sx, sy, sz, 1), pt(sx, sy, sz, 2)], edge, mat, centre, 0.12)
  }

  /** A hexahedron from its eight corners (bit 0 x, bit 1 y, bit 2 z of the box it stands in for). */
  hexa(c: number[][], col: Rgb, mat: Mat = MAT.lit): void {
    const centre = [0, 1, 2].map((i) => c.reduce((s, p) => s + p[i]!, 0) / 8)
    for (const f of [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]]) this.face(f.map((i) => c[i]!), col, mat, centre)
  }

  /** A drum along z: an n-sided prism round (cx, cy), radius r, from z0 to z1, over angles a0..a1. */
  drum(cx: number, cy: number, r: number, z0: number, z1: number, n: number, col: Rgb, mat: Mat = MAT.lit, a0 = 0, a1 = Math.PI * 2): void {
    const centre = [cx, cy, (z0 + z1) / 2]
    const p = (a: number, z: number) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r, z]
    for (let i = 0; i < n; i++) {
      const a = a0 + ((a1 - a0) * i) / n, b = a0 + ((a1 - a0) * (i + 1)) / n
      this.face([p(a, z0), p(b, z0), p(b, z1), p(a, z1)], col, mat, centre, 0.03)
      this.face([[cx, cy, z1], p(a, z1), p(b, z1)], col, mat, centre, 0.03)
      this.face([[cx, cy, z0], p(a, z0), p(b, z0)], col, mat, centre, 0.03)
    }
  }

  /** A square tube of half-width `w` through points in the (z, y) plane, from x0 to x1. */
  tube(pts: [number, number][], x0: number, x1: number, w: number, col: Rgb, edge: Rgb): void {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [za, ya] = pts[i]!, [zb, yb] = pts[i + 1]!
      const l = Math.hypot(zb - za, yb - ya) || 1
      const nz = (-(yb - ya) / l) * w, ny = ((zb - za) / l) * w
      const c = (x: number, s: number, end: 0 | 1) => (end === 0 ? [x, ya + ny * s, za + nz * s] : [x, yb + ny * s, zb + nz * s])
      this.hexa([c(x0, -1, 0), c(x1, -1, 0), c(x0, 1, 0), c(x1, 1, 0), c(x0, -1, 1), c(x1, -1, 1), c(x0, 1, 1), c(x1, 1, 1)], i % 2 ? col : edge)
    }
  }
}

/** Moves every vertex of `m` (and its normal) from the saw frame into eye space. */
function place(m: Mesh): Mesh {
  for (let i = 0; i < m.v.length; i += FLOATS_PER_VERT) {
    const p = toEye([m.v[i]!, m.v[i + 1]!, m.v[i + 2]!])
    const n = turn([m.v[i + 3]!, m.v[i + 4]!, m.v[i + 5]!], TURN.yaw, TURN.pitch, TURN.roll)
    m.v[i] = p[0]
    m.v[i + 1] = p[1]
    m.v[i + 2] = p[2]
    m.v[i + 3] = n[0]
    m.v[i + 4] = n[1]
    m.v[i + 5] = n[2]
  }
  return m
}

/** The saw without its moving chain. */
export function sawViewMesh(): Mesh {
  const s = new Saw(new Mesh())
  // Rear handle: the grip, its post and lower rail, the trigger under it and the lockout on top, the guard below.
  s.box(-0.065, -0.017, -0.016, 0.08, 0.018, 0.016, DARK, 0.007, DARK_WORN)
  s.box(-0.097, -0.13, -0.017, -0.06, 0.012, 0.017, DARK, 0.007, DARK_WORN)
  s.box(-0.097, -0.14, -0.02, 0.13, -0.105, 0.02, DARK, 0.007, DARK_WORN)
  s.box(-0.09, -0.146, 0, 0.07, -0.132, 0.065, DARK, 0.004, DARK_WORN)
  s.box(0.0, -0.042, -0.007, 0.036, -0.016, 0.007, ORANGE, 0.003, ORANGE_WORN)
  s.box(0.006, 0.016, -0.008, 0.048, 0.027, 0.008, GREY, 0.003)
  s.box(0.07, -0.035, -0.032, 0.125, 0.022, 0.032, DARK, 0.008, DARK_WORN)
  // Engine: dark crankcase under the orange cover, which steps up to the air filter and its knob.
  s.box(0.11, -0.205, -0.18, 0.37, -0.07, -0.005, DARK, 0.012, DARK_WORN)
  s.box(0.1, -0.088, -0.19, 0.37, -0.02, 0.006, ORANGE, 0.016, ORANGE_WORN)
  s.box(0.12, -0.028, -0.176, 0.32, 0.036, -0.012, ORANGE, 0.02, ORANGE_WORN)
  s.box(0.135, 0.028, -0.158, 0.262, 0.056, -0.028, [ORANGE[0] * 0.9, ORANGE[1] * 0.95, ORANGE[2]], 0.012, ORANGE_WORN)
  s.m.prism(0.2, -0.093, 0.018, 0.015, 0.05, 0.072, 8, DARK)
  // Cooling slots down the cover's left side, a worn decal under them, grime and soot towards the muffler.
  for (let i = 0; i < 5; i++) s.box(0.15 + i * 0.03, -0.014, -0.18, 0.164 + i * 0.03, 0.026, -0.172, DARK)
  s.box(0.15, -0.075, -0.194, 0.31, -0.04, -0.188, DECAL, 0.003, [DECAL[0] * 0.8, DECAL[1] * 0.8, DECAL[2] * 0.8])
  for (let i = 0; i < 6; i++) s.box(0.162 + i * 0.023, -0.066, -0.196, 0.178 + i * 0.023, -0.05, -0.192, DARK)
  s.box(0.31, -0.085, -0.192, 0.37, -0.03, -0.186, SOOT)
  s.box(0.33, -0.088, -0.14, 0.372, -0.02, -0.02, SOOT)
  // The starter cover with its ribs and pull grip; the fuel cap behind it.
  s.box(0.14, -0.195, -0.207, 0.345, -0.085, -0.18, DARK, 0.01, DARK_WORN)
  for (let i = 0; i < 5; i++) s.box(0.16, -0.18 + i * 0.019, -0.21, 0.33, -0.172 + i * 0.019, -0.205, GREY)
  s.box(0.24, -0.006, -0.22, 0.33, 0.014, -0.196, DARK, 0.005, DARK_WORN)
  s.box(0.28, -0.01, -0.2, 0.29, 0.0, -0.18, GREY)
  s.drum(0.125, -0.16, 0.024, -0.215, -0.18, 10, DARK)
  s.drum(0.125, -0.16, 0.012, -0.22, -0.214, 6, GREY)
  // The muffler on the front, sooty, its slots facing out to the left.
  s.box(0.365, -0.17, -0.135, 0.405, -0.075, -0.02, [0.09, 0.085, 0.08], 0.006, [0.2, 0.19, 0.18], MAT.shiny)
  for (let i = 0; i < 4; i++) s.box(0.375, -0.155 + i * 0.02, -0.139, 0.398, -0.148 + i * 0.02, -0.134, SOOT)
  // The bucking spikes either side of the bar's root.
  for (const y of [-0.15, -0.09])
    s.hexa([[0.395, y - 0.012, -0.02], [0.43, y - 0.002, -0.02], [0.395, y + 0.012, -0.02], [0.43, y + 0.002, -0.02], [0.395, y - 0.012, -0.008], [0.43, y - 0.002, -0.008], [0.395, y + 0.012, -0.008], [0.43, y + 0.002, -0.008]], STEEL, MAT.shiny)
  // The chain brake's hand guard, raked forward, ahead of the wrap handle.
  s.hexa([[0.37, 0.02, -0.13], [0.382, 0.02, -0.13], [0.39, 0.165, -0.11], [0.402, 0.165, -0.11], [0.37, 0.02, 0.03], [0.382, 0.02, 0.03], [0.39, 0.165, 0.015], [0.402, 0.165, 0.015]], DARK)
  // The wrap handle: up the left side, over the top, down to the right.
  s.tube([[-0.205, -0.16], [-0.216, -0.05], [-0.21, 0.07], [-0.18, 0.13], [-0.11, 0.155], [-0.03, 0.15], [0.02, 0.12], [0.04, 0.06], [0.042, 0.0]], 0.33, 0.356, 0.014, DARK, [0.05, 0.05, 0.052])
  // The clutch cover over the bar's root on the right, its two bar nuts and the tensioner.
  s.box(0.17, -0.185, 0.008, 0.39, -0.048, 0.066, DARK, 0.014, DARK_WORN)
  for (const x of [0.27, 0.325]) s.drum(x, -0.11, 0.012, 0.066, 0.082, 6, STEEL, MAT.shiny)
  s.drum(0.37, -0.15, 0.006, 0.066, 0.072, 6, GREY)
  // The bar: dark plate, polished rails where the chain rides, the nose and its sprocket rivet.
  s.box(0.36, -0.13, -0.004, 0.8, -0.08, 0.004, BAR)
  s.box(0.36, -0.08, -0.0045, 0.8, -0.075, 0.0045, STEEL, 0, STEEL, MAT.shiny)
  s.box(0.36, -0.135, -0.0045, 0.8, -0.13, 0.0045, STEEL, 0, STEEL, MAT.shiny)
  s.drum(0.8, -0.105, 0.03, -0.0045, 0.0045, 10, STEEL, MAT.shiny, -Math.PI / 2, Math.PI / 2)
  s.drum(0.8, -0.105, 0.006, -0.006, 0.006, 6, GREY)
  s.box(0.52, -0.118, -0.0055, 0.66, -0.092, -0.0045, [0.3, 0.29, 0.26])
  // The chain under the moving cutters: a dark strip on both edges and round the nose, where its links stand still.
  s.box(RUN_X0, -0.075, -0.003, RUN_X1, -0.069, 0.003, CHAIN, 0, CHAIN, MAT.shiny)
  s.box(RUN_X0, -0.141, -0.003, RUN_X1, -0.135, 0.003, CHAIN, 0, CHAIN, MAT.shiny)
  for (let i = 0; i <= 6; i++) {
    const a = -Math.PI / 2 + (i / 6) * Math.PI
    const x = 0.8 + Math.cos(a) * 0.035, y = -0.105 + Math.sin(a) * 0.035
    s.box(x - 0.005, y - 0.005, -0.0035, x + 0.005, y + 0.005, 0.0035, i % 2 ? CUTTER : CHAIN, 0, CHAIN, MAT.shiny)
  }
  return place(s.m)
}

/** A run of chain: cutters (alternating sides, polished tops) and the straps between, every `LINK` along x. */
function runMesh(top: boolean): Mesh {
  const s = new Saw(new Mesh())
  const y0 = top ? -0.069 : -0.147
  const n = Math.floor((RUN_X1 - RUN_X0) / LINK) - 1
  for (let i = 0; i < n; i++) {
    const x = RUN_X0 + i * LINK
    if (i % 2 === 0) {
      const side = (i / 2) % 2 === 0 ? -1 : 1
      const zc = side * 0.0015
      s.box(x, y0, zc - 0.0028, x + 0.012, y0 + 0.008, zc + 0.0028, CHAIN, 0, CHAIN, MAT.shiny)
      s.box(x + 0.004, top ? y0 + 0.008 : y0 - 0.002, zc - 0.003, x + 0.012, top ? y0 + 0.011 : y0, zc + 0.003, CUTTER, 0, CUTTER, MAT.shiny)
    } else s.box(x, top ? y0 : y0 + 0.002, -0.0035, x + 0.01, top ? y0 + 0.005 : y0 + 0.006, 0.0035, CHAIN, 0, CHAIN, MAT.shiny)
  }
  return place(s.m)
}

/** The chain's two moving runs: the top towards the nose, the bottom back. */
export function sawChainMeshes(): [Mesh, Mesh] {
  return [runMesh(true), runMesh(false)]
}

/** Gloved fists and plaid cuffs on the handles, drawn while the arms load or with `sawArms` off. */
export function sawGlovesMesh(): Mesh {
  const m = new Mesh({ chamfer: "auto" })
  const glove = (g: V3, back: number) => {
    const [x, y, z] = g
    m.box(x - 0.04, y - 0.03, z - 0.04, x + 0.035, y + 0.035, z + 0.04, GLOVE)
    m.box(x - 0.005, y + 0.015, z - 0.035, x + 0.045, y + 0.042, z + 0.025, GLOVE)
    m.box(x - 0.04 - back, y - 0.06, z - 0.045, x - 0.04, y + 0.02, z + 0.045, PLAID_B)
  }
  glove(GRIP_R, 0.12)
  glove([GRIP_L[0] - 0.01, GRIP_L[1], GRIP_L[2]], 0.1)
  return place(m)
}

export type SawModels = { body: number; top: number; bottom: number; gloves: number }

export type SawPose = {
  /** Eye position (world). */
  eye: readonly number[]
  /** Camera yaw (the game's `camYaw`) and pitch down (rad). */
  yaw: number
  pitch: number
  /** 0 idle .. 1 revving; 0..1 in wood; seconds; the engine running. */
  rev: number
  cut: number
  t: number
  on: boolean
  /** Head bob (m) and the sprint (0..1). */
  bob: number
  sprint: number
  buzz: number
  /** Tint (0..1), against the helmet lamp's glare up close. */
  lit: number
  /** How far the chain has run (m). */
  chain: number
  /** Draw the gloves (the arms aren't on it). */
  gloves: boolean
}

/** The saw's frame this frame (world): eye space maps to `at + turn(q, yaw, pitch, roll)`. */
export type SawFrame = { at: V3; yaw: number; pitch: number; roll: number }

export type SawDrawn = {
  frame: SawFrame
  /** The bar's nose, where chips leave; the muffler's outlet and its way out (world). */
  nose: V3
  exhaust: V3
  exhaustDir: V3
}

export const sawWorld = (f: SawFrame, q: readonly number[]): V3 => {
  const r = turn(q, f.yaw, f.pitch, f.roll)
  return [f.at[0] + r[0], f.at[1] + r[1], f.at[2] + r[2]]
}

/** Draws the first-person saw for this frame. */
export function drawSawView(fp: FrameParts, models: SawModels, p: SawPose): SawDrawn {
  const fx = -Math.sin(p.yaw)
  const fz = -Math.cos(p.yaw)
  // The engine shakes the saw: a fine buzz idling, a harder one revved, a coarse judder in wood.
  const b = p.on ? p.buzz * (0.0025 + p.rev * 0.004 + p.cut * 0.006) : 0
  const jx = Math.sin(p.t * 97) * b + Math.sin(p.t * 61) * b * 0.6
  const jy = Math.sin(p.t * 83 + 1) * b + Math.sin(p.t * 41) * b * 0.5
  // Lowered at a sprint, pushed forward and down into the cut.
  const lower = p.sprint * 0.12 + p.bob * 0.4
  const push = p.cut * 0.08
  const frame: SawFrame = {
    at: [p.eye[0]! + fx * push, p.eye[1]! - lower * 0.3 + jy, p.eye[2]! + fz * push],
    yaw: Math.atan2(fz, fx) + jx * 3,
    pitch: -p.pitch - lower * 0.6 - p.cut * 0.1 + jy * 4,
    roll: jx * 6 + p.sprint * 0.12 * Math.sin(p.t * 7),
  }
  const { at, yaw, pitch, roll } = frame
  // A dimmer tint: it sits half a metre under the helmet lamp, which would otherwise blow it out.
  const tint: V3 = [p.lit, p.lit, p.lit]
  fp.part(models.body, at[0], at[1], at[2], yaw, tint, pitch, roll, 0, 1, 1)
  if (p.gloves) fp.part(models.gloves, at[0], at[1], at[2], yaw, tint, pitch, roll, 0, 1, 1)
  // The chain: each run slides along the bar by how far it has run, wrapping every pair of cutters.
  const off = ((p.chain % REPEAT) + REPEAT) % REPEAT
  const along = turn([1, 0, 0], TURN.yaw, TURN.pitch, TURN.roll)
  for (const [model, d] of [[models.top, off], [models.bottom, REPEAT - off]] as const) {
    const o = sawWorld(frame, [along[0] * d, along[1] * d, along[2] * d])
    fp.part(model, o[0], o[1], o[2], yaw, tint, pitch, roll, 0, 1, 1)
  }
  const out = toEye(EXHAUST)
  const dir = turn(turn(EXHAUST_DIR, TURN.yaw, TURN.pitch, TURN.roll), yaw, pitch, roll)
  return { frame, nose: sawWorld(frame, toEye(NOSE)), exhaust: sawWorld(frame, out), exhaustDir: dir }
}
