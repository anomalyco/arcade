import { Anatomy } from "../kit/anatomy"
import { bakeCreature } from "../kit/bake"
import type { CreatureData } from "../kit/format"
import { buildBody, buildStrands, paintBody } from "./anatomy"
import { buildAntlers, paintAntler } from "./antlers"
import { buildSkull, paintSkull } from "./skull"

// Generates the Wendigo from scratch (pure TypeScript; ~10-20 s). The game loads the cached result from
// public/models/monsters/wendigo.bin, written by `bun scripts/creatures/bake.ts wendigo`.

export function generateWendigo(log: (s: string) => void = () => {}): CreatureData {
  const an = new Anatomy(1984)
  buildBody(an)
  const head = an.b("head")
  const jaw = an.b("jaw")
  const { skull, jaw: jawModel } = buildSkull(head, jaw)
  const antlers = buildAntlers(head)
  const strands = buildStrands(an)
  log(`shapes: body ${an.model.shapes.length}, skull ${skull.shapes.length}, jaw ${jawModel.shapes.length}, antlers ${antlers.shapes.length}, strands ${strands.shapes.length}; bones ${an.skel.bones.length}`)
  return bakeCreature(
    an.skel.bones,
    [
      { name: "body", model: an.model, h: 0.0042, budget: 70000, sigma: 0.016, paint: (p) => paintBody(p) },
      { name: "skull", model: skull, h: 0.0022, budget: 16000, rigidBone: head, paint: (p) => paintSkull(p), thin: 0 },
      { name: "jaw", model: jawModel, h: 0.0022, budget: 5000, rigidBone: jaw, paint: (p) => paintSkull(p), thin: 0 },
      { name: "antlers", model: antlers, h: 0.0028, budget: 24000, rigidBone: head, smooth: 2, thin: 0, paint: (p) => paintAntler(p) },
      { name: "strands", model: strands, h: 0.0024, budget: 24000, smooth: 1, sigma: 0.03, thin: 0, paint: (p) => paintBody(p) },
    ],
    log,
  )
}
