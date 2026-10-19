import { distToRect, type Rect } from "@arcade/kit/sim/geom"
import { Rng } from "@arcade/kit/sim/rng"
import { carSites } from "../../shared/discovery/verbs"
import { frontageEnd, inBuildingFootprint, propShape, SIZE, type Building, type Prop, type Town } from "../../shared/map"
import { supportHeight } from "../../shared/terrain"
import { carPose } from "../discovery/verbs"
import type { OutbreakDetailSettings } from "./settings"

/**
 * Where the world details go: a pure function of the town and the Details settings. Every building and car rolls from
 * its own key (`town.seed`, `dtSeed`, building id or car key), so a building keeps its details while the streaming
 * window moves and co-op clients agree. Interior pieces keep off walls, doors, windows and furniture; outdoor pieces
 * keep off buildings, fences, doorways, front paths, driveways, cars and trees.
 */

/** Every model the details draw (index = model slot in `models.ts`). */
export const DETAIL_MODELS = [
  "chair",
  "crockery",
  "mail",
  "boxes2",
  "boxes3",
  "books",
  "drawer",
  "bins",
  "binsBags",
  "dumpster",
  "mailbox",
  "suitcase",
  "suitcaseOpen",
  "bike",
  "pram",
  "cone",
  "tape",
  "tapeTail",
  "markX",
  "wordHelp",
  "wordDeadInside",
  "wordGone",
  "wordKeepOut",
  "wordDontOpen",
  "wordNo",
  "bloodDontOpen",
  "bloodDeadInside",
  "bloodKeepOut",
  "bloodHelpUs",
  "bloodTheyHear",
  "bloodStayQuiet",
  "bloodNotDead",
  "bloodGoAway",
  "bloodBitten",
  "bloodHide",
  "tv",
  "crowSit",
  "crowUp",
  "crowDown",
] as const
export type DetailModel = (typeof DETAIL_MODELS)[number]

/** Spray-painted words and the width (m) each takes on a wall. */
export const WORDS: readonly { model: DetailModel; text: string; height: number }[] = [
  { model: "wordHelp", text: "HELP", height: 0.42 },
  { model: "wordDeadInside", text: "DEAD INSIDE", height: 0.3 },
  { model: "wordGone", text: "GONE", height: 0.36 },
  { model: "wordKeepOut", text: "KEEP OUT", height: 0.32 },
  { model: "wordDontOpen", text: "DONT OPEN", height: 0.3 },
  { model: "wordNo", text: "NO", height: 0.5 },
]
/** Indoor warnings written in blood (AR-69), smaller and more varied than the spray paint outside. */
export const BLOOD_WORDS: readonly { model: DetailModel; text: string; height: number }[] = [
  { model: "bloodDontOpen", text: "DONT OPEN", height: 0.3 },
  { model: "bloodDeadInside", text: "DEAD INSIDE", height: 0.26 },
  { model: "bloodKeepOut", text: "KEEP OUT", height: 0.3 },
  { model: "bloodHelpUs", text: "HELP US", height: 0.32 },
  { model: "bloodTheyHear", text: "THEY HEAR", height: 0.28 },
  { model: "bloodStayQuiet", text: "STAY QUIET", height: 0.26 },
  { model: "bloodNotDead", text: "NOT DEAD", height: 0.3 },
  { model: "bloodGoAway", text: "GO AWAY", height: 0.32 },
  { model: "bloodBitten", text: "BITTEN", height: 0.34 },
  { model: "bloodHide", text: "HIDE", height: 0.38 },
]
/** Letter advance and word space in letter-height units (the font is 2 wide by 4 tall plus spacing). */
export const LETTER_ADVANCE = 0.72
export const wordWidth = (text: string, height: number) => (text.length * LETTER_ADVANCE - 0.22) * height

export type DetailSite = {
  model: DetailModel
  x: number
  y: number
  z: number
  yaw: number
  scale: number
  pitch: number
  roll: number
  /** Footprint radius used for spacing (m). */
  r: number
}

export type DetailPlacementInput = Pick<
  OutbreakDetailSettings,
  "worldDetails" | "dtTurnedOver" | "dtMail" | "dtBoxes" | "dtMarks" | "dtBloodWriting" | "dtBins" | "dtMailboxes" | "dtStreetJunk" | "dtPoliceTape" | "dtTvs" | "dtSeed"
