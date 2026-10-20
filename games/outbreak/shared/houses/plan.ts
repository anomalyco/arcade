import { distToRect, type Rect } from "@arcade/kit/sim/geom"
import { Rng } from "@arcade/kit/sim/rng"
import { propSize, type Barrier, type Building, type Door, type Lamp, type Prop, type WindowOpening } from "../map"
import { boundaryEdges, OUTER_WALL, PARTITION, roomInner, sharedEdges, type PlanEdge } from "./geometry"
import { fittingForms, pickCondition, pickDressing, pickForm } from "./pick"
import type { HouseForm, HouseRoom, HouseStyle, Household, RoomType, YardItem, YardKind } from "./style"
import type { HouseVariety } from "./variety"

/**
 * Lays out a streamed home from its style (AR-79): rooms in strips from the street back, doors between strips and
 * archways inside open ones, outside walls with the windows the style asks for, furniture by room type and household,
 * lamps, fences, an outbuilding and yard things. Pure and deterministic from the chunk seed. Every room is checked
 * reachable from a front door with every container within reach, dropping furniture that blocks the way.
 */

/** How a lot's loot differs from its building's table: a garage's shelves roll the garage table, a hideout has more ammo. */
export type LootHint = { table?: string; ammoBonus?: number; bare?: boolean }

export type HousePlanInput = {
  /** Building ids are `${prefix}-${archetype}`, as Today's. */
  prefix: string
  archetype: string
  district: string
  /** The building envelope (Today's lot rect). */
  lot: Rect
  chunk: Rect
  /** Whether a point is in the street corridor (with padding). */
  inRoad: (x: number, z: number, pad: number) => boolean
  rng: Rng
  variety: HouseVariety
}

export type HousePlan = {
  building: Building
  barriers: Barrier[]
  doors: Door[]
  windows: WindowOpening[]
  props: Prop[]
  /** Hide-in closets go after every other prop (Today keeps them last too). */
  closets: { x: number; y: number }[]
  lamps: Lamp[]
  loot: Map<Prop, LootHint>
}

const r2 = (v: number) => Math.round(v * 100) / 100
const FORM_ARCHETYPE: Record<HouseForm, string> = {
  bungalow: "house",
  colonial: "house",
  ranch: "ranch",
  duplex: "house",
  shotgun: "cottage",
  farmhouse: "ranch",
  trailer: "cottage",
  apartment: "house",
  corner_store: "grocery",
}

type LRoom = HouseRoom & { strip: number; unit: number; open: boolean }
type Shares = readonly (readonly [RoomType, number])[]
/** A strip of rooms across the block (`rooms`, by share of the width), or split room by room behind the strip ahead (`behind`), so every room shares one wall with a room in front of it. */
type StripSpec = { depth: number; open: boolean; rooms?: Shares; behind?: readonly Shares[] }

/** Rooms of a w × d block from the street (south, z = y + d) back, strip by strip; the last strip takes what is left. */
function strips(x: number, y: number, w: number, d: number, specs: readonly StripSpec[], unit = 0, firstStrip = 0): LRoom[] {
  const out: LRoom[] = []
  let south = y + d
  let ahead: [number, number][] = [[x, x + w]]
  specs.forEach((s, i) => {
    const north = i === specs.length - 1 ? y : r2(south - s.depth)
    const spans: [number, number, Shares][] = s.behind ? ahead.map(([a, b], k) => [a, b, s.behind![k] ?? s.behind![s.behind!.length - 1]!]) : [[x, x + w, s.rooms!]]
    const row: [number, number][] = []
    for (const [a, b, shares] of spans) {
      const total = shares.reduce((acc, [, share]) => acc + share, 0)
      let west = a
      shares.forEach(([type, share], k) => {
        const east = k === shares.length - 1 ? b : r2(west + ((b - a) * share) / total)
        out.push({ rect: [r2(west), r2(north), r2(east), r2(south)], type, strip: firstStrip + i, unit, open: s.open })
        row.push([west, east])
        west = east
      })
    }
    ahead = row
    south = north
  })
  return out
}

type Layout = {
  rooms: LRoom[]
  /** Front doors: room index and where along its south wall (0 west .. 1 east). */
  fronts: { room: number; t: number }[]
  /** Extra door links (room a north of room b, sharing an edge) beyond the strip rule. */
  links?: [number, number][]
  /** A back door from this room's north wall. */
  back?: number
}

