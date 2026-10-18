# Outbreak art direction

The shipped look is **Today · v8**, a Darkwood pass (AR-52, finished in AR-53). This page is the contract: what the
look is, the numbers it is held to, and what never to do. Read it before touching Outbreak's shaders, lighting,
post or look settings. The look studies that led here are in [outbreak-look.md](outbreak-look.md) and
[outbreak-look-v2.md](outbreak-look-v2.md).

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

## Targets by hour

| Hour | Target | Final (AR-53, seed 7, 1536×1024) |
| --- | --- | --- |
| Day 14:00 | Sickly overcast: olive greens, khaki earth, heavy dark canopies (`dayMuted`). Cone visibly brighter than the shroud. | meanL 0.146, meanS 0.082. Cone ground ~0.26 vs shroud ~0.14. |
| Dusk 18:30 | Low-key peat-amber light sinking into slate. No neon sunset, no blue rim. | meanL 0.086, meanS 0.087, lit S 0.39. |
| Night 21:00 | Near black outside light. The beam and a few lamps are the world. | meanL 0.047, p50L 0.035. Turned around: beam ground 0.31–0.74, cone outside the beam 0.06, shroud 0.03. |
| Start house 21:00 | Warm interior pools held by walls; grey memory elsewhere. | meanL 0.053, lit S 0.37. |

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
  ground. PR #245 removed them; the flicker check below guards it.
- **Coordinate hacks.** No hard-coded world coordinates in shaders (#247); use building and camera uniforms.
- **A second shader path per look.** One surface path (`buildOutbreakSurfaceWgsl`); earlier looks are knob sets.
  Follow the register-pressure rules in [rendering-techniques.md](rendering-techniques.md).

## Settings and Before presets

Every v8 value is a typed, documented knob in `src/look/world.ts` (`DEFAULT_LOOK_TRIMS`, Lab: Backquote › Look) or
`DEFAULT_FLASHLIGHT_BEAM` (Backquote › Flashlight). The presets in `src/look/presets.ts` are `today` (v8, the
identity and Reset) and one Before preset, `today-v7` (the Dying Light pass), expressed only through knobs: the
v8-only terms are gated by `dayShroud`, `dayMuted`, `shroudLampKeep`, `sightGlow` and `groundDetail`, which are 0 in
v7. Earlier presets (v4–v6, Legacy, rendering-round ideas) and their shader branches were removed in AR-53.

## Proof

`games/outbreak/scripts/look-beauty.ts`, always through `hivemind run --kind browser` (headless, muted):

- `--mode stills [--variants '{"name":{knobs}}'] [--scenes a,b]`: the eight beauty scenes with pixel stats.
- `--mode flicker --base <git archive of main>`: walking temporal metric (tile RMS and high-pass RMS between
  frames with grain off). AR-53: street night hpRms p90 0.0109 vs 0.0070 on main, all of it from the larger lit
  area of the new beam (the v7 beam on this branch measures 0.0073); ground detail on/off differs by < 0.0001.
  Daytime improved (0.0127 vs 0.0142).
- `--mode gpu --base <tree>`: paired GPU per scene at 3456×1894. AR-53 vs main: −0.74 to −1.10 ms in every scene
  (MAD ≤ 0.18 ms), mostly from the thin volumetric beam.
- `--mode sheet --columns 'Label:dir:prefix,...' --refs a,b`: the comparison sheet.
