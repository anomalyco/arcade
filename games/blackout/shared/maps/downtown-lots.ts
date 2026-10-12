import type { Rect } from "../geom"
import { T } from "./builder"
import { type Block, FACE, OUT, SHOP_H, type Town, free, overlap, take } from "./downtown-town"
import { type Side, shuffle, step, weighted } from "./geo"
import type { Prop } from "./types"

type Rot = Prop["rot"]
const SIDES: readonly Side[] = ["n", "s", "w", "e"]
const OPP: Record<Side, Side> = { n: "s", s: "n", w: "e", e: "w" }
const horizontal = (s: Side) => s === "n" || s === "s"

/** A building plot: which sides face a street sidewalk and which an alley. */
type Plot = { rect: Rect; fronts: Side[]; alleys: Side[]; edge: boolean; tall: boolean }

/** Length of side s of a rect, and the depth behind it. */
const len = (rc: Rect, s: Side) => (horizontal(s) ? rc[2] - rc[0] : rc[3] - rc[1])
const depth = (rc: Rect, s: Side) => (horizontal(s) ? rc[3] - rc[1] : rc[2] - rc[0])

/**
 * A rect in the frame of side s of `rc`: u along the side (from its west or north end), v inward from it. Lets shop
 * furnishing be written once for any orientation.
 */
function at(rc: Rect, s: Side, u0: number, v0: number, u1: number, v1: number): Rect {
  const [x0, y0, x1, y1] = rc
  if (s === "n") return [x0 + u0, y0 + v0, x0 + u1, y0 + v1]
  if (s === "s") return [x0 + u0, y1 - v1, x0 + u1, y1 - v0]
  if (s === "w") return [x0 + v0, y0 + u0, x0 + v1, y0 + u1]
  return [x1 - v1, y0 + u0, x1 - v0, y0 + u1]
}

/** Splits rc across its `along` axis at the given cut spans (each [a, b] becomes a gap). */
function slice(rc: Rect, along: "x" | "y", gaps: [number, number][]): Rect[] {
  const out: Rect[] = []
  let u = along === "x" ? rc[0] : rc[1]
  for (const [a, b] of [...gaps, along === "x" ? [rc[2], rc[2]] : [rc[3], rc[3]]] as [number, number][]) {
    if (a - u > 0.05) out.push(along === "x" ? [u, rc[1], a, rc[3]] : [rc[0], u, rc[2], a])
    u = b
  }
  return out
}

/** Which sides of a lot have a sidewalk right outside them. */
function frontsOf(t: Town, rc: Rect): Side[] {
  return SIDES.filter((s) => {
    const band: Rect = s === "n" ? [rc[0] + 0.3, rc[1] - 0.4, rc[2] - 0.3, rc[1] - 0.1] : s === "s" ? [rc[0] + 0.3, rc[3] + 0.1, rc[2] - 0.3, rc[3] + 0.4] : s === "w" ? [rc[0] - 0.4, rc[1] + 0.3, rc[0] - 0.1, rc[3] - 0.3] : [rc[2] + 0.1, rc[1] + 0.3, rc[2] + 0.4, rc[3] - 0.3]
    let cover = 0
    for (const w of t.walks) {
      const ox = Math.min(band[2], w.rect[2]) - Math.max(band[0], w.rect[0])
      const oy = Math.min(band[3], w.rect[3]) - Math.max(band[1], w.rect[1])
      if (ox > 0 && oy > 0) cover += horizontal(s) ? ox : oy
    }
    return cover > len(band, s) * 0.5
  })
}

/** Picks what each block holds, then builds them all. */
export function lots(t: Town): void {
  const { r } = t
  const inner = t.blocks.filter((k) => k.kind !== "edge")
  const cx = t.W / 2
  const cy = t.H / 2
  const dist = (k: Block) => Math.hypot((k.rect[0] + k.rect[2]) / 2 - cx, (k.rect[1] + k.rect[3]) / 2 - cy)
  const area = (k: Block) => (k.lot[2] - k.lot[0]) * (k.lot[3] - k.lot[1])
  const short = (k: Block) => Math.min(k.lot[2] - k.lot[0], k.lot[3] - k.lot[1])
  // The plaza near the middle and roomy; the parking lot on a block deep enough for a row of bays and an aisle.
  const plaza = [...inner].sort((a, b) => Number(a.big) - Number(b.big) || dist(a) - area(a) / 12 - (dist(b) - area(b) / 12) + (r.next() - 0.5) * 6)[0]!
  plaza.kind = "plaza"
  const rest = shuffle(r, inner.filter((k) => k.kind === "buildings"))
  // Most blocks stay built up so fights have walls to work round: the plaza, then a parking lot or a park on a small
  // grid, both (now and then) on a bigger one.
  const lotFor = rest.filter((k) => short(k) >= 11.2).sort((a, b) => short(b) - short(a))[0] ?? [...rest].sort((a, b) => short(b) - short(a))[0]
  const park = rest.find((k) => k.big) ?? rest.find((k) => k !== lotFor)
  const extra = inner.length >= 4
  const both = extra && inner.length >= 5 && r.next() < 0.6
  const parkFirst = extra && !both && t.streets.filter((s) => s.park[0] || s.park[1]).length >= 3 && r.next() < 0.45
  if (extra && lotFor && !parkFirst) {
    lotFor.kind = "parking"
    rest.splice(rest.indexOf(lotFor), 1)
  }
  if (park && park.kind === "buildings" && (both || parkFirst)) park.kind = "park"

  const plots: Plot[] = []
  const open: Block[] = []
  for (const k of t.blocks) {
    if (k.kind === "buildings") plots.push(...cut(t, k.lot, frontsOf(t, k.lot), false, k.big))
    else if (k.kind === "edge") plots.push(...cut(t, k.lot, frontsOf(t, k.lot), true, false, k.front))
    else {
      // A long open block keeps a row of buildings along one of its long sides.
      const [x0, y0, x1, y1] = k.lot
      const wide = x1 - x0 >= y1 - y0
      const Lg = wide ? x1 - x0 : y1 - y0
      const Sh = wide ? y1 - y0 : x1 - x0
      const need = k.kind === "parking" ? 11.2 : k.kind === "plaza" ? 14 : 11
      const d = step(r, 6, 8, 0.5)
      if (Lg >= 16 && Sh - d >= need && r.next() < 0.65) {
        const lo = r.next() < 0.5
        const row: Rect = wide ? (lo ? [x0, y0, x1, y0 + d] : [x0, y1 - d, x1, y1]) : lo ? [x0, y0, x0 + d, y1] : [x1 - d, y0, x1, y1]
        const rest: Rect = wide ? (lo ? [x0, y0 + d, x1, y1] : [x0, y0, x1, y1 - d]) : lo ? [x0 + d, y0, x1, y1] : [x0, y0, x1 - d, y1]
        plots.push(...cut(t, row, frontsOf(t, row), false, false))
        open.push({ ...k, lot: rest })
      } else open.push(k)
    }
  }
  // Shops: spread out over the plots with a street front long enough for a door and windows.
  const cands = shuffle(
    r,
    plots.filter((p) => p.fronts.some((s) => len(p.rect, s) >= 5.5 && depth(p.rect, s) >= 5)),
  )
  const want = 3 + r.int(3)
  const shops: Plot[] = []
  for (const p of cands) {
    if (shops.length >= want) break
    const c = { x: (p.rect[0] + p.rect[2]) / 2, y: (p.rect[1] + p.rect[3]) / 2 }
    if (shops.some((q) => Math.hypot((q.rect[0] + q.rect[2]) / 2 - c.x, (q.rect[1] + q.rect[3]) / 2 - c.y) < 14)) continue
    shops.push(p)
  }
  for (const p of plots) {
    if (shops.includes(p)) shop(t, p)
    else building(t, p.rect, p)
  }
  for (const k of open) {
    if (k.kind === "plaza") plazaBlock(t, k)
    else if (k.kind === "parking") parkingBlock(t, k)
    else if (k.kind === "park") parkBlock(t, k)
  }
}