/** The plan of each form inside its footprint [x, y, x + w, y + d]. */
function layoutFor(form: HouseForm, x: number, y: number, w: number, d: number, rng: Rng, household: Household): Layout {
  const second = (): RoomType => (household === "family" ? "nursery" : household === "elderly" || household === "student" ? "study" : rng.next() < 0.5 ? "bedroom" : "study")
  switch (form) {
    case "bungalow": {
      const front = r2(d * (0.5 + rng.next() * 0.08))
      const livingWest = rng.next() < 0.5
      const kitchenBack: Shares = (w * 1) / 2.2 >= 4.6 ? [["bath", 0.46], [second(), 0.54]] : [["bath", 1]]
      const bedroomBack: Shares = [["bedroom", 1]]
      const rooms = strips(x, y, w, d, [
        { depth: front, open: true, rooms: livingWest ? [["living", 1.2], ["kitchen", 1]] : [["kitchen", 1], ["living", 1.2]] },
        { depth: 0, open: false, behind: livingWest ? [bedroomBack, kitchenBack] : [kitchenBack, bedroomBack] },
      ])
      const living = rooms.findIndex((r) => r.type === "living")
      return { rooms, fronts: [{ room: living, t: rooms[living]!.rect[0] === x ? 0.65 : 0.35 }], back: rng.next() < 0.4 ? rooms.findIndex((r) => r.type === "bedroom") : undefined }
    }
    case "colonial": {
      const rooms = strips(x, y, w, d, [
        { depth: r2(d * 0.52), open: true, rooms: [["living", 1], ["hall", 0.8], ["dining", 1]] },
        { depth: 0, open: false, behind: [[["kitchen", 1]], [["bath", 1]], [[rng.next() < 0.5 ? "study" : "laundry", 1]]] },
      ])
      return { rooms, fronts: [{ room: 1, t: 0.5 }], back: rng.next() < 0.6 ? 3 : undefined }
    }
    case "ranch": {
      // A garage wing stands forward of the house on one side; the entry is recessed beside it.
      const wingW = r2(4.4 + rng.next() * 0.6), wingD = r2(Math.min(3.9, d * 0.36))
      const left = rng.next() < 0.5
      const mainD = r2(d - wingD)
      const rooms = strips(x, y, w, mainD, [
        { depth: r2(mainD * 0.53), open: true, rooms: left ? [["kitchen", 1], ["living", 1.4]] : [["living", 1.4], ["kitchen", 1]] },
        { depth: 0, open: false, behind: left ? [[["bath", 0.45], ["bedroom", 0.55]], [["bedroom", 1], [second(), 1]]] : [[["bedroom", 1], [second(), 1]], [["bedroom", 0.55], ["bath", 0.45]]] },
      ])
      const wx = left ? x : r2(x + w - wingW)
      rooms.push({ rect: [wx, r2(y + mainD), r2(wx + wingW), r2(y + d)], type: "garage", strip: -1, unit: 0, open: false })
      const g = rooms.length - 1
      // The garage joins whichever front room it stands in front of.
      const host = rooms.findIndex((r) => r.strip === 0 && r.rect[0] <= wx + wingW / 2 && r.rect[2] >= wx + wingW / 2)
      const living = rooms.findIndex((r) => r.type === "living")
      // Front door on the recessed façade, in the crook beside the garage.
      return { rooms, fronts: [{ room: living, t: left ? 0.25 : 0.75 }], links: [[host, g]] }
    }
    case "duplex": {
      const half = r2(w / 2)
      const unit = (ux: number, u: number, mirror: boolean) =>
        strips(ux, y, half, d, [
          { depth: r2(d * 0.5), open: true, rooms: mirror ? [["kitchen", 0.9], ["living", 1.1]] : [["living", 1.1], ["kitchen", 0.9]] },
          { depth: 0, open: false, behind: mirror ? [[["bath", 1]], [["bedroom", 1]]] : [[["bedroom", 1]], [["bath", 1]]] },
        ], u)
      const a = unit(x, 0, false), b = unit(r2(x + half), 1, true)
      const rooms = [...a, ...b]
      // Twin front doors by the party wall.
      return { rooms, fronts: [{ room: 0, t: 0.72 }, { room: a.length + 1, t: 0.28 }] }
    }
    case "shotgun": {
      const n = d >= 11.8 ? 4 : 3
      const depth = r2(d / n)
      const specs: StripSpec[] = [{ depth, open: true, rooms: [["living", 1]] }, { depth, open: false, rooms: [["bedroom", 1]] }]
      if (n === 4) specs.push({ depth, open: false, rooms: [[second(), 1]] })
      specs.push({ depth: 0, open: false, rooms: [["kitchen", 1]] })
      const rooms = strips(x, y, w, d, specs)
      return { rooms, fronts: [{ room: 0, t: 0.3 }], back: rooms.length - 1 }
    }
    case "farmhouse": {
      const rooms = strips(x, y, w, d, [
        { depth: r2(d * 0.5), open: true, rooms: [["living", 1], ["hall", 0.7], ["dining", 0.95]] },
        { depth: 0, open: false, behind: [[["kitchen", 1]], [["laundry", 1]], [["bedroom", 1]]] },
      ])
      return { rooms, fronts: [{ room: 1, t: 0.5 }], back: 3 }
    }
    case "trailer": {
      const rooms = strips(x, y, w, d, [{ depth: d, open: true, rooms: [["bedroom", 1], ["living", 1.2], ["kitchen", 0.8], [rng.next() < 0.5 ? "bedroom" : "bath", 0.75]] }])
      return { rooms, fronts: [{ room: 1, t: 0.5 }] }
    }
    case "apartment": {
      const units = w >= 14 ? 3 : 2
      const rooms = strips(x, y, w, d, [
        { depth: 3, open: true, rooms: [["lobby", 1]] },
        { depth: 0, open: false, rooms: Array.from({ length: units }, () => ["unit", 1] as const) },
      ])
      return { rooms, fronts: [{ room: 0, t: 0.5 }], back: rng.next() < 0.5 ? 1 : undefined }
    }
    case "corner_store": {
      const rooms = strips(x, y, w, d, [
        { depth: r2(d * 0.6), open: true, rooms: [["shop", 1]] },
        { depth: 0, open: false, rooms: [["store", 1.2], ["hall", 0.8]] },
      ])
      return { rooms, fronts: [{ room: 0, t: rng.next() < 0.5 ? 0.25 : 0.75 }], back: 2 }
    }
  }
}

/** Footprint size of a form in a lot W × D. */
function sizeFor(form: HouseForm, W: number, D: number, rng: Rng): [number, number] {
  const span = (lo: number, hi: number, max: number) => r2(Math.min(max, lo + rng.next() * (hi - lo)))
  switch (form) {
    case "bungalow": return [span(9, 12.5, W), span(8.6, 10.2, D)]
    case "colonial": return [span(9.6, 12, W), span(8.6, 9.8, D)]
    case "ranch": return [span(12.5, 15, W), span(10.2, 11.4, D)]
    case "duplex": return [span(13, 15, W), span(8.6, 10, D)]
    case "shotgun": return [span(5, 5.8, W), span(10, 12, D)]
    case "farmhouse": return [span(11, 13.4, W), span(9.4, 10.6, D)]
    case "trailer": return [span(11, 13, W), 4.2]
    case "apartment": return [span(13, 15, W), span(10, 11.4, D)]
    case "corner_store": return [span(9.4, 12, W), span(9, 10.8, D)]
  }
}

// --- furniture -------------------------------------------------------------------------------------------------------

type Side = "n" | "s" | "w" | "e"
type Item = { kind: Exclude<Prop["kind"], "tree">; side?: Side | readonly Side[]; essential?: boolean; table?: string }

