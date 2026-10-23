---
name: arcade-props
description: Make 3D models for arcade games with the prop pipeline (image → TRELLIS.2 → Blender cleanup → finish → .prop or textured prop) or an authored or CC0 model. Use when adding or replacing furniture, clutter, a hero object, a creature body, a vehicle or room fixtures, or when a model looks blobby, boxy or flat.
---

# Arcade props

A model reaches the game by one of three routes. Pick the route first; the pipeline is wrong for anything held,
inspected or hard-surfaced up close.

| Route | Use for | How |
| --- | --- | --- |
| Prop pipeline | Furniture and clutter seen from a game camera | Below; `scripts/props/README.md` owns the commands |
| Authored geometry | Hard-surface heroes (CRT, phone, keypad), held objects | Global `blender` skill; `games/nightshift/scripts/author-hard-surface.py` is the worked example |
| Scanned or CC0/CC BY model | Natural props, anything a good model already exists for | [docs/assets.md](../../../docs/assets.md#sources-arcade-already-uses) sources, licence rules and manifest |

Creatures and rooms: see the method rows in [docs/assets.md](../../../docs/assets.md#pick-the-right-method).

## Prop pipeline

1. **Source image.** `scripts/props/source-images.ts` makes one product shot per prop with `gpt-image-2`, prompts in
   `scripts/props/sources.ts`. Chunky silhouettes survive; flaps, fronds, levers and thin panels shred. Resolve the
   OpenAI key locally with `2password run` and pipe it over (the README has the line). Done when each prop has a clean
   shot in the work folder.
2. **Catalogue entry.** Add the prop to `packages/kit/props/catalogue.ts` with its real size in metres, placement and
   LOD budgets. Done when the size is a measured real-world size, not a guess.
3. **TRELLIS.2 and Blender cleanup.** `bun scripts/props/generate.ts --ids <ids>` runs both on `mini` (never Studio;
   `--worker pro` is the fallback). Done when `<work>/report.json` lists no failure and the three preview renders read
   as the object.
4. **Finish.** The default cleanup bakes Cycles AO and vertex colour. For textured props use
   `generate.ts --textured`: normalised UV islands, high-to-low normal/AO/ORM/base transfer and lossless WebP GLB,
   with maps sized for 256 texels/m (don't pin `--texture-size` without a reason;
   [commands and limits](../../../scripts/props/README.md#textured-props)). Check the source albedo for embedded
   lighting; the transfer preserves it. In the game, give `TexturedPropBatches` the game's own `SceneHookVariants`
   (every look mode, `postLightMaterial` included) and call `setLook` with the vertex props' `PropLook`. Done when
   the report has no failures and vertex and textured stills match in exposure in each look mode
   (`scripts/props/textured-proof.ts`). Code-built props can also go through the shared finish pass
   (`@arcade/kit/gpu/finish`: chamfers, baked AO/curvature/exposure, wear looks; no game uses it yet, see
   `docs/realism.md` for its triangle cost); `bun scripts/finish-prop.ts` reports albedo range and AO for `.prop` files.
5. **Check.** `bun test props/` in `packages/kit` (two LODs, floor pivot, size, triangle budget). Then look at it in
   the Lab's `props` station (`bun run arcade station props`) and at the game's own camera, beside its target. Done
   when the tests pass and the in-game still holds up next to the target.
6. **Credit.** Record the source and licence in the game's `CREDITS.md`
   ([licence of generated output](../../../docs/assets.md#licence-of-generated-output)).

Then continue with the quality checklist's finish and pre-flight steps
([docs/quality-checklist.md](../../../docs/quality-checklist.md)).
