/** Vehicle shapes the world streamer saves with its chunks, with no runtime code (see `shared/vehicles.ts`). */

export type VehicleKind = "sedan" | "cruiser" | "pickup" | "van"

export type SavedVehicleState = {
  id: number
  kind: VehicleKind
  originChunkKey: string
  spawnX: number
  spawnY: number
  spawnH: number
  x: number
  y: number
  h: number
  hp: number
  fuel: number
  hasBattery: boolean
  hasKeys: boolean
  headlights: boolean
  wreck: boolean
}