/** What each room holds, by household. Bedrooms and kitchens first so the essentials get the walls. */
function recipe(type: RoomType, household: Household, rng: Rng, condition: HouseStyle["condition"]): Item[] {
  if (condition === "construction") {
    if (type === "garage" || type === "living" || type === "shop") return [{ kind: "table" }, { kind: "shelf", side: ["n", "s"], table: "hardware" }]
    if (type === "kitchen") return [{ kind: "counter", side: ["e", "w"] }]
    return rng.next() < 0.3 ? [{ kind: "shelf", side: ["n", "s"], table: "hardware" }] : []
  }
  const hoard: Item[] = household === "hoarder" ? [{ kind: "shelf", side: ["n", "s"] }, { kind: "shelf", side: ["s", "n"] }] : []
  switch (type) {
    case "living": {
      const out: Item[] = [{ kind: "sofa", side: ["w", "e"] }, { kind: "coffee" }]
      if (household === "hideout") out.unshift({ kind: "bed", side: ["n", "s"] })
      if (household !== "student") out.push({ kind: "shelf", side: ["n", "s"] })
      if (household === "elderly") out.push({ kind: "chair" }, { kind: "shelf", side: ["s", "n"] })
      return [...out, ...hoard]
    }
    case "kitchen":
      return [{ kind: "counter", side: ["e", "w"], essential: true }, { kind: "fridge", side: ["n", "e", "w", "s"] }, { kind: "stove", side: ["n", "e", "w", "s"] }, { kind: "table" }, { kind: "chair" }, ...(household === "hoarder" ? [{ kind: "shelf", side: ["n", "s"] } as Item] : [])]
    case "dining":
      return [{ kind: "table" }, { kind: "chair" }, { kind: "chair" }, { kind: "shelf", side: ["n", "s"] }, ...hoard]
    case "bedroom":
      return [
        { kind: "bed", side: "n", essential: true },
        { kind: "nightstand" },
        { kind: "closet", side: ["n", "w", "e"] },
        { kind: household === "student" ? "desk" : "dresser", side: ["n", "s"] },
        ...(household === "student" ? [{ kind: "chair" } as Item] : []),
        ...hoard.slice(0, 1),
      ]
    case "nursery":
      return [{ kind: "crib", side: ["n", "s"], essential: true }, { kind: "dresser", side: ["n", "s"] }, { kind: "chair" }]
    case "study":
      return [{ kind: "desk", side: ["n", "s"], essential: true }, { kind: "chair" }, { kind: "shelf", side: ["n", "s", "e", "w"] }, ...hoard]
    case "bath":
      return [{ kind: "tub", side: ["n", "s"], essential: true }]
    case "laundry":
      return [{ kind: "washer", side: ["n", "s"], essential: true }, { kind: "washer", side: ["n", "s"] }, { kind: "shelf", side: ["n", "s"] }]
    case "hall":
      return household === "hoarder" ? [{ kind: "stairs", side: ["e", "w"] }, { kind: "shelf", side: ["n", "s"] }] : [{ kind: "stairs", side: ["e", "w"] }]
    case "garage":
      return [{ kind: "shelf", side: ["n", "s"], table: "garage", essential: true }, { kind: "counter", side: ["e", "w"], table: "garage" }, { kind: "shelf", side: ["n", "s"], table: "garage" }]
    case "shop":
      return [{ kind: "counter", side: ["e", "w"], essential: true }, { kind: "shelf", side: "n" }, { kind: "shelf", side: "n" }, { kind: "shelf", side: "n" }, { kind: "fridge", side: ["w", "e", "n"] }]
    case "store":
      return [{ kind: "shelf", side: ["n", "s"], essential: true }, { kind: "shelf", side: ["n", "s"] }, { kind: "shelf", side: ["e", "w"] }]
    case "lobby":
      return [{ kind: "stairs", side: ["e", "w"] }]
    case "unit":
      return [{ kind: "bed", side: "n", essential: true }, { kind: "closet", side: ["n", "w", "e"] }, { kind: "counter", side: ["e", "w"] }, { kind: "fridge", side: ["n", "e", "w"] }, { kind: "table" }, { kind: "chair" }]
  }
}

const TALL = new Set<Prop["kind"]>(["shelf", "fridge", "closet", "dresser", "stairs"])
const overlaps = (a: Rect, b: Rect, m = 0) => a[0] < b[2] + m && a[2] > b[0] - m && a[1] < b[3] + m && a[3] > b[1] - m

type Placed = { prop: Prop; rect: Rect; room: number; essential: boolean; table?: string; closet?: boolean }

function furnish(rooms: LRoom[], inners: Rect[], zones: Rect[], windowRects: Rect[], household: Household, condition: HouseStyle["condition"], rng: Rng): Placed[] {
  const placed: Placed[] = []
  const free = (r: Rect, room: Rect) =>
    r[0] >= room[0] - 1e-6 && r[2] <= room[2] + 1e-6 && r[1] >= room[1] - 1e-6 && r[3] <= room[3] + 1e-6 && !placed.some((p) => overlaps(p.rect, r, 0.04)) && !zones.some((z) => overlaps(z, r))
  const rectAt = (kind: Item["kind"], cx: number, cz: number): Rect => {
    const [w, d] = propSize(kind)
    return [r2(cx - w / 2), r2(cz - d / 2), r2(cx + w / 2), r2(cz + d / 2)]
  }
  const put = (kind: Item["kind"], cx: number, cz: number, room: number, it: Item): Placed => {
    const p: Placed = { prop: { x: r2(cx), y: r2(cz), kind, variant: Number(rng.next().toFixed(4)) }, rect: rectAt(kind, cx, cz), room, essential: Boolean(it.essential), table: it.table, closet: kind === "closet" }
    placed.push(p)
    return p
  }
  rooms.forEach((room, ri) => {
    const inner = inners[ri]!
    const items = recipe(room.type, household, rng, condition)
    // Burnt and derelict homes lost most of what stood in them.
    const keep = condition === "burnt" ? 0.3 : condition === "derelict" ? 0.7 : 1
    for (const it of items) {
      if (!it.essential && rng.next() > keep) continue
      const [w, d, h] = propSize(it.kind)
      if (it.kind === "nightstand") {
        const bed = placed.find((p) => p.room === ri && p.prop.kind === "bed")
        if (!bed) continue
        for (const sx of rng.next() < 0.5 ? [-1, 1] : [1, -1]) {
          const cx = sx < 0 ? bed.rect[0] - w / 2 - 0.04 : bed.rect[2] + w / 2 + 0.04
          const cz = inner[1] + d / 2 + 0.03
          if (free(rectAt("nightstand", cx, cz), inner)) {
            put("nightstand", cx, cz, ri, it)
            break
          }
        }
        continue
      }
      if (it.kind === "coffee") {
        const sofa = placed.find((p) => p.room === ri && p.prop.kind === "sofa")
        if (!sofa) continue
        const cx = sofa.prop.x < (inner[0] + inner[2]) / 2 ? sofa.rect[2] + w / 2 + 0.45 : sofa.rect[0] - w / 2 - 0.45
        if (free(rectAt("coffee", cx, sofa.prop.y), inner)) put("coffee", cx, sofa.prop.y, ri, it)
        continue
      }
      if (it.kind === "chair") {
        const host = placed.find((p) => p.room === ri && (p.prop.kind === "table" || p.prop.kind === "desk"))
        const tries: [number, number][] = host
          ? [[host.prop.x, host.rect[3] + 0.36], [host.prop.x, host.rect[1] - 0.36], [host.rect[0] - 0.36, host.prop.y], [host.rect[2] + 0.36, host.prop.y]]
          : [[(inner[0] + inner[2]) / 2 + (rng.next() - 0.5), (inner[1] + inner[3]) / 2 + (rng.next() - 0.5)]]
        for (const [cx, cz] of tries) {
          if (free(rectAt("chair", cx, cz), inner) && !blindSlot(rectAt("chair", cx, cz), inner, placed.filter((p) => p !== host))) {
            put("chair", cx, cz, ri, it)
            break
          }
        }
        continue
      }
      if (!it.side) {
        // Free-standing: near the middle, nudged until it fits, first with a walkway (1.1 m) round
        // it on every side so nothing gets snagged between it and the next piece, then anywhere it fits.
        const mx = (inner[0] + inner[2]) / 2, mz = (inner[1] + inner[3]) / 2
        const roomy = (r: Rect) => r[0] >= inner[0] + 1.1 && r[2] <= inner[2] - 1.1 && r[1] >= inner[1] + 1.1 && r[3] <= inner[3] - 1.1 && !placed.some((p) => overlaps(p.rect, r, 1.1))
        for (let k = 0; k < 16; k++) {
          const cx = mx + (rng.next() - 0.5) * Math.max(0, inner[2] - inner[0] - w) * 0.8
          const cz = mz + (rng.next() - 0.5) * Math.max(0, inner[3] - inner[1] - d) * 0.8
          if (free(rectAt(it.kind, cx, cz), inner) && (k >= 12 || (k < 8 ? roomy(rectAt(it.kind, cx, cz)) : !blindSlot(rectAt(it.kind, cx, cz), inner, placed)))) {
            put(it.kind, cx, cz, ri, it)
            break
          }
        }
        continue
      }
      const sides = typeof it.side === "string" ? [it.side] : it.side
      let done = false
      for (const side of sides) {
        if (done) break
        const along = side === "n" || side === "s"
        const lo = along ? inner[0] + w / 2 + 0.03 : inner[1] + d / 2 + 0.03
        const hi = along ? inner[2] - w / 2 - 0.03 : inner[3] - d / 2 - 0.03
        if (hi < lo) continue
        const fixed = side === "n" ? inner[1] + d / 2 + 0.03 : side === "s" ? inner[3] - d / 2 - 0.03 : side === "w" ? inner[0] + w / 2 + 0.03 : inner[2] - w / 2 - 0.03
        const start = lo + (hi - lo) * rng.next()
        for (let k = 0; k <= Math.ceil((hi - lo) / 0.1) * 2 + 1 && !done; k++) {
          const off = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.1
          const a = start + off
          if (a < lo - 1e-6 || a > hi + 1e-6) continue
          const cx = along ? a : fixed, cz = along ? fixed : a
          const r = rectAt(it.kind, cx, cz)
          if (!free(r, inner)) continue
          // A closet is left from its south side: keep a step clear in front of it.
          if (it.kind === "closet" && !free([r[0], r[3], r[2], r[3] + 0.7], inner)) continue
          // Tall pieces keep off the windows.
          if (h > 0.95 && TALL.has(it.kind) && windowRects.some((wr) => overlaps(wr, r, 0.35))) continue
          // No blind slot beside it along the wall: a gap to the corner or the next piece is flush or a walkway, never a
          // dead end the dead walk into and cannot turn out of.
          if (blindSlot(r, inner, placed)) continue
          put(it.kind, cx, cz, ri, it)
          done = true
        }
      }
    }
  })
  return placed
}