>

/** Most details one building can carry (inside and out); the presenter caps each model's instances on top. */
export const BUILDING_DETAIL_BUDGET = 16
/** Most details per car (luggage, or four cones and their tape). */
export const CAR_DETAIL_BUDGET = 24

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  return h >>> 0
}

export const detailRng = (town: Pick<Town, "seed">, seed: number, key: string) => new Rng(hash(`${town.seed}:detail:${seed}:${key}`) || 1)

const HOMES: readonly string[] = ["house", "ranch", "cottage", "cabin"]
export const isHome = (b: Building) => HOMES.includes(b.archetype ?? b.kind)

/** Macro-block local coordinate (the street grid repeats every 96 m; roads at 40..48, sidewalks 38..40 and 48..50). */
const fold = (v: number) => ((v % SIZE) + SIZE) % SIZE
const onRoad = (x: number, z: number) => {
  const lx = fold(x)
  const lz = fold(z)
  return (lx > 39.6 && lx < 48.4) || (lz > 39.6 && lz < 48.4)
}

const inRectPad = (x: number, z: number, r: Rect, pad: number) => x > r[0] - pad && x < r[2] + pad && z > r[1] - pad && z < r[3] + pad

type Taken = { x: number; z: number; r: number }[]

const clearOfTaken = (taken: Taken, x: number, z: number, r: number) => taken.every((t) => Math.hypot(t.x - x, t.z - z) > t.r + r)

/** What stands in a building: walls and windows, its doors and windows (with their clearances) and its furniture. */
export type BuildingSolids = { walls: Rect[]; doors: Rect[]; windows: Rect[]; props: Rect[]; propsOf: Prop[] }

export function buildingSolids(town: Town, b: Building, avoid: readonly Rect[] = []): BuildingSolids {
  const box = b.rect
  const near = (r: Rect) => r[2] > box[0] - 0.3 && r[0] < box[2] + 0.3 && r[3] > box[1] - 0.3 && r[1] < box[3] + 0.3
  const walls = town.barriers.filter((w) => w.kind !== "fence" && near(w.rect)).map((w) => w.rect)
  const doors = town.doors.filter((d) => near(d.rect)).map((d) => d.rect)
  const windows = town.windows.filter((w) => near(w.rect)).map((w) => w.rect)
  const propsOf = town.props.filter((p) => p.kind !== "tree" && inRectPad(p.x, p.y, box, 0))
  const props = [...propsOf.map((p) => propShape(p)?.rect).filter((r): r is Rect => Boolean(r)), ...avoid.filter(near)]
  return { walls, doors, windows, props, propsOf }
}

/** Whether a floor piece of radius `r` fits at (x, z) inside `b`: in the footprint, off walls and furniture, `doorPad` clear of doors. */
export function floorFree(b: Building, s: BuildingSolids, taken: Taken, x: number, z: number, r: number, doorPad = 0.8): boolean {
  for (const [dx, dz] of [[-r, -r], [r, -r], [-r, r], [r, r]] as const) if (!inBuildingFootprint(b, x + dx, z + dz)) return false
  for (const w of s.walls) if (distToRect(x, z, w) < r + 0.06) return false
  for (const p of s.props) if (distToRect(x, z, p) < r + 0.06) return false
  for (const d of s.doors) if (distToRect(x, z, d) < r + doorPad) return false
  for (const w of s.windows) if (distToRect(x, z, w) < r + 0.3) return false
  return clearOfTaken(taken, x, z, r)
}

