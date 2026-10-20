import type { Player } from "../player"
import { BUILDING } from "../world/layout"
import { transmitter, type TransmitterPhase } from "../world/interior/storeys/s3/transmitter-state"
import { PARKED } from "./intro/route"
import { type Checkpoint, restorePlayer, setLastCheckpoint } from "./checkpoint"
import { CHAIN, story } from "./objectives"
import { setObjective } from "./objective"

// Dev chapter select: jump straight to a point in the story without the intro or the climb. Each chapter is a
// checkpoint (src/game/checkpoint.ts) plus the 3-08 beat's phase (transmitter-state.ts): jumping sets the beat's phase,
// makes the chapter the run's last checkpoint and restores it by the checkpoints' own path (play mode: the death
// screen's `restart`, src/game/encounters; debug: restorePlayer + the hunter). Dev builds and localhost only.
//
//   play mode:  /?play&start=3-08     (ids below), or F9 on the home screen for a list
//   debug:      Lab → Story

export type ChapterId = "arrival" | "lobby" | "3-08" | "tx-on" | "after-call" | "after-reveal" | "ambush"

type Chapter = {
  id: ChapterId
  label: string
  stage: number
  phase: TransmitterPhase
  visited308: boolean
  /** Feet position (world), yaw (rad, 0 = −Z), pitch. */
  at: [number, number, number]
  yaw: number
  pitch?: number
}

const Y0 = BUILDING.floorY + 0.01
const Y3 = Y0 + 3 * BUILDING.main.storeyHeight

export const CHAPTERS: readonly Chapter[] = [
  { id: "arrival", label: "Arrival (by the car)", stage: 0, phase: "off", visited308: false, at: [PARKED.x + 1.8, 0, PARKED.z - 1.0], yaw: 0 },
  { id: "lobby", label: "Lobby", stage: 0, phase: "off", visited308: false, at: [0, Y0, 17.5], yaw: 0 },
  { id: "3-08", label: "3-08 entered (transmitter off)", stage: 2, phase: "off", visited308: true, at: [3.4, Y3, -3.6], yaw: 2.6, pitch: -0.05 },
  { id: "tx-on", label: "Transmitter on (use the mic)", stage: 2, phase: "on", visited308: true, at: [9.0, Y3, -12.85], yaw: 0, pitch: -0.45 },
  { id: "after-call", label: "After the call (push the body)", stage: 3, phase: "transmitted", visited308: true, at: [8.45, Y3, -12.45], yaw: 0.05, pitch: -0.5 },
  { id: "after-reveal", label: "After the reveal (Hide, hunter on)", stage: 4, phase: "revealed", visited308: true, at: [8.45, Y3, -12.45], yaw: 0.05, pitch: -0.5 },
  { id: "ambush", label: "Lift ambush armed (storey 3 lift lobby)", stage: 2, phase: "off", visited308: true, at: [-37.9, Y3, 17.2], yaw: Math.PI },
]

/** Chapter select is available (dev server or a local preview, never on the public site). */
export const chaptersEnabled = () => import.meta.env.DEV || ["localhost", "127.0.0.1", "[::1]", "::1"].includes(location.hostname)

export const chapterById = (id: string) => CHAPTERS.find((c) => c.id === id) ?? null

/** The chapter as a checkpoint (the arrival's y is the ground at the car). */
export function chapterCheckpoint(c: Chapter, groundY: (x: number, z: number) => number): Checkpoint {
  const [x, y, z] = c.at
  return {
    id: `chapter:${c.id}`,
    pos: { x, y: c.id === "arrival" ? groundY(x, z) : y, z },
    yaw: c.yaw,
    pitch: c.pitch ?? 0,
    storey: Math.max(0, Math.round((y - BUILDING.floorY) / BUILDING.main.storeyHeight)),
    stage: c.stage,
    visited308: c.visited308,
    transmitter: c.phase,
    at: performance.now(),
  }
}

/** False when the beat is already past the chapter's phase (it only moves forward): the caller reloads instead. */
export const chapterReachable = (c: Chapter) => !transmitter.reached(c.phase) || transmitter.phase === c.phase

/**
 * Moves the run to `c`. `restart` is the checkpoint restore (play mode: the encounters' `restart`); without it (debug)
 * the player and the hunter are restored here.
 */
export async function jumpToChapter(c: Chapter, player: Player, groundY: (x: number, z: number) => number, restart?: () => void) {
  // The hunter has to be in place before the beat moves past the reveal (its entry hooks onto it; the restore then
  // replaces the entry with "somewhere far away, a grace period").
  const { hunterHandle } = await import("./hunter")
  if (c.phase === "revealed") for (let i = 0; i < 100 && !hunterHandle(); i++) await new Promise((r) => setTimeout(r, 100))
  transmitter.set(c.phase)
  const cp = chapterCheckpoint(c, groundY)
  setLastCheckpoint(cp)
  if (restart) restart()
  else {
    restorePlayer(player, cp)
    story.stage = cp.stage
    story.revealed = cp.stage >= 4
    setObjective(CHAIN[Math.min(CHAIN.length - 1, cp.stage)]!)
    const h = hunterHandle()
    if (h) cp.stage >= 4 ? h.restore() : h.sleep()
  }
  if (c.id === "ambush") void (globalThis as { __ashwoodAmbush?: { arm(): Promise<void> } }).__ashwoodAmbush?.arm()
}
