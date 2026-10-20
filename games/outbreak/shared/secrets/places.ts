import { distToRect, type Rect } from "@arcade/kit/sim/geom"
import { propShape, type Building, type Prop, type Town } from "../map"
import { secretHash, type SecretId, type SecretSeeds } from "./catalog"
import { hostedIn, isSecretHome, type SecretHost } from "./hosts"
import type { SecretRun } from "./select"

/**
 * Where a run's secrets stand in one building: a pure function of the town's geometry, the run and the one-house
 * hosts, computed per building so the streaming window can move without replanning and every client agrees. Plan
 * coordinates (`x`, `y`); `z` is the height above the floor or ground; `yaw` turns a model's +z (its front) off +y.
 */
export type SecretPiece =
  | "calendar"
  | "clock"
  | "photo"
  | "chalk"
  | "nod"
  | "chair"
  | "window"
  | "footprint"
  | "phone"
  | "rocker"
  | "hatch"
  | "set"
  | "page"
  | "mast"

export type SecretSite = {
  readonly secret: SecretId
  readonly piece: SecretPiece
  /** Unique per run: `<piece>:<building>[:n]`. */
  readonly key: string
  readonly buildingId: string
  readonly x: number
  readonly y: number
  readonly z: number
  readonly yaw: number
  /** Piece-specific: photo faces (low nibble) and which is scratched (high, 0 none); footprint side; chair lean. */
  readonly variant: number
  /** Where a survivor stands to look at it or use it. */
  readonly rect: Rect
}

/** Chance a home has each per-house piece (the cellar's house always has a clock and a calendar). */
export const PER_HOUSE = { calendar: 0.55, clock: 0.4, photo: 0.35, scratched: 0.42, chalk: 0.22 } as const

/** Heights of the wall pieces' centres (m). */
export const WALL_HEIGHT = { calendar: 1.42, clock: 1.78, photo: 1.5, phone: 1.36 } as const
/** Half-widths of the wall pieces (m). */
const HALF = { calendar: 0.17, clock: 0.18, photo: 0.2, phone: 0.12 } as const

/** Tall furniture hides the wall behind it. */
const TALL: ReadonlySet<Prop["kind"]> = new Set(["shelf", "fridge", "closet"])
const KITCHEN: ReadonlySet<Prop["kind"]> = new Set(["counter", "fridge", "stove"])
const LIVING: ReadonlySet<Prop["kind"]> = new Set(["sofa", "coffee"])
const BEDROOM: ReadonlySet<Prop["kind"]> = new Set(["bed", "dresser", "nightstand"])
/** Tables the radio man's set can stand on, and their tops (the generated furniture's, under the collision boxes). */
const SET_TABLES: readonly Prop["kind"][] = ["table", "desk", "workbench", "coffee", "dresser", "counter", "nightstand"]
const TOPS: Partial<Record<Prop["kind"], number>> = { table: 0.76, desk: 0.74, workbench: 0.9, coffee: 0.46, dresser: 0.8, counter: 0.9, nightstand: 0.6 }
/** How much floor north of an east–west wall it hides from the camera (`discovery/vignettes.ts`). */
const WALL_SHADOW = 2.4

const r3 = (v: number) => Math.round(v * 1000) / 1000
const roll = (seeds: SecretSeeds, key: string) => secretHash(`${seeds.seed}:${seeds.houseSeed}:place:${key}`) / 4294967296

type Solids = { walls: Rect[]; all: Rect[]; doors: Rect[]; windows: Rect[]; props: Prop[]; propRects: Rect[] }

