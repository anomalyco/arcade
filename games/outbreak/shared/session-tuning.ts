import { DEFAULT_MELEE_TUNING, type MeleeTuning } from "./combat"
import { outbreakSharedFeatures } from "./feature-registry"
import { DEFAULT_FLASHLIGHT_TUNING } from "./flashlight"
import type { NamespacedSessionTuning, ResolvedSessionTuning, SessionTuning } from "./sim-types"
import { DEFAULT_STAMINA_TUNING } from "./stamina"
import { DEFAULT_VEHICLE_TUNING, type VehicleTuning } from "./vehicles"

function isNamespacedSessionTuning(tuning: SessionTuning): tuning is NamespacedSessionTuning {
  return (
    "stamina" in tuning ||
    "flashlight" in tuning ||
    "ai" in tuning ||
    "vehicle" in tuning ||
    "combat" in tuning ||
    "melee" in tuning
  )
}

let cachedDefaultFeatureList: readonly unknown[] | null = null
let cachedDefaultResolved: ResolvedSessionTuning | null = null

export function resolveSessionTuning(tuning?: SessionTuning): ResolvedSessionTuning {
  const list = outbreakSharedFeatures.list()
  if (!tuning || tuning === DEFAULT_STAMINA_TUNING) {
    if (cachedDefaultResolved && cachedDefaultFeatureList === list) {
      return cachedDefaultResolved
    }
    const features = outbreakSharedFeatures.resolveTuningNamespaces(undefined)
    cachedDefaultFeatureList = list
    cachedDefaultResolved = {
      stamina: DEFAULT_STAMINA_TUNING,
      flashlight: DEFAULT_FLASHLIGHT_TUNING,
      ai: undefined,
      melee: (features.melee as MeleeTuning | undefined) ?? DEFAULT_MELEE_TUNING,
      vehicle: (features.vehicle as VehicleTuning | undefined) ?? DEFAULT_VEHICLE_TUNING,
      infiniteAmmo: false,
      features,
    }
    return cachedDefaultResolved
  }
  const features = outbreakSharedFeatures.resolveTuningNamespaces(
    tuning as Record<string, unknown> | undefined,
  )
  if (isNamespacedSessionTuning(tuning)) {
    const meleeOut = { ...DEFAULT_MELEE_TUNING }
    for (const src of [tuning.combat, tuning.melee]) {
      if (!src) continue
      for (const k of Object.keys(DEFAULT_MELEE_TUNING) as (keyof MeleeTuning)[]) {
        if (typeof src[k] === "number" && Number.isFinite(src[k])) {
          meleeOut[k] = src[k]!
        }
      }
    }
    return {
      stamina: tuning.stamina ? { ...DEFAULT_STAMINA_TUNING, ...tuning.stamina } : DEFAULT_STAMINA_TUNING,
      flashlight: tuning.flashlight ? { ...DEFAULT_FLASHLIGHT_TUNING, ...tuning.flashlight } : DEFAULT_FLASHLIGHT_TUNING,
      ai: tuning.ai,
      melee: (features.melee as MeleeTuning | undefined) ?? meleeOut,
      vehicle: (features.vehicle as VehicleTuning | undefined) ?? (tuning.vehicle ? { ...DEFAULT_VEHICLE_TUNING, ...tuning.vehicle } : DEFAULT_VEHICLE_TUNING),
      infiniteAmmo: Boolean(tuning.combat?.infiniteAmmo),
      features,
    }
  }
  const hasAiKeys =
    tuning.sightRange !== undefined ||
    tuning.sightCone !== undefined ||
    tuning.hearingScale !== undefined ||
    tuning.chaseSpeed !== undefined ||
    tuning.aggression !== undefined ||
    tuning.nightMultiplier !== undefined ||
    tuning.directorPacing !== undefined ||
    tuning.aiDebugOverlay !== undefined ||
    tuning.startHour !== undefined ||
    tuning.openingClock !== undefined ||
    tuning.openingCalm !== undefined ||
    tuning.safeRadius !== undefined ||
    tuning.initialDensity !== undefined ||
    tuning.rampTime !== undefined ||
    tuning.noiseSensitivity !== undefined ||
    tuning.maxActiveNearPlayer !== undefined
  return {
    stamina: { ...DEFAULT_STAMINA_TUNING, ...tuning },
    flashlight: { ...DEFAULT_FLASHLIGHT_TUNING, ...tuning },
    ai: hasAiKeys
      ? {
          sightRange: tuning.sightRange,
          sightCone: tuning.sightCone,
          hearingScale: tuning.hearingScale,
          chaseSpeed: tuning.chaseSpeed,
          aggression: tuning.aggression,
          nightMultiplier: tuning.nightMultiplier,
          directorPacing: tuning.directorPacing,
          aiDebugOverlay: tuning.aiDebugOverlay,
          startHour: tuning.startHour,
          openingClock: tuning.openingClock,
          openingCalm: tuning.openingCalm,
          safeRadius: tuning.safeRadius,
          initialDensity: tuning.initialDensity,
          rampTime: tuning.rampTime,
          noiseSensitivity: tuning.noiseSensitivity,
          maxActiveNearPlayer: tuning.maxActiveNearPlayer,
        }
      : undefined,
    melee: (features.melee as MeleeTuning | undefined) ?? { ...DEFAULT_MELEE_TUNING, ...tuning },
    vehicle: (features.vehicle as VehicleTuning | undefined) ?? { ...DEFAULT_VEHICLE_TUNING, ...tuning },
    infiniteAmmo: Boolean(tuning.infiniteAmmo),
    features,
  }
}
