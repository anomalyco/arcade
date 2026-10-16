import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { Rng } from "@arcade/kit/sim/rng"
import { inBuildingFootprint, propShape, type Building, type Town } from "../../shared/map"
import { buildingSeed, buildingStreamSlot, interiorSettings, isResidential, planInterior, RUG_Y, rugKey, type InteriorPlan, type InteriorTheme, type RugPlacement } from "./plan"
import { SCONCE_FLOATS, SCONCE_LAMP_SLOT } from "./sconces"
import { MAT_RUG } from "./wgsl"

const rgb = (v: number): Rgb => [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
type Rect = readonly [number, number, number, number]

/**
 * Pushes one rug: a top quad whose vertex colour carries the texture uv (r, g) and orientation (b), and four thin
 * edge faces so the pile has visible thickness from the game camera.
 */
export function emitRug(m: Mesh, p: RugPlacement, key: number): void {
  const [x0, z0, x1, z1] = p.rect
  const y0 = 0.131, y1 = RUG_Y
  const o = p.alongX ? 1 : 0
  // uv per corner: u across the rug, v along it.
  const uv = (x: number, z: number): [number, number] =>
    p.alongX ? [(z - z0) / (z1 - z0), (x - x0) / (x1 - x0)] : [(x - x0) / (x1 - x0), (z - z0) / (z1 - z0)]
  const v = m.v
  const vert = (x: number, y: number, z: number, nx: number, ny: number, nz: number, u: [number, number]) =>
    v.push(x, y, z, nx, ny, nz, u[0], u[1], o, MAT_RUG, key)
  const quad = (a: number[], b: number[], c: number[], d: number[], n: number[]) => {
    const ua = uv(a[0]!, a[2]!), ub = uv(b[0]!, b[2]!), uc = uv(c[0]!, c[2]!), ud = uv(d[0]!, d[2]!)
    vert(a[0]!, a[1]!, a[2]!, n[0]!, n[1]!, n[2]!, ua)
    vert(b[0]!, b[1]!, b[2]!, n[0]!, n[1]!, n[2]!, ub)
    vert(c[0]!, c[1]!, c[2]!, n[0]!, n[1]!, n[2]!, uc)
    vert(a[0]!, a[1]!, a[2]!, n[0]!, n[1]!, n[2]!, ua)
    vert(c[0]!, c[1]!, c[2]!, n[0]!, n[1]!, n[2]!, uc)
    vert(d[0]!, d[1]!, d[2]!, n[0]!, n[1]!, n[2]!, ud)
  }
  quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0])
  // Edges inset slightly so fringes (transparent on top) don't show a solid lip at the short ends.
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1])
  quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1])
  quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0])
  quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0])
}

export function emitBuildingRugs(m: Mesh, b: Building, town: Town, plan: InteriorPlan = planInterior(b, town.houseSeed)): void {
  const slot = buildingStreamSlot(b)
  for (const r of plan.rugs) emitRug(m, r, rugKey(slot, r.idx))
}

type Face = { wall: Rect; axis: "x" | "z"; side: 1 | -1; at: number; a0: number; a1: number; window: boolean }

/** Room-facing wall faces of a building (both sides of partitions, the inside of exterior walls). */
function interiorFaces(b: Building, town: Town): Face[] {
  const [bx0, bz0, bx1, bz1] = b.rect
  const faces: Face[] = []
  for (const w of town.barriers) {
    if (w.kind === "fence") continue
    const [x0, z0, x1, z1] = w.rect
    if (x0 < bx0 - 0.05 || x1 > bx1 + 0.05 || z0 < bz0 - 0.05 || z1 > bz1 + 0.05) continue
    const horizontal = x1 - x0 >= z1 - z0
    for (const side of [-1, 1] as const) {
      if (horizontal) {
        const at = side < 0 ? z0 : z1
        const pz = at + side * 0.3, px = (x0 + x1) / 2
        if (!inBuildingFootprint(b, px, pz)) continue
        faces.push({ wall: w.rect, axis: "x", side, at, a0: x0, a1: x1, window: w.kind === "window" })
      } else {
        const at = side < 0 ? x0 : x1
        const px = at + side * 0.3, pz = (z0 + z1) / 2
        if (!inBuildingFootprint(b, px, pz)) continue
        faces.push({ wall: w.rect, axis: "z", side, at, a0: z0, a1: z1, window: w.kind === "window" })
      }
    }
  }
  return faces
}

