import { Anatomy } from "../kit/anatomy"
import { bakeCreature } from "../kit/bake"
import type { CreatureData } from "../kit/format"
import { buildBody, buildHair, buildShroud, buildSkeleton, hairDangle, paintBody, paintHair, paintShroud, shroudDangle } from "./anatomy"

// Generates the Banshee from scratch (pure TypeScript). The game loads the cached result from
// public/models/monsters/banshee.bin, written by `bun scripts/creatures/bake.ts banshee`.
// Material slots: 0 body (skin, teeth, claws), 1 hair, 2 shroud.

export function generateBanshee(log: (s: string) => void = () => {}): CreatureData {
  const an = new Anatomy(1847)
  buildSkeleton(an)
  buildBody(an)
  const hair = buildHair(an)
  const shroud = buildShroud(an)
  log(`shapes: body ${an.model.shapes.length}, hair ${hair.shapes.length}, shroud ${shroud.shapes.length}; bones ${an.skel.bones.length}`)
  return bakeCreature(
    an.skel.bones,
    [
      { name: "body", model: an.model, h: 0.0028, budget: 60000, sigma: 0.012, paint: (p) => paintBody(p), thin: 0.6 },
      { name: "hair", model: hair, h: 0.003, budget: 40000, smooth: 1, sigma: 0.06, thin: 0, material: 1, paint: (p) => paintHair(p), dangle: hairDangle },
      { name: "shroud", model: shroud, h: 0.0034, budget: 34000, smooth: 1, sigma: 0.05, thin: 0.5, material: 2, paint: (p) => paintShroud(p), dangle: shroudDangle },
    ],
    log,
  )
}
