import { gridVariants } from "@arcade/kit/lab/overworld/types"
import { defineStation } from "./define"

export default defineStation({
  id: "lighting",
  title: "Lighting & flashlight",
  summary: "Lamps, spotlights, moonlight and soft shadows on the lighting stage. The Outbreak station has the flashlight in its real lot.",
  order: 60,
  prop: "lamp",
  color: 0xffd36b,
  status: "live",
  demo: { kind: "section", section: "lighting" },
  variants: gridVariants("lighting"),
  grid: "lighting",
  board: { feature: "AR-12" },
  paths: ["packages/kit/lab/lighting.ts", "packages/kit/lab/stage-shader.ts"],
  branches: ["outbreak-lighting", "shadow-*"],
})
