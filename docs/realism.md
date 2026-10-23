# Realism playbook

## Water candidate (2026-10-22, awaiting Kit)

Carrier's opt-in continuous ocean uses `packages/kit/water/`: irregular filtered
normal bands, sparse sun glints and turbulent surface foam. `water/wake.ts` adds a
bounded Kelvin cusp-normal approximation at 19.47°, driven by the real boat poses;
wave geometry and authoritative buoyancy are unchanged. Today remains the default.
The separate `woods-water` branch adds moon/star reflections, shallow torch scatter,
rain rings and a draggable local log to the real forest lake, with its existing sky
as the labelled fallback until `kit/sky` integrates. The lake needs that branch's
forest prerequisite, not just the Carrier branch.

Cost: deliberately not gated by paired timing, per Kit's latest direction. Decision:
pending visual review. Evidence and remaining differences: [perf/water.md](../perf/water.md).

What makes Arcade's scenes read as real, by what you see: lights, bounce, shadows, fog, smoke, wet ground, storms,
foliage, materials, glass, the camera, stability, quality tiers and sound. Each entry says what the trick is and why
it reads as real, where it lives (the kit path first, then the games using it), what it costs and how the quality
tiers treat it, what Kit picked or turned down, and how it goes wrong. How each one works in detail is in
[rendering-techniques.md](rendering-techniques.md); measured lessons are in [game-notes.md](game-notes.md). This page
links to those instead of repeating them.

- **Costs** are paired whole-frame GPU deltas against Today on Metal unless noted. The Mac mini (M4 Pro) is the budget
  machine. Studio's headless timings are not usable while its displays stay dark (184 ms frames, timestamp errors),
  so most numbers come from `mini` and `pro`. Outbreak is measured at 3456×1894 and the first-person games at
  1920×1080 unless noted.
- **Today** is the look before a technique. Every technique keeps Today one Lab setting away, and Today is the
  same pixels as before it shipped.

## What looks best: Kit's taste so far

- **Colour only inside light.** At night a surface keeps its colour in proportion to the light it receives;
  everything else is near-monochrome, and the moon gives no colour (Outbreak rule 1,
  [outbreak-art-direction.md](outbreak-art-direction.md)). Bounced light, character shadows, mist and dust exist only
  where a light lands, and darkness stays dark. The woods research says the same for first person: no blue ambient
  everywhere, and orange tape keeps its colour only where it is lit.
- **Real-world reference beats invention.** Kit judges against something real: Aiden's Ashwood for the Lot ("beat
  Ashwood, not match it"), his own paint-overs, period hardware (GE M-400 cobra heads, an Axon body camera), Darkwood
  for Outbreak. A trick that sounds right but doesn't match the reference gets reworked. Reference metrics
  (`games/lot/scripts/compare.py`) measure similarity, not quality.
- **Restraint.** Footsteps are quiet ("way too loud", Night Shift); lightning relights the scene once per strike with
  no white overlay and no exposure pumping; puddles are small; mist pools instead of washing the frame; camera filters
  are off by default; the lens is subtle. Woods research: one chosen camera, no maximised grain, chromatic
  aberration, blur or exposure pumping.
- **Lights come from a visible source.** "You can tell the light comes from a single point beneath" (Lot street
  lamps, AR-117); glass you can see through ("you can't see through the glass in ours, but in his you can", AR-110).
- **Silhouettes mass and connect.** "His trees are thicker and kind of connect, make a better silhouette"; "his fog
  descends more"; "shadier up there, more atmospheric" (Lot, AR-109/AR-111). Distant darks must fade in fog, not
  stand out as black cutouts ("would you actually see the black things? It's too visible", woods Scrawl, Oct 21).
- **Stable before detailed.** Glitter, flashing lights and popping pools are bugs to fix before adding detail
  (AR-118, AR-123).
- **Today is always one setting away.** New looks ship as a Lab option with Today the default; Kit picks from paired
  stills on a board decision (D-47 to D-52); the pick becomes the default and Today stays one setting away.
- **Hardware scales the look, not Kit.** "Don't we have settings and auto settings for gfx??" (D-53, withdrawn): a
  look that is too expensive on the mini goes into the quality tiers instead of asking Kit to cut it.

## Adding a technique

1. Build it in `packages/kit/` unless it is truly game-specific; the game supplies hooks (its attenuation,
   irradiance, masks). See [shared-code.md](shared-code.md) for what still lives in one game.
2. Ship it behind a typed Lab setting with Today as the default and byte-identical Today pixels. Pipelines build on
   first draw (`ensureScenePipes`, `VolumeSlot.ensurePipes`), shader paths that slow SwiftShader compile are
   compile-time opt-in (`PhysicalLightOptions.street`, `rect`), and `?smoke` keeps the technique at Today.
3. Measure paired GPU on `mini` (and `pro`) at the game's real resolution, and temporal stability with the game's
   motion script (`games/lot/scripts/motion.ts`, `games/outbreak/scripts/motion.ts`), not only stills.
4. Put it to Kit as a board decision with Today and the candidate at the same moment.
5. If it costs more than ~0.5 ms on the mini, give it quality-tier values.
6. Add an entry here with the cost and Kit's decision.

## Lights

**Catalogue night sky (`night-sky`).** `packages/kit/sky` draws 9,096 Yale catalogue stars with
temperature colours, atmospheric extinction, sidereal rotation and a pixel-integrated point spread. Airglow and
a faint procedural Galactic band sit behind a NASA-textured, half-degree Moon. The host supplies linear scene
units per cd/m² and owns exposure. `moonLight()` supplies lux and direction for the host's shadowed lighting.
- Where: on by default in Barbara (through `@arcade/kit/forest`, Today one setting away; its software-GPU smoke keeps
  Today); opt-in adapters in Lot, Night Shift, Outbreak and the shared world/Sky station, where Today is the default.
- Cost: initial sky-only mini Metal proof, 1920×1080 MSAA4, +0.204 ms median (MAD 0.028 ms); this precedes the
  lunar occultation and mip-filtering follow-up. No whole-game cost claim.
- Stability: integrated star energy varies 0.035% across 32 subpixel positions. Translation-free sky TAA drifts
  0.031 px after 64 m camera travel in the isolated production-pass fixture.