/**
 * Cuts a block's lot into building plots: deep superblocks get an alley down the middle, long lots alleys across
 * (through to the next street, or dead-end pockets into an edge strip), then each part splits into frontages.
 */
function cut(t: Town, lot: Rect, fronts: Side[], edge: boolean, big: boolean, face?: Side): Plot[] {
  const { r, b } = t
  const wide = face ? horizontal(face) : lot[2] - lot[0] >= lot[3] - lot[1]
  const along = wide ? "x" : "y"
  const Lg = wide ? lot[2] - lot[0] : lot[3] - lot[1]
  const Sh = wide ? lot[3] - lot[1] : lot[2] - lot[0]
  const alleys: Rect[] = []
  let parts: Rect[] = [lot]
  if (!edge && Sh >= 16 && (big || r.next() < 0.6)) {
    const aw = step(r, 2.5, 3.5, 0.5)
    const u = (wide ? lot[1] : lot[0]) + step(r, 6, Sh - 6 - aw, 0.5)
    parts = slice(lot, wide ? "y" : "x", [[u, u + aw]])
    alleys.push(wide ? [lot[0], u, lot[2], u + aw] : [u, lot[1], u + aw, lot[3]])
  }
  const out: Rect[] = []
  for (const p of parts) {
    const pl = along === "x" ? p[2] - p[0] : p[3] - p[1]
    const n = edge ? (pl >= 26 && r.next() < 0.7 ? 1 : 0) : pl >= 34 ? 2 : pl >= 14 && r.next() < 0.75 ? 1 : 0
    const gaps: [number, number][] = []
    const m = edge ? 6.5 : 5.5
    let lo = (along === "x" ? p[0] : p[1]) + m
    for (let k = 0; k < n; k++) {
      const aw = step(r, 2.5, 3, 0.5)
      const hi = (along === "x" ? p[2] : p[3]) - m - aw - (n - 1 - k) * 10
      if (hi < lo) break
      const u = step(r, lo, hi, 0.5)
      gaps.push([u, u + aw])
      lo = u + aw + 7
    }
    for (const [a, z] of gaps) {
      let rc: Rect = along === "x" ? [a, p[1], z, p[3]] : [p[0], a, p[2], z]
      if (edge) {
        // A dead-end pocket in from the sidewalk; the building behind closes it off.
        const f = face
        if (f) {
          const d = depth(p, f) - step(r, 1.5, 2.5, 0.5)
          const back: Rect = f === "n" ? [rc[0], rc[1] + d, rc[2], rc[3]] : f === "s" ? [rc[0], rc[1], rc[2], rc[3] - d] : f === "w" ? [rc[0] + d, rc[1], rc[2], rc[3]] : [rc[0], rc[1], rc[2] - d, rc[3]]
          rc = f === "n" ? [rc[0], rc[1], rc[2], rc[1] + d] : f === "s" ? [rc[0], rc[3] - d, rc[2], rc[3]] : f === "w" ? [rc[0], rc[1], rc[0] + d, rc[3]] : [rc[2] - d, rc[1], rc[2], rc[3]]
          b.wall(...back, step(r, 6.5, 9, 0.5), "building", r.int(1 << 16))
        }
      }
      alleys.push(rc)
    }
    out.push(...slice(p, along, gaps))
  }
  for (const a of alleys) alley(t, a)
  // Frontages: each part split along its length into buildings 5.5 to 10 m wide, and a deep part split down the
  // middle into two rows back to back.
  const plots: Plot[] = []
  const rows: Rect[] = []
  for (const p of out) {
    const w = p[2] - p[0] >= p[3] - p[1]
    const sh = w ? p[3] - p[1] : p[2] - p[0]
    if (!edge && sh >= 11) {
      const m = (w ? p[1] : p[0]) + step(r, sh * 0.4, sh * 0.6, 0.5)
      rows.push(...slice(p, w ? "y" : "x", [[m, m]]))
    } else rows.push(p)
  }
  for (const p of rows) {
    const w = face ? horizontal(face) : p[2] - p[0] >= p[3] - p[1]
    const pl = w ? p[2] - p[0] : p[3] - p[1]
    const cuts: [number, number][] = []
    let u = (w ? p[0] : p[1]) + step(r, 5.5, 10, 0.5)
    while ((w ? p[2] : p[3]) - u >= 5) {
      cuts.push([u, u])
      u += step(r, 5.5, 10, 0.5)
    }
    for (const rc of pl >= 10.5 ? slice(p, w ? "x" : "y", cuts) : [p]) {
      const fr = fronts.filter((s) => Math.abs(lineOf(rc, s) - lineOf(lot, s)) < 1e-6)
      const al = SIDES.filter((s) => alleys.some((a) => touches(rc, s, a)))
      plots.push({ rect: rc, fronts: fr, alleys: al, edge, tall: edge && fronts[0] !== "n" })
    }
  }
  return plots
}

