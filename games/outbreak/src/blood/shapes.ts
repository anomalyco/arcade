import { MAT, Mesh, type Mat, type Rgb } from "@arcade/kit/gpu/mesh"
import { Rng } from "@arcade/kit/sim/rng"

/**
 * Painted blood stamps (Darkwood: dark wine-brown pools with lobes and clots, wiped smears, drag trails, prints).
 * Every stamp is flat geometry in the model's XZ plane (normal +Y) with per-vertex colour, so the scene shader lights
 * it like the floor it lies on: colour only where light lands, grey in the shroud. Features are at least ~1.5 cm so
 * nothing turns into sub-pixel glitter at the game's zoom; MSAA smooths the painted edges.
 *
 * Wall stamps are built the same way and stood up by the instance roll (+Z in the model becomes down on the wall).
 */

export const BLOOD_FLOOR_KINDS = ["pool", "stain", "splat", "drops", "smear", "drag"] as const
export const BLOOD_WALL_KINDS = ["hand", "wallSplat", "wallSmear"] as const
export type BloodFloorKind = (typeof BLOOD_FLOOR_KINDS)[number]
export type BloodWallKind = (typeof BLOOD_WALL_KINDS)[number]
export type BloodKind = BloodFloorKind | BloodWallKind | "foot"

/** Variants built per kind (feet: left/right × three strengths, indexed side * 3 + strength). */
export const BLOOD_VARIANTS: Record<BloodKind, number> = {
  pool: 3,
  stain: 3,
  splat: 3,
  drops: 2,
  smear: 2,
  drag: 2,
  foot: 6,
  hand: 2,
  wallSplat: 2,
  wallSmear: 1,
}

/** Grime overlays shared by every floor stamp (dirt specks worked into the blood). */
export const GRIME_VARIANTS = 3

type Palette = {
  core: Rgb
  body: Rgb
  rim: Rgb
  edge: Rgb
  oldCore: Rgb
  oldBody: Rgb
  grime: readonly Rgb[]
}

