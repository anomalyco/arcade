import type { Body, Input } from "../../shared/sim/vehicle"

/** Input-driven, seeded capture routes. Only initial pose is staged; effects use normal vehicle state. */
export type EmissionStudy = "drift" | "burnout" | "nitro" | "pops" | "cold"
export function startEmissionStudy(body: Body, study: EmissionStudy) {
  const drift = study === "drift", speed = drift ? 18 : study === "nitro" ? 25 : study === "pops" ? 18 : 0
  Object.assign(body, { x: drift ? 228 : 220, z: drift ? 192 : 228, h: drift ? 0 : Math.PI / 2,
    vx: drift ? 0 : speed, vz: drift ? speed : 0, yaw: 0, drift: 0, slip: 0 })
}
export function emissionInput(study: EmissionStudy, frame: number, body: Body, input: Input) {
  input.throttle = 1; input.brake = 0; input.handbrake = false; input.boost = false
  const target = study === "drift" && frame < 16 ? 0 : Math.PI / 2
  input.steer = Math.max(-1, Math.min(1, (target - body.h) * 1.8 - body.yaw * 0.45))
  if (study === "drift") { input.handbrake = frame >= 16 && frame < 65; if (frame >= 100) input.throttle = 0 }
  if (study === "burnout") { input.brake = frame < 80 ? 1 : 0; if (frame >= 140) input.throttle = 0 }
  if (study === "nitro") input.boost = frame >= 10 && frame < 85
  if (study === "pops") input.throttle = frame < 100 ? 1 : 0
  if (study === "cold") { input.throttle = 0; input.steer = 0 }
}
