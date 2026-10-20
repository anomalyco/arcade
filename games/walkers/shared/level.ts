// Levels: the floor, solid blocks (ceilings, vents), props (loose crates, seesaws, moving platforms) and, for the heist,
// lasers, cameras, a pressure plate, the gem and the exit. Everything is plain data built deterministically from a
// task id and its settings, so workers and replays rebuild exactly the same room.

import { mulberry32 } from "@arcade/kit/sim/rng"

export type Pt = [number, number]

export type PropDef =
  | { kind: "crate"; x: number; y: number; hx: number; hy: number; m: number }
  /** A plank on a pivot pinned to the world. */
  | { kind: "seesaw"; x: number; y: number; hx: number; hy: number; m: number; tilt: number }
  /** An immovable platform sliding along (ax, ay) on a sine. */
  | { kind: "platform"; x: number; y: number; hx: number; hy: number; ax: number; ay: number; period: number; phase: number }

export type LaserDef =
  /** A fixed beam; with on/off it pulses (seconds), with grid it switches off once the plate is pressed. */
  | { kind: "beam"; x1: number; y1: number; x2: number; y2: number; on?: number; off?: number; offset?: number; grid?: boolean }
  /** A level beam between x1 and x2 that sweeps up and down: height y + amp·sin(2πt/period + phase). */
  | { kind: "sweep"; x1: number; x2: number; y: number; amp: number; period: number; phase: number }

export type CameraDef = { x: number; y: number; angle: number; amp: number; period: number; phase: number; half: number; range: number }

export type Level = {
  /** Human contact exceptions: only lowered hands/knees in these obstacle zones. */
  crawlZones?: { x0: number; x1: number; height: number }[]
  floor: Pt[]
  blocks: Pt[][]
  props: PropDef[]
  lasers: LaserDef[]
  cameras: CameraDef[]
  plate: { x0: number; x1: number } | null
  gem: { x: number; y: number } | null
  /** Finish line (m); with a gem it is the exit and needs the gem. */
  goal: number
  dark: boolean
  /** Episode length (s) when this level needs longer than the reward's default. */
  seconds?: number
  /** Room extent, for drawing. */
  left: number
  right: number
  height: number
}

export type HeistSettings = { stage: number; laserSpeed: number; extra?: number }

export const HEIST_STAGES = ["Walk-through", "Static beams", "Pulsing beam", "Sweeper + camera", "Full heist"] as const
export const HEIST_MAX_STAGE = HEIST_STAGES.length - 1

const LEFT = -3
const GOAL = 16
const RIGHT = GOAL + 4
const H = 3

const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]

function room(middle: Pt[] = [], right = RIGHT): Pt[] {
  return [[LEFT - 0.5, H], [LEFT, H], [LEFT, 0], ...middle, [right, 0], [right, H], [right + 0.5, H]]
}

function bump(x: number, w: number, h: number): Pt[] {
  return [[x, 0], [x, h], [x + w, h], [x + w, 0]]
}

function base(floor: Pt[]): Level {
  return { floor, blocks: [], props: [], lasers: [], cameras: [], plate: null, gem: null, goal: GOAL, dark: false, left: LEFT, right: RIGHT, height: H }
}

export function roomLevel(): Level {
  return base(room())
}

export function wallLevel(): Level {
  return base(room([...bump(3, 0.3, 0.14), ...bump(7, 0.3, 0.22), ...bump(11.5, 0.3, 0.3)]))
}

export function stepsLevel(): Level {
  const out: Pt[] = []
  let h = 0
  for (let i = 0; i < 8; i++) {
    const x = 2.5 + i * 0.9
    out.push([x, h])
    h += 0.07
    out.push([x, h])
  }
  out.push([2.5 + 8 * 0.9 + 1.2, h])
  for (let i = 0; i < 8; i++) {
    const x = 2.5 + 8 * 0.9 + 1.2 + i * 0.9
    out.push([x, h])
    h -= 0.07
    out.push([x, h])
  }
  return base(room(out))
}

