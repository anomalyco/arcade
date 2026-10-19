import { FLOATS_PER_VERT, MAT, type Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { lbox, lquad, type Frame } from "./frame"
import type { InteriorTheme } from "./plan"

/**
 * Craft windows (AR-69): one builder for every window opening, origin and streamed, so a window looks the same from
 * the street and from the room. Exterior casing and a projecting sill with a drip edge; jamb liners through the wall;
 * a two-sash frame with meeting rail and glazing bars; glass at the sash planes; an interior stool, apron and casing;
 * cloth drapes hung from a rod or under a pelmet, gathered at a tie-back. Boards nailed across use the barricade
 * board's size and timber so decayed houses match the boards players nail up.
 *
 * Local frame: `u` runs along the wall, `d` across it from the room face (0) to the street face (`T`), `y` is up.
 */

const hex = (v: number): Rgb => [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
const shade = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k]

/** Where window pieces go: low parts (y ≤ 0.88) never cut, high parts cut with the walls, glass in the glass pass. */
export type WindowSink = { low: Mesh; high: Mesh; glass: Mesh }

export type WindowStyle = {
  /** Room trim (casing, stool, jamb liners). */
  trim: Rgb
  /** Drapes; null hangs none. */
  drape: Rgb | null
  /** Floor-length drapes under a pelmet (RE mansion rooms) rather than sill-length on a rod. */
  grand: boolean
}

export const WINDOW_STYLES: Record<InteriorTheme, WindowStyle> = {
  plain: { trim: hex(0x5e5442), drape: hex(0x6a4418), grand: false },
  mansion: { trim: hex(0x3a2212), drape: hex(0x4c100c), grand: true },
  village: { trim: hex(0x34201a), drape: hex(0x1c3020), grand: true },
  baker: { trim: hex(0x3a2c1e), drape: hex(0x5e523e), grand: false },
  station: { trim: hex(0x22342a), drape: null, grand: false },
}

/** Exterior trim, sash paint and glazing, shared by every house so the street reads as one town. */
const EXT_TRIM = hex(0x787060)
const EXT_CASING = hex(0x6c6556)
const DRIP = hex(0x2a2620)
const SASH = hex(0x7e7666)
const SASH_DARK = hex(0x5a5448)
const GLASS_WARM = hex(0x463626)
const GLASS_COOL = hex(0x6e888c)
const ROD = hex(0x3a3024)
const BRASS = hex(0x8a6a2a)

/** Height of the opening the walls leave (level.ts and world-streamer.ts). */
export const OPENING_Y0 = 0.84
export const OPENING_Y1 = 2.16

export type CraftWindowOptions = {
  /** +1 when the street is on the +z (or +x) side of the wall. */
  out: 1 | -1
  theme: InteriorTheme
  /** Map light whose warm panes glow in the reveal (MAT.lamp aux); -1 for none. */
  lamp?: number
  /** Glow colours of the lower and upper panes per bay, when `lamp` is set. */
  glow?: (bay: number) => readonly [Rgb, Rgb]
  /** Cool north-light glass instead of warm. */
  cool?: boolean
  /** Hang drapes (default true). */
  drapes?: boolean
}

function frameOf(rect: readonly [number, number, number, number], out: 1 | -1): { f: Frame; u0: number; u1: number; T: number } {
  const [x, z, r, end] = rect
  const alongX = r - x >= end - z
  const inner = alongX ? (out > 0 ? z : end) : out > 0 ? x : r
  return { f: { alongX, inner, out }, u0: alongX ? x : z, u1: alongX ? r : end, T: alongX ? end - z : r - x }
}

const pick = (s: WindowSink, y1: number) => (y1 <= 0.88 ? s.low : s.high)

/** One sash: stiles, rails, a glazing bar and its glass. */
function sash(s: WindowSink, f: Frame, u0: number, u1: number, y0: number, y1: number, d0: number, d1: number, bottomRail: number, cool: boolean): void {
  const m = pick(s, y1)
  const st = 0.045
  lbox(m, f, u0, u0 + st, y0, y1, d0, d1, SASH, MAT.lit)
  lbox(m, f, u1 - st, u1, y0, y1, d0, d1, SASH, MAT.lit)
  lbox(m, f, u0 + st, u1 - st, y0, y0 + bottomRail, d0, d1, SASH, MAT.lit)
  lbox(m, f, u0 + st, u1 - st, y1 - 0.04, y1, d0, d1, SASH, MAT.lit)
  // One vertical glazing bar: two lites per sash, the 1970s replacement of a six-over-six.
  const um = (u0 + u1) / 2
  lbox(m, f, um - 0.012, um + 0.012, y0 + bottomRail, y1 - 0.04, d0 + 0.004, d1 - 0.004, SASH_DARK, MAT.lit)
  const dm = (d0 + d1) / 2
  lbox(s.glass, f, u0 + st, u1 - st, y0 + bottomRail, y1 - 0.04, dm - 0.004, dm + 0.004, cool ? GLASS_COOL : GLASS_WARM, MAT.glass)
}

/**
 * One drape panel hung from `top`, its outer edge fixed at `uOut`, its leading edge drawn from `uTop` at the rod to
 * `uTie` at the tie-back and out to `uHem` at the hem. Pleats are a zig-zag of strips whose depth grows where the
 * cloth is gathered, so the folds read under any light; the valley strips are a shade darker.
 */
function drape(m: Mesh, f: Frame, uOut: number, uTop: number, uTie: number, uHem: number, yTop: number, yTie: number, yHem: number, dBack: number, col: Rgb): void {
  const rows = [yTop, (yTop + yTie) / 2 + 0.12, yTie, (yTie + yHem) / 2, yHem]
  const lead = (y: number) => {
    if (y >= yTie) { const t = (yTop - y) / Math.max(0.01, yTop - yTie); return uTop + (uTie - uTop) * (t * t * (3 - 2 * t)) }
    const t = (yTie - y) / Math.max(0.01, yTie - yHem)
    return uTie + (uHem - uTie) * Math.sqrt(t)
  }
  const width0 = Math.abs(uTop - uOut)
  const cols = 7
  const grid = rows.map(y => {
    const ul = lead(y)
    const w = Math.max(0.04, Math.abs(ul - uOut))
    const depth = Math.min(0.075, 0.03 * (width0 / w))
    return Array.from({ length: cols }, (_, i) => {
      const t = i / (cols - 1)
      return [uOut + (ul - uOut) * t, y, dBack - (i % 2 ? depth : 0)] as const
    })
  })
  for (let j = 0; j < rows.length - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = grid[j]![i]!, b = grid[j]![i + 1]!, c = grid[j + 1]![i + 1]!, d = grid[j + 1]![i]!
      const valley = i % 2 === 1
      const k = (valley ? 0.72 : 1) * (j >= 2 ? 0.92 : 1)
      lquad(m, f, [a, b, c, d], shade(col, k), MAT.lit, true)
    }
  }
  // Tie-back band.
  const ut = lead(yTie)
  const lo = Math.min(uOut, ut) - 0.005, hi = Math.max(uOut, ut) + 0.005
  lbox(m, f, lo, hi, yTie - 0.035, yTie + 0.035, dBack - 0.085, dBack + 0.005, shade(col, 0.6), MAT.lit)
}

