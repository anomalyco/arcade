/**
 * Procedural rug textures: hand-knotted Persian and Turkmen pile, flat-woven kilims, Art Deco carved pile, braided
 * rag ovals and 70s shag, baked from a seed into an RGBA mip chain (RGB = sRGB albedo, A = pile height, 0 = no rug).
 *
 * The design is evaluated once per knot on a slightly irregular knot grid, outlined, then rendered per pixel with
 * knot shading, abrash banding, wear, fade, stains and fringes. Pure TypeScript with no DOM, so it runs in a Worker.
 */

import { ROLE, RUG_PALETTES, type RugPaletteId, hexToRgb } from "./rug-palettes"

export { RUG_PALETTES, RUG_PALETTE_IDS, type RugPaletteId } from "./rug-palettes"

export const RUG_STYLES = ["persian", "turkmen", "kilim", "deco", "braided", "shag"] as const
export type RugStyle = (typeof RUG_STYLES)[number]

export const RUG_STYLE_LABELS: Record<RugStyle, string> = {
  persian: "Persian medallion",
  turkmen: "Turkmen gul",
  kilim: "Kilim (flat weave)",
  deco: "Art Deco",
  braided: "Braided oval",
  shag: "70s shag",
}

/** Field layouts for Persian rugs. */
export const PERSIAN_FIELDS = ["floral", "herati", "boteh", "mina"] as const
export type PersianField = (typeof PERSIAN_FIELDS)[number]

export type RugSpec = {
  style: RugStyle
  palette: RugPaletteId
  /** Design seed: motif choice and placement. Separate from every other parameter. */
  seed: number
  /** Physical size in metres; `length` runs along the texture's v axis. */
  width: number
  length: number
  /** 0 = new, 1 = threadbare in the traffic path. */
  wear: number
  /** 0 = fresh dyes, 1 = sun-faded. */
  fade: number
  /** 0 = even dye lots, 1 = strong abrash bands across the length. */
  abrash: number
  /** Knot pitch in millimetres (fine city rugs ~5, village rugs ~10). */
  knotMm: number
  /** Persian medallion size, 0 = none (allover field), 1 = large. */
  medallion: number
  /** Border scale relative to the rug's short side. */
  borderScale: number
  /** Persian field pattern (other styles ignore it). */
  field: PersianField
  /** Fringes on the short ends (pile and flat-woven rugs). */
  fringe: boolean
  /** Dark spots and spills, 0..1. */
  stains: number
}

export const DEFAULT_RUG_SPEC: RugSpec = {
  style: "persian",
  palette: "madder",
  seed: 7,
  width: 2.0,
  length: 3.0,
  wear: 0.25,
  fade: 0.2,
  abrash: 0.35,
  knotMm: 7,
  medallion: 0.8,
  borderScale: 1,
  field: "floral",
  fringe: true,
  stains: 0.1,
}

export type RugBake = {
  /** Square texture size of mip 0. */
  size: number
  /** RGBA8 levels from `size` down to 1×1. */
  mips: Uint8Array[]
  /** Mean sRGB colour of the visible rug (for distant or unbaked fallbacks). */
  average: [number, number, number]
  ms: number
}

// ── small deterministic helpers ─────────────────────────────────────────────────────────────────────────────────

function hash2(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function vnoise(x: number, y: number, s: number): number {
  const ix = Math.floor(x), iy = Math.floor(y)
  const fx = x - ix, fy = y - iy
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy)
  const a = hash2(ix, iy, s), b = hash2(ix + 1, iy, s), c = hash2(ix, iy + 1, s), d = hash2(ix + 1, iy + 1, s)
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
}

function fbm(x: number, y: number, s: number, oct = 3): number {
  let v = 0, amp = 0.5, f = 1, norm = 0
  for (let i = 0; i < oct; i++) {
    v += vnoise(x * f, y * f, s + i * 17) * amp
    norm += amp
    amp *= 0.5
    f *= 2.03
  }
  return v / norm
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/** Scalloped "cloud" edge: 1 at lobe centres, dipping to 1 - amp at the notches between `n` lobes. */
function lobeEdge(theta: number, n: number, amp: number): number {
  const c = Math.abs(Math.cos(theta * n * 0.5))
  return 1 - amp * Math.pow(1 - c, 1.6)
}

// ── knot design ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Region groups; outlines are drawn where a higher group meets a lower one. */
const G = { ground: 0, fieldMotif: 1, spandrel: 2, medal: 3, medalRing: 4, medalInner: 5, core: 6, border: 7, borderMotif: 8, guard: 9, line: 10, panel: 11 } as const

type Design = {
  nx: number
  ny: number
  knot: number
  /** Palette role per knot. */
  role: Uint8Array
  /** Region group per knot. */
  group: Uint8Array
  /** Extra height offset per knot (carving), -1..1 scaled by 1/127. */
  carve: Int8Array
}

type Ctx = {
  spec: RugSpec
  Wh: number
  Hh: number
  knot: number
  rnd: () => number
  seed: number
}

/** Repeating motif sampler for a field region; returns a role or -1 for ground. */
type MotifFn = (x: number, y: number) => number

/** Small floral scatter (rosettes, leaf pairs, buds, stars, tendrils) on a jittered cell grid. */
function floralScatter(cell: number, seed: number, roles: readonly number[], density = 0.92): MotifFn {
  return (x, y) => {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell)
    let best = -1, bestPri = -1
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const gx = cx + i, gy = cy + j
        const h0 = hash2(gx, gy, seed)
        if (h0 > density) continue
        const h1 = hash2(gx, gy, seed + 1), h2 = hash2(gx, gy, seed + 2), h3 = hash2(gx, gy, seed + 3)
        const px = (gx + 0.2 + 0.6 * h1) * cell, py = (gy + 0.2 + 0.6 * h2) * cell
        const dx = x - px, dy = y - py
        const r = Math.hypot(dx, dy)
        const kind = Math.floor(h3 * 6)
        const size = cell * (0.26 + 0.18 * hash2(gx, gy, seed + 4))
        if (r > size * 1.9) continue
        const rot = hash2(gx, gy, seed + 5) * Math.PI * 2
        const c1 = roles[Math.floor(hash2(gx, gy, seed + 6) * roles.length)]!
        const c2 = roles[Math.floor(hash2(gx, gy, seed + 7) * roles.length)]!
        let hit = -1
        const th = Math.atan2(dy, dx) + rot
        if (kind <= 1) {
          // Rosette: n petals, coloured eye.
          const n = kind === 0 ? 6 : 8
          const edge = size * (0.55 + 0.45 * Math.abs(Math.cos(th * n * 0.5)))
          if (r < size * 0.3) hit = r < size * 0.13 ? c1 : c2
          else if (r < edge) hit = c1
        } else if (kind === 2) {
          // Leaf pair (vesica leaves on a short stem).
          const ca = Math.cos(rot), sa = Math.sin(rot)
          const lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca
          for (const side of [-1, 1]) {
            const qx = lx - size * 0.55 * side, qy = ly
            const L = size * 0.85, w = size * 0.32
            const t = qx / L
            if (Math.abs(t) < 1 && Math.abs(qy - side * 0.25 * size * (1 - t * t)) < w * (1 - t * t)) hit = c1 === roles[0] ? roles[roles.length - 1]! : c1
          }
          if (Math.abs(ly) < cell * 0.03 && Math.abs(lx) < size * 1.2) hit = hit < 0 ? c2 : hit
        } else if (kind === 3) {
          // Eight-point star.
          const edge = size * (0.42 + 0.58 * Math.pow(Math.abs(Math.cos(th * 4)), 3))
          if (r < edge) hit = r < size * 0.22 ? c2 : c1
        } else if (kind === 4) {
          // Tendril: a thin arc with a bud at its end.
          const ar = size * 1.25
          const ox = px + Math.cos(rot) * ar, oy = py + Math.sin(rot) * ar
          const d = Math.hypot(x - ox, y - oy)
          const ang = Math.atan2(y - oy, x - ox) - rot - Math.PI
          const wrapped = Math.atan2(Math.sin(ang), Math.cos(ang))
          if (Math.abs(d - ar) < cell * 0.035 && wrapped > -1.1 && wrapped < 1.1) hit = c2
          if (r < size * 0.34) hit = c1
        } else {
          // Bud: teardrop with a dark eye.
          const ca = Math.cos(rot), sa = Math.sin(rot)
          const lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca
          const inBody = Math.hypot(lx, ly + size * 0.15) < size * 0.42
          const inTip = ly < -size * 0.15 && ly > -size * 1.0 && Math.abs(lx) < size * 0.42 * ((ly + size) / (size * 0.85))
          if (inBody || inTip) hit = Math.hypot(lx, ly + size * 0.1) < size * 0.16 ? c2 : c1
        }
        if (hit >= 0 && h0 > bestPri) {
          best = hit
          bestPri = h0
        }
      }
    }
    return best
  }
}