/** Whether an outdoor piece of radius `r` fits at (x, z): off buildings, fences, doorways, front paths, driveways, cars and trees. */
export function outdoorFree(town: Town, x: number, z: number, r: number, taken: Taken, opts: { road?: boolean } = {}): boolean {
  const wb = town.worldBounds ?? [0, 0, SIZE, SIZE]
  if (x < wb[0] + 1 || x > wb[2] - 1 || z < wb[1] + 1 || z > wb[3] - 1) return false
  if (!opts.road && onRoad(x, z)) return false
  for (const b of town.buildings) {
    if (inRectPad(x, z, b.rect, r + 0.2)) return false
    if (b.kind === "house") {
      const [a, c, , e] = b.rect
      const end = frontageEnd(b) + 2
      // Front path and porch, and the driveway.
      if (x > a + 4.4 - r && x < a + 7.1 + r && z > e - 0.2 && z < end) return false
      if (x > a - 3.05 - r && x < a - 0.3 + r && z > c && z < end) return false
    }
  }
  for (const w of town.barriers) if (distToRect(x, z, w.rect) < r + 0.12) return false
  for (const d of town.doors) if (distToRect(x, z, d.rect) < r + 1.1) return false
  for (const car of carSites(town)) if (distToRect(x, z, car.rect) < r + 0.35) return false
  for (const p of town.props) if (p.kind === "tree" && Math.hypot(p.x - x, p.y - z) < r + 0.55) return false
  return clearOfTaken(taken, x, z, r)
}

function site(town: Town, model: DetailModel, x: number, z: number, yaw: number, r: number, extra: Partial<Pick<DetailSite, "y" | "scale" | "pitch" | "roll">> = {}, lift = 0): DetailSite {
  return { model, x, y: extra.y ?? supportHeight(town, x, z) + lift, z, yaw, scale: extra.scale ?? 1, pitch: extra.pitch ?? 0, roll: extra.roll ?? 0, r }
}

/** Interior floor pieces sit just over the rugs (0.142 m) so they never sink into them. */
const RUG_LIFT = 0.016

/** Tries `n` spots around (cx, cz) between radius r0 and r1; the first that `ok` accepts. */
function around(rng: Rng, cx: number, cz: number, r0: number, r1: number, n: number, ok: (x: number, z: number, a: number) => boolean): { x: number; z: number; a: number } | null {
  for (let i = 0; i < n; i++) {
    const a = rng.next() * Math.PI * 2
    const d = r0 + rng.next() * (r1 - r0)
    const x = cx + Math.cos(a) * d
    const z = cz + Math.sin(a) * d
    if (ok(x, z, a)) return { x, z, a }
  }
  return null
}

const KITCHEN: ReadonlySet<Prop["kind"]> = new Set(["counter", "stove", "fridge"])
const STORAGE: ReadonlySet<Prop["kind"]> = new Set(["dresser", "nightstand", "closet"])

/**
 * A toppled chair lies on its back (roll -90°) or its side (pitch ±90°); the chair model is built 0.22 m from its
 * centre to the back and the sides, so either way the lift that grounds it is the same.
 */
export const CHAIR_DOWN_LIFT = 0.22