/** Free spans along a face, avoiding furniture within 0.8 m of the wall. */
function freeSpans(f: Face, town: Town, b: Building): [number, number][] {
  let spans: [number, number][] = [[f.a0 + 0.15, f.a1 - 0.15]]
  for (const p of town.props) {
    const s = propShape(p)
    if (!s) continue
    const [px0, pz0, px1, pz1] = s.rect
    if (px1 < b.rect[0] || px0 > b.rect[2] || pz1 < b.rect[1] || pz0 > b.rect[3]) continue
    const near = f.axis === "x"
      ? (f.side > 0 ? pz0 < f.at + 0.8 && pz1 > f.at : pz1 > f.at - 0.8 && pz0 < f.at)
      : (f.side > 0 ? px0 < f.at + 0.8 && px1 > f.at : px1 > f.at - 0.8 && px0 < f.at)
    if (!near) continue
    const lo = (f.axis === "x" ? px0 : pz0) - 0.1, hi = (f.axis === "x" ? px1 : pz1) + 0.1
    const next: [number, number][] = []
    for (const [a, c] of spans) {
      if (hi <= a || lo >= c) { next.push([a, c]); continue }
      if (lo > a) next.push([a, lo])
      if (hi < c) next.push([hi, c])
    }
    spans = next
  }
  return spans.filter(([a, c]) => c - a > 0.2)
}

/** Box placed against a face: `a` along the wall, `out` distance from the face, `w` width along, `d` depth out. */
function faceBox(m: Mesh, f: Face, a: number, out: number, w: number, d: number, y0: number, y1: number, col: Rgb, mat: number, top?: Rgb, aux = 0): void {
  const n0 = f.at + f.side * out, n1 = f.at + f.side * (out + d)
  const lo = Math.min(n0, n1), hi = Math.max(n0, n1)
  if (f.axis === "x") m.box(a - w / 2, y0, lo, a + w / 2, y1, hi, col, mat as typeof MAT.lit, aux, top)
  else m.box(lo, y0, a - w / 2, hi, y1, a + w / 2, col, mat as typeof MAT.lit, aux, top)
}

/** Flat quad on a face (facing into the room). */
function faceQuad(m: Mesh, f: Face, a0: number, a1: number, y0: number, y1: number, out: number, col: Rgb, mat: number): void {
  const n = f.at + f.side * out
  if (f.axis === "x") m.quad([a0, y0, n], [a1, y0, n], [a1, y1, n], [a0, y1, n], [0, 0, f.side], col, mat as typeof MAT.lit)
  else m.quad([n, y0, a1], [n, y0, a0], [n, y1, a0], [n, y1, a1], [f.side, 0, 0], col, mat as typeof MAT.lit)
}

const WAINSCOT: Record<InteriorTheme, { panel: number; frame: number; rail: number; mat: number } | null> = {
  plain: null,
  mansion: { panel: 0x2a170c, frame: 0x3a2212, rail: 0x4a2c16, mat: MAT.timber },
  village: { panel: 0x221510, frame: 0x34201a, rail: 0x6a5226, mat: MAT.timber },
  baker: { panel: 0x4a3c2c, frame: 0x5a4a36, rail: 0x3a2c1e, mat: MAT.timber },
  station: { panel: 0x2a4232, frame: 0x34503c, rail: 0x22342a, mat: MAT.lit },
}

function wainscot(m: Mesh, f: Face, theme: InteriorTheme): void {
  const w = WAINSCOT[theme]
  if (!w) return
  const top = f.window ? 0.76 : 0.94
  const len = f.a1 - f.a0
  if (len < 0.25) return
  // Recessed field, then proud stiles and rails, then the chair rail.
  faceQuad(m, f, f.a0, f.a1, 0.26, top - 0.04, 0.012, rgb(w.panel), w.mat)
  const panels = Math.max(1, Math.round(len / 0.62))
  const pw = len / panels
  for (let i = 0; i <= panels; i++) {
    const a = f.a0 + i * pw
    faceQuad(m, f, Math.max(f.a0, a - 0.045), Math.min(f.a1, a + 0.045), 0.26, top - 0.04, 0.02, rgb(w.frame), w.mat)
  }
  faceQuad(m, f, f.a0, f.a1, 0.26, 0.33, 0.02, rgb(w.frame), w.mat)
  faceQuad(m, f, f.a0, f.a1, top - 0.11, top - 0.04, 0.02, rgb(w.frame), w.mat)
  faceBox(m, f, (f.a0 + f.a1) / 2, 0, len, 0.035, top - 0.04, top, rgb(w.rail), w.mat, rgb(w.rail))
}

