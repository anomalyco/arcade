import type { LabControl } from "@arcade/kit/lab-panel"
import { clamp } from "@arcade/kit/rig"
import { humanProfiles, type HumanProfile } from "@arcade/kit/human-profile"
import { resolveZombieVariant, type ZombieVariant } from "@arcade/kit/shamble-crouch"

/** Art direction only: an uneven approach, trailing chest/head, dragged foot, reaching hands and variant archetype. */
export const zombieTuning = {
  zombieVariant: 0,
  zombieLurch: .8,
  zombieAsymmetry: .8,
  zombieDrag: .85,
  zombieReach: .7,
}
export type ZombieTuning = typeof zombieTuning
export type ZombieTuningInput = Pick<
  ZombieTuning,
  "zombieLurch" | "zombieAsymmetry" | "zombieDrag" | "zombieReach"
> &
  Partial<Pick<ZombieTuning, "zombieVariant">>

/** Presentation-only live controls, shared by the terrain adapter and the Lab. */
export const zombieControls: LabControl[] = [
  {
    key: "zombieVariant",
    label: "Variant",
    group: "Zombie",
    options: [
      { label: "Auto (crowd mix)", value: 0 },
      { label: "Limper", value: 1 },
      { label: "Dragger", value: 2 },
      { label: "Reacher", value: 3 },
      { label: "Fast lunger", value: 4 },
    ],
  },
  { key: "zombieLurch", label: "Lurch", group: "Zombie", min: 0, max: 1, step: .05, unit: "" },
  { key: "zombieAsymmetry", label: "Asymmetry", group: "Zombie", min: 0, max: 1, step: .05, unit: "" },
  { key: "zombieDrag", label: "Foot drag", group: "Zombie", min: 0, max: 1, step: .05, unit: "" },
  { key: "zombieReach", label: "Reach", group: "Zombie", min: 0, max: 1, step: .05, unit: "" },
]

const VARIANT_MAP: Record<number, ZombieVariant> = {
  0: "auto",
  1: "limper",
  2: "dragger",
  3: "reacher",
  4: "lunger",
}

/**
 * Overrides for the canonical zombie preset.
 * Rebuild on Lab changes, not each frame. The common rig owns contacts, IK and springs;
 * this adapter only maps Outbreak's art controls into its existing profile vocabulary.
 */
export function zombieProfileOverrides(tuning: ZombieTuningInput) {
  const lurch = clamp(tuning.zombieLurch, 0, 1)
  const asymmetry = clamp(tuning.zombieAsymmetry, 0, 1)
  const drag = clamp(tuning.zombieDrag, 0, 1)
  const reach = clamp(tuning.zombieReach, 0, 1)
  const variantCode = Math.round(clamp(tuning.zombieVariant ?? 0, 0, 4))
  const zombieVariant = VARIANT_MAP[variantCode] ?? "auto"
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
    ...(variantCode > 0 ? { zombieVariant } : {}),
  }
}

export function zombieProfile(tuning: ZombieTuningInput, seed = 0, out?: HumanProfile): HumanProfile {
  const lurch = clamp(tuning.zombieLurch, 0, 1)
  const asymmetry = clamp(tuning.zombieAsymmetry, 0, 1)
  const drag = clamp(tuning.zombieDrag, 0, 1)
  const reach = clamp(tuning.zombieReach, 0, 1)
  const variantCode = Math.round(clamp(tuning.zombieVariant ?? 0, 0, 4))
  const zombieVariant = VARIANT_MAP[variantCode] ?? "auto"
  const base: HumanProfile = out ? Object.assign(out, humanProfiles.zombie) : { ...humanProfiles.zombie }
  base.strideScale = .94 - .24 * lurch
  base.torsoLean = .05 + .24 * lurch
  base.chestHz = 5 - 3 * lurch
  base.headHz = 7 - 5.8 * lurch
  base.timingBias = .28 * asymmetry
  base.torsoRoll = .12 * asymmetry
  base.headTilt = .2 * asymmetry
  base.armAsymmetry = .13 * asymmetry
  base.footDrag = .95 * drag
  base.armReach = .2 + .32 * reach
  base.handPose = "reach"
  if (variantCode > 0) base.zombieVariant = zombieVariant
  if (variantCode > 0 || seed !== 0) {
    const resolved = resolveZombieVariant(VARIANT_MAP[variantCode], seed)
    base.zombieVariant = resolved
    if (variantCode === 1) {
      // Limper: stronger timing bias, deeper hip drop & cant
      base.timingBias = clamp(base.timingBias * 1.12, -0.3, 0.3)
      base.hipDrop = clamp(base.hipDrop * 1.25, 0, 0.22)
      base.torsoRoll = clamp(base.torsoRoll * 1.3, -0.2, 0.2)
    } else if (variantCode === 2) {
      // Dragger: heavier foot drag and deeper hunch
      base.footDrag = clamp(Math.max(base.footDrag, 0.88), 0, 0.95)
      base.torsoLean = clamp(base.torsoLean * 1.18, -0.15, 0.35)
    } else if (variantCode === 3) {
      // Reacher: extended asymmetric reach
      base.armReach = clamp(base.armReach + 0.06, 0.2, 0.52)
      base.armAsymmetry = clamp(base.armAsymmetry * 1.25, -0.18, 0.18)
    } else if (variantCode === 4) {
      // Fast lunger: longer aggressive lurch stride and faster upper-body snap
      base.strideScale = clamp(base.strideScale * 1.12, 0.6, 1.4)
      base.torsoLean = clamp(base.torsoLean * 1.22, -0.15, 0.35)
      base.bobScale = clamp(base.bobScale * 1.2, 0, 2)
    }
  }
  return base
}
