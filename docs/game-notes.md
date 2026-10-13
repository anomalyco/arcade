# Game notes

Techniques that have worked in one arcade game and should carry to the others. Add an entry once something is proven:
what it does, where it lives, and what it measured. Mark candidates that have not been measured or playtested yet.
Shared code that bakes these decisions in is tracked in `docs/shared-code.md`.

## Proving a change

- **Measure before you edit.** Record a baseline on the unchanged code, then make one change at a time. Use one warmup
  and seven or more measured runs, and compare medians with their spread. Results go in `perf/results.jsonl`.
- **Separate GPU time from frame time.** Frame time is capped by vsync. Use `timestamp-query` where the adapter has it,
  and `device.queue.onSubmittedWorkDone()` otherwise.
- **Headless Chromium on a Mac can use Metal.** Launch it with `--enable-unsafe-webgpu --use-angle=metal` and check that
  `adapter.info.architecture` is not SwiftShader before trusting a number. Linux headless only has SwiftShader.
- **A performance pass must not change the look.** Compare before/after stills of the same seeded frame. If they differ,
  the change is a look change and needs its own review. (Getaway: a widened helicopter spotlight slipped into a perf
  pass; the tight original read better.)
- **Expect machine noise as large as the win.** On a shared machine, one Blackout run measured 10.0 ms against a real
  5–6 ms; a confirmation round without code changes came back at 5.8 ms. Alternate the variants in pairs, keep raw
  runs and outliers, and never claim a win inside the spread.
- **Read timestamps only after they resolve.** Queue completion does not mean the timestamp readback finished; await
  the readback before clearing samples. Render-pass timestamp ranges can overlap, so don't sum per-pass times into a
  total.
- **Keep invalid measurements as labelled diagnostics.** Getaway's initial Look report called a -0.154 ms paired
  pass-sum delta a total GPU saving. That claim is withdrawn: overlapping pass ranges invalidate the total, and
  individual-feature spreads also exceeded several apparent changes. `perf/getaway-look-paired.json` retains the
  raw runs; valid total and per-feature GPU costs remain unverified. The 180 matching route poses and visual captures
  still establish the comparison's simulation agreement and appearance.
- **Seeded, enemy-free play for comparisons.** `?peaceful=1&seed=N` gives a fixed world with no enemies acting, so two
  builds can be played side by side with the same input. Getaway's `games/getaway/src/game/session.ts` keeps the
  simulation in its free-driving phase and supplies a chase HUD view. Two scripted 3,600-frame runs at 60 Hz with
  seed 7 produced identical final car views, with zero cops, busts or round endings. Runtime cost is unmeasured.
- **Acknowledged comparisons in both games.** `packages/kit/compare.ts` queues input at 60 Hz tick boundaries and
  waits for the follower's acknowledgement before advancing. Blackout uses BEFORE's pose; Getaway uses AFTER's
  complete view and camera state, including simulation time, so vehicle physics and light clocks cannot drift.
  Both actual historical/current preview pairs passed 18,010 paired ticks (300.17 simulated seconds) with zero pose
  mismatches, input from either iframe and the parent, equal full-width wipe viewports, and matching seeded resets.
  `games/blackout/scripts/prove-compare.ts` accelerates only the parent clock; iframe rendering and message delivery
  remain real. This proves tick agreement, not simultaneous display presentation or pixel-identical graphics.
  Messaging cost is unmeasured; concurrent GPU timings are live diagnostics, not isolated optimization benchmarks.
- **Measure both renderers through the device.** `packages/kit/gpu-perf.ts` counts submitted draws/vertices and samples
  every tenth command encoder with render/compute timestamp pairs. Without timestamp-query it reports explicitly
  labelled queue-completion latency. Both games post frame percentiles, GPU time, counts and player position every
  150 ms. Baseline hooks use the same instrument without editing either historical renderer or shader: all 28
  baseline rendering files matched their saved hashes. Split and wipe screenshots live in `captures/preview/`.
- **Acknowledged fixed-tick comparisons.** Blackout's `games/blackout/compare.html` queues input at tick boundaries,
  advances BEFORE, then advances AFTER with BEFORE's authoritative position, velocity, aim and target. Rendering runs
  independently in `games/blackout/src/main.ts`, so the simulation handshake does not cap the frame-rate readout.
  The actual historical BEFORE and current AFTER previews completed 357 paired ticks in Chromium on Metal with zero
  mismatches across all seven state fields. Both loaded seed 1 at (51.75, 2.75), kept the player centred, accepted
  WASD/Dvorak input from either pane and the parent, fired from either pane, and returned to the same spawn after reset.
  Messaging cost is unmeasured.
- **Verify both ends of the comparison protocol.** A working AFTER client cannot compensate for BEFORE using old
  message names, omitting the ready/step acknowledgements, or sending incomplete perf fields. Blackout's initial
  same-client proof missed those baseline incompatibilities. `games/blackout/compare.html` now validates protocol,
  floor and spawn before stepping and gives each reset a fresh run ID. Both clients ingest their initial snapshot and
  centre the camera before announcing readiness, even while the other pane is loading.
- **Passive targets around the existing simulation.** `SandboxSession` in `games/blackout/src/game/game.ts` supplies
  idle bot brains and refills the human's ammo while using the normal world rules for hits and deaths. Seed 1 produced
  identical initial player snapshots in two sessions. A script checked 300 idle ticks with stationary bots and no shots,
  an actual kill with a two-second respawn, 240 firing/reload ticks with ammo remaining and no reload delay, and the
  passive/live toggle. `tests/sandbox.test.ts` now verifies five idle minutes and respawning at the original dummy
  position/aim; explicit peaceful mode prevents the B shortcut from reactivating bots. Runtime cost is unmeasured.

## Rendering (WebGPU)

- **Bake fine window coverage separately from soft AO.** Blackout's 12.5 cm moon mask, 18.75 cm blocker march and
  box blur created stepped diagonals and cloudy mullion bands. Exact world-space segment/rectangle intersections and
  2×2 coverage samples in a separate 3.125 cm R8 moon mask fix those edges without changing AO bytes. This costs
  1.60–1.85 MiB and an extra 31–56 ms once per level for the two office seeds tested. One extra filtered sample added
  no measurable GPU cost in the 1440p M5 Max wood-room fixture (median −0.00048 ms, MAD 0.00249). See
  `perf/blackout-window-light.md` and `scripts/window-proof.ts`; motion/Look toggles produced identical movement poses.

- **Filter polar visibility across rays.** Blackout's five sparse nearest-ray shadow samples produced repeated radial
  silhouettes on floors and tables even with the Look pass off. Nine weighted, interpolated visibility taps with
  world-anchored sub-stratum offsets remove the coherent bands without a fullscreen blur. Never interpolate blocker
  distances across silhouettes. `src/render/shaders.ts`, `perf/blackout-shadows.md`; all-off remains RGB-identical to main.
  This is a quality/cost tradeoff: the 1440p office paired delta was +1.341 ms (MAD 0.282).
- **Motion history belongs to submitted frames and stable owners.** Blackout's opt-in MRT velocity path tracks actor,
  projectile and vehicle parts by weak owner/model/part identities. Coalesced builds do not advance history; gaps,
  teleports and resize reset it. Eight depth-aware samples run in the existing composite, before the DOM HUD. The
  1440p M5 Max paired deltas were +0.060 / -0.312 / +0.237 ms for office/downtown/lot, with MAD
  0.345 / 0.896 / 0.273. The sub-0.5 ms target is unproven under that variance. See `perf/blackout-motion.md`.
- **Fast projectiles need a flight-aware continuity threshold.** Blackout's 240 m/s tracers crossed the original
  4-metre actor teleport threshold at 60 Hz, suppressing their velocity. Transient keys now carry an emission point
  and 32-metre threshold; casings and sheets also get stable keys. A 1/60 shutter, 1.25-pixel dead zone and 32-pixel cap
  make fast motion visible while slow camera following stays sharp. Tracked flash/tracer quads sweep their trailing
  edge so their narrow silhouettes can streak. `scripts/motion-demo.ts` matches vehicle, camera and effect states for
  an actual passing car and close-zoom shotgun kill/throw. Cost of this tuning is unmeasured; blur stays default off.

