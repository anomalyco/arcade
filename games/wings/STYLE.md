# Art Style Guide

## CURRENT LOOK (locked, supersedes everything below): "STORMFRONT"
Reference image (the target): `art/concepts/s1-storm-chase.png`. Secondary: `art/concepts/s2-storm-carrier.png`.
Semi-realistic, cinematic, dark rainy storm at sea. Lighting and atmosphere carry the look.
- **Sky:** low, heavy, dark slate-green storm clouds (`#1e2a28`–`#3a4744`), layered and moving; brighter breaks near the horizon; occasional lightning that briefly lights clouds, sea and aircraft.
- **Light:** dim, cool, diffuse key from above (no hard sun), very low ambient; contrast comes from emissive sources: afterburners (warm `#ffb46a`), tracers, muzzle flashes, explosions, ship lights, AA bursts. Bloom on emissives is essential.
- **Ocean:** dark gray-green (`#1f2b2a`→`#2e3b38`), large rolling swells + chop, wind-driven foam/whitecaps, spray, specular sheen catching distant light, darker toward the horizon. Proper animated waves (GPU), not flat.
- **Atmosphere:** dense height + distance fog/mist that swallows the horizon (visibility ~3–6 km, closer near the surface), rain streaks (screen + world particles), rain on the camera optional, wet reflections on decks and aircraft.
- **Islands:** dark wet rock and deep green vegetation, emerging from mist; surf at the shores.
- **Aircraft & ships:** realistic matte military gray/olive, wet specular highlights, readable silhouettes against the brighter cloud breaks; team markings muted, but enemies must stay readable (HUD markers do the heavy lifting).
- **Effects:** fire and tracers are the brightest things on screen (warm orange/yellow), smoke dark and heavy, flak bursts with dark smoke, lightning flashes.
- **Post:** filmic tone mapping (ACES/AgX), bloom, subtle vignette, slight desaturation, light film grain, optional subtle motion blur at speed. No stylized color grading gimmicks.
- **Gameplay readability rules:** keep enough visibility to dogfight (fog tuned per altitude, cloud breaks), and never let rain obscure the HUD.

## RENDERER (locked): WebGPU first
- Three.js `WebGPURenderer` from `three/webgpu` (automatic WebGL2 fallback). All materials must be node materials (`MeshStandardNodeMaterial`, `MeshPhysicalNodeMaterial`, `MeshBasicNodeMaterial`, `SpriteNodeMaterial`, …) or TSL (`three/tsl`) — no GLSL `ShaderMaterial`/`onBeforeCompile`.
- Post-processing via the node `PostProcessing` pipeline (TSL passes: bloom, tone mapping, grain, vignette).
- Use GPU compute (TSL `compute`) where it helps: ocean wave displacement/normals, rain and spray particles, effects particles.
- Keep a quality preset system (Low/Balanced/High). Target 60 fps on a laptop with integrated GPU on Balanced.

## LOCKED PALETTE: Option B "Muted Tactical" (see art/stylesheets.html, option B) — overrides colors below
- World: sky `#8fb3cc`→`#dde6ea`, deep sea `#2f5d78`, shallows `#6fa6a8`, grass `#7f9a5a`, sand `#d4c39a`, rock `#7a746b`, trees `#4f6a3e`, cloud/foam `#eef1f2`, concrete `#a9aca8`, aircraft base olive `#5e6658` (per-aircraft variations within this muted family).
- Teams (muted): blue `#3c6ea8`, orange `#c98a2e`, green `#4e8a5a`, red `#b04a44`. Strong color only on team markings.
- Materials matte (roughness 0.65–0.8), soft shadows, almost no bloom. Combat effects (fire, tracers) are the brightest things on screen.
- UI: charcoal `#22262a` / off-white `#eceae4` / single accent safety orange `#ff7a2e`. Square corners, no pills, no glow, no gradients on buttons, no decorative elements.
- **Typography (locked): blend of options A + B in art/ui-type-2.html.** Two families only: **Archivo Narrow** (wordmark + headings + menu items) and **IBM Plex Mono** (numbers, indices, metadata, keys, HUD numerics).
  - Lowercase / sentence case everywhere; no all-caps shouting (mono metadata may use small caps-style uppercase at 11px with tracking, sparingly).
  - Wordmark: huge lowercase "wings", Archivo Narrow 700, tight tracking (-0.035em).
  - Menu: big stacked sentence-case items (Archivo Narrow 500, ~40px), no dividers, no boxes; A-style mono indices (01, 02…) in small Plex Mono; selected item = short orange rule + full-opacity text, others ~55% opacity. Small mono metadata lines under the selection. Key-hint footer in mono with outlined key caps.
  - Extreme scale contrast: tiny mono metadata (11–12px) vs large type.
  - No panels/cards over the world; legibility from a soft dark gradient on the menu side only.
  - HUD: Plex Mono numbers (no boxes behind them, soft text shadow), small lowercase Archivo Narrow labels/units, orange only for lock/warnings.
  - Fonts self-hosted (woff2, latin subset) from `public/fonts/`, `font-display: swap`, preloaded; first paint must stay instant.
