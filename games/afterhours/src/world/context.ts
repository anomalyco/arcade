import type * as THREE from "three/webgpu"
import type { LabControl, LabSettings } from "@arcade/kit/lab-panel"
import type { Doors } from "./doors"

/** Axis-aligned solid the player cannot walk through. */
export type Box = { min: readonly [number, number, number]; max: readonly [number, number, number] }

/** A walkable horizontal surface (building floors, the loading dock, booth floor). Outdoors the terrain is the floor. */
export type Floor = {
  min: readonly [number, number]
  max: readonly [number, number]
  y: number
  /**
   * Footstep surface (`Surface` in src/audio/surfaces.ts): "concrete", "linoleum", "tile", "carpet", "raised" (access
   * floor), "wood", "metal" (chequer plate), "grating", "gravel", "asphalt", "grass", "forest". Untagged floors get a
   * default from their position (storey finish, fire escape, lift car, roof); tag a floor to override it.
   */
  surface?: string
}

/**
 * A light source a builder places. Builders only describe fixtures; `render/lighting.ts` decides which become real
 * lights, which cast shadows, and draws their glow and in-scattering, so the light budget lives in one place.
 */
export type Lamp = {
  kind: "sodium" | "fluorescent" | "window" | "exit" | "warning" | "incandescent"
  position: readonly [number, number, number]
  /** Unit direction for spot lights (sodium heads point down, fluorescent panels down). Omit for point lights. */
  direction?: readonly [number, number, number]
  /** Linear RGB colour. */
  color: readonly [number, number, number]
  /** Luminous intensity in candela (three.js physical units). */
  intensity: number
  /** Distance at which the light reaches zero. */
  range: number
  /** Outer cone half-angle in radians for spot lights. */
  angle?: number
  penumbra?: number
  /** Builder hint that this lamp matters for shadows (the rig still enforces a budget). */
  shadow?: boolean
  /** Visible emitter size in metres, for the glow/halo. */
  size?: number
  /** Flicker amount 0..1 (fluorescent tubes on their way out). */
  flicker?: number
  /** Culling zone: "exterior", or "interior:<storey>" for lamps inside the main block. Lighting skips far zones. */
  zone?: string
}

/** A climbable volume (fire-escape and access ladders). Inside it, W/S climb up/down instead of walking. */
export type Ladder = {
  min: readonly [number, number, number]
  max: readonly [number, number, number]
  /**
   * Horizontal unit normal [x, z] of the rung plane, pointing out to the side the climber is on. Optional: by default
   * the player takes the volume's thinner horizontal axis, signed towards the side it approached from.
   */
  normal?: readonly [number, number]
}

export type WorldModule = {
  update?: (dt: number, time: number, camera: THREE.PerspectiveCamera) => void
}

export type WorldContext = {
  scene: THREE.Scene
  renderer: THREE.WebGPURenderer
  camera: THREE.PerspectiveCamera
  colliders: Box[]
  floors: Floor[]
  ladders: Ladder[]
  lamps: Lamp[]
  /** Every openable door (hinged, sliding, roll-up): `ctx.doors.add(...)`. See the migration note in `world/doors.ts`. */
  doors: Doors
  /** Lab panel settings shared by every module; add defaults here and controls to `controls`. */
  settings: LabSettings
  controls: LabControl[]
  params: URLSearchParams
}