/** The interior and front-of-house details of one building. `turnedOver` forces it ransacked (a Blood incident). */
export function placeBuildingDetails(town: Town, b: Building, s: DetailPlacementInput, turnedOver: boolean, avoid: readonly Rect[] = []): DetailSite[] {
  if (!s.worldDetails) return []
  const out: DetailSite[] = []
  const taken: Taken = []
  const solids = buildingSolids(town, b, avoid)
  const home = isHome(b)
  const rng = (part: string) => detailRng(town, s.dtSeed, `${part}:${b.id}`)
  const push = (d: DetailSite) => {
    if (out.length >= BUILDING_DETAIL_BUDGET) return
    out.push(d)
    taken.push({ x: d.x, z: d.z, r: d.r })
  }
  const front = town.doors.find((d) => d.id === `${b.id}-front`)

  // Mail and a newspaper where the front door pushed them.
  if (s.dtMail && front) {
    const r = rng("mail")
    if (r.next() < (home ? 0.8 : 0.5)) {
      const cx = (front.rect[0] + front.rect[2]) / 2 + (r.next() - 0.5) * 0.7
      const z = front.rect[1] - 0.32 - r.next() * 0.25
      if (floorFree(b, solids, taken, cx, z, 0.2, 0)) push(site(town, "mail", cx, z, (r.next() - 0.5) * 1.2, 0.2, {}, RUG_LIFT))
    }
  }

  // A corner of stacked moving boxes, back to a wall.
  {
    const r = rng("boxes")
    if (r.next() < s.dtBoxes) {
      const stacks = home ? 1 : 1 + Math.floor(r.next() * 2)
      for (let k = 0; k < stacks; k++) {
        const spot = againstWall(r, b, solids, taken, 0.34, 0.36, 40)
        if (spot) push(site(town, r.next() < 0.5 ? "boxes2" : "boxes3", spot.x, spot.z, spot.yaw + (r.next() - 0.5) * 0.3, 0.36, { scale: 0.9 + r.next() * 0.2 }, RUG_LIFT))
      }
    }
  }

  // A television left on against a living-room wall, its screen to the room.
  if (home && s.dtTvs > 0) {
    const r = rng("tv")
    if (r.next() < s.dtTvs) {
      const spot = againstWall(r, b, solids, taken, 0.3, 0.42, 40)
      if (spot) push(site(town, "tv", spot.x, spot.z, spot.yaw, 0.42, {}, RUG_LIFT))
    }
  }

  // Turned over: chairs on their backs by the tables, a drawer pulled out and dumped, books off the shelves,
  // smashed plates by the kitchen counters.
  {
    const r = rng("turned")
    if (turnedOver || r.next() < s.dtTurnedOver) {
      const props = solids.propsOf
      const anchors = (kinds: (k: Prop["kind"]) => boolean, max: number) => props.filter((p) => kinds(p.kind)).slice(0, max)
      const ok = (rad: number, pad: number) => (x: number, z: number) => floorFree(b, solids, taken, x, z, rad, pad)
      const chairs = [...anchors((k) => k === "table", 2), ...anchors((k) => k === "chair", 1)]
      for (const t of chairs) {
        const at = around(r, t.x, t.y, 0.95, 1.35, 10, ok(0.42, 0.6))
        if (!at) continue
        const side = r.next() < 0.5
        push(site(town, "chair", at.x, at.z, at.a + Math.PI / 2 + (r.next() - 0.5) * 0.6, 0.42, side ? { pitch: r.next() < 0.5 ? Math.PI / 2 : -Math.PI / 2 } : { roll: -Math.PI / 2 }, CHAIR_DOWN_LIFT + RUG_LIFT))
      }
      for (const p of anchors((k) => STORAGE.has(k), 1)) {
        const at = around(r, p.x, p.y, 0.75, 1.05, 10, ok(0.3, 0.5))
        if (at) push(site(town, "drawer", at.x, at.z, r.next() * Math.PI * 2, 0.3, {}, RUG_LIFT))
      }
      for (const p of anchors((k) => k === "shelf", 1)) {
        const at = around(r, p.x, p.y, 0.7, 1.0, 10, ok(0.3, 0.5))
        if (at) push(site(town, "books", at.x, at.z, r.next() * Math.PI * 2, 0.3, {}, RUG_LIFT))
      }
      if (home) {
        for (const p of anchors((k) => KITCHEN.has(k), 2)) {
          const at = around(r, p.x, p.y, 0.7, 1.0, 10, ok(0.28, 0.5))
          if (at) push(site(town, "crockery", at.x, at.z, r.next() * Math.PI * 2, 0.28, {}, RUG_LIFT))
        }
      }
      // Whoever holed up here painted a warning beside the inner door, on the face the camera sees.
      const inner = town.doors.find((d) => d.id === `${b.id}-room`)
      if (inner && r.next() < 0.6) {
        // One draw either way, so everything placed after it is unchanged by the blood-writing toggle.
        const roll = r.next()
        const blood = s.dtBloodWriting !== false
        const word = blood ? BLOOD_WORDS[Math.floor(roll * BLOOD_WORDS.length)]!.model : INNER_WORDS[Math.floor(roll * INNER_WORDS.length)]!
        const w = (blood ? BLOOD_WORDS : WORDS).find((o) => o.model === word)!
        const k = blood ? 1 : Math.min(1, 0.3 / w.height)
        const half = (wordWidth(w.text, w.height) * k) / 2
        const face = inner.rect[3]
        const wall = s.dtMarks > 0 ? innerWall(town, b, face, inner.rect, half) : null
        if (wall !== null && inBuildingFootprint(b, wall, face + 0.3)) {
          // Blood is written higher, about where a hand reaches without stooping, and runs down from there.
          push(site(town, word, wall, face + 0.014, 0, 0.1, { y: supportHeight(town, wall, face + 0.3) + (blood ? 1.22 : 1.0), scale: k }))
        }
      }
    }
  }

  // Spray paint on the front wall: a search mark, and sometimes a warning. On a window's wall it goes on the apron
  // under the sill, smaller.
  {
    const r = rng("marks")
    if (r.next() < s.dtMarks) {
      const spans = frontWallSpans(town, b)
      const word = WORDS[Math.floor(r.next() * WORDS.length)]!
      const e = b.rect[3]
      const ground = (x: number) => supportHeight(town, x, e + 0.4)
      // Bare wall: chest height. Window apron: above the 0.26 m skirting.
      const base = (sp: FrontSpan) => (sp.top > 2 ? 1.0 : 0.29)
      const pick = (width: number, height: number) => {
        const fits = (sp: FrontSpan) => {
          const k = Math.min(1, (sp.top - base(sp)) / height)
          return k > 0.45 && sp.a1 - sp.a0 >= width * k + 0.3
        }
        const fit = spans.filter(fits)
        if (!fit.length) return null
        // Prefer the full-height wall when there is one.
        const tall = fit.filter((sp) => sp.top > 2)
        const sp = (tall.length ? tall : fit)[Math.floor(r.next() * (tall.length ? tall : fit).length)]!
        const k = Math.min(1, (sp.top - base(sp)) / height)
        const w = width * k
        const a = sp.a0 + 0.15 + w / 2 + r.next() * (sp.a1 - sp.a0 - w - 0.3)
        // Take the used stretch out so a second mark never overlaps the first.
        spans.splice(spans.indexOf(sp), 1, { a0: sp.a0, a1: a - w / 2 - 0.2, top: sp.top }, { a0: a + w / 2 + 0.2, a1: sp.a1, top: sp.top })
        const y = sp.top > 2 ? 1.0 + r.next() * 0.35 : base(sp)
        return { a, k, y }
      }
      const x = pick(MARK_X_SIZE, MARK_X_SIZE)
      if (x) push(site(town, "markX", x.a, e + 0.012, 0, 0.1, { y: ground(x.a) + x.y, scale: x.k * (0.9 + r.next() * 0.1) }))
      if (!x || r.next() < 0.6) {
        const w = pick(wordWidth(word.text, word.height), word.height)
        if (w) push(site(town, word.model, w.a, e + 0.012, 0, 0.1, { y: ground(w.a) + w.y, scale: w.k * (0.92 + r.next() * 0.08) }))
      }
    }
  }

  // Outside: a mailbox at the end of the front path, bins by the drive or a dumpster beside the shop, and whatever
  // people dropped on the lawn when they ran.
  const street = streetLine(b)
  if (home && front && s.dtMailboxes) {
    const r = rng("mailbox")
    // Just past the east edge of the front path (a + 4.5 .. a + 7 for every house lot).
    const x = Math.max((front.rect[0] + front.rect[2]) / 2 + 1.25, b.rect[0] + 7.45) + r.next() * 0.3
    const z = street - 0.35
    if (outdoorFree(town, x, z, 0.22, taken)) {
      const state = r.next()
      // Most stand; some lean where something hit them, a few were knocked flat.
      const extra = state < 0.12 ? { pitch: Math.PI / 2 - 0.08, roll: 0 } : state < 0.35 ? { pitch: (r.next() - 0.5) * 0.5, roll: (r.next() - 0.5) * 0.4 } : {}
      push(site(town, "mailbox", x, z, (r.next() - 0.5) * 0.3, 0.22, extra, state < 0.12 ? 0.08 : 0))
    }
  }
  if (s.dtBins) {
    const r = rng("bins")
    if (home) {
      const x = b.rect[0] + 0.45 + r.next() * 0.3
      const z = street - 0.55
      if (outdoorFree(town, x, z, 0.5, taken)) push(site(town, r.next() < 0.45 ? "binsBags" : "bins", x, z, (r.next() - 0.5) * 0.4, 0.5))
    } else {
      for (const [side, x] of [[1, b.rect[2] + 1.45], [-1, b.rect[0] - 1.45]] as const) {
        const z = b.rect[1] + 2.4 + r.next() * Math.max(0, b.rect[3] - b.rect[1] - 6)
        if (!outdoorFree(town, x, z, 1.05, taken)) continue
        push(site(town, "dumpster", x, z, side > 0 ? -Math.PI / 2 : Math.PI / 2, 1.05, { scale: 0.95 + r.next() * 0.1 }))
        break
      }
    }
  }
  if (home && s.dtStreetJunk > 0) {
    const r = rng("junk")
    const n = Math.round(s.dtStreetJunk * r.next() * 2.2)
    for (let k = 0; k < n; k++) {
      const pick = r.next()
      const model: DetailModel = pick < 0.34 ? "bike" : pick < 0.5 ? "pram" : pick < 0.78 ? "suitcase" : "suitcaseOpen"
      const rad = model === "bike" ? 0.75 : model === "pram" ? 0.5 : 0.45
      for (let t = 0; t < 8; t++) {
        const x = b.rect[0] - 1 + r.next() * (b.rect[2] - b.rect[0] + 2)
        const z = b.rect[3] + 0.9 + r.next() * Math.max(0.5, street - b.rect[3] - 1.4)
        if (!outdoorFree(town, x, z, rad, taken)) continue
        push(site(town, model, x, z, r.next() * Math.PI * 2, rad))
        break
      }
    }
  }
  return out
}