- Kit: turned it on for Barbara at its ship. Calibrated exposure and cloud composition remain integration work.
  Measurements and boundaries: [night-sky ledger](../perf/night-sky.md), [woods integration](../perf/night-sky-woods.md).
- Pitfalls: do not use a long-exposure photograph's brightness as an eye-level target; do not raise forest ambient
  to make stars visible. Moon mips filter in linear light, and the unlit disk also occludes stars.

**Physical lights and surfaces.** GGX with height-correlated Smith, Karis sphere-light widening so a fixture
mirrors as a patch, geometric specular AA, and a split-sum sky reflection with a fitted env BRDF. Reads as wet
asphalt, car paint and metal instead of Blinn hot spots.
- Where: `packages/kit/gpu/lights/physical.ts` (`physicalLightHooks`). Lot, Night Shift, Lab.
- Cost: +0.11 to +0.21 ms (Lab night lamps, `mini`, 3456×1894).

**Street lamps as lens emitters.** A cobra head is a glowing 0.6 × 0.3 m bowl throwing an asymmetric roadway pool
(IES Type II–III batwing, 62° cutoff), so the lamp is modelled as that: photometry from the pool it is designed to
light, `1/(d² + b²)` lens-kernel falloff (no hotspot under the head), highlights and airlight from the lens, PCSS
shadows sized by the lens, and an emissive sag bowl.
- Where: `packages/kit/gpu/lights/street.ts`, `FogLamp.lens` in `gpu/fog-scatter.ts`, `spotShadowVisArea` in
  `gpu/shadows/spot-shadows.ts`. Lot (`games/lot/src/lamps.ts`); Outbreak's top-down port
  (`games/outbreak/src/street-lamps/lens.ts`).
- Cost: Lot ≈ +0.2–0.3 ms (Studio, noisy). Outbreak +0.65 ms at a lamp-lit crossroads, +0.08 ms on the start street
  (`mini`). The same on every Outbreak tier. Compile-time opt-in: on SwiftShader the path took CI's smoke from 66–116 s
  to 149 s.
- Kit: D-49 picked lens emitters for Outbreak; the Lot's lamps follow his paint-over (AR-117, #364, #368).
- Pitfalls: with the scene's phase g 0.6, a camera standing in the pool sees a ball of air round the head; the beam
  needs its own low g (0.1) to read as the wedge below the lens. At full share the lamp-glow map lit the whole cloud
  deck olive; a cutoff head only sends its ground bounce up (`uplight` 0.12). LTC disc lights were rejected: at 6–9 m
  the lens subtends under 3°.
- Research: `~/code/home/artifacts/lot-2026-10-20/lamps-*`, `lamps-research-2026-10-20.md`.

**Torch beam profile.** Hot core, soft cone, two faint reflector rings and a wide dim spill, so the core reads as the
bulb and the ground beside the beam doesn't go black.
- Where: `packages/kit/gpu/lights/beam.ts` (`SceneLight.beam`, `BEAM_PROFILES`). Lot and Night Shift torches;
  Outbreak keeps its own `flashProfile` (`games/outbreak/src/lighting.ts`), from which the kit profile came.
- Cost: ~20 ALU per beam-lit pixel inside the light loop.
- Pitfalls: Outbreak's near-lens softening `1/(1 + d²/36)` is a top-down readability choice; don't use it in first
  person (woods research: clamp by the source radius instead). A first-person beam's own airlight read as "a solid
  bright wedge from the screen corner" in the woods; near-field scattering must be thin by the lens and fade softly.
- Research: woods `RESEARCH.md` §D (hotspot 8–16°, beam 25–40°, spill 1–5 %, 2,000–8,000 cd, source 0.25–0.45 m to
  the side of the eye).

**Flickering and failing practicals.** Stateless functions of seed and time, so co-op clients, replays and paired
captures agree: sodium restrike, fluorescent starter stutter, incandescent brown-out, beacons. One signal drives the
light, the emissive tube, the electrode glow and the ballast sound together.
- Where: `packages/kit/gpu/lights/flicker.ts` (`lampFlicker`, `coldSodiumTint`). Lab › Dying lamps; Outbreak's dying
  sodium lamps; Night Shift's `tubeSignal` (`games/nightshift/src/polish/tube.ts`). Blackout keeps its own flicker.
- Cost: CPU only, ~0.2 µs per lamp.
- Pitfalls: dying lamps and police bars flash by design; exclude them before attributing motion pops (AR-123).

**Rectangular panel emitters.** Exact horizon-clipped polygon diffuse for a ceiling troffer, approximate
representative-point GGX and shared area shadows, so a lobby panel lights the wall and floor like a panel, not a
point.
- Where: `packages/kit/gpu/lights/rect.ts` (`SceneLight.rect`, `physicalLightHooks({ rect: true })`). Lot lobby
  (`games/lot/src/interior/fixtures.ts`).
- Cost: one polygon evaluation per panel-lit fragment; compile-time opt-in, Today and smoke use a point.

**Emissive sources.** Lamp bowls and lit panes are emissive geometry; bloom is gated to light sources
(`PostFinishOptions.bloomGate`) and the first downsample is Karis-weighted (`bloomKaris`) so a lone ember doesn't
flash. Far glow decals need a depth offset counted in 24-bit depth steps (`SceneHooks.depthBias`): the Lot's
stairwell glow sat 5 mm off its backing, under one depth step at 150 m, and flashed (AR-118).

**Analytic gobos and window light.** Light through blinds or a window frame, box-filtered with a penumbra that widens
with distance from the aperture, shared by the surfaces and the dust in the same beam.
- Where: Night Shift `blindCookieAt` (`games/nightshift/src/blind-cookie.ts`); Blackout bakes a 3.125 cm window mask
  (`games/blackout/src/render/level-mesh.ts`). The kit has no shared cookie yet.

**Light culling.** Many practicals stay cheap with the plan light-list grid (`packages/kit/gpu/lamp-grid.ts`: −0.23 to
−0.62 ms in Outbreak on `mini`) and CPU frustum culling. A lamp must fade across its cull distance, not cut (Outbreak
`stepLampReach`, 0.5 s, AR-123).

