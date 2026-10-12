import type { Rect } from "../geom"
import type { Rng } from "../rng"
import { type Archetype, type Side, EPS, area, contact, overlaps, q, snap, step, subtract, subtractV, weighted } from "./geo"
import { Gen, type Mood, type Template } from "./zones"

const corridorWidth = (r: Rng) => r.pick([2.1, 2.4, 2.4, 2.7])

function mood(r: Rng, arch: Archetype): Mood {
  return weighted<Mood>(r, [
    ["mixed", 3],
    ["warren", arch === "open" ? 0 : arch === "spine" || arch === "cross" ? 2.5 : 1.5],
    ["open", arch === "open" || arch === "sidecore" ? 3 : 1.2],
    ["social", arch === "open" ? 2.5 : 1.5],
    ["tech", 1.3],
  ])
}

/** Splits a long band into two or three zones, so a facade isn't one template end to end. */
function splitBand(r: Rng, rc: Rect, along: "x" | "y"): Rect[] {
  const a = along === "x" ? rc[0] : rc[1]
  const b = along === "x" ? rc[2] : rc[3]
  const L = b - a
  if (L < 26 || r.next() < 0.3) return [rc]
  const n = L >= 40 && r.next() < 0.35 ? 3 : 2
  const cuts: number[] = []
  for (let k = 1; k < n; k++) cuts.push(snap(a + (L * k) / n + (r.next() - 0.5) * L * 0.18))
  const out: Rect[] = []
  let u = a
  for (const c of [...cuts, b]) {
    out.push(along === "x" ? [u, rc[1], c, rc[3]] : [rc[0], u, rc[2], c])
    u = c
  }
  return out
}

/** Fills blocks: open areas first, so rooms beside them can open into them. */
function fill(g: Gen, blocks: { rc: Rect; allow?: Template[]; reception?: number }[]): void {
  const order = blocks.map((b) => ({ ...b, open: b.allow?.every((t) => t === "hall" || t === "cafe" || t === "rowhall") ?? false }))
  for (const b of [...order.filter((x) => x.open), ...order.filter((x) => !x.open)]) {
    if (b.rc[2] - b.rc[0] < 0.05 || b.rc[3] - b.rc[1] < 0.05) continue
    // Slivers are riser space: solid.
    if (b.rc[2] - b.rc[0] < 2.4 || b.rc[3] - b.rc[1] < 2.4) {
      g.room("shaft", b.rc, "n")
      continue
    }
    if (Math.min(b.rc[2] - b.rc[0], b.rc[3] - b.rc[1]) < 3.3 || area(b.rc) < 14) {
      g.room(area(b.rc) < 9 ? "closet" : "storage", b.rc, nearestFront(g, b.rc))
      continue
    }
    g.block(b.rc, b.allow, { reception: b.reception })
  }
}

function nearestFront(g: Gen, rc: Rect): Side {
  let best: Side = "n"
  let len = -1
  for (const s of ["n", "s", "e", "w"] as Side[]) {
    const l = g.reach(rc, s)
    if (l > len) {
      len = l
      best = s
    }
  }
  return best
}

const CELL: Template[] = ["rows", "rows", "suite", "labs"]
const OPEN: Template[] = ["hall", "rowhall", "cluster", "rows", "server", "cafe"]

/**
 * Ring, spine, atrium and court floors: bands along the long facades, two long corridors, a central zone of blocks
 * between them. Long bands split into zones; some have a notch cut out of the facade (U, H and T plates).
 */
