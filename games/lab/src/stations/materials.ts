import { gridVariants } from "@arcade/kit/lab/overworld/types"
import { defineStation } from "./define"

export default defineStation({
  id: "materials",
  title: "Materials",
  summary: "Generated surface recipes (wood, cobblestone, plaster, asphalt, grass, leaves) on calibration swatches under the Lab lights.",
  order: 70,
  prop: "swatches",
  color: 0xb08a5a,
  status: "review",
  demo: { kind: "section", section: "materials" },
  variants: gridVariants("materials"),
  grid: "materials",
  board: { feature: "AR-3" },
  paths: ["packages/kit/gpu/surface-materials.ts", "packages/kit/lab/materials.ts", "packages/kit/textures"],
  branches: ["materials", "generated-textures", "architecture-materials"],
})