function solidsOf(town: Town, b: Building): Solids {
  const box = b.rect
  const near = (r: Rect) => r[2] > box[0] - 0.3 && r[0] < box[2] + 0.3 && r[3] > box[1] - 0.3 && r[1] < box[3] + 0.3
  const walls = town.barriers.filter((w) => w.kind === "wall" && near(w.rect)).map((w) => w.rect)
  const all = town.barriers.filter((w) => w.kind !== "fence" && near(w.rect)).map((w) => w.rect)
  const doors = town.doors.filter((d) => near(d.rect)).map((d) => d.rect)
  const windows = town.windows.filter((w) => near(w.rect)).map((w) => w.rect)
  const inside = (p: Prop) => p.kind !== "tree" && p.x >= box[0] && p.x <= box[2] && p.y >= box[1] && p.y <= box[3]
  const props = town.props.filter(inside).sort((a, c) => a.x - c.x || a.y - c.y || (a.kind < c.kind ? -1 : 1))
  const propRects = props.map((p) => propShape(p)?.rect).filter((r): r is Rect => Boolean(r))
  return { walls: sortRects(walls), all: sortRects(all), doors: sortRects(doors), windows: sortRects(windows), props, propRects }
}

const sortRects = (rs: Rect[]) => rs.sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[3] - b[3] || a[2] - b[2])

/** Is there a wall, window or door south of (x, y) before the building ends? (Then (x, y) is indoors, not a notch.) */
function enclosedSouth(s: Solids, b: Building, x: number, y: number): boolean {
  for (const r of [...s.all, ...s.doors]) if (x > r[0] && x < r[2] && r[1] >= y && r[1] <= b.rect[3] + 0.1) return true
  return false
}

/** A wall face the camera sees: the south face of an east–west wall inside a building, with floor in front. */
type Face = { x0: number; x1: number; y: number }

function faces(s: Solids, b: Building): Face[] {
  const out: Face[] = []
  for (const w of s.walls) {
    if (w[2] - w[0] < w[3] - w[1]) continue
    const y = w[3]
    if (y >= b.rect[3] - 0.3 || y < b.rect[1] - 0.05) continue
    const x0 = Math.max(w[0], b.rect[0]) + 0.3
    const x1 = Math.min(w[2], b.rect[2]) - 0.3
    if (x1 - x0 < 0.5) continue
    if (!enclosedSouth(s, b, (x0 + x1) / 2, y + 0.4)) continue
    out.push({ x0, x1, y })
  }
  return out
}

type Hung = { x: number; y: number; half: number }

/** A spot `half` wide on a seen wall face, clear of tall furniture, doors and windows, and what is already hung there. */
function wallSpot(seeds: SecretSeeds, s: Solids, b: Building, hung: Hung[], half: number, key: string, prefer?: ReadonlySet<Prop["kind"]>): { x: number; y: number } | null {
  const fs = faces(s, b)
  if (!fs.length) return null
  const anchors = prefer ? s.props.filter((p) => prefer.has(p.kind)) : []
  const cands: { x: number; y: number; score: number }[] = []
  for (const f of fs) {
    for (let x = f.x0 + half; x <= f.x1 - half + 1e-6; x += 0.25) {
      const y = f.y
      if (s.doors.some((d) => distToRect(x, y, d) < half + 0.25)) continue
      if (s.windows.some((w) => distToRect(x, y, w) < half + 0.2)) continue
      if (s.props.some((p) => TALL.has(p.kind) && overlapsFront(p, x, y, half))) continue
      if (hung.some((h) => Math.abs(h.y - y) < 0.05 && Math.abs(h.x - x) < h.half + half + 0.35)) continue
      const near = anchors.length ? Math.min(...anchors.map((p) => Math.hypot(p.x - x, p.y - y))) : 0
      cands.push({ x: r3(x), y: r3(y), score: near + roll(seeds, `${key}:${x.toFixed(2)},${y.toFixed(2)}`) * (anchors.length ? 1.5 : 10) })
    }
  }
  if (!cands.length) return null
  cands.sort((a, c) => a.score - c.score || a.x - c.x || a.y - c.y)
  const best = cands[0]!
  hung.push({ x: best.x, y: best.y, half })
  return best
}

function overlapsFront(p: Prop, x: number, y: number, half: number): boolean {
  const sh = propShape(p)
  if (!sh) return false
  const r = sh.rect
  return r[2] > x - half && r[0] < x + half && r[1] < y + 0.9 && r[3] > y - 0.1
}