/**
 * A craft window in a barrier `rect` (the wall leaves the 0.84–2.16 m opening). Double windows (over 2.2 m) get a
 * mullion and two bays.
 */
export function emitCraftWindow(s: WindowSink, rect: readonly [number, number, number, number], o: CraftWindowOptions): void {
  const { f, u0, u1, T } = frameOf(rect, o.out)
  const style = WINDOW_STYLES[o.theme]
  const cool = o.cool ?? false
  const Y0 = OPENING_Y0, Y1 = OPENING_Y1
  const hi = s.high, lo = s.low
  // Street side: casing boards, a head with a drip cap, a projecting sill with horns and a drip edge under it.
  lbox(hi, f, u0 - 0.09, u0, Y0, Y1 + 0.1, T, T + 0.022, EXT_CASING, MAT.lit)
  lbox(hi, f, u1, u1 + 0.09, Y0, Y1 + 0.1, T, T + 0.022, EXT_CASING, MAT.lit)
  lbox(hi, f, u0 - 0.12, u1 + 0.12, Y1, Y1 + 0.11, T, T + 0.028, EXT_CASING, MAT.lit)
  lbox(hi, f, u0 - 0.14, u1 + 0.14, Y1 + 0.11, Y1 + 0.14, T, T + 0.05, EXT_TRIM, MAT.lit)
  lbox(lo, f, u0 - 0.12, u1 + 0.12, Y0 - 0.06, Y0 - 0.005, T * 0.45, T + 0.07, EXT_TRIM, MAT.lit, 0, shade(EXT_TRIM, 1.12))
  lbox(lo, f, u0 - 0.1, u1 + 0.1, Y0 - 0.085, Y0 - 0.06, T + 0.035, T + 0.065, DRIP, MAT.lit)
  // Through the wall: jamb liners and the head liner.
  lbox(hi, f, u0, u0 + 0.05, Y0, Y1, 0, T, style.trim, MAT.lit)
  lbox(hi, f, u1 - 0.05, u1, Y0, Y1, 0, T, style.trim, MAT.lit)
  lbox(hi, f, u0 + 0.05, u1 - 0.05, Y1 - 0.05, Y1, 0, T, style.trim, MAT.lit)
  // Room side: stool, apron and casing with a little head cap.
  lbox(lo, f, u0 - 0.07, u1 + 0.07, Y0 - 0.04, Y0 + 0.005, -0.07, T * 0.45, style.trim, MAT.lit, 0, shade(style.trim, 1.18))
  lbox(lo, f, u0 - 0.03, u1 + 0.03, Y0 - 0.14, Y0 - 0.04, -0.018, 0, shade(style.trim, 0.85), MAT.lit)
  lbox(hi, f, u0 - 0.08, u0, Y0 + 0.005, Y1 + 0.09, -0.022, 0, style.trim, MAT.lit)
  lbox(hi, f, u1, u1 + 0.08, Y0 + 0.005, Y1 + 0.09, -0.022, 0, style.trim, MAT.lit)
  lbox(hi, f, u0 - 0.1, u1 + 0.1, Y1 + 0.09, Y1 + 0.13, -0.034, 0, shade(style.trim, 1.1), MAT.lit)
  // Sashes: the lower inside the upper, meeting at 1.5 m; a mullion splits double windows into two bays.
  const dm = T * 0.5
  const double = u1 - u0 > 2.2
  const mid = (u0 + u1) / 2
  const bays: [number, number][] = double ? [[u0 + 0.05, mid - 0.04], [mid + 0.04, u1 - 0.05]] : [[u0 + 0.05, u1 - 0.05]]
  if (double) lbox(hi, f, mid - 0.04, mid + 0.04, Y0, Y1, 0.01, T - 0.01, style.trim, MAT.lit)
  bays.forEach(([b0, b1], i) => {
    sash(s, f, b0, b1, Y0 + 0.01, 1.53, dm - 0.035, dm - 0.005, 0.075, cool)
    sash(s, f, b0, b1, 1.47, Y1 - 0.05, dm + 0.005, dm + 0.035, 0.04, cool)
    // Warm rooms glow in the reveal behind the glass (the lit-window light is the room lamp's, unchanged).
    if (o.lamp !== undefined && o.lamp >= 0 && o.glow) {
      const [lowCol, highCol] = o.glow(i)
      lbox(hi, f, b0 + 0.05, b1 - 0.05, Y0 + 0.04, 1.47, 0.012, 0.03, lowCol, MAT.lamp, o.lamp)
      lbox(hi, f, b0 + 0.05, b1 - 0.05, 1.53, Y1 - 0.08, 0.012, 0.03, highCol, MAT.lamp, o.lamp)
    }
  })
  if (o.drapes === false || !style.drape) return
  // Drapes: grand rooms hang floor-length velvet under a pelmet; plain rooms hang sill-length on a rod.
  const yTop = Y1 + 0.2
  const reach = Math.min(0.42, (u1 - u0) * 0.22)
  if (style.grand) {
    lbox(hi, f, u0 - 0.26, u1 + 0.26, yTop - 0.02, yTop + 0.18, -0.17, -0.02, style.trim, MAT.timber, 0, shade(style.trim, 1.15))
    lbox(hi, f, u0 - 0.26, u1 + 0.26, yTop - 0.05, yTop - 0.02, -0.18, -0.02, shade(style.trim, 1.3), MAT.timber)
  } else {
    lbox(hi, f, u0 - 0.24, u1 + 0.24, yTop - 0.012, yTop + 0.012, -0.085, -0.06, ROD, MAT.shiny)
    for (const ue of [u0 - 0.26, u1 + 0.26]) lbox(hi, f, ue - 0.025, ue + 0.025, yTop - 0.025, yTop + 0.025, -0.1, -0.05, BRASS, MAT.shiny)
  }
  const yHem = style.grand ? 0.17 : Y0 - 0.06
  const yTie = style.grand ? 1.2 : 1.32
  const m = hi
  drape(m, f, u0 - 0.22, u0 + reach, u0 + 0.02, u0 + reach * 0.55, yTop - 0.02, yTie, yHem, -0.08, style.drape)
  drape(m, f, u1 + 0.22, u1 - reach, u1 - 0.02, u1 - reach * 0.55, yTop - 0.02, yTie, yHem, -0.08, style.drape)
}

