import { seedOf } from "@arcade/kit/sim/rng"
import { inBuildingFootprint, type Building, type Prop, type Town } from "../../../shared/map"
import { isResidential } from "../../interiors/plan"

/** Stateless hash of a few ints to [0, 1): every client and the offline reel agree. */
export function hash01(a: number, b = 0, c = 0, d = 0): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1) ^ Math.imul(d | 0, 0x85ebca77)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

export type ScapePoint = { x: number; y: number; key: string }
export type ScapeClock = ScapePoint & { id: "scape.clock.tick" | "scape.clock.limp"; rate: number; chime: boolean; chimeOffset: number }
export type ScapeTap = ScapePoint & { period: number; phase: number; double: boolean }

/** Everything that makes a sound in one building, a pure function of the town seed and the building. */
export type HousePlan = {
  readonly building: Building
  readonly seed: number
  readonly residential: boolean
  readonly cx: number
  readonly cy: number
  /** Game hour (since the run's first midnight) the power fails here; `-1` never had any, `Infinity` keeps it. */
  readonly powerLoss: number
  readonly clocks: readonly ScapeClock[]
  readonly taps: readonly ScapeTap[]
  readonly fridge: ScapePoint | null
  readonly pipe: ScapePoint
  readonly musicBox: ScapePoint | null
  readonly phone: (ScapePoint & { haunted: boolean }) | null
  readonly chimes: ScapePoint | null
  readonly gutters: readonly ScapePoint[]
}

const PLAN_CACHE = new WeakMap<Building, HousePlan>()

function propsIn(town: Town, b: Building): Prop[] {
  const out: Prop[] = []
  for (const p of town.props) if (p.kind !== "tree" && inBuildingFootprint(b, p.x, p.y)) out.push(p)
  return out
}

/** Nudges a point toward the building's centre so it sits inside, off the wall. */
function inside(b: Building, x: number, y: number, by = 0.4): { x: number; y: number } {
  const [x0, y0, x1, y1] = b.rect
  return { x: Math.min(x1 - by, Math.max(x0 + by, x)), y: Math.min(y1 - by, Math.max(y0 + by, y)) }
}

/**
 * Whether a building's mains are live at `absHour` (game hours since the run's first midnight). Most houses had
 * power when the outbreak started and lose it one by one over the first three nights; some never had it. Pure, so the
 * life layer (TVs left on) can agree with the fridges.
 */
export function housePowered(plan: Pick<HousePlan, "powerLoss">, absHour: number): boolean {
  return plan.powerLoss > absHour
}