/** Darkwood's blood: wine-brown, near black where thick, browner where it dried (refs in 2026-10-18-darkwood-blood). */
export function bloodPalette(value = 1): Palette {
  const v = (c: readonly [number, number, number]): Rgb => [Math.min(1, c[0] * value), Math.min(1, c[1] * value), Math.min(1, c[2] * value)]
  return {
    core: v([0.16, 0.032, 0.028]),
    body: v([0.29, 0.058, 0.046]),
    rim: v([0.39, 0.095, 0.07]),
    edge: v([0.21, 0.105, 0.072]),
    oldCore: v([0.14, 0.045, 0.035]),
    oldBody: v([0.235, 0.085, 0.06]),
    grime: [v([0.15, 0.128, 0.1]), v([0.105, 0.09, 0.072]), v([0.2, 0.168, 0.128])],
  }
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const UP = [0, 1, 0] as const

class Painter {
  constructor(
    readonly m: Mesh,
    readonly mat: Mat,
  ) {}

  /** Callers pass a, b, c counter-clockwise in (x, z); emitted as c, b, a so the face points up through back-face culling. */
  tri(a: readonly number[], ca: Rgb, b: readonly number[], cb: Rgb, c: readonly number[], cc: Rgb): void {
    this.m.vert([a[0]!, 0, a[1]!], UP, ca, this.mat)
    this.m.vert([c[0]!, 0, c[1]!], UP, cc, this.mat)
    this.m.vert([b[0]!, 0, b[1]!], UP, cb, this.mat)
  }

  /** An irregular painted blob: a fan core and rings out to a thin rim and a dried edge. */
  blob(rng: Rng, cx: number, cz: number, r: number, cols: { core: Rgb; body: Rgb; rim: Rgb; edge?: Rgb }, opts: { segments?: number; rough?: number; sx?: number; rot?: number } = {}): void {
    const n = opts.segments ?? 22
    const rough = opts.rough ?? 0.22
    const sx = opts.sx ?? 1
    const rot = opts.rot ?? 0
    const amps: number[] = []
    const phases: number[] = []
    for (let k = 2; k <= 7; k++) {
      amps.push((rough * (0.5 + rng.next())) / (k * 0.7))
      phases.push(rng.next() * Math.PI * 2)
    }
    const radius = (t: number) => {
      let s = 1
      for (let k = 0; k < amps.length; k++) s += amps[k]! * Math.sin((k + 2) * t + phases[k]!)
      return r * Math.max(0.5, Math.min(1.55, s))
    }
    const cr = Math.cos(rot)
    const sr = Math.sin(rot)
    const at = (t: number, f: number): [number, number] => {
      const rr = radius(t) * f
      const lx = Math.cos(t) * rr * sx
      const lz = Math.sin(t) * rr
      return [cx + lx * cr - lz * sr, cz + lx * sr + lz * cr]
    }
    const rings = cols.edge ? [0, 0.45, 0.82, 1, 1.07] : [0, 0.5, 1]
    const ringCols = cols.edge ? [cols.core, mix(cols.core, cols.body, 0.6), cols.body, cols.rim, cols.edge] : [cols.core, cols.body, cols.rim]
    for (let i = 0; i < n; i++) {
      const t0 = (i / n) * Math.PI * 2
      const t1 = ((i + 1) / n) * Math.PI * 2
      this.tri([cx, cz], ringCols[0]!, at(t0, rings[1]!), ringCols[1]!, at(t1, rings[1]!), ringCols[1]!)
      for (let k = 1; k < rings.length - 1; k++) {
        const a0 = at(t0, rings[k]!)
        const a1 = at(t1, rings[k]!)
        const b0 = at(t0, rings[k + 1]!)
        const b1 = at(t1, rings[k + 1]!)
        this.tri(a0, ringCols[k]!, b0, ringCols[k + 1]!, b1, ringCols[k + 1]!)
        this.tri(a0, ringCols[k]!, b1, ringCols[k + 1]!, a1, ringCols[k]!)
      }
    }
  }

  /** A small round drop. */
  drop(rng: Rng, cx: number, cz: number, r: number, inner: Rgb, outer: Rgb): void {
    const n = r < 0.03 ? 7 : 10
    const ph = rng.next() * 6.28
    for (let i = 0; i < n; i++) {
      const t0 = (i / n) * Math.PI * 2 + ph
      const t1 = ((i + 1) / n) * Math.PI * 2 + ph
      const w0 = r * (0.85 + 0.3 * Math.abs(Math.sin(t0 * 2.3 + ph)))
      const w1 = r * (0.85 + 0.3 * Math.abs(Math.sin(t1 * 2.3 + ph)))
      this.tri([cx, cz], inner, [cx + Math.cos(t0) * w0, cz + Math.sin(t0) * w0], outer, [cx + Math.cos(t1) * w1, cz + Math.sin(t1) * w1], outer)
    }
  }

  /** A stroke along a polyline with per-point half-width and colour (smears, drags, drips, fingers). */
  stroke(points: readonly (readonly [number, number])[], widths: readonly number[], cols: readonly Rgb[]): void {
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i]!
      const p1 = points[i + 1]!
      const dx = p1[0] - p0[0]
      const dz = p1[1] - p0[1]
      const l = Math.hypot(dx, dz) || 1
      const nx = -dz / l
      const nz = dx / l
      const w0 = widths[i]!
      const w1 = widths[i + 1]!
      const a0: [number, number] = [p0[0] + nx * w0, p0[1] + nz * w0]
      const b0: [number, number] = [p0[0] - nx * w0, p0[1] - nz * w0]
      const a1: [number, number] = [p1[0] + nx * w1, p1[1] + nz * w1]
      const b1: [number, number] = [p1[0] - nx * w1, p1[1] - nz * w1]
      this.tri(a0, cols[i]!, b0, cols[i]!, b1, cols[i + 1]!)
      this.tri(a0, cols[i]!, b1, cols[i + 1]!, a1, cols[i + 1]!)
    }
  }
}