const lineOf = (rc: Rect, s: Side) => (s === "n" ? rc[1] : s === "s" ? rc[3] : s === "w" ? rc[0] : rc[2])

/** Whether side s of rc lies along rect a (sharing its line, overlapping along it). */
function touches(rc: Rect, s: Side, a: Rect): boolean {
  const E = 1e-6
  if (s === "n") return Math.abs(rc[1] - a[3]) < E && rc[0] < a[2] && rc[2] > a[0]
  if (s === "s") return Math.abs(rc[3] - a[1]) < E && rc[0] < a[2] && rc[2] > a[0]
  if (s === "w") return Math.abs(rc[0] - a[2]) < E && rc[1] < a[3] && rc[3] > a[1]
  return Math.abs(rc[2] - a[0]) < E && rc[1] < a[3] && rc[3] > a[1]
}

/** A solid building: walls all the way up, roof dressing drawn by the renderer from `v`. */
function building(t: Town, rc: Rect, p: Pick<Plot, "edge" | "tall">): void {
  const h = p.tall ? step(t.r, 6.5, 9.5, 0.5) : p.edge ? step(t.r, 4.5, 6, 0.5) : step(t.r, 4.5, 7, 0.5)
  t.b.wall(...rc, h, "building", t.r.int(1 << 16))
}

/** Alley: bare concrete, dumpsters and crates against the walls, maybe a bulb over a back door. */
function alley(t: Town, a: Rect): void {
  const { b, r } = t
  b.floor("concrete", ...a)
  const wide = a[2] - a[0] >= a[3] - a[1]
  const L = wide ? a[2] - a[0] : a[3] - a[1]
  const W = wide ? a[3] - a[1] : a[2] - a[0]
  if (W < 2.4) return
  const R = (u0: number, v0: number, u1: number, v1: number): Rect => (wide ? [a[0] + u0, a[1] + v0, a[0] + u1, a[1] + v1] : [a[0] + v0, a[1] + u0, a[0] + v1, a[1] + u1])
  // Things go along one wall at a time so a 1.4 m path always stays clear.
  for (let u = 1.2 + r.next() * 2; u < L - 2.5; u += 2.6 + r.next() * 3) {
    const side = r.next() < 0.5 ? 0 : 1
    const roll = r.next()
    if (roll < 0.4) {
      const rc = side ? R(u, W - 1.0, u + 1.8, W - 0.05) : R(u, 0.05, u + 1.8, 1.0)
      b.wall(...rc, 1.25, "dumpster", r.int(1 << 16) * 2 + side)
      take(t, rc)
      u += 1
    } else if (roll < 0.7) {
      const rc = side ? R(u, W - 0.8, u + 0.75, W - 0.05) : R(u, 0.05, u + 0.75, 0.8)
      b.prop("crate", ...rc, 0)
      take(t, rc)
    } else if (roll < 0.85) {
      const rc = side ? R(u, W - 0.7, u + 1.1, W - 0.05) : R(u, 0.05, u + 1.1, 0.7)
      b.prop("bags", ...rc, side ? (wide ? 2 : 1) : wide ? 0 : 3, false)
    }
  }
  if (L > 6 && r.next() < 0.6) {
    const c = R(L * (0.3 + r.next() * 0.4), W / 2, 0, 0)
    t.lit.push({ x: c[0], y: c[1] })
    b.light({ kind: "bulb", x: c[0], y: c[1], h: 2.9, r: 5.5, power: 0.85, color: [1, 0.7, 0.4], flicker: r.next() < 0.4 ? r.range(0.3, 0.8) : undefined })
  }
}

// Shops ---------------------------------------------------------------------------------------------------------------

type ShopKind = "diner" | "bar" | "store" | "lobby" | "cafe"
const NEON: Record<ShopKind, { text: string[]; color: readonly [number, number, number] }> = {
  diner: { text: ["DINER", "EAT"], color: [0.2, 0.95, 1] },
  bar: { text: ["BAR", "LIVE"], color: [1, 0.2, 0.75] },
  store: { text: ["24/7", "OPEN"], color: [0.25, 0.85, 1] },
  lobby: { text: ["HOTEL"], color: [1, 0.3, 0.55] },
  cafe: { text: ["CAFE", "PIZZA"], color: [1, 0.55, 0.2] },
}

/**
 * An enterable shop on the ground floor: a front of windows with a door onto the street, another door on a side street
 * or alley when it has one, furnished by kind, lit inside, a neon sign over the door. Deep plots keep a solid building
 * behind the shop.
 */
