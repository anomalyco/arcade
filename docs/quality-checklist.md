# Quality checklist

For anything visual: a prop, creature, room, scene, light, look or effect. Work through the six steps in order; each
ends on checks you can answer yes or no. Kit judges against something real, so a build with no target can't be judged.
The `arcade-quality` skill runs this page; `arcade-props` and `arcade-lookdev` cover steps 2–3 and 1, 5, 6 in depth.

## 1. Target

- Is there a reference target before you build: a real photo, a reference Kit named, or a paint-over of a real
  capture? With no direction yet, the global `concept-art` skill makes distinct looks for Kit to pick; the global
  `paint-over` skill then paints over a real screenshot to make the target.
- Is the target saved with the work, and are the hero camera and exposure it will be compared at fixed?

## 2. Method for each asset

- Does every asset class have a method from [assets.md](assets.md#pick-the-right-method)? Scans for natural
  surfaces; the prop pipeline or a CC0 model for furniture and clutter; authored geometry (global `blender` skill) or a
  CC0/CC BY model for hard-surface heroes; MPFB people for characters; procedural vector graphics for maps and text.
- Plain `Mesh.box` geometry belongs to a toy that hasn't passed its feel test ([prototyping.md](prototyping.md)). Is
  every primitive in a shown build either finished (step 3) or labelled a toy?
- Licence: CC0 or credited CC BY, a `CREDITS.md` entry and a hashed source manifest ([assets.md](assets.md#rules))?

## 3. Finish pass

- Does every model have contact AO, bevels on hard edges, believable roughness and wear where hands and weather
  reach? Today: `Mesh.bevelBox`, Outbreak's vertex tone stamp (`stampOutbreakVertexTone`), the prop pipeline's Cycles
  AO. The shared finish pass is landing on `kit-finish`.
- Are albedos in range? Nothing near black or pure white unless it's metal or a light; kit vertex colours are sRGB and
  get linearised ([realism.md](realism.md#materials-and-wear)).
- Does every surface the camera gets close to use a scan or a footprint-filtered recipe rather than flat colour?
- Do held and inspected objects follow [close-up hero objects](assets.md#close-up-hero-objects)?

## 4. Shared kit effects

- Did you use the kit's version of every effect rather than a game copy: physical lights, torch beam, lens street
  lamps, flicker, spot/capsule/contact shadows, fog and mist, bounce, wet ground and SSR, glass and rooms, weather,
  night sky, highlight shoulder, TAA, quality tiers? [realism.md](realism.md) lists each with cost and what Kit picked
  per game. Landing: CRT display and screen light (`kit-crt`), baked lightmaps (`kit-lightmaps`), textured props
  (`kit-textured-props`).
- Is anything new in `packages/kit/` behind a typed Lab setting, with Today one setting away
  ([adding a technique](realism.md#adding-a-technique))?
- Does it follow [Kit's taste](realism.md#what-looks-best-kits-taste-so-far): colour only inside light, darkness
  stays dark, restraint, light from a visible source, stable before detailed?

## 5. Pre-flight gates

Run these before Kit sees anything; a round that fails one is not worth his time.

- Is the subject legible at game exposure, with no crushed or clipped frame and no near-camera slab? (Past misses:
  the invisible spider, the white rain-drip rectangle on a trunk.) Automated gates are landing on `quality-gates`.
- Is it stable in motion, checked with the game's motion script and not only stills
  ([temporal stability](realism.md#temporal-stability))?
- Is there an aligned capture at the target's camera and exposure, side by side with the target?
- Did captures run headless and muted inside the browser budget, following `browser_proofs_default` in
  [agent-state.md](agent-state.md)?

## 6. Show Kit

- Does Kit get Today and the candidate at the same moment, as paired stills on a board decision, or a Lab station
  for something he will come back to ([lab.md](lab.md#stations), [dev-control.md](dev-control.md#show-kit-things))?
- Is the technique recorded in [realism.md](realism.md) with its cost and Kit's decision, and the evidence in
  [research/](research/README.md)?
