# Outbreak art direction

The shipped look is **Today · v8**, a Darkwood pass (AR-52, finished in AR-53). This page is the contract: what the
look is, the numbers it is held to, and what never to do. Read it before touching Outbreak's shaders, lighting,
post or look settings. The look studies that led here are in [outbreak-look.md](research/outbreak-look.md) and
[outbreak-look-v2.md](research/outbreak-look-v2.md).

Current stills, v8 | Darkwood reference | final (AR-53):
https://problems.kitlangton.com/media/iQeYx8OA8M1QrwJ_3Q2qYw.jpg

## The reference: Darkwood

Darkwood (Acid Wizard, 2017) is a top-down survival horror game. Its programmer describes the field of view as
"every other light in the game": raycasts from the survivor build a mask, the mask is blurred, and everything
outside it is greyed, darkened and grained, at every hour. Outbreak has the same machinery (the 512-ray polar
visibility field in `src/fog-of-war.ts`, `Vision.actorVisible` in `shared/vision.ts`), so the reference
translates almost directly.

| Reference | What to take from it |
| --- | --- |
| ![ref-01](https://problems.kitlangton.com/media/ehYGgwg-cJjmMk98QUtdjQ.jpg) | Night flashlight: a wide, crisp wedge that lights the ground's texture and colour; black outside it. |
| ![ref-02](https://problems.kitlangton.com/media/aimi5c-WjDm-H-PcgYQYBA.jpg) | Day: the sight cone is a lit wedge cut out of a grey, grainy shroud. The shroud holds by day. |
| ![ref-10](https://problems.kitlangton.com/media/fhO1cLaWI_BvV524x1Uv8Q.jpg) | Trees and walls cut dark wedges out of the cone. Muted olive and khaki inside, slate outside. |
| ![ref-04](https://problems.kitlangton.com/media/yWytNnu__5UYRH7dU6QL9A.jpg) | Indoors at night: a warm lamp pool held by walls; explored rooms out of sight are grey memory. |
| ![ref-07](https://problems.kitlangton.com/media/Q7A7Dwil4K4k61mcLFHzCg.jpg) | Deep night: almost all black, a narrow cone, heavy grain. |

Measured reference values (from the reference report, 384×256 downsample): night meanL 0.086–0.100, p50L
0.044–0.069; in-beam ground luma about 0.35 with the shroud at about 0.09 (ref-01); grain std 0.010–0.025.

## Rules

1. **Colour only inside actual light.** At night a surface keeps its pigment in proportion to the light it
   receives (flashlight, lamps, windows, headlights, muzzle flash, baked lamp bounce). Everything else is
   near-monochrome. `lightColour`, `worldSaturation`, `litColour`, `beamColour` in `src/look/world.ts`; the colour
   mask is `outbreakColorMask` in `src/lighting.ts`. A pool needs a lamp: outdoor practical pools only exist while
   the lamps are on, never as a sourceless glow around the survivor.
2. **The sight cone is the frame.** Outside sight the world is cold-slate charcoal, darker and grainy, by day and
   by night (`dayShroud`, `shroudCharcoal`, `shroudGrain`). The cone has a crisp ~5° edge and a body halo that
   ends at the awareness radius (`coneSharpness`). Walls and trees cut wedges out of it. Lamp-lit places keep a
   little colour while out of sight (`shroudLampKeep`), so a lit window across the street still reads warm.
3. **At night the cone still reads.** What the survivor can see is dim grey terrain, a few points of luma above
   the shroud (`sightGlow`), so turning around shows the cone and its occluder wedges even outside the beam.
4. **The flashlight is the main thing on screen at night.** See the spec below.
5. **Grain and vignette at every hour.** Grain is part of the painted texture, not a night effect: `dayGrain`
   (0.05) and `nightGrain` (0.085) in the grade, and coarse crawling grit in the shroud. The vignette floor is
   `dayVignette` (0.42); nights use `nightVignette` (0.52).
6. **Painted ground, not noise.** Ground detail is dirt drifts, dried stains with darker rims, scuffed wear,
   leaf litter and cracks at 0.4–3 m in world space (`paintedGround` in `src/ground.ts`, `groundDetail`). Every
   term fades or widens with `surfaceFootprint`, so it holds still while walking.
7. **Lamps are pools with a hot core.** A porch, window or room lamp reads as a warm pool: a small warm-white core
   where its light is strongest, amber falloff around it and dark beyond. Never a clipped, flat yellow blob. Lamp
   light is added light, never painted into albedo, so the flashlight crossing a pool keeps its own colour.
   `lampRolloff` (Look · Lights) rolls lamp-lit surfaces off with the hue held and turns the hottest part warm white,
   weighted by how much of the light is lamp rather than beam.
8. **Without a light, night sight is short.** At night with the flashlight off, sight reads dim grey out to
   `nightSightRadius` (4.5 m) and fades to dark over `nightSightFalloff` (5 m); places a real light reaches stay in
   sight (Look · Night sight, `src/look/night-sight.ts`, `outbreakNightReach`). The client's vision range shrinks to the
   dark edge too, so zombies past it are hidden like anything else out of sight. `nightSight` 0 is the v8 look.
9. **The town is abandoned: few lamps are left on.** Only `litWindows` (20%) of houses, by a stable roll on the
   building id (`src/look/lit-windows.ts`), glow behind their windows and spill window light; the rest have dark glass.
   A lit window is warm tungsten, brightest low in the pane and dimmer behind half-drawn curtains, never a flat slab.

## Interior material and detail standard

The floors set the bar (AR-42/AR-46): every interior surface should hold detail at the same density and stay as
still while walking. Anything built for interiors meets these numbers. The craft pass (AR-69) brought walls, windows,
cabinets and blood writing up to them; Lab: Backquote › Rugs & interiors › **Interior craft** (Today / Craft pass)
switches it all back for comparison, and **Wall wear** scales the wall shading.

| Property | Standard | Where |
| --- | --- | --- |
| Smallest painted detail | 0.04–0.08 m (a plank seam, a grout line, a tide-line rim). Narrower terms widen or fade with `surfaceFootprint`. | `themedFloor`, `interiorWallWear` in `src/interiors/wgsl.ts` |
| Tiled textures | Wallpaper, parquet and floor plates repeat seamlessly in world space: the repeat material sampler with `fract` coordinates (the detail sampler clamps, for rugs), and an explicit mip from the layer's real size (Lab rug resolution), so motifs hold still while walking instead of shimmering. | `interiorTileSample` in `src/interiors/wgsl.ts` |
| Large variation | 0.5–3 m mottling or macro tone on every face, so no long wall or floor reads as one flat colour. | same |
| Smallest modelled edge | 10–30 mm: chamfers, door stiles proud of fields, reveals between fronts, sill drip edges. A surface the camera sees edge-on gets a lit top. | `cabinetry.ts`, `windows.ts`, `skirting` in `mesh.ts` |
| Joins | Every wall meets the floor with a skirting (0.14 m, 32 mm proud, chamfered top) and the ceiling line with the cap moulding. Plain rooms add a dado rail where the dado paint stops. Nothing coplanar with a wall; pieces stand 2–10 mm proud of what they sit on. | `skirting`, `dadoRail`, `emitWallCapMoulding` |
| Wall surface | Painted plaster or wallpaper, then wear: cove shade under the ceiling, contact shade down to the skirting, occlusion from furniture in front (the floor bake), vertical water streaks from the top, a rising-damp tide line with a darker rim. Streaks run vertically, the wall's uncompressed screen axis. | `plasterWall`, `interiorWallWear` |
| Fitted furniture | Toe-kick, framed fronts with a recessed field, a dark reveal between fronts, pulls on standoffs, counter with overhang, edge band and backsplash, a sink well that is actually deep. Generated library furniture is the reference for detail. | `cabinetry.ts`, `props/` |
| Windows | One builder for street and room: casing and sill with a drip edge outside, jamb liners through the wall, two sashes with meeting rail and glazing bars, stool, apron and casing inside, cloth drapes. Boards across a window use the barricade board (0.13 × 0.05 m, `BOARD`). | `emitCraftWindow`, `emitFaceWindow` in `windows.ts` |
| Materials | Matte by default (`MAT.lit`, `MAT.timber`, brick). `MAT.shiny` only for small metal (pulls, taps, rods); glass is the only reflective surface. Nothing glows unless a lamp lights it (`MAT.lamp` slots, owned by lighting). | |
| Wall writing | Painted by hand in blood: tapered strokes that run dry, letters that lean and drift off the baseline, drips from the low points ending in beads, a smear and flecks. Darker where thick, matte, aligned to the wall plane, about 1.2 m above the floor. Details › "Indoor warnings in blood" off shows Today's spray font. | `bloodWord` in `src/details/models.ts`, `BLOOD_WORDS` in `placement.ts` |
| Cost | Bounded and seeded: geometry comes from the building plan and seed only. The AR-69 pass adds about 9% triangles to the origin level (107k → 117k); shader wear is a few noise taps per wall pixel. | `tests/interiors-craft.test.ts` |

## Targets by hour

| Hour | Target | Final (AR-53, seed 7, 1536×1024) |
| --- | --- | --- |
| Day 14:00 | Sickly overcast: olive greens, khaki earth, heavy dark canopies (`dayMuted`). Cone visibly brighter than the shroud. | meanL 0.146, meanS 0.082. Cone ground ~0.26 vs shroud ~0.14. |
| Dusk 18:30 | Low-key peat-amber light sinking into slate. No neon sunset, no blue rim. | meanL 0.086, meanS 0.087, lit S 0.39. |
| Night 21:00 | Near black outside light. The beam and a few lamps are the world. | meanL 0.047, p50L 0.035. Turned around: beam ground 0.31–0.74, cone outside the beam 0.06, shroud 0.03. |
| Start house 21:00 | Warm interior pools held by walls; grey memory elsewhere. | meanL 0.053, lit S 0.37. |

The default camera distance is 38 since D-35 (was 46; the AR-53 numbers above were taken at 46). At 38 with the
lamp roll-off (same seed and size): day meanL 0.149, meanS 0.091; dusk meanL 0.092, lit S 0.39; night facing the
house meanL 0.052, p50L 0.035, lit S 0.47 (was 0.50, from the yellow blob); turned around p90L 0.16; start house
meanL 0.063, lit S 0.35.

## Flashlight spec

A dirty halogen torch (`beamWarmth` 0.45, about 3800–4000K): a **wide, evenly lit wedge with a crisp edge** that
lands about a metre in front of the survivor and runs to its range, lighting the ground's texture and colour.

| Setting | Value | Why |
| --- | --- | --- |
| `beamInner` | 0.8 | Flat-topped cone: the edge is the last 20% of the angle. |
| `beamCore`, `beamCookie` | 0.2, 0.1 | A hint of hotspot and reflector rings, not a bright dot. |
| `beamSpill` | 0.02 | Almost no light outside the wedge. |
| `beamPoolDistance` | 2.4 m | Aimed low so the near pool starts at the survivor's feet. |
| `beamNearSoftening` | 6 m | Flattens inverse-square so the far end stays lit (turned around at 21:00: near 0.74, mid 0.52, far 0.31 luma). |
| `beamVisibility`, `beamGlare` | 0.35, 0.6 | Thin air glow and lens flare: the ground is lit, the air isn't a wall of light. |
| `beamTightness` | 0 | The v7 tight hotspot is off. |
| Dust motes | 0.12 share, 1.5× size, 0.7× brightness | A few large motes, not glitter. |

`DEFAULT_FLASHLIGHT_BEAM` in `src/lighting.ts` holds these; look presets carry their own beam (`beam` in
`src/look/presets.ts`), so the `today-v7` Before preset still shows the v7 beam. The cone angle (`flashlightCone`
56° in `shared/flashlight.ts`) is sim and AI tuning; don't change it for looks.

## What not to do

- **Blue nights.** Moonlit darks are neutral slate, not indigo. The grade's night split-tone cools unlit darks;
  the unseen post neutralises cool darks outside light (`applyOutbreakUnseenPost`), so cone and halo edges never
  ring blue. Don't bring back `cold-moonlight`-style presets.
- **Washes.** No full-screen colour wash, no warm pool that follows the survivor, no lamp light by day.
- **Glitter and 1-px noise.** No `hash2(floor(p * k))` terms at sub-pixel scale, no specular sparkle on matte
  ground. PR #245 removed them; the flicker check below guards it. Scattered litter is jittered per cell, varies in
  size and is darker than the ground it lies on; a flake centred in every grid cell reads as rows of bright dots in
  the beam (AR-70). Blood is matte, pools included.
- **Coordinate hacks.** No hard-coded world coordinates in shaders (#247); use building and camera uniforms.
- **A second shader path per look.** One surface path (`buildOutbreakSurfaceWgsl`); earlier looks are knob sets.
  Follow the register-pressure rules in [rendering-techniques.md](research/rendering-techniques.md).

## Settings and Before presets

Every v8 value is a typed, documented knob in `src/look/world.ts` (`DEFAULT_LOOK_TRIMS`, Lab: Backquote › Look) or
`DEFAULT_FLASHLIGHT_BEAM` (Backquote › Flashlight). The presets in `src/look/presets.ts` are `today` (v9, the
identity and Reset), `today-v8` (before night sight and rare lit windows: `nightSight` 0, `litWindows` 1) and
`today-v7` (the Dying Light pass), expressed only through knobs: the
v8-only terms are gated by `dayShroud`, `dayMuted`, `shroudLampKeep`, `sightGlow` and `groundDetail`, which are 0 in
v7. Earlier presets (v4–v6, Legacy, rendering-round ideas) and their shader branches were removed in AR-53.

## Proof

`games/outbreak/scripts/look-beauty.ts`, always through `hivemind run --kind browser` (headless, muted). Scenes use the default camera distance (38):

- `--mode stills [--variants '{"name":{knobs}}'] [--scenes a,b]`: the eight beauty scenes with pixel stats.
- `--mode flicker --base <git archive of main>`: walking temporal metric (tile RMS and high-pass RMS between
  frames with grain off). AR-53: street night hpRms p90 0.0109 vs 0.0070 on main, all of it from the larger lit
  area of the new beam (the v7 beam on this branch measures 0.0073); ground detail on/off differs by < 0.0001.
  Daytime improved (0.0127 vs 0.0142).
- `--mode gpu --base <tree>`: paired GPU per scene at 3456×1894. AR-53 vs main: −0.74 to −1.10 ms in every scene
  (MAD ≤ 0.18 ms), mostly from the thin volumetric beam.
- `--mode sheet --columns 'Label:dir:prefix,...' --refs a,b`: the comparison sheet.
