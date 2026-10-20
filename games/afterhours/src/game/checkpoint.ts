import type { Player } from "../player"
import { onCheckpoint, story } from "./objectives"
import { transmitter, type TransmitterPhase } from "../world/interior/storeys/s3/transmitter-state"
import { BUILDING } from "../world/layout"

// Story checkpoints (play mode): a snapshot of where the player stood and how far the story got, taken whenever the
// objective chain lands a checkpoint (src/game/objectives.ts: "arrival" right after the intro, "3-08:entered",
// "3-08:transmitted"). The death screen restores the last one in place: the player's transform, the objective
// chain at its stage and the run's flags. The world itself isn't rewound (the transmitter only ever moves forward, and
// the checkpoints follow it, so its state always matches the snapshot's).

export type Checkpoint = {
  id: string
  /** Feet position and view. */
  pos: { x: number; y: number; z: number }
  yaw: number
  pitch: number
  storey: number
  /** Objective chain stage (story.stage) and flags. */
  stage: number
  visited308: boolean
  transmitter: TransmitterPhase
  at: number
}

let last: Checkpoint | null = null

export function snapshot(id: string, player: Player): Checkpoint {
  const p = player.pos
  return {
    id,
    pos: { x: p.x, y: p.y, z: p.z },
    yaw: player.yaw,
    pitch: player.pitch,
    storey: Math.max(0, Math.round((p.y - BUILDING.floorY) / BUILDING.main.storeyHeight)),
    // A checkpoint that lands with an objective change records the stage it starts.
    stage: id === "arrival" ? 0 : id === "3-08:entered" ? 2 : id === "3-08:transmitted" ? 4 : story.stage,
    visited308: story.visited308 || id !== "arrival",
    transmitter: transmitter.phase,
    at: performance.now(),
  }
}

/** Records every checkpoint the objectives land for this player. Returns an unsubscribe. */
export function trackCheckpoints(player: Player) {
  return onCheckpoint((id) => {
    last = snapshot(id, player)
    try {
      sessionStorage.setItem("afterhours.checkpoint", JSON.stringify(last))
    } catch {}
  })
}

export const lastCheckpoint = () => last

/** Makes `cp` the run's last checkpoint (a chapter jump, src/game/chapters.ts). */
export function setLastCheckpoint(cp: Checkpoint) {
  last = cp
  try {
    sessionStorage.setItem("afterhours.checkpoint", JSON.stringify(last))
  } catch {}
}

/** Puts the player back where the checkpoint was taken (velocity, crouch and air state cleared). */
export function restorePlayer(player: Player, cp: Checkpoint) {
  const p = player.pos as { x: number; y: number; z: number }
  p.x = cp.pos.x
  p.y = cp.pos.y
  p.z = cp.pos.z
  const look = player as unknown as { yaw: number; pitch: number }
  look.yaw = cp.yaw
  look.pitch = cp.pitch
  player.release()
  player.resetMotion()
  story.visited308 = cp.visited308
}

/** Clears the run's checkpoint (start over). */
export function clearCheckpoints() {
  last = null
  try {
    sessionStorage.removeItem("afterhours.checkpoint")
  } catch {}
}