const seedOf = (kind: string, variant: number) => {
  let h = 2166136261
  for (let i = 0; i < kind.length; i++) h = Math.imul(h ^ kind.charCodeAt(i), 16777619)
  return (Math.imul(h ^ (variant + 1), 2654435761) >>> 0) || 1
}

/** A pool (wet, under a body) or an old dried stain: overlapping lobes, clots and satellite drops; unit radius ~0.5 m. */
function poolShape(p: Painter, rng: Rng, pal: Palette, wet: boolean): void {
  const cols = wet
    ? { core: pal.core, body: pal.body, rim: pal.rim, edge: pal.edge }
    : { core: pal.oldCore, body: pal.oldBody, rim: mix(pal.oldBody, pal.edge, 0.5), edge: pal.edge }
  const lobes = 3 + Math.floor(rng.next() * 3)
  p.blob(rng, 0, 0, 0.34, cols, { segments: 26, rough: 0.28 })
  for (let i = 0; i < lobes; i++) {
    const a = rng.next() * Math.PI * 2
    const d = 0.18 + rng.next() * 0.16
    p.blob(rng, Math.cos(a) * d, Math.sin(a) * d, 0.12 + rng.next() * 0.12, cols, { segments: 16, rough: 0.3, sx: 1 + rng.next() * 0.6, rot: a })
  }
  // Thicker clots in the middle of the pool.
  for (let i = 0; i < 3; i++) {
    const a = rng.next() * 6.28
    const d = rng.next() * 0.16
    p.blob(rng, Math.cos(a) * d, Math.sin(a) * d, 0.05 + rng.next() * 0.05, { core: mix(cols.core, [0, 0, 0], 0.35), body: cols.core, rim: cols.core }, { segments: 10, rough: 0.35 })
  }
  for (let i = 0; i < 7; i++) {
    const a = rng.next() * Math.PI * 2
    const d = 0.42 + rng.next() * 0.14
    p.drop(rng, Math.cos(a) * d, Math.sin(a) * d, 0.016 + rng.next() * 0.03, cols.body, cols.rim)
  }
}

/** Directional spray: a core where it landed and streaks and drops thrown toward +X (unit extent ±0.5 m). */
function splatShape(p: Painter, rng: Rng, pal: Palette, wall: boolean): void {
  p.blob(rng, -0.2, 0, 0.13, { core: pal.core, body: pal.body, rim: pal.rim, edge: pal.edge }, { segments: 18, rough: 0.32 })
  const streaks = 6 + Math.floor(rng.next() * 4)
  for (let i = 0; i < streaks; i++) {
    const a = (rng.next() - 0.5) * 1.5
    const l = 0.18 + rng.next() * 0.3
    const x0 = -0.14
    const pts: [number, number][] = []
    const ws: number[] = []
    const cs: Rgb[] = []
    for (let k = 0; k <= 4; k++) {
      const t = k / 4
      pts.push([x0 + Math.cos(a) * l * t, Math.sin(a) * l * t])
      ws.push((0.022 + rng.next() * 0.012) * (1 - t * 0.75))
      cs.push(mix(pal.body, pal.rim, t))
    }
    p.stroke(pts, ws, cs)
    const end = pts[4]!
    p.drop(rng, end[0] + Math.cos(a) * 0.03, end[1] + Math.sin(a) * 0.03, 0.018 + rng.next() * 0.02, pal.body, pal.rim)
  }
  for (let i = 0; i < 12; i++) {
    const a = (rng.next() - 0.5) * 1.9
    const d = 0.12 + rng.next() * 0.42
    p.drop(rng, -0.14 + Math.cos(a) * d, Math.sin(a) * d, 0.012 + rng.next() * 0.022, pal.body, pal.rim)
  }
  if (wall) {
    // Gravity drips: model +Z is down once the stamp stands on a wall.
    for (let i = 0; i < 4; i++) {
      const x = -0.3 + rng.next() * 0.45
      const z0 = (rng.next() - 0.5) * 0.12
      const len = 0.12 + rng.next() * 0.32
      const pts: [number, number][] = []
      const ws: number[] = []
      const cs: Rgb[] = []
      for (let k = 0; k <= 5; k++) {
        const t = k / 5
        pts.push([x + Math.sin(t * 3 + i) * 0.006, z0 + len * t])
        ws.push(0.011 * (1 - t * 0.45))
        cs.push(mix(pal.body, pal.core, t * 0.4))
      }
      p.stroke(pts, ws, cs)
      const e = pts[5]!
      p.drop(rng, e[0], e[1] + 0.008, 0.016, pal.core, pal.body)
    }
  }
}