/** Is a floor spot of radius `r` clear of walls, furniture and (by `doorPad`) doors, inside the building? */
function floorFree(s: Solids, b: Building, x: number, y: number, r: number, doorPad = 0.8): boolean {
  if (x - r < b.rect[0] || x + r > b.rect[2] || y - r < b.rect[1] || y + r > b.rect[3]) return false
  if (!enclosedSouth(s, b, x, y)) return false
  for (const w of s.all) if (distToRect(x, y, w) < r + 0.06) return false
  for (const p of s.propRects) if (distToRect(x, y, p) < r + 0.08) return false
  for (const d of s.doors) if (distToRect(x, y, d) < r + doorPad) return false
  return true
}

/** And the camera sees it: no east–west wall within `WALL_SHADOW` south of it. */
function seen(s: Solids, x: number, y: number, r: number): boolean {
  for (const w of s.all) if (w[2] - w[0] >= w[3] - w[1] && x > w[0] - r && x < w[2] + r && w[1] > y && w[1] - y < WALL_SHADOW) return false
  return true
}

const rectAround = (x: number, y: number, hx: number, hy: number): Rect => [r3(x - hx), r3(y - hy), r3(x + hx), r3(y + hy)]
/** Where a survivor stands to look at a wall piece: the floor in front of it. */
const lookRect = (x: number, y: number, half: number): Rect => rectAround(x, y + 0.5, half + 0.1, 0.5)

export type CellarPlan = { hatch: SecretSite; set: SecretSite | null; page: SecretSite | null }

/** The cellar's hatch in its host: the first clear, seen floor spot in seeded order. Null when the house has none. */
export function hatchSpot(town: Town, b: Building, seeds: SecretSeeds, s: Solids = solidsOf(town, b)): { x: number; y: number } | null {
  const cands: { x: number; y: number; k: number }[] = []
  for (let x = b.rect[0] + 0.8; x <= b.rect[2] - 0.8; x += 0.35) {
    for (let y = b.rect[1] + 0.8; y <= b.rect[3] - 0.8; y += 0.35) {
      cands.push({ x: r3(x), y: r3(y), k: roll(seeds, `hatch:${b.id}:${x.toFixed(2)},${y.toFixed(2)}`) })
    }
  }
  cands.sort((a, c) => a.k - c.k)
  for (const c of cands) if (floorFree(s, b, c.x, c.y, 0.62, 1.0) && seen(s, c.x, c.y, 0.6)) return { x: c.x, y: c.y }
  for (const c of cands) if (floorFree(s, b, c.x, c.y, 0.55, 0.8)) return { x: c.x, y: c.y }
  return null
}

/** The table the radio man's set stands on: the house's dining table, else a workbench, coffee table or dresser. */
function setTable(s: Solids): Prop | undefined {
  for (const kind of SET_TABLES) {
    const p = s.props.find((q) => q.kind === kind)
    if (p) return p
  }
  return undefined
}

/**
 * Every secret piece in building `b` for a run. Per-house pieces roll on the building id; one-house pieces come from
 * `hosts`. Order-independent: nothing depends on the order the town lists its barriers, doors or props.
 */