## Bounced and indirect light

**One-bounce plan-space light.** Fire, torches, muzzle flashes, lamps and lit windows spill their colour onto nearby
floors and walls: a 64 m grid around the camera, emission from the frame's lights, a mip chain and a 16-cone gather
that walls block. Nothing jitters, so it holds still under TAA, and six torches cost the same as one.
- Where: `packages/kit/gpu/gi/plan-bounce.ts`. Outbreak (`games/outbreak/src/bounce-light/`).
- Cost: within noise (−0.02 to +0.04 ms, `pro`). Tiers: 0.5 m texels on High and Balanced, 1 m on Low.
- Kit: D-47 picked ×3. Physically normalised ×1 read too faint after Outbreak's grade.
- Pitfalls: plan space only. The woods research warns it doesn't model bounce under a canopy, off lifted logs or from
  a raised torch; for first person use a bounded hit-light (a diffuse emitter just off the beam's hit point, 0.5–3 m,
  2–8 % of the direct light).

**Baked lamp pools and bounce.** Static room lamps that aren't live indoors bake their line-of-sight pools into the
0.5 m bounce texture, so rooms have warm pools at no GPU cost and the colour rule counts them as light.
- Where: Outbreak `games/outbreak/src/lightbake.ts`; Blackout `bakeBounce` (`games/blackout/src/render/level-mesh.ts`).
  Lot interior has room-local bounce (`games/lot/src/interior/`).

**Sky and fog ambient.** The fog's sky is also the surface ambient, a quadratic in `n.y` fitted to the fog colour, so
shadowed surfaces take the night sky's tint with no env bake (`fogAmbient`, `packages/kit/gpu/fog-scatter.ts`).
Baked floor AO and Jimenez's multi-bounce AO keep crevices saturated instead of grey (`packages/kit/gpu/shaders.ts`).

**Not built yet:** directional (SH) ambient, canopy-openness sky occlusion for forests (woods research rank 3), and the
first-person flashlight hit bounce.

## Shadows

**Polar shadows.** 512 rays per light in one compute pass give omnidirectional shadows for dozens of lamps seen from
above, with finite shadows from low furniture (`packages/kit/gpu/shaders.ts`). Outbreak, Blackout.

**Spot shadow maps.** Perspective depth maps for the two or three lights that matter most, with a hysteresis picker,
cross-fades, re-rendering only on change, and a fixed 3×3 hardware PCF (no per-pixel noise to crawl under TAA).
- Where: `packages/kit/gpu/shadows/spot-shadows.ts`. Lot (three slots, the booth light included), Night Shift (its
  dust samples them too).
- Cost: +0.37 ms for two slots sampling (`mini`); each slot change renders one 1024² layer.
- Pitfalls: cutout foliage isn't a caster, so ferns cast nothing (woods research). Fade a slot by camera distance near
  the pool's edge (`SpotSlot.reach`), not only on hand-over. Rendering a moving torch's map every frame is a separate
  cost from sampling; budget it separately.

**Soft character shadows from capsules.** Each body is 14 bone capsules; every fragment gets a contact term and a
soft shadow from each of its four strongest lights, sharp at the feet and widening up the body. It exists only where
that light lands, so darkness stays dark.
- Where: `packages/kit/gpu/shadows/capsule-shadows.ts`. Outbreak (`games/outbreak/src/soft-shadows/`).
- Cost: +0.18 to +0.23 ms (Metal); CPU 0.1–0.5 ms. Tiers: three shadow lights per body on High, one on Low.
- Kit: D-48 picked soft shadows.

**Screen-space contact shadows.** A short depth march toward the one or two lights lighting each pixel most grounds
pole feet, kerbs, furniture and cars where shadow maps are too coarse.
- Where: `packages/kit/gpu/contact-shadows.ts`. Lot, Night Shift, Outbreak (`games/outbreak/src/contact-shadows/`).
- Cost: Lot +0.25–0.8 ms (`pro`); Outbreak +1.5 ms alone, +2.6/+1.6 ms in the combined run (`mini`). Tiers: High 2
  lights × 12 steps, Balanced 1 × 8, Low off. Not compiled under `?smoke`.
