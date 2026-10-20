/**
 * Door-stuck harness: zombies chasing a survivor through a doorway, measured for time spent wedged.
 *
 * A survivor stands still on one side of a door (kept alive); 1–6 relentless chasers start on the other side and
 * must get to them, through the open door or by bashing the shut one down. A zombie counts as stuck while it is
 * not bashing, not staggered and not yet through the doorway (0.6 m past its far face, in the survivor's room) or within
 * reach of the survivor, and has moved less than 0.1 m over the last 2 s. Crowding at the survivor once through is not counted. CPU only, deterministic: `bun scripts/door-stuck.ts` prints the table; `tests/door-stuck.test.ts` holds the
 * budget.
 */
import { clearLine, distToRect, type Rect } from "@arcade/kit/sim/geom"
import { TICK_DT } from "../shared/clock"
import { solidRects, type Door } from "../shared/map"
import { LocalSession } from "../shared/session"
import type { SessionTuning } from "../shared/sim-types"
import { DEFAULT_STAMINA_TUNING } from "../shared/stamina"
import { spawnSpecial } from "../shared/specials/specials"
import { SPECIAL_BRUTE, SPECIAL_RUNNER } from "../shared/specials/kinds"
import { boxOf, distToBox } from "../shared/vehicles"
import type { AIAgent } from "../shared/ai"

export type DoorScenario = {
  seed: number
  /** "procedural" builds every house from the chunk generator (cottages, ranches, houses) instead of the start block. */
  world?: "procedural"
  doorId: string
  open: boolean
  /** Which side of the door the zombies start on: "south" is the street side of a front door. */
  zombieSide: "north" | "south"
  zombies: number
  /** Where they start: in a row straight out from the door, fanned wide along the wall, or right up against it. */
  layout: "line" | "fan" | "hug"
  special?: "brute" | "runner"
  /** Seconds simulated. */
  seconds?: number
}

export type DoorScenarioResult = {
  label: string
  /** Seconds each zombie spent stuck. */
  stuck: number[]
  /** Longest single stuck stretch of any zombie (s). */
  longestStuck: number
  /** Zombies that got through the doorway (or to the survivor). */
  arrived: number
  zombies: number
  /** Seconds until the last zombie arrived (or the run length). */
  allArrivedAt: number
  doorOpenedAt: number
}

const REACH = 1.1
/** Chained dogs stay quiet: a bark pulls the dead off the survivor, and this measures only how they get through doors. */
const QUIET_DOGS = { ...DEFAULT_STAMINA_TUNING, dogSense: 0 } as SessionTuning
const WINDOW = 2
const MIN_PROGRESS = 0.1
const BODY = 0.28

function sideSign(side: "north" | "south"): number {
  return side === "north" ? -1 : 1
}

function wallRects(session: LocalSession): Rect[] {
  return session.view.town.barriers.map((b) => b.rect)
}

/** A spot on `side` of the door at perpendicular distance `depth` and lateral `lateral`, clear and in the door's room. */
function spotNear(session: LocalSession, door: Door, side: "north" | "south", depth: number, lateral: number): { x: number; y: number } | null {
  const town = session.view.town
  const cx = (door.rect[0] + door.rect[2]) / 2
  const face = side === "north" ? door.rect[1] : door.rect[3]
  const x = cx + lateral
  const y = face + sideSign(side) * depth
  const solids = solidRects(town)
  for (const r of solids) if (r !== door.rect && distToRect(x, y, r) < BODY + 0.08) return null
  for (const v of session.vehicles.list) if (distToBox(x, y, boxOf(v, v.spec)) < 0.9) return null
  if (!session.ai.nav.walkable({ x, y })) return null
  // Same room as the door's face: a straight line to just off the door's middle crosses no wall.
  const approach = { x: cx, y: face + sideSign(side) * 0.45 }
  if (!clearLine(x, y, approach.x, approach.y, wallRects(session))) return null
  return { x, y }
}

function survivorSpot(session: LocalSession, door: Door, side: "north" | "south"): { x: number; y: number } {
  for (const depth of [2.2, 1.8, 2.8, 1.4, 3.4]) {
    for (const lateral of [0, 0.5, -0.5, 1, -1, -2, 2, -3, 3]) {
      const p = spotNear(session, door, side, depth, lateral)
      if (p) return p
    }
  }
  throw new Error(`no survivor spot by ${door.id} (${side})`)
}