function banded(r: Rng, arch: "ring" | "spine" | "atrium" | "court"): Gen {
  const c = corridorWidth(r)
  let tN: "cell" | "open" = "cell"
  let tS: "cell" | "open" = "open"
  let dN = 5.4
  let dS = 10.2
  let H = 36
  const depth = (t: "cell" | "open") => (t === "cell" ? step(r, 4.8, 6.6, 0.6) : step(r, 9.6, 12, 0.6))
  for (let tries = 0; tries < 60; tries++) {
    ;[tN, tS] = weighted<["cell" | "open", "cell" | "open"]>(r, [
      [["cell", "open"], 3],
      [["open", "cell"], 3],
      [["cell", "cell"], 2],
      [["open", "open"], arch === "spine" ? 1.2 : 0.8],
    ])
    dN = depth(tN)
    dS = depth(tS)
    H = step(r, 33, 40, 0.3)
    const mid = H - dN - dS - 2 * c
    if (mid >= (arch === "atrium" || arch === "court" ? 12 : 10.2) && mid <= 18) break
    tN = "cell"
    tS = "open"
    dN = 5.4
    dS = 10.2
    H = q(dN + dS + 2 * c + 14.4)
  }
  const W = step(r, 48, 58, 0.3)
  const g = new Gen(r, W, H, mood(r, arch))
  const yN = dN
  const yS = q(H - dS)
  let cx0 = 0
  let cx1 = W
  let tW: "cell" | "open" | "none" = "none"
  let tE: "cell" | "open" | "none" = "none"
  let stub: { side: "w" | "e"; y: number } | null = null
  if (arch === "spine") {
    const n = g.corridor([0, yN, W, yN + c])
    const s = g.corridor([0, yS - c, W, yS])
    const diag = r.next() < 0.5
    g.end(n, "w", diag)
    g.end(n, "e", !diag)
    g.end(s, "w", !diag)
    g.end(s, "e", diag)
    g.solid.add("w")
    g.solid.add("e")
  } else {
    const side = () =>
      weighted<"cell" | "open" | "none">(r, [
        ["cell", 6],
        ["open", 2.5],
        ["none", 1.2],
      ])
    tW = side()
    tE = side()
    if (tW === "none" && tE === "none") tE = "cell"
    const dW = tW === "none" ? 0 : tW === "cell" ? step(r, 4.8, 6.6, 0.6) : step(r, 9, 10.8, 0.6)
    const dE = tE === "none" ? 0 : tE === "cell" ? step(r, 4.8, 6.6, 0.6) : step(r, 9, 10.8, 0.6)
    cx0 = dW
    cx1 = q(W - dE)
    g.corridor([cx0, yN, cx1, yN + c])
    g.corridor([cx0, yS - c, cx1, yS])
    g.corridor([cx0, yN + c, cx0 + c, yS - c])
    g.corridor([cx1 - c, yN + c, cx1, yS - c])
    // An escape corridor out through an office row to a fire stair on the facade.
    const cand = (["w", "e"] as const).filter((s) => (s === "w" ? tW : tE) === "cell")
    if (cand.length && yS - yN >= 15 && r.next() < 0.55) {
      const s = r.pick(cand)
      const y = snap((yN + yS) / 2 - c / 2 + (r.int(3) - 1) * 1.2)
      const k = s === "w" ? g.corridor([0, y, cx0, y + c]) : g.corridor([cx1, y, W, y + c])
      g.end(k, s, true)
      stub = { side: s, y }
    }
  }

  // The central zone: blocks across it, a cross corridor between some of them.
  const mx0 = arch === "spine" ? 0 : q(cx0 + c)
  const mx1 = arch === "spine" ? W : q(cx1 - c)
  const my0 = q(yN + c)
  const my1 = q(yS - c)
  const IW = mx1 - mx0
  type Block = { kind: "core" | "mini" | "atrium" | "court" | "inner"; w: number }
  let blocks: Block[] = []
  const coreW = step(r, 13.2, 17.4, 0.6)
  const court = arch === "atrium" || arch === "court" ? arch : null
  const split = arch !== "spine" && IW >= 32 && r.next() < (court ? 0.4 : 0.35)
  if (split) {
    // Two small cores at either end, something else in the middle.
    const mw = step(r, 6.6, 8.4, 0.6)
    blocks = [
      { kind: "mini", w: mw },
      { kind: court ?? "inner", w: 0 },
      { kind: "mini", w: mw },
    ]
    g.tags.add("twincore")
  } else if (court && IW - coreW - 2 * c >= 9) {
    const aw = Math.min(step(r, 9, 13.2, 0.6), q(IW - coreW - 2 * c))
    const rest = IW - aw - coreW - 2 * c
    blocks.push({ kind: "core", w: coreW }, { kind: court, w: aw })
    if (rest >= 6.6) blocks.push({ kind: "inner", w: rest })
    else blocks[0]!.w += rest + c
    if (r.next() < 0.5) blocks.reverse()
    if (blocks.length === 3 && blocks[1]!.kind !== court) [blocks[1], blocks[2]] = [blocks[2]!, blocks[1]!]
  } else {
    const three = IW - coreW >= 2 * 6.6 + 2 * c
    if (three) {
      const at = arch === "spine" ? 1 : weighted(r, [[1, 3], [0, 1], [2, 1]] as const)
      for (let k = 0; k < 3; k++) blocks.push({ kind: k === at ? "core" : "inner", w: 0 })
    } else blocks.push(...(r.next() < 0.5 ? [{ kind: "core" as const, w: 0 }, { kind: "inner" as const, w: 0 }] : [{ kind: "inner" as const, w: 0 }, { kind: "core" as const, w: 0 }]))
  }
  const voidish = (b: Block) => b.kind === "atrium" || b.kind === "court"
  const gaps = blocks.slice(1).map((b, k) => arch === "spine" || voidish(b) || voidish(blocks[k]!) || r.next() < 0.5)
  if (gaps.length && !gaps.some(Boolean)) gaps[r.int(gaps.length)] = true
  if (split) {
    const free = IW - blocks[0]!.w - blocks[2]!.w - gaps.filter(Boolean).length * c
    blocks[1]!.w = free
  } else if (!court || blocks.every((b) => !voidish(b))) {
    let free = IW - coreW - gaps.filter(Boolean).length * c
    let others = blocks.filter((b) => b.kind !== "core")
    if (arch !== "spine" && free / others.length < 6.6) {
      gaps.fill(false)
      free = IW - coreW
    }
    if (free / others.length < 6.6) {
      blocks.splice(0, blocks.length, { kind: "core", w: IW })
      gaps.length = 0
      others = []
    }
    const share = free / others.length
    let left = free
    others.forEach((b, k) => {
      b.w = k === others.length - 1 ? left : snap(share * (0.85 + r.next() * 0.3))
      left = q(left - b.w)
    })
    if (others.length) blocks.find((b) => b.kind === "core")!.w = coreW
  }
  let x = mx0
  let lobby = W / 2
  const pending: { kind: Block["kind"]; rc: Rect }[] = []
  blocks.forEach((b, k) => {
    const x1 = k === blocks.length - 1 ? mx1 : q(x + b.w)
    pending.push({ kind: b.kind, rc: [x, my0, x1, my1] })
    x = x1
    if (k < gaps.length && gaps[k]) {
      g.corridor([x, my0, q(x + c), my1])
      x = q(x + c)
    }
  })
  for (const p of pending) {
    if (p.kind === "core") lobby = g.core(p.rc, ["n", "s"])
    else if (p.kind === "mini") g.miniCore(p.rc, ["n", "s"])
    else if (p.kind === "court") {
      g.void(p.rc)
      g.tags.add("courtyard")
    }
  }
  const rec = tN === "cell" && (tS !== "cell" || r.next() < 0.5) ? "n" : tS === "cell" ? "s" : null

  // Bands along the facades, some notched (a U or H plate) or with their corners cut (a T).
  const bands: { rc: Rect; allow: Template[]; reception?: number }[] = []
  const notched = (rc: Rect, top: boolean, t: "cell" | "open"): Rect[] => {
    const allow = t === "cell" ? CELL : OPEN
    const roll = r.next()
    let parts: Rect[] = [rc]
    const L = W
    if (roll < 0.28) {
      const nw = step(r, 9.6, Math.min(16.8, L * 0.32), 0.6)
      const nx = snap(L * r.range(0.3, 0.7) - nw / 2)
      const v: Rect = [nx, rc[1], q(nx + nw), rc[3]]
      g.void(v)
      g.tags.add(top ? "notchN" : "notchS")
      parts = subtractV(rc, v)
    } else if (roll < 0.4 && arch !== "spine") {
      const cw = step(r, 6, 10.8, 0.6)
      g.void([0, rc[1], cw, rc[3]])
      g.void([q(W - cw), rc[1], W, rc[3]])
      g.tags.add("corners")
      parts = [[cw, rc[1], q(W - cw), rc[3]]]
    }
    const out: Rect[] = []
    for (const p of parts) out.push(...splitBand(r, p, "x"))
    for (const p of out) bands.push({ rc: p, allow, reception: (top ? rec === "n" : rec === "s") && p[0] <= lobby && p[2] >= lobby ? lobby : undefined })
    return out
  }
  notched([0, 0, W, yN], true, tN)
  notched([0, yS, W, H], false, tS)
  for (const [t, s, rc] of [
    [tW, "w", [0, yN, cx0, yS]],
    [tE, "e", [cx1, yN, W, yS]],
  ] as const) {
    if (t === "none") continue
    const allow = t === "cell" ? CELL : OPEN
    if (stub?.side === s) {
      bands.push({ rc: [rc[0], rc[1], rc[2], stub.y], allow })
      bands.push({ rc: [rc[0], q(stub.y + c), rc[2], rc[3]], allow })
    } else bands.push({ rc: [...rc], allow })
  }
  const inner = pending.filter((p) => p.kind === "inner").map((p) => ({ rc: p.rc }))
  for (const p of pending) if (p.kind === "atrium") g.room("atrium", p.rc, "n")
  fill(g, [...bands, ...inner])
  return g
}