/** Herati: diamond lattice with rosettes on the nodes, lancet leaves inside each diamond and a vine on the edges. */
function heratiField(cell: number, roles: readonly number[], vine: number, knot: number): MotifFn {
  return (x, y) => {
    const u = (x + y) / cell, v = (x - y) / cell
    const fu = u - Math.round(u), fv = v - Math.round(v)
    // Lattice node (diamond corner) rosette.
    const node = Math.hypot(fu, fv) * cell * 0.7071
    const th = Math.atan2(fv, fu)
    if (node < cell * 0.16 * (0.6 + 0.4 * Math.abs(Math.cos(th * 3)))) return node < cell * 0.05 ? roles[1]! : roles[0]!
    // Diamond centre flower.
    const cu = u - Math.floor(u) - 0.5, cv = v - Math.floor(v) - 0.5
    const cr = Math.hypot(cu, cv) * cell * 0.7071
    if (cr < cell * 0.09) return cr < cell * 0.04 ? roles[0]! : roles[2]!
    // Lancet leaves pointing from the diamond's sides toward its centre.
    for (const [ax, ay] of [[1, 0], [0, 1]] as const) {
      const along = ax ? cu : cv, across = ax ? cv : cu
      const t = (Math.abs(along) - 0.28) / 0.17
      if (Math.abs(t) < 1 && Math.abs(across - Math.sign(along) * 0.05 * (1 - t * t)) < 0.075 * (1 - t * t)) return roles[3 % roles.length]!
    }
    // Vine on the lattice edges.
    if (Math.min(Math.abs(fu), Math.abs(fv)) * cell * 0.7071 < knot * 0.75) return vine
    return -1
  }
}

/** Boteh (paisley) rows alternating direction. */
function botehField(cell: number, roles: readonly number[]): MotifFn {
  return (x, y) => {
    const row = Math.floor(y / (cell * 1.25))
    const off = row & 1 ? cell * 0.5 : 0
    const col = Math.floor((x + off) / cell)
    const lx = x + off - (col + 0.5) * cell, ly = y - (row + 0.5) * cell * 1.25
    const dir = (row + col) & 1 ? 1 : -1
    const s = cell * 0.3
    // Body circle plus a curled, tapering tail built from shrinking circles.
    let inside = Math.hypot(lx, ly - s * 0.35) < s
    let inner = Math.hypot(lx, ly - s * 0.35) < s * 0.55
    for (let k = 1; k <= 6 && !inside; k++) {
      const t = k / 6
      const ang = t * 2.3
      const cx = dir * Math.sin(ang) * s * 0.9, cy = s * 0.35 - Math.cos(ang) * s * 0.2 - t * s * 1.45
      if (Math.hypot(lx - cx, ly - cy) < s * (1 - t) * 0.85) inside = true
    }
    if (!inside) return -1
    if (inner) return Math.hypot(lx, ly - s * 0.35) < s * 0.22 ? roles[2]! : roles[1]!
    return roles[0]!
  }
}

/** Mina khani: rosettes on a square grid joined by a diamond vine net, with small flowers between. */
function minaField(cell: number, roles: readonly number[], vine: number, knot: number): MotifFn {
  const flowers = floralScatter(cell * 0.5, 991, roles.slice(1), 0.5)
  return (x, y) => {
    const fx = x / cell - Math.round(x / cell), fy = y / cell - Math.round(y / cell)
    const r = Math.hypot(fx, fy) * cell
    const th = Math.atan2(fy, fx)
    if (r < cell * 0.2 * (0.55 + 0.45 * Math.abs(Math.cos(th * 2)))) return r < cell * 0.07 ? roles[1]! : roles[0]!
    const d = Math.abs(Math.abs(fx) + Math.abs(fy) - 0.5) * cell * 0.7071
    if (d < knot * 0.8) return vine
    return flowers(x, y)
  }
}

/** Two families of wavy stems forming a scrolling vine net under the flowers. */
function vineNet(spacing: number, role: number, knot: number, seed: number): MotifFn {
  const a = spacing * 0.32, f = (Math.PI * 2) / (spacing * 1.7), ph = hash2(seed, 1, 2) * 6
  return (x, y) => {
    const w1 = (y - a * Math.sin(x * f + ph)) / spacing
    const w2 = (x - a * Math.sin(y * f * 1.13 + ph * 0.7)) / spacing
    const d1 = Math.abs(w1 - Math.round(w1)) * spacing, d2 = Math.abs(w2 - Math.round(w2)) * spacing
    return Math.min(d1, d2) < knot * 0.62 ? role : -1
  }
}

/** Stacks motif layers: the first layer that paints wins. */
function layered(...layers: MotifFn[]): MotifFn {
  return (x, y) => {
    for (const l of layers) {
      const r = l(x, y)
      if (r >= 0) return r
    }
    return -1
  }
}

/** Fills one region of a Persian field with its allover motif. */
function persianFieldMotif(ctx: Ctx, kind: PersianField, scale: number, roles: readonly number[], vine: number, seed: number): MotifFn {
  const base = Math.min(ctx.Wh, ctx.Hh) * 2
  const cell = Math.max(ctx.knot * 7, base * 0.04 * scale)
  switch (kind) {
    case "herati": return heratiField(cell * 2.6, roles, vine, ctx.knot)
    case "boteh": return layered(botehField(cell * 2.2, roles), floralScatter(cell * 0.8, seed + 5, roles, 0.45))
    case "mina": return minaField(cell * 3, roles, vine, ctx.knot)
    default:
      return layered(
        floralScatter(cell * 2.3, seed + 3, roles, 0.55),
        floralScatter(cell, seed, roles, 0.97),
        vineNet(cell * 2.1, vine, ctx.knot, seed),
      )
  }
}

type Band = { w: number; kind: "line" | "guard" | "main" | "plain"; role: number; alt?: number }

function makeBands(ctx: Ctx, mainBg: number, guardBg: number, lineRole: number, borders: number): Band[] {
  const minDim = Math.min(ctx.Wh, ctx.Hh) * 2
  const k = ctx.knot
  const M = Math.max(k * 10, minDim * 0.085 * ctx.spec.borderScale)
  const g = Math.max(k * 4, M * 0.26)
  const line = Math.max(k * 1.1, minDim * 0.005)
  const bands: Band[] = [
    { w: line * 1.4, kind: "line", role: ROLE.dark },
    { w: g, kind: "guard", role: guardBg, alt: ROLE.ground },
    { w: line, kind: "line", role: lineRole },
    { w: M, kind: "main", role: mainBg },
    { w: line, kind: "line", role: lineRole },
    { w: g * 0.85, kind: "guard", role: guardBg, alt: ROLE.blue },
    { w: line, kind: "line", role: lineRole },
  ]
  if (borders >= 3) bands.splice(1, 0, { w: g * 0.7, kind: "plain", role: ROLE.border2 }, { w: line, kind: "line", role: lineRole })
  return bands
}

type BorderHit = { role: number; group: number } | null

