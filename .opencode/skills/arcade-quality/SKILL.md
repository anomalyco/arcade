---
name: arcade-quality
description: Quality workflow for anything visual in arcade. Use before building or changing a prop, model, creature, character look, room, interior, building, vehicle, scene, light, material, camera look or effect, and before showing Kit any visual result.
---

# Arcade quality

Kit judges a build against something real. The rounds that disappointed him had the same causes: no target
image, hand-built primitives shown as finished models, an effect rebuilt in a game instead of taken from the kit, and
a frame he could have been spared (an invisible subject, a white slab at the lens). This skill runs
[docs/quality-checklist.md](../../../docs/quality-checklist.md), which owns the checks.

## Steps

1. **Target.** Load `arcade-lookdev` and get a target image before writing geometry or shaders. Done when the target
   is saved with the work and the hero camera and exposure are fixed.
2. **Method and models.** Pick a method per asset class from the checklist's step 2. For any model (furniture,
   clutter, hero object, creature body, room fixture) load `arcade-props`. For character motion load
   `procedural-animation-iteration`. Done when every asset class has a named method and licence.
3. **Build on the kit.** Take each effect from [docs/realism.md](../../../docs/realism.md); a missing one goes in
   `packages/kit/` behind a typed Lab setting with Today one setting away. Done when no game file reimplements a kit
   effect.
4. **Finish.** Run the checklist's step 3 on every model. Done when no primitive in the shown build is unfinished
   or unlabelled.
5. **Pre-flight.** Run the checklist's step 5. Done when every check is yes, or a failing check is written down with
   its reason for Kit.
6. **Show and record.** Follow `arcade-lookdev`'s showing steps, then record the technique and Kit's decision in
   `docs/realism.md` and the evidence in `docs/research/`.

Motion and feel get the global `kit-motion` skill; HUD, menus and other interface polish get the global `puckett`
skill.