/**
 * Whether a piece leaves a 0.1–1.1 m slot (under two of the dead's 0.5 m nav cells once padded) between itself and a wall or another piece beside it: a gap is flush or a
 * walkway, never a dead end the dead walk into and cannot turn out of.
 */
function blindSlot(r: Rect, inner: Rect, placed: readonly Placed[]): boolean {
  const slot = (g: number) => g > 0.1 && g < 1.1
  if (slot(r[0] - inner[0]) || slot(inner[2] - r[2]) || slot(r[1] - inner[1]) || slot(inner[3] - r[3])) return true
  for (const p of placed) {
    const q = p.rect
    if (q[1] < r[3] && q[3] > r[1] && (slot(r[0] - q[2]) || slot(q[0] - r[2]))) return true
    if (q[0] < r[2] && q[2] > r[0] && (slot(r[1] - q[3]) || slot(q[1] - r[3]))) return true
  }
  return false
}

// --- reachability ----------------------------------------------------------------------------------------------------

const CELL = 0.2
// A little wider than a survivor (0.3 m), so a gap the plan keeps is never a squeeze on another grid.
const AGENT = 0.36

/** Rooms and containers a survivor can reach from outside through the open doors. */
function reachable(bounds: Rect, solids: readonly Rect[], starts: readonly [number, number][]): Flood {
  const x0 = bounds[0] - 1.2, z0 = bounds[1] - 1.2
  const nx = Math.ceil((bounds[2] - bounds[0] + 2.4) / CELL), nz = Math.ceil((bounds[3] - bounds[1] + 2.4) / CELL)
  const blocked = new Uint8Array(nx * nz)
  for (const s of solids) {
    const i0 = Math.max(0, Math.floor((s[0] - AGENT - x0) / CELL)), i1 = Math.min(nx - 1, Math.floor((s[2] + AGENT - x0) / CELL))
    const k0 = Math.max(0, Math.floor((s[1] - AGENT - z0) / CELL)), k1 = Math.min(nz - 1, Math.floor((s[3] + AGENT - z0) / CELL))
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      const cx = x0 + (i + 0.5) * CELL, cz = z0 + (k + 0.5) * CELL
      if (distToRect(cx, cz, s) < AGENT) blocked[i + k * nx] = 1
    }
  }
  const seen = new Uint8Array(nx * nz)
  const queue: number[] = []
  for (const [sx, sz] of starts) {
    const i = Math.floor((sx - x0) / CELL), k = Math.floor((sz - z0) / CELL)
    if (i < 0 || k < 0 || i >= nx || k >= nz || blocked[i + k * nx]) continue
    seen[i + k * nx] = 1
    queue.push(i + k * nx)
  }
  while (queue.length) {
    const c = queue.pop()!
    const i = c % nx, k = (c - i) / nx
    for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const a = i + di, b = k + dk
      if (a < 0 || b < 0 || a >= nx || b >= nz) continue
      const n = a + b * nx
      if (seen[n] || blocked[n]) continue
      seen[n] = 1
      queue.push(n)
    }
  }
  const ok = (x: number, z: number) => {
    const i = Math.floor((x - x0) / CELL), k = Math.floor((z - z0) / CELL)
    return i >= 0 && k >= 0 && i < nx && k < nz && seen[i + k * nx] === 1
  }
  ok.free = (x: number, z: number) => {
    const i = Math.floor((x - x0) / CELL), k = Math.floor((z - z0) / CELL)
    return i >= 0 && k >= 0 && i < nx && k < nz && blocked[i + k * nx] === 0
  }
  return ok
}

/**
 * The zombies' view: the same 0.5 m tile rasterisation as `buildChunkNavTile` (`shared/world.ts`), aligned to the
 * chunk, with doors carved through and flooded from outside the front doors.
 */
function navReachable(chunk: Rect, solids: readonly Rect[], doors: readonly Rect[], starts: readonly [number, number][]): Flood {
  const cell = 0.5, pad = 0.3, ox = chunk[0], oy = chunk[1]
  const tile = new Uint8Array(64 * 64)
  for (const r of solids) {
    const x0 = Math.max(0, Math.ceil((r[0] - ox - pad) / cell - 0.5)), x1 = Math.min(63, Math.floor((r[2] - ox + pad) / cell - 0.5))
    const y0 = Math.max(0, Math.ceil((r[1] - oy - pad) / cell - 0.5)), y1 = Math.min(63, Math.floor((r[3] - oy + pad) / cell - 0.5))
    for (let cy = y0; cy <= y1; cy++) tile.fill(1, cy * 64 + x0, cy * 64 + x1 + 1)
  }
  for (const d of doors) {
    const box: Rect = [d[0] + 0.18, d[1] - 0.42, d[2] - 0.18, d[3] + 0.42]
    for (let cy = Math.max(0, Math.floor((box[1] - oy) / cell)); cy <= Math.min(63, Math.floor((box[3] - oy) / cell)); cy++)
      for (let cx = Math.max(0, Math.floor((box[0] - ox) / cell)); cx <= Math.min(63, Math.floor((box[2] - ox) / cell)); cx++) tile[cy * 64 + cx] = 0
  }
  const seen = new Uint8Array(64 * 64)
  const queue: number[] = []
  for (const [sx, sz] of starts) {
    const i = Math.floor((sx - ox) / cell), k = Math.floor((sz - oy) / cell)
    if (i < 0 || k < 0 || i > 63 || k > 63 || tile[i + k * 64]) continue
    seen[i + k * 64] = 1
    queue.push(i + k * 64)
  }
  while (queue.length) {
    const c = queue.pop()!
    const i = c % 64, k = (c - i) / 64
    for (const [a, b] of [[i + 1, k], [i - 1, k], [i, k + 1], [i, k - 1]] as const) {
      if (a < 0 || b < 0 || a > 63 || b > 63) continue
      const n = a + b * 64
      if (seen[n] || tile[n]) continue
      seen[n] = 1
      queue.push(n)
    }
  }
  const ok = (x: number, z: number) => {
    const i = Math.floor((x - ox) / cell), k = Math.floor((z - oy) / cell)
    return i >= 0 && k >= 0 && i < 64 && k < 64 && seen[i + k * 64] === 1
  }
  ok.free = (x: number, z: number) => {
    const i = Math.floor((x - ox) / cell), k = Math.floor((z - oy) / cell)
    return i >= 0 && k >= 0 && i < 64 && k < 64 && tile[i + k * 64] === 0
  }
  return ok
}

