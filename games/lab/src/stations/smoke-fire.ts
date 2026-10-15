import { gridVariants } from "@arcade/kit/lab/overworld/types"
import { defineStation } from "./define"

export default defineStation({
  id: "smoke-fire",
  title: "Smoke & fire",
  summary: "Volumetric grenade smoke, tyre smoke and fire from the shared FX kit, with wind, rise and density you can scrub live.",
  order: 20,
  prop: "smoke",
  color: 0x9aa3ad,
  status: "live",
  demo: {
    kind: "section",
    section: "effects",
    setup: [
      { command: "scene.set-param", args: { key: "effect", value: "smoke" } },
      { command: "effect.trigger", args: { seed: 7 } },
    ],
  },
  defaultVariant: "standard-smoke",
  variants: [
    ...gridVariants("smoke"),
    { id: "fire", label: "Fire", setup: [{ command: "scene.set-param", args: { key: "effect", value: "fire" } }, { command: "effect.trigger", args: { seed: 7 } }] },
    { id: "tyre", label: "Tyre smoke", setup: [{ command: "scene.set-param", args: { key: "effect", value: "tyre" } }, { command: "effect.trigger", args: { seed: 7 } }] },
  ],
  grid: "smoke",
  board: { feature: "AR-15" },
  paths: ["packages/kit/fx/volume.ts", "packages/kit/fx/smoke-trail.ts", "packages/kit/fx/particles.ts"],
  branches: ["smoke-*"],
})