const PORTRAITS = [0x2a2218, 0x1e2422, 0x2c1c18, 0x1a1c26, 0x30281a]

function painting(m: Mesh, f: Face, a: number, w: number, h: number, yc: number, rng: Rng, gilt: boolean): void {
  const frame = gilt ? rgb(0x8a6a2a) : rgb(0x3a2a1a)
  faceBox(m, f, a, 0, w, 0.05, yc - h / 2, yc + h / 2, frame, gilt ? MAT.shiny : MAT.timber)
  const canvas = rgb(rng.pick(PORTRAITS))
  faceQuad(m, f, a - w / 2 + 0.07, a + w / 2 - 0.07, yc - h / 2 + 0.07, yc + h / 2 - 0.07, 0.052, canvas, MAT.lit)
  if (rng.next() < 0.6) {
    // A dim sitter: shoulders and a pale face (the stare that follows you down the hall).
    faceQuad(m, f, a - w * 0.28, a + w * 0.28, yc - h / 2 + 0.08, yc - h * 0.08, 0.054, rgb(0x14100c), MAT.lit)
    faceBox(m, f, a, 0.054, w * 0.2, 0.004, yc - h * 0.06, yc + h * 0.2, rgb(0x6a5440), MAT.lit)
  } else {
    // Landscape: a dark horizon and a smudge of sky.
    faceQuad(m, f, a - w / 2 + 0.08, a + w / 2 - 0.08, yc, yc + h / 2 - 0.08, 0.054, rgb(0x3a4040), MAT.lit)
  }
}

function grandfatherClock(m: Mesh, f: Face, a: number, theme: InteriorTheme): void {
  const wood = rgb(theme === "baker" ? 0x3c2a1a : 0x2a160c), dark = rgb(0x140a06), brass = rgb(0x9a7a3a)
  faceBox(m, f, a, 0.02, 0.56, 0.36, 0.13, 0.36, wood, MAT.timber)
  faceBox(m, f, a, 0.04, 0.46, 0.3, 0.36, 1.62, wood, MAT.timber)
  faceBox(m, f, a, 0.02, 0.54, 0.36, 1.62, 2.18, wood, MAT.timber)
  faceBox(m, f, a, 0.0, 0.6, 0.4, 2.18, 2.3, wood, MAT.timber)
  // Pendulum window and face.
  faceQuad(m, f, a - 0.13, a + 0.13, 0.62, 1.44, 0.341, dark, MAT.shiny)
  faceBox(m, f, a, 0.336, 0.08, 0.008, 0.82, 0.9, brass, MAT.shiny)
  faceBox(m, f, a, 0.38, 0.38, 0.005, 1.7, 2.08, rgb(0xb8aa88), MAT.lit)
  faceBox(m, f, a, 0.384, 0.04, 0.004, 1.86, 2.0, dark, MAT.lit)
}

function fireplace(m: Mesh, f: Face, a: number, theme: InteriorTheme, lamp: number): void {
  const stone = rgb(theme === "village" ? 0x4a4642 : 0x2a2420), mantel = rgb(theme === "village" ? 0x3a2a1c : 0x1e120a)
  faceBox(m, f, a, 0, 1.7, 0.36, 0.13, 1.12, stone, MAT.brick)
  faceBox(m, f, a, 0, 1.9, 0.44, 1.12, 1.2, mantel, MAT.timber, mantel)
  faceQuad(m, f, a - 0.5, a + 0.5, 0.18, 0.86, 0.361, rgb(0x080605), MAT.lit)
  faceBox(m, f, a, 0.02, 1.5, 0.5, 0.13, 0.16, rgb(0x2a2622), MAT.lit)
  // Embers and andirons.
  faceBox(m, f, a, 0.12, 0.6, 0.12, 0.16, 0.22, rgb(0x6a2a0a), lamp >= 0 ? MAT.lamp : MAT.lit, undefined, Math.max(0, lamp))
  for (const s of [-0.28, 0.28]) faceBox(m, f, a + s, 0.1, 0.05, 0.2, 0.16, 0.4, rgb(0x161412), MAT.shiny)
  // Candlesticks on the mantel.
  for (const s of [-0.7, 0.7]) {
    faceBox(m, f, a + s, 0.14, 0.06, 0.06, 1.2, 1.42, rgb(0x9a7a3a), MAT.shiny)
    faceBox(m, f, a + s, 0.15, 0.03, 0.03, 1.42, 1.5, rgb(0xd8c8a0), lamp >= 0 ? MAT.lamp : MAT.lit, undefined, Math.max(0, lamp))
  }
}

