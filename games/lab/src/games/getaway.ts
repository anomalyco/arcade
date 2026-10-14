import { MAT } from "../../../getaway/src/render/mesh"
import { getawayEffectSection } from "../../../getaway/src/lab/effects"
import type { LabGameModule } from "./registry"

export default {
  sections: [getawayEffectSection],
  materials: [{ game: "Getaway", codes: MAT }],
} satisfies LabGameModule