/** Border bands: returns the role at a point, or null inside the field. `along` repeats are aligned to the mitred corners. */
function evalBands(
  ctx: Ctx,
  ax: number,
  ay: number,
  bands: readonly Band[],
  mainMotif: (s: number, t: number, P: number) => number,
  guardMotif: (s: number, t: number, P: number, alt: number) => number,
  out: { inner: number },
): BorderHit {
  const dX = ctx.Wh - ax, dY = ctx.Hh - ay
  const d = Math.min(dX, dY)
  let start = 0
  for (const b of bands) {
    if (d < start + b.w) {
      if (b.kind === "line" || b.kind === "plain") return { role: b.role, group: G.line }
      const vertical = dX <= dY
      const s = (d - start) / b.w
      const center = start + b.w * 0.5
      // Half-length of this band's centreline on this side, from the middle of the rug to the mitred corner.
      const half = vertical ? ctx.Hh - center : ctx.Wh - center
      const pos = vertical ? ay : ax
      const P0 = b.kind === "main" ? b.w * 1.15 : b.w * 1.1
      const n = Math.max(1, Math.round(half / P0))
      const P = half / n
      const t = half - pos // distance from the corner along the band
      if (b.kind === "main") {
        const r = mainMotif(s, t, P)
        return r >= 0 ? { role: r, group: G.borderMotif } : { role: b.role, group: G.border }
      }
      const r = guardMotif(s, t, P, b.alt ?? ROLE.ground)
      return r >= 0 ? { role: r, group: G.borderMotif } : { role: b.role, group: G.guard }
    }
    start += b.w
  }
  out.inner = start
  return null
}

function persianDesign(ctx: Ctx, kx: number, ky: number, nx: number, ny: number, design: Design): void {
  const { spec, rnd } = ctx
  const pal = spec.palette
  const ivoryField = pal === "tabriz"
  const borderBg = ivoryField ? ROLE.border : rnd() < 0.55 ? ROLE.border : ROLE.medal
  const guardBg = rnd() < 0.5 ? ROLE.ivory : ROLE.gold
  const lineRole = rnd() < 0.5 ? ROLE.dark : ROLE.gold
  const bands = makeBands(ctx, borderBg, guardBg, lineRole, rnd() < 0.3 ? 3 : 2)
  const borderKind = Math.floor(rnd() * 3) // 0 rosette & vine, 1 cartouche, 2 boteh
  const vineRole = borderBg === ROLE.ivory || borderBg === ROLE.border ? ROLE.ground2 : ROLE.gold
  const rosetteA = ROLE.ground, rosetteB = borderBg === ROLE.medal ? ROLE.ivory : ROLE.medal
  const mainMotif = (s: number, t: number, P: number) => {
    const ph = t / P
    const k = Math.round(ph)
    const f = ph - k // -0.5..0.5 around each main motif centre
    const across = s - 0.5
    const M = P // motif scale in "periods"
    // Main rosette at each period (the corner one sits on the mitre).
    const rr = Math.hypot(f, across * 0.85)
    const th = Math.atan2(across, f)
    if (borderKind === 1) {
      // Lobed cartouche alternating with rosettes.
      if (k % 2 === 0) {
        const e = 0.4 * lobeEdge(th, 10, 0.18)
        if (rr < e) {
          if (rr > e - 0.045) return ROLE.dark
          if (rr < 0.17) return rr < 0.07 ? ROLE.gold : rr > 0.14 ? ROLE.dark : rosetteB
          const petal = Math.abs(Math.cos(th * 5))
          return petal > 0.93 ? ROLE.dark : rr < 0.27 ? ROLE.ivory : rosetteA
        }
      } else {
        const cx = Math.abs(f) / 0.47, cy = Math.abs(across) / 0.3
        const e = cx * cx + cy * cy
        if (e < 1) {
          if (e > 0.86) return ROLE.dark
          if (e < 0.22) return e < 0.08 ? ROLE.medal : ROLE.ivory
          const dots = hash2(Math.floor(f * 22), Math.floor(across * 18), ctx.seed + k) < 0.18
          return dots ? ROLE.gold : rosetteB
        }
        if (e < 1.18 && Math.abs(across) < 0.06) return ROLE.dark
      }
    } else if (borderKind === 2) {
      const dir = k % 2 === 0 ? 1 : -1
      const bx = f * dir, by = across
      if (Math.hypot(bx + 0.06, by) < 0.24) return Math.hypot(bx + 0.06, by) < 0.11 ? ROLE.gold : rosetteA
      for (let i = 1; i <= 5; i++) {
        const tt = i / 5
        if (Math.hypot(bx - 0.06 - tt * 0.24, by - Math.sin(tt * 2.4) * 0.14) < 0.2 * (1 - tt) + 0.02) return rosetteA
      }
    } else {
      const e = 0.38 * lobeEdge(th, 8, 0.32)
      if (rr < e) {
        if (rr > e - 0.045) return ROLE.dark
        if (rr < 0.15) return rr < 0.06 ? ROLE.gold : rr > 0.12 ? ROLE.dark : rosetteB
        if (Math.abs(Math.cos(th * 4)) > 0.95) return ROLE.dark
        return rr < 0.24 ? ROLE.ivory : rosetteA
      }
      // Palmette half-way between rosettes: a fan of three lobes on a calyx.
      const g2 = ph - Math.floor(ph) - 0.5
      if (Math.abs(g2) < 0.2 && Math.abs(across) < 0.26) {
        const pr = Math.hypot(g2 / 0.18, across / 0.24)
        const pth = Math.atan2(across, g2)
        const pe = lobeEdge(pth, 6, 0.35)
        if (pr < pe) return pr > pe - 0.18 ? ROLE.dark : pr < 0.4 ? ROLE.gold : rosetteB
      }
    }
    // Undulating vine with leaves.
    const vy = 0.5 + 0.27 * Math.sin(Math.PI * ph)
    const dv = Math.abs(s - vy) * M
    if (dv < ctx.knot * 0.9) return vineRole
    const leafPh = ph * 2 + 0.25
    const lf = leafPh - Math.round(leafPh)
    if (Math.abs(lf) < 0.12 && Math.abs(s - vy - 0.12 * Math.cos(Math.PI * ph)) < 0.08 * (1 - (lf / 0.12) ** 2)) return ROLE.green
    return -1
  }
  const guardMotif = (s: number, t: number, P: number, alt: number) => {
    const ph = t / (P * 0.5)
    const f = ph - Math.round(ph)
    const r = Math.hypot(f, (s - 0.5) * 0.9)
    if (r < 0.26) return r < 0.1 ? ROLE.dark : alt
    if (Math.abs(f) > 0.38 && Math.abs(s - 0.5) < 0.12) return ROLE.ground2
    return -1
  }
  const fieldRoles = ivoryField ? [ROLE.medal, ROLE.blue, ROLE.gold, ROLE.green, ROLE.rose] : [ROLE.ivory, ROLE.gold, ROLE.blue, ROLE.rose, ROLE.green, ROLE.medal2]
  const medalRoles = [ROLE.ivory, ROLE.gold, ROLE.rose, ROLE.ground, ROLE.green]
  const fieldKind = spec.field
  const fieldMotif = persianFieldMotif(ctx, fieldKind, 1, fieldRoles, ROLE.green, ctx.seed + 11)
  const medalMotif = persianFieldMotif(ctx, "floral", 0.8, medalRoles, ROLE.gold, ctx.seed + 23)
  const innerMotif = floralScatter(Math.max(ctx.knot * 7, Math.min(ctx.Wh, ctx.Hh) * 0.06), ctx.seed + 37, [ROLE.medal, ROLE.ground, ROLE.blue, ROLE.gold])
  const lobes = [8, 12, 16][Math.floor(rnd() * 3)]!
  const lobeAmp = 0.12 + rnd() * 0.18
  const diamond = 0.35 + rnd() * 0.45
  const innerLobes = [6, 8, 10][Math.floor(rnd() * 3)]!
  const mSize = spec.medallion
  const runner = ctx.Hh / ctx.Wh > 2.2
  const medallions = runner && mSize > 0 ? Math.max(2, Math.round(ctx.Hh / ctx.Wh)) : 1
  const spandrels = mSize > 0.05 && !runner
  const out = { inner: 0 }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = (i + 0.5) * ctx.knot - ctx.Wh, y = (j + 0.5) * ctx.knot - ctx.Hh
      const ax = Math.abs(x), ay = Math.abs(y)
      const idx = j * nx + i
      const bh = evalBands(ctx, ax, ay, bands, mainMotif, guardMotif, out)
      if (bh) {
        design.role[idx] = bh.role
        design.group[idx] = bh.group
        continue
      }
      const Fw = ctx.Wh - out.inner, Fh = ctx.Hh - out.inner
      let role = ivoryField ? ROLE.ground : ROLE.ground
      let group: number = G.ground
      let done = false
      if (mSize > 0) {
        // Medallion(s), centred on the field (stacked along the length for runners).
        const segH = Fh / medallions
        const my = medallions > 1 ? (((ay + (medallions % 2 ? segH : 0)) % (2 * segH)) - segH) : ay
        const mw = Math.min(0.92, 0.66 * mSize) * (runner ? 1.3 : 1), mh = runner ? mw * (Fw / segH) * 0.95 : Math.min(0.85, 0.52 * mSize)
        const qx = ax / (Fw * mw), qy = Math.abs(my) / (Math.min(segH, Fh) * mh)
        const re = Math.hypot(qx, qy)
        const rd = (qx + qy) * 0.78
        const r = re + (rd - re) * diamond
        const th = Math.atan2(qy, qx)
        const edge = lobeEdge(th, lobes, lobeAmp)
        const rq = r / edge
        if (rq < 1) {
          done = true
          if (rq > 0.92) { role = ROLE.gold; group = G.medalRing }
          else if (rq > 0.88) { role = ROLE.dark; group = G.medalRing }
          else {
            const ie = lobeEdge(th + 0.2, innerLobes, 0.22)
            const ir = re / ie
            if (ir < 0.17) { role = ir < 0.07 ? ROLE.gold : ROLE.ground; group = G.core }
            else if (ir < 0.5) {
              group = G.medalInner
              const m = innerMotif(ax, my)
              role = ir > 0.46 ? ROLE.dark : m >= 0 ? m : ROLE.ivory
            } else {
              group = G.medal
              const m = medalMotif(ax, my)
              role = m >= 0 ? m : ROLE.medal
            }
          }
        } else if (!runner) {
          // Pendants on the long axis.
          const py = Fh * mh * 1.16, pr = Fw * mw * 0.17
          const dp = Math.hypot(ax / pr, (ay - py) / (pr * 0.9))
          const pth = Math.atan2(ay - py, ax)
          if (dp < lobeEdge(pth, 6, 0.25)) {
            done = true
            group = G.medalRing
            role = dp < 0.45 ? ROLE.gold : dp > 0.86 ? ROLE.dark : ROLE.medal
          } else if (ax < ctx.knot * 1.2 && ay > Fh * mh * 0.9 && ay < py) {
            done = true
            role = ROLE.gold
            group = G.medalRing
          } else if (Math.hypot(ax, ay - py - pr * 1.75) < pr * 0.45) {
            done = true
            role = ROLE.ivory
            group = G.medalRing
          }
        }
      }
      if (!done && spandrels) {
        const sx = (Fw - ax) / (Fw * 0.44 * Math.max(0.6, mSize)), sy = (Fh - ay) / (Fh * 0.36 * Math.max(0.6, mSize))
        const sr = Math.hypot(sx, sy)
        const sth = Math.atan2(sy, sx)
        const se = lobeEdge(sth, lobes / 2 + 2, lobeAmp * 1.2)
        if (sr < se) {
          done = true
          group = G.spandrel
          if (sr > se - 0.07) role = ROLE.gold
          else if (sr > se - 0.11) role = ROLE.dark
          else {
            const m = medalMotif(ax, ay)
            role = m >= 0 ? m : ROLE.medal
          }
        }
      }
      if (!done) {
        const m = fieldMotif(ax, ay)
        if (m >= 0) { role = m; group = G.fieldMotif }
      }
      design.role[idx] = role
      design.group[idx] = group
    }
  }
}