/** Bulb centre: 0.165 m off the face, 1.79 m up (the shade below). */
const SCONCE_OUT = 0.165
const SCONCE_Y = 1.79

function sconce(m: Mesh, f: Face, a: number): void {
  faceBox(m, f, a, 0, 0.08, 0.03, 1.62, 1.78, rgb(0x6a5428), MAT.shiny)
  faceBox(m, f, a, 0.03, 0.03, 0.12, 1.68, 1.71, rgb(0x6a5428), MAT.shiny)
  faceBox(m, f, a, 0.1, 0.13, 0.13, 1.72, 1.86, rgb(0xd8a860), MAT.lamp, undefined, SCONCE_LAMP_SLOT)
}

/**
 * Records a pair of sconces centred at `a`, `half` either side, as one light (layout in `sconces.ts`). `back` puts the
 * half-space cut just inside the wall so the face they hang on is lit but the room behind is not; `left`/`right` clip
 * the light to its room along the wall, found by scanning for perpendicular walls 0.4 m in front of the face (a
 * doorway gap lets it through, as it would).
 */
function pushSconcePair(out: number[], f: Face, a: number, half: number, b: Building, town: Town): void {
  const [wx0, wz0, wx1, wz1] = f.wall
  const thickness = f.axis === "x" ? wz1 - wz0 : wx1 - wx0
  const line = f.at + f.side * 0.4
  let left = 4, right = 4
  for (const w of town.barriers) {
    if (w.kind === "fence" || w.rect === f.wall) continue
    const [x0, z0, x1, z1] = w.rect
    if (x1 < b.rect[0] - 0.05 || x0 > b.rect[2] + 0.05 || z1 < b.rect[1] - 0.05 || z0 > b.rect[3] + 0.05) continue
    const [c0, c1, s0, s1] = f.axis === "x" ? [z0, z1, x0, x1] : [x0, x1, z0, z1]
    if (line < c0 || line > c1) continue
    if (s0 >= a) right = Math.min(right, s0 - a)
    else if (s1 <= a) left = Math.min(left, a - s1)
  }
  const along = f.at + f.side * SCONCE_OUT
  const start = out.length
  out.push(
    f.axis === "x" ? a : along,
    f.axis === "x" ? along : a,
    SCONCE_Y,
    f.axis === "x" ? 0 : f.side,
    f.axis === "x" ? f.side : 0,
    SCONCE_OUT + Math.min(0.06, thickness * 0.5),
    left,
    right,
    half,
    b.rect[0], b.rect[1], b.rect[2], b.rect[3],
  )
  if (out.length - start !== SCONCE_FLOATS) throw new Error("sconce layout drifted")
}

function typewriterDesk(m: Mesh, f: Face, a: number): void {
  const wood = rgb(0x2e1c10)
  faceBox(m, f, a, 0.02, 0.8, 0.5, 0.7, 0.75, wood, MAT.timber, rgb(0x3a2414))
  for (const s of [-0.34, 0.34]) for (const d of [0.06, 0.44]) faceBox(m, f, a + s, d, 0.05, 0.05, 0.13, 0.7, wood, MAT.timber)
  // The typewriter and its ink ribbons.
  faceBox(m, f, a, 0.14, 0.36, 0.26, 0.75, 0.84, rgb(0x1a1c1c), MAT.shiny)
  faceBox(m, f, a, 0.12, 0.42, 0.06, 0.84, 0.9, rgb(0x222424), MAT.shiny)
  faceBox(m, f, a, 0.2, 0.22, 0.004, 0.84, 1.0, rgb(0xc8c0a8), MAT.lit)
  faceBox(m, f, a + 0.3, 0.3, 0.06, 0.06, 0.75, 0.79, rgb(0x5a1a14), MAT.lit)
}

const nearestLamp = (town: Town, x: number, z: number) => {
  let best = -1, bd = 25
  town.lamps.forEach((l, i) => {
    if (l.kind !== "room") return
    const d = (l.x - x) ** 2 + (l.y - z) ** 2
    if (d < bd) { bd = d; best = i }
  })
  return best
}