function shop(t: Town, p: Plot): void {
  const { b, r } = t
  const front = [...p.fronts].sort((a, c) => len(p.rect, c) - len(p.rect, a))[0]!
  let rc = p.rect
  const D = depth(rc, front)
  if (D > 11) {
    const d = step(r, 7.5, 9.5, 0.5)
    const back = at(rc, OPP[front], 0, 0, len(rc, front), D - d)
    // `at` measures u from the west or north end for every side, so this covers the full width.
    building(t, back, p)
    rc = at(rc, front, 0, 0, len(rc, front), d)
  }
  const kind = weighted(r, [["diner", 1], ["bar", 1], ["store", 1.2], ["lobby", 0.5], ["cafe", 0.7]] as const)
  b.floor(kind === "bar" ? "wood" : kind === "lobby" ? "wood" : "tile", ...rc)
  const doors: { side: Side; u: number; w: number }[] = []
  for (const s of SIDES) {
    const L = len(rc, s)
    const sideOf = Math.abs(lineOf(rc, s) - lineOf(p.rect, s)) > 1e-6 ? "back" : p.fronts.includes(s) ? "street" : p.alleys.includes(s) ? "alley" : "wall"
    const isFront = s === front
    const opens = isFront || ((sideOf === "street" || sideOf === "alley") && L >= 3 && r.next() < 0.8)
    const dw = sideOf === "alley" ? 1.2 : 1.6
    const du = opens ? step(r, Math.min(L * 0.3, L - dw - 0.6), Math.max(L * 0.3, L * 0.7 - dw), 0.1) : -1
    if (opens) doors.push({ side: s, u: du, w: dw })
    const wallRc = (u0: number, u1: number) => at(rc, s, u0, 0, u1, T)
    const glazed = sideOf === "street"
    const piece = (u0: number, u1: number) => {
      if (u1 - u0 < 0.05) return
      if (glazed && u1 - u0 > 1.4) {
        b.wall(...wallRc(u0, u0 + 0.5), SHOP_H, "shop")
        b.windows.push(wallRc(u0 + 0.5, u1 - 0.5))
        b.wall(...wallRc(u1 - 0.5, u1), SHOP_H, "shop")
      } else b.wall(...wallRc(u0, u1), SHOP_H, "shop")
    }
    if (opens) {
      piece(0, du)
      piece(du + dw, L)
    } else piece(0, L)
  }
  const inner: Rect = [rc[0] + T + 0.02, rc[1] + T + 0.02, rc[2] - T - 0.02, rc[3] - T - 0.02]
  const keep: Rect[] = doors.map((d) => at(inner, d.side, d.u - 0.5 - T, 0, d.u + d.w + 0.5 - T, 1.6))
  const f = new Fit(t, inner, front, keep)
  if (kind === "diner") diner(f)
  else if (kind === "bar") bar(f)
  else if (kind === "store") store(f)
  else if (kind === "cafe") cafe(f)
  else lobby(f)
  // The sign over the main door, out on the facade.
  const d = doors[0]!
  const n = NEON[kind]
  const text = r.pick(n.text)
  const sl = Math.min(len(rc, front) - 0.6, 0.55 * text.length + 0.5)
  const su = Math.max(0.3, Math.min(len(rc, front) - sl - 0.3, d.u + d.w / 2 - sl / 2))
  const sign = at(rc, front, su, -0.16, su + sl, 0)
  const [ox, oy] = OUT[front]
  const mx = (sign[0] + sign[2]) / 2 + ox * 0.7
  const my = (sign[1] + sign[3]) / 2 + oy * 0.7
  const id = b.light({ kind: "neon", x: mx, y: my, h: 2.9, r: 7, power: 1.1, color: n.color, cone: [ox, oy, -0.35], flicker: r.next() < 0.2 ? 0.25 : undefined })
  b.props.push({ kind: "neon", rect: sign, rot: FACE[front], solid: false, light: id >= 0 ? id : undefined, text })
  t.lit.push({ x: mx, y: my })
  take(t, at(rc, front, d.u - 0.6, -1.4, d.u + d.w + 0.6, 0))
  t.shops++
}

/** Furnishing context for a shop: its floor inside the walls, the street side, and doorways to keep clear. */
class Fit {
  placed: Rect[] = []
  constructor(
    readonly t: Town,
    readonly inner: Rect,
    readonly front: Side,
    readonly keep: Rect[],
  ) {}
  get back(): Side {
    return OPP[this.front]
  }
  get flanks(): [Side, Side] {
    return horizontal(this.front) ? ["w", "e"] : ["n", "s"]
  }
  len(s: Side) {
    return len(this.inner, s)
  }
  depth(s: Side) {
    return depth(this.inner, s)
  }
  at(s: Side, u0: number, v0: number, u1: number, v1: number): Rect {
    return at(this.inner, s, u0, v0, u1, v1)
  }
  fits(rc: Rect, gap = 0.06): boolean {
    const [x0, y0, x1, y1] = this.inner
    if (rc[0] < x0 - 0.01 || rc[1] < y0 - 0.01 || rc[2] > x1 + 0.01 || rc[3] > y1 + 0.01) return false
    if (this.keep.some((k) => overlap(k, rc))) return false
    return !this.placed.some((q) => overlap(q, rc, gap))
  }
  put(kind: Prop["kind"], rc: Rect, rot: Rot, solid = true, light?: number): boolean {
    if (!this.fits(rc)) return false
    this.t.b.prop(kind, ...rc, rot, solid, light)
    this.placed.push(rc)
    return true
  }
  shelf(rc: Rect, h: number): boolean {
    if (!this.fits(rc, 0.02)) return false
    this.t.b.wall(...rc, h, "shelf")
    this.placed.push(rc)
    return true
  }
  light(kind: "pendant" | "bulb" | "panel", x: number, y: number, color?: readonly [number, number, number]): void {
    const spec = { pendant: { h: 2.6, r: 6, power: 1, color: [1, 0.72, 0.42] as const }, bulb: { h: 2.6, r: 5, power: 0.9, color: [1, 0.7, 0.4] as const }, panel: { h: 2.9, r: 6.5, power: 0.9, color: [0.8, 0.88, 1] as const } }[kind]
    this.t.b.light({ kind, x, y, ...spec, color: color ?? spec.color })
    this.t.lit.push({ x, y })
  }
  get cx() {
    return (this.inner[0] + this.inner[2]) / 2
  }
  get cy() {
    return (this.inner[1] + this.inner[3]) / 2
  }
}

const FACE_IN: Record<Side, Rot> = { n: 0, s: 2, w: 3, e: 1 }

