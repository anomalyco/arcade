# Art Style Guide — Aircraft

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
