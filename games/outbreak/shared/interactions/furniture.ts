import { distToRect, type Rect } from "@arcade/kit/sim/geom"
import type { StoreState } from "@arcade/kit/sim/ledger"
import { propShape, type Building, type Door, type Town, type WindowOpening } from "../map"

/**
 * Loose furniture (AR-96, Kit: "The ability to drag items"): a chair, a table, a dresser or a mattress left loose in
 * a house, which a survivor drags (E) and sets down, and which, set down against a door or window, braces it: the dead
 * bash the planks off first, then the furniture, until it is shoved aside (`PortalHolds` on the crowd). A chair wedges
 * under a door handle; a mattress goes up against a window or a door; a table or dresser does either.
 *
 * The house's own furniture stays where the level bakes it; these pieces are extra, found where there is floor for
 * them. Each is one ledger store, so co-op seats see it with the ledger deltas and nothing is added to the wire.
 *
 * | Store | Counts | Meaning |
 * | --- | --- | --- |
 * | `furn:<building>:<i>` | `k`, `yaw` (centiradians), `drag`, `br`, `px`, `py` (cm), `hp`, `down` | a piece at `at`; dragged by `owner` while `drag`; bracing the portal at `p` while `br` |
 */

export const FURNITURE_KINDS = ["chair", "table", "dresser", "mattress"] as const
export type FurnitureKind = (typeof FURNITURE_KINDS)[number]

export type FurnitureDef = {
  label: string
  /** Width across its front and depth front to back, in metres (its footprint at yaw 0 is w along x, d along y). */
  w: number
  d: number
  h: number
  /** Share of walking speed while dragging it. */
  speed: number
  /** Hit points it holds a portal for. */
  hp: number
  doors: boolean
  windows: boolean
}

export const FURNITURE: Readonly<Record<FurnitureKind, FurnitureDef>> = {
  chair: { label: "Chair", w: 0.48, d: 0.48, h: 0.9, speed: 0.85, hp: 70, doors: true, windows: false },
  table: { label: "Table", w: 1.1, d: 0.7, h: 0.76, speed: 0.7, hp: 150, doors: true, windows: true },
  dresser: { label: "Dresser", w: 0.95, d: 0.48, h: 1.15, speed: 0.55, hp: 240, doors: true, windows: true },
  mattress: { label: "Mattress", w: 1.35, d: 0.24, h: 1.85, speed: 0.75, hp: 110, doors: true, windows: true },
}

export const furnStoreId = (buildingId: string, i: number) => `furn:${buildingId}:${i}`
export const isFurnStore = (id: string) => id.startsWith("furn:")
export const furnKind = (st: StoreState): FurnitureKind => FURNITURE_KINDS[st.counts.k ?? 0] ?? "chair"
export const furnYaw = (st: StoreState) => (st.counts.yaw ?? 0) / 100

/** A piece's footprint: the box round its centre at `yaw`, as an axis-aligned rect (what survivors push against). */
export function furnRect(x: number, y: number, kind: FurnitureKind, yaw: number, down = false): Rect {
  const def = FURNITURE[kind]
  // Toppled, a tall piece lies along its height.
  const w = def.w
  const d = down ? Math.min(def.h, 1.9) : def.d
  const c = Math.abs(Math.cos(yaw))
  const s = Math.abs(Math.sin(yaw))
  const hx = (w * c + d * s) / 2
  const hy = (w * s + d * c) / 2
  return [x - hx, y - hy, x + hx, y + hy]
}

export type Portal = { id: string; kind: "door" | "window"; x: number; y: number; rect: Rect; horizontal: boolean }

const portalOf = (o: Door | WindowOpening, kind: "door" | "window"): Portal => ({
  id: o.id,
  kind,
  x: (o.rect[0] + o.rect[2]) / 2,
  y: (o.rect[1] + o.rect[3]) / 2,
  rect: o.rect,
  horizontal: o.rect[2] - o.rect[0] >= o.rect[3] - o.rect[1],
})

/** The door or window within `range` of `(x, y)` a piece of `kind` can brace, nearest first. */
export function braceTarget(town: Town, x: number, y: number, kind: FurnitureKind, range: number): Portal | null {
  const def = FURNITURE[kind]
  let best: Portal | null = null
  let bestD = range
  if (def.doors) for (const d of town.doors) {
    const dist = distToRect(x, y, d.rect)
    if (dist < bestD) [best, bestD] = [portalOf(d, "door"), dist]
  }
  if (def.windows) for (const w of town.windows) {
    if (w.open) continue
    const dist = distToRect(x, y, w.rect)
    if (dist < bestD) [best, bestD] = [portalOf(w, "window"), dist]
  }
  return best
}

