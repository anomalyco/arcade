import type * as THREE from "three/webgpu"
import type { Flow } from "./flow"
import { BUILDING, UPPER } from "../world/layout"
import { completeObjective, clearObjective, setObjective } from "./objective"
import { roomById } from "../world/interior/registry"
import { onReveal, onTransmitted } from "../world/interior/storeys/s3/transmitter-state"
import { hasItem, hasNote, onInventory } from "./inventory"
import { power } from "../world/power"

// The run's objective chain (play mode): set when explore starts, advanced by simple zone checks on the camera and the
// 3-08 radio-room beat (world/interior/storeys/s3/transmitter.ts):
//   explore           → "Find out why the radio went silent. Check the map (M)"
//   storey 3 corridor → "Find the radio room: 3-08"
//   inside 3-08       → "Restore the power. The switch is on the transmitter"  ← checkpoint "3-08:entered"
//                       (the station is dark until MAIN POWER on TX-1 is thrown: src/game/power.ts)
//   power back        → "Use the radio. Report what you found" (same stage; key the desk mic: the call to County)
//   call over         → "Check the body at the desk"
//   body moved        → the warning under it            ← checkpoint "3-08:transmitted"; story.revealed
//                       (a beat of silence, the scream, the car, the glass: the Wendigo is in) → "Hide."
//   hidden             → "Find the truck keys"         ← checkpoint "hide:over" (the hunter lost you for 30 s, or 90 s)
//   then the key trail (src/game/search, src/game/inventory), each step from what you carry or have read:
//     the vehicle sign-out by 3-08      → "Facilities office, 0-30"                     ← checkpoint "trail:signout"
//     the locked cabinet's tag           → "Get the cabinet key from Security (0-38)"  ← checkpoint "trail:tag"
//     the FAC. CAB. key from the key box → "Facilities office, 0-30"                   ← checkpoint "trail:cabinet-key"
//     the Truck 2 keys from the cabinet  → "Escape. The truck is in the vehicle shed by the dock." ← checkpoint "trail:keys"
//   (Hargrove's body, his note and locker 14 are flavour: never objectives.)
//   (`onObjective` listeners hear each new stage; the escape drive picks up from the last one.)

export const OBJECTIVES = {
  transmission: "Find out why the radio went silent. Check the map (M)",
  radio: "Find the radio room: 3-08",
  power: "Restore the power. The switch is on the transmitter",
  report: "Use the radio. Report what you found",
  body: "Check the body at the desk",
  hide: "Hide.",
  keys: "Find the truck keys",
  cabinet: "Facilities office, 0-30",
  security: "Get the cabinet key from Security (0-38)",
  office: "Facilities office, 0-30",
  escape: "Escape. The truck is in the vehicle shed by the dock.",
} as const
/** The objective line for each story stage (checkpoint restores show `CHAIN[stage]`). */
export const CHAIN = [OBJECTIVES.transmission, OBJECTIVES.radio, OBJECTIVES.report, OBJECTIVES.body, OBJECTIVES.hide, OBJECTIVES.keys, OBJECTIVES.cabinet, OBJECTIVES.security, OBJECTIVES.office, OBJECTIVES.escape]
/** The objective line for a stage now (stage 2 reads "restore the power" until the mains are back). */
export function objectiveText(stage: number) {
  const s = Math.max(0, Math.min(CHAIN.length - 1, stage))
  return s === 2 && !power.on ? OBJECTIVES.power : CHAIN[s]!
}
/** Stage numbers past "Hide." (CHAIN indices). */
export const STAGE = { hide: 4, keys: 5, cabinet: 6, security: 7, office: 8, escape: 9 } as const
/** Hiding: over once the hunter has lost the player for HIDE_LOST s (after at least HIDE_MIN s), or at HIDE_MAX s. */
const HIDE_MIN = 30
const HIDE_LOST = 30
const HIDE_MAX = 90
/** "Hide." comes this long after the warning is seen (s): right after the struck-through line fades. */
const HIDE_AFTER = 3

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

const objectiveListeners = new Set<(stage: number, text: string) => void>()
/** Each new objective stage (CHAIN index) as it is set. Returns an unsubscribe. */
export function onObjective(fn: (stage: number, text: string) => void) {
  objectiveListeners.add(fn)
  return () => objectiveListeners.delete(fn)
}