- Smooth shading from "Bright Stylized" stays; only colors/materials change to this palette.

## CURRENT LOOK (locked, supersedes everything below): "BRIGHT STYLIZED" — Fortnite-like, tasteful, restrained
User feedback: previous looks were "vibing too hard" / "vibe coded". Goal: clean, polished, confident stylized realism like Fortnite. Less is more. No gimmicks.
- **Daylight:** clear sunny afternoon, sun ~40–50° elevation, white-warm key light, soft blue sky fill. Real soft shadows (shadow map) near the camera. Subtle ambient occlusion on High.
- **Sky:** clean blue gradient (deeper blue zenith → pale blue horizon), sun with a gentle glow, big soft white cumulus clouds with smooth shading (no faceted clouds, no pink/purple). **No Watcher moon, no aurora, no cosmic effects.**
- **Smooth shading everywhere** (no flat facets, no low-poly look, no ink outlines). Rounded, chunky stylized forms.
- **Terrain:** smooth-shaded hills with soft vertex-color gradients + subtle large-scale variation: lush saturated grass greens, warm sand beaches, gray-brown stylized rock on steep slopes, a little snow only on the highest peak. Natural, not terraced. Stylized round-canopy trees, smooth shaded, in clusters.
- **Water:** bright stylized ocean: turquoise shallows → clear blue → deep blue, clean specular sun highlight, soft fresnel, gentle animated waves, crisp white foam at shores.
- **Materials:** clean PBR-ish (roughness ~0.5–0.7), saturated but controlled colors, gentle rim light. Aircraft in clean military-toy paint with bold team color accents.
- **Effects:** Fortnite-style stylized smoke/explosions (smooth puffy shapes, bright orange-yellow fire, white-gray smoke), clean tracers.
- **UI:** clean, bold, confident: strong sans-serif (heavy weight, slight italic/condensed for titles), white panels or dark translucent panels with bright accent (e.g. electric blue/yellow), big readable HUD, minimal decoration. No lore taglines, no blinking eyes, no "something circles beneath the clouds".
- **Post:** minimal — light bloom on highlights, slight saturation/contrast, FXAA/SMAA. No color grading gimmicks, no heavy vignette, no ink pass.
- Performance budgets unchanged (≤ 60 world draw calls Balanced, 60 fps laptop).

## Signature look (locked, supersedes the Islanders section below): "GOLDEN ELDRITCH"
A permanent, impossibly beautiful golden hour over a tropical archipelago — and something enormous watching from the sky.
References for mood: Sable (flat color + fine ink line), Journey (warm glowing light), Outer Wilds (huge celestial bodies on the horizon), Studio Ghibli skies.
- **Light:** sun low on the horizon (~8–12° elevation), warm apricot/peach key light (`#ffc58a`–`#ffd9a8`), long soft shadows; **shadow side is cool lilac/violet** (`#7d6fa8`-ish), never gray. Strong warm/cool split on every faceted surface.
- **Sky:** gradient from warm peach at the horizon → rose → dusty lavender → deep indigo at the zenith. Clouds are big soft low-poly banks lit pink/gold on the sun side, lilac in shadow, with a slight rim glow.
- **The Watcher:** a vast pale moon/planet (with a faint ring and subtle surface detail) hanging huge above the horizon opposite the sun, ~25–35° of sky, slightly too close. Faint aurora ribbons near it. Tasteful, uncanny, never cartoon-scary. It's the game's logo moment.
- **Sea:** deep teal-indigo, with a bright golden sun-glitter path toward the sun, turquoise shallows turning gold near beaches, soft glowing foam rings.
- **Terrain:** faceted low-poly kept, palette re-tuned for golden light: warm sand, olive-to-sage greens, terracotta/ochre cliffs, lilac in shade. Fewer, richer colors.
- **Ink:** thin warm-dark outlines (`#3b2a3f`, ~1–1.5 px, distance-faded) on silhouettes of aircraft, props and terrain ridges — Moebius/Sable feel, subtle, not cartoon-thick.
- **Atmosphere:** warm haze toward the sun, cooler violet haze away from it; distant islands fade into layered silhouettes.
- **Effects:** fire/explosions in gold/coral, smoke warm-gray with lilac shadows, tracers warm white-gold.
- **UI:** keep the frosted panels but tint them warm ivory with deep-indigo text and gold/lilac accents to match.
- Performance budgets unchanged (≤ 60 world draw calls Balanced, 60 fps laptop).