/** Where a piece stands bracing `portal` from the side `(fromX, fromY)` is on: flush against it, square to it. */
export function bracePose(portal: Portal, kind: FurnitureKind, fromX: number, fromY: number): { x: number; y: number; yaw: number } {
  const def = FURNITURE[kind]
  const off = def.d / 2 + 0.1
  if (portal.horizontal) {
    const side = fromY >= portal.y ? 1 : -1
    return { x: portal.x, y: portal.y + side * off, yaw: 0 }
  }
  const side = fromX >= portal.x ? 1 : -1
  return { x: portal.x + side * off, y: portal.y, yaw: Math.PI / 2 }
}

/** The portal a braced piece holds: the door or window whose centre is at its `px, py`. */
export function bracedPortal(town: Town, st: StoreState): Portal | null {
  if (!st.counts.br) return null
  const px = (st.counts.px ?? 0) / 100
  const py = (st.counts.py ?? 0) / 100
  for (const d of town.doors) if (Math.abs((d.rect[0] + d.rect[2]) / 2 - px) < 0.05 && Math.abs((d.rect[1] + d.rect[3]) / 2 - py) < 0.05) return portalOf(d, "door")
  for (const w of town.windows) if (Math.abs((w.rect[0] + w.rect[2]) / 2 - px) < 0.05 && Math.abs((w.rect[1] + w.rect[3]) / 2 - py) < 0.05) return portalOf(w, "window")
  return null
}

function hash01(s: string, salt: number): number {
  let h = 2166136261 ^ salt
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  h = Math.imul(h ^ (h >>> 15), 2246822507)
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296
}

export type FurnitureSite = { id: string; buildingId: string; kind: FurnitureKind; x: number; y: number; yaw: number }

/**
 * The loose pieces in a house: up to two (a chair or a dresser, and a mattress or a table), on open floor clear of the
 * house's furniture, walls and doorways. A pure function of the town; `count` 0 places none.
 */
export function furnitureSites(town: Town, b: Building, count: number, solids: readonly Rect[]): FurnitureSite[] {
  if (b.kind !== "house" || count <= 0) return []
  const out: FurnitureSite[] = []
  const near = (r: Rect) => r[2] > b.rect[0] - 1 && r[0] < b.rect[2] + 1 && r[3] > b.rect[1] - 1 && r[1] < b.rect[3] + 1
  const props = town.props.filter((p) => p.kind !== "tree" && p.x > b.rect[0] && p.x < b.rect[2] && p.y > b.rect[1] && p.y < b.rect[3])
  // A closet's doors face south: keep the floor in front of it clear to step in and out.
  const blocks: Rect[] = props.flatMap((p) => {
    const s = propShape(p)
    if (!s) return []
    return p.kind === "closet" ? [s.rect, [s.rect[0], s.rect[3], s.rect[2], s.rect[3] + 2] as Rect] : [s.rect]
  })
  const walls = solids.filter(near)
  const openings = [...town.doors.map((d) => d.rect), ...town.windows.map((w) => w.rect)].filter(near)
  const wants: FurnitureKind[] = ([hash01(b.id, 41) < 0.55 ? "chair" : "dresser", hash01(b.id, 42) < 0.5 ? "mattress" : "table"] as FurnitureKind[]).slice(0, Math.min(2, Math.round(count)))
  for (const [i, kind] of wants.entries()) {
    const clear = (x: number, y: number, yaw: number) => {
      const r = furnRect(x, y, kind, yaw)
      const pad = (o: Rect, m: number) => r[0] < o[2] + m && r[2] > o[0] - m && r[1] < o[3] + m && r[3] > o[1] - m
      if (walls.some((o) => pad(o, 0.3)) || blocks.some((o) => pad(o, 0.3)) || openings.some((o) => pad(o, 1.1))) return false
      return !out.some((o) => pad(furnRect(o.x, o.y, o.kind, o.yaw), 0.5))
    }
    for (let k = 0; k < 24; k++) {
      const yaw = hash01(b.id, 60 + i * 31 + k) < 0.5 ? 0 : Math.PI / 2
      const x = b.rect[0] + 0.9 + hash01(b.id, 100 + i * 37 + k) * (b.rect[2] - b.rect[0] - 1.8)
      const y = b.rect[1] + 0.9 + hash01(b.id, 200 + i * 41 + k) * (b.rect[3] - b.rect[1] - 1.8)
      if (!clear(x, y, yaw)) continue
      out.push({ id: furnStoreId(b.id, i), buildingId: b.id, kind, x: Number(x.toFixed(2)), y: Number(y.toFixed(2)), yaw })
      break
    }
  }
  return out
}