export function roughLevel(): Level {
  const rand = mulberry32(7)
  const out: Pt[] = [[1.5, 0]]
  let h = 0
  for (let x = 2; x < GOAL + 1.5; x += 0.5) {
    h = Math.max(0, Math.min(0.35, h + (rand() - 0.5) * 0.16))
    out.push([x, Math.round(h * 1000) / 1000])
  }
  out.push([GOAL + 2, 0])
  return base(room(out))
}

/** Gaps are shallow trenches: with 1.2 m pits, a quadruped that put a paw wrong at the first moving platform stayed
 *  down there and the whole population stopped at 5 m. */
const PIT = 0.3

export const COURSE_MODULES = ["steps", "ramp", "gap", "hurdle", "ceiling", "crate", "seesaw", "platform"] as const

/** A seeded obstacle course: a run of modules picked from the room kit, from x = 1.5 to the goal at 16 m. */
export function courseLevel(seed: number): Level {
  const rand = mulberry32((seed * 2654435761) >>> 0)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
  const r = (a: number, b: number) => Math.round((a + (b - a) * rand()) * 100) / 100
  const floor: Pt[] = []
  const blocks: Pt[][] = []
  const props: PropDef[] = []
  let x = 1.5
  let y = 0
  const flat = (len: number) => { x += len }
  const mods = [...COURSE_MODULES]
  let last = ""
  while (x < GOAL - 2.5) {
    let m: string = pick(mods)
    if (m === last) m = pick(mods)
    last = m
    if (m === "steps") {
      const n = 2 + Math.floor(rand() * 3), rise = r(0.06, 0.11), run = r(0.5, 0.8)
      for (let i = 0; i < n; i++) { floor.push([x, y]); y += rise; floor.push([x, y]); x += run }
      flat(0.6)
      for (let i = 0; i < n; i++) { floor.push([x, y]); y -= rise; floor.push([x, y]); x += run }
      y = Math.max(0, y)
    } else if (m === "ramp") {
      const rise = r(0.2, 0.4), run = r(1.2, 2)
      floor.push([x, y]); x += run; y += rise; floor.push([x, y]); flat(r(0.4, 1)); floor.push([x, y]); x += run; y -= rise; floor.push([x, y])
    } else if (m === "gap") {
      const w = r(0.22, 0.4)
      floor.push([x, y], [x, y - PIT], [x + w, y - PIT], [x + w, y]); x += w
    } else if (m === "hurdle") {
      const h = r(0.1, 0.2)
      floor.push([x, y], [x, y + h], [x + 0.06, y + h], [x + 0.06, y]); x += 0.06
    } else if (m === "ceiling") {
      const h = r(0.58, 0.7), len = r(1.2, 1.8)
      blocks.push(rect(x, y + h, x + len, y + h + 0.25)); x += len
    } else if (m === "crate") {
      const s = r(0.12, 0.18)
      props.push({ kind: "crate", x: x + s, y: y + s + 0.01, hx: s, hy: s, m: r(2, 5) }); x += 2 * s
    } else if (m === "seesaw") {
      const hx = 0.8, py = 0.2, tilt = 0.25
      floor.push([x + hx - 0.05, y], [x + hx - 0.05, y + py - 0.04], [x + hx + 0.05, y + py - 0.04], [x + hx + 0.05, y])
      props.push({ kind: "seesaw", x: x + hx, y: y + py, hx, hy: 0.035, m: 6, tilt }); x += 2 * hx
    } else {
      const w = 0.9
      floor.push([x, y], [x, y - PIT], [x + w, y - PIT], [x + w, y])
      props.push({ kind: "platform", x: x + w / 2, y: y - 0.05, hx: 0.28, hy: 0.05, ax: 0.22, ay: 0, period: 2.4, phase: r(0, 6) }); x += w
    }
    flat(r(0.7, 1.4))
  }
  if (y !== 0) floor.push([x, y], [x + 1, 0])
  return { ...base(room(floor)), blocks, props, seconds: 24 }
}

