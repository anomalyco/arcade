import type * as THREE from "three/webgpu"
import { type Builder, type Mat, FLOOR_Y, M, T, door, glow, paint } from "./kit"
import { type DoorState, openable } from "./plan"
import { registerDoor } from "./registry"

// One doorway: frame, leaf (or pair) on the shared door system, number plate and sign, and the hardware its state
// implies (key cylinder for janitor doors, card reader for keycard doors, a hasp and padlock for locked ones).

export type DoorwaySpec = {
  /** Centre of the opening at floor level, on the wall's centre plane (whole assembly, finish layers included). */
  x: number
  z: number
  /** 0: front (sign side) faces +z; π: −z; ±π/2: ∓x. */
  rot: number
  /** Stable id (storey-prefixed automatically), e.g. "1-07". Pairs get "<id>:b" for the second leaf. */
  id?: string
  state: DoorState
  /** Room the door belongs to (registry; usually the room it leads INTO). */
  room?: string
  /** Room number plate (stored for gameplay; drawn as an abstract plate — no readable text) and a label strip. */
  sign?: { number: string; label?: string }
  /** Leaf finish: "steel" (default, green institutional), "veneer", "glass" (full-glazed aluminium), or any Mat. */
  leaf?: "steel" | "veneer" | "glass" | Mat
  /** Vision panel: "wire" (default for steel), "none", or a material. */
  glass?: "wire" | "none" | THREE.Material
  width?: number
  double?: boolean
  /** Dutch door (service counter): a ledge on the wall beside the latch jamb; one leaf in the door system. */
  dutch?: boolean
  /** Insulated cold-room door: thick bright steel leaf, strap hinges, latch handle. */
  insulated?: boolean
  /** Total wall assembly thickness (default 0.15 spine; 0.12 partitions). */
  wallT?: number
  /** Start angle override (rad, sign = side); default from state ("open": ajar ~1.2 rad, others shut). */
  open?: number
  /** Full swing (rad). */
  angle?: number
  /** "fixed" where one side of the opening is blocked (opens only to the `open`/`angle` sign side). */
  swing?: "auto" | "fixed"
  panic?: boolean
}

const KEY_BRASS = paint(0x8a6a2a, 0.3, 0.9)
const READER_LED = glow(0x200404, 0xff2010, 2, "card_reader_led")

/** Builds a doorway; returns the door ids (one, or two for a pair). */
export function doorway(b: Builder, d: DoorwaySpec): string[] {
  const wallT = d.wallT ?? 0.15
  const width = d.width ?? (d.double ? 1.7 : 0.92)
  const leafMat: Mat = d.leaf === undefined || d.leaf === "steel" ? "door_steel" : d.leaf === "veneer" ? M.veneer : d.leaf === "glass" ? M.steel : d.leaf
  const glass = d.leaf === "glass" ? M.glass : d.glass === "none" || d.leaf === "veneer" || d.insulated ? null : d.glass === undefined || d.glass === "wire" ? undefined : d.glass
  const locked = !openable(d.state)
  const id = d.id ? `s${b.storey}:${d.id}` : undefined
  const ids = door(b, d.x, d.z, {
    rot: d.rot,
    wallT,
    width,
    leaves: d.double ? 2 : 1,
    open: d.open ?? (d.state === "open" ? 1.2 : 0),
    angle: d.angle,
    swing: d.swing,
    locked,
    glass,
    leaf: d.insulated ? M.steel : leafMat,
    thickness: d.insulated ? 0.1 : undefined,
    panic: d.panic,
    plate: !!d.sign,
    sound: d.leaf === "glass" ? "glass" : d.leaf === "veneer" ? "wood" : "steel",
    id,
  })
  const F = T(d.x, FLOOR_Y, d.z, d.rot)
  const front = wallT / 2 + 0.014
  const latchX = width / 2 + 0.1
  // State hardware on the frame's latch side, front face.
  if (d.state === "janitor") b.cyl(KEY_BRASS, F.clone().multiply(T(latchX - 0.04, 1.02, front, 0, Math.PI / 2)), 0.016, 0.016, 0.02, 12)
  else if (d.state.startsWith("keycard:")) {
    b.rbox(M.darkSteel, F, 0.08, 0.13, 0.025, 0.006, latchX + 0.04, 1.2, front + 0.004)
    b.boxM(M.felt, F, 0.05, 0.006, 0.004, latchX + 0.04, 1.23, front + 0.017, { cast: false })
    b.boxM(READER_LED, F, 0.012, 0.012, 0.004, latchX + 0.04, 1.16, front + 0.017, { cast: false })
  } else if (d.state === "locked") {
    b.boxM(M.steel, F, 0.03, 0.12, 0.02, latchX - 0.02, 1.15, front + 0.004)
    b.rbox(KEY_BRASS, F, 0.05, 0.06, 0.02, 0.008, latchX - 0.02, 1.07, front + 0.02)
  }
  // Label strip under the number plate (blank: no readable text).
  if (d.sign?.label) b.boxM(M.paper, F, 0.22, 0.05, 0.004, width / 2 + 0.22, 1.39, front, { cast: false })
  // Dutch door: a service ledge on the wall beside the latch jamb (the leaf itself is one piece in the door system).
  if (d.dutch) b.rbox(M.laminateTop, F, 0.5, 0.03, 0.28, 0.008, width / 2 + 0.38, 1.05, wallT / 2 + 0.14)
  if (d.insulated) for (const y of [0.3, 1.6]) b.boxM(M.steel, F, 0.3, 0.05, 0.03, -width / 2 + 0.15, y, front + 0.04)
  registerDoor({ id: ids[0]!, storey: b.storey, state: d.state, room: d.room, x: d.x, z: d.z, sign: d.sign })
  return ids
}