/** A table with chairs on two or four sides. */
function table(f: Fit, x: number, y: number, w: number, d: number, four: boolean): void {
  if (!f.put("table", [x - w / 2, y - d / 2, x + w / 2, y + d / 2], 0)) return
  f.put("chair", [x - 0.22, y - d / 2 - 0.55, x + 0.22, y - d / 2 - 0.1], 0, false)
  f.put("chair", [x - 0.22, y + d / 2 + 0.1, x + 0.22, y + d / 2 + 0.55], 2, false)
  if (four) {
    f.put("chair", [x - w / 2 - 0.55, y - 0.22, x - w / 2 - 0.1, y + 0.22], 3, false)
    f.put("chair", [x + w / 2 + 0.1, y - 0.22, x + w / 2 + 0.55, y + 0.22], 1, false)
  }
}

/** Counter along the back with stools, booths down the windows, a fridge, warm pendants. */
function diner(f: Fit): void {
  const back = f.back
  const L = f.len(back)
  const D = f.depth(back)
  const cl = Math.min(L - 1.6, Math.max(2, L * 0.65))
  const cu = f.t.r.next() < 0.5 ? 0.2 : L - cl - 0.2
  f.put("counter", f.at(back, cu, 0, cu + cl, 0.7), FACE_IN[back])
  f.put("fridge", f.at(back, cu > 1 ? 0.1 : L - 0.95, 0, cu > 1 ? 0.95 : L - 0.1, 0.8), FACE_IN[back])
  if (D >= 4.6) for (let u = cu + 0.35; u < cu + cl - 0.3; u += 0.75) f.put("stool", f.at(back, u - 0.2, 1.05, u + 0.2, 1.45), FACE_IN[back], false)
  // Booths: sofa, table, sofa, end-on to the front windows.
  const fr = f.front
  for (let u = 0.15; u + 2.3 <= f.len(fr) && D >= 5.2; u += 2.6) {
    const a = f.at(fr, u, 0.1, u + 0.7, 1.5)
    const tb = f.at(fr, u + 0.8, 0.25, u + 1.5, 1.35)
    const c = f.at(fr, u + 1.6, 0.1, u + 2.3, 1.5)
    if (!f.fits(a) || !f.fits(tb) || !f.fits(c)) continue
    const rotA: Rot = horizontal(fr) ? 3 : 2
    const rotC: Rot = horizontal(fr) ? 1 : 0
    f.put("sofa", a, rotA)
    f.put("table", tb, 0)
    f.put("sofa", c, rotC)
  }
  f.light("pendant", f.cx, f.cy)
  if (L * D > 40) f.light("pendant", (f.cx + f.inner[0]) / 2 + (f.inner[2] - f.inner[0]) * 0.1, (f.cy + f.inner[1]) / 2 + (f.inner[3] - f.inner[1]) * 0.1, [1, 0.6, 0.35])
}

/** A long bar down one side with stools, bottles on the wall behind, round tables, low light. */
function bar(f: Fit): void {
  const [s] = f.t.r.next() < 0.5 ? f.flanks : [f.flanks[1], f.flanks[0]]
  const L = f.len(s!)
  const bl = Math.max(2, L - 1.8)
  const bu = f.front === "n" || f.front === "w" ? L - bl - 0.1 : 0.1
  f.put("bookshelf", f.at(s!, bu, 0, bu + bl, 0.4), FACE_IN[s!])
  f.put("counter", f.at(s!, bu, 1.2, bu + bl, 1.85), FACE_IN[OPP[s!]])
  for (let u = bu + 0.35; u < bu + bl - 0.3; u += 0.8) f.put("stool", f.at(s!, u - 0.2, 2.05, u + 0.2, 2.45), FACE_IN[s!], false)
  const o = OPP[s!]
  const room = f.depth(o) - 3
  if (room >= 2.2) {
    for (let u = 1.2; u < f.len(o) - 1; u += 2.4) {
      const c = f.at(o, u, room / 2 + 0.2, u, room / 2 + 0.2)
      table(f, c[0], c[1], 0.8, 0.8, false)
    }
  }
  f.put("plant", f.at(f.back, 0.1, 0.1, 0.75, 0.75), 0)
  f.light("pendant", f.cx, f.cy, [1, 0.45, 0.6])
}

/** Aisles of shelving parallel to the front, a glowing wall of drinks coolers at the back, a till by the door. */
function store(f: Fit): void {
  const back = f.back
  const L = f.len(back)
  const D = f.depth(back)
  const n = Math.max(1, Math.floor((L - 0.4) / 1.5))
  const u0 = (L - n * 1.5) / 2
  for (let k = 0; k < n; k++) f.put("vending", f.at(back, u0 + k * 1.5 + 0.05, 0, u0 + k * 1.5 + 1.45, 0.8), FACE_IN[back], true, k === Math.floor(n / 2) ? coolerLight(f, back) : undefined)
  for (let v = 2.2; v + 0.6 <= D - 2.2; v += 1.9) {
    const gap = L > 6 ? L * (0.35 + f.t.r.next() * 0.3) : -1
    const runs: [number, number][] = gap > 0 ? [[0.9, gap - 0.7], [gap + 0.7, L - 0.9]] : [[0.9, L - 0.9]]
    for (const [a, z] of runs) if (z - a >= 1.2) f.shelf(f.at(back, a, v, z, v + 0.6), 1.5)
  }
  const s = f.flanks[f.t.r.int(2)]!
  f.put("counter", f.at(s, f.front === "n" || f.front === "w" ? 0.1 : f.len(s) - 2.1, 0, f.front === "n" || f.front === "w" ? 2.1 : f.len(s) - 0.1, 0.7), FACE_IN[s])
  f.light("panel", f.cx, f.cy)
}

function coolerLight(f: Fit, back: Side): number {
  const c = f.at(back, f.len(back) / 2, 1.1, f.len(back) / 2, 1.1)
  const [dx, dy] = OUT[OPP[back]]
  return f.t.b.light({ kind: "vending", x: c[0], y: c[1], h: 1.2, r: 5.5, power: 1, color: [0.25, 0.85, 1], cone: [dx, dy, -0.25] })
}

