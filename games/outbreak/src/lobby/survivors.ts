import { clampSurvivorVariant } from "../../shared/loadout"
import { SURVIVORS, type SurvivorVariantSpec } from "../look/survivors"

export type SurvivorLookSpec = SurvivorVariantSpec
export { SURVIVORS }

export function survivorSpec(variant: unknown): SurvivorLookSpec {
  return SURVIVORS[clampSurvivorVariant(variant, 0)]!
}
