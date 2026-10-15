import { MAT } from "@arcade/kit/gpu/mesh"
import { outbreakVignetteSection } from "../../../outbreak/src/vignette"
import { stylePlaygroundSection } from "../styles/section"
import type { LabGameModule } from "./registry"

export default {
  sections: [outbreakVignetteSection, stylePlaygroundSection],
  materials: [{ game: "Outbreak", codes: MAT }],
} satisfies LabGameModule
