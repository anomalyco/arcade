// Procedural Web Audio engine (owned by the Audio agent). Implementation lives in src/audio/.
import type { GameEvent, Vec3, VehicleEntity } from "./sim/types"

export interface GameAudio {
  /** Must be called from a user gesture before any sound plays. */
  unlock(): void
  /** Listener pose each frame (camera). forward/up are world-space unit vectors. */
  setListener(position: Vec3, forward: Vec3, up: Vec3): void
  /** Update continuous engine/rotor loops for all visible vehicles (call every frame). ownId = local player's vehicle. */
  updateVehicles(vehicles: VehicleEntity[], ownId: string | null): void
  /** One-shot sound for a game event, positioned in world space when position is known. */
  event(event: GameEvent, position: Vec3 | null, local: boolean): void
  /** UI sounds: click, hover, lock tone loop etc. */
  ui(name: "click" | "hover" | "confirm" | "error" | "lock-tone" | "locked" | "warning"): void
  setMuted(muted: boolean): void
  setVolume(volume: number): void
  dispose(): void
}

export { createAudio } from "./audio/engine"
export type { AudioStats, GameAudioEngine } from "./audio/engine"