/** A line of drops left by someone walking while bleeding (unit length 1 m along X). */
function dropsShape(p: Painter, rng: Rng, pal: Palette): void {
  let x = -0.5
  while (x < 0.5) {
    const z = (rng.next() - 0.5) * 0.12
    p.drop(rng, x, z, 0.018 + rng.next() * 0.03, pal.body, pal.rim)
    if (rng.next() < 0.35) p.drop(rng, x + 0.03, z + (rng.next() - 0.5) * 0.06, 0.012 + rng.next() * 0.01, pal.body, pal.rim)
    x += 0.07 + rng.next() * 0.12
  }
}

/** Hand-wiped smear: parallel dragged strokes that break up and dry out toward +X (unit length 1 m). */
function smearShape(p: Painter, rng: Rng, pal: Palette): void {
  const strokes = 4 + Math.floor(rng.next() * 3)
  const bend = (rng.next() - 0.5) * 0.25
  for (let s = 0; s < strokes; s++) {
    const z0 = -0.13 + (s / (strokes - 1)) * 0.26 + (rng.next() - 0.5) * 0.03
    const len = 0.6 + rng.next() * 0.38
    const segs = 9
    let pts: [number, number][] = []
    let ws: number[] = []
    let cs: Rgb[] = []
    const flush = () => {
      if (pts.length > 1) p.stroke(pts, ws, cs)
      pts = []
      ws = []
      cs = []
    }
    for (let k = 0; k <= segs; k++) {
      const t = k / segs
      if (k > 1 && rng.next() < 0.12) flush()
      pts.push([-0.5 + len * t, z0 + bend * t * t + Math.sin(t * 5 + s) * 0.01])
      ws.push((0.018 + rng.next() * 0.016) * (1 - t * 0.55))
      cs.push(mix(pal.body, mix(pal.rim, pal.edge, 0.6), t))
    }
    flush()
  }
  p.blob(rng, -0.47, 0, 0.1, { core: pal.core, body: pal.body, rim: pal.rim, edge: pal.edge }, { segments: 14, rough: 0.3, sx: 0.6 })
}