/**
 * A window drawn on a solid wall face (pass-throughs and the hand-built houses' lamp-lit side windows): casing, stool,
 * sash bars over a warm glowing pane, and optional drapes. `face` is the room face coordinate, `toward` the room side.
 */
export function emitFaceWindow(
  m: Mesh,
  alongX: boolean,
  face: number,
  toward: 1 | -1,
  u0: number,
  u1: number,
  y0: number,
  y1: number,
  pane: Rgb,
  lamp: number,
  theme: InteriorTheme,
  drapes = true,
): void {
  // Local frame: d measured from the face into the wall, so the room is at -d as for openings.
  const f: Frame = { alongX, inner: face, out: (-toward) as 1 | -1 }
  const style = WINDOW_STYLES[theme]
  // Everything stands proud of the face (there is no opening behind it): pane, sash bars, then casing and stool.
  lbox(m, f, u0, u1, y0, y1, -0.012, -0.003, pane, MAT.lamp, lamp)
  lbox(m, f, u0 - 0.07, u0 + 0.01, y0 - 0.02, y1 + 0.08, -0.04, 0, style.trim, MAT.lit)
  lbox(m, f, u1 - 0.01, u1 + 0.07, y0 - 0.02, y1 + 0.08, -0.04, 0, style.trim, MAT.lit)
  lbox(m, f, u0 - 0.09, u1 + 0.09, y1, y1 + 0.12, -0.048, 0, style.trim, MAT.lit, 0, shade(style.trim, 1.15))
  lbox(m, f, u0 - 0.08, u1 + 0.08, y0 - 0.06, y0, -0.1, 0, style.trim, MAT.lit, 0, shade(style.trim, 1.18))
  lbox(m, f, u0 - 0.03, u1 + 0.03, y0 - 0.16, y0 - 0.06, -0.03, 0, shade(style.trim, 0.85), MAT.lit)
  // Sash bars in front of the pane: bottom rail, meeting rail and one glazing bar.
  const um = (u0 + u1) / 2, ym = (y0 + y1) / 2
  lbox(m, f, u0, u1, ym - 0.025, ym + 0.025, -0.03, -0.012, SASH, MAT.lit)
  lbox(m, f, um - 0.013, um + 0.013, y0, y1, -0.026, -0.012, SASH_DARK, MAT.lit)
  lbox(m, f, u0, u1, y0, y0 + 0.05, -0.03, -0.012, SASH, MAT.lit)
  if (!drapes || !style.drape) return
  const reach = Math.min(0.32, (u1 - u0) * 0.22)
  const yTop = y1 + 0.18
  lbox(m, f, u0 - 0.22, u1 + 0.22, yTop - 0.012, yTop + 0.012, -0.125, -0.1, ROD, MAT.shiny)
  for (const ue of [u0 - 0.24, u1 + 0.24]) lbox(m, f, ue - 0.025, ue + 0.025, yTop - 0.025, yTop + 0.025, -0.14, -0.09, BRASS, MAT.shiny)
  drape(m, f, u0 - 0.18, u0 + reach, u0 + 0.02, u0 + reach * 0.55, yTop - 0.02, ym - 0.1, y0 - 0.04, -0.12, style.drape)
  drape(m, f, u1 + 0.18, u1 - reach, u1 - 0.02, u1 - reach * 0.55, yTop - 0.02, ym - 0.1, y0 - 0.04, -0.12, style.drape)
}