/** Small tables by the window, a counter with the coffee machine at the back. */
function cafe(f: Fit): void {
  const back = f.back
  const L = f.len(back)
  f.put("counter", f.at(back, 0.4, 0, Math.max(1.6, L - 1.2), 0.7), FACE_IN[back])
  const D = f.depth(back)
  for (let v = 1.8; v < D - 1.6; v += 2.0) for (let u = 1.1; u < L - 0.9; u += 2.1) {
    const c = f.at(back, u, v + 0.4, u, v + 0.4)
    table(f, c[0], c[1], 0.75, 0.75, false)
  }
  f.put("plant", f.at(f.front, 0.1, 0.1, 0.7, 0.7), 0)
  f.light("pendant", f.cx, f.cy)
}

/** A hotel lobby: reception facing the door, sofas, plants. */
function lobby(f: Fit): void {
  const back = f.back
  const L = f.len(back)
  f.put("reception", f.at(back, L / 2 - 1.2, 1.0, L / 2 + 1.2, 1.8), FACE_IN[OPP[back]])
  f.put("chair", f.at(back, L / 2 - 0.25, 0.3, L / 2 + 0.25, 0.8), FACE_IN[back], false)
  for (const s of f.flanks) f.put("sofa", f.at(s, f.len(s) / 2 - 1, 0.05, f.len(s) / 2 + 1, 0.85), FACE_IN[s])
  f.put("plant", f.at(back, 0.1, 0.1, 0.75, 0.75), 0)
  f.put("plant", f.at(back, L - 0.75, 0.1, L - 0.1, 0.75), 0)
  f.light("pendant", f.cx, f.cy, [1, 0.62, 0.4])
}

// Open blocks ---------------------------------------------------------------------------------------------------------

/** The plaza: paving, a lit fountain in the middle ringed by planters and benches, a subway entrance, lamps at the corners. */
function plazaBlock(t: Town, k: Block): void {
  const { b, r } = t
  const [x0, y0, x1, y1] = k.lot
  b.floor("plaza", ...k.lot)
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const fr = Math.min(2.2, (Math.min(x1 - x0, y1 - y0) - 4.4) / 2)
  if (fr >= 1.2) {
    const rc: Rect = [cx - fr, cy - fr, cx + fr, cy + fr]
    b.wall(...rc, 0.75, "fountain")
    take(t, [rc[0] - 1.2, rc[1] - 1.2, rc[2] + 1.2, rc[3] + 1.2])
    b.light({ kind: "glow", x: cx, y: cy, h: 0.9, r: 6, power: 1, color: [0.2, 0.8, 1] })
    t.lit.push({ x: cx, y: cy })
  }
  // Subway entrance: a railed stairwell along one side of the plaza, glowing up out of the ground.
  const spots = shuffle(r, SIDES.flatMap((side) => [0.2, 0.5, 0.8].map((f) => ({ side, f }))))
  for (const { side, f } of spots) {
    const sl = 4.6
    const sd = 2.2
    const L = horizontal(side) ? x1 - x0 : y1 - y0
    if (depth(k.lot, side) < sd + 4) continue
    const u = Math.max(0.6, Math.min(L - sl - 0.6, L * f - sl / 2))
    const rc = at(k.lot, side, u, 0.9, u + sl, 0.9 + sd)
    if (!free(t, rc, 0.6)) continue
    b.wall(...rc, 1.05, "subway", side === "n" ? 0 : side === "s" ? 1 : side === "w" ? 2 : 3)
    take(t, [rc[0] - 0.8, rc[1] - 0.8, rc[2] + 0.8, rc[3] + 0.8])
    const sx = (rc[0] + rc[2]) / 2
    const sy = (rc[1] + rc[3]) / 2
    b.light({ kind: "glow", x: sx, y: sy, h: 1.6, r: 6.5, power: 1.1, color: [0.55, 0.85, 1] })
    t.lit.push({ x: sx, y: sy })
    break
  }
  // Planters on the diagonals, benches facing in between them.
  const dx = Math.min(fr + 3.2, (x1 - x0) / 2 - 1.2)
  const dy = Math.min(fr + 3.2, (y1 - y0) / 2 - 1.2)
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const px = cx + sx * dx
    const py = cy + sy * dy
    const rc: Rect = [px - 0.7, py - 0.7, px + 0.7, py + 0.7]
    if (free(t, rc, 0.4)) {
      b.wall(...rc, 0.85, "planter", r.int(1 << 16))
      take(t, rc)
    }
  }
  for (const s of SIDES) {
    if (r.next() < 0.25) continue
    const [ox, oy] = OUT[s]
    const d = horizontal(s) ? dy : dx
    const bx = cx + ox * d
    const by = cy + oy * d
    const rc: Rect = horizontal(s) ? [bx - 0.9, by - 0.3, bx + 0.9, by + 0.3] : [bx - 0.3, by - 0.9, bx + 0.3, by + 0.9]
    if (free(t, rc, 0.2)) {
      b.prop("bench", ...rc, FACE[OPP[s]], true)
      take(t, rc)
    }
  }
  // Trees in the corners of the paving.
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    if (r.next() < 0.3) continue
    const px = sx < 0 ? x0 + 1.4 : x1 - 1.4
    const py = sy < 0 ? y0 + 1.4 : y1 - 1.4
    const rc: Rect = [px - 0.35, py - 0.35, px + 0.35, py + 0.35]
    if (free(t, rc, 0.5)) {
      b.prop("tree", ...rc, r.int(4) as Rot, true)
      take(t, [rc[0] - 0.6, rc[1] - 0.6, rc[2] + 0.6, rc[3] + 0.6])
    }
  }
  // Lamps at two or three corners of the paving.
  for (const [sx, sy] of shuffle(r, [[-1, -1], [1, -1], [-1, 1], [1, 1]] as [number, number][]).slice(0, 2 + r.int(2))) {
    const px = sx < 0 ? x0 + 0.5 : x1 - 0.5
    const py = sy < 0 ? y0 + 0.5 : y1 - 0.5
    lampAt(t, px, py, sy < 0 ? 0 : 2, 4.4)
  }
}

/** A park lamp: a post with the lamp right on top (no arm), warm. */
function lampAt(t: Town, x: number, y: number, rot: Rot, h: number): void {
  const rc: Rect = [x - 0.15, y - 0.15, x + 0.15, y + 0.15]
  if (!free(t, rc, 0.3)) return
  const id = t.b.light({ kind: "street", x, y, h, r: 8.5, power: 1, color: [1, 0.66, 0.34] })
  t.b.prop("parklamp", ...rc, rot, true, id)
  take(t, rc)
  t.lit.push({ x, y })
}

