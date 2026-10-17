import { clampSurvivorVariant, type SurvivorVariant } from "../../shared/loadout"
import { SURVIVOR_COLOURS } from "../seat-colours"

export type SurvivorLookSpec = {
  readonly variant: SurvivorVariant
  readonly id: string
  readonly name: string
  readonly role: string
  readonly detail: string
  readonly torso: number
  readonly legs: number
  readonly css: string
}

// Plug in SURVIVORS from "../look/survivors" once the co-op character-looks PR (AR-42) lands.
export const SURVIVORS: readonly SurvivorLookSpec[] = [
  {
    variant: 0,
    id: "cole",
    name: "Cole",
    role: "Watchman",
    detail: "Tan field jacket & slate denim",
    torso: SURVIVOR_COLOURS[0]!.torso,
    legs: SURVIVOR_COLOURS[0]!.legs,
    css: SURVIVOR_COLOURS[0]!.css,
  },
  {
    variant: 1,
    id: "maya",
    name: "Maya",
    role: "Paramedic",
    detail: "Harbour blue coat & charcoal trousers",
    torso: SURVIVOR_COLOURS[1]!.torso,
    legs: SURVIVOR_COLOURS[1]!.legs,
    css: SURVIVOR_COLOURS[1]!.css,
  },
  {
    variant: 2,
    id: "reyes",
    name: "Reyes",
    role: "Lineworker",
    detail: "Oxblood canvas & workwear",
    torso: SURVIVOR_COLOURS[2]!.torso,
    legs: SURVIVOR_COLOURS[2]!.legs,
    css: SURVIVOR_COLOURS[2]!.css,
  },
  {
    variant: 3,
    id: "lin",
    name: "Lin",
    role: "Courier",
    detail: "Pine windbreaker & olive cargo",
    torso: SURVIVOR_COLOURS[3]!.torso,
    legs: SURVIVOR_COLOURS[3]!.legs,
    css: SURVIVOR_COLOURS[3]!.css,
  },
] as const

export function survivorSpec(variant: unknown): SurvivorLookSpec {
  return SURVIVORS[clampSurvivorVariant(variant, 0)]!
}