function zombieSpots(session: LocalSession, door: Door, side: "north" | "south", layout: DoorScenario["layout"], n: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  const candidates: [number, number][] = []
  if (layout === "line") {
    for (let k = 0; k < 16; k++) candidates.push([2.2 + k * 0.75, ((k % 3) - 1) * 0.35])
  } else if (layout === "fan") {
    for (const depth of [2.4, 3.4, 4.4]) for (const lateral of [-2.6, 2.6, -1.4, 1.4, -3.6, 3.6, 0]) candidates.push([depth, lateral])
  } else {
    for (const lateral of [-1.9, 1.9, -2.7, 2.7, -1.2, 1.2, -3.5, 3.5]) for (const depth of [0.55, 0.9]) candidates.push([depth, lateral])
  }
  for (const [depth, lateral] of candidates) {
    if (out.length >= n) break
    const p = spotNear(session, door, side, depth, lateral)
    if (p && out.every((q) => Math.hypot(q.x - p.x, q.y - p.y) > 0.7)) out.push(p)
  }
  return out
}

export function scenarioLabel(s: DoorScenario): string {
  return `${s.world ? "proc " : ""}seed ${s.seed} ${s.doorId} ${s.open ? "open" : "shut"} from ${s.zombieSide} ×${s.zombies} ${s.layout}${s.special ? ` ${s.special}` : ""}`
}

export function runDoorScenario(
  s: DoorScenario,
  trace?: (time: number, zombies: readonly AIAgent[], session: LocalSession, door: Door) => void,
): DoorScenarioResult {
  const session = s.world
    ? new LocalSession(s.seed, s.seed, 0.22, { zombieCount: 0, openingCalm: 0 }, s.world)
    : new LocalSession(s.seed, s.seed, 0.22, { zombieCount: 0, openingCalm: 0 })
  const town = session.view.town
  const door = town.doors.find((d) => d.id === s.doorId)
  if (!door) throw new Error(`no door ${s.doorId}`)
  door.open = s.open
  door.locked = false
  session.rebuildCollision()
  const survivorSide = s.zombieSide === "north" ? "south" : "north"
  const home = survivorSpot(session, door, survivorSide)
  const p = session.view.player
  Object.assign(p, { x: home.x, y: home.y, vx: 0, vy: 0, aim: 0 })
  const spots = zombieSpots(session, door, s.zombieSide, s.layout, s.zombies)
  const zs: AIAgent[] = []
  for (const [k, spot] of spots.entries()) {
    const aim = Math.atan2(home.y - spot.y, home.x - spot.x)
    const special = s.special && k === 0 ? (s.special === "brute" ? SPECIAL_BRUTE : SPECIAL_RUNNER) : null
    const z = special ? spawnSpecial(session.sim, special, spot.x, spot.y, aim) : session.ai.spawnZombie(town, spot.x, spot.y, "chase", aim)
    if (!z) continue
    z.state = "chase"
    z.awareness = 1
    z.targetX = home.x
    z.targetY = home.y
    zs.push(z)
  }

  const walls = wallRects(session)
  const seconds = s.seconds ?? 20
  const ticks = Math.round(seconds / TICK_DT)
  const histLen = Math.round(WINDOW / TICK_DT)
  const hist = zs.map((z) => Array.from({ length: histLen }, () => ({ x: z.x, y: z.y })))
  const stuck = zs.map(() => 0)
  const run = zs.map(() => 0)
  let longestStuck = 0
  const arrivedAt = zs.map(() => -1)
  let doorOpenedAt = s.open ? 0 : -1
  for (let t = 0; t < ticks; t++) {
    // Relentless chasers: always know where the survivor is, so any failure to arrive is navigation.
    for (const z of zs) {
      if (z.state === "dead") continue
      z.awareness = 1
      z.targetX = p.x
      z.targetY = p.y
      if (z.state === "wander" || z.state === "investigate" || z.state === "search") {
        z.state = "chase"
        z.stateTime = 0
        z.repathAt = 0
      }
    }
    Object.assign(p, { x: home.x, y: home.y, vx: 0, vy: 0, health: 100 })
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false }, 0, QUIET_DOGS)
    if (doorOpenedAt < 0 && door.open) doorOpenedAt = (t + 1) * TICK_DT
    trace?.((t + 1) * TICK_DT, zs, session, door)
    const slot = t % histLen
    for (let k = 0; k < zs.length; k++) {
      const z = zs[k]!
      if (arrivedAt[k]! >= 0) continue
      const past = survivorSide === "north" ? z.y < door.rect[1] - 0.6 : z.y > door.rect[3] + 0.6
      const through = past && clearLine(z.x, z.y, home.x, home.y, walls)
      if (through || Math.hypot(z.x - home.x, z.y - home.y) <= REACH) {
        arrivedAt[k] = (t + 1) * TICK_DT
        run[k] = 0
        continue
      }
      const old = hist[k]![slot]!
      const moved = Math.hypot(z.x - old.x, z.y - old.y)
      old.x = z.x
      old.y = z.y
      const busy = z.state === "bash" || z.state === "stagger" || z.state === "knockdown" || z.state === "dead"
      if (t >= histLen && !busy && moved < MIN_PROGRESS) {
        stuck[k]! += TICK_DT
        run[k]! += TICK_DT
        longestStuck = Math.max(longestStuck, run[k]!)
      } else run[k] = 0
    }
  }
  const arrived = arrivedAt.filter((a) => a >= 0).length
  return {
    label: scenarioLabel(s),
    stuck,
    longestStuck,
    arrived,
    zombies: zs.length,
    allArrivedAt: arrived === zs.length ? Math.max(0, ...arrivedAt) : seconds,
    doorOpenedAt,
  }
}

