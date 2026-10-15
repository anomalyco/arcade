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
  metrics: [
    { label: "Outbreak flashlight pool, luminance fall to 10% along the axis (street, 22:00)", value: "hard cut at 7 m → smooth to 7.8 m", source: "games/outbreak/scripts/noir-profile.py" },
    { label: "Outbreak flashlight width at 5 m (FWHM), paint-over target 28.5°", value: "30° flat-topped → 28.5° with core and spill", source: "games/outbreak/scripts/noir-profile.py" },
  ],
  paths: ["packages/kit/lab/lighting.ts", "packages/kit/lab/stage-shader.ts", "games/outbreak/src/lighting.ts", "games/outbreak/src/fog-of-war.ts"],
  branches: ["outbreak-lighting", "shadow-*", "noir-v2"],
  links: [
    { label: "Outbreak flashlight, Noir v2", href: "/arcade/outbreak/?peaceful=1&seed=7" },
  ],
})