/** The z of the street side of a building's front yard: the near edge of the sidewalk if one is close, else past the frontage. */
export function streetLine(b: Building): number {
  const e = b.rect[3]
  const toWalk = 38 - fold(e)
  if (toWalk > 0.8 && toWalk < 9) return e + toWalk
  return frontageEnd(b) + 2.2
}

/** Width and height (m) of the spray-painted search X at scale 1. */
export const MARK_X_SIZE = 0.8

/** A paintable stretch of a front wall face: [a0, a1] along x, up to `top` m (2.6 on bare wall, under the sill on a window's apron). */
export type FrontSpan = { a0: number; a1: number; top: number }

/** Stretches of a building's front (south) wall face with no door, and the window aprons under the sills. */
export function frontWallSpans(town: Town, b: Building): FrontSpan[] {
  const e = b.rect[3]
  const spans: FrontSpan[] = []
  for (const w of town.barriers) {
    if (w.kind === "fence" || Math.abs(w.rect[3] - e) > 0.05 || w.rect[2] - w.rect[0] < w.rect[3] - w.rect[1]) continue
    if (w.rect[0] < b.rect[0] - 0.05 || w.rect[2] > b.rect[2] + 0.05) continue
    const pad = w.kind === "window" ? 0.12 : 0.2
    spans.push({ a0: w.rect[0] + pad, a1: w.rect[2] - pad, top: w.kind === "window" ? 0.7 : 2.6 })
  }
  for (const d of town.doors) {
    if (Math.abs(d.rect[3] - e) > 0.05) continue
    const lo = d.rect[0] - 0.35
    const hi = d.rect[2] + 0.35
    for (let i = spans.length - 1; i >= 0; i--) {
      const sp = spans[i]!
      if (hi <= sp.a0 || lo >= sp.a1) continue
      spans.splice(i, 1, ...[{ a0: sp.a0, a1: lo, top: sp.top }, { a0: hi, a1: sp.a1, top: sp.top }].filter((q) => q.a1 - q.a0 > 0.2))
    }
  }
  return spans.filter((sp) => sp.a1 - sp.a0 > 0.5).sort((p, q) => p.a0 - q.a0)
}