/** Side core: the core and support rooms along one facade, a spine corridor, a deep open plan with islands of rooms. */
function sidecore(r: Rng): Gen {
  const c = corridorWidth(r)
  const W = step(r, 48, 58, 0.3)
  const H = step(r, 33, 40, 0.3)
  const g = new Gen(r, W, H, mood(r, "sidecore"))
  const dN = step(r, 7.2, 9.6, 0.6)
  const spine = g.corridor([0, dN, W, dN + c])
  const exitW = r.next() < 0.75
  g.end(spine, "w", exitW)
  g.end(spine, "e", !exitW || r.next() < 0.6)
  g.solid.add("w")
  g.solid.add("e")
  g.solid.add("n")
  const cw = step(r, 13.2, 16.8, 0.6)
  const cx = snap(W / 2 - cw / 2 + (r.next() - 0.5) * W * 0.25)
  g.core([cx, 0, q(cx + cw), dN], ["s"])
  const top = q(dN + c)
  const dS = r.next() < 0.6 ? step(r, 4.8, 6, 0.6) : 0
  const bottom = q(H - dS)
  let h0 = 0
  let h1 = W
  const ends: Rect[] = []
  for (const lo of [true, false]) {
    if (r.next() > 0.45) continue
    const w = step(r, 6, 8.4, 0.6)
    ends.push(lo ? [0, top, w, bottom] : [q(W - w), top, W, bottom])
    if (lo) h0 = w
    else h1 = q(W - w)
  }
  // The open plan, maybe round an island of rooms standing in it.
  const region: Rect = [h0, top, h1, bottom]
  const islands: Rect[] = []
  if (r.next() < 0.7 && bottom - top >= 16) {
    const iw = step(r, 9.6, 15.6, 0.6)
    const id = step(r, 6, 9, 0.6)
    const ix = snap(h0 + 7.2 + (h1 - h0 - iw - 14.4) * r.next())
    const iy = snap(top + 6 + (bottom - top - id - 12) * r.next())
    islands.push([ix, iy, q(ix + iw), q(iy + id)])
    g.tags.add("island")
  }
  for (const h of islands.length ? subtractV(region, islands[0]!) : [region]) {
    const hall = g.room("hall", h, "n")
    g.openRound(hall, 0.25)
  }
  fill(g, [...islands.map((rc) => ({ rc, allow: ["rows", "cluster", "cafe", "server", "team"] as Template[] })), ...ends.map((rc) => ({ rc, allow: ["rows", "cluster", "labs"] as Template[] }))])
  if (dS) fill(g, splitBand(r, [0, bottom, W, H], "x").map((rc) => ({ rc, allow: CELL })))
  fill(g, [{ rc: [0, 0, cx, dN] }, { rc: [q(cx + cw), 0, W, dN] }])
  return g
}