/** The sound plan of one building (cached per building object). */
export function housePlan(town: Town, b: Building): HousePlan {
  const hit = PLAN_CACHE.get(b)
  if (hit) return hit
  const seed = (seedOf(b.id) ^ Math.imul(town.seed + 0x51ed27, 0x9e3779b1)) >>> 0
  const r = (salt: number, k = 0) => hash01(seed, salt, k)
  const residential = isResidential(b)
  const [x0, y0, x1, y1] = b.rect
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const props = propsIn(town, b)
  const find = (...kinds: Prop["kind"][]) => props.filter((p) => kinds.includes(p.kind))
  const key = (what: string, k = 0) => `${b.id}:${what}:${k}`

  // The grid: a quarter of shops and a tenth of houses were already dark; the rest fail between the first evening
  // and the third night, and one in six holds on for the whole run.
  const dark = r(1) < (residential ? 0.1 : 0.25)
  const holds = r(2) < 0.16
  const powerLoss = dark ? -1 : holds ? Infinity : 19 + r(3) * 46

  const clocks: ScapeClock[] = []
  const living = find("sofa", "shelf", "coffee", "table")
  const nClocks = residential ? (r(4) < 0.7 ? 1 : 0) + (r(5) < 0.25 ? 1 : 0) : r(4) < 0.8 ? 1 : 0
  for (let k = 0; k < nClocks; k++) {
    const anchor = living.length ? living[Math.floor(r(6, k) * living.length)]! : { x: cx + (r(7, k) - 0.5) * 3, y: cy + (r(8, k) - 0.5) * 3 }
    const p = inside(b, anchor.x + (r(9, k) - 0.5) * 0.8, anchor.y + (r(10, k) - 0.5) * 0.8)
    // Shops have battery wall clocks that never stop; a third of house clocks were never wound again.
    const running = !residential || r(11, k) < 0.66
    if (!running) continue
    const grand = residential && r(12, k) < 0.2
    clocks.push({
      ...p,
      key: key("clock", k),
      id: r(13, k) < 0.06 ? "scape.clock.limp" : "scape.clock.tick",
      rate: grand ? 0.62 + r(14, k) * 0.06 : 0.94 + r(14, k) * 0.12,
      chime: residential && r(15, k) < 0.5,
      chimeOffset: r(16, k) * 25,
    })
  }

  const taps: ScapeTap[] = []
  const wet = find("counter", "stove")
  const nTaps = r(20) < (residential ? 0.8 : 0.3) ? 1 : 0
  for (let k = 0; k < nTaps + (residential && r(21) < 0.25 ? 1 : 0); k++) {
    const a = wet[k % Math.max(1, wet.length)] ?? { x: x1 - 2, y: y1 - 2 }
    const p = inside(b, a.x + (r(22, k) - 0.5) * 0.6, a.y + (r(23, k) - 0.5) * 0.6)
    taps.push({ ...p, key: key("tap", k), period: 1.3 + r(24, k) * 3.6, phase: r(25, k) * 4, double: r(26, k) < 0.2 })
  }

  const fridgeProp = find("fridge")[0]
  const fridge = fridgeProp ? { ...inside(b, fridgeProp.x, fridgeProp.y), key: key("fridge") } : residential && wet[0] ? { ...inside(b, wet[0].x, wet[0].y - 1.2), key: key("fridge") } : null

  const pipeAt = wet[0] ?? { x: x0 + 1, y: cy }
  const pipe = { ...inside(b, pipeAt.x, pipeAt.y, 0.25), key: key("pipe") }

  const bedroom = find("bed", "nightstand")
  const musicBox = residential && bedroom.length > 0 && r(30) < 0.14 ? { ...inside(b, bedroom[0]!.x + 0.4, bedroom[0]!.y + 0.2), key: key("musicbox") } : null

  const phoneAt = find("table", "counter", "shelf")[0]
  const haunted = residential && r(31) < 0.07
  const phone = phoneAt && (haunted || r(32) < 0.5) ? { ...inside(b, phoneAt.x, phoneAt.y), key: key("phone"), haunted } : null

  // A porch chime on the front of a fifth of houses (the side the door faces, under the eave).
  const door = town.doors.find((d) => {
    const dx = (d.rect[0] + d.rect[2]) / 2
    const dy = (d.rect[1] + d.rect[3]) / 2
    return dx >= x0 - 0.5 && dx <= x1 + 0.5 && dy >= y0 - 0.5 && dy <= y1 + 0.5
  })
  let chimes: ScapePoint | null = null
  if (residential && r(40) < 0.2) {
    const dx = door ? (door.rect[0] + door.rect[2]) / 2 : cx
    const dy = door ? (door.rect[1] + door.rect[3]) / 2 : y1
    const out = [dy - y0 < 0.6 ? [0, -1] : y1 - dy < 0.6 ? [0, 1] : dx - x0 < 0.6 ? [-1, 0] : [1, 0]][0]!
    chimes = { x: dx + out[0]! * 1.1 + out[1]! * 0.9, y: dy + out[1]! * 1.1 + out[0]! * 0.9, key: key("chimes") }
  }

  // Downpipes at two or three corners, just outside the walls.
  const gutters: ScapePoint[] = []
  const corners: [number, number][] = [
    [x0 - 0.25, y0 - 0.25],
    [x1 + 0.25, y0 - 0.25],
    [x1 + 0.25, y1 + 0.25],
    [x0 - 0.25, y1 + 0.25],
  ]
  for (let k = 0; k < 4; k++) if (r(50, k) < 0.6) gutters.push({ x: corners[k]![0], y: corners[k]![1], key: key("gutter", k) })

  const plan: HousePlan = { building: b, seed, residential, cx, cy, powerLoss, clocks, taps, fridge, pipe, musicBox, phone, chimes, gutters }
  PLAN_CACHE.set(b, plan)
  return plan
}

/** Distance from a point to a building's rectangle (0 inside). */
export function distToBuilding(b: Building, x: number, y: number): number {
  const [x0, y0, x1, y1] = b.rect
  const dx = Math.max(x0 - x, 0, x - x1)
  const dy = Math.max(y0 - y, 0, y - y1)
  return Math.hypot(dx, dy)
}