function turkmenDesign(ctx: Ctx, nx: number, ny: number, design: Design): void {
  const { rnd } = ctx
  const minDim = Math.min(ctx.Wh, ctx.Hh) * 2
  const k = ctx.knot
  const bands: Band[] = [
    { w: k * 1.5, kind: "line", role: ROLE.dark },
    { w: Math.max(k * 4, minDim * 0.03), kind: "guard", role: ROLE.ground2, alt: ROLE.ivory },
    { w: k * 1.2, kind: "line", role: ROLE.dark },
    { w: Math.max(k * 8, minDim * 0.06 * ctx.spec.borderScale), kind: "main", role: ROLE.ground },
    { w: k * 1.2, kind: "line", role: ROLE.dark },
  ]
  const mainMotif = (s: number, t: number, P: number) => {
    // Small octagonal stars (kurbaghe) with dark cross-hooks.
    const ph = t / (P * 0.7)
    const f = ph - Math.round(ph)
    const a = s - 0.5
    const o = Math.max(Math.abs(f) / 0.32, Math.abs(a) / 0.3, (Math.abs(f) / 0.32 + Math.abs(a) / 0.3) * 0.7)
    if (o < 1) return o < 0.45 ? ROLE.gold : Math.round(ph) % 2 ? ROLE.ivory : ROLE.blue
    if (Math.abs(f) > 0.42 && Math.abs(a) < 0.08) return ROLE.dark
    return -1
  }
  const guardMotif = (s: number, t: number, _P: number, alt: number) => {
    // Barber-pole diagonal stripes.
    const st = (t / (k * 6) + s * 0.9) % 1
    return st < 0.5 ? alt : ROLE.dark
  }
  const cols = Math.max(2, Math.round((ctx.Wh * 2) / (0.42 + rnd() * 0.2)))
  const out = { inner: 0 }
  // End panels (elem) at the short ends.
  const elem = Math.max(k * 10, ctx.Hh * 0.07)
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = (i + 0.5) * k - ctx.Wh, y = (j + 0.5) * k - ctx.Hh
      const ax = Math.abs(x), ay = Math.abs(y)
      const idx = j * nx + i
      const bh = evalBands(ctx, ax, ay, bands, mainMotif, guardMotif, out)
      if (bh) { design.role[idx] = bh.role; design.group[idx] = bh.group; continue }
      const Fw = ctx.Wh - out.inner, Fh = ctx.Hh - out.inner
      let role: number = ROLE.ground, group: number = G.ground
      if (ay > Fh - elem) {
        // Elem: rows of small trees on a lighter ground.
        group = G.panel
        role = ROLE.ground2
        const ex = x / (elem * 0.55)
        const fx = ex - Math.round(ex)
        const ey = (ay - (Fh - elem)) / elem
        if (Math.abs(fx) < 0.05 && ey > 0.15 && ey < 0.85) role = ROLE.ivory
        else if (Math.abs(Math.abs(fx) - (0.85 - ey) * 0.35) < 0.06 && ey > 0.25 && ey < 0.8 && ((ey * 6) % 1) < 0.6) role = ROLE.gold
        if (ay > Fh - k * 1.2 || ay < Fh - elem + k * 1.2) role = ROLE.dark
      } else {
        const fh = Fh - elem
        const sx = (Fw * 2) / cols
        const sy = sx * 0.78
        const rows = Math.max(1, Math.round((fh * 2) / sy))
        const syA = (fh * 2) / rows
        const lx0 = x + Fw, ly0 = y + fh
        const col = Math.floor(lx0 / sx), row = Math.floor(ly0 / syA)
        const lx = lx0 - (col + 0.5) * sx, ly = ly0 - (row + 0.5) * syA
        const a = sx * 0.4, b = syA * 0.36
        const oct = Math.max(Math.abs(lx) / a, Math.abs(ly) / b, (Math.abs(lx) / a + Math.abs(ly) / b) * 0.74)
        // Grid lines joining the guls.
        if (Math.abs(lx) < k * 0.8 || Math.abs(ly) < k * 0.8) { role = ROLE.dark; group = G.fieldMotif }
        if (oct < 1) {
          group = G.medal
          if (oct > 0.9) role = ROLE.dark
          else if (oct > 0.8) role = ROLE.ivory
          else {
            const q = (lx > 0) === (ly > 0)
            role = q ? ROLE.medal : ROLE.medal2
            // Inner hooked motifs in each quarter.
            const qx = Math.abs(lx) / a - 0.36, qy = Math.abs(ly) / b - 0.34
            if (Math.abs(qx) + Math.abs(qy) < 0.16) role = q ? ROLE.ivory : ROLE.gold
            if (oct < 0.22) role = oct < 0.1 ? ROLE.gold : ROLE.ivory
            if (Math.abs(lx) < k * 0.8 || Math.abs(ly) < k * 0.8) role = ROLE.dark
          }
        } else {
          // Minor gul (stepped diamond) on the half-offset grid.
          const mx = lx0 - Math.round(lx0 / sx) * sx, my = ly0 - Math.round(ly0 / syA) * syA
          const sd = Math.abs(Math.round(mx / k)) * k / (sx * 0.16) + Math.abs(Math.round(my / k)) * k / (syA * 0.16)
          if (sd < 1) { group = G.fieldMotif; role = sd < 0.4 ? ROLE.gold : sd < 0.75 ? ROLE.ivory : ROLE.blue }
        }
      }
      design.role[idx] = role
      design.group[idx] = group
    }
  }
}

