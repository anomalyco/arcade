import { inRect, type Rect } from "@arcade/kit/sim/geom"
import { inBuildingFootprint, propShape, type Building, type Town } from "../map"
import { STARTING_SAFEHOUSE_RECT } from "../pacing"
import { callingIndexOf, type CallingId } from "./callings"

/**
 * Habit loops (AR-88): places in the town where one of the dead is still doing what it did when it turned, until it
 * notices you. A pure function of the town, so the sim (which pins a zombie there) and every client (which plays the
 * habit on whoever stands on the spot, still and wandering) agree with nothing on the wire.
 *
 * | Kind | Where | Who |
 * | --- | --- | --- |
 * | `knock` | inside a house, facing its own shut front door | bathrobes, dresses, hoodies, office shirts |
 * | `stove` | at a cold kitchen stove, stirring | bathrobes, dresses |
 * | `bed` | standing over a bed, head bowed | bathrobes, nurses, dresses, office shirts |
 * | `fence` | tangled in a garden fence, pulling at it | mail carriers, joggers, couriers, guards |
 * | `bride` / `groom` | outside the church doors, slow-dancing | bride, groom |
 */
export type HabitKind = "knock" | "stove" | "bed" | "fence" | "bride" | "groom"

export const HABIT_KINDS: readonly HabitKind[] = ["knock", "stove", "bed", "fence", "bride", "groom"]

export type HabitSite = {
  /** Stable id (`<kind>:<building or fence key>`). */
  key: string
  kind: HabitKind
  x: number
  y: number
  /** Which way it faces (plan radians, as `AIAgent.aim`). */
  aim: number
  /** The callings (indices) someone here would have had; the sim picks one by the site's hash. */
  callings: readonly number[]
  /** The door it knocks on (`knock` only). */
  doorId?: string
  /** Its fixed roll in [0, 1): the site is used when this is under the habit share. */
  roll: number
}

const RESIDENTIAL = new Set(["house", "ranch", "cottage", "cabin"])
const CHANCE: Readonly<Record<HabitKind, number>> = { knock: 0.24, stove: 0.22, bed: 0.16, fence: 0.07, bride: 0.85, groom: 0.85 }
const WHO: Readonly<Record<HabitKind, readonly CallingId[]>> = {
  knock: ["robe", "robe", "dress", "hoodie", "office"],
  stove: ["robe", "dress", "robe"],
  bed: ["robe", "nurse", "dress", "office"],
  fence: ["mail", "jogger", "courier", "guard", "jogger"],
  bride: ["bride"],
  groom: ["groom"],
}

function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  return (h >>> 0) / 4294967296
}

const roll = (town: Pick<Town, "seed">, key: string) => hash01(`${town.seed}:habit:${key}`)
const round = (n: number) => Math.round(n * 100) / 100

export const isResidential = (b: Building) => b.kind === "house" || RESIDENTIAL.has(b.archetype ?? "")

/** The front door of `b` with its centre and the unit normal pointing out of the building. */
function frontDoor(town: Town, b: Building) {
  const door = town.doors.find((d) => d.id === `${b.id}-front`)
  if (!door) return null
  const cx = (door.rect[0] + door.rect[2]) / 2
  const cy = (door.rect[1] + door.rect[3]) / 2
  const horizontal = door.rect[2] - door.rect[0] > door.rect[3] - door.rect[1]
  const bx = (b.rect[0] + b.rect[2]) / 2
  const by = (b.rect[1] + b.rect[3]) / 2
  const out = horizontal ? { x: 0, y: Math.sign(cy - by) || 1 } : { x: Math.sign(cx - bx) || 1, y: 0 }
  return { door, cx, cy, out }
}

/** A spot `gap` metres off the side of `rect` that faces `(tx, ty)`, and the aim back at the rect's centre. */
function besideRect(rect: Rect, tx: number, ty: number, gap: number) {
  const cx = (rect[0] + rect[2]) / 2
  const cy = (rect[1] + rect[3]) / 2
  const dx = tx - cx
  const dy = ty - cy
  const hw = (rect[2] - rect[0]) / 2
  const hh = (rect[3] - rect[1]) / 2
  const x = Math.abs(dx) * hh > Math.abs(dy) * hw ? cx + Math.sign(dx || 1) * (hw + gap) : cx
  const y = Math.abs(dx) * hh > Math.abs(dy) * hw ? cy : cy + Math.sign(dy || 1) * (hh + gap)
  return { x, y, aim: Math.atan2(cy - y, cx - x) }
}

function site(town: Town, kind: HabitKind, key: string, x: number, y: number, aim: number, doorId?: string): HabitSite {
  return {
    key: `${kind}:${key}`,
    kind,
    x: round(x),
    y: round(y),
    aim: round(aim),
    callings: WHO[kind].map(callingIndexOf),
    ...(doorId ? { doorId } : {}),
    roll: roll(town, `${kind}:${key}`),
  }
}

