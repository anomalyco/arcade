import type { LabControl } from "@arcade/kit/lab-panel"

/**
 * Combat oomph and body physics (AR-90), all presentation: the simulation never reads these. `impactStyle` 0 is
 * Today (every layer below off, the game exactly as it was); 1 turns the layers on at their own strengths.
 */
export const DEFAULT_IMPACT_SETTINGS = {
  /** 0 Today, 1 Physical. */
  impactStyle: 1,
  /** Directional hit reactions on the living: trunk rock, shoulder twist, head whip, knee buckle (× strength). */
  impactReactions: 1,
  /** How much of today's canned stagger pose stays under the directional reaction (0..1). */
  impactCannedStagger: 0.35,
  /** Deaths fall as ragdolls from the pose they died in (0 off). */
  impactRagdolls: 1,
  /** × the killing blow's push on the falling body. */
  impactDeathPush: 1,
  /** × how hard blasts and cars move bodies already down. */
  impactCorpsePush: 1,
  /** Ragdolls simulated at once; more than this and the oldest settles where it is. */
  impactMaxAwake: 12,
  /** Bodies remembered; past this the least recently seen goes back to the canned pose. */
  impactMaxBodies: 96,
  /** Spread of hit-stop and shake by weapon weight (0 = every weapon the same, 1 = knife light, fire axe heavy). */
  impactWeaponWeight: 1,
  /** Hit-stop on a bullet that hits without killing (ms). */
  impactShotHitStop: 14,
  /** Blast hit-stop (ms) at point blank, falling off with distance. */
  impactBlastHitStop: 46,
  /** × directional kick and punch from a blast, on top of Fire › Blast shake. */
  impactBlastKick: 1,
  /** × hit-stop and kick when your car hits one of the dead. */
  impactCarHit: 1,
}

export type OutbreakImpactSettings = typeof DEFAULT_IMPACT_SETTINGS

const FEEL = "Feel"
const PHYS = "Physics"

export const impactControls: readonly LabControl[] = [
  {
    key: "impactStyle",
    label: "Impact",
    group: FEEL,
    options: [
      { label: "Today", value: 0 },
      { label: "Physical", value: 1 },
    ],
  },
  { key: "impactWeaponWeight", label: "Weapon weight spread", group: FEEL, min: 0, max: 1.5, step: 0.05, unit: "×" },
  { key: "impactShotHitStop", label: "Hit-stop: bullet hit (impact)", group: FEEL, min: 0, max: 60, step: 2, unit: "ms" },
  { key: "impactBlastHitStop", label: "Hit-stop: blast", group: FEEL, min: 0, max: 120, step: 2, unit: "ms" },
  { key: "impactBlastKick", label: "Blast kick", group: FEEL, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "impactCarHit", label: "Car hit weight", group: FEEL, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "impactReactions", label: "Hit reactions", group: PHYS, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "impactCannedStagger", label: "Canned stagger kept", group: PHYS, min: 0, max: 1, step: 0.05, unit: "×" },
  {
    key: "impactRagdolls",
    label: "Ragdoll deaths",
    group: PHYS,
    options: [
      { label: "Off", value: 0 },
      { label: "On", value: 1 },
    ],
  },
  { key: "impactDeathPush", label: "Death push", group: PHYS, min: 0, max: 2.5, step: 0.05, unit: "×" },
  { key: "impactCorpsePush", label: "Bodies pushed by blasts and cars", group: PHYS, min: 0, max: 2.5, step: 0.05, unit: "×" },
  { key: "impactMaxAwake", label: "Ragdolls at once", group: PHYS, min: 1, max: 32, step: 1 },
  { key: "impactMaxBodies", label: "Bodies kept", group: PHYS, min: 8, max: 256, step: 8 },
]

/** Whether the Physical style is on (anything above Today). */
export const impactOn = (s: OutbreakImpactSettings) => s.impactStyle >= 1