function kilimDesign(ctx: Ctx, nx: number, ny: number, design: Design): void {
  const { rnd } = ctx
  const k = ctx.knot
  // Bands across the length, mirrored about the middle.
  const bandCount = 3 + Math.floor(rnd() * 3)
  const bandRoles = [ROLE.ground, ROLE.medal, ROLE.ground2, ROLE.dark, ROLE.blue]
  const lozRoles = [ROLE.ivory, ROLE.medal2, ROLE.gold, ROLE.ground, ROLE.green, ROLE.blue]
  const sizes: number[] = []
  let total = 0
  for (let b = 0; b < bandCount; b++) { const s = 0.6 + rnd() * 0.8; sizes.push(s); total += s }
  const stripe = k * (3 + Math.floor(rnd() * 3))
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = (i + 0.5) * k - ctx.Wh, y = (j + 0.5) * k - ctx.Hh
      const ax = Math.abs(x), ay = Math.abs(y)
      const idx = j * nx + i
      let role: number = ROLE.ground, group: number = G.ground
      // Side borders: stepped zig-zag.
      const side = ctx.Wh - ax
      const zw = Math.max(k * 8, ctx.Wh * 0.14)
      if (side < zw) {
        const zz = Math.abs(((Math.floor(ay / (k * 2)) * k * 2) / zw) % 2 - 1)
        role = side / zw < zz * 0.8 + 0.1 ? ROLE.dark : ROLE.ivory
        if (side < k * 1.5) role = ROLE.medal
        design.role[idx] = role; design.group[idx] = G.border; continue
      }
      // Which band are we in (from the centre outward)?
      const t = ay / ctx.Hh
      let acc = 0, band = 0, b0 = 0, b1 = 1
      for (let b = 0; b < bandCount; b++) {
        const nxt = acc + sizes[b]! / total
        if (t <= nxt || b === bandCount - 1) { band = b; b0 = acc; b1 = nxt; break }
        acc = nxt
      }
      const by0 = b0 * ctx.Hh, by1 = b1 * ctx.Hh
      if (ay - by0 < stripe || by1 - ay < stripe) {
        const sIdx = Math.floor((ay - by0) / k) & 1
        role = sIdx ? ROLE.dark : ROLE.gold
        group = G.line
      } else {
        role = bandRoles[band % bandRoles.length]!
        const bh = by1 - by0 - stripe * 2
        const cyb = (by0 + by1) / 2
        const lozW = bh * (0.9 + 0.3 * hash2(band, 1, ctx.seed))
        const cnt = Math.max(1, Math.round(((ctx.Wh - zw) * 2) / lozW))
        const sx = ((ctx.Wh - zw) * 2) / cnt
        const lx0 = x + ctx.Wh - zw
        const lx = lx0 - (Math.floor(lx0 / sx) + 0.5) * sx
        const ly = ay - cyb
        // Stepped lozenge (quantised to 2-knot steps) with hooked rims and a nested inner lozenge.
        const qx = Math.round(lx / (k * 2)) * k * 2, qy = Math.round(ly / (k * 2)) * k * 2
        const d = Math.abs(qx) / (sx * 0.46) + Math.abs(qy) / (bh * 0.46)
        if (d < 1) {
          group = G.fieldMotif
          const lr = lozRoles[(band * 2 + Math.floor(lx0 / sx)) % lozRoles.length]!
          role = d > 0.86 ? ROLE.dark : d > 0.62 ? lr : d > 0.48 ? ROLE.ivory : d > 0.28 ? lozRoles[(band + 3) % lozRoles.length]! : ROLE.dark
        } else if (d < 1.22 && ((Math.floor((lx + ly) / (k * 3)) & 3) === 0)) {
          role = ROLE.dark
          group = G.fieldMotif
        }
      }
      design.role[idx] = role
      design.group[idx] = group
    }
  }
}

function decoDesign(ctx: Ctx, nx: number, ny: number, design: Design): void {
  const { rnd } = ctx
  const k = ctx.knot
  const minDim = Math.min(ctx.Wh, ctx.Hh) * 2
  const bw = Math.max(k * 8, minDim * 0.07 * ctx.spec.borderScale)
  const lightField = rnd() < 0.5
  const fieldRole = lightField ? ROLE.medal : ROLE.ground
  const accent = lightField ? ROLE.ground : ROLE.medal
  const rays = 7 + Math.floor(rnd() * 5)
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = (i + 0.5) * k - ctx.Wh, y = (j + 0.5) * k - ctx.Hh
      const ax = Math.abs(x), ay = Math.abs(y)
      const idx = j * nx + i
      const d = Math.min(ctx.Wh - ax, ctx.Hh - ay)
      let role: number = fieldRole, group: number = G.ground, carve = 0
      if (d < bw) {
        role = ROLE.dark
        group = G.border
        const s = d / bw
        if (Math.abs(s - 0.3) < 0.06 || Math.abs(s - 0.7) < 0.04) { role = ROLE.gold; carve = -60 }
      } else {
        const Fw = ctx.Wh - bw, Fh = ctx.Hh - bw
        // Corner sunburst fans.
        const cx = Fw - ax, cy = Fh - ay
        const cr = Math.hypot(cx, cy)
        const R = Math.min(Fw, Fh) * 0.55
        if (cr < R) {
          const ang = Math.atan2(cy, cx) / (Math.PI / 2)
          const ray = Math.floor(ang * rays)
          role = ray % 2 ? accent : ROLE.gold
          if (cr > R * 0.92) role = ROLE.dark
          else if (cr < R * 0.3) role = cr < R * 0.22 ? ROLE.dark : ROLE.gold
          group = G.spandrel
          carve = -30
        }
        // Central stepped octagon (ziggurat outlines).
        const sq = Math.max(ax / (Fw * 0.5), ay / (Fh * 0.42))
        const oc = Math.max(sq, (ax / (Fw * 0.5) + ay / (Fh * 0.42)) * 0.72)
        const step = Math.round(oc * 9) / 9
        if (oc < 1) {
          group = G.medal
          const ring = Math.floor(step * 9)
          role = ring % 3 === 0 ? ROLE.dark : ring % 3 === 1 ? accent : fieldRole
          if (oc < 0.2) role = ROLE.gold
          if (Math.abs(oc * 9 - Math.round(oc * 9)) < 0.08) { role = ROLE.gold; carve = -70 }
        }
        // Long thin pinstripes across the field.
        if (group === G.ground && Math.abs(((ay / (Fh * 0.18)) % 1) - 0.5) < 0.02) { role = ROLE.gold; group = G.fieldMotif; carve = -40 }
      }
      design.role[idx] = role
      design.group[idx] = group
      design.carve[idx] = carve
    }
  }
}