/**
 * A fenced parking lot: rows of bays either side of drive aisles along its length, cars in most bays, a floodlight on a
 * tall pole, a dumpster in a corner. Gaps in the fence on every side let you through.
 */
function parkingBlock(t: Town, k: Block): void {
  const { b, r } = t
  const lot = k.lot
  b.floor("parking", ...lot)
  const [x0, y0, x1, y1] = lot
  const wide = x1 - x0 >= y1 - y0
  const Lg = wide ? x1 - x0 : y1 - y0
  const Sh = wide ? y1 - y0 : x1 - x0
  const R = (u0: number, v0: number, u1: number, v1: number): Rect => (wide ? [x0 + u0, y0 + v0, x0 + u1, y0 + v1] : [x0 + v0, y0 + u0, x0 + v1, y0 + u1])
  // Fence round the edge with a gap in each side; the long sides' gaps line up with the aisles.
  const F = 0.12
  const fence = (s: Side, gaps: [number, number][]) => {
    const L = len(lot, s)
    let u = 0
    for (const [a, z] of [...gaps].sort((p, q) => p[0] - q[0])) {
      if (a - u > 0.2) b.wall(...at(lot, s, u, 0, a, F), 1.15, "fence")
      u = z
    }
    if (L - u > 0.2) b.wall(...at(lot, s, u, 0, L, F), 1.15, "fence")
  }
  // Across the short side: [bay 5][aisle 6][bay 5] repeated, or one row and an aisle, the rest as margin. A narrow
  // lot gets cars parked along both edges of a single aisle instead.
  const rows: { v: number; flip: boolean }[] = []
  const aisles: number[] = []
  let v = 0.6
  while (v + 16 <= Sh - 0.4) {
    rows.push({ v, flip: false })
    aisles.push(v + 5)
    rows.push({ v: v + 11, flip: true })
    v += 16.4
  }
  if (!rows.length && Sh >= 11.2) {
    rows.push({ v: 0.6, flip: false })
    aisles.push(5.6)
  }
  const lanes = !rows.length && Sh >= 8
  if (lanes) aisles.push(2.7)
  const endGap = (s: Side): [number, number][] => {
    // Ends (short sides): openings at the aisles. Long sides: one pedestrian gap.
    if ((wide && !horizontal(s)) || (!wide && horizontal(s))) return aisles.length ? aisles.map((a) => [a + 0.5, a + 5.5] as [number, number]) : [[Sh / 2 - 2, Sh / 2 + 2]]
    const g = Lg * (0.3 + r.next() * 0.4)
    return [[g, g + 1.8]]
  }
  for (const s of SIDES) fence(s, endGap(s))
  const bayW = 2.6
  const n = Math.floor((Lg - 2) / bayW)
  const u0 = (Lg - n * bayW) / 2
  let wreck = r.next() < 0.35
  // A drivable jeep or van in one of the bays.
  let ride = true
  if (lanes)
    for (const vv of [0.3, Sh - 2.4])
      for (let u = 1 + r.next() * 2; u + 4.6 <= Lg - 1; u += 5.6 + r.next() * 2) if (r.next() < 0.7) parkedCar(t, R(u, vv, u + 4.6, vv + 2.1), wide ? "x" : "y", vv > 1)
  for (const row of rows) {
    for (let i = 0; i <= n; i++) {
      const u = u0 + i * bayW
      b.paint.push({ rect: R(u - 0.05, row.v, u + 0.05, row.v + 4.8), color: "white" })
    }
    for (let i = 0; i < n; i++) {
      const u = u0 + i * bayW
      if (r.next() < 0.22) continue
      const rc = R(u + 0.35, row.v + 0.3, u + bayW - 0.35, row.v + 4.7)
      if (wreck && i > 0 && i < n - 1 && r.next() < 0.3) {
        wreckAt(t, rc, wide ? "y" : "x")
        wreck = false
        continue
      }
      if (ride && i >= n / 3 && r.next() < 0.4) {
        const cx = (rc[0] + rc[2]) / 2
        const cy = (rc[1] + rc[3]) / 2
        const kind = r.next() < 0.6 ? "jeep" : "van"
        const box: Rect = wide ? [cx - 1.15, cy - 2.6, cx + 1.15, cy + 2.6] : [cx - 2.6, cy - 1.15, cx + 2.6, cy + 1.15]
        if (free(t, box, 0.1)) {
          // Nose out toward the aisle.
          t.vehicles.push({ kind, x: cx, y: cy, heading: wide ? (row.flip ? -Math.PI / 2 : Math.PI / 2) : row.flip ? Math.PI : 0 })
          take(t, box)
          ride = false
          continue
        }
      }
      parkedCar(t, rc, wide ? "y" : "x", row.flip)
    }
  }
  // Floodlight on a tall pole in the margin of a row end, a dumpster in a corner.
  const pv = rows.length ? rows[0]!.v + 2.4 : Sh / 2
  const pu = r.next() < 0.5 ? u0 * 0.5 + 0.1 : Lg - u0 * 0.5 - 0.1
  const pc = R(pu, pv, pu, pv)
  const pole: Rect = [pc[0] - 0.18, pc[1] - 0.18, pc[0] + 0.18, pc[1] + 0.18]
  if (u0 >= 0.6 && free(t, pole, 0.1)) {
    const id = b.light({ kind: "flood", x: pc[0], y: pc[1], h: 7, r: 15, power: 1.05, color: [0.82, 0.9, 1] })
    b.prop("floodpole", ...pole, 0, true, id)
    take(t, pole)
    t.lit.push({ x: pc[0], y: pc[1] })
  }
  const dc = R(Lg - 2.2, Sh - 1.2, Lg - 0.3, Sh - 0.25)
  if (free(t, dc, 0.1)) {
    b.wall(...dc, 1.25, "dumpster", r.int(1 << 16) * 2)
    take(t, dc)
  }
}