- Kit: D-52 picked contact shadows.
- Pitfalls: keep the history while moving (`historyMoving` 0.25 in the Lot: lamp walk 2436 → 230 pops/frame);
  reconstruct depth at the exact integer texel (Night Shift, #389); the Lot excludes its street lamps from the contact
  irradiance.

**Baked contact AO.** Floor AO under walls and furniture and vertex AO in foliage cost nothing per frame. Outbreak
also stamps base darkening and edge tone into `v.color.a` on its buildings and props (`stampOutbreakVertexTone` in
`games/outbreak/src/lighting.ts`); the kit's `Mesh.box` and `bevelBox` still leave it at 1.0, so other games miss it.

## Fog, mist and volumetrics

- **Clear air near you (Woods):** `packages/kit/forest/view.ts` scales torch in-scatter from 10% at the eye to 100% at 8 m, with −0.25-stop compensation only while your torch is on; measured renderer GPU delta −0.031 to +0.053 ms (mini/Metal, High, 1600×900, three views; [measurements](../perf/woods-autoresearch.md#review-follow-up-optional-clear-near-air)). Default on in Barbara and its Lab page at Kit's request; **Kit's final visual decision is pending**. Mist → Clear air near you → off restores Today, including its exposure target, after adaptation settles; smoke stays Today.

**Lamp airlight in height fog.** Exponential height fog with closed-form optical depth; each pixel takes 4
equiangular samples per lamp along the view ray, so every lamp hangs in the air with a soft cone. Half resolution with
its own history and a depth-aware upsample.
- Where: `packages/kit/gpu/fog-scatter.ts`, `gpu/volume-pass.ts`. Lot (on); Outbreak lamp fog is an option, off.
- Cost: Outbreak +1.37 to +1.39 ms (`mini`, half res, up to 7 lamps). Zero and uncompiled at Today.
- Research: Aiden's Afterhours; equiangular sampling after Kulla & Fajardo.

**Drifting fog bank and low mist.** A ray–slab march through a noise-modulated height layer with a rolling top, so fog
settles between trunks and lamp beams thicken inside it. Outbreak masks it to pool against house walls, in yard
hollows and along gutters.
- Where: `fogScatterVolume({ atmosphere: true })` in `packages/kit/gpu/fog-scatter.ts`. Lot (on); Outbreak low mist
  (`games/outbreak/src/mist/`, mask in `games/outbreak/src/mist/wgsl.ts`).
- Cost: Lot +0.5 to +1.2 ms (`mini`, 2560×1440). Outbreak +1.8 ms (yard) to +2.3 ms (start street) at a third of the
  screen (`mini`). Tiers: a third on High, a quarter on Balanced (−1.0 ms), off on Low.
- Kit: D-50 picked low mist.
- Pitfalls: **mist reading as a grey wash.** An even layer over near-clear fog read as a flat grey veil from 38 m up.
  The fixes: pool it with a mask, keep the fog under the bank nearly clear (3e-5/m), give the mist no sky light at
  night, and fade each lamp's glow-map light at 1.5× its reach (`FogLamp.glowRange`), which keeps mist outside sight
  black. The woods hit the same thing as "a flat grey veil with a hard horizontal band": use local pockets and layered
  depth, not a slab.

**Fog-depth blur.** A fog-weighted half/quarter-res blur mixed in by 1 − T, so far trees and buildings soften into
masses (`packages/kit/gpu/fog-blur.ts`). Lot: +0.51 ms (`mini`).

**Lit cloud deck.** A footprint-filtered cloud plane lit from below by a 32² top-down lamp-glow map, which also tints
the bank; every lamp tints the sky for one texture read (`fogCloud`, `bakeLampGlow`). Lot: +0.03 to +0.05 ms.

**Volumetric torch shaft.** From a steep camera a torch that only lights surfaces reads as a pool at the feet, so
Outbreak marches the beam in a separate half- or quarter-res pass scissored to the shaft
(`games/outbreak/src/flashlight-beam.ts`, kit `VolumeLightShader`): 0.04–0.23 ms. The same march inside the scene
shader cost +2.2 ms through register pressure.

**Dust motes.** A world-anchored lattice drawn per light, shaded in the vertex stage and shadowed in the fragment
stage, so motes only glint inside real light and never behind a wall; backlit motes catch forward scatter.
- Where: Outbreak `games/outbreak/src/air/dust.ts`; Night Shift `games/nightshift/src/polish/dust.ts` (shares the blind
  cookie and the spot depth maps). Blackout's `MAT.mote` quads are still unshadowed.
- Cost: Outbreak +0.02 to +0.12 ms. Tiers: lamps get motes on High (12) and Balanced (6), not Low.
- Pitfalls: a camera cut must not stir a walking wake (Night Shift). Woods research: 10–40 visible motes near a beam,
  not a snowstorm.

**Pitfall for all of the above: atmosphere hides temporal faults.** Turning the Lot's fog bank or blur off
multiplied the reflection glitter 15× and 7×. Attribute flicker with the atmosphere off as well as on.

## Smoke, fire and particles

**Room smoke.** A 0.5 m gas grid with 16-direction, corner-safe spreading, ray-marched at low res against stored
depth (`packages/kit/fx/volume.ts`): +0.166 ms. Blackout.

**Blackbody fire and explosions.** Planckian fireball billows whose outer lobes crust into soot, with a buoyant soot
plume (`packages/kit/fx/explosion.ts`): +0.346 ms at 1280×800. Outbreak draws its fire on the kit look (AR-68:
flamethrower +0.76 ms, molotov +0.57 ms) with fire lights as capsules (`LIGHT_CAPSULE`) so a burning body lights like
a column, not a point.

**World smoke and tyre smoke.** Seeded steam from drains and manholes, smouldering cars and chimneys, lit by the beam
and lamps (Outbreak `games/outbreak/src/air/smoke.ts`); curl-advected tyre smoke that stays where the tyre made it
(`packages/kit/fx/smoke-trail.ts`, Getaway).

- Pitfalls:
  - **Software-GPU smoke tests time out on heavy scenes (#392).** One Lot frame takes ~190 s to rasterize on CI's
    SwiftShader. The Lot smoke now draws offscreen and checks validation with an error-scope round trip instead of
    waiting for the frame; Outbreak builds pipelines on first draw (#373). Keep new looks at Today under `?smoke`.
  - Flames at blackbody heat ≥ 1.5 read as white dots; keep crown billows ~0.8–0.95 and tongues ~1.1–1.25.
  - Unlit smoke at 0.8 ambient was a grey ghost over the unseen area; 0.4 fixed it. Noir needs `keepColour` alpha, or
    fire greys to white blowouts.
  - Woods research: no constant smoke in a forest.
  - Particles, rain and bolts draw into the TAA reactive mask (`packages/kit/gpu/reactive.ts`).

## Wet surfaces, reflections and SSR

**Wet asphalt and puddles.** World-space noise and AO cavities pick puddles (near-mirror, flat normal, darker albedo);
a porous film darkens and smooths the rest, with drying streaks. Coverage is equalised, so the knob means area.
- Where: `packages/kit/gpu/reflections/wet.ts` (`wetSurfaceWgsl`, from Ashwood's `wet()`). Lot road. Weather wetness
  and puddle masks: `packages/kit/weather/wgsl.ts`, Outbreak `games/outbreak/src/weather/puddles.ts`.
- Research: Lagarde's *Water drop* series: porous darkening 0.65–0.85×, puddles 5–20 % of the pavement, water F0
  ≈ 0.02.

**Screen-space reflections.** Each physical surface tags `2 − roughness` into HDR alpha, so a volume slot marches a
quarter-res mirror ray with no G-buffer, then a vertical streak blur and temporal accumulation. Puts the booth, poles
and barrier into the wet road.
- Where: `packages/kit/gpu/reflections/ssr.ts`, `surface.ts`. Lot.
- Cost: +0.69 to +1.13 ms (Lot, Metal).
- Pitfalls: keep the slot's history while walking (`historyMoving` 0.2: far-lamp glitter 4.7 → 0 pops/frame); roll
  bright hits off softly instead of clamping; rebuild normals from depth at the exact loaded texel; passes drawn over
  the scene (the lightning bolt) write RGB only so the roughness tag survives. Keep the normal map's lost mip variance
  in roughness so far puddles go satin.

**Reflected airlight and glints.** The fog integrates lamps along the mirrored ray with a jittered normal, giving long
soft lamp streaks on wet ground plus a narrow per-lamp glint (`packages/kit/gpu/fog-scatter.ts`). Jittering the four
lobe strata per pixel and frame removed a bright dot at the end of each streak.

**Analytic light reflections from a top-down camera.** From Outbreak's steep camera the lamp heads a puddle would show
are off screen, so SSR would miss them. The CPU picks up to 8 outdoor lights and the ground shader draws each one's
mirror image, with dark reflected figures in front.
- Where: `games/outbreak/src/reflections/` (on by default), with mirror glass in the houses.
- Cost: +2.22 ms in its first build (`pro`); not re-measured since the light images moved to the CPU.
- LEAN glint AA widens images smaller than a pixel into a sheen (`glintAA`, on): rain walk at the far camera 592 → 557
  pops/frame.

- Pitfalls:
  - Everything wet and glossy looks fake: keep porous darkening, thin film and standing water distinct.
  - A hard reflection cap kills the streaks; clamp fireflies in the history, luminance-weighted.
  - The Lot's residual distant shimmer is lamp-lit wet asphalt (AR-122, open). Colour-mip filtering and filtered
    coverage did not fix it.

## Rain, storms and lightning

**Rain that shows only in light.** Instanced streaks, splashes and eave drips that fade outside lamp cones and torch
beams (`litOnly`), lit by the nearest practicals.
- Where: `packages/kit/weather/` (`WeatherRenderer`). Outbreak, Lot, Lab. Carrier keeps its ocean rain on purpose.
- Cost: +0.08 to +0.41 ms (Lab, Outbreak). Lot on `mini` at 1280×720: 7.58 ms Today → Drizzle 7.61, Rain 7.64,
  Storm 7.69 between strikes.
- Research: Garg & Nayar 2006 (streak appearance depends on light and view); Tatarchuk 2006 (ToyShop).

**Light-volume rain and flash recovery (opt-in).** `weather/rain-lighting.ts` supplies typed controls for 3D light
cones, endpoint-lit short streaks, smaller splashes and gravity-timed eave drips. `weather/exposure.ts` tracks bounded
log-EV sensitivity per view: 0.3 s bright response, 3 s dark recovery, no shadow lift. Lot and the shared Lab world
bind both under Weather, with independent Today defaults and Reset. The adapters use relative stimulus
`1 + 48 × flash`, not measured scene luminance; Lot also applies dose-driven glare through its bloom before the
single final exposure. Cost has not been isolated. Kit requested both as opt-ins; D-59 keeps Today's storm and
parks the volumetric-cloud experiment on `weather-clouds-parked`.

**Rain visibility follow-up (candidate).** Kit approved adaptation but rejected the faint lamp rain. On
`weather-rain-look`, streak radiance receives attenuation once, with a forward-scattering lobe and no unlit floor.
The existing far-drop budget samples world-anchored tiles around nearby light sources; the near field is tighter,
and rain streak counts no longer fall to 34% at HiDPI. Splash/mist budgets stay as before. A typed **Streak brightness**
control defaults to 4×. Lot lamp and carried-torch stills are in `perf/weather-rain-look.md`; Today matches the shipped
renderer in both views. This is an image candidate awaiting Kit's review; motion and GPU cost have not been measured.

**Lightning as one event envelope.** A seeded stepped-leader channel with midpoint displacement, a return stroke and
2–4 later strokes in the same channel inside half a second, and one scene-light pulse per strike that lights the
ground, the fog, the cloud deck and the rain together. No white overlay and no exposure change. A flash limiter keeps
any second to three scene flashes (WCAG 2.3.1); Full / Reduced / Off, with Reduced the default under
`prefers-reduced-motion`.
- Where: `packages/kit/weather/lightning.ts`, `lightning-pass.ts` (moved from the Lot). Lot storm
  (`games/lot/src/weather/storm.ts`). Outbreak has its own strike schedule
  (`games/outbreak/shared/weather/lightning.ts`) and kit weather a plain flash envelope (`weatherStrikeFlash`).
- Pitfalls: light the cloud, not the sky behind it (a sky lobe at ×0.25 of the flash glowed through the cloud; now
  ×0.02). Copying real restrike timing into the scene light makes a strobe. The bolt goes in the reactive mask so TAA
  doesn't average the flicker away. Strike now lands 220–420 m out because the Lot's sky dome is ±699 m.
- Research: `~/code/home/artifacts/lot-2026-10-20/storm/RESEARCH.md` (NOAA, Rakov & Uman, WCAG G15).

**Forest storm (`barbara-looks`).** The kit strike envelope under a canopy: `StormStrikes` (`weather/storm.ts`)
schedules strikes and emits each one's thunder with its position and arrival (slant / 343 m/s); `ForestStorm`
(`forest/storm.ts`) lights the forest from the channel as a directional light through a spot shadow map from the
strike's direction (so trunks and crowns cast), adds a dim cloud dome (×0.35 on surfaces, so the floor doesn't go
milky), draws far channels scaled inside the far plane so they show through canopy gaps, and darkens the eye after the
flash (`EyeAdaptation`, 1.6 EV, ~3 s recovery) while the forest's own meter holds. Rain uses the weather layer's
light-volume mode, so drops appear only in torch beams, window and porch cones and the flash; drips fall from the
nearest crowns' lowest branches. BARBARA's thunder goes through its own soundscape with travel delay.
- Where: `packages/kit/forest/storm.ts`, `packages/kit/weather/storm.ts`, `games/barbara/src/looks.ts` (Storm coming,
  Downpour), `games/barbara/src/audio/storm.ts`.
- Cost: Downpour vs Today at the camera-lab spot (mini Metal, 1600×900, 12-frame median, two runs): +0.6–1.4 ms High,
  +0.3–0.4 ms Low.
- Kit: asked for it with restraint (dark between flashes, no milky wash). First pass at 1.5 lx flash and a full cloud
  dome lit the whole floor grey; shipped at 0.9 lx (Downpour 1.1) with the dome at ×0.35. Awaiting his pick.
- Pitfalls: the forest's scene units make a full moon (0.25 lx) about as bright as a torch pool, so flash "lux" is
  relative to the moon, not to real lightning (10–100 lx would wash everything).

**Shared shelter and wind.** One list of sheltered rects and dripping eaves drives rain, wetness and sound
(`games/lot/src/weather/shelter.ts`); the weather's gust (`evaluateWeatherGust`) drives forest sway.

## Foliage and forests

**Kit foliage.** Clump-correlated curved grass, opaque leaf mounds under scalloped rosettes (no see-through gaps from
above), a travelling gust field, actor trampling and thin-leaf translucency in the torch
(`packages/kit/gpu/foliage.ts`). Outbreak, Lab.

**Tree looks.** Outward-normal leaf-card clusters over gnarled, kinked limbs (`packages/kit/gpu/foliage-looks.ts`).
- Where: Outbreak (`games/outbreak/src/vegetation/trees.ts`).
- Cost: +0.4–0.5 ms.
- Kit: D-42 picked look 4, Darkwood Diablo Blend: "dense dark leaf-card crowns over twisted limbs; colour only in the
  torch beam". D-41 (twelve reference looks) was replaced by D-42 once three ran in engine.

**Massed forest with cross-faded LOD.** Per-variant card models at two levels plus one impostor per far tree,
complementary Bayer cross-fades shifted every frame (TAA resolves them), far crowns thinned and grown so coverage
holds, and Ashwood's inner-crown shade.
- Where: `packages/kit/gpu/forest.ts`. Lot.
- Cost: within noise of Today (Studio, Lot title camera).
- Kit: "his trees are thicker and kind of connect, make a better silhouette".
- In progress: the woods forest renderer, `packages/kit/forest` on branch `woods-look` (not merged).

**Rule-based ground clutter.** Weeds at fence bases, litter at kerbs, gravel in gutters, with padded keep-outs for
lanes, doors and colliders; raising a density only adds items (`packages/kit/sim/debris.ts`). Lot.

- Pitfalls:
  - Alpha cutouts with hard discard shimmer and cast no shadow (woods research). Filtered alpha-to-coverage thinned
    the Lot's distant fence and was rejected.
  - Trees must stay out of houses (Outbreak). Fallen logs read as boxes and spruce cards as a sawtooth (woods Scrawl).
  - Uniform tree spacing, scale and rotation look planted; cluster them.

## Materials and wear

- **Scanned surfaces beat procedural noise.** The Lot imports CC0 scans and bakes Ashwood's tints and roughness; its
  interior adds world-space wear, wall sheen and wax (`games/lot/src/interior/finishes.ts`); Night Shift uses CC0 PBR
  sets. The woods research ranks scanned ground and bark first. Delight the scans and keep AO separate.
- **Footprint-filtered procedural recipes.** Seams and grain fade to their mean before they alias, and unresolved
  normal variance goes into roughness (`packages/kit/gpu/surface-materials.ts`). Take derivatives at fragment entry,
  before branches.
- **Mips that keep variance.** Normal mips keep their shortened length as roughness (`packages/kit/gpu/normal-mips.ts`);
  colour mips filter in linear light, alpha-weighted (`packages/kit/gpu/image-mips.ts`; a correctness fix, not a
  shimmer fix).
- **Generated textures and props.** Flat-diffuse WebP texture arrays (`packages/kit/textures/`), TRELLIS props with
  baked vertex colour and AO (`packages/kit/props/`), worker-baked rugs (`packages/kit/textures/rug.ts`). Outbreak.
- **Painted ground.** Dirt drifts, stains with dark rims, scuffs and cracks at 0.4–3 m, each fading with the pixel
  footprint (Outbreak `games/outbreak/src/ground.ts`).
- Pitfalls: coplanar trim makes moving patches (Night Shift partition rails); noise octaves and bump normals must fade
  by footprint. Not built: triplanar wear on props and cars.

## Glass and interiors

**Grounded camp construction (BARBARA).** Wider closed-riser steps meet the terrain, four corner posts leave
the entrance clear, and a framed door and firewood stack give the porch a use. Centred scanned stones surround
textured ash, charcoal chips and charred logs. Camp wood stays matte; paths blend through the terrain material.
- Where: `packages/kit/forest/build.ts` and `shaders.ts`, behind `campDetail`; enabled by the BARBARA adapter.
  The shared kit default stays off and the setting remains available to Looks presets through a world rebuild.
- Cost: approved camp pose, triangles 780,622 → 789,329, draws 468 → 468, lights 21 → 42. Rough shared-Pro
  timing ~20 ms for the candidate is unpaired and does not establish incremental cost. No new render pass.
  Game lights pack before camp under the 64-light limit (`forest/lights.test.ts`).
- Kit: approved rounds 8–11 as the default, including the remaining faint paths, less visible tabletop and
  lower fine detail than the targets. [Evidence and port status](../perf/woods-autoresearch.md).

**Thin glass.** Fresnel reflectance is also the opacity, so a pane is nearly clear face-on and a mirror at grazing;
grime and condensation raise roughness and scatter light from both sides; faces looking into a lit room reflect the
room.
- Where: `packages/kit/gpu/materials/glass.ts` (`thinGlassHooks`). Lot booth and interior panes; rain on glass rides
  the same pass.
- Cost: within noise (≤ 0.3 ms, `pro`).
- Kit: "you can't see through the glass in ours, but in his you can" (AR-110).
- Pitfall: the pane frame comes from screen derivatives, so the Lot's interior panes need per-face affine UVs
  (`games/lot/src/interior/pane-uvs.ts`).

**Rooms behind windows.** Interior mapping: a ray–box room behind each lit pane re-projected onto a pre-lit room
image, with blinds and mullions, so windows read as rooms with depth and parallax.
- Where: `interiorWindowHooks` in `packages/kit/gpu/materials/glass.ts` with an 8-room atlas painted by
  `scripts/textures/paint-rooms.ts`; Lot (+0.1–0.3 ms). Outbreak has its own analytic room with no atlas
  (`games/outbreak/src/window-rooms/`, free).
- Kit: D-51 picked rooms behind glass for Outbreak.
- Pitfall: far mullions need exact box coverage, not a one-pixel smoothstep, or they flash as they cross pixel centres.

**Mirrors.** Outbreak's floor mirrors intersect the reflected ray with the floor plane and people's cylinders in
their own fragment shader, aged with foxing and cracks (`games/outbreak/src/reflections/mirror.ts`): +0.90 ms in its
first build.

## Camera, lens and post

- **Highlight shoulder that preserves RGB ratios (BARBARA).** Above scene-linear peak 1, map the peak through
  `1 - (4/9)/(1 + .75*ln(peak))` and scale RGB together. Value and slope meet the old curve at the knee, so the
  hotspot rolls off without bleaching the bark or shifting its hue.
  - Where: `packages/kit/forest/post.ts`; `highlightShoulder` in `forest/settings.ts`, enabled by BARBARA's
    `games/barbara/src/world-view.ts` adapter. The kit default stays off. Kit approved the game default.
  - Cost: scalar logarithm and RGB scaling in the existing composite, no pass or texture. Isolated GPU delta
    unmeasured; the earlier whole candidate camp was roughly 12–13 ms on mini/Metal at 1600×900 High, not the
    shoulder's cost. Same operation on all tiers.
  - Proof: fixed near-bark clipping 9.52% → 0%, hotspot detail .001762 → .009900 at equal exposure .354.
    See [Woods round 7](../perf/woods-autoresearch.md#round-7-source-filtered-bloom-and-camp-delta-2026-10-22).
- **Contain bloom at the source (BARBARA).** The scene writes a negative HDR-alpha mask on nearby rough, non-emissive
  surfaces. Limit those source taps before the first bloom downsample; bulbs, windows, torch lenses and the held
  map retain their halos. Never cap the final bloom by the destination pixel's radiance: halos fall on dark air.
  - Where: `packages/kit/forest/shaders.ts` and `forest/post.ts`, through the optional
    `PostFinishOptions.bloomSource` hook in `gpu/{look-shaders,shaders}.ts`. Kit approved round 7 for Woods.
  - Cost: existing alpha channel and 13 source-tap tests/scales; no extra pass, texture or sample. Isolated GPU
    delta unmeasured. Other consumers' generated WGSL is unchanged when the hook is unset.
  - Proof: trunk-edge excess over no-bloom falls 94.6%; bulb/torch halo display-luminance contributions remain
    .187510/.027323. The mask is full within 3 m, fades to 6 m, and skips roughness below .4 to preserve reflections.
  - Pitfalls: MSAA and source filtering mix tags at silhouettes, allowing a small fringe and partial attenuation
    of subpixel emitters over tagged surfaces. Broad head-on torch haze remains even with bloom off.
- **Grade from received light.** Outbreak drives selective colour from the irradiance written into HDR alpha, with
  unlit saturation at 0.06 (`games/outbreak/src/look/world.ts`). Tonemappers, split tone, halation and grain are in
  `packages/kit/gpu/look.ts`.
- **Grain and dither.** Midtone-masked grain and a dark-gated 8-bit IGN dither keep twilight gradients from banding
  while black stays clean (`packages/kit/gpu/look-shaders.ts`).
- **Lens.** Night Shift's edge softness, bright-source fringe, midtone grain and a restrained vignette on the existing
  bloom (`games/nightshift/src/polish/lens.ts`).
- **Camera filters.** iPhone, VHS camcorder, CRT TV and body cam, each with its own knobs, as a final pass after the
  composite; the body cam also changes the rig (fisheye from a wide render, chest mount, torso lag).
  - Where: `packages/kit/gpu/post/camcorder.ts`, `packages/kit/client/bodycam-rig.ts`. Night Shift, Lot, Outbreak
    (no body cam). Off by default; off builds nothing.
  - Cost: Studio 0.14–0.27 ms, `mini` 0.23–0.47 ms.
  - Kit asked for them: "it would make everything else look realistic, like that body cam game" (AR-125).
  - Pitfalls: the filter runs after tonemapping, so it can't recover clipped highlights; don't stack its exposure
    hunting on another exposure controller. VHS and CRT are period looks, not a realism upgrade (woods research).
- **Lens and codec artifacts.** Eight switches around the camera filter, chained lens → filter → codec with
  `FinalPassChain` on `Renderer.setFinalPass` (all off composites straight to the canvas): compression starvation
  (macroblocks, banding and stale blocks while moving, a 1 s quality pump), autofocus hunting (waits, starts the wrong
  way, overshoots, settles; focus breathing), sensor gain (luma/chroma noise and denoise smear that grow in the dark),
  LED PWM banding (friends' torches through a rolling shutter), lens flare (ghosts plus a six-blade starburst from
  torches pointed at the lens), lens dirt, condensation, infrared monochrome. Eyeshine (retroreflecting eyes in your
  beam, from the shared distant-sound events) and an IR lamp at the lens are woods scene pieces.
  - Where: `packages/kit/gpu/post/camera-artifacts.ts`, `final-chain.ts`; woods `src/camera-look.ts` (presets Eyes,
    Body cam night, Camcorder NightShot, Phone night mode, VHS), `src/eyeshine.ts`, station `woods-camera`.
  - Cost (`mini`, 1600×900 High, against Eyes): each effect a small fraction of a millisecond; the full looks under a
    millisecond, NightShot and phone the heaviest. Off builds nothing.
  - Kit: "What are some interesting rendering effects, like the bodycam etc., that could make this look cooler… to
    make it feel realer?" Contact sheet: gallery `woods-2026-10-21/camera-lab/`.
  - Pitfalls: flare needs sources projected from the torches, not a bright-pixel threshold, or every lit trunk ghosts;
    the PWM band is subtle at a few hundred hertz, so its depth is a knob.
- **Restrained walking camera.** Contacts come from actual displacement with critically damped presentation
  (`packages/kit/client/walk.ts`, `walk-camera.ts`). Night Shift, Lot. Woods research: 0.5–1.5 cm translation and
  0.1–0.35° roll tied to contacts, no idle sine.
- Research: woods `RESEARCH.md` §F (vignette 5–12 %, chromatic aberration under 0.3–0.7 px at the edge, no DOF while
  navigating, exposure correction 1–2 stops at most).

## Temporal stability

- **TAA and upscaling.** Halton jitter, depth reprojection, a YCoCg variance clip, a reactive mask and RCAS
  (`packages/kit/gpu/temporal.ts`). Outbreak option (MSAA stays the default): TAA + upscale 0.67 saves 2.6–3.9 ms;
  TAA at native costs 0.6–2.9 ms. Passes in the scene take the jittered camera from the frame binding.
- **Signed metadata needs signed history.** `gpu/temporal.ts`'s `sampleHistory` currently clamps all four channels
  to >= 0 after Catmull–Rom sampling. Current-frame alpha is signed, but history loses Woods' negative bloom mask
  and Outbreak's negative flash mask. The later neighbourhood clamp restores a uniform negative area; at mixed
  edges, especially during motion, positive history weakens suppression. A fix should clamp RGB only and retain
  alpha until the existing neighbourhood clamp, with a moving-edge regression covering both signed masks and
  nonnegative roughness/shroud consumers. Left unchanged in the camp pass: cross-game temporal verification is
  broader than a cheap local fix, and settled stills do not prove that behaviour.
- **History in motion.** Volume slots keep their history while the camera moves, clipped to mean ± 1.25σ and blended
  in a luminance-compressed space (`VolumeInput.moving`). Exception: the fog's in-scatter follows the view ray, so a
  kept fog history made the Lot's booth halo jump; it stays at 1.
- **Footprint filtering and specular AA** everywhere a pattern can drop below a pixel; LEAN for glints.
- **Fades instead of cuts:** lamp reach (Outbreak), spot-shadow reach (`SpotSlot.reach`), Bayer LOD cross-fades.
- **Jitter pattern.** IGN slid 5.588 px a frame; golden-ratio offsets left a diagonal pattern in converged wet
  reflections. A per-frame sliding fence dither scored worse than a fixed one.
- **Measure it.** `games/lot/scripts/motion.ts` and `games/outbreak/scripts/motion.ts` report reprojected pops per
  frame and block flashes on scripted paths, with world-anchored regions. Copy the WebGPU canvas in the same task as
  the render (a presented canvas reads back black); score a lamp halo with a region moved by the lamp's own screen
  motion, because its depth is the sky.

## Quality tiers and auto quality

- **Kit tiers.** `packages/kit/quality.ts` (`AdaptiveQualityController`, `QUALITY_PROFILES`) and
  `packages/kit/client/quality.ts` (`GameQuality`): High, Balanced, Low and Auto. Auto starts at full Retina, sheds
  pixels when 12 % of frames miss with the GPU at least half busy, and never adds pixels on a tier drop. Getaway,
  Blackout, Brawl, Carrier and Outbreak draw through it; the Lot and Night Shift don't yet.
- **Tiers carry looks.** Outbreak's tiers (`games/outbreak/src/quality.ts`) also set the mist, contact shadows, bounce
  grid and soft-shadow lights; each Lab setting defaults to "Quality tier" (-1) and an explicit Lab value wins. High
  sheds a little resolution (`minScale` 0.85), then steps to Balanced, because the cheaper looks cost less than more
  lost pixels. On the mini at 4K 2×, the crossroads costs 20.5 ms at High 2×, 15.8 ms at High 1.7×, 11.5 ms at
  Balanced 1.5× and 6.7 ms at Low 1×; Auto settles on Balanced 1.5× after one change.
- Pitfall: headless timing at 4K is unusable (Chromium copies the canvas back every frame, ~5 fps), so time the GPU
  per tier and replay the controller (`games/outbreak/scripts/auto-quality.ts`).

## Audio realism

- **Quiet material footsteps.** Seeded contact PCM for twelve surfaces (carpet, concrete, tile, wood, asphalt, wet
  asphalt, puddle, gravel, dirt, grass, wet grass, mud) scheduled from actual displacement, so walls never make
  footsteps (`packages/kit/audio/footsteps.ts`). Night Shift and the Lot. The Lot picks the surface from its triangles
  and wetness from the puddle mask (`games/lot/src/surface-query.ts`, `foot-surface.ts`).
  - Kit: "The step sound effects are not good for Night Shift. They are way too loud." Contacts now sit 24–29 dB below
    the old bank.
- **Night ambience.** Seeded wind, traffic, fixture buzz, HVAC, drips and distant wildlife synthesized into loops
  (`packages/kit/audio/ambience.ts`, moved from the Lot).
- **Storm sound.** A quiet surface bed under positional car, booth-roof, gutter and drip emitters; thunder scheduled at
  distance / 343 m/s with crack, body and roll by distance, a distance lowpass, bearing pan and two facade echoes, all
  behind a limiter and muffled indoors (`games/lot/src/weather/audio.ts`; `weather.*` library ids, ElevenLabs).
  Research: Alan Wake 2 (900 placed surface emitters), keep thunder out of rain loops, keep the bed below the detail.
- **Light and sound from one signal.** Night Shift's ballast hum and starter crackle follow the same `tubeSignal` as
  the tube's light.
- **Outbreak's mix.** Six buses, 11 surface materials and voice priority: [audio-design.md](audio-design.md) §4.
- Never play sound aloud for tests: render offline (`packages/kit/audio/offline.ts`).

## Research

- Storm (rain, wet BRDF, lightning, thunder, flash safety): `~/code/home/artifacts/lot-2026-10-20/storm/RESEARCH.md`.
- Night forest (scans, flashlight photometry, mist coefficients, camera treatment, asset licences):
  `~/code/home/artifacts/woods-2026-10-21/RESEARCH.md`.
- Web survey (Tidewater, web-ocean, Neon Zenith, three.js nodes, radiance cascades) and the Ashwood comparison:
  `~/code/home/artifacts/agent-reports/gfx-research.md`, `engine-comparison.md`, contact sheet
  `~/code/home/artifacts/gfx-research-2026-10-20/index.html`.
- Camera filters (VHS, CRT, body cam sources): `~/code/home/artifacts/agent-reports/camera-filters.md`.
- Licence rule: MIT, CC0 and Unlicense code may be ported with credit; GPL and CC BY-NC-SA work is technique only.
