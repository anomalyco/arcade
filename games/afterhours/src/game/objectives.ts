import type * as THREE from "three/webgpu"
import type { Flow } from "./flow"
import { BUILDING, UPPER } from "../world/layout"
import { completeObjective, clearObjective, setObjective } from "./objective"
import { roomById } from "../world/interior/registry"
import { onReveal, onTransmitted } from "../world/interior/storeys/s3/transmitter-state"

// The run's objective chain (play mode): set when explore starts, advanced by simple zone checks on the camera and the
// 3-08 radio-room beat (world/interior/storeys/s3/transmitter.ts):
//   explore           → "Find out why the radio went silent. Check the map (M)"
//   storey 3 corridor → "Find the radio room: 3-08"
//   inside 3-08       → "Report what you found"          ← checkpoint "3-08:entered"
//                       (switch TX-1 on, then key the desk mic: the call to County)
//   call over         → "Check the body at the desk"
//   body moved        → the warning under it            ← checkpoint "3-08:transmitted"; story.revealed
//                       (a beat of silence, the scream, the car, the glass: the Wendigo is in) → "Hide."

export const OBJECTIVES = {
  transmission: "Find out why the radio went silent. Check the map (M)",
  radio: "Find the radio room: 3-08",
  report: "Report what you found",
  body: "Check the body at the desk",
  hide: "Hide.",
} as const
/** The objective line for each story stage (checkpoint restores show `CHAIN[stage]`). */
export const CHAIN = [OBJECTIVES.transmission, OBJECTIVES.radio, OBJECTIVES.report, OBJECTIVES.body, OBJECTIVES.hide]
/** "Hide." comes this long after the warning is seen (s): after the scream and the car. */
const HIDE_AFTER = 7.5

/** The briefing, handwritten across the top of the clipboard's first sheet (two lines: underlined, then smaller). */
export const BRIEFING = ["Station radio silent 48 hrs.", "Last contact from radio room 3-08. Find out why."]

const ROOM_3_08 = { x0: 0.8, x1: 11.6, z0: -21.65, z1: -1.75 }
const SPINE = UPPER.corridor
/** Storey the eye is on (eye ≈ 1.6 m over the floor). */
const floorOf = (eyeY: number) => Math.floor((eyeY - 1.0 - BUILDING.floorY) / BUILDING.main.storeyHeight + 0.15)

/** Story checkpoints reached this run, in order; `onCheckpoint` listeners hear each one as it lands (saves, chapters). */
export const checkpoints: string[] = []
const checkpointListeners = new Set<(id: string) => void>()
export function onCheckpoint(fn: (id: string) => void) {
  checkpointListeners.add(fn)
  return () => checkpointListeners.delete(fn)
}
/** Where the story stands (read by checkpoints and encounters): the CHAIN index (0 explore … 2 in 3-08, 3 check the
 *  body, 4 "Hide."), whether 3-08 has been entered, and whether the warning has been seen (the hunter is coming). */
export const story = { stage: 0, visited308: false, revealed: false }

function checkpoint(id: string) {
  checkpoints.push(id)
  for (const l of checkpointListeners) l(id)
}

/** `from`: resume at a stage (a checkpoint restore) instead of the start of the chain. */
export function startObjectives(flow: Flow, camera: THREE.Camera, signal?: AbortSignal, from = 0) {
  let stage = from
  let next = 0
  const advance = (text: string) => {
    stage++
    completeObjective()
    clearTimeout(next)
    next = window.setTimeout(() => setObjective(text), 1700)
  }
  story.stage = from
  if (from >= 2) story.visited308 = true
  if (from >= 4) story.revealed = true
  setObjective(CHAIN[Math.min(CHAIN.length - 1, from)]!)
  if (from === 0) checkpoint("arrival")
  const off = flow.onUpdate(() => {
    const p = camera.position
    const s = floorOf(p.y)
    if (stage === 0 && s === 3 && p.x > SPINE.min[0] && p.x < SPINE.max[0] && p.z > SPINE.min[1] && p.z < SPINE.max[1]) advance(OBJECTIVES.radio)
    else if (stage === 1 && s === 3) {
      const r = roomById(3, "3-08")?.rect ?? ROOM_3_08
      if (p.x > r.x0 && p.x < r.x1 && p.z > r.z0 && p.z < r.z1) {
        advance(OBJECTIVES.report)
        story.visited308 = true
        checkpoint("3-08:entered")
      }
    }
    story.stage = stage
  })
  // The radio-room beat runs on the world's clock.
  const offTx = onTransmitted(() => {
    if (stage >= 3) return
    stage = 3
    story.stage = 3
    story.visited308 = true
    completeObjective()
    clearTimeout(next)
    next = window.setTimeout(() => setObjective(OBJECTIVES.body), 1700)
  })
  const offReveal = onReveal(() => {
    if (stage >= 4) return
    stage = 4
    story.stage = 4
    story.revealed = true
    completeObjective()
    clearTimeout(next)
    checkpoint("3-08:transmitted")
    next = window.setTimeout(() => setObjective(OBJECTIVES.hide), HIDE_AFTER * 1000)
  })
  const stop = () => {
    off()
    offTx()
    offReveal()
    clearTimeout(next)
    clearObjective()
  }
  signal?.addEventListener("abort", stop)
  return stop
}