## World art direction (previous): ISLANDERS-style low-poly
Reference: Islanders (https://store.steampowered.com/app/1046030/ISLANDERS/), also Townscaper, Sky Rogue.
- **Faceted, flat-shaded geometry**: each terrain triangle has one flat color (no smooth per-vertex gradients, no noise textures). Low-poly silhouettes with clean, deliberate facets.
- **One small curated palette** (~12–16 colors total for the whole world), harmonious and slightly desaturated/pastel: soft sand, 2–3 greens (light meadow, mid, deep forest), warm rock/cliff tones, pale snow; water in 2–3 blues (deep, mid, light turquoise shallows) with a crisp, simple foam edge. Colors chosen by height/slope bands with **hard band edges** (no blending/streaks).
- **Soft, consistent lighting**: a single warm sun + cool sky fill; gentle contrast between lit and shaded facets; no harsh noise. Optional subtle ambient occlusion via darker facets in valleys.
- **Gradient sky** (horizon light → zenith deeper) and **soft distance fog** that fades islands into the sky color — strong atmospheric perspective.
- **Props are low-poly and chunky**: cone/ico trees in 2–3 greens, simple blocky buildings in off-white with colored roofs, all flat-shaded, using the same palette.
- Everything on screen should look like it belongs to the same toy diorama.

# Aircraft

Goal: **as good-looking and detailed as possible, cartoonish, and cheap to render.**
Think stylized military toy / Pixar-ish chunkiness rather than a sim, while every aircraft stays instantly recognizable as its real counterpart.

## Shape language
- **Chunky, slightly exaggerated proportions.** Keep the real silhouette, but scale up the features players read at a glance by ~10–25%: canopies, engines/intakes, nose cones, guns, rocket pods, missiles, rotor hubs.
- **Soft, rounded forms.** Prefer lathes, capsules, and beveled extrusions over raw boxes. Every extrusion gets a bevel (`bevel` 0.03–0.12 depending on size). Avoid razor-thin slabs; wings/fins are at least ~0.18 m thick at the root with beveled edges.
- **Clean, readable hierarchy:** big primary shapes first, then medium secondary shapes (intakes, fairings, pylons, gear pods), then a few small tertiary details. No noise.
- **Canopies sit into the body** with a hull-colored fairing behind them. Never a separate blob perched on top.
- **Nothing implausible bolted on.** Game-only seats/weapons must be integrated believably (targeting pods, door guns), never a turret stuck on top of a jet.

## Detail that adds charm (cheap)
- Pitot tube, blade antennas, intake lips with darker interiors, darker exhaust interiors, panel-break bands (thin inset rings/strips in a slightly different shade).
- **Navigation lights** (emissive, small): red on the left wingtip, green on the right, white on the tail. Name them `navlight_L`, `navlight_R`, `navlight_tail`.
- Afterburner / exhaust glow discs (emissive orange) where applicable, named so the game can scale their intensity.
- Missiles/rockets with colored bands (yellow/white/black) and fins.

## Color blocking (no textures)
- **Two-tone scheme:** a darker top color and a lighter belly color (countershading), plus a dark-metal accent for guns/exhausts/gear.
- **Team livery zones** in `#2f6fd1`, named `livery_*`, large enough to read from 300 m (tail fins, wingtips, nose band, rotor tips). The game recolors anything named `livery_*` per team.
- Saturated but not neon. Keep roughness 0.45–0.7 so the in-game toon shading reads well.

## Crew figures (consistent across all aircraft)
- Group `pilot_N`, slightly chibi: helmet ~1.25× realistic size (radius ~0.18–0.2), capsule torso, simple arms (two small capsules) reaching forward to controls. Flight suit `#5b6b3a` (Blackbird: pressure-suit gold `#c8a24a`), helmet `#d9dcdf`, visor `#1a1206` facing the crew member's look direction.
- Fully inside the canopy/cabin and visible through the glass.

## Performance budget (hard limits)
- **≤ 20,000 triangles per aircraft** including crew and weapons. Spend triangles on curved primary shapes; tiny parts use 6–10 segments.
- Lathe/sphere segments: 24–32 for fuselages and canopies, 12–16 for medium parts, 6–10 for small parts.
- **≤ 12 distinct materials per aircraft** (don't merge unrelated colors just to save a slot, e.g. helmets and belly paint). Reuse the exact same color/metalness/roughness values for every part of the same material so the game can merge meshes by material.
- No lights or cameras inside the aircraft root group.
- Keep required animated pivots (rotors, props, turrets, gun barrels, gear group, `pilot_N`, `missile_*`) as separate named groups; everything else may be freely combined.

## Rendering intent (what the game does with it)
- The game renders with stylized shading (soft banded lighting + subtle outlines) and per-team livery recoloring, so clean shape and color zones matter more than micro detail.