export function secretSitesIn(town: Town, b: Building, run: SecretRun, hosts: ReadonlyMap<SecretId, SecretHost>): SecretSite[] {
  if (!isSecretHome(b)) return []
  const out: SecretSite[] = []
  const s = solidsOf(town, b)
  const hung: Hung[] = []
  const seeds = run
  const here = new Set(hostedIn(hosts, b.id))
  const has = (id: SecretId) => run.picked.has(id)
  const push = (secret: SecretId, piece: SecretPiece, x: number, y: number, z: number, yaw: number, variant: number, rect: Rect, n?: number) =>
    out.push({ secret, piece, key: `${piece}:${b.id}${n === undefined ? "" : `:${n}`}`, buildingId: b.id, x: r3(x), y: r3(y), z: r3(z), yaw: r3(yaw), variant, rect })
  const cellar = here.has("cellar")

  if (has("calendar") && (cellar || roll(seeds, `calendar:${b.id}`) < PER_HOUSE.calendar)) {
    const at = wallSpot(seeds, s, b, hung, HALF.calendar, `calendar:${b.id}`, KITCHEN)
    if (at) push("calendar", "calendar", at.x, at.y + 0.012, WALL_HEIGHT.calendar, 0, 0, lookRect(at.x, at.y, HALF.calendar))
  }
  if (has("clock") && (cellar || roll(seeds, `clock:${b.id}`) < PER_HOUSE.clock)) {
    const at = wallSpot(seeds, s, b, hung, HALF.clock, `clock:${b.id}`, LIVING)
    if (at) push("clock", "clock", at.x, at.y + 0.02, WALL_HEIGHT.clock, 0, 0, lookRect(at.x, at.y, HALF.clock))
  }
  if (has("photo") && roll(seeds, `photo:${b.id}`) < PER_HOUSE.photo) {
    const at = wallSpot(seeds, s, b, hung, HALF.photo, `photo:${b.id}`, BEDROOM)
    if (at) {
      const faces = 2 + Math.floor(roll(seeds, `photo-n:${b.id}`) * 4)
      const scratched = roll(seeds, `photo-x:${b.id}`) < PER_HOUSE.scratched ? 1 + Math.floor(roll(seeds, `photo-who:${b.id}`) * faces) : 0
      push("photo", "photo", at.x, at.y + 0.015, WALL_HEIGHT.photo, 0, faces | (scratched << 4), lookRect(at.x, at.y, HALF.photo))
    }
  }
  if (has("chalk") && roll(seeds, `chalk:${b.id}`) < PER_HOUSE.chalk) {
    const at = chalkSpot(town, b)
    if (at) push("chalk", "chalk", at.x, at.y, 0.004, at.yaw, Math.floor(roll(seeds, `chalk-v:${b.id}`) * 4), rectAround(at.x, at.y, 1.6, 1.4))
  }

  if (cellar) {
    const hatch = hatchSpot(town, b, seeds, s)
    if (hatch) push("cellar", "hatch", hatch.x, hatch.y, 0, 0, 0, rectAround(hatch.x, hatch.y, 0.55, 0.55))
    const table = setTable(s)
    const shape = table && propShape(table)
    if (table && shape) {
      const [x0, y0, x1, y1] = shape.rect
      const top = TOPS[table.kind] ?? shape.height
      const sx = x0 + (x1 - x0) * 0.74
      const sy = y0 + (y1 - y0) * 0.34
      push("cellar", "set", sx, sy, top, 0, 0, rectAround(sx, sy + 0.4, 0.5, 0.6))
      const px = x0 + (x1 - x0) * 0.4
      const py = y0 + (y1 - y0) * 0.42
      push("cellar", "page", px, py, top + 0.004, 0.18, 0, rectAround(px, py + 0.4, 0.5, 0.6))
    } else if (hatch) {
      // No table in the house: the set sits on the floor beside the hatch, the page under it.
      const spot = [1, -1, 0, 0].map((dx, i) => ({ x: hatch.x + dx * 1.0, y: hatch.y + (i < 2 ? 0 : i === 2 ? 1.0 : -1.0) })).find((q) => floorFree(s, b, q.x, q.y, 0.28, 0.4))
      if (spot) {
        push("cellar", "set", spot.x, spot.y, 0, 0, 0, rectAround(spot.x, spot.y + 0.4, 0.5, 0.6))
        push("cellar", "page", spot.x - 0.3, spot.y + 0.32, 0.004, 0.18, 0, rectAround(spot.x - 0.3, spot.y + 0.7, 0.5, 0.6))
      }
    }
    const east = roll(seeds, `mast:${b.id}`) < 0.5
    const mx = east ? b.rect[2] + 1.4 : b.rect[0] - 1.4
    const my = b.rect[1] + (b.rect[3] - b.rect[1]) * 0.35
    if (!town.buildings.some((o) => o !== b && distToRect(mx, my, o.rect) < 1.2)) push("cellar", "mast", mx, my, 0, 0, 0, rectAround(mx, my, 0.4, 0.4))
  }

  if (here.has("footprints")) footprints(out, town, b, s, seeds, cellar ? out.find((o) => o.piece === "hatch") : undefined)

  if (here.has("audience")) {
    const fs = faces(s, b).sort((a, c) => c.x1 - c.x0 - (a.x1 - a.x0) || a.y - c.y || a.x0 - c.x0)
    for (const f of fs) {
      const chairs: { x: number; y: number }[] = []
      const cx = (f.x0 + f.x1) / 2
      for (let row = 0; row < 3; row++) {
        for (const dx of [-0.75, 0, 0.75]) {
          const x = cx + dx + (row % 2 ? 0.12 : 0)
          const y = f.y + 1.15 + row * 0.85
          if (floorFree(s, b, x, y, 0.24, 0.5)) chairs.push({ x, y })
        }
      }
      if (chairs.length < 5) continue
      chairs.forEach((c, i) => {
        // The middle of the front row is pushed back and turned, as if someone just stood up from it.
        const up = i === 1 && Math.abs(c.x - cx) < 0.2
        push("audience", "chair", c.x, c.y + (up ? 0.32 : 0), 0, Math.PI + (up ? 0.45 : (roll(seeds, `chair:${b.id}:${i}`) - 0.5) * 0.08), up ? 1 : 0, rectAround(c.x, c.y, 2.6, 2.6), i)
      })
      break
    }
  }

  if (here.has("litWindow")) {
    const south = town.windows
      .filter((w) => w.buildingId === b.id && Math.abs(w.rect[3] - b.rect[3]) < 0.05)
      .sort((a, c) => a.rect[0] - c.rect[0])
    const w = south[Math.floor(roll(seeds, `window:${b.id}`) * south.length)]
    if (w) {
      const x = (w.rect[0] + w.rect[2]) / 2
      push("litWindow", "window", x, w.rect[3], 0, 0, Math.round((w.rect[2] - w.rect[0]) * 100), rectAround(x, w.rect[3] + 6, 8, 8))
      const cy = w.rect[1] - 1.0
      if (floorFree(s, b, x, cy, 0.24, 0.3)) push("litWindow", "chair", x, cy, 0, 0, 0, rectAround(x, cy, 1.2, 1.2), 0)
    }
  }

  if (here.has("phone")) {
    const at = wallSpot(seeds, s, b, hung, HALF.phone, `phone:${b.id}`, KITCHEN)
    if (at) push("phone", "phone", at.x, at.y + 0.04, WALL_HEIGHT.phone, 0, 0, lookRect(at.x, at.y, HALF.phone + 0.3))
  }

  if (here.has("rockingChair")) {
    const front = town.doors.find((d) => d.id === `${b.id}-front`)
    if (front) {
      const side = roll(seeds, `rocker:${b.id}`) < 0.5 ? -1 : 1
      const x = (front.rect[0] + front.rect[2]) / 2 + side * 1.55
      const y = b.rect[3] + 0.75
      push("rockingChair", "rocker", x, y, 0, side * 0.35, 0, rectAround(x, y, 0.5, 0.5))
    }
  }

  if (here.has("nod")) {
    const fs = faces(s, b)
    for (const f of fs.sort((a, c) => a.y - c.y || a.x0 - c.x0)) {
      const x = f.x0 + (f.x1 - f.x0) * (0.25 + roll(seeds, `nod:${b.id}`) * 0.5)
      const y = f.y + 0.32
      if (!floorFree(s, b, x, y, 0.28, 0.6)) continue
      push("nod", "nod", x, y, 0, (roll(seeds, `nod-yaw:${b.id}`) - 0.5) * 0.25, 0, rectAround(x, y + 0.8, 1, 1))
      break
    }
  }
  return out
}