function makeDesign(ctx: Ctx): Design {
  const nx = Math.max(8, Math.round((ctx.Wh * 2) / ctx.knot))
  const ny = Math.max(8, Math.round((ctx.Hh * 2) / ctx.knot))
  ctx.knot = (ctx.Wh * 2) / nx
  const design: Design = { nx, ny, knot: ctx.knot, role: new Uint8Array(nx * ny), group: new Uint8Array(nx * ny), carve: new Int8Array(nx * ny) }
  switch (ctx.spec.style) {
    case "turkmen": turkmenDesign(ctx, nx, ny, design); break
    case "kilim": kilimDesign(ctx, nx, ny, design); break
    case "deco": decoDesign(ctx, nx, ny, design); break
    default: persianDesign(ctx, 0, 0, nx, ny, design)
  }
  // Outline small field motifs one knot wide where they meet the ground (not on kilims, which have no outlines).
  if (ctx.spec.style === "persian") {
    const role = design.role, group = design.group
    const src = role.slice()
    for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const idx = j * nx + i
      if (group[idx] !== G.ground && group[idx] !== G.medal && group[idx] !== G.spandrel) continue
      const nb = [idx - 1, idx + 1, idx - nx, idx + nx]
      for (const q of nb) {
        if (group[q] === G.fieldMotif && src[q] !== src[idx] && hash2(i, j, ctx.seed + 77) < 0.55) {
          role[idx] = ROLE.dark
          break
        }
      }
    }
  }
  return design
}

// ── pixel rendering ─────────────────────────────────────────────────────────────────────────────────────────────

const SRGB_TO_LIN = new Float32Array(256)
for (let i = 0; i < 256; i++) {
  const c = i / 255
  SRGB_TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
const LIN_TO_SRGB = new Uint8Array(4096)
for (let i = 0; i < 4096; i++) {
  const c = i / 4095
  LIN_TO_SRGB[i] = Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055))
}
const toSrgb = (lin: number) => LIN_TO_SRGB[Math.max(0, Math.min(4095, Math.round(lin * 4095)))]!

/**
 * Bakes a rug into a square RGBA texture at `size` and its full mip chain. Rug long axis runs along v; fringes and
 * the transparent area around an oval sit inside the texture with alpha 0.
 */
export function bakeRug(input: Partial<RugSpec>, size = 1024): RugBake {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now()
  const spec: RugSpec = { ...DEFAULT_RUG_SPEC, ...input }
  const base = renderRug(spec, size)
  const mips = buildRugMips(base, size)
  let r = 0, g = 0, b = 0, n = 0
  const top = mips[Math.max(0, mips.length - 4)]!
  for (let i = 0; i < top.length; i += 4) {
    if (top[i + 3]! < 40) continue
    r += SRGB_TO_LIN[top[i]!]!; g += SRGB_TO_LIN[top[i + 1]!]!; b += SRGB_TO_LIN[top[i + 2]!]!; n++
  }
  n = Math.max(1, n)
  const ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0
  return { size, mips, average: [toSrgb(r / n), toSrgb(g / n), toSrgb(b / n)], ms }
}

/** Fringe length on each short end, as a fraction of the texture's v axis. */
export function rugFringeFraction(spec: Pick<RugSpec, "style" | "fringe" | "length">): number {
  if (!spec.fringe || spec.style === "braided" || spec.style === "shag") return 0
  return Math.min(0.08, 0.07 / Math.max(0.5, spec.length))
}