/**
 * The vault: in through a low vent on the left, over a trip wire and under a high beam, through a pulsing beam, over
 * a pressure plate that kills the laser grid, up to the gem on its pedestal, then under a scanning beam and past a
 * panning camera to the exit door. Curriculum stages add the hazards one group at a time.
 */
export function heistLevel(h: HeistSettings): Level {
  const stage = Math.max(0, Math.min(HEIST_MAX_STAGE, Math.round(h.stage)))
  const k = Math.max(0.25, h.laserSpeed)
  const exit = 19
  const right = exit + 2
  const lv = base(room([], right))
  lv.goal = exit
  lv.right = right
  lv.dark = true
  lv.blocks.push(rect(LEFT, 0.88, 0.7, 1.15), rect(LEFT, H - 0.05, right, H + 0.3), rect(exit + 0.25, 1.4, right, H - 0.05))
  // The pedestal stands behind the creature's plane (drawn, not solid); the gem sits at head height.
  lv.gem = { x: 10, y: 0.62 }
  if (stage >= 1) {
    lv.lasers.push({ kind: "beam", x1: 2.4, y1: 0.07, x2: 2.52, y2: 0.07 })
    lv.lasers.push({ kind: "beam", x1: 3.9, y1: 0.7, x2: 4.9, y2: 0.7 })
  }
  if (stage >= 2) lv.lasers.push({ kind: "beam", x1: 6.6, y1: 0, x2: 6.6, y2: 1.6, on: 1.1 / k, off: 1.2 / k, offset: 0 })
  if (stage >= 3) {
    // In a side view, anything that sweeps across the whole floor can't be dodged: the creature has to cross it
    // somewhere (a swinging beam from the ceiling was, measurably, unavoidable). So the sweeper scans up and down (go
    // under it while it is high), and the camera pans from looking out of reach of the floor to looking straight down.
    lv.lasers.push({ kind: "sweep", x1: 12.2, x2: 13.2, y: 0.7, amp: 0.45, period: 3.6 / k, phase: 0 })
    lv.cameras.push({ x: 17.3, y: H - 0.08, angle: -Math.PI + 0.7, amp: 0.5, period: 5 / k, phase: 1.3, half: 0.16, range: 3.4 })
  }
  const extra = Math.max(0, Math.min(4, Math.round(h.extra ?? 0)))
  for (let i = 0; i < extra; i++) lv.lasers.push({ kind: "beam", x1: 14 + i, y1: 0, x2: 14 + i, y2: 1.6, on: 0.9 / k, off: 1.3 / k, offset: 0.55 * i })
  if (stage >= 4) {
    lv.plate = { x0: 7.5, x1: 8.1 }
    for (const gx of [8.7, 8.95, 9.2]) lv.lasers.push({ kind: "beam", x1: gx, y1: 0, x2: gx, y2: 1.5, grid: true })
    lv.lasers.push({ kind: "beam", x1: 8.55, y1: 1.4, x2: 9.35, y2: 0.02, grid: true })
  }
  return lv
}

/** Same vault mechanics, scaled for a standing human. Stage zero is a short hand-grab lesson. */
export function humanHeistLevel(h: HeistSettings): Level {
  const lv = heistLevel(h)
  lv.blocks = [rect(LEFT, H - .05, lv.right, H + .3)]
  lv.gem = { x: h.stage === 0 ? 3.8 : 10, y: 1.0 }
  if (h.stage === 0) lv.goal = 5
  lv.crawlZones = []
  if (h.stage >= 1) {
    lv.lasers[1] = { kind: "beam", x1: 3.9, y1: 1.25, x2: 4.9, y2: 1.25 }
    lv.crawlZones.push({ x0: 3.1, x1: 5.6, height: 1.15 })
  }
  if (h.stage >= 2) {
    lv.blocks.push(rect(11, .78, 12, 1.02))
    lv.crawlZones.push({ x0: 10.2, x1: 12.8, height: .7 })
  }
  // Timed barriers must reach above the human's head; no walking over a shoulder-height vertical beam.
  for (const beam of lv.lasers) if (beam.kind === "beam" && beam.x1 === beam.x2) beam.y2 = 2.2
  return lv
}