/** A parked car in rc, its long axis along `axis`; `flip` turns it to face the other way. */
export function parkedCar(t: Town, rc: Rect, axis: "x" | "y", flip: boolean): void {
  const { r } = t
  const model = weighted(r, [[0, 3], [1, 2], [2, 1.2], [3, 0.5], [4, 1]] as const)
  const h = model === 4 ? 2.05 : model === 3 ? 1.55 : 1.45
  let box = rc
  if (model === 4) {
    // Vans are a little longer and wider.
    const cx = (rc[0] + rc[2]) / 2
    const cy = (rc[1] + rc[3]) / 2
    box = axis === "x" ? [cx - 2.5, cy - 1.0, cx + 2.5, cy + 1.0] : [cx - 1.0, cy - 2.5, cx + 1.0, cy + 2.5]
  } else {
    const cx = (rc[0] + rc[2]) / 2
    const cy = (rc[1] + rc[3]) / 2
    box = axis === "x" ? [cx - 2.2, cy - 0.9, cx + 2.2, cy + 0.9] : [cx - 0.9, cy - 2.2, cx + 0.9, cy + 2.2]
  }
  if (!free(t, box, 0.05)) return
  t.b.wall(...box, h, "car", model + 8 * r.int(8) + (flip ? 64 : 0))
  take(t, box)
}

/** A burnt-out car still on fire: orange light, flames tied to it. */
export function wreckAt(t: Town, rc: Rect, axis: "x" | "y"): void {
  const cx = (rc[0] + rc[2]) / 2
  const cy = (rc[1] + rc[3]) / 2
  const box: Rect = axis === "x" ? [cx - 2.2, cy - 0.95, cx + 2.2, cy + 0.95] : [cx - 0.95, cy - 2.2, cx + 0.95, cy + 2.2]
  if (!free(t, box, 0.05)) return
  const id = t.b.light({ kind: "fire", x: cx, y: cy, h: 1.7, r: 10, power: 1.5, color: [1, 0.48, 0.14], flicker: 0.3 })
  t.b.wall(...box, 1.2, "wreck", (id >= 0 ? id : 0) * 2 + (axis === "x" ? 0 : 1))
  take(t, box)
  t.lit.push({ x: cx, y: cy })
}

/** A park: grass, paths crossing it, trees, hedges with gaps, benches by the paths, a lamp or two. */
function parkBlock(t: Town, k: Block): void {
  const { b, r } = t
  const lot = k.lot
  const [x0, y0, x1, y1] = lot
  b.floor("grass", ...lot)
  const cx = x0 + (x1 - x0) * (0.35 + r.next() * 0.3)
  const cy = y0 + (y1 - y0) * (0.35 + r.next() * 0.3)
  const pw = 2.2
  const paths: Rect[] = [
    [x0, cy - pw / 2, x1, cy + pw / 2],
    [cx - pw / 2, y0, cx + pw / 2, y1],
  ]
  for (const p of paths) b.floor("plaza", ...p)
  // Hedges along each edge, broken where the paths come out and once more at random.
  for (const s of SIDES) {
    const L = len(lot, s)
    const pu = horizontal(s) ? cx - x0 : cy - y0
    const g2 = L * (r.next() < 0.5 ? 0.18 : 0.8)
    const gaps: [number, number][] = [[pu - pw / 2 - 0.6, pu + pw / 2 + 0.6], [g2 - 0.9, g2 + 0.9]]
    let u = 0.4
    for (const [a, z] of gaps.sort((p, q) => p[0] - q[0])) {
      if (a - u > 0.8) {
        const rc = at(lot, s, u, 0.3, a, 0.95)
        b.wall(...rc, 0.95, "hedge")
        take(t, rc)
      }
      u = Math.max(u, z)
    }
    if (L - 0.4 - u > 0.8) {
      const rc = at(lot, s, u, 0.3, L - 0.4, 0.95)
      b.wall(...rc, 0.95, "hedge")
      take(t, rc)
    }
  }
  for (const p of paths) take(t, [p[0] - 0.3, p[1] - 0.3, p[2] + 0.3, p[3] + 0.3])
  // Trees scattered over the grass, kept apart.
  const trees: { x: number; y: number }[] = []
  const n = Math.round(((x1 - x0) * (y1 - y0)) / 26)
  for (let k2 = 0; k2 < n * 4 && trees.length < n; k2++) {
    const x = r.range(x0 + 1.8, x1 - 1.8)
    const y = r.range(y0 + 1.8, y1 - 1.8)
    const rc: Rect = [x - 0.3, y - 0.3, x + 0.3, y + 0.3]
    if (!free(t, rc, 0.8) || trees.some((q) => Math.hypot(q.x - x, q.y - y) < 3.6)) continue
    b.prop("tree", ...rc, r.int(4) as Rot, true)
    take(t, rc)
    trees.push({ x, y })
  }
  // Benches beside the paths, facing them.
  for (let k2 = 0; k2 < 4; k2++) {
    const alongX = r.next() < 0.5
    const s = r.next() < 0.5 ? -1 : 1
    const rc: Rect = alongX ? (() => {
      const x = r.range(x0 + 2, x1 - 4)
      const y = cy + s * (pw / 2 + 0.55)
      return [x, y - 0.3, x + 1.8, y + 0.3] as Rect
    })() : (() => {
      const y = r.range(y0 + 2, y1 - 4)
      const x = cx + s * (pw / 2 + 0.55)
      return [x - 0.3, y, x + 0.3, y + 1.8] as Rect
    })()
    if (Math.abs((alongX ? rc[0] : rc[1]) - (alongX ? cx : cy)) < 2.5) continue
    if (!free(t, rc, 0.15)) continue
    b.prop("bench", ...rc, alongX ? (s < 0 ? 0 : 2) : s < 0 ? 3 : 1, true)
    take(t, rc)
  }
  lampAt(t, cx + pw / 2 + 0.3, cy + pw / 2 + 0.3, 0, 4.2)
  if ((x1 - x0) * (y1 - y0) > 500) lampAt(t, x0 + (cx - x0) / 2, cy - pw / 2 - 0.3, 0, 4.2)
}
