import { MAT } from "../../../blackout/src/render/mesh"
import { blackoutSpawn } from "../../../blackout/src/lab/spawn"
import { blackoutEffectSection } from "../../../blackout/src/lab/effects"
import { fireWaterSection } from "../../../blackout/src/lab/fire-water"
import { splatterSection } from "../../../blackout/src/lab/splatter"
import type { LabGameModule } from "./registry"

export default {
  sections: [blackoutEffectSection, fireWaterSection, splatterSection],
  materials: [{ game: "Blackout", codes: MAT }],
  characters: context => [blackoutSpawn(context)],
} satisfies LabGameModule