/** A spot `out` metres off a wall face inside `b`, facing into the room (yaw turns the model's +Z off the wall). */
function againstWall(rng: Rng, b: Building, s: BuildingSolids, taken: Taken, out: number, r: number, tries: number): { x: number; z: number; yaw: number } | null {
  if (!s.walls.length) return null
  for (let i = 0; i < tries; i++) {
    const w = s.walls[Math.floor(rng.next() * s.walls.length)]!
    const alongX = w[2] - w[0] >= w[3] - w[1]
    const side = rng.next() < 0.5 ? -1 : 1
    const t = rng.next()
    const x = alongX ? w[0] + 0.3 + t * Math.max(0, w[2] - w[0] - 0.6) : side < 0 ? w[0] - out : w[2] + out
    const z = alongX ? (side < 0 ? w[1] - out : w[3] + out) : w[1] + 0.3 + t * Math.max(0, w[3] - w[1] - 0.6)
    // Measure from the box's centre, so the wall it backs onto is allowed at `out`.
    const nx = alongX ? 0 : side
    const nz = alongX ? side : 0
    if (!floorFree(b, { ...s, walls: s.walls.filter((o) => o !== w) }, taken, x, z, r, 0.9)) continue
    if (distToRect(x, z, w) < out - 0.02) continue
    return { x, z, yaw: Math.atan2(-nx, nz) }
  }
  return null
}