/** Resident Evil dressing for a building: wainscoting, portraits, a clock, a fireplace, sconces and a save-room desk. */
/** Floor footprint of a piece standing on face `f` at `a`: `w` along the wall, `d` out from it. */
function faceFootprint(f: Face, a: number, w: number, d: number): Rect {
  const n0 = f.at, n1 = f.at + f.side * d
  const lo = Math.min(n0, n1), hi = Math.max(n0, n1)
  return f.axis === "x" ? [a - w / 2, lo, a + w / 2, hi] : [lo, a - w / 2, hi, a + w / 2]
}

/** `footprints` (optional) receives the floor rects of the standing pieces (fireplace, clock, desk) so other dressing can keep off them. */
export function emitInteriorDecor(m: Mesh, b: Building, town: Town, plan: InteriorPlan = planInterior(b, town.houseSeed), sconces?: number[], footprints?: Rect[]): void {
  if (plan.theme === "plain" || !interiorSettings.decor) return
  const faces = interiorFaces(b, town)
  if (interiorSettings.wainscot) for (const f of faces) wainscot(m, f, plan.theme)
  const rng = new Rng(buildingSeed(b, town.houseSeed) ^ 0x7f4a7c15)
  const solid = faces.filter(f => !f.window && f.a1 - f.a0 > 1.2)
  type Slot = { f: Face; a0: number; a1: number }
  const slots: Slot[] = []
  for (const f of solid) for (const [a0, a1] of freeSpans(f, town, b)) slots.push({ f, a0, a1 })
  slots.sort((p, q) => (q.a1 - q.a0) - (p.a1 - p.a0) || p.a0 - q.a0)
  const take = (need: number): { f: Face; a: number } | null => {
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i]!
      if (s.a1 - s.a0 < need) continue
      const a = s.a0 + need / 2 + (s.a1 - s.a0 - need) * (0.3 + 0.4 * rng.next())
      slots.splice(i, 1)
      if (a - need / 2 - s.a0 > 0.5) slots.push({ f: s.f, a0: s.a0, a1: a - need / 2 })
      if (s.a1 - (a + need / 2) > 0.5) slots.push({ f: s.f, a0: a + need / 2, a1: s.a1 })
      slots.sort((p, q) => (q.a1 - q.a0) - (p.a1 - p.a0) || p.a0 - q.a0)
      return { f: s.f, a }
    }
    return null
  }
  const residential = isResidential(b)
  const gilt = plan.theme === "mansion" || plan.theme === "village"
  if (residential && (plan.theme === "mansion" || plan.theme === "village")) {
    const fp = take(2.1)
    if (fp) {
      const lamp = nearestLamp(town, fp.f.axis === "x" ? fp.a : fp.f.at, fp.f.axis === "x" ? fp.f.at : fp.a)
      fireplace(m, fp.f, fp.a, plan.theme, lamp)
      footprints?.push(faceFootprint(fp.f, fp.a, 1.9, 0.52))
      painting(m, fp.f, fp.a, 1.1, 0.8, 1.85, rng, true)
    }
  }
  if (residential && plan.theme !== "station") {
    const c = take(0.8)
    if (c) {
      grandfatherClock(m, c.f, c.a, plan.theme)
      footprints?.push(faceFootprint(c.f, c.a, 0.6, 0.4))
    }
  }
  if (plan.theme === "station" || plan.theme === "mansion" || (plan.theme === "baker" && rng.next() < 0.5)) {
    const t = take(1.0)
    if (t) {
      typewriterDesk(m, t.f, t.a)
      footprints?.push(faceFootprint(t.f, t.a, 0.8, 0.52))
    }
  }
  const paintings = residential ? 3 : 2
  for (let i = 0; i < paintings; i++) {
    const w = 0.55 + rng.next() * 0.5
    const p = take(w + (gilt || plan.theme === "station" ? 0.7 : 0.3))
    if (!p) break
    painting(m, p.f, p.a, w, w * (1.15 + rng.next() * 0.3), 1.62, rng, gilt || rng.next() < 0.4)
    if (gilt || plan.theme === "station") {
      const half = w / 2 + 0.22
      for (const s of [-1, 1]) sconce(m, p.f, p.a + s * half)
      if (sconces) pushSconcePair(sconces, p.f, p.a, half, b, town)
    }
  }
}

/** Sconce lights of a town's buildings, as `emitInteriorDecor` places them (for levels built on the main thread). */
export function collectSconces(town: Town): Float32Array<ArrayBuffer> {
  const out: number[] = []
  const scratch = new Mesh()
  for (const b of town.buildings) {
    scratch.v.length = 0
    emitInteriorDecor(scratch, b, town, undefined, out)
  }
  return new Float32Array(out)
}