/** A body dragged along +X: two mottled lanes and drops, thick where it starts (unit length 1 m, ~0.26 wide). */
function dragShape(p: Painter, rng: Rng, pal: Palette): void {
  for (const lane of [-0.065, 0.065]) {
    const segs = 12
    let pts: [number, number][] = []
    let ws: number[] = []
    let cs: Rgb[] = []
    const flush = () => {
      if (pts.length > 1) p.stroke(pts, ws, cs)
      pts = []
      ws = []
      cs = []
    }
    for (let k = 0; k <= segs; k++) {
      const t = k / segs
      if (k > 1 && k < segs && rng.next() < 0.1) flush()
      pts.push([-0.52 + 1.04 * t, lane + (rng.next() - 0.5) * 0.02])
      ws.push(0.03 + rng.next() * 0.025)
      cs.push(mix(pal.body, pal.oldBody, 0.3 + 0.4 * rng.next()))
    }
    flush()
  }
  // Thin streaks between the lanes where clothing dragged.
  for (let i = 0; i < 4; i++) {
    const z = (rng.next() - 0.5) * 0.22
    const x0 = -0.5 + rng.next() * 0.6
    const l = 0.18 + rng.next() * 0.3
    p.stroke(
      [
        [x0, z],
        [x0 + l * 0.5, z + (rng.next() - 0.5) * 0.02],
        [x0 + l, z],
      ],
      [0.006, 0.009, 0.004],
      [pal.rim, pal.body, pal.edge],
    )
  }
  for (let i = 0; i < 6; i++) p.drop(rng, -0.5 + rng.next(), (rng.next() - 0.5) * 0.3, 0.012 + rng.next() * 0.02, pal.body, pal.rim)
}

/** A shoe print (+X toe), tread bars with gaps, fading with each step. */
function footShape(p: Painter, rng: Rng, pal: Palette, left: boolean, strength: number): void {
  const side = left ? 1 : -1
  const fade = [1, 0.6, 0.3][strength]!
  const col = mix(pal.edge, pal.body, fade)
  const rim = mix(pal.edge, pal.rim, fade)
  const bars = 7
  for (let i = 0; i < bars; i++) {
    if (strength === 2 && rng.next() < 0.35) continue
    const t = i / (bars - 1)
    const x = -0.11 + t * 0.23
    // Heel narrower than the ball of the foot; slight outward curve.
    const half = t < 0.3 ? 0.033 : t < 0.55 ? 0.026 : 0.043 - (t - 0.8) * (t > 0.8 ? 0.2 : 0)
    const z = side * (t - 0.5) * (t - 0.5) * 0.05
    p.stroke(
      [
        [x, z - half],
        [x, z + half],
      ],
      [0.011, 0.011],
      [col, rim],
    )
  }
  p.drop(rng, 0.115, side * 0.004, 0.03, col, rim)
}

/** A hand print on a wall (+Z down): palm, fingers, thumb, and on variant 1 the smear of the hand sliding down. */
function handShape(p: Painter, rng: Rng, pal: Palette, smeared: boolean): void {
  p.blob(rng, 0, 0, 0.045, { core: pal.body, body: pal.body, rim: pal.rim }, { segments: 14, rough: 0.15, sx: 1.1 })
  for (let f = 0; f < 4; f++) {
    const x = -0.034 + f * 0.023
    const len = [0.07, 0.083, 0.08, 0.062][f]!
    const spread = (f - 1.5) * 0.12
    p.stroke(
      [
        [x, -0.035],
        [x + Math.sin(spread) * len * 0.5, -0.035 - len * 0.5],
        [x + Math.sin(spread) * len, -0.035 - len],
      ],
      [0.011, 0.01, 0.0085],
      [pal.body, pal.body, pal.rim],
    )
  }
  p.stroke(
    [
      [0.045, 0.0],
      [0.07, -0.025],
      [0.085, -0.05],
    ],
    [0.013, 0.011, 0.009],
    [pal.body, pal.body, pal.rim],
  )
  if (smeared) {
    for (let i = 0; i < 5; i++) {
      const x = -0.04 + i * 0.02 + (rng.next() - 0.5) * 0.006
      const len = 0.08 + rng.next() * 0.16
      p.stroke(
        [
          [x, 0.02],
          [x + (rng.next() - 0.5) * 0.01, 0.02 + len * 0.5],
          [x, 0.02 + len],
        ],
        [0.008, 0.007, 0.004],
        [pal.body, mix(pal.body, pal.edge, 0.5), pal.edge],
      )
    }
  }
}