export function renderRug(spec: RugSpec, size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4)
  const pal = RUG_PALETTES[spec.palette] ?? RUG_PALETTES.madder
  const colors = pal.colors.map(hexToRgb)
  const lin = colors.map(([r, g, b]) => [SRGB_TO_LIN[r]!, SRGB_TO_LIN[g]!, SRGB_TO_LIN[b]!] as const)
  const seed = spec.seed >>> 0
  const W = Math.max(0.3, spec.width), L = Math.max(0.3, spec.length)
  const fringeF = rugFringeFraction(spec)
  const bodyL = L * (1 - fringeF * 2)
  const knot = Math.max(0.003, spec.knotMm / 1000)
  const ctx: Ctx = { spec, Wh: W / 2, Hh: bodyL / 2, knot, rnd: makeRng(seed ^ 0x51ed27), seed }
  const pile = spec.style === "persian" || spec.style === "turkmen" || spec.style === "deco"
  const design = pile || spec.style === "kilim" ? makeDesign(ctx) : null
  const k = design ? design.knot : knot
  const wearSeed = seed + 1013
  // Abrash bands along the length: a few dye-lot shifts with wavy edges.
  const bandCount = 2 + Math.floor(hash2(seed, 3, 9) * 5)
  const bandEdges: number[] = []
  const bandShift: [number, number, number][] = []
  for (let b = 0; b <= bandCount; b++) {
    bandEdges.push(b / bandCount + (b > 0 && b < bandCount ? (hash2(b, seed, 31) - 0.5) * 0.12 : 0))
    const v = (hash2(b, seed, 41) - 0.5) * 0.36
    const hue = (hash2(b, seed, 43) - 0.5) * 0.16
    bandShift.push([1 + v + hue, 1 + v, 1 + v - hue])
  }
  const sunDir = hash2(seed, 5, 51) < 0.5 ? 1 : -1
  const stainSpots: [number, number, number][] = []
  const nStains = Math.round(spec.stains * 6)
  for (let s = 0; s < nStains; s++) stainSpots.push([(hash2(s, seed, 61) - 0.5) * W * 0.8, (hash2(s, seed, 63) - 0.5) * bodyL * 0.8, 0.04 + hash2(s, seed, 65) * 0.12])
  const fadeAmt = clamp01(spec.fade), wearAmt = clamp01(spec.wear), abrash = clamp01(spec.abrash)
  const ivory = lin[ROLE.ivory]!
  const warp: readonly [number, number, number] = [ivory[0] * 0.85, ivory[1] * 0.8, ivory[2] * 0.7]
  const braidColors = [ROLE.ground, ROLE.ground2, ROLE.medal, ROLE.medal2, ROLE.border, ROLE.border2, ROLE.ivory, ROLE.blue]
  const shagA = lin[ROLE.ground]!, shagB = lin[ROLE.ground2]!, shagC = lin[ROLE.medal]!

  for (let py = 0; py < size; py++) {
    const v = (py + 0.5) / size
    const Y = (v - 0.5) * L // metres from centre along the length
    for (let px = 0; px < size; px++) {
      const u = (px + 0.5) / size
      const X = (u - 0.5) * W
      const o = (py * size + px) * 4
      let r = 0, g = 0, b = 0, h = 0
      if (Math.abs(Y) > bodyL / 2) {
        // Fringe: warp threads gathered into small knotted bundles near the rug body.
        if (fringeF <= 0) { out[o + 3] = 0; continue }
        const f = (Math.abs(Y) - bodyL / 2) / (L * fringeF)
        const thread = X / (k * 1.6) + Math.sin(f * 5 + X * 40) * 0.15 * f
        const tf = thread - Math.floor(thread)
        const bundle = Math.floor(thread / 4)
        const len = 0.65 + 0.35 * hash2(bundle, Math.floor(thread), seed + (Y > 0 ? 7 : 8))
        const knotZone = f < 0.18
        const present = knotZone ? true : tf > 0.18 && tf < 0.82 && f < len && Math.abs(X) < W / 2 - k
        if (!present || Math.abs(X) > W / 2) { out[o + 3] = 0; continue }
        const shade = knotZone ? 0.82 + 0.18 * Math.sin(((thread / 4) % 1) * Math.PI) : 0.78 + 0.22 * Math.sin(tf * Math.PI)
        const grime = 0.9 - 0.25 * wearAmt * f
        r = warp[0] * shade * grime; g = warp[1] * shade * grime; b = warp[2] * shade * grime
        h = knotZone ? 0.42 : 0.22 + 0.1 * Math.sin(tf * Math.PI)
      } else if (spec.style === "braided") {
        // Stadium-shaped braided rag rug: concentric 3-strand braids.
        const Rr = W / 2, seg = Math.max(0, bodyL / 2 - Rr)
        const cy = Math.max(-seg, Math.min(seg, Y))
        const dx = X, dy = Y - cy
        const dist = Math.hypot(dx, dy)
        if (dist > Rr) { out[o + 3] = 0; continue }
        const bw = Math.max(0.026, Rr / 13)
        const fromEdge = Rr - dist
        const ring = Math.floor(fromEdge / bw)
        const across = fromEdge / bw - ring
        // Continuous arc length around the stadium so braids run unbroken through the straight sides and the caps.
        const rc = Math.max(bw * 0.5, Rr - (ring + 0.5) * bw)
        let along: number
        if (Math.abs(Y) <= seg) along = X >= 0 ? Y + seg : 2 * seg + Math.PI * rc + (seg - Y)
        else if (Y > seg) along = 2 * seg + Math.atan2(dy, dx) * rc
        else along = 4 * seg + Math.PI * rc + Math.atan2(-dy, -dx) * rc
        const stitch = bw * 0.62
        const phase = along / stitch + Math.abs(across - 0.5) * 1.3
        const fp = phase - Math.floor(phase)
        const strand = (Math.floor(phase) % 3 + 3) % 3
        // Rings come in bands of related colours; each braid's three strands vary within its band.
        const band = Math.floor((ring + Math.floor(hash2(seed, 7, 3) * 3)) / (2 + Math.floor(hash2(ring >> 2, 1, seed) * 3)))
        const baseIdx = Math.floor(hash2(band, 0, seed + 91) * braidColors.length)
        const alt = strand === 1 && hash2(ring, 5, seed) < 0.6 ? 1 : strand === 2 && hash2(ring, 6, seed) < 0.3 ? 2 : 0
        const c = lin[braidColors[(baseIdx + alt) % braidColors.length]!]!
        const bulge = 1 - Math.pow(2 * across - 1, 2)
        const sh = (0.62 + 0.38 * Math.sin(fp * Math.PI)) * (0.4 + 0.6 * bulge) * (0.92 + 0.16 * hash2(ring, strand, seed + 3))
        r = c[0] * sh; g = c[1] * sh; b = c[2] * sh
        h = 0.25 + 0.6 * bulge * (0.7 + 0.3 * Math.sin(fp * Math.PI))
        if (fromEdge < k) h *= 0.8
      } else if (spec.style === "shag") {
        const ex = Math.abs(X) - (W / 2 - 0.04), ey = Math.abs(Y) - (bodyL / 2 - 0.04)
        const corner = ex > 0 && ey > 0 ? Math.hypot(ex, ey) : Math.max(ex, ey)
        if (corner > 0.04) { out[o + 3] = 0; continue }
        // Long tufts: each cell holds a soft strand leaning with the "combed" flow plus its own scatter.
        const cs = 0.009
        const gx = Math.floor(X / cs), gy = Math.floor(Y / cs)
        const flow = fbm(X * 1.4, Y * 1.4, seed + 13) * Math.PI * 4
        let best = 0, bestCol = 0
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
          const hx = gx + i, hy = gy + j
          const ang = flow + (hash2(hx, hy, seed + 3) - 0.5) * 1.6
          const sx = (hx + hash2(hx, hy, seed + 4)) * cs, sy = (hy + hash2(hx, hy, seed + 5)) * cs
          const ux = X - sx, uy = Y - sy
          const along2 = ux * Math.cos(ang) + uy * Math.sin(ang)
          const acr = -ux * Math.sin(ang) + uy * Math.cos(ang)
          const lenS = cs * 1.8
          const wid = cs * 0.55 * (1 - (along2 / lenS) * 0.4)
          if (along2 > -cs * 0.3 && along2 < lenS && Math.abs(acr) < wid) {
            const val = (0.55 + 0.45 * (along2 / lenS)) * (1 - (acr / wid) ** 2 * 0.5)
            if (val > best) { best = val; bestCol = hash2(hx, hy, seed + 6) }
          }
        }
        const mixN = fbm(X * 2.2, Y * 2.2, seed + 9)
        const tone = clamp01(mixN * 1.4 - 0.2 + (bestCol - 0.5) * 0.35)
        const c0 = bestCol < 0.06 ? shagC : shagA
        r = c0[0] + (shagB[0] - c0[0]) * tone; g = c0[1] + (shagB[1] - c0[1]) * tone; b = c0[2] + (shagB[2] - c0[2]) * tone
        const sh = 0.5 + 0.55 * best
        r *= sh; g *= sh; b *= sh
        h = 0.4 + 0.6 * best
        if (corner > 0) h *= 1 - corner / 0.04
      } else if (design) {
        // Knotted or woven body: sample the knot grid with gentle hand-made irregularity.
        const bx = X + W / 2, by = Y + bodyL / 2
        const wobX = (vnoise(by * 2.1, 0.5, seed + 71) - 0.5) * k * 1.4
        const wobY = (vnoise(bx * 1.7, 3.5, seed + 73) - 0.5) * k * 1.1 + (vnoise(bx * 0.6, by * 0.6, seed + 75) - 0.5) * k * 0.8
        const fx = (bx + wobX) / k, fy = (by + wobY) / k
        const ki = Math.min(design.nx - 1, Math.max(0, Math.floor(fx)))
        const kj = Math.min(design.ny - 1, Math.max(0, Math.floor(fy)))
        const di = ki + kj * design.nx
        const role = design.role[di]!
        const c = lin[role]!
        const lu = fx - Math.floor(fx), lv = fy - Math.floor(fy)
        const kh = hash2(ki, kj, seed + 81)
        let shade: number
        if (spec.style === "kilim") {
          // Flat weave: weft ribs across the width, warp ridges showing through.
          shade = (0.82 + 0.18 * Math.sin(lv * Math.PI)) * (0.96 + 0.08 * kh)
          h = 0.32 + 0.1 * Math.sin(lv * Math.PI)
          // Slits where colours change along the weft.
          if (ki + 1 < design.nx && design.role[di + 1] !== role && lu > 0.8) { shade *= 0.35; h = 0.15 }
        } else {
          // Persian knot: two pile tufts per knot read as a soft chevron.
          const tuft = Math.min(Math.hypot(lu - 0.3, lv - 0.5), Math.hypot(lu - 0.7, lv - 0.5))
          shade = (0.8 + 0.28 * (1 - tuft * 1.8)) * (0.93 + 0.12 * kh)
          h = 0.72 + 0.16 * (1 - tuft * 2) + design.carve[di]! / 127 * 0.25
        }
        r = c[0] * shade; g = c[1] * shade; b = c[2] * shade
        // Selvedge: overcast wool along the long sides.
        if (bx < k * 1.2 || bx > W - k * 1.2) {
          const s = 0.7 + 0.3 * Math.sin((by / (k * 1.5)) * Math.PI)
          const dc = lin[ROLE.dark]!
          r = dc[0] * s * 1.4; g = dc[1] * s * 1.4; b = dc[2] * s * 1.4
          h = 0.8
        }
      }
      if (h <= 0) { out[o + 3] = 0; continue }
      const inBody = Math.abs(Y) <= bodyL / 2
      if (inBody) {
        // Abrash: dye-lot bands across the length (strongest on the ground colour, which used the most wool).
        if (abrash > 0 && design) {
          const t = (Y / bodyL + 0.5) + (vnoise(X * 3, Y * 0.5, seed + 33) - 0.5) * 0.03
          let bi = 0
          while (bi < bandCount - 1 && t > bandEdges[bi + 1]!) bi++
          const sh = bandShift[bi]!
          r *= 1 + (sh[0] - 1) * abrash; g *= 1 + (sh[1] - 1) * abrash; b *= 1 + (sh[2] - 1) * abrash
        }
        // Wear: low-frequency patches plus the traffic path down the middle; the pile thins to the foundation.
        if (wearAmt > 0) {
          const path = Math.exp(-((X / (W * 0.28)) ** 2)) * 0.8
          const patch = fbm(X * 2.6, Y * 2.6, wearSeed, 4)
          const wv = clamp01((patch * 0.9 + path * 0.45 - 0.62 + wearAmt * 0.55) * 2.2) * wearAmt
          if (wv > 0) {
            const fine = vnoise(X * 160, Y * 160, wearSeed + 5)
            const bare = clamp01((wv - 0.45 - fine * 0.25) * 3)
            const dim = 1 - wv * 0.3
            r *= dim; g *= dim; b *= dim
            h *= 1 - wv * 0.7
            if (bare > 0 && spec.style !== "shag" && spec.style !== "braided") {
              // Foundation: off-white warps running along the length.
              const wl = 0.75 + 0.25 * Math.sin((X / (k * 0.5)) * Math.PI)
              r += (warp[0] * wl - r) * bare; g += (warp[1] * wl - g) * bare; b += (warp[2] * wl - b) * bare
              h = Math.min(h, 0.18 + 0.05 * wl)
            }
          }
        }
        // Stains: soft dark blotches with tide-line rims.
        for (const [sx, sy, sr] of stainSpots) {
          const d = Math.hypot(X - sx, Y - sy) / sr
          if (d < 1.1) {
            const wob = d + (vnoise(X * 30, Y * 30, seed + 101) - 0.5) * 0.3
            const k2 = wob < 1 ? 0.25 + 0.12 * smooth(0.75, 1, wob) : 0
            r *= 1 - k2; g *= 1 - k2 * 1.05; b *= 1 - k2 * 1.15
          }
        }
      }
      // Fade: sun-bleached toward one side, losing saturation and warming slightly.
      if (fadeAmt > 0) {
        const sun = clamp01(0.55 + sunDir * (X / W) * 0.6 + (fbm(X * 1.3, Y * 1.3, seed + 121) - 0.5) * 0.5) * fadeAmt
        const lum = r * 0.2126 + g * 0.7152 + b * 0.0722
        const tl = lum * 0.85 + 0.035
        r += (tl * 1.06 - r) * sun * 0.75; g += (tl * 1.0 - g) * sun * 0.75; b += (tl * 0.86 - b) * sun * 0.75
      }
      out[o] = toSrgb(r)
      out[o + 1] = toSrgb(g)
      out[o + 2] = toSrgb(b)
      out[o + 3] = Math.max(1, Math.min(255, Math.round(h * 255)))
    }
  }
  return out
}

