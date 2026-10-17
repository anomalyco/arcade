import type { DoorState, Rect } from "./plan"

// Room and door registry for gameplay (cleaning anchors, keycards, fuse zones) and the doors check. Filled by `room()`
// and `doorway()` while storeys build; read through `interiorRooms` / `interiorDoors` (re-exported by interior.ts).

export type Anchor = { kind: string; x: number; y: number; z: number }
export type RoomEntry = { id: string; storey: number; name: string; rect: Rect; lit: boolean; doors: string[]; anchors: Anchor[] }
export type DoorEntry = { id: string; storey: number; state: DoorState; room?: string; x: number; z: number; sign?: { number: string; label?: string } }

export const interiorRooms: RoomEntry[] = []
export const interiorDoors: DoorEntry[] = []

export const roomById = (storey: number, id: string) => interiorRooms.find((r) => r.storey === storey && r.id === id)

export function registerDoor(e: DoorEntry) {
  interiorDoors.push(e)
  if (e.room) roomById(e.storey, e.room)?.doors.push(e.id)
}
