import type { VehicleSpec as Vehicle, VehicleView, GroundHeight, SpriteSink, LightSink, LampMounts } from "./types"
import { bodyPoint, type BodyPose } from "./body-pose"

/** 0 is the original reference; 4 is the tunable default. */
import { vehicleEffectSettings } from "./effect-settings"
export type LightStyle = 0 | 1 | 2 | 3 | 4
/** Automation override. Players choose styles in the Lab. */
export function lightStyle(params: URLSearchParams): LightStyle {
  if (!params.has("bench") && !params.has("mux")) return 4
  const n = Number(params.get("lights") ?? 4)
  return n === 0 || n === 1 || n === 2 || n === 3 ? n : 4
}

/** Shared by the emissive lens, spotlight, beam, road pool and flare. */
export const HEADLIGHT: [number, number, number] = [1, 0.93, 0.78]
export const LIGHT_DEFAULTS = {
  beamLength: 12,
  beamWidth: 0.28,
  beamSpread: 2.4,
  beamIntensity: 0.13,
  poolSize: 3.4,
  poolIntensity: 0.04,
  poolAhead: 5,
  glowSize: 0.32,
  glowIntensity: 0.85,
  flareStrength: 0.09,
  tailGlow: 2,
  brakeIntensity: 1.9,
}
export type LightSettings = typeof LIGHT_DEFAULTS & { style: LightStyle }

/** Lens centres match the front/rear fascia geometry (local +z is forward). */
export function lampMounts(v: Vehicle): LampMounts {
  if (v.lamps) return v.lamps
  const half = v.width / 2
  switch (v.id) {
    case "muscle": return { frontX: half - 0.32, frontY: 0.5, rearX: half - 0.33, rearY: 0.66 }
    case "cruiser": return { frontX: half - 0.37, frontY: 0.56, rearX: half - 0.35, rearY: 0.65 }
    case "interceptor": return { frontX: half - 0.38, frontY: 0.5, rearX: half - 0.37, rearY: 0.64 }
    case "compact": return { frontX: half - 0.31, frontY: 0.52, rearX: half - 0.23, rearY: 0.8 }
    case "van": return { frontX: half - 0.32, frontY: 0.58, rearX: half - 0.13, rearY: 1 }
    case "swat": return { frontX: half - 0.31, frontY: 0.8, rearX: half - 0.16, rearY: 1 }
    default: return { frontX: 0, frontY: 0.9, rearX: 0, rearY: 0.9 }
  }
}