/** Warnings painted indoors, beside the door to the back rooms. */
const INNER_WORDS: readonly DetailModel[] = ["wordDontOpen", "wordDeadInside", "wordKeepOut", "wordHelp"]

/**
 * Centre x for a word `half` wide on the south face (z = `face`) of the wall the inner door sits in, just past one
 * side of the door, on solid wall (not past its end): null when neither side has room.
 */
function innerWall(town: Town, b: Building, face: number, door: Rect, half: number): number | null {
  const walls = town.barriers.filter((w) => w.kind === "wall" && Math.abs(w.rect[3] - face) < 0.05 && w.rect[0] >= b.rect[0] - 0.05 && w.rect[2] <= b.rect[2] + 0.05)
  for (const x of [door[2] + 0.3 + half, door[0] - 0.3 - half]) {
    if (walls.some((w) => x - half > w.rect[0] + 0.1 && x + half < w.rect[2] - 0.1)) return x
  }
  return null
}

export type CruiserSite = { key: string; x: number; z: number; yaw: number }

/** Off every building, wall, window and fence by `pad`, inside the world (pieces that stand on the road beside cars). */
function clearOfBuildings(town: Town, x: number, z: number, pad: number): boolean {
  const wb = town.worldBounds ?? [0, 0, SIZE, SIZE]
  if (x < wb[0] + 0.5 || x > wb[2] - 0.5 || z < wb[1] + 0.5 || z > wb[3] - 0.5) return false
  if (town.buildings.some((b) => inRectPad(x, z, b.rect, pad))) return false
  return town.barriers.every((w) => distToRect(x, z, w.rect) > pad)
}

/** Luggage dropped beside abandoned cars, and police tape on cones round the police cars. */
export function placeCarDetails(town: Town, s: DetailPlacementInput, cruisers: readonly CruiserSite[]): DetailSite[] {
  if (!s.worldDetails) return []
  const out: DetailSite[] = []
  const taken: Taken = []
  const police = new Set(cruisers.map((c) => c.key.replace(/^cruiser:/, "")))
  for (const car of carSites(town)) {
    const pose = carPose(car.rect)
    const c = Math.cos(pose.yaw)
    const sn = Math.sin(pose.yaw)
    // Car frame: +X forward along (c, sn), +Z to the side along (-sn, c).
    const at = (fx: number, fz: number) => ({ x: pose.x + fx * c - fz * sn, z: pose.z + fx * sn + fz * c })
    const r = detailRng(town, s.dtSeed, `car:${car.key}`)
    const mine: DetailSite[] = []
    if (s.dtPoliceTape && police.has(car.key)) {
      const hl = pose.halfLength + 1.25
      const hw = pose.halfWidth + 1.15
      const corners = [at(hl, hw), at(-hl, hw), at(-hl, -hw), at(hl, -hw)]
      const ok = corners.map((p) => clearOfBuildings(town, p.x, p.z, 0.3))
      const broken = Math.floor(r.next() * 4)
      for (let i = 0; i < 4; i++) {
        const p = corners[i]!
        if (!ok[i]) continue
        mine.push(site(town, "cone", p.x, p.z, r.next() * Math.PI * 2, 0.2))
        const q = corners[(i + 1) % 4]!
        if (!ok[(i + 1) % 4]) continue
        const dx = q.x - p.x
        const dz = q.z - p.z
        const len = Math.hypot(dx, dz)
        const yaw = Math.atan2(dz, dx)
        if (i === broken) {
          // Snapped: a tail hangs from each cone to the ground.
          mine.push(site(town, "tapeTail", p.x, p.z, yaw, 0.1))
          mine.push(site(town, "tapeTail", q.x, q.z, yaw + Math.PI, 0.1))
          continue
        }
        const n = Math.max(1, Math.round(len))
        const step = len / n
        for (let k = 0; k < n; k++) {
          const x = p.x + (dx * k) / n
          const z = p.z + (dz * k) / n
          mine.push(site(town, "tape", x, z, yaw, 0.1, { y: supportHeight(town, x, z) + 0.66, scale: step }))
        }
      }
    }
    if (s.dtStreetJunk > 0 && r.next() < 0.3 * s.dtStreetJunk) {
      const side = r.next() < 0.5 ? -1 : 1
      const p = at(-0.2 + r.next() * 0.8, side * (pose.halfWidth + 0.75))
      if (clearOfBuildings(town, p.x, p.z, 0.5) && clearOfTaken(taken, p.x, p.z, 0.42)) {
        mine.push(site(town, r.next() < 0.5 ? "suitcaseOpen" : "suitcase", p.x, p.z, pose.yaw + (r.next() - 0.5) * 0.8, 0.42))
      }
    }
    for (const d of mine.slice(0, CAR_DETAIL_BUDGET)) {
      out.push(d)
      taken.push({ x: d.x, z: d.z, r: d.r })
    }
  }
  return out
}

