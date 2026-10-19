import type * as THREE from "three/webgpu"
import type { Flow } from "./flow"
import { BUILDING, UPPER } from "../world/layout"
import { completeObjective, clearObjective, setObjective } from "./objective"
import { roomById } from "../world/interior/registry"

// The run's objective chain (play mode): set when explore starts, advanced by simple zone checks on the camera.
//   explore           → "Find the source of the transmission — check the map (M)"
//   storey 3 corridor → "Find the radio room — 3-08"
//   inside 3-08       → "Find the night crew"

export const OBJECTIVES = {
  transmission: "Find the source of the transmission — check the map (M)",
  radio: "Find the radio room — 3-08",
  crew: "Find the night crew",
} as const

/** The same first objective, handwritten across the top of the clipboard's first sheet. */
export const BRIEFING = ["Find the source of the transmission.", "floor plans on the next pages — start inside"]

const ROOM_3_08 = { x0: 0.8, x1: 11.6, z0: -21.65, z1: -1.75 }
const SPINE = UPPER.corridor
/** Storey the eye is on (eye ≈ 1.6 m over the floor). */
const floorOf = (eyeY: number) => Math.floor((eyeY - 1.0 - BUILDING.floorY) / BUILDING.main.storeyHeight + 0.15)

export function startObjectives(flow: Flow, camera: THREE.Camera, signal?: AbortSignal) {
  let stage = 0
  let next = 0
  const advance = (text: string) => {
    stage++
    completeObjective()
    clearTimeout(next)
    next = window.setTimeout(() => setObjective(text), 1700)
  }
  setObjective(OBJECTIVES.transmission)
  const off = flow.onUpdate(() => {
    const p = camera.position
    const s = floorOf(p.y)
    if (stage === 0 && s === 3 && p.x > SPINE.min[0] && p.x < SPINE.max[0] && p.z > SPINE.min[1] && p.z < SPINE.max[1]) advance(OBJECTIVES.radio)
    else if (stage === 1 && s === 3) {
      const r = roomById(3, "3-08")?.rect ?? ROOM_3_08
      if (p.x > r.x0 && p.x < r.x1 && p.z > r.z0 && p.z < r.z1) advance(OBJECTIVES.crew)
    }
  })
  const stop = () => {
    off()
    clearTimeout(next)
    clearObjective()
  }
  signal?.addEventListener("abort", stop)
  return stop
}