/** The key-trail stage from what the player carries and has read. */
export function trailStage() {
  if (hasItem("truck-keys")) return STAGE.escape
  if (hasItem("cabinet-key")) return STAGE.office
  if (hasNote("cabinet-tag")) return STAGE.security
  if (hasNote("signout")) return STAGE.cabinet
  return STAGE.keys
}

function checkpoint(id: string) {
  checkpoints.push(id)
  for (const l of checkpointListeners) l(id)
}

/** `from`: resume at a stage (a checkpoint restore) instead of the start of the chain. The stage lives in
 *  `story.stage` (a checkpoint restore sets it there too). */
export function startObjectives(flow: Flow, camera: THREE.Camera, signal?: AbortSignal, from = 0) {
  let next = 0
  const go = (stage: number, delay = 1700) => {
    if (stage <= story.stage && delay > 0) return
    story.stage = stage
    completeObjective()
    clearTimeout(next)
    const text = objectiveText(stage)
    next = window.setTimeout(() => {
      setObjective(text)
      for (const l of objectiveListeners) l(stage, text)
    }, delay)
  }
  story.stage = from
  if (from >= 2) story.visited308 = true
  if (from >= 4) story.revealed = true
  setObjective(objectiveText(from))
  if (from === 0) checkpoint("arrival")
  // Hiding: the hunter's mode (globalThis.__ashwoodHunter), else the timer alone.
  let hideT = 0
  let lostT = 0
  const huntMode = () => (globalThis as { __ashwoodHunter?: { hunter?: { mode?: string } } }).__ashwoodHunter?.hunter?.mode
  const off = flow.onUpdate((dt) => {
    const p = camera.position
    const s = floorOf(p.y)
    const stage = story.stage
    if (stage === 0 && s === 3 && p.x > SPINE.min[0] && p.x < SPINE.max[0] && p.z > SPINE.min[1] && p.z < SPINE.max[1]) go(1)
    else if (stage === 1 && s === 3) {
      const r = roomById(3, "3-08")?.rect ?? ROOM_3_08
      if (p.x > r.x0 && p.x < r.x1 && p.z > r.z0 && p.z < r.z1) {
        go(2)
        story.visited308 = true
        checkpoint("3-08:entered")
      }
    } else if (stage === STAGE.hide) {
      hideT += dt
      const m = huntMode()
      lostT = m === "hunt" || m === "caught" ? 0 : lostT + dt
      if ((hideT > HIDE_MIN && lostT > HIDE_LOST) || hideT > HIDE_MAX) {
        go(Math.max(STAGE.keys, trailStage()))
        checkpoint("hide:over")
      }
    }
  })
  const trail = () => {
    if (story.stage < STAGE.keys) return
    const t = trailStage()
    if (t <= story.stage) return
    go(t, 1500)
    if (t === STAGE.cabinet) checkpoint("trail:signout")
    else if (t === STAGE.security) checkpoint("trail:tag")
    else if (t === STAGE.office) checkpoint("trail:cabinet-key")
    else if (t === STAGE.escape) checkpoint("trail:keys")
  }
  const offInv = onInventory(trail)
  // The power back on in 3-08: the same stage, now the radio.
  const offPower = power.onChange((on) => {
    if (!on || story.stage !== 2) return
    completeObjective()
    clearTimeout(next)
    next = window.setTimeout(() => setObjective(objectiveText(2)), 2200)
  })
  // The radio-room beat runs on the world's clock.
  const offTx = onTransmitted(() => {
    if (story.stage >= 3) return
    story.visited308 = true
    go(3)
  })
  const offReveal = onReveal(() => {
    if (story.stage >= 4) return
    story.revealed = true
    hideT = 0
    lostT = 0
    go(4, HIDE_AFTER * 1000)
    checkpoint("3-08:transmitted")
  })
  const stop = () => {
    off()
    offInv()
    offTx()
    offReveal()
    offPower()
    clearTimeout(next)
    clearObjective()
  }
  signal?.addEventListener("abort", stop)
  return stop
}