- **Randomize through the shared control path.** `packages/kit/lab-panel.ts` randomizes each named group's ranges and
  selects, retaining slider step alignment and option value types. It applies hidden-by-dependency values too, then
  refreshes enablement and readouts. Metal checks covered minimum/midpoint/maximum draws, all 12 light sliders and the
  five-style select, exact Copy JSON, input isolation and unchanged switches/other groups. A generic fixture checked
  string options and a non-divisible range (0.05–1, step 0.1 → maximum valid 0.95). Approved defaults remain unchanged.

- **End tilted beams below the receiver.** Getaway's perpendicular cone rim had a raised half that ended across
  the spotlight pool. Removing the beam in a Metal capture removed the seam. `game/scene.ts` now extends each rim ray
  below the road, so the existing world-height fade reaches zero before the geometry ends. The 7.5 m pool and 0.0025
  cone feather are unchanged. The contact shadow also has a smaller rounded footprint, a lower peak opacity and
  stronger clearance fading in `render/shaders.ts`; its half-width grows from 1.482 to 2.372 m at the captured 3.26 m
  jump, while opacity falls from 0.82 to 0.46. `scripts/prove-fixes.ts` captures the exact `b0a9446` module bodies and
  current code with matching static/jump poses and spotlight uniforms. No passes or draws were added; runtime cost
  is unmeasured. Stills and the no-beam diagnostic are in `captures/getaway-fixes/`.

- **Presentation comparisons belong in the Lab.** Getaway exposes car-light styles, vehicle-emission visibility and
  cold exhaust through the shared `packages/kit/lab-panel.ts`, alongside its chassis controls. The panel's generic
  select leaves All On/Off restricted to toggles and keeps keyboard/pointer input out of the game. Switching light style
  replaces the existing model buffers, retaining wheel contacts and spring state. A Metal check switched eight times
  with 42 model slots throughout, unchanged chassis identity and no page/console errors; cold exhaust emitted wisps,
  bulk toggles preserved the light choice, and regular URL style overrides had no effect. `bench`/`mux` overrides remain
  for automation. This supersedes the query-selected light study instructions below; switching cost is unmeasured.

- **Keep sprite kinds distinct when combining studies.** The integrated car-light and exhaust paths both originally
  used kinds 10 and 13. Exhaust retains 10 (cold condensation) and 13 (attached flame); car-light footprints, lenses,
  lens streaks and brake streaks use 14–17 in `game/scene.ts` and `render/shaders.ts`. On the combined Metal preview,
  drift and standing nitro emitted 312 and 74 smoke samples, and the 16 posed light-style cases passed their packed
  position/direction checks. Moving brake/kerb fixtures and cruiser/SWAT sirens also passed. Startup red stayed within
  42.45–42.83, with no page or console errors. Runtime cost of this integration has not been measured.

- **Getaway's approved presentation is permanent.** The six Look effects and eight driving effects now run without
  switches or `vanilla`/`off` overrides. The Lab retains its frame/GPU readout and input isolation, with no empty preset
  buttons. Spotlight radius is the original 7.5 m with 0.0025 cone feather. The removed Wet Road setting stored 0.55,
  but Flatter Ground already overrode it to 0.035; retaining 0.035 preserves the approved matte image. Two unused
  frame-uniform vectors and the alternate colour-grade path were removed. `scripts/prove-look.ts` checks the retained
  Lab on Metal; the historical switch experiment remains in git history. Performance cost remains unmeasured.

- **Bake shop-spill footprints and room colours.** Getaway's `render/city/building.ts` records footprints only for
  lit street-facing shops; `game/scene.ts` draws nearby footprints in the existing additive batch. `render/mesh.ts`
  stores room tint in unused window UVs for vertex shading. Metal stills show sidewalk spill and window variety
  without added dynamic lights or texture fetches. Default on for visual review; valid GPU cost is unverified.
- **Reuse ground decals for contact.** Getaway's `game/scene.ts` and `render/shaders.ts` draw building-foot strips,
  tree-base discs and a car shadow wider than the body with stronger wheel patches. A grid-distance term darkens curb
  feet. The matched-frame sheet shows the result; Grounding defaults on pending Kit's playtest. Valid GPU cost is
  unverified. Both techniques and the diagnostic pass-sum timings are documented in `perf/getaway-look.md`.

- **Live presentation labs.** `packages/kit/lab-panel.ts` stops pointer, mouse, wheel, touch, and keyboard bubbling
  and releases gameplay input on pointer down. The two `src/ui/debug-overlay.ts` adapters expose only enable/disable
  rows, All On / All Off, and compact FPS/frame/GPU telemetry. Getaway's rendering switches select baseline or enhanced
  constants; disabling road sheen and spotlight changes restores the original values. The comparison runs vanilla
  BEFORE and recommended AFTER while synchronizing player state. Getaway layers local camera effects over the
  synchronized camera without putting those offsets into the message protocol. The earlier historical/current proofs completed
  626 Blackout and 628 Getaway paired ticks with zero pose mismatches and matching seeded resets. `bun run check`
  passed 188 Blackout tests and 106 Getaway tests (12 existing skips), typechecks, and production builds. Evidence:
  `captures/preview/*-lab.png`, `*-lab-proof.json`, and `*-compare-proof.json`. Performance impact is unmeasured.
- **Tune baked lighting without rebaking per frame.** Blackout retains the linear irradiance arrays from monitor-on
  and monitor-off bounce bakes. Intensity changes recombine those arrays and upload the existing bounce texture once;
  ordinary frames keep the same single bounce texture sample. Chair-shadow changes invalidate the culler's static
  occluder cache only when the switch changes. `tests/lighting.test.ts` checks chair restoration, zero-intensity removal,
  tight 1.65 m direct cones, and the zero-occluder monitor suffix. No new sub-0.05 ms claim is made for the Lab build.

- **Shadowless practical lights still need pixel culling.** Blackout's desktop monitors use a 1.6875 m direct radius,
  no occluders, and a separate suffix in the packed light array. `LightCuller.shadowLightCount` restricts polar compute
  to the shadow-casting prefix; `lightSum` skips shadow sampling for zero-occluder lights. The wider cyan spill is
  baked into the existing bounce texture. A first seven-pair measurement still cost 0.115 ms east / 0.010 ms south;
  conservative bounds that skip the monitor suffix outside its footprint reduced those medians to 0.037 / 0.021 ms
  on the M5 Max, with considerable run-to-run noise. See `perf/monitor-lights.md` for the fixed-frame confirmation.

- **Keep `discard` out of the main opaque pipeline.** Apple GPUs lose hidden-surface removal for any pipeline whose
  fragment shader can discard. Draw opaque geometry with a variant without `discard`, and use the cutaway variant only
  for the chunks that touch the cutaway region. Blackout: GPU time 12.7 ms → 5.0 ms median across six views.
- **Chunk static geometry and cull it per pass.** Split level meshes into spatial chunks with bounds, cull each pass
  (main and shadow) against its own frustum, and merge adjacent visible ranges into one draw. Getaway: city vertices
  per frame 6.42M → 0.77M, frame time 72 → 38 ms in the 1280×720 benchmark.
- **One light loop.** Do diffuse and specular in the same pass over the lights, and reject a light on squared distance
  before any `sqrt`.
- **Sample textures only where they are used.** Compute `dpdx`/`dpdy` in uniform control flow, then call
  `textureSampleGrad` inside the branch that needs the texture.
- **Shadow early-outs must cover every filter tap.** A clear centre ray does not prove neighboring penumbra rays are
  clear. The Blackout center-only shortcut was rejected for visual parity. Exact per-tap early-outs are safe.
- **Back-face culling on closed meshes.** Keep `cullMode: "none"` only for single-sided or translucent geometry.
- **Snap orthographic shadow cameras to texels** so shadow edges don't shimmer while the camera moves.
- **No per-frame allocation.** Cache `GPUTextureView`s on resize, upload contiguous instance data in one
  `writeBuffer`, and reuse typed arrays instead of building maps and arrays each frame.
- **Static shadow caches need measured reuse.** Getaway's snapped X/Y projection still changes depth translation on
  every moving frame: 180 distinct matrices in every seven-run sample. Exact-matrix caching would add a depth copy
  without avoiding a pass on this path (`perf/getaway.md`).
- **Getaway early-Z split was not a clear win.** Opaque/cutaway pipelines with separate alpha chunks measured
  38.254 → 37.308 ms (inside MAD), with increased CPU submission cost; reverted (`perf/autoresearch.md`).

## Art direction