/** Every detail in a town (the presenter caches per building and per car; this is the whole set, for tests and tools). */
export function placeDetails(town: Town, s: DetailPlacementInput, ctx: { turnedOver?: ReadonlySet<string>; cruisers?: readonly CruiserSite[] } = {}): DetailSite[] {
  if (!s.worldDetails) return []
  const out: DetailSite[] = []
  for (const b of town.buildings) out.push(...placeBuildingDetails(town, b, s, ctx.turnedOver?.has(b.id) ?? false))
  out.push(...placeCarDetails(town, s, ctx.cruisers ?? []))
  return out
}

/** A flock of crows on the ground: where, how many, and its own roll for the birds' spots and timing. */
export type CrowFlock = { key: string; x: number; z: number; birds: number; seed: number }

/** Crows on the front lawns of some homes and at most bodies left outdoors (`dtCrows` scales the odds). */
export function placeCrowFlocks(town: Town, s: Pick<OutbreakDetailSettings, "worldDetails" | "dtCrows" | "dtSeed">, bodies: readonly { key: string; x: number; y: number }[] = []): CrowFlock[] {
  if (!s.worldDetails || s.dtCrows <= 0) return []
  const out: CrowFlock[] = []
  const taken: Taken = []
  const add = (key: string, r: Rng, x: number, z: number) => {
    out.push({ key, x, z, birds: 3 + Math.floor(r.next() * 4), seed: Math.floor(r.next() * 4294967296) >>> 0 })
    taken.push({ x, z, r: 2 })
  }
  for (const body of bodies) {
    if (town.buildings.some((b) => inBuildingFootprint(b, body.x, body.y))) continue
    const r = detailRng(town, s.dtSeed, `crows-body:${body.key}`)
    if (r.next() >= Math.min(1, 0.6 * s.dtCrows)) continue
    const a = r.next() * Math.PI * 2
    const x = body.x + Math.cos(a) * 0.9
    const z = body.y + Math.sin(a) * 0.9
    if (clearOfBuildings(town, x, z, 0.8) && clearOfTaken(taken, x, z, 2)) add(`body:${body.key}`, r, x, z)
  }
  for (const b of town.buildings) {
    if (!isHome(b)) continue
    const r = detailRng(town, s.dtSeed, `crows:${b.id}`)
    if (r.next() >= Math.min(1, 0.3 * s.dtCrows)) continue
    const street = streetLine(b)
    for (let t = 0; t < 8; t++) {
      const x = b.rect[0] - 2 + r.next() * (b.rect[2] - b.rect[0] + 4)
      const z = b.rect[3] + 1 + r.next() * Math.max(0.5, street - b.rect[3] - 1.2)
      if (!outdoorFree(town, x, z, 0.9, taken)) continue
      add(`lawn:${b.id}`, r, x, z)
      break
    }
  }
  return out
}
