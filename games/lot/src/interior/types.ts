import type { SourceLamp } from "../world"

export type Collider = { min: number[]; max: number[] }
export type Placement = { position: [number, number, number]; yaw?: number; scale?: number; collide?: boolean }
export type InteriorScene = {
  version: number
  records: { file: string; name: string; roughness: number; metalness: number; alpha: number; triangles: number }[]
  lamps: SourceLamp[]
  colliders: Collider[]
  placements: { name: string; props: Placement[] }[]
}