- **Blackout's C look pass** (`games/blackout/src/render/shaders.ts`, `lighting.ts`, and the Lab's Look group).
  A darker teal shadow grade, reduced colour fringing and grain, warm-white tubes, amber desk lights, tan wall faces,
  stronger baked contact AO, blue cap bevels and more visible floor pattern move the seeded office frame toward C.
  The city material uses warm/cool window variation and soft window footprints to suggest distant defocus. This costs
  shader terms rather than a fullscreen depth/blur pass; it does not add building geometry. All seven default on.
  Tile gloss and longer furniture shadows remain separate opt-ins because their benefit in this view is small.
  Office material changes are gated by map kind; downtown receives only the grade. Smoke and particle logic are unchanged.
  At 1280×800 on M5 Max Metal, one warmup plus seven alternating pairs measured all-on total GPU deltas of
  +0.071 ms office (MAD 0.077), -0.009 ms downtown (MAD 0.034), and +0.024 ms vehicle lot (MAD 0.020).
  These are noisy cost estimates, not speedups. Each switch's paired samples and added work are in
  `perf/blackout-look-paired.json` and `perf/blackout-look.md`; CPU and pipeline-creation costs remain unmeasured.
- **Exact Look-off needs the original shader arithmetic.** Blackout's first uniform-disabled shader still differed
  from main by a few one-code-value pixels. Shader overrides reduced the error but did not eliminate it. The shader
  factories now omit Look terms entirely for the baseline pipelines. Main and Look-off stills match every RGB pixel
  in the office, downtown and vehicle lot at the same seeded frame. Baseline normalized WGSL also matches main.
  `games/blackout/scripts/look-proof.ts` captures those frames and rejects invalid hardware timestamps; the benchmark
  uses first-pass start to composite end, awaits readback, and never sums overlapping pass intervals.
  The production/current comparison completed 181 paired ticks with zero pose mismatches and passed the nine Look
  switches and All On/Off controls. Its left pane preserves main's existing presentation defaults rather than forcing
  the older vanilla preset.

### Shipped tyre smoke and launch wheelspin (v2)

Getaway now has one tyre/exhaust path. The shipped renderer is the former **6, advected billows**; its soft wheel
sources read better in the inspected motion than the shallow raymarched alternative. The style selector, URL
selection, faceted puffs, cel sprites, ribbons, directional variant, density field and volume pipeline were removed.
Historical study reports below describe earlier commits; their experimental capture scripts are no longer shipped.

`game/vehicle-emissions.ts` owns wheel-local heat and emission. A low-speed nitro press or high-throttle launch
starts at most 1.25 s of wheelspin. Releasing a held brake under full throttle also starts a launch burst. Strength
uses `accel / grip`, nitro strength, drivetrain and a speed envelope that reaches zero at 24 m/s. RWD uses full
strength, FWD 0.75 and AWD 0.45. Compact is FWD, Interceptor AWD, and unspecified cars retain rear drive.
Launch heat rises faster (6/s, about 95% in half a second), while normal drift heat still rises at 2/s.
The smoke and skid ribbons consume the same per-wheel slip value; straight braking alone makes neither.
The shared simulation still lacks wheel RPM/torque, so this is a presentation traction proxy, not a new handling model.

Two small realism changes are shipped:

- Smoke and skid emission stop on lawn. `tyreSurface` follows the park's 3.2 m grass inset and preserves its crossing
  paths, central paving and plazas. Wheel histories continue updating while inactive so road re-entry cannot bridge
  a track across the grass. Existing clouds can drift over a lawn. No dust/snow effect is implied.
- Practical-light tint is stronger, sampled at billboard corners for a gradual colour change across each puff.
  The bounded 32-light loop runs in the vertex stage, with cars and sirens packed before nearby street lamps.
  The captures show red tail/brake tint fading into warm lamp light. This adds no lights, shadow pass or fragment loop.

Skid ribbons use a fixed 1,600-slot buffer instead of per-segment objects. Per-car wheel positions are also reused.
The six capture routes peaked at 312 smoke samples for drift, 144 for burnout/launch and 74 for standing nitro.
Standing nitro produced 56 connected skid segments; the rolling nitro route produced zero smoke samples or skid
segments. All three cloud routes dispersed completely, and still/phone simulations matched on every recorded frame.

Paired whole-GPU measurements on M5 Max/Metal at 960×640 include tyre smoke, skid ribbons, exhaust sprites and pop
lights. The largest pose-median increment was 0.0846 ms (dispersing drift, MAD 0.0092 ms). Some other poses had
outliers over 1 ms; this is a median budget result, not a worst-frame or phone-GPU guarantee. Raw paired intervals,
coverage and reproduction are in `perf/getaway-smoke-realistic-v2.json` and `.md`.

The branch was rebased onto `getaway-look` at `5f9b839`, preserving its startup-clock fix and baked effects.
`vehicleEffects.coldExhaust` remains the single cold-preset integration setting. Evidence is in
`captures/getaway-smoke-realistic-v2/`: a 1440×1440 sheet and a silent 720×1280, 40.13 s, 8,001,888-byte
H.264 Main/yuv420p fast-start clip. Both were inspected, copied to Lamplight's preview folder and sent to Kit.

### Tyres, nitro and cold exhaust

Historical v1 study; the v2 section above describes the shipped path.

The connected study's boost cloud has been replaced by wheel-driven emission in
`games/getaway/src/game/vehicle-emissions.ts`. The default remains style 6; style 8 uses the same wheel sources
through its raymarched field. The look and preset code has no dependency on this policy.

- **Two wheel sources, then one cloud.** Each rear wheel has independent position, distance remainder and heat.
  Current vehicle specs have no drivetrain; the presentation defaults to rear drive (one rear source for bikes).
  `drivenMask` also understands optional `fwd`/`awd` specs. Popped and airborne wheels emit nothing. Heat reaches
  86% after one second of sustained slip, then decays when slip ends. Optical density scales with slip, rubbing
  speed and heat; fixed 0.36 m samples preserve continuity instead of making weak emission open spatial gaps.
  A stationary burnout uses a 14 Hz temporal top-up. The top-up subtracts the distance rate to avoid double emission.
- **Smoke stays where the tyre made it.** `smoke-trail.ts` inherits just 0.8% of car velocity, with drag, a
  city-seeded 0.45 m/s wind, analytic curl drift and gentle lift. Radius grows from 0.55 m to roughly 2.5 m;
  density falls as it grows. Lifetime is 4.5–5.3 s. The inspected drift has separate young bands, a merged older
  cloud, and an empty road by 8.2 s; the burnout leaves a cloud behind rather than dragging it along with the car.
- **Telemetry limits are explicit.** `CarView.drift` is measured lateral speed, not wheel RPM; `CarView.slip` is an
  oil timer and must not be used as tyre slip. Launch smoke uses high throttle, low speed and acceleration; burnout
  uses high throttle plus brake at low speed. Only the handbrake explicitly represents locked wheels. Ordinary
  straight-line braking does not smoke. Remote snapshots lack throttle/brake amount, so their drift/boost is visible
  but stationary burnout and lift-off cannot be inferred reliably. These are presentation proxies, not tyre physics.
- **Nitro is an attached flame.** A gripping boost run produced zero tyre-smoke particles across the entire capture.
  Short blue cores and a restrained glow follow the exhaust every frame and flicker with throttle. There is no
  persistent flame trail or boost cloud; the optional purge was omitted. Orange lift-off/shift pops last 0.11 s,
  have a 1.8 s cooldown, require prior load and skip every third eligible event. Shifts use speed bands because the
  simulation has no gearbox. The pops capture shows two events, with clear intervals between them.
- **Cold exhaust has one integration setting.** Import `vehicleEffects` from `game/vehicle-emissions` and set
  `vehicleEffects.coldExhaust = true` for a cold preset, false for warm presets. Default false; standalone preview
  also accepts `?coldExhaust=1`. Low-opacity tailpipe wisps live at most 0.85 s, shortened with speed to disappear
  within about 1–2 m. This is condensation, not tyre smoke or snow spray; snow appearance stays with the looks work.
- **Cheap and shadowless.** New simulation, instance and wisp storage is persistent. Flames/wisps reuse the existing
  additive/alpha batches; style 6 adds one smoke draw, with no normal-frame extra pass or smoke shadow draw.
  Peak counts were 312 tyre elements for the drift and 96 for burnout. On M5 Max/Metal at 960×640, paired
  whole-GPU deltas at the densest drift pose were 0.177 ms (MAD 0.0016); the active pop was 0.018 ms (MAD 0.0038),
  cold wisps about 0.008 ms, and nitro below reliable resolution. Other poses had substantial shared-machine noise.
  Raw pairs, total intervals and limitations: `perf/getaway-smoke-realistic.json` / `.md`.