/** The renderer supplies sinks; sprite kinds are documented in README.md. */
export function drawLamps(c: VehicleView, pose: BodyPose, spec: Vehicle, settings: LightSettings, braking: number,
  ground: number, clearance: number, eye: ArrayLike<number>, groundAt: GroundHeight, sprite: SpriteSink, light: LightSink) {
  const half = spec.length / 2, altitude = c.y ?? 0
  const normalizeV = (v: number[]): [number, number, number] => {
    const l = Math.hypot(v[0]!, v[1]!, v[2]!)
    return [v[0]! / l, v[1]! / l, v[2]! / l]
  }
  if (settings.style === 0) {
    const head = bodyPoint(c, pose, [0, 1.3, half + 0.5])
    const aim = bodyPoint(c, pose, [0, 1, half + 1.45])
    const dir = normalizeV([aim[0] - head[0], aim[1] - head[1], aim[2] - head[2]])
    light(...head, vehicleEffectSettings.headlights.radius, 1, 0.92, 0.78, vehicleEffectSettings.headlights.power, ...dir, 0.8)
    const hw = spec.width / 2 - 0.25
    for (const s of spec.id === "bike" ? [0] : [-1, 1]) {
      sprite("d", ...bodyPoint(c, pose, [hw * s, 0.75, half + 0.1]), 0.55, 1, 0.95, 0.85, 1.4, 0)
      sprite("d", ...bodyPoint(c, pose, [hw * s, 0.75, -(half + 0.05)]), braking ? 0.9 : 0.55, 1, 0.12, 0.08, braking ? 2.2 : 1.1, 0)
    }
    if (dir[1] < -0.03) {
      const reach = Math.min(18, Math.max(0, (head[1] - ground) / -dir[1]))
      const x = head[0] + dir[0] * reach, z = head[2] + dir[2] * reach
      sprite("d", x, groundAt(x, z) + 0.06, z, 2.6 + clearance * 0.65, 1, 0.9, 0.72, 0.1 / (1 + clearance * 0.12), 3, Math.atan2(dir[0], dir[2]), 2.2)
    }
    light(...bodyPoint(c, pose, [0, 0.9, -(half + 0.6)]), 7, 1, 0.1, 0.06, braking ? 3 : 1.2)
    return
  }
  const style = settings.style, tuned = style === 4, mount = lampMounts(spec), cool = style === 2
  const frontZ = mount.frontZ ?? half, rearZ = mount.rearZ ?? -half
  const green = tuned ? HEADLIGHT[1] : cool ? 0.94 : 0.84, blue = tuned ? HEADLIGHT[2] : cool ? 1 : 0.6
  const front = bodyPoint(c, pose, [0, mount.frontY, frontZ + 0.08])
  const drop = tuned ? mount.frontY / settings.poolAhead : 0.28
  const aim = bodyPoint(c, pose, [0, mount.frontY - drop, frontZ + 1.08])
  const dir = normalizeV([aim[0] - front[0], aim[1] - front[1], aim[2] - front[2]])
  const beamYaw = Math.atan2(dir[0], dir[2])
  const rearIntensity = tuned ? (braking ? settings.brakeIntensity : settings.tailGlow) : (braking ? 1.9 : 0.75)
  light(...front, tuned ? settings.beamLength + settings.poolSize * 2 : style === 3 ? 22 : 18, 1, green, blue, tuned ? settings.poolIntensity * 21 : 2.1, ...dir, 0.82)
  light(...bodyPoint(c, pose, [0, mount.rearY, rearZ - 0.28]), 4, 1, 0.055, 0.025, tuned ? rearIntensity * 0.9 : braking ? 1.8 : 0.65)
  light(...bodyPoint(c, pose, [0, mount.frontY + 0.5, frontZ + 0.16]), 1.8, 1, green, blue, 0.65)
  light(...bodyPoint(c, pose, [0, mount.rearY + 0.4, rearZ - 0.14]), 1.6, 1, 0.08, 0.035, tuned ? rearIntensity * 0.45 : braking ? 0.9 : 0.35)
  for (const s of spec.id === "bike" ? [0] : [-1, 1]) {
    const head = bodyPoint(c, pose, [mount.frontX * s, mount.frontY + 0.02, frontZ + 0.065])
    const tail = bodyPoint(c, pose, [mount.rearX * s, mount.rearY + 0.02, rearZ - 0.075])
    sprite("d", ...head, tuned ? settings.glowSize : 0.25, 1, green, blue, tuned ? settings.glowIntensity : 0.8, 15, c.h, 0.3)
    sprite("d", ...tail, 0.23, 1, 0.055, 0.02, rearIntensity, 15, c.h, 0.3)
    const reach = tuned ? settings.beamLength : style === 3 ? 12 : cool ? 10 : 8
    const spread = tuned ? settings.beamWidth + settings.beamSpread : cool ? 2.4 : 1.9
    const grounded = Math.max(0, 1 - altitude / 1.2)
    sprite("d", head[0], 0.035 + groundAt(head[0], head[2]), head[2], spread, 1, green, blue, (tuned ? settings.beamIntensity : style === 3 ? 0.15 : 0.11) * grounded, tuned ? 18 : 14, beamYaw, reach / spread, tuned ? settings.beamWidth / spread : 0)
    if (tuned) {
      const flat = Math.hypot(dir[0], dir[2]) || 1
      const exact = dir[1] < -0.01 ? ((head[1] - groundAt(head[0], head[2])) / -dir[1]) * flat : Infinity
      const distance = Math.min(settings.poolAhead * 1.15, Math.max(settings.poolAhead * 0.85, exact))
      const x = head[0] + (dir[0] / flat) * distance, z = head[2] + (dir[2] / flat) * distance
      sprite("d", x, groundAt(x, z) + 0.045, z, settings.poolSize, 1, green, blue, settings.poolIntensity * grounded, 19, beamYaw, 1.65)
      sprite("d", ...head, settings.glowSize, 1, green, blue, settings.glowIntensity * 0.24, 0)
    }
    if (style === 3 || tuned) {
      const toCam = Math.hypot(eye[0]! - head[0], eye[2]! - head[2]) || 1
      const facing = Math.max(0.15, ((eye[0]! - head[0]) * dir[0] + (eye[2]! - head[2]) * dir[2]) / toCam)
      sprite("d", ...head, tuned ? 0.65 : 0.85, 1, green, blue, (tuned ? settings.flareStrength : 0.18) * facing, 16, 0, 0.045)
      sprite("d", ...tail, braking ? 0.9 : 0.5, 1, 0.07, 0.03, tuned ? rearIntensity * 0.08 : braking ? 0.3 : 0.13, 16, 0, 0.05)
      if (style === 3 && braking && c.speed > 4) {
        const length = Math.min(2.5, c.speed * 0.07)
        sprite("d", ...tail, 0.08, 1, 0.04, 0.015, 0.32, 17, Math.atan2(-c.vx, -c.vz), length / 0.08)
      }
    }
  }
  if (style === 2 && spec.id !== "bike") sprite("d", ...bodyPoint(c, pose, [0, mount.rearY + 0.03, rearZ - 0.08]), spec.width * 0.42, 1, 0.045, 0.015, braking ? 1.25 : 0.55, 15, c.h, 0.045)
}
