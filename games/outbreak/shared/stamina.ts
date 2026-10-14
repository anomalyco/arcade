export type StaminaTuning = {
  walkSpeed: number
  sprintSpeed: number
  staminaDrain: number
  staminaRegen: number
  staminaDelay: number
  staminaThreshold: number
}

export const DEFAULT_STAMINA_TUNING: StaminaTuning = {
  walkSpeed: 3.4,
  sprintSpeed: 5.6,
  staminaDrain: 0.28,
  staminaRegen: 0.22,
  staminaDelay: 0.9,
  staminaThreshold: 0.35,
}

export const IDLE_NOISE = 1.2
export const WALK_NOISE = 4.0
export const SPRINT_NOISE = 12.0
export const DOOR_NOISE = 5.5
export const VAULT_NOISE = 14.0
export const NOISE_DECAY = 10.0

/** Live simulation tunable descriptors exposed in the shared Lab panel. */
export const staminaControls = [
  { key: "walkSpeed", label: "Walk speed", group: "Stamina", min: 1.5, max: 5.0, step: 0.1, unit: "m/s" },
  { key: "sprintSpeed", label: "Sprint speed", group: "Stamina", min: 3.5, max: 8.0, step: 0.1, unit: "m/s" },
  { key: "staminaDrain", label: "Sprint drain", group: "Stamina", min: 0.05, max: 1.0, step: 0.01, unit: "/s" },
  { key: "staminaRegen", label: "Stamina regen", group: "Stamina", min: 0.05, max: 1.0, step: 0.01, unit: "/s" },
  { key: "staminaDelay", label: "Regen delay", group: "Stamina", min: 0.0, max: 3.0, step: 0.05, unit: "s" },
  { key: "staminaThreshold", label: "Recovery threshold", group: "Stamina", min: 0.1, max: 0.9, step: 0.05, unit: "" },
] as const

export type StaminaState = {
  stamina: number
  exhausted: boolean
  sprinting: boolean
  regenCooldown: number
  noise: number
}

export function createStaminaState(): StaminaState {
  return {
    stamina: 1,
    exhausted: false,
    sprinting: false,
    regenCooldown: 0,
    noise: IDLE_NOISE,
  }
}

/**
 * Advances stamina drain, recovery delay, exhaustion latch, and acoustic/awareness noise radius for one step.
 * Returns the authoritative travel speed (m/s) for this step.
 */
export function stepStamina(
  state: StaminaState,
  moving: boolean,
  wantsSprint: boolean,
  dt: number,
  tuning: StaminaTuning = DEFAULT_STAMINA_TUNING,
): number {
  const canSprint = moving && wantsSprint && !state.exhausted && state.stamina > 0
  if (canSprint) {
    state.sprinting = true
    state.stamina = Math.max(0, state.stamina - tuning.staminaDrain * dt)
    state.regenCooldown = tuning.staminaDelay
    if (state.stamina <= 1e-6) {
      state.stamina = 0
      state.exhausted = true
      state.sprinting = false
    }
  } else {
    state.sprinting = false
    if (state.regenCooldown > 0) {
      state.regenCooldown = Math.max(0, state.regenCooldown - dt)
    }
    if (state.regenCooldown <= 0 && state.stamina < 1) {
      state.stamina = Math.min(1, state.stamina + tuning.staminaRegen * dt)
      if (state.exhausted && state.stamina + 1e-6 >= tuning.staminaThreshold) {
        state.exhausted = false
      }
    }
  }

  const baseNoise = state.sprinting
    ? SPRINT_NOISE * (tuning.sprintSpeed / DEFAULT_STAMINA_TUNING.sprintSpeed)
    : moving
      ? WALK_NOISE * (tuning.walkSpeed / DEFAULT_STAMINA_TUNING.walkSpeed)
      : IDLE_NOISE
  state.noise = Math.max(baseNoise, state.noise - NOISE_DECAY * dt)

  return state.sprinting ? tuning.sprintSpeed : tuning.walkSpeed
}
