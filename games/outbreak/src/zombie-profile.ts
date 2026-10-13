import type { LabControl } from "@arcade/kit/lab-panel"
import { clamp } from "@arcade/kit/rig"
import { humanProfiles, type HumanProfile } from "@arcade/kit/human-profile"

/** Art direction only: an uneven approach, trailing chest/head, dragged foot and reaching hands. */
export const zombieTuning = { zombieLurch: .8, zombieAsymmetry: .8, zombieDrag: .85, zombieReach: .7 }
export type ZombieTuning = typeof zombieTuning

/** Presentation-only controls, shared by the terrain adapter and the Lab. */
export const zombieControls: LabControl[] = [
  { key: "zombieLurch", label: "Lurch", group: "Zombie", min: 0, max: 1, step: .05 },
  { key: "zombieAsymmetry", label: "Asymmetry", group: "Zombie", min: 0, max: 1, step: .05 },
  { key: "zombieDrag", label: "Foot drag", group: "Zombie", min: 0, max: 1, step: .05 },
  { key: "zombieReach", label: "Reach", group: "Zombie", min: 0, max: 1, step: .05 },
]

/**
 * Overrides for the canonical zombie preset.
 * Rebuild on Lab changes, not each frame. The common rig owns contacts, IK and springs;
 * this adapter only maps Outbreak's art controls into its existing profile vocabulary.
 */
export function zombieProfileOverrides(tuning: ZombieTuning) {
  const lurch = clamp(tuning.zombieLurch, 0, 1)
  const asymmetry = clamp(tuning.zombieAsymmetry, 0, 1)
  const drag = clamp(tuning.zombieDrag, 0, 1)
  const reach = clamp(tuning.zombieReach, 0, 1)
  return {
    strideScale: .94 - .24 * lurch,
    torsoLean: .05 + .24 * lurch,
    chestHz: 5 - 3 * lurch,
    headHz: 7 - 5.8 * lurch,
    timingBias: .28 * asymmetry,
    torsoRoll: .12 * asymmetry,
    headTilt: .2 * asymmetry,
    armAsymmetry: .13 * asymmetry,
    footDrag: .95 * drag,
    armReach: .2 + .32 * reach,
    handPose: "reach" as const,
  }
}

export function zombieProfile(tuning: ZombieTuning): HumanProfile {
  return { ...humanProfiles.zombie, ...zombieProfileOverrides(tuning) }
}