/** The standard matrix: every start-block door, open and shut, from both sides, crowds of 1–6, the specials. */
export function doorScenarios(seeds: readonly number[] = [7, 19]): DoorScenario[] {
  const out: DoorScenario[] = []
  const doors = ["ash-front", "elm-front", "hardware-front", "pharmacy-front", "ash-room", "hardware-room"]
  for (const seed of seeds) {
    for (const doorId of doors) {
      for (const open of [true, false]) {
        for (const zombieSide of ["south", "north"] as const) {
          out.push({ seed, doorId, open, zombieSide, zombies: 1, layout: "line" })
          out.push({ seed, doorId, open, zombieSide, zombies: 4, layout: "fan" })
          out.push({ seed, doorId, open, zombieSide, zombies: 6, layout: "line" })
          out.push({ seed, doorId, open, zombieSide, zombies: 3, layout: "hug" })
        }
      }
    }
    // Generated houses: every front and back-room door the chunk generator puts round the start.
    const proc = new LocalSession(seed, seed, 0.22, { zombieCount: 0 }, "procedural")
    for (const door of proc.view.town.doors) {
      for (const open of [true, false]) {
        for (const zombieSide of ["south", "north"] as const) {
          out.push({ seed, world: "procedural", doorId: door.id, open, zombieSide, zombies: 4, layout: "fan" })
          out.push({ seed, world: "procedural", doorId: door.id, open, zombieSide, zombies: 3, layout: "hug" })
        }
      }
    }
    out.push({ seed, doorId: "ash-front", open: true, zombieSide: "south", zombies: 3, layout: "fan", special: "brute" })
    out.push({ seed, doorId: "ash-front", open: false, zombieSide: "south", zombies: 3, layout: "fan", special: "brute" })
    out.push({ seed, doorId: "elm-front", open: true, zombieSide: "south", zombies: 3, layout: "hug", special: "runner" })
  }
  return out
}

export type DoorStuckSummary = {
  scenarios: number
  zombies: number
  totalStuck: number
  worstScenarioStuck: number
  longestStuck: number
  stuckOver2s: number
  notArrived: number
  results: DoorScenarioResult[]
}

export function summarize(results: DoorScenarioResult[]): DoorStuckSummary {
  let zombies = 0
  let totalStuck = 0
  let worst = 0
  let longest = 0
  let over = 0
  let notArrived = 0
  for (const r of results) {
    zombies += r.zombies
    const sum = r.stuck.reduce((a, b) => a + b, 0)
    totalStuck += sum
    worst = Math.max(worst, sum)
    longest = Math.max(longest, r.longestStuck)
    over += r.stuck.filter((v) => v > 2).length
    notArrived += r.zombies - r.arrived
  }
  return { scenarios: results.length, zombies, totalStuck, worstScenarioStuck: worst, longestStuck: longest, stuckOver2s: over, notArrived, results }
}

if (import.meta.main) {
  const all = process.argv.includes("--all")
  const results = doorScenarios().map((s) => runDoorScenario(s))
  const sum = summarize(results)
  for (const r of results) {
    const total = r.stuck.reduce((a, b) => a + b, 0)
    if (all || total > 0 || r.arrived < r.zombies) {
      console.log(
        `${r.label.padEnd(56)} stuck ${total.toFixed(1).padStart(5)}s longest ${r.longestStuck.toFixed(1).padStart(4)}s arrived ${r.arrived}/${r.zombies} last ${r.allArrivedAt.toFixed(1)}s door ${r.doorOpenedAt.toFixed(1)}s`,
      )
    }
  }
  console.log(
    `\n${sum.scenarios} scenarios, ${sum.zombies} zombies: stuck ${sum.totalStuck.toFixed(1)} s total, worst scenario ${sum.worstScenarioStuck.toFixed(1)} s, longest stretch ${sum.longestStuck.toFixed(1)} s, ${sum.stuckOver2s} zombies stuck > 2 s, ${sum.notArrived} never arrived`,
  )
}