/** A flood fill: whether a point was reached, and whether it is open floor at all. */
type Flood = ((x: number, z: number) => boolean) & { free: (x: number, z: number) => boolean }

/**
 * The middle of the open floor inside `r` the flood never reached, when it adds up to more than `limit` m² (furniture
 * walled off a pocket of the room), sampled every `step` m.
 */
function pocket(f: Flood, r: Rect, step: number, limit: number): [number, number] | null {
  let n = 0, sx = 0, sz = 0
  for (let z = r[1] + step / 2; z < r[3]; z += step) for (let x = r[0] + step / 2; x < r[2]; x += step) {
    if (f.free(x, z) && !f(x, z)) {
      n++
      sx += x
      sz += z
    }
  }
  return n * step * step > limit ? [sx / n, sz / n] : null
}

/** Whether any reachable cell lies within `pad` of `r`. */
function touches(ok: (x: number, z: number) => boolean, r: Rect, pad: number): boolean {
  for (let z = r[1] - pad; z <= r[3] + pad; z += CELL / 2) for (let x = r[0] - pad; x <= r[2] + pad; x += CELL / 2) if (ok(x, z)) return true
  return false
}

// --- the plan --------------------------------------------------------------------------------------------------------

type Opening = { edge: PlanEdge | null; axis: "x" | "z"; at: number; a0: number; a1: number; kind: "door" | "arch" | "window"; id?: string; boarded?: boolean }