Real tyre smoke includes condensed tyre-derived compounds and fine rubber particles; it is not simply water
vapour ([Street Machine](https://www.streetmachine.com.au/features/diy/how-to-make-coloured-burnout-smoke)).
The [BeamNG volumetric-smoke mod](https://www.beamng.com/resources/volumetric-smoke.38775/) is a useful reference
for heat-dependent wheel emission and restrained exhaust, but has richer wheel telemetry than Getaway.
[NIOSH](https://www.cdc.gov/niosh/npg/npgd0465.html) identifies nitrous oxide as colourless; the short blue flame
is a game readability convention, not a claim that nitrous itself burns blue. The selected warm-up, lifetime and
spread values are tuned visual targets, not universal measurements for every tyre, wind or snowy road.

Compatibility was checked with a three-way scratch merge against the current `getaway-looks` edits, followed by
the combined check. Smoke's legacy faceted material now reserves ID 12 so it cannot collide with windows/buildings
at 10–11. Smoke UI initialization and script entries are placed away from the preset additions. The other worktree
was read only. Snapshot hashes: `perf/getaway-smoke-merge.json`.

The GPU timer now joins the frame with a load/store of the same composite target before its ending timestamp.
An independent 1px marker was rejected: Metal scheduled it early and returned a negative interval. The dependent
marker's overhead is present on both sides of every pair; it exists only while benchmarking. No pass times are summed.
The prior connected-study report describes its historical offscreen-target measurement, not this newer timer.

Evidence: `captures/getaway-smoke-realistic/` contains the 1440×1380 sheet, silent 720×1280 H.264 Main/yuv420p clip
(31.6 s, 7,435,113 bytes), original stills, motion inspection, matching still/video route poses and paired GPU data.

- **Choose lighting in the Lab.** Backquote → Lights → Style switches between Reference, Recessed, Light bar,
  Cinematic and Soft pool while driving. Soft pool enables the 12 tuning sliders, and Copy JSON includes the style.
  The shared Lab supplies selects and dependent-control enablement. `Scene` replaces existing mesh buffers and changes
  both moving and parked cars without resetting the world. The Metal proof cycled all five styles, checked that
  repeated selections reused meshes, and confirmed that the car state survived every change. `lights=N` remains
  an automation override for repeatable captures; interactive comparisons use the panel.

- **Blend bumper beams into a tunable road pool.** Getaway's new default, Soft pool, shares one warm-white
  `HEADLIGHT` colour between mesh lenses, lights, glows, beams and pools. Sprite kinds 14 and 15 use smooth fades
  with zero-slope edges and no alpha discard threshold. The pool projects the posed lamp's aim onto road height;
  brake dive brings it closer. All mounted origins still use `bodyPoint`. The Lab's Lights group has 12 live sliders
  and a Copy JSON button; settings last for the current page session. Styles 0–3 retain their comparison values.
  `scripts/prove-car-lights.ts --v2 --pose` passed on Metal (`metal-3`): matched front/braking/gameplay stills for
  0, 1 and 4, three 180-frame straight drives of 56.94 m with no lateral drift, and 12 submitted body-pose cases.
  Every slider changed submitted lighting, its minimum remained finite, all 12 pointer interactions released game
  input, keyboard events stayed in the panel, and clipboard JSON matched the settings. No page/GPU errors occurred.
  `scripts/car-lights-sheet.py --v2` assembles the 1480×1190 sheet at `captures/preview/getaway-car-lights-v2.jpg`;
  raw frames and proof are in `captures/preview/lights-v2/`. The seeded one-car light count stays at 100, as in style 1.
  GPU-time cost remains unmeasured.

- **One body pose for the mesh and its lamps.** `src/game/car-pose.ts` uses the chassis branch's
  `bodyPoint(car, pose, local)` interface and the instance shader's roll → pitch → yaw order. Omitted height,
  roll and pitch default to zero; supplied height includes ground, flight and springs. `scene.ts` sends the same
  `pose` to the body instance and every car lamp glow/light, including the reference style, sirens, crash and backfire.
  Headlight direction comes from two transformed local points, so brake dive changes the aim too. Ground footprints
  use the posed lamp's horizontal origin and road height rather than floating with the body. Keep the chassis branch's
  sprung `pose` calculation when integrating; lamp code needs no separate suspension calculation.
  Four transform tests pass, and `scripts/prove-car-lights.ts --pose` checked lift, roll, brake dive and combined motion
  for all four light styles on Metal. It compares actual submitted light/glow positions and beam directions with the
  body instance pose (16 cases, tolerance 0.00003 m), and retains shaped lens glows in candidates 1–3. No GPU-time
  claim is made for the extra transforms.

- **Car-light studies (`?lights=0..3`).** `src/render/car-lights.ts`, `car-mesh.ts`, `game/scene.ts` and the sprite
  shader keep an original reference (0), warm recessed lamps (1, preview default), cool headlamps/full rear bar (2),
  and longer warm fans with subtle lens and braking streaks (3). All candidates replace oversized round sprites with
  bevelled housings and tight rectangular lens glows. Lens positions follow body roll, pitch and jump height. Two
  short-range lights let the adjacent body bevels catch the lamp colour; the ground fans fade out in flight.
  The concept images show small rectangular rear lamps, compact red spill and beams connected to the nose. The
  [Precinct Steam screenshots](https://store.steampowered.com/app/490110/The_Precinct/) show small practical sources
  with road wash; [Art of Rally's Light Trails mod](https://mikematthews.itch.io/light-trails-mod) demonstrates
  brake-only trails (a mod reference, not a claim about the base game). Our streak candidate is much shorter.
  A physically elevated spotlight can leave a gap on the road; the old extra ellipse at bumper +6 m made that gap
  read as a detached pool. Candidates use an 8/10/12 m fan starting at the bumper, plus the real spotlight.
  Shape the fan **in fragment space on a rectangular quad**: a tapered vertex quad distorted affine UV interpolation
  into two bright diagonal lines. The corrected fan is continuous in the inspected close and gameplay Metal views.
  `scripts/prove-car-lights.ts --video` captures all four at identical poses, verifies real app startup for each URL,
  and makes a silent 720×1280, 30 fps, 24 s H.264 Main/yuv420p phone clip (6.72 MB). Twelve stills and 720 video frames
  completed without page or GPU errors. Light count rises from 98 to 100 in the seeded one-car scene; the extra
  geometry and sprite/light work have no measured GPU-time claim. Kit's choice among the candidates is pending.

- **Check street furniture in metres beside an unscaled car.** Getaway's `src/game/props/dimensions.ts` sets shared
  dimensions for all 17 clutter kinds. Mesh-bound tests catch lids and feet extending beyond colliders; a separate
  seat-surface check fixes benches at 0.45 m seat height. The Metal scale fixture shows a 5.0 m muscle car beside a
  1.8 m bench, 0.75 m hydrant and 0.70 m cone. Legacy mesh helpers share these dimensions. See `perf/clutter/README.md`
  for the full audit; this visual correction has no new performance claim.
- **Sleep on a supporting face, not a bounding-box axis.** Getaway's `src/game/props/contact-shape.ts` compiles contact
  points into faces whose polygons support the mass centre with a tipping margin. Cone tips and narrow sign edges
  cannot become resting faces. The solver preserves the mass centre during rotation and waits for stable orientation
  before sleep. Tests settled 256 random cone drops, five inverted cases and 448 other prop drops; Metal proof shows
  four tip-first/tilted cones resting on their sloping sides. Evidence: `perf/clutter/rest-proof.json`. Runtime cost
  has not been remeasured; body-pair contacts still use decorative rounded proxies.

- **What makes the Getaway concept art read** (`games/getaway/concept/dir-d-lowpoly-*.png`), compared with the game on
  2026-10-12: small warm lamp pools with dark navy road between them (ours were large, even and hazy); flat, matte
  ground (ours too shiny); everything grounded by dark contact areas under cars and at building bases, curbs and
  trees; walls and roofs with tonal gradients and lit edges rather than one flat colour; dense set dressing on
  sidewalks and plazas; warm shop-window light spilling onto the sidewalk; a clear cool-fill, warm-pool, saturated
  siren colour split; and chunky white smoke. Kit agreed on the pools, the ground and the shop light. Six independent
  Look switches now implement the lighting, material, grounding and grading changes in `src/ui/debug-overlay.ts`.
  They default on after matched-frame concept review, pending Kit's playtest; valid GPU costs remain unverified.
- **Tune compact lamp cores together with matte ground.** In Getaway's `src/game/scene.ts`, reducing lamp radii and
  sky fill alone left the diffuse pools too dim after ground specular dropped from 0.55 to 0.035. Raising only the
  compact cores restored warm pools while retaining dark gaps. Keep both switches on for review; the original tight
  helicopter cone is unchanged. Cost awaits valid total-GPU measurement.
- **Grade shadows and bright colours in the existing composite.** Getaway's `src/render/shaders.ts` mixes a
  peak-preserving shoulder with ACES, reduces blue shadow lift and lightens the vignette. The inspected frames moved
  closer to the concept, so Colour grade defaults on. This is not AgX, and siren appearance still needs a chase
  playtest. Wall darkening and cool roof-top shading also default on. Costs remain unverified; see `perf/getaway-look.md`.
- **Soft smoke can overshoot.** Replacing Getaway's hard faceted puffs with soft sprites fixed the hard look but made
  the trail barely visible; the concept's smoke is full and opaque. Aim for readable volume first, softness second.
- **Smoke needs a dense core, a shaded underside and deliberate spacing.** Getaway's `fx.ts` and `shaders.ts` now
  offer five presentation styles (`?smoke=1..5`, compact Smoke selector; `0` retains the previous sprites). Faceted
  puffs use a shadowless model and vertex-lit scattering; soft/cel sprites shade three overlapping spherical lobes.
  Soft smoke fades analytically at the ground plane, without a depth-texture pass. Flames stay attached to the
  exhaust for one render frame rather than depositing blue beads, and ribbon segments join the previous rear-wheel
  positions. Boost emission has a density floor and scales with speed so mild drifting cannot open large gaps.
  All reuse existing passes. The 110-frame Metal study peaked at 40 faceted instances, 43 soft/cel sprites, 9 wisps,
  or 61 ribbon/wisp sprites. All six runs had identical poses and no browser/GPU errors; live selector changes passed.
  `scripts/prove-smoke.ts` captures the launch, turn and streetlamp frames; `scripts/smoke-sheet.py` assembles them.
  Kit rejected these silhouettes as separate beads; the connected study below supersedes that recommendation.
  Their GPU-time cost remains unmeasured. Evidence: `captures/getaway-smoke/` (sheet, labelled portrait clip and proof JSON).

- **Connected smoke needs shared density, not just more puffs.** Getaway's `game/smoke-trail.ts` carries unused
  emission distance, interpolates births every 0.42 m, and advects a fixed particle pool with the curl of an analytic
  stream function, drag and buoyancy. `render/smoke.ts` samples shared animated 3D noise so overlapping particles
  agree on billow structure. Styles 6 and 7 draw in the existing main pass with ground-plane fading; 7 adds a
  low-frequency scattering-gradient approximation, not a baked six-way lightmap. No smoke enters the shadow pass.
  On the M5 Max at 960×640, highest pose-median whole-frame GPU deltas were 0.132 ms (6) and 0.147 ms (7).
- **A shallow density field can make one raymarched trail.** Style 8 splats density, height and radius into a reusable
  128² RGBA8 field, then integrates twelve samples through the combined volume in one bounded draw. A conservative
  footprint rejects empty pixels before lighting/noise work. Highest measured pose-median delta was 0.099 ms;
  whole-frame CPU submission was about 0.3–0.5 ms, including CPU field construction. The cloud has approximate
  vertical self-shading and nearby-light scattering, not a CS2 voxel simulation or obstacle-filling fluid solver.
- **Measure the complete GPU interval and retain noise.** `render/frame-timer.ts` measures first-shadow-pass start
  to final-composite end, never a sum of passes. `scripts/prove-smoke-real.ts --timing --fixture` alternates smoke
  on/off at identical frozen poses, with nine measured pairs of eight frames after warmup. The final composite uses
  an equal-size/format offscreen target to exclude presentation fences. One style-7 pair had a 1.502 ms delta;
  retained raw results and per-pose medians/MAD are in `perf/getaway-smoke-real.json` and `perf/getaway-smoke-real.md`.
  These numbers establish the single-trail study, not a many-car budget or a bound on every frame.
- **Hold the camera after emission stops.** The connected-smoke capture holds after boost release so the car can
  leave while the smoke expands and fades. Matched Metal captures show continuity through the sharp turn and
  dissipation by 5.9 s. The inspected sheet and motion frames favour 8 for volume and 6 for softer edges; 7 is more
  contrasty. Default 6 remains a review candidate. Peak live count was 388/768; the pool drops new births if full.
  Evidence: `captures/getaway-smoke-real/`, including the original, faceted reference, concept crop and cited Valve
  reference. No new per-frame JS storage is allocated by the smoke simulation, preparation or upload path.

## Researched, not yet adopted

### Connected smoke research (2026-10-12)

Kit rejected styles 1–5 because their separate silhouettes read as beads. The next study must maintain overlapping
density through fast movement and sharp turns, then let that density drift and dissipate. Cost estimates below are
operation counts and memory, not measured milliseconds.

- **CS2 volumes.** [Valve's Responsive Smokes](https://www.youtube.com/watch?v=_y9MpNcAitQ) establishes connected,
  world-space smoke that fills spaces and reacts to lighting and gunfire. [Gunnell's reconstruction](https://github.com/GarrettGunnell/CS2-Smoke-Grenades)
  uses voxel flood fill, raymarching and tiled Worley density; this is a reconstruction, not Valve's shader source.
  Shared density avoids sprite seams; light-ray transmittance gives internal shading. A full voxel solver is excessive
  for tire smoke: a 64³ R8 density field is 256 KiB, before velocity, obstacles and lighting, plus repeated grid passes.
- **Soft particles.** [NVIDIA's soft-particle paper](https://developer.download.nvidia.com/whitepapers/2007/SDK10/SoftParticles_hi.pdf)
  fades opacity by the difference between scene and particle depth. Getaway can fade against y=0 for a few ALU operations;
  full obstacle fade needs readable MSAA depth and a separate pass or resolve. The planar approximation does not soften building intersections.
- **Distance emission.** [Unity's emission guide](https://docs.unity3d.com/Manual/particle-emissions-emitters.html)
  specifically recommends emission per unit travelled for vehicle dust. Carry unused distance and interpolate births
  along each segment; 0.35–0.5 m spacing with a radius above 0.7 m guarantees overlap, even across uneven frame times.
  Cost is O(distance/spacing), with fixed-capacity storage and a teleport cutoff.
- **Curl advection.** [Bridson, Hourihan and Nordenstam (SIGGRAPH 2007)](https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph2007-curlnoise.pdf)
  take the curl of a noise potential to obtain divergence-free turbulence instead of random velocity sinks. A shallow
  trail can use a 2D stream function plus buoyancy and drag, evaluated once per live element; this is much cheaper than a fluid solve.
- **Billow textures and flipbooks.** [Epic's Niagara smoke guide](https://docs.unrealengine.com/4.27/en-US/RenderingAndGraphics/Niagara/HowTo/RecreateSmoke/)
  uses sub-UV smoke, growth, acceleration and drag. Flipbooks preserve simulated billows at one or two texture reads;
  procedural world-space fBm avoids repeating round sprites and texture animation assets, but costs several noise reads.
  A small periodic 3D noise texture can be generated once and shared by all trail fragments.
- **Six-way lighting.** [Unity's six-way documentation](https://docs.unity3d.com/Packages/com.unity.visualeffectgraph@17.7/manual/six-way-lighting.html)
  packs six directional scattering responses into two RGBA textures. [The workflow](https://unity.com/blog/engine-platform/realistic-smoke-with-6-way-lighting-in-vfx-graph)
  supports baked Houdini/Blender smoke and describes EmberGen's six-point export. It fits the sprite pipeline at two
  fetches plus lighting; a procedural density-gradient approximation is cheaper to author but is not a baked six-way lightmap.
- **Merged half-resolution cloud.** [GPU Gems 3, chapter 23](https://developer.nvidia.com/gpugems/gpugems3/part-iv-image-effects/chapter-23-high-speed-screen-particles)
  renders particles into a smaller target and composites with downsampled depth. Half width/height cuts fill to one
  quarter; a small blur can hide seams but cannot repair separated density. Two half-resolution RGBA16F targets cost
  about 2.34 MiB at 960×640, plus 2–3 passes; depth-aware upsampling is needed to prevent halos around cars and buildings.
- **Bounded analytic volumes.** [GPU Gems 3, chapter 30](https://developer.nvidia.com/gpugems/gpugems3/part-v-physics-simulation/chapter-30-real-time-simulation-and-rendering-3d-fluids)
  explains ray integration, transmittance, early exit and low-resolution volume rendering. For Getaway, overlap small
  ellipsoid/capsule fields along the path and integrate their combined density in 8–16 samples, with shared 3D fBm.
  One bounded draw avoids a voxel solver; cost scales with covered pixels × steps × density contributors, so cull contributors first.
- **Overdraw and extinction.** GPU Gems 23 and Unity's [six-way discussion](https://discussions.unity.com/t/vfx-graph-introducing-six-way-lighting-for-smoke-dust-and-clouds-vfx/906564)
  both identify transparent overdraw as the main expense. Keep noise coherent across overlapping elements, convert
  optical depth with `1-exp(-density*distance)`, reduce density as the cloud expands, and bound screen coverage before adding resolution.

### Getaway sound pass: research and choice

- **Engine sources.** Crossfaded RPM/load recordings preserve a real engine's character; pitch-synchronous
  granular playback follows RPM with fewer obvious layer boundaries. The [Project CARS / Forza Motorsport 5
  interview](https://designingsound.org/2014/08/11/vehicle-engine-design-project-cars-forza-motorsport-5-and-rev/)
  compares these approaches; [Audiokinetic's sample-to-granular guide](https://www.audiokinetic.com/en/community/blog/engine-sound-modeling-from-sampling-to-granular-synthesis-in-wwise)
  describes RPM and load blending. This is the relevant racing-game pattern, not a claim that every Codemasters or
  Forza release uses one implementation. Good recordings and loop authoring are the expensive part.
- **Procedural alternative.** [Antonio-R1's WebAudio engine generator](https://github.com/Antonio-R1/engine-sound-generator)
  separates intake, block and outlet, with waveguides and an AudioWorklet (and a faster WASM implementation).
  [AngeTheGreat's engine-sim](https://github.com/ange-yaghi/engine-sim) simulates combustion and engine response to
  generate audio. Both explain why firing pulses and resonances matter; full combustion simulation is excessive here.
- **Chosen candidate:** native, band-limited periodic-wave firing harmonics over a 720-degree cycle, low exhaust
  and brighter load-dependent intake, with crank rumble and filtered air. Automatic class-specific gear ratios,
  hysteresis and 160 ms torque cuts give RPM drops and short clunks. One detailed player voice, four cheap world
  engines. Native DSP avoids per-sample JS work. This is an arcade approximation, not a physical engine simulator.
- **Tyres and transients:** lateral slip angle plus estimated launch slip ratio feeds quiet scrub, then resonant
  band-limited noise whose centre frequency rises with slip. Airborne tyres are silent; grass reduces squeal and
  kerbs brighten scrub. Nitro gets a noise ignition, sustained roar and release/blow-off with exhaust pops.
  Existing crash layers follow speed and vehicle mass; contact speed drives the scrape loops and landings use thuds.
- **Mix:** keep wail/yelp recordings with bounded Doppler and distance attenuation; street-height segment/AABB
  occlusion closes their low-pass behind buildings. Nearby facades vary the synthetic street impulse send.
  Eighteen sample one-shots, eight synthetic bursts, four remote engines and four remote sirens bound work.
  Exponential parameter smoothing, event ducking and a final compressor/limiter follow the
  [Web Audio API](https://www.w3.org/TR/webaudio/). A compressor is not a guaranteed true-peak brick wall: measure
  rendered peaks and leave headroom. Hearing preference and mobile-device cost still need playtesting.
- **Offline result:** 450 seed-7 chase frames, 30 Hz, captured on Chromium/Metal on the Studio. The new raw mixer
  measured −16.04 LUFS integrated and −4.28 dBTP; legacy voices through the same protected bus measured −15.66 LUFS
  and −4.20 dBTP. Neither clipped. Six shifts were scheduled; the actual M handler and Lab old/new switch passed.
  New control scheduling was 0.10 ms median / 0.20 ms p95 in this single render (browser clock granularity; not a
  runtime speedup or audio-thread CPU benchmark). Spectrograms show RPM harmonic movement and shift drops.
  Maximum isolated-sample deviation was 0.144 new / 0.175 old; new control-boundary delta 0.167 was below its
  overall 0.314 maximum. These are discontinuity diagnostics, not an assertion that no audible click exists.
  No listening took place. Six focused gearbox/slip/occlusion tests passed; full check passed 112 tests, 12 skips.
  Reproduction and provenance: `games/getaway/src/audio/SOURCES.md`; raw reports remain beside the private captures.
- **Nitro retrigger correction:** the first player synth preferred snapshot `boosting` to local input, remote
  bursts watched successive fuel decreases, and holding boost at empty fuel alternates depletion/refill in the sim.
  `audio/nitro.ts` now latches one ignition per local press, locks out refill while held after exhaustion, and
  debounces only remote boost-state releases. Interruption stops native sources and requires a fresh press.
  The replacement noise/turbine voice sits under the engine; exhaust pops follow actual scene backfire events.
  The 12-second peaceful proof recorded exactly four ignitions for four presses including a hold through empty,
  zero voices afterward, −18.64 LUFS / −4.46 dBTP and zero clipped samples. A separate unfaded offline regression
  checked eight ignitions and six exactly silent tail windows after exhaustion/release/interruption. Full check:
  115 passed, 12 skips. Subjective improvement awaits Kit's listening; no audio was played during verification.

### Getaway street destruction research (2026-10-12)

- **Use cheap collision shapes and sleep.** [Rapier's sleeping guide](https://rapier.rs/docs/user_guides/javascript/rigid_body_sleeping/)
  explicitly removes stationary bodies from simulation until contact wakes them. Boxes give good ground support;
  spheres/capsules make inexpensive pair contacts but cannot reproduce flat stacks. A small fixed-step impulse solver
  with oriented box ground support, conservative rounded pair proxies and a spatial hash fits disposable street clutter.
  Rapier WASM is the stronger choice for stable piles, joints and precise convex contacts; those are not required here.
  No Rapier bundle-size or performance advantage is claimed without a measured comparison.
- **PBD/XPBD are alternatives, not automatic upgrades.** [Small Steps](https://www.physicsbasedanimation.com/2019/08/01/small-steps-in-physics-simulation/)
  reports that smaller substeps outperform spending the same iterations on a large XPBD step. XPBD's compliance is
  useful for constrained/deformable systems; isolated props primarily need impulses, gravity, friction and restitution.
  [Spatial hashing](https://carmencincotti.com/2022-10-31/spatial-hash-maps-part-one/) avoids testing all object pairs.
  Keep sleeping entries in the hash; move only awake entries and query locally around swept car boxes.
- **Break into authored pieces, not a voxel world.** GTA's [YFT fragment workflow](https://www.youtube.com/watch?v=LI_eCB2JVgo)
  is evidence for pre-fractured props, not a claim about Rockstar's internal solver. Valve's
  [breakable-prop documentation](https://developer.valvesoftware.com/wiki/Half-Life:_Alyx_Workshop_Tools/Modeling/Breakable_Props)
  likewise separates render pieces and collision shapes. [Teardown's developer interview](https://www.gamedeveloper.com/design/combining-bombastic-heists-with-a-fully-destructible-voxel-world-in-i-teardown-i-)
  describes whole-world voxel destruction. Getaway needs only a few material-coloured boards/chunks per prop, with
  bounded lifetimes; procedural chunks preserve the chunky art without voxel meshing or fragment assets.
- **Batch the pieces.** Reuse one instanced draw per prop/chunk mesh, no small-debris shadow pass, and the existing
  alpha/additive sprite batches for water, sparks, fire, smoke and paper. The official
  [WebGPU compute-particle sample](https://webgpu.github.io/webgpu-samples/?sample=particles) demonstrates GPU simulation
  and instanced billboards. Compute pays at large independent particle counts; at a few thousand, a bounded CPU pool
  avoids another pipeline, readback for gameplay-adjacent contacts and worker messaging. Measure the CPU path first.
- **Separate the beats.** [Burnout's retrospective](https://www.gamedeveloper.com/design/devs-reflect-on-the-impact-and-legacy-of-i-burnout-paradise-i-)
  makes spectacle and close-up crash feedback central to the game's identity. Our timing is an art-direction choice:
  a brief bright core/light, expanding ground ring, fast ballistic chunks, then slower rising smoke and a lasting scorch.
  Short distance-attenuated camera punch sells nearby impacts. Delay neighbouring fuel detonations slightly so a chain
  reads as separate impacts. GTA/Burnout are visual references; no proprietary implementation is inferred.

**Initial choice:** a local TypeScript solver and CPU particle pool, fixed 120 Hz with capped catch-up, sleeping active
set, spatial hash, and the existing instanced renderer. Keep the solver free of game/DOM imports for later extraction
only when another game has a consumer. Performance and appearance remain unverified until the clutter proof below.

Candidates from the code audits; measure and playtest before moving any into the sections above.

- Full AgX-style tone mapping remains a candidate; Getaway now has a simpler peak-preserving shoulder under Colour
  grade. Compare both on a siren-heavy chase before adopting AgX. Brightness-weighted first bloom downsample to stop
  specular fireflies and one-code-value dither before 8-bit output remain unimplemented, unmeasured candidates.
- Blackout: shadow-occluded light haze and dust motes (they currently glow through walls), framed glass meeting
  rooms, and bounce light that follows a flickering lamp's power.
- Getaway: lamps aimed downward so upper facades stay in cool shadow; window interiors with depth and blinds.
- Rendering with less MSAA cost: weight the multisample resolve by brightness so emissive edges stay antialiased.

## Working on these games

- **One branch per change, one owner per file.** Parallel work on the same files overwrote fixes and committed other
  work half-done. Give each parallel task its own worktree and branch, and say which files it owns.
- **A game's check must pass from a clean clone with only its own dependencies,** as CI runs it. Blackout's deploy
  failed because a Blackout script imported a Getaway helper that needed Getaway's Playwright install, and a fix to
  that Getaway file didn't trigger Blackout's workflow at all.
- **Give historical proof fixtures separate Vite caches.** Getaway's `scripts/prove-look.ts` serves an archived
  baseline with its own `cacheDir`; sharing the dependency cache caused `504 Outdated Optimize Dep` failures.
  The isolated fixture completed the 180-frame before/after capture. This is a tooling fix, not a measured game-speed win.

## Multiplayer

- **Pair snapshot benchmarks on the same source.** `scripts/bench-multiplayer.ts --paired` alternates shared and
  per-recipient preparation order, runs one warmup plus nine measured pairs of 1,000 ticks, and checks serialized
  byte counts and SHA-256 outside the timed interval. Both games produced identical output across all 20 runs.
  On the shared Studio, Getaway's control/shared medians were 169.152 / 121.137 ms; Blackout's were
  45.038 / 60.736 ms with a 189.070 ms shared-run outlier. Preserve those samples: this noisy confirmation does
  not establish a new Blackout speedup. Raw evidence: `perf/*-multiplayer-final-paired.json`.
- **Build the shared part of each tick's snapshot once.** Rooms used to build and serialise a full view per connected
  player. Building shared entities once and adding per-player fields cut 1,000 ticks from 66 → 45 ms (Getaway, 8
  players) and 43.5 → 32.8 ms (Blackout, 10 players). Benchmark: `scripts/bench-multiplayer.ts`.
- **Keep the simulation in `shared/` deterministic** and free of DOM and Worker APIs, so the server, solo mode,
  prediction and benchmarks all run the same code.
- **Version handshake.** Hash `shared/` at build time and send it in `hello`; a server with another hash asks the client
  to reload into the same room (Blackout `scripts/build-id.ts`).
- **Persist lobby room reports** in Durable Object storage so a restarted lobby knows every live room at once instead of
  waiting for heartbeats (Blackout `server/lobby.ts`).

## Input

- **Latch fire presses across input ticks.** Blackout's `src/game/input.ts` keeps one press edge for at most 100 ms,
  consumed by the next 30 Hz input tick. `Intent.firePressed` carries that edge through prediction and the wire so
  consecutive taps remain distinct even without a sampled release. Weapon cooldown/reload gates consume rejected
  presses; disabling play, Lab capture and blur clear pending input. `tests/fire-input.test.ts` covers taps, holds,
  expiry, focus release and server queue delivery. `scripts/prove-fire-input.ts` drives trusted mouse down/up events
  against the real game with manual ticks, silent audio and a mocked room socket. The original build lost the
  between-tick tap in both paths (0 predicted/authoritative shots); the fix produced 1/1. Each fixed path completed
  the consecutive-tap, sniper-hold, double-click, cooldown, Lab and rifle-hold checks with 12/12 shots. Physical
  trackpad gesture recognition and GPU cost were not measured.

- **Ignore blur releases from the previous input owner.** On an iframe focus change, the old window's blur message can
  arrive after the new window's keydown or mousedown and cancel the new input. `games/blackout/compare.html` releases
  held input when ownership changes, then accepts release messages only from the current owner. The parent header is
  explicitly focusable. The Metal browser check moved from both panes and the parent, fired eight shots in each client,
  and checked shifted Dvorak comma release and Cmd release. Messaging cost is unmeasured.

- **Support any keyboard layout.** Match both `e.code` (physical position) and `e.key` (character), so QWERTY and
  Dvorak both work without settings. Don't bind an action to a key that is a movement key on another layout (Blackout
  used `E` for plant/defuse, which is Dvorak's right strafe).
- **Release the character a key produced when it went down.** Shift and Option change `e.key` while a key is held
  (Dvorak `,` becomes `<`), so releasing by the keyup's `e.key` leaves the key stuck and the player keeps moving.
  Record the character per `e.code` on keydown and clear it on keyup. Release everything when Cmd comes up, because
  macOS drops keyups for other keys while Cmd is held, and on window blur.
- **Give input focus back to the canvas after debug controls.** Clicking a non-focusable canvas can leave a checkbox
  or button focused, so the panel keeps swallowing gameplay keys. Blackout's `games/blackout/src/game/input.ts` focuses
  the canvas on mousedown; `games/blackout/src/ui/debug-overlay.ts` stops panel events and releases held gameplay input on pointer
  interaction. Chromium checks passed All On/Off, clicking back into the game, B to switch bots, and Backquote to hide
  the panel. Runtime cost is unmeasured.

## Feel

- **Lab navigation captures keys, not just focus.** The shared panel captures keyboard events at the window before
  game bubble listeners, releases held input on open, and retains consumed keyups after close. This follows
  [Dear ImGui's keyboard capture guidance](https://github.com/ocornut/imgui/blob/master/docs/FAQ.md#q-how-can-i-tell-whether-to-dispatch-mousekeyboard-to-dear-imgui-or-my-application).
  Contextual row/group commands keep edits local; command-palette-style fuzzy search jumps through folded groups.
  DOM-free tests cover focus, adjustment, search, exact values and default resets. Metal preview proof exercised both
  games' input adapters, Dvorak letter keys, coarse/fine steps, edit cancellation, Copy JSON, search/unfolding, presets,
  and comparison-message typing/modifiers with zero leaked keys or page errors. Rendering performance was not measured.

- **Separate pursuing cops without crash impulses.** Getaway's `shared/sim/bots.ts` blends pursuit with distance- and
  closing-speed-weighted separation steering and braking. `world.ts` gently corrects remaining cop/cop overlaps using
  their oriented footprints, with no velocity impulse or crash event; it preserves frozen cars and vertical separation.
  The 100-tick Metal chase's minimum centre spacing rose from 0.003 m to 4.001 m with zero impacts. The deterministic
  eight-second sim test requires more than 2 m centre spacing and less than 0.4 m soft bumper overlap, plus zero stun
  and impact events. All three new regression tests fail on the original simulation and pass after the change.
  Neighbour checks are quadratic in the cop count; runtime cost is unmeasured.

- **Tunnel crossings carry a snapshot counter.** Getaway's `shared/sim/tunnel.ts` mirrors lateral pose and velocity
  between two bores on one street. The shared substepped driver and client proxies use the same transfer; interpolation
  snaps on the counter and the camera cuts on the position jump. Seven tests cover both directions, velocity preservation,
  deterministic worlds, delayed prediction, remote proxy blending and a pursuing bot. `scripts/prove-tunnel.ts` captured
  the crossing and follower on Metal. Its two 90-frame ramp runs matched every car state and reached 3.26 m. The contact
  shadow now grows with clearance, stays on top of ramp surfaces and loses its sharp wheel patches with height; the
  headlight footprint moves forward and widens. Both reuse existing sprite batches. Runtime cost is unmeasured.

- **Sleeping street props with bounded local debris.** Getaway's `src/game/props/` places 1,281 props from seed 7,
  independently of the authoritative city RNG. Rendered car boxes wake a 120 Hz impulse solver; a spatial hash and
  awake set skip resting bodies. Rotated box ground support and rounded pair proxies suit disposable furniture, but
  do not provide precision stacks. Crashes produce instanced chunks and pooled sprites, with hydrant water, paper,
  fuel chains and off-screen recovery. On the M2 Max, seven-run CPU medians were 0.00254 ms asleep, 1.0203 ms for 512
  awake bodies, and 0.07073 ms for 2,400 particles. Valid paired total-frame GPU intervals on M5 Max Metal measured
  +0.01554 ms for resting visible clutter (inside noise) and +0.13239 ms for 320 props plus a particle burst. Metal
  captures verified all four reaction scenarios; playtest approval is pending. Details and raw runs: `perf/clutter/`.

- **Start elapsed time on the animation-frame clock.** Getaway's first RAF timestamp can precede completion of
  synchronous scene construction. Subtracting `performance.now()` produced a first delta of -0.463 s on Metal.
  Subtracting that negative delta raised crash, brake, boost and freeze timers from zero: orange light and a frozen
  camera, despite **zero simulation impact**. `src/main.ts` now starts with a null timestamp and a zero first delta,
  then clamps elapsed time nonnegative. `Scene` also starts car impact grace at 1 s and decrements its hit-stop cooldown
  once per rendered frame, clearing it on reset. `scripts/prove-startup.ts` uses the original 640×480 / 30-capture /
  60 ms probe and checks the actual timer values. On headless Metal, the 100×100 centre-crop red mean changed from
  152.9 → 46.5 during startup before the clock fix to 47.2 → 47.0 after it; `off=trauma` starts at 47.0.
  Reset Seed in `compare.html` also retained the same stationary spawn without the flash. This supersedes the earlier
  unreproduced-startup note below. Runtime cost is unmeasured.

- **Attach car lamps with the same transform as the body mesh.** Getaway's `src/game/car-pose.ts` exports
  `bodyPoint(car, { height, roll, pitch }, [x, y, z])`, which applies roll, pitch, yaw, then translation like the
  instance shader. Headlight/taillight glows, point/spot origins and sirens share it; the headlight direction uses two
  transformed points. Ground-light pools project onto the road instead of floating with the body. Close-up Metal
  braking/kerb captures and packed-buffer checks covered 288 off/on frames; maximum attachment error was 0.000007 m.
  Cruiser and SWAT sirens also passed. `captures/preview/getaway-chassis-lamps-phone.mp4` has the stacked proof.
  The extra CPU cost of the attachment transforms has not been measured.

- **Filter acceleration before springing the body.** Getaway's `src/game/chassis.ts` filters interpolated velocity
  over 85 ms and acceleration over 65 ms, then uses exact underdamped springs (12–16 rad/s, damping ratio 0.52).
  Tests cover 10 Hz repeated snapshots, large-dt stability, settling and one-shot impact/landing impulses. Real wheel
  hubs sample rounded sidewalks and shared ramps; subtract centre-ramp height before adding the four-contact lift.
  Compose wheel spin before steer and bank to keep a leaning bike's axle fixed. The Chassis switches preserve the
  original mesh/transform path when all four are off. Metal captures matched 432 simulation poses across six off/on
  fixtures, including a 3.155 m jump and landing. For 28 cars, chassis updates cost 0.085 ms/frame median (+0.063 ms
  paired); split wheels add 104 instances and 47 submitted draws. Wheel-only GPU timing was too noisy to isolate
  overhead (paired deltas −1.525…+1.329 ms). See `perf/getaway-chassis.md`. Kit approved the chassis; all four switches
  default on in the integrated build. A combined smoke/chassis Metal check emitted 312 connected smoke points on a drift,
  with body roll reaching 0.144 rad and pitch 0.148 rad. No page or console errors occurred. The startup centre-crop red
  mean stayed within 46.54–47.21 (46.64–47.22 with `off=trauma`, which is now ignored because trauma is baked in).

- **Hit-stop is presentation only.** Freeze or slow what is drawn, never the simulation clock, so prediction and the
  server stay in step.
- **Scale shake with trauma squared** so small hits stay subtle and big ones land hard.
- **Blackout playtest verdicts.** Kit rejected gunshot/sprint sound rings and found shot-triggered lamp flicker too
  strobey. Both switches now default off, including the Recommended preset in
  `games/blackout/src/ui/debug-overlay.ts`; monitor lights, paper, glass, monitor sparks, casings and trauma remain on.
  `games/blackout/src/game/game.ts` replaces the lamp strobe with one smooth 0.8-second brownout, at most 30% dimmer,
  a 1.2-second retrigger interval and three small sparks. The softened brownout is a candidate awaiting another playtest;
  its runtime cost is unmeasured. A 60 Hz buffer check on a steady lamp found brightness 1 → 0.70 → 1, a maximum
  frame-to-frame change of 0.0196 and no restart from a hit during recovery. Rings remain available as an opt-in switch.
- **Candidates being playtested** behind the debug overlay (`` ` ``), each with an enable/disable switch: floor sound
  rings on shots and sprint steps, paper and glass debris by surface, ejected casings, shootable lamps, sparks stretched
  along their velocity that bounce, scrape sparks, connected skid marks, exhaust backfire, nitro camera rush, kerb
  suspension hop. Record the verdict and cost here after playing them.
- **Getaway effect checks** (candidates). In `games/getaway/src/game/fx.ts`, a downward spark bounced off `y = 0.05`,
  and a skid segment joined two wheel positions while rejecting a 100 m teleport. In `games/getaway/src/game/camera.ts`,
  the nitro switch moved FOV toward 0.65 and disabling it restored 0.60. These passed script-level assertions;
  appearance and CPU/GPU cost remain unmeasured. The current spark ribbon adds up to four kind-6 sprite instances
  per spark, using the existing glow shader.
- **Seeded driveable ramps and shared height.** Getaway's `shared/sim/city.ts` uses a separate random stream for
  mid-block ramps, alley loading ramps and a harbor ramp (12 with seed 7). `vehicle.ts` samples the same two-slope
  profile drawn by `src/render/city/ramps.ts`, launches at the crest, removes tire forces in flight and restores grip
  over 0.22 s after landing. A landing counter survives snapshot gaps; height and vertical speed interpolate separately.
  Seven focused tests cover airtime, slow roll-over, both bot approach directions, deterministic world events,
  protocol/interpolation and two-tick-delayed prediction/reconciliation. The Metal headless proof reached 3.31 m and
  landed once; the final `bun run check` passed 105 tests (12 existing skips). Runtime cost is unmeasured.
- **Lights follow controls, not render-frame derivatives.** Getaway's `scene.ts` now uses shared brake/boost state and
  local controls, with 100 ms release holds. Speed derivatives spiked between interpolated snapshots; fuel-drop edge
  detection repeatedly restarted the blue backfire light. The headless brake run held rear intensity at 1.2 or 3 with
  two intentional transitions, and emitted one three-frame backfire at boost onset. Startup with effects on and off
  kept 98 point lights, 337 glow sprites and bloom 0.9 for three seconds: the reported startup glow fade was **not
  reproduced**, so no root cause or bloom fix is claimed. BEFORE starts at a different site despite seed 7.
- **Soft smoke stays out of the opaque/shadow passes.** Getaway's `fx.ts` emits tire smoke through the existing alpha
  sprite path: growing, dragged, rising, fading particles. `shaders.ts` gives each smoke vertex a bounded 48-light
  diffuse lookup and smooth radial alpha, without shadow sampling or casting. Metal stills show the former solid
  faceted blobs replaced by soft smoke. Nitro onset below 24 m/s adds a 0.45 s rear-wheel skid/smoke burst under the
  existing skid switch; the capture recorded exactly 26 connected segments (two per frame) and five smoke sprites,
  then no further segments while boost stayed held. CPU/GPU cost and Kit's playtest verdict remain unmeasured.
