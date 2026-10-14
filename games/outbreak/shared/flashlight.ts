import { angleDiff, clearLine, type Rect } from "@arcade/kit/sim/geom"

export type FlashlightTuning = {
  flashlightIntensity: number
  flashlightRange: number
  flashlightCone: number
  flashlightWarmth: number
  flashlightDrain: number
  flashlightRegen: number
  flashlightDelay: number
  flashlightFlicker: number
  flashlightRecovery: number
}

export const DEFAULT_FLASHLIGHT_TUNING: FlashlightTuning = {
  flashlightIntensity: 1.35,
  flashlightRange: 19,
  flashlightCone: 52,
  flashlightWarmth: 0.45,
  flashlightDrain: 0.07,
  flashlightRegen: 0.16,
  flashlightDelay: 1.2,
  flashlightFlicker: 0.28,
  flashlightRecovery: 0.3,
}

/** Live simulation and presentation tunable descriptors exposed in the shared Lab panel. */
export const flashlightControls = [
  { key: "flashlightIntensity", label: "Beam intensity", group: "Flashlight", min: 0, max: 3.0, step: 0.05, unit: "" },
  { key: "flashlightRange", label: "Beam range", group: "Flashlight", min: 6, max: 36, step: 0.5, unit: "m" },
  { key: "flashlightCone", label: "Beam cone", group: "Flashlight", min: 20, max: 110, step: 1, unit: "°" },
  { key: "flashlightWarmth", label: "Beam warmth", group: "Flashlight", min: 0, max: 1, step: 0.05, unit: "" },
  { key: "flashlightDrain", label: "Battery drain", group: "Flashlight", min: 0.01, max: 0.5, step: 0.01, unit: "/s" },
  { key: "flashlightRegen", label: "Battery regen", group: "Flashlight", min: 0.02, max: 0.6, step: 0.01, unit: "/s" },
  { key: "flashlightDelay", label: "Recharge delay", group: "Flashlight", min: 0, max: 4.0, step: 0.1, unit: "s" },
  { key: "flashlightFlicker", label: "Flicker threshold", group: "Flashlight", min: 0.05, max: 0.6, step: 0.05, unit: "" },
  { key: "flashlightRecovery", label: "Cutout recovery", group: "Flashlight", min: 0.1, max: 0.8, step: 0.05, unit: "" },
] as const

export type FlashlightState = {
  flashlightOn: boolean
  battery: number
  batteryDepleted: boolean
  batteryCooldown: number
  flashlightOutput: number
  lightSignature: number
}

export function createFlashlightState(initiallyOn = true): FlashlightState {
  return {
    flashlightOn: initiallyOn,
    battery: 1,
    batteryDepleted: false,
    batteryCooldown: 0,
    flashlightOutput: initiallyOn ? 1 : 0,
    lightSignature: initiallyOn ? DEFAULT_FLASHLIGHT_TUNING.flashlightRange : 0,
  }
}

/** Interpolates beam RGB from cool xenon (0) to warm halogen tungsten (1). */
export function flashlightColor(warmth: number): [number, number, number] {
  const w = Math.max(0, Math.min(1, warmth))
  return [
    Number((0.82 + 0.18 * w).toFixed(4)),
    Number((0.92 - 0.08 * w).toFixed(4)),
    Number((1.0 - 0.38 * w).toFixed(4)),
  ]
}

/** Deterministic low-battery dimming and multi-frequency sputter/dropout envelope. */
export function computeFlashlightOutput(
  on: boolean,
  battery: number,
  depleted: boolean,
  time: number,
  flickerThreshold: number,
): number {
  if (!on || depleted || battery <= 1e-6) return 0
  if (battery >= flickerThreshold) return 1
  const u = Math.max(0, Math.min(1, battery / Math.max(0.01, flickerThreshold)))
  const dim = 0.32 + 0.68 * u
  const wave =
    0.5 +
    0.25 * Math.sin(time * 37.0) +
    0.15 * Math.sin(time * 83.0 + 1.7) +
    0.1 * Math.cos(time * 149.0 + 0.6)
  const dropout = wave < (1 - u) * 0.58 ? 0.06 : 1.0
  return Number((dim * dropout * (0.72 + 0.28 * wave)).toFixed(4))
}

/** Toggles the flashlight switch if not locked out by a depleted battery. */
export function toggleFlashlight(state: FlashlightState): boolean {
  if (state.flashlightOn) {
    state.flashlightOn = false
    state.flashlightOutput = 0
    state.lightSignature = 0
    return true
  }
  if (state.batteryDepleted || state.battery <= 1e-6) {
    return false
  }
  state.flashlightOn = true
  return true
}

/**
 * Advances battery drain while on, recharge delay and regeneration while off,
 * low-battery flicker/dimming, and cutout latch at empty.
 */
export function stepFlashlight(
  state: FlashlightState,
  dt: number,
  time: number,
  tuning: FlashlightTuning = DEFAULT_FLASHLIGHT_TUNING,
): number {
  if (state.flashlightOn && !state.batteryDepleted && state.battery > 0) {
    state.battery = Math.max(0, state.battery - tuning.flashlightDrain * dt)
    state.batteryCooldown = tuning.flashlightDelay
    if (state.battery <= 1e-6) {
      state.battery = 0
      state.batteryDepleted = true
      state.flashlightOn = false
      state.flashlightOutput = 0
      state.lightSignature = 0
      state.batteryCooldown = Math.max(tuning.flashlightDelay * 1.5, 0.5)
      return 0
    }
    state.flashlightOutput = computeFlashlightOutput(
      true,
      state.battery,
      false,
      time,
      tuning.flashlightFlicker,
    )
    state.lightSignature = Number((state.flashlightOutput * tuning.flashlightRange).toFixed(3))
    return state.flashlightOutput
  }

  state.flashlightOn = false
  state.flashlightOutput = 0
  state.lightSignature = 0
  if (state.batteryCooldown > 0) {
    state.batteryCooldown = Math.max(0, state.batteryCooldown - dt)
  }
  if (state.batteryCooldown <= 0 && state.battery < 1) {
    state.battery = Math.min(1, state.battery + tuning.flashlightRegen * dt)
    if (state.batteryDepleted && state.battery + 1e-6 >= tuning.flashlightRecovery) {
      state.batteryDepleted = false
    }
  }
  return 0
}

/**
 * Authoritative zombie-awareness query: returns 0..1 for how strongly an observer/zombie at (targetX, targetY)
 * is illuminated by or aware of the survivor's flashlight beam, respecting wall/door occlusion.
 */
export function flashlightAwarenessAt(
  player: { x: number; y: number; aim: number } & FlashlightState,
  targetX: number,
  targetY: number,
  blockers: readonly Rect[],
  tuning: Pick<FlashlightTuning, "flashlightRange" | "flashlightCone"> = DEFAULT_FLASHLIGHT_TUNING,
): number {
  if (!player.flashlightOn || player.flashlightOutput <= 0.01) return 0
  const dx = targetX - player.x
  const dy = targetY - player.y
  const dist = Math.hypot(dx, dy)
  if (dist > tuning.flashlightRange) return 0
  if (dist > 0.05) {
    const toAngle = Math.atan2(dy, dx)
    const halfConeRad = (tuning.flashlightCone * Math.PI) / 360
    if (Math.abs(angleDiff(player.aim, toAngle)) > halfConeRad) return 0
  }
  if (!clearLine(player.x, player.y, targetX, targetY, blockers)) return 0
  const distFalloff = 1 - (dist / tuning.flashlightRange) * 0.5
  return Number((player.flashlightOutput * distFalloff).toFixed(4))
}