/** Barricade board size and timber (`discovery/barricades.ts`): 1.56 × 0.13 × 0.05 m, nails 0.66 m out. */
export const BOARD = { height: 0.13, thick: 0.05, timber: hex(0x8e6f48), weathered: hex(0x6a5236), nail: hex(0x353738) } as const

/**
 * A board nailed across a façade opening: `u0`..`u1` along the wall at centre height `y`, tilted `tilt` radians in the
 * wall plane, standing `out` metres proud of the face at `face` (street side +`side`). Nail heads near both ends.
 */
export function boardPlank(m: Mesh, alongX: boolean, face: number, side: 1 | -1, u0: number, u1: number, y: number, tilt: number, weathered: boolean): void {
  const from = m.length
  const half = (u1 - u0) / 2, h = BOARD.height / 2, t = BOARD.thick
  const col = weathered ? BOARD.weathered : BOARD.timber
  // Built along +x at the origin, depth along +z out of the wall, then tilted and placed.
  m.box(-half, -h, 0, half, h, t, col, MAT.timber, 0, shade(col, 1.08))
  m.box(-half + 0.006, -h + 0.006, t, -half + 0.03, h - 0.006, t + 0.002, shade(col, 0.7), MAT.timber)
  for (const s of [-1, 1]) for (const dy of [-0.032, 0.032]) {
    const nx = s * (half - 0.09)
    m.box(nx - 0.011, dy - 0.011, t, nx + 0.011, dy + 0.011, t + 0.008, BOARD.nail, MAT.shiny)
  }
  const c = Math.cos(tilt), sn = Math.sin(tilt)
  const uc = (u0 + u1) / 2
  // A proper rotation about y (never a mirror, which would turn the faces inside out): +z goes to the street side.
  const su = alongX ? side : -side
  for (let i = from; i < m.v.length; i += FLOATS_PER_VERT) {
    const lx = m.v[i]!, ly = m.v[i + 1]!, lz = m.v[i + 2]!
    const nx = m.v[i + 3]!, ny = m.v[i + 4]!, nz = m.v[i + 5]!
    const rx = lx * c - ly * sn, ry = lx * sn + ly * c
    const rnx = nx * c - ny * sn, rny = nx * sn + ny * c
    const u = uc + su * rx, d = face + side * lz, nu = su * rnx, nd = side * nz
    m.v[i + 1] = y + ry
    m.v[i + 4] = rny
    if (alongX) {
      m.v[i] = u; m.v[i + 2] = d
      m.v[i + 3] = nu; m.v[i + 5] = nd
    } else {
      m.v[i] = d; m.v[i + 2] = u
      m.v[i + 3] = nd; m.v[i + 5] = nu
    }
  }
}