/** A horizontal wipe on a wall with runs dripping down (+Z). */
function wallSmearShape(p: Painter, rng: Rng, pal: Palette): void {
  for (let s = 0; s < 4; s++) {
    const z = -0.06 + s * 0.035
    const pts: [number, number][] = []
    const ws: number[] = []
    const cs: Rgb[] = []
    for (let k = 0; k <= 8; k++) {
      const t = k / 8
      pts.push([-0.3 + 0.6 * t, z + Math.sin(t * 4 + s) * 0.008])
      ws.push(0.012 * (1 - t * 0.5) + rng.next() * 0.004)
      cs.push(mix(pal.body, pal.edge, t))
    }
    p.stroke(pts, ws, cs)
  }
  for (let i = 0; i < 3; i++) {
    const x = -0.25 + rng.next() * 0.3
    const len = 0.1 + rng.next() * 0.25
    p.stroke(
      [
        [x, 0.05],
        [x, 0.05 + len],
      ],
      [0.008, 0.005],
      [pal.body, pal.core],
    )
  }
}

/** Dirt worked into a stain: brown-grey specks and grit inside a ~0.45 m radius (drawn over the blood). */
function grimeShape(p: Painter, rng: Rng, pal: Palette): void {
  for (let i = 0; i < 26; i++) {
    const a = rng.next() * 6.28
    const d = Math.sqrt(rng.next()) * 0.45
    const g = pal.grime[i % pal.grime.length]!
    p.drop(rng, Math.cos(a) * d, Math.sin(a) * d, 0.011 + rng.next() * 0.02, g, mix(g, pal.edge, 0.3))
  }
  for (let i = 0; i < 3; i++) {
    const a = rng.next() * 6.28
    const d = rng.next() * 0.3
    const g = pal.grime[i % pal.grime.length]!
    p.blob(rng, Math.cos(a) * d, Math.sin(a) * d, 0.035 + rng.next() * 0.03, { core: g, body: g, rim: mix(g, pal.edge, 0.4) }, { segments: 9, rough: 0.45 })
  }
}

export type BloodModelBuild = { kind: BloodKind | "grime"; variant: number; mesh: Mesh }

/** Builds every stamp mesh for a palette (deterministic: the same value always builds the same geometry). */
export function buildBloodMeshes(value = 1): BloodModelBuild[] {
  const pal = bloodPalette(value)
  const out: BloodModelBuild[] = []
  for (const kind of Object.keys(BLOOD_VARIANTS) as BloodKind[]) {
    for (let v = 0; v < BLOOD_VARIANTS[kind]; v++) {
      const rng = new Rng(seedOf(kind, v))
      const wall = (BLOOD_WALL_KINDS as readonly string[]).includes(kind)
      // Matte, pools included: a glossy pool caught the flashlight as a bright reflective blotch.
      const mat: Mat = wall ? MAT.wall : MAT.lit
      const mesh = new Mesh()
      const p = new Painter(mesh, mat)
      if (kind === "pool") poolShape(p, rng, pal, true)
      else if (kind === "stain") poolShape(p, rng, pal, false)
      else if (kind === "splat") splatShape(p, rng, pal, false)
      else if (kind === "drops") dropsShape(p, rng, pal)
      else if (kind === "smear") smearShape(p, rng, pal)
      else if (kind === "drag") dragShape(p, rng, pal)
      else if (kind === "foot") footShape(p, rng, pal, v < 3, v % 3)
      else if (kind === "hand") handShape(p, rng, pal, v === 1)
      else if (kind === "wallSplat") splatShape(p, rng, pal, true)
      else wallSmearShape(p, rng, pal)
      out.push({ kind, variant: v, mesh })
    }
  }
  for (let v = 0; v < GRIME_VARIANTS; v++) {
    const mesh = new Mesh()
    grimeShape(new Painter(mesh, MAT.lit), new Rng(seedOf("grime", v)), pal)
    out.push({ kind: "grime", variant: v, mesh })
  }
  return out
}