/** Every habit site in the town's active chunks. Deterministic; the order is stable for a given town. */
export function habitSites(town: Town): HabitSite[] {
  const out: HabitSite[] = []
  for (const b of town.buildings) {
    if (inRect((b.rect[0] + b.rect[2]) / 2, (b.rect[1] + b.rect[3]) / 2, STARTING_SAFEHOUSE_RECT)) continue
    const bx = (b.rect[0] + b.rect[2]) / 2
    const by = (b.rect[1] + b.rect[3]) / 2
    if (isResidential(b)) {
      const front = frontDoor(town, b)
      if (front) {
        const x = front.cx - front.out.x * 0.7
        const y = front.cy - front.out.y * 0.7
        if (inBuildingFootprint(b, x, y)) out.push(site(town, "knock", b.id, x, y, Math.atan2(front.out.y, front.out.x), front.door.id))
      }
      let stove = false
      let bed = false
      for (const p of town.props) {
        if ((p.kind !== "stove" || stove) && (p.kind !== "bed" || bed)) continue
        if (!inBuildingFootprint(b, p.x, p.y)) continue
        const shape = propShape(p)
        if (!shape) continue
        const at = besideRect(shape.rect, bx, by, p.kind === "stove" ? 0.42 : 0.38)
        if (!inBuildingFootprint(b, at.x, at.y)) continue
        if (p.kind === "stove") stove = true
        else bed = true
        out.push(site(town, p.kind, b.id, at.x, at.y, at.aim))
      }
    } else if (b.archetype === "church") {
      const front = frontDoor(town, b)
      if (front) {
        const mx = front.cx + front.out.x * 2.4
        const my = front.cy + front.out.y * 2.4
        // Side by side across the path, facing each other.
        const sx = -front.out.y
        const sy = front.out.x
        out.push(site(town, "bride", b.id, mx + sx * 0.36, my + sy * 0.36, Math.atan2(-sy, -sx)))
        out.push(site(town, "groom", b.id, mx - sx * 0.36, my - sy * 0.36, Math.atan2(sy, sx)))
      }
    }
  }
  for (const f of town.barriers) {
    if (f.kind !== "fence") continue
    const [x0, y0, x1, y1] = f.rect
    const horizontal = x1 - x0 >= y1 - y0
    const len = horizontal ? x1 - x0 : y1 - y0
    if (len < 3) continue
    const key = `${round((x0 + x1) / 2)},${round((y0 + y1) / 2)}`
    const side = roll(town, `fence-side:${key}`) < 0.5 ? -1 : 1
    const along = (roll(town, `fence-at:${key}`) - 0.5) * (len - 1.6)
    const half = horizontal ? (y1 - y0) / 2 : (x1 - x0) / 2
    const cx = (x0 + x1) / 2 + (horizontal ? along : side * (half + 0.58))
    const cy = (y0 + y1) / 2 + (horizontal ? side * (half + 0.58) : along)
    const aim = horizontal ? Math.atan2(-side, 0) : Math.atan2(0, -side)
    out.push(site(town, "fence", key, cx, cy, aim))
  }
  return out
}

/** Whether a site is in use at `share` (0..1): its own roll against its kind's chance, scaled by the share. */
export function siteActive(s: HabitSite, share: number): boolean {
  return s.roll < CHANCE[s.kind] * Math.max(0, share) * 2
}

/** Which calling the zombie at `s` was. */
export function siteCalling(s: HabitSite): number {
  const r = hash01(`${s.key}:who`)
  return s.callings[Math.floor(r * s.callings.length)]!
}

/**
 * The town's habit sites in a coarse grid, so a client finds the site under a standing zombie in O(1). Rebuilt only
 * when the active chunks change (`signature`).
 */
export class HabitSiteIndex {
  private signature = ""
  private cells = new Map<number, HabitSite[]>()
  sites: HabitSite[] = []

  static signatureOf(town: Town): string {
    return `${town.seed}:${town.activeChunkKeys?.join("|") ?? ""}:${town.buildings.length}:${town.barriers.length}:${town.props.length}`
  }

  sync(town: Town): void {
    const sig = HabitSiteIndex.signatureOf(town)
    if (sig === this.signature) return
    this.signature = sig
    this.sites = habitSites(town)
    this.cells.clear()
    for (const s of this.sites) {
      const k = cellKey(Math.floor(s.x / 4), Math.floor(s.y / 4))
      let list = this.cells.get(k)
      if (!list) this.cells.set(k, (list = []))
      list.push(s)
    }
  }

  /** The site within `radius` metres of `(x, y)`, or `null`. */
  at(x: number, y: number, radius = 0.35): HabitSite | null {
    const cx = Math.floor(x / 4)
    const cy = Math.floor(y / 4)
    for (let oy = -1; oy <= 1; oy++)
      for (let ox = -1; ox <= 1; ox++) {
        const list = this.cells.get(cellKey(cx + ox, cy + oy))
        if (!list) continue
        for (const s of list) if (Math.abs(s.x - x) < radius && Math.abs(s.y - y) < radius) return s
      }
    return null
  }
}

const cellKey = (cx: number, cy: number) => (cx + 4096) * 8192 + (cy + 4096)