/**
 * Two corridors crossing, a quadrant of different workspace in each corner. Plates: a plain rectangle, an L (one
 * quadrant cut away), a T (both corners off one side), a U (a notch where one arm of the cross would be) or an H.
 */
function cross(r: Rng): Gen {
  const c = corridorWidth(r)
  const W = step(r, 48, 58, 0.3)
  const H = step(r, 34, 40, 0.3)
  const g = new Gen(r, W, H, mood(r, "cross"))
  const shape = weighted<"rect" | "L" | "T" | "U" | "H">(r, [
    ["rect", 1.6],
    ["L", 2.4],
    ["T", 1.2],
    ["U", 1.6],
    ["H", 1.2],
  ])
  g.tags.add(shape)
  const xc = snap(W * r.range(shape === "L" ? 0.42 : 0.38, shape === "L" ? 0.56 : 0.62))
  const yc = snap(H * r.range(0.42, 0.58))
  const voids: Rect[] = []
  if (shape === "L") {
    const inset = r.next() < 0.6 ? step(r, 4.8, 6, 0.6) : 0
    const insetY = r.next() < 0.6 ? step(r, 4.8, 6, 0.6) : 0
    voids.push([q(xc + c + inset), 0, W, q(yc - insetY)])
  } else if (shape === "T") {
    const a = step(r, 8.4, Math.min(14.4, xc - 6), 0.6)
    const b = step(r, 6, Math.max(6, yc - 6), 0.6)
    voids.push([0, 0, a, b], [q(W - a), 0, W, b])
  } else if (shape === "U" || shape === "H") {
    for (const top of shape === "U" ? [true] : [true, false]) {
      const half = step(r, 4.8, 7.8, 0.6)
      const vd = step(r, 7.2, Math.max(7.2, (top ? yc : H - yc - c) - 6), 0.6)
      voids.push(top ? [q(xc - half), 0, q(xc + c + half), vd] : [q(xc - half), q(H - vd), q(xc + c + half), H])
    }
  }
  for (const v of voids) g.void(v)
  // Corridors, cut back where the plate is.
  const hz = g.corridor([0, yc, W, q(yc + c)])
  const exits = r.next() < 0.5
  g.end(hz, "w", exits)
  g.end(hz, "e", !exits)
  for (const top of [true, false]) {
    let v: Rect = top ? [xc, 0, q(xc + c), yc] : [xc, q(yc + c), q(xc + c), H]
    const cut = voids.find((x) => overlaps(x, v))
    if (cut) {
      v = top ? [xc, cut[3], q(xc + c), yc] : [xc, q(yc + c), q(xc + c), cut[1]]
      if (v[3] - v[1] < 0.5) continue
      // A short stub to a glazed end isn't worth it: the block takes the space.
      continue
    }
    if (shape === "rect" && !top && r.next() < 0.25) continue
    const k = g.corridor(v)
    g.end(k, top ? "n" : "s", r.next() < 0.4)
  }
  const vs = g.corridors.slice(1)
  // Quadrants: wings either side of the vertical corridor, or one band where it's missing.
  const regions: Rect[] = []
  for (const top of [true, false]) {
    const y0 = top ? 0 : q(yc + c)
    const y1 = top ? yc : H
    const vert = vs.find((v) => (top ? v[3] <= yc + EPS : v[1] >= yc + c - EPS))
    if (vert) regions.push([0, y0, xc, y1], [q(xc + c), y0, W, y1])
    else regions.push([0, y0, W, y1])
  }
  let pieces: Rect[] = []
  for (const reg of regions) {
    let parts: Rect[] = [reg]
    for (const v of voids) {
      const next: Rect[] = []
      for (const p of parts) {
        const a = subtract(p, v)
        const b = subtractV(p, v)
        const score = (xs: Rect[]) => xs.reduce((s, x) => s + (touchesCorridor(g, x) ? 1 : -1) - (Math.min(x[2] - x[0], x[3] - x[1]) < 3.3 ? 2 : 0), 0)
        next.push(...(score(b) >= score(a) ? b : a))
      }
      parts = next
    }
    pieces.push(...parts.filter((p) => p[2] - p[0] > 0.5 && p[3] - p[1] > 0.5))
  }
  // The core: one by the crossing, or two small ones in opposite quadrants.
  const twin = r.next() < 0.35
  const byH = pieces.filter((p) => Math.abs(p[3] - yc) < EPS || Math.abs(p[1] - (yc + c)) < EPS)
  const cores: { rc: Rect; front: Side; mini: boolean }[] = []
  const used = new Set<Rect>()
  for (let k = 0; k < (twin ? 2 : 1); k++) {
    const cand = byH.filter((p) => !used.has(p) && p[2] - p[0] >= (twin ? 8 : 15) && p[3] - p[1] >= (twin ? 9 : 9.6) && (k === 0 || (p[1] < yc) !== (cores[0]!.rc[1] < yc)))
    if (!cand.length) break
    const p = r.pick(cand)
    used.add(p)
    const front: Side = p[1] < yc ? "s" : "n"
    const pw = p[2] - p[0]
    const pd = p[3] - p[1]
    let cw = twin ? step(r, 6.6, 8.4, 0.6) : Math.min(pw - 3.6, step(r, 13.2, 16.8, 0.6))
    let cd = Math.min(pd, twin ? step(r, 9, 10.8, 0.6) : step(r, 9, 11.4, 0.6))
    // Whatever is left behind the core needs a way in round its side, or the core takes the full depth.
    if (pd - cd > 0.5 && pw - cw < 4.2) {
      if (pw - 4.2 >= (twin ? 6 : 11.4)) cw = q(pw - 4.2)
      else cd = pd
    }
    // Against the vertical corridor when there is one, else anywhere along the band.
    const nearV = Math.abs(p[2] - xc) < EPS ? p[2] - cw : Math.abs(p[0] - (xc + c)) < EPS ? p[0] : snap(p[0] + (p[2] - p[0] - cw) * r.range(0.2, 0.8))
    const x0 = q(Math.max(p[0], Math.min(p[2] - cw, nearV)))
    const raw: Rect = front === "s" ? [x0, q(p[3] - cd), q(x0 + cw), p[3]] : [x0, p[1], q(x0 + cw), q(p[1] + cd)]
    // No slivers beside or behind it: the core takes them in.
    const rc: Rect = [raw[0] - p[0] < 3.6 ? p[0] : raw[0], raw[1] - p[1] < 3.6 ? p[1] : raw[1], p[2] - raw[2] < 3.6 ? p[2] : raw[2], p[3] - raw[3] < 3.6 ? p[3] : raw[3]]
    cores.push({ rc, front, mini: twin })
    pieces = pieces.flatMap((x) => (x === p ? subtractV(p, rc) : [x]))
  }
  if (!cores.length) {
    // Nowhere roomy enough: a small core in the biggest piece on the corridor.
    const p = [...byH].sort((a, b) => area(b) - area(a))[0]!
    const front: Side = p[1] < yc ? "s" : "n"
    const cw = Math.min(8.4, p[2] - p[0])
    const cd = Math.min(p[3] - p[1], 9)
    const rc: Rect = front === "s" ? [p[0], q(p[3] - cd), q(p[0] + cw), p[3]] : [p[0], p[1], q(p[0] + cw), q(p[1] + cd)]
    cores.push({ rc, front, mini: true })
    pieces = pieces.flatMap((x) => (x === p ? subtractV(p, rc) : [x]))
  }
  for (const k of cores) {
    const fronts: Side[] = [k.front]
    if (k.mini) g.miniCore(k.rc, fronts)
    else g.core(k.rc, fronts)
  }
  fill(
    g,
    pieces.map((rc) => ({ rc })),
  )
  return g
}

