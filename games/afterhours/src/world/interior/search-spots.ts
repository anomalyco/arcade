import type * as THREE from "three/webgpu"

// Searchable furniture the interior builds (desk drawers, filing cabinets, lockers), registered as it is placed, for
// the game's search system (src/game/search). World coordinates; `storey` 0..4. No game logic here.

export type SearchSpotKind = "desk" | "cabinet" | "locker"
export type SearchSpot = {
  id: string
  kind: SearchSpotKind
  storey: number
  /** Where the hand goes and the aim targets (world). */
  at: readonly [number, number, number]
  /** Lockers: the number on the door. */
  number?: number
}

export const searchSpots: SearchSpot[] = []

export function addSearchSpot(s: SearchSpot) {
  if (searchSpots.some((o) => o.id === s.id)) return
  searchSpots.push(s)
}

/** The 0-30 key cabinet's moving parts (built by storeys/s0/south.ts): its door and the Truck 2 keys on their hook. */
export const keyCabinet: { door: THREE.Object3D | null; keys: THREE.Object3D | null; at: readonly [number, number, number] | null; open(): void } = {
  door: null,
  keys: null,
  at: null,
  /** Swings the door open (it was built closed: half a turn round its hinge). */
  open() {
    if (!this.door || this.door.userData.open) return
    this.door.userData.open = true
    this.door.rotateY(1.9 - Math.PI)
  },
}

/** The Security office (0-38) key box: the FAC. CAB. key on its hook (built by storeys/s0/east.ts). */
export const securityKeyBox: { keys: THREE.Object3D | null; at: readonly [number, number, number] | null } = { keys: null, at: null }

;(globalThis as { __ashwoodKeyCabinet?: typeof keyCabinet }).__ashwoodKeyCabinet = keyCabinet