export function planHouse(input: HousePlanInput): HousePlan | null {
  const { lot, chunk, rng, variety } = input
  const W = lot[2] - lot[0], D = lot[3] - lot[1]
  const form = pickForm(rng, fittingForms(W, D, input.archetype), variety)
  if (!form) return null
  const condition = pickCondition(rng, form, variety)
  const { dressing, paint } = pickDressing(rng, form, condition)
  const [w, d] = sizeFor(form, W, D, rng)
  // Setbacks: anywhere across the lot, and up to 1.4 m back from Today's building line.
  const x = r2(lot[0] + (W - w) * rng.next())
  const y = r2(lot[3] - d - Math.min(1.4, D - d) * rng.next())
  const layout = layoutFor(form, x, y, w, d, rng, dressing.household)
  const rooms = layout.rooms
  const rects = rooms.map((r) => r.rect)
  const archetype = input.archetype === "cabin" ? "cabin" : FORM_ARCHETYPE[form]
  const id = `${input.prefix}-${archetype}`
  const rect: Rect = [Math.min(...rects.map((r) => r[0])), Math.min(...rects.map((r) => r[1])), Math.max(...rects.map((r) => r[2])), Math.max(...rects.map((r) => r[3]))]
  const color = paint

  const barriers: Barrier[] = []
  const doors: Door[] = []
  const windows: WindowOpening[] = []
  const openings: Opening[] = []
  const wall = (r: Rect, kind: Barrier["kind"] = "wall", col = color) => barriers.push({ rect: [r2(r[0]), r2(r[1]), r2(r[2]), r2(r[3])], color: col, kind })

  // Links: each room behind the front strip gets a door to a room ahead of it (same unit), open strips get archways.
  const shared = sharedEdges(rooms)
  const doorLinks: { edge: (typeof shared)[number] }[] = []
  const archLinks: (typeof shared)[number][] = []
  const linked = new Set<number>()
  const extra = layout.links ?? []
  for (const [a, b] of extra) {
    const e = shared.find((s) => s.axis === "x" && ((s.a === a && s.b === b) || (s.a === b && s.b === a)) && s.a1 - s.a0 >= 1.95)
    if (e) {
      doorLinks.push({ edge: e })
      linked.add(rooms[a]!.strip < 0 ? a : b)
    }
  }
  rooms.forEach((room, i) => {
    if (room.strip <= 0 || linked.has(i)) return
    const ahead = shared.filter((s) => s.axis === "x" && s.a === i && rooms[s.b]!.unit === room.unit && rooms[s.b]!.strip === room.strip - 1 && s.a1 - s.a0 >= 1.95)
    ahead.sort((p, q) => q.a1 - q.a0 - (p.a1 - p.a0))
    if (ahead[0]) doorLinks.push({ edge: ahead[0] })
  })
  for (const s of shared) {
    if (s.axis !== "z") continue
    const a = rooms[s.a]!, b = rooms[s.b]!
    if (a.open && b.open && a.unit === b.unit && a.strip === b.strip && s.a1 - s.a0 >= 1.9) archLinks.push(s)
  }

  // Partitions with their door or archway.
  let roomDoor = 0
  for (const s of shared) {
    const door = doorLinks.find((l) => l.edge === s)
    const arch = archLinks.includes(s)
    let gap: [number, number] | null = null
    if (door) {
      const lo = s.a0 + 0.27, hi = s.a1 - 0.27 - 1.4
      const dx = r2(lo + Math.max(0, hi - lo) * (rng.next() < 0.5 ? 0.15 * rng.next() : 1 - 0.15 * rng.next()))
      gap = [dx, dx + 1.4]
      doors.push({ id: `${id}-room${roomDoor ? roomDoor + 1 : ""}`, rect: [dx, r2(s.at - PARTITION / 2), r2(dx + 1.4), r2(s.at + PARTITION / 2)], open: false })
      roomDoor++
      openings.push({ edge: null, axis: "x", at: s.at, a0: dx, a1: dx + 1.4, kind: "door" })
    } else if (arch) {
      // Archways keep to the street side of the wall.
      const g1 = r2(s.a1 - 0.3 - rng.next() * Math.max(0, s.a1 - s.a0 - 2.2)), g0 = r2(Math.max(s.a0 + 0.3, g1 - 1.6))
      gap = [g0, g1]
      openings.push({ edge: null, axis: "z", at: s.at, a0: g0, a1: g1, kind: "arch" })
    }
    const piece = (a0: number, a1: number) => {
      if (a1 - a0 < 0.02) return
      wall(s.axis === "x" ? [a0, s.at - PARTITION / 2, a1, s.at + PARTITION / 2] : [s.at - PARTITION / 2, a0, s.at + PARTITION / 2, a1])
    }
    if (gap) {
      piece(s.a0, gap[0])
      piece(gap[1], s.a1)
    } else piece(s.a0, s.a1)
  }

  // Outside walls: front and back doors, then windows by the style's pattern.
  const edges = boundaryEdges(rects)
  const edgeOf = (axis: "x" | "z", at: number, side: 1 | -1, a: number) => edges.find((e) => e.axis === axis && e.side === side && Math.abs(e.at - at) < 1e-4 && a >= e.a0 - 1e-4 && a <= e.a1 + 1e-4)
  const frontRooms = new Set<number>()
  layout.fronts.forEach((f, k) => {
    const r = rooms[f.room]!.rect
    const e = edgeOf("x", r[3], 1, (r[0] + r[2]) / 2)
    if (!e) return
    const lo = Math.max(r[0], e.a0) + 0.45, hi = Math.min(r[2], e.a1) - 0.45 - 1.4
    if (hi < lo) return
    const dx = r2(lo + (hi - lo) * f.t)
    doors.push({ id: k === 0 ? `${id}-front` : `${id}-front${k + 1}`, rect: [dx, r2(e.at - OUTER_WALL), r2(dx + 1.4), e.at], open: false })
    openings.push({ edge: e, axis: "x", at: e.at, a0: dx, a1: dx + 1.4, kind: "door" })
    frontRooms.add(f.room)
  })
  if (layout.back !== undefined && layout.back >= 0) {
    const r = rooms[layout.back]!.rect
    const e = edgeOf("x", r[1], -1, (r[0] + r[2]) / 2)
    if (e) {
      const lo = Math.max(r[0], e.a0) + 0.45, hi = Math.min(r[2], e.a1) - 0.45 - 1.4
      if (hi >= lo) {
        const dx = r2(lo + (hi - lo) * rng.next())
        doors.push({ id: `${id}-back`, rect: [dx, e.at, r2(dx + 1.4), r2(e.at + OUTER_WALL)], open: false })
        openings.push({ edge: e, axis: "x", at: e.at, a0: dx, a1: dx + 1.4, kind: "door" })
      }
    }
  }
  const boardShare = dressing.household === "hideout" ? 0.9 : condition === "derelict" ? Math.max(0.45, variety.boarded) : condition === "kept" ? variety.boarded : 0
  let winCount = 0
  rooms.forEach((room, ri) => {
    const r = room.rect
    const sides: [PlanEdge["axis"], number, 1 | -1, number, number][] = [
      ["x", r[3], 1, r[0], r[2]],
      ["x", r[1], -1, r[0], r[2]],
      ["z", r[0], -1, r[1], r[3]],
      ["z", r[2], 1, r[1], r[3]],
    ]
    for (const [axis, at, side, s0, s1] of sides) {
      for (const e of edges) {
        if (e.axis !== axis || e.side !== side || Math.abs(e.at - at) > 1e-4) continue
        let a0 = Math.max(s0, e.a0) + 0.5, a1 = Math.min(s1, e.a1) - 0.5
        if (a1 - a0 < 0.8) continue
        // Keep clear of the doors on this edge.
        const spans: [number, number][] = [[a0, a1]]
        for (const o of openings) {
          if (o.axis !== axis || Math.abs(o.at - at) > 1e-4 || o.kind !== "door") continue
          for (let i = spans.length - 1; i >= 0; i--) {
            const [p0, p1] = spans[i]!
            if (o.a1 + 0.4 <= p0 || o.a0 - 0.4 >= p1) continue
            spans.splice(i, 1, ...([[p0, o.a0 - 0.4], [o.a1 + 0.4, p1]] as [number, number][]).filter(([q0, q1]) => q1 - q0 >= 0.8))
          }
        }
        if (!spans.length) continue
        spans.sort((p, q) => q[1] - q[0] - (p[1] - p[0]))
        ;[a0, a1] = spans[0]!
        const len = a1 - a0
        const t = room.type
        if (t === "store") continue
        if (t === "garage" && axis === "x" && side === 1) continue
        if (t === "lobby" && axis === "x") continue
        const want: number[] = []
        const front = axis === "x" && side === 1
        if (t === "bath" || t === "laundry" || t === "garage" || t === "hall") want.push(Math.min(0.8, len))
        else if (t === "shop" && front) want.push(Math.min(3.2, len))
        else if (dressing.windows === "band" && len >= 2.2) want.push(Math.min(2.8, len * 0.75))
        else if (dressing.windows === "picture" && front && t === "living") want.push(Math.min(2.6, len))
        else if (dressing.windows === "pairs" && len >= 3.4) want.push(1.0, 1.0)
        else want.push(Math.min(form === "trailer" ? 0.9 : 1.2, len))
        if (axis === "z" && want.length > 1) want.length = 1
        const slots = want.length === 2 ? [a0 + len * 0.27, a0 + len * 0.73] : [a0 + len / 2]
        want.forEach((wl, k) => {
          if (winCount >= 12) return
          const c = slots[k]!
          const w0 = r2(c - wl / 2), w1 = r2(c + wl / 2)
          const boarded = rng.next() < boardShare
          const winId = `${id}-w${winCount}`
          winCount++
          openings.push({ edge: e, axis, at, a0: w0, a1: w1, kind: "window", id: winId, boarded })
        })
        void ri
      }
    }
  })
  for (const e of edges) {
    const mine = openings.filter((o) => o.edge === e).sort((p, q) => p.a0 - q.a0)
    const wr = (a0: number, a1: number): Rect =>
      e.axis === "x" ? (e.side > 0 ? [a0, e.at - OUTER_WALL, a1, e.at] : [a0, e.at, a1, e.at + OUTER_WALL]) : e.side > 0 ? [e.at - OUTER_WALL, a0, e.at, a1] : [e.at, a0, e.at + OUTER_WALL, a1]
    let cur = e.a0
    for (const o of mine) {
      if (o.a0 - cur > 0.02) wall(wr(cur, o.a0))
      if (o.kind === "window") {
        const rr = wr(o.a0, o.a1)
        wall(rr, "window")
        // Burnt shells and unfinished frames have no glass left to open: their windows stand open.
        const gaping = condition === "burnt" || condition === "construction"
        windows.push({ id: o.id!, buildingId: id, buildingIndex: 0, rect: [r2(rr[0]), r2(rr[1]), r2(rr[2]), r2(rr[3])], open: gaping && !o.boarded, openable: !o.boarded, ...(o.boarded ? { boarded: true } : {}) })
      }
      cur = o.a1
    }
    if (e.a1 - cur > 0.02) wall(wr(cur, e.a1))
  }

  // Furniture, kept out of every doorway and archway's swing.
  const inners = rects.map((r) => roomInner(r, rects))
  const zones: Rect[] = []
  for (const o of openings) {
    if (o.kind === "window") continue
    // Doors swing; archways only need the way through kept clear.
    // The dead walk a 0.5 m grid padded 0.3 m off every solid: keep a clear tile either side of the way through.
    const depth = o.kind === "door" ? 1.05 : 0.95
    const side = o.kind === "door" ? 0.3 : 0.4
    zones.push(o.axis === "x" ? [o.a0 - side, o.at - depth, o.a1 + side, o.at + depth] : [o.at - depth, o.a0 - side, o.at + depth, o.a1 + side])
  }
  const winRects = openings.filter((o) => o.kind === "window").map((o): Rect => (o.axis === "x" ? [o.a0, o.at - 0.3, o.a1, o.at + 0.3] : [o.at - 0.3, o.a0, o.at + 0.3, o.a1]))
  let placed = furnish(rooms, inners, zones, winRects, dressing.household, condition, rng)

  // Reachability: drop whatever cuts a room, a pocket of one, or a container off.
  // From the front doors only: every room must be reachable through the house, not just round the back.
  const outsideStarts: [number, number][] = doors.filter((dr) => dr.id.includes("-front")).map((dr) => {
    const cx = (dr.rect[0] + dr.rect[2]) / 2
    return [cx, dr.rect[3] + 0.6]
  })
  // Back doors count as shut for this, so the flood cannot walk round the outside and in at the back.
  const backs = doors.filter((dr) => dr.id.endsWith("-back")).map((dr) => dr.rect)
  for (let guard = 0; guard < 40; guard++) {
    const solids = [...barriers.map((b) => b.rect), ...backs, ...placed.map((p) => p.rect)]
    const ok = reachable(rect, solids, outsideStarts)
    const nav = navReachable(chunk, solids, doors.filter((dr) => !dr.id.endsWith("-back")).map((dr) => dr.rect), outsideStarts)
    const roomBad = rooms.findIndex((_, i) => {
      const inn = inners[i]!
      return !touches(ok, [inn[0] + 0.45, inn[1] + 0.45, inn[2] - 0.45, inn[3] - 0.45], 0) || !touches(nav, inn, 0)
    })
    const propBad = placed.findIndex((p) => !touches(ok, p.rect, 0.75))
    // No pocket of a room walled off by furniture, for survivors or the dead.
    let hole: [number, number] | null = null
    for (let i = 0; i < rooms.length && !hole; i++) hole = pocket(ok, inners[i]!, CELL, 0.5) ?? pocket(nav, inners[i]!, 0.5, 0.6)
    if (roomBad < 0 && propBad < 0 && !hole) break
    // Drop the piece nearest the trouble (the cut-off room, the pocket, or the unreachable piece itself), loose furniture first.
    const target: Rect = roomBad >= 0 ? rects[roomBad]! : propBad >= 0 ? placed[propBad]!.rect : [hole![0], hole![1], hole![0], hole![1]]
    let k = -1, best = Infinity
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i]!
      const dist = distToRect((p.rect[0] + p.rect[2]) / 2, (p.rect[1] + p.rect[3]) / 2, target) + (p.essential ? 100 : 0)
      if (dist < best) { best = dist; k = i }
    }
    if (k < 0) break
    placed = placed.filter((_, i) => i !== k)
  }

  const props: Prop[] = []
  const closets: { x: number; y: number }[] = []
  const loot = new Map<Prop, LootHint>()
  const bonus = dressing.household === "hideout" ? 4 : 0
  const bare = condition === "burnt" || dressing.household === "ransacked"
  for (const p of placed) {
    if (p.closet) {
      closets.push({ x: p.prop.x, y: p.prop.y })
      continue
    }
    props.push(p.prop)
    if (p.table || bonus || bare) loot.set(p.prop, { ...(p.table ? { table: p.table } : {}), ...(bonus ? { ammoBonus: bonus } : {}), ...(bare ? { bare: true } : {}) })
  }

  // Lamps: a porch light at each front door, a few room lights, and a window lamp behind the first front window.
  const lamps: Lamp[] = []
  if (condition !== "burnt") {
    for (const dr of doors) if (dr.id.includes("-front")) lamps.push({ x: r2(dr.rect[0] + 0.7), y: r2(dr.rect[3] + 0.55), h: 2.42, radius: 8.8, power: 1.05, kind: "porch" })
    if (condition !== "construction") {
      const lit = rooms
        .map((r, i) => ({ i, area: (inners[i]![2] - inners[i]![0]) * (inners[i]![3] - inners[i]![1]), type: r.type }))
        .filter((r) => r.type !== "bath" && r.type !== "garage" && r.type !== "store")
        .sort((p, q) => q.area - p.area)
        .slice(0, 4)
      for (const { i } of lit) {
        const inn = inners[i]!
        const span = Math.min(inn[2] - inn[0], inn[3] - inn[1])
        lamps.push({ x: r2((inn[0] + inn[2]) / 2), y: r2((inn[1] + inn[3]) / 2), h: 2.36, radius: r2(Math.max(3.4, Math.min(4.8, span * 0.8 + 1.5))), power: r2(0.32 + rng.next() * 0.12), kind: "room" })
      }
      const fw = openings.find((o) => o.kind === "window" && o.axis === "x" && o.edge?.side === 1 && !o.boarded)
      if (fw) lamps.push({ x: r2((fw.a0 + fw.a1) / 2), y: r2(fw.at + 0.12), h: 1.45, radius: 3.5, power: 0.44, kind: "window" })
    }
  }

  const style: HouseStyle = { ...dressing, rooms: rooms.map((r) => ({ rect: r.rect, type: r.type })), yard: [] }

  // Grounds: fences, the outbuilding and yard things, all inside the chunk and off the street and the driveway.
  const [cx0, cz0, cx1, cz1] = chunk
  const driveway: Rect = [rect[0] - 3.2, rect[1] - 0.5, rect[0] - 0.2, rect[3] + 3]
  const solidsOut: Rect[] = []
  const inChunk = (r: Rect, m = 0.5) => r[0] >= cx0 + m && r[2] <= cx1 - m && r[1] >= cz0 + m && r[3] <= cz1 - m
  const roadFree = (r: Rect, pad = 0.6) => !input.inRoad((r[0] + r[2]) / 2, (r[1] + r[3]) / 2, pad) && !input.inRoad(r[0], r[1], pad) && !input.inRoad(r[2], r[3], pad) && !input.inRoad(r[0], r[3], pad) && !input.inRoad(r[2], r[1], pad)
  const clearOf = (r: Rect, m: number) => !overlaps(r, rect, m + 0.6) && !overlaps(r, driveway, m) && !solidsOut.some((s) => overlaps(s, r, m))
  const fenceCol = dressing.fence === "picket" ? 0x756b51 : dressing.fence === "chainlink" ? 0x6a6e70 : dressing.fence === "rail" ? 0x5e4a36 : 0x2e3a24
  const fy = r2(Math.max(cz0 + 1.2, rect[1] - Math.min(7, rect[1] - cz0 - 1.2)))
  const backDepth = rect[1] - fy
  const fx0 = r2(Math.max(cx0 + 0.6, rect[0] - 3.5)), fx1 = r2(Math.min(cx1 - 0.6, rect[2] + 1.8))
  // Detached garage or carport beside the driveway.
  if (dressing.garage === "detached" || dressing.garage === "carport") {
    const gx0 = r2(rect[0] - 3.5), gx1 = r2(rect[0] - 0.4)
    if (dressing.garage === "carport") {
      const c: Rect = [gx0, r2(rect[3] - 4.7), gx1, r2(rect[3] + 0.4)]
      if (inChunk(c) && roadFree(c)) style.outbuilding = c
      else style.garage = "none"
    } else {
      const deep = rect[3] - 4.6 - 5.4 >= rect[1] - 0.3
      const g: Rect = deep ? [gx0, r2(rect[3] - 10), gx1, r2(rect[3] - 4.6)] : [gx0, r2(rect[1] - 5.8), gx1, r2(rect[1] - 0.4)]
      if (inChunk(g) && roadFree(g) && (deep || g[1] > fy + 0.3)) {
        style.outbuilding = g
        solidsOut.push(g)
        barriers.push({ rect: g, color: color, kind: "wall", hidden: true })
      } else style.garage = "none"
    }
  }
  if (dressing.fence !== "none" && backDepth >= 2.4) {
    const hidden = dressing.fence !== "picket"
    const fence = (r: Rect) => {
      if (!inChunk(r, 0.3) || !roadFree(r, 0.4) || (style.outbuilding && overlaps(r, style.outbuilding, 0.3))) return
      // Derelict picket fences have lost sections.
      if (condition === "derelict" && dressing.fence === "picket" && r[2] - r[0] > 3) {
        const g = r[0] + 1 + rng.next() * (r[2] - r[0] - 2.4)
        barriers.push({ rect: [r2(r[0]), r[1], r2(g), r[3]], color: fenceCol, kind: "fence" })
        barriers.push({ rect: [r2(g + 1.2), r[1], r2(r[2]), r[3]], color: fenceCol, kind: "fence" })
        return
      }
      barriers.push({ rect: [r2(r[0]), r2(r[1]), r2(r[2]), r2(r[3])], color: fenceCol, kind: "fence", ...(hidden ? { hidden: true } : {}) })
    }
    fence([fx0, fy, fx1, fy + 0.12])
    if (fx0 >= cx0 + 0.6 && rect[0] - fx0 > 2.9) fence([fx0, fy, fx0 + 0.12, r2(rect[3] - 0.8)])
    if (fx1 - rect[2] > 1.2) fence([fx1 - 0.12, fy, fx1, r2(rect[3] - 0.8)])
  }
  // Yard things in the back yard (inside the fence line) and, for junk, beside the driveway.
  const yardWants: YardKind[] = []
  const hh = dressing.household
  const pool: [YardKind, number][] = [
    ["shed", 1],
    ["garden", hh === "elderly" ? 2.5 : 1],
    ["swing", hh === "family" ? 2.5 : 0.3],
    ["trampoline", hh === "family" ? 1.2 : 0.1],
    ["clothesline", 1],
    ["woodpile", form === "farmhouse" || input.archetype === "cabin" ? 2.5 : 0.6],
    ["pool", 0.35],
    ["junk_car", condition === "derelict" || form === "trailer" ? 2.5 : 0.25],
    ["tyres", condition === "derelict" || form === "trailer" ? 2 : 0.3],
  ]
  const yardCount = Math.round((condition === "construction" ? 0.5 : condition === "burnt" ? 0.6 : 1.6) * variety.yard + rng.next() * variety.yard)
  for (let k = 0; k < yardCount; k++) {
    let total = 0
    for (const [, wgt] of pool) total += wgt
    let roll = rng.next() * total
    for (const item of pool) {
      roll -= item[1]
      if (roll < 0) {
        yardWants.push(item[0])
        item[1] = 0
        break
      }
    }
  }
  const SIZES: Record<YardKind, [number, number]> = {
    shed: [2.1, 1.7],
    swing: [2.8, 1.4],
    garden: [2.6, 1.6],
    pool: [3.2, 3.2],
    junk_car: [2, 4.3],
    woodpile: [1.8, 0.8],
    clothesline: [3.4, 0.4],
    tyres: [1.1, 1.1],
    trampoline: [3, 3],
  }
  const COLLIDES: Partial<Record<YardKind, Barrier["kind"]>> = { shed: "wall", pool: "fence", junk_car: "fence", woodpile: "fence" }
  const yardArea: Rect = [fx0 + 0.4, fy + 0.4, fx1 - 0.4, rect[1] - 0.7]
  for (const kind of yardWants) {
    const [sw, sd] = SIZES[kind]
    const areas: Rect[] = [yardArea]
    if (kind === "junk_car") areas.unshift([rect[0] - 3.1, rect[1] + 0.3, rect[0] - 0.7, rect[3] - 4.6])
    let done = false
    for (const area of areas) {
      if (done) break
      for (let t = 0; t < 10 && !done; t++) {
        const ax = area[0] + sw / 2, bx = area[2] - sw / 2, az = area[1] + sd / 2, bz = area[3] - sd / 2
        if (bx < ax || bz < az) break
        const px = ax + (bx - ax) * rng.next(), pz = az + (bz - az) * rng.next()
        const r: Rect = [r2(px - sw / 2), r2(pz - sd / 2), r2(px + sw / 2), r2(pz + sd / 2)]
        const inDriveSide = area !== yardArea
        if (!inChunk(r) || !roadFree(r) || (!inDriveSide && !clearOf(r, 0.5)) || barriers.some((b) => b.kind === "fence" && overlaps(b.rect, r, 0.35)) || solidsOut.some((s) => overlaps(s, r, 0.5))) continue
        if (inDriveSide && (overlaps(r, rect, 0.3) || solidsOut.some((s) => overlaps(s, r, 0.4)))) continue
        style.yard.push({ kind, rect: r, yaw: Number(((rng.next() - 0.5) * 0.3).toFixed(3)) })
        solidsOut.push(r)
        const k = COLLIDES[kind]
        if (k) barriers.push({ rect: kind === "pool" ? [r2(r[0] + 0.25), r2(r[1] + 0.25), r2(r[2] - 0.25), r2(r[3] - 0.25)] : r, color: kind === "shed" ? 0x464f5a : 0x4a4a44, kind: k, hidden: true })
        done = true
      }
    }
  }

  const building: Building = {
    id,
    kind: "hardware",
    archetype,
    district: input.district,
    rect,
    color,
    footprint: rects,
    style,
  }
  return { building, barriers, doors, windows, props, closets, lamps, loot }
}

/** Yard things and outbuildings that stand on the ground (trees and spawns keep off them). */
export function houseGroundRects(b: Building): Rect[] {
  const s = b.style
  if (!s) return []
  const out: Rect[] = s.yard.map((y: YardItem) => y.rect)
  if (s.outbuilding) out.push(s.outbuilding)
  return out
}