/** Full mip chain with linear-light colour averaging; alpha is averaged as coverage × height. */
export function buildRugMips(base: Uint8Array, size: number): Uint8Array[] {
  const mips = [base]
  let src = base, s = size
  while (s > 1) {
    const d = Math.max(1, s >> 1)
    const dst = new Uint8Array(d * d * 4)
    for (let y = 0; y < d; y++) for (let x = 0; x < d; x++) {
      let r = 0, g = 0, b = 0, a = 0, wsum = 0
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const sx = Math.min(s - 1, x * 2 + i), sy = Math.min(s - 1, y * 2 + j)
        const o = (sy * s + sx) * 4
        const al = src[o + 3]!
        const w = al > 0 ? 1 : 0.0001
        r += SRGB_TO_LIN[src[o]!]! * w; g += SRGB_TO_LIN[src[o + 1]!]! * w; b += SRGB_TO_LIN[src[o + 2]!]! * w
        wsum += w
        a += al
      }
      const o = (y * d + x) * 4
      dst[o] = toSrgb(r / wsum); dst[o + 1] = toSrgb(g / wsum); dst[o + 2] = toSrgb(b / wsum)
      dst[o + 3] = Math.round(a / 4)
    }
    mips.push(dst)
    src = dst
    s = d
  }
  return mips
}

/** Stable cache key for a spec at a texture size. */
export function rugSpecKey(spec: RugSpec, size: number): string {
  return [spec.style, spec.palette, spec.seed >>> 0, spec.width.toFixed(2), spec.length.toFixed(2), spec.wear.toFixed(2), spec.fade.toFixed(2), spec.abrash.toFixed(2), spec.knotMm.toFixed(1), spec.medallion.toFixed(2), spec.borderScale.toFixed(2), spec.field, spec.fringe ? 1 : 0, spec.stains.toFixed(2), size].join("|")
}

/** Rug kinds a house can ask for; each picks plausible styles and palettes. */
export type RugRoomKind = "living" | "bedroom" | "hall" | "dining" | "study" | "kitchen" | "church" | "lobby"

const ROOM_STYLES: Record<RugRoomKind, readonly (readonly [RugStyle, number])[]> = {
  living: [["persian", 6], ["turkmen", 2], ["deco", 1], ["shag", 1]],
  bedroom: [["persian", 3], ["braided", 2], ["shag", 2], ["kilim", 2], ["turkmen", 1]],
  hall: [["persian", 5], ["kilim", 2], ["turkmen", 2]],
  dining: [["persian", 5], ["turkmen", 2], ["deco", 1]],
  study: [["persian", 3], ["turkmen", 3], ["deco", 2]],
  kitchen: [["braided", 3], ["kilim", 3]],
  church: [["persian", 1]],
  lobby: [["persian", 3], ["deco", 2]],
}

const STYLE_PALETTES: Record<RugStyle, readonly RugPaletteId[]> = {
  persian: ["madder", "madder", "kashan", "tabriz", "antique", "isfahan", "walnut", "mansion", "mansion"],
  turkmen: ["tekke", "tekke", "walnut", "antique"],
  kilim: ["kilim", "kilim", "antique", "madder"],
  deco: ["deco", "deco", "antique", "kashan"],
  braided: ["braid", "braid", "antique"],
  shag: ["shag70s"],
}

/** A plausible rug for a room, entirely from `seed`. Size comes from the placement. */
export function rugSpecFor(seed: number, room: RugRoomKind, width: number, length: number, age = 0.5): RugSpec {
  const rnd = makeRng((seed ^ 0x2c1b3c6d) >>> 0)
  const options = ROOM_STYLES[room]
  let total = 0
  for (const [, w] of options) total += w
  let pick = rnd() * total
  let style: RugStyle = options[0]![0]
  for (const [s, w] of options) { if ((pick -= w) <= 0) { style = s; break } }
  if (room === "hall" && length / width > 2.4 && style === "turkmen") style = "persian"
  const palettes = room === "church" ? (["mansion", "madder"] as const) : STYLE_PALETTES[style]
  const palette = palettes[Math.floor(rnd() * palettes.length)]!
  return {
    style,
    palette,
    seed: Math.floor(rnd() * 1e9),
    width,
    length,
    wear: clamp01(age * 0.5 + rnd() * 0.35),
    fade: clamp01(age * 0.35 + rnd() * 0.3),
    abrash: style === "persian" || style === "turkmen" ? 0.2 + rnd() * 0.5 : 0.1,
    knotMm: style === "persian" ? 5.5 + rnd() * 3.5 : style === "turkmen" ? 6 + rnd() * 3 : 7 + rnd() * 3,
    medallion: style === "persian" ? (rnd() < 0.18 ? 0 : 0.6 + rnd() * 0.45) : 0,
    borderScale: 0.8 + rnd() * 0.45,
    field: PERSIAN_FIELDS[Math.floor(rnd() * PERSIAN_FIELDS.length)]!,
    fringe: style !== "braided" && style !== "shag",
    stains: rnd() * 0.35 * (0.5 + age),
  }
}
