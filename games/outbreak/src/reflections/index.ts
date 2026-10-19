import { registerOutbreakClientFeature } from "../feature-registry"
import { MirrorPresenter } from "./mirror"
import { mirrorsShown } from "./settings"

/**
 * Reflections (Look › Reflections): the lights' images in puddles and wet paving are shaded in the scene shader
 * (`wgsl.ts`, settings packed with the lighting uniforms; the Lab group is part of the look's controls); this feature
 * draws the houses' mirrors (`mirror.ts`), placed with the interior dressing (`emitInteriorDecor`).
 */
let mirrors: MirrorPresenter | null = null

export const outbreakReflectionsFeature = registerOutbreakClientFeature({
  id: "reflections",
  order: 16,
  frame: {
    batches: (ctx) => {
      mirrors ??= new MirrorPresenter(ctx.renderer)
      return mirrors.collect(ctx.session.view.town, ctx.cam.groundRect(2.0), mirrorsShown(ctx.settings.look))
    },
  },
  harnessMethods: (host) => ({
    /** Every mirror in the current town (start house first), for proofs and stills. */
    mirrors() {
      const presenter = (mirrors ??= new MirrorPresenter(host.renderer))
      return [...presenter.mirrors(host.session().view.town)].sort((a, b) => Number(b.start) - Number(a.start))
    },
  }),
  harnessState: () => ({
    reflections: { mirrorsDrawn: mirrors ? mirrors.drawn.map((m) => ({ ...m })) : [] },
  }),
})
