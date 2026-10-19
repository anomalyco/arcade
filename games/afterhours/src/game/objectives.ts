import type * as THREE from "three/webgpu"
import type { Flow } from "./flow"
import { BUILDING, UPPER } from "../world/layout"
import { completeObjective, clearObjective, setObjective } from "./objective"
import { roomById } from "../world/interior/registry"
import { transmitter } from "../world/interior/storeys/s3/transmitter-state"

// The run's objective chain (play mode): set when explore starts, advanced by simple zone checks on the camera.
//   explore           → "Find the source of the transmission — check the map (M)"
//   storey 3 corridor → "Find the radio room — 3-08"
//   inside 3-08       → "Shut off the transmitter"     (the TX POWER switch on the rack, E)
//   switch thrown     → (silence, then a crash outside) → "Get out."   ← checkpoint "3-08:transmitter-off";
//                                                                         the end of the current content

export const OBJECTIVES = {
  transmission: "Find the source of the transmission — check the map (M)",
  radio: "Find the radio room — 3-08",
  transmitter: "Shut off the transmitter",
  out: "Get out.",
} as const

/** The same first objective, handwritten across the top of the clipboard's first sheet. */
export const BRIEFING = ["Find the source of the transmission.", "floor plans on the next pages — start inside"]

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
/** Where the story stands (read by checkpoints and encounters): 0 explore … 2 in 3-08 … 3 "Get out.". */
export const story = { stage: 0, visited308: false }

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
  setObjective([OBJECTIVES.transmission, OBJECTIVES.radio, OBJECTIVES.transmitter, OBJECTIVES.out][Math.min(3, from)]!)
  if (from === 0) checkpoint("arrival")
  const off = flow.onUpdate(() => {
    const p = camera.position
    const s = floorOf(p.y)
    if (stage === 0 && s === 3 && p.x > SPINE.min[0] && p.x < SPINE.max[0] && p.z > SPINE.min[1] && p.z < SPINE.max[1]) advance(OBJECTIVES.radio)
    else if (stage === 1 && s === 3) {
      const r = roomById(3, "3-08")?.rect ?? ROOM_3_08
      if (p.x > r.x0 && p.x < r.x1 && p.z > r.z0 && p.z < r.z1) {
        advance(OBJECTIVES.transmitter)
        story.visited308 = true
        checkpoint("3-08:entered")
      }
    }
    story.stage = stage
  })
  // The transmitter beat runs on the world's clock: the switch strikes the line through; the next one only comes
  // after the silence and the crash outside.
  const offTx = transmitter.on((phase) => {
    if (phase === "off") {
      if (stage < 2) stage = 2
      story.visited308 = true
      clearTimeout(next)
      completeObjective()
    } else if (phase === "aftermath") {
      stage = 3
      clearTimeout(next)
      next = window.setTimeout(() => {
        setObjective(OBJECTIVES.out)
        checkpoint("3-08:transmitter-off")
      }, 2600)
    }
  })
  const stop = () => {
    off()
    offTx()
    clearTimeout(next)
    clearObjective()
  }
  signal?.addEventListener("abort", stop)
  return stop
}
