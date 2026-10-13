/** Presentation coordinates: +Y up, local +Z forward, +X right; yaw 0 faces +Z.
 * Games adapt their interpolated state here. Nothing in this package writes simulation state. */
export type VehicleView = {
  id: number; vehicle: string; x: number; z: number; h: number; vx: number; vz: number
  speed: number; drift: number; impact: number; stun: number; boost: number
  y?: number; vy?: number; airborne?: boolean; landings?: number; landing?: number
  braking?: boolean; boosting?: boolean; wheels?: number; engineOff?: boolean
}
export type Controls = { throttle: number; brake: number; steer: number; handbrake: boolean; boost: boolean }
export type LampMounts = { frontX: number; frontY: number; rearX: number; rearY: number; frontZ?: number; rearZ?: number }
export type VehicleSpec = {
  id: string; width: number; length: number; mass: number; accel: number; grip: number; boost: number
  drivetrain?: "fwd" | "rwd" | "awd"
  lamps?: LampMounts
  /** Optional authored wheel contacts, front-left/front-right/rear-left/rear-right. */
  wheels?: readonly { x: number; z: number }[]
  /** Minimum lift-off speed for lower-speed vehicles; defaults to 12 m/s. */
  popSpeed?: number
}
export type GroundHeight = (x: number, z: number) => number
export type SkidSink = { skidSegment(ax: number, az: number, bx: number, bz: number, alpha: number, y?: number): void }
export type SpriteSink = (list: "a" | "d", x: number, y: number, z: number, size: number, r: number, g: number, b: number, alpha: number, kind: number, rotation?: number, stretch?: number, extra?: number) => void
export type LightSink = (x: number, y: number, z: number, radius: number, r: number, g: number, b: number, intensity: number, dx?: number, dy?: number, dz?: number, cone?: number) => void
/** Context and clock also support OfflineAudioContext; the game owns unlock, mute and spatial buses. */
export type AudioBus = { readonly ctx: BaseAudioContext | null; readonly now: number; sfx: AudioNode; verb: AudioNode }