/** Chalk on the driveway of a bungalow, else the front path's side. Null if a parked car is on it. */
function chalkSpot(town: Town, b: Building): { x: number; y: number; yaw: number } | null {
  const [a, , , e] = b.rect
  const front = town.doors.find((d) => d.id === `${b.id}-front`)
  const options = b.kind === "house" ? [{ x: a - 1.7, y: e + 2.3 }, { x: a - 1.7, y: e + 4.6 }] : []
  if (front) {
    const cx = (front.rect[0] + front.rect[2]) / 2
    options.push({ x: cx + 2.6, y: e + 2.2 }, { x: cx - 2.6, y: e + 2.2 })
  }
  for (const o of options) {
    if ((town.vehicles ?? []).some((v) => distToRect(o.x, o.y, v) < 1.2)) continue
    if (town.buildings.some((q) => distToRect(o.x, o.y, q.rect) < 0.9)) continue
    if (town.barriers.some((w) => distToRect(o.x, o.y, w.rect) < 0.9)) continue
    return { x: r3(o.x), y: r3(o.y), yaw: 0 }
  }
  return null
}

const STRIDE = 0.42

/** Bare footprints from the road up to the side wall, and on inside from the wall to the hatch or the room's middle. */
function footprints(out: SecretSite[], town: Town, b: Building, s: Solids, seeds: SecretSeeds, hatch: SecretSite | undefined): void {
  const east = hatch ? hatch.x > (b.rect[0] + b.rect[2]) / 2 : roll(seeds, `prints:${b.id}`) < 0.5
  const wallX = east ? b.rect[2] : b.rect[0]
  const out1 = east ? 1 : -1
  // Where they meet the wall: level with the hatch, else a seen spot along the side wall indoors.
  let wy = hatch ? hatch.y : b.rect[1] + (b.rect[3] - b.rect[1]) * 0.5
  for (let i = 0; i < 12 && !floorFree(s, b, wallX - out1 * 0.6, wy, 0.2, 0.4); i++) wy += i % 2 ? i * 0.3 : -i * 0.3
  const start = { x: wallX + out1 * 3.2, y: b.rect[3] + 5.5 }
  const meet = { x: wallX + out1 * 0.22, y: wy }
  const inside = hatch ? { x: hatch.x + (wallX > hatch.x ? 0.75 : -0.75), y: hatch.y } : { x: wallX - out1 * Math.min(3, (b.rect[2] - b.rect[0]) * 0.3), y: wy }
  let n = 0
  const walk = (from: { x: number; y: number }, to: { x: number; y: number }, ok: (x: number, y: number) => boolean) => {
    const len = Math.hypot(to.x - from.x, to.y - from.y)
    // Model +z (the toes) turned by yaw points along (−sin yaw, cos yaw).
    const yaw = Math.atan2(-(to.x - from.x), to.y - from.y)
    const steps = Math.max(1, Math.floor(len / STRIDE))
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const side = n % 2 ? 1 : -1
      const x = from.x + (to.x - from.x) * t + Math.cos(yaw) * 0.09 * side
      const y = from.y + (to.y - from.y) * t + Math.sin(yaw) * 0.09 * side
      if (!ok(x, y)) continue
      out.push({ secret: "footprints", piece: "footprint", key: `footprint:${b.id}:${n}`, buildingId: b.id, x: r3(x), y: r3(y), z: 0.003, yaw: r3(yaw + (roll(seeds, `print:${b.id}:${n}`) - 0.5) * 0.2), variant: side > 0 ? 1 : 0, rect: rectAround(x, y, 0.9, 0.9) })
      n++
    }
  }
  const outdoors = (x: number, y: number) => !town.buildings.some((q) => distToRect(x, y, q.rect) < 0.12) && !town.barriers.some((w) => w.kind === "fence" && distToRect(x, y, w.rect) < 0.15)
  walk(start, meet, outdoors)
  walk({ x: wallX - out1 * 0.35, y: wy }, inside, (x, y) => floorFree(s, b, x, y, 0.08, 0.2))
}