const touchesCorridor = (g: Gen, rc: Rect) => g.corridors.some((c) => {
  const t = contact(rc, c)
  return !!t && t.hi - t.lo >= 2
})

/** Cuts a region into open-plan rects round islands standing in it: strips between the islands' sides, split by them. */
function around(region: Rect, islands: Rect[]): Rect[] {
  const xs = [...new Set([region[0], region[2], ...islands.flatMap((i) => [i[0], i[2]])])].sort((a, b) => a - b)
  const out: Rect[] = []
  for (let k = 0; k + 1 < xs.length; k++) {
    const [xa, xb] = [xs[k]!, xs[k + 1]!]
    let y = region[1]
    for (const i of islands.filter((i) => i[0] < xb - EPS && i[2] > xa + EPS).sort((a, b) => a[1] - b[1])) {
      if (i[1] - y > EPS) out.push([xa, y, xb, i[1]])
      y = i[3]
    }
    if (region[3] - y > EPS) out.push([xa, y, xb, region[3]])
  }
  return out
}

/** No corridors: open plan round islands (the core, or two small cores, and blocks of rooms), rooms along some facades. */
function openPlan(r: Rng): Gen {
  const W = step(r, 46, 56, 0.3)
  const H = step(r, 32, 38, 0.3)
  const g = new Gen(r, W, H, mood(r, "open"))
  let dN = r.next() < 0.6 ? step(r, 4.8, 6, 0.6) : 0
  let dS = r.next() < (dN ? 0.35 : 0.75) ? step(r, 4.8, 6, 0.6) : 0
  let dW = r.next() < 0.45 ? step(r, 6, 8.4, 0.6) : 0
  const dE = r.next() < (dW ? 0.3 : 0.55) ? step(r, 6, 8.4, 0.6) : 0
  if (H - dN - dS < 24) dS = 0
  if (H - dN - dS < 24) dN = 0
  // Always some rooms to fight through as well as the open floor.
  if (!dN && !dS && !dW && !dE) dW = step(r, 6, 8.4, 0.6)
  const region: Rect = [dW, dN, q(W - dE), q(H - dS)]
  const RW = region[2] - region[0]
  const RH = region[3] - region[1]
  type Island = { rc: Rect; kind: "core" | "mini" | "block" | "void"; turn: boolean }
  const islands: Island[] = []
  // Now and then a corner of the plate is a roof terrace.
  const voids: Rect[] = []
  if (r.next() < 0.4) {
    const a = step(r, 9, 15, 0.6)
    const b = step(r, 7.2, 10.8, 0.6)
    const v: Rect = [q(W - a), 0, W, b]
    voids.push(v)
    g.void(v)
    g.tags.add("terrace")
    // Its edge squared off with the open plan's.
    const hv: Rect = [Math.max(region[0], v[0]), region[1], region[2], Math.max(region[1], v[3])]
    if (hv[2] > hv[0] && hv[3] > hv[1]) islands.push({ rc: hv, kind: "void", turn: false })
  }
  // Edges either line up with the other islands' or stand well clear, so the open plan round them has no slivers.
  const clear = (a: number, b: number) => Math.abs(a - b) < 0.01 || Math.abs(a - b) >= 3.6
  const lined = (rc: Rect) => islands.every((i) => [rc[0], rc[2]].every((e) => clear(e, i.rc[0]) && clear(e, i.rc[2])) && [rc[1], rc[3]].every((e) => clear(e, i.rc[1]) && clear(e, i.rc[3])))
  const free = (rc: Rect) =>
    lined(rc) && rc[0] >= region[0] + 6 - EPS && rc[2] <= region[2] - 6 + EPS && rc[1] >= region[1] + 5.4 - EPS && rc[3] <= region[3] - 5.4 + EPS && islands.every((i) => !overlaps([i.rc[0] - 6, i.rc[1] - 5.4, i.rc[2] + 6, i.rc[3] + 5.4], rc))
  const place = (w: number, d: number, kind: Island["kind"], turn: boolean, at?: number) => {
    for (let k = 0; k < 40; k++) {
      const x = snap(at !== undefined && k < 20 ? at - w / 2 + (r.next() - 0.5) * 4 : region[0] + 6 + (RW - 12 - w) * r.next())
      const y = snap(region[1] + 5.4 + (RH - 10.8 - d) * r.next())
      const rc: Rect = [x, y, q(x + w), q(y + d)]
      if (free(rc)) {
        islands.push({ rc, kind, turn })
        return true
      }
    }
    return false
  }
  const twin = RW >= 40 && r.next() < 0.4
  if (twin) {
    const w = step(r, 6.6, 8.4, 0.6)
    const d = step(r, 9, 10.8, 0.6)
    place(w, d, "mini", false, region[0] + RW * 0.2)
    place(w, d, "mini", false, region[2] - RW * 0.2)
    g.tags.add("twincore")
  } else {
    const turn = RH - 10.8 >= 15 && r.next() < 0.4
    const cw = step(r, 13.2, 15.6, 0.6)
    const cd = step(r, 9.6, 11.4, 0.6)
    if (!place(turn ? cd : cw, turn ? cw : cd, "core", turn, region[0] + RW * r.range(0.25, 0.75))) place(cw, Math.min(cd, RH - 10.8), "core", false)
  }
  // Blocks of rooms standing in the open plan.
  for (let k = 0; k < (twin ? 2 : 1 + r.int(2)); k++) {
    const w = step(r, 9, 14.4, 0.6)
    const d = step(r, 6, 9, 0.6)
    const turn = r.next() < 0.35
    if (place(turn ? d : w, turn ? w : d, "block", false, twin && k === 0 ? (region[0] + region[2]) / 2 : undefined)) g.tags.add("island")
  }
  if (!islands.some((i) => i.kind === "core" || i.kind === "mini")) {
    // Nowhere to stand it: the core goes against a facade instead.
    const cw = 13.2
    const cd = Math.min(10.8, RH / 2)
    islands.push({ rc: [snap(region[0] + (RW - cw) / 2), region[1], q(snap(region[0] + (RW - cw) / 2) + cw), q(region[1] + cd)], kind: "core", turn: false })
  }
  for (const i of islands) {
    if (i.kind === "core") g.core(i.rc, i.turn ? ["e", "w"] : ["n", "s"])
    else if (i.kind === "mini") g.miniCore(i.rc, ["n", "s"])
  }
  for (const h of around(region, islands.map((i) => i.rc))) g.room("hall", h, "n")
  g.tags.add("hall")
  fill(g, islands.filter((i) => i.kind === "block").map((i) => ({ rc: i.rc, allow: ["rows", "cluster", "cafe", "team", "server"] as Template[] })))
  const bands: { rc: Rect; allow?: Template[] }[] = []
  if (dN) bands.push(...splitBand(r, [region[0], 0, region[2], dN], "x").map((rc) => ({ rc, allow: CELL })))
  if (dS) bands.push(...splitBand(r, [region[0], region[3], region[2], H], "x").map((rc) => ({ rc, allow: CELL })))
  if (dW) bands.push({ rc: [0, 0, dW, H], allow: ["rows", "cluster", "labs", "server"] })
  if (dE) bands.push({ rc: [region[2], 0, W, H], allow: ["rows", "cluster", "labs", "server"] })
  fill(
    g,
    bands.flatMap((b) => voids.reduce<Rect[]>((parts, v) => parts.flatMap((p) => subtractV(p, v)), [b.rc]).map((rc) => ({ rc, allow: b.allow }))),
  )
  return g
}

/** Picks and lays out a floor's composition. */
export function compose(r: Rng): { g: Gen; archetype: Archetype } {
  const archetype = weighted<Archetype>(r, [
    ["ring", 2],
    ["spine", 1.4],
    ["atrium", 1],
    ["court", 1.2],
    ["sidecore", 1.3],
    ["cross", 3],
    ["open", 1.4],
  ])
  const g = archetype === "sidecore" ? sidecore(r) : archetype === "cross" ? cross(r) : archetype === "open" ? openPlan(r) : banded(r, archetype)
  return { g, archetype }
}
