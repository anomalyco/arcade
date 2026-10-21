# Game notes

Techniques that have worked in one arcade game and should carry to the others. Add an entry once something is proven:
what it does, where it lives, and what it measured. Mark candidates that have not been measured or playtested yet.
Shared code that bakes these decisions in is tracked in `docs/shared-code.md`. Animation has its own file,
[animation.md](animation.md).

## Human animation

Animation insights for the shared human rig (gait timing, contacts, arms, posture, transitions, profiles and
weapons, with measured values and known gaps) live in [animation.md](animation.md). The rig's API and ownership are
in [human-rig.md](human-rig.md), and the tuning procedure is the `procedural-animation-iteration` skill. Add
proven animation techniques to animation.md, not here.

## Proving a change

- **Minified normals and wet reflections (Lot, AR-103).** `gpu/normal-mips.ts` filters decoded unit normals without
  renormalizing lower mips; `gpu/textured-mesh.ts` converts lost vector length into roughness variance. Physical
  specular AA must read the mapped normal, not just the flat asphalt mesh normal. Lot's reflected airlight runs after
  scene TAA with its own volume history; its opt-in deterministic lobe samples, HDR sample cap and footprint-filtered
  wet boundary avoid relying on a scene reactive mask that cannot reach that pass. Seven Naga variants and the real
  production input capture pass. Iteration 6 static RGB MAE is 2.279/255 versus 2.229 for iteration 5; this is not a
  claim of measured temporal improvement. The local matched-camera page exposes the remaining differences directly.
  Keep the reflection-loop bound uniform-driven: on macOS SwiftShader, a literal four-tap bound left the GPU process
  compiling beyond the 165 s smoke deadline with its raster workers idle. The uniform-driven bound passed the same
  two-frame GPU-drain check at four default taps and full 1024 shadow maps; no quality reduction was needed.

- **Static textured imports and saved-frame fidelity (Lot, AR-103).** `gpu/gltf.ts` expands glTF node transforms and UVs into an opt-in 32-byte vertex stream; `gpu/textured-mesh.ts` binds per-material textures on the existing scene pass and exposes opaque buffers to spot shadows. Existing 24-byte procedural vertices stay unchanged. Lot converts Ashwood's exterior builders offline, retains original tree atlases and distant impostors, and uses shared physical lights, fog-sky illumination and reflected airlight. At 1920×1080, iteration 3 reduced display-RGB MAE against the saved Ashwood title frame from 3.994 to 2.252/255, with mean-luminance error 0.000909 and hue error 0.922°. Evidence includes an 8×6 grid, fixed-region metrics and full captures in `~/code/home/artifacts/lot-2026-10-20/`. Four focused tests cover the vertex ABI, complete finite baked geometry, the licensed wagon's 5.05 m normalization and controller ownership/collision. Seven Naga variants pass. Full Chromium headless accepts Pointer Lock where headless-shell rejected it; capture scripts must restore hidden controls before checking panel focus. GPU cost is unmeasured.

- **Keep spell proof on the real input path.** Blackout's `scripts/prove-wizards-spells.ts` reads scrolls with F and
  draws through Chromium mouse events. Its manual sandbox clock advances both simulation and animation between
  captures; advancing simulation alone left the rig's planted feet behind. The inspected Metal proof captured a
  dummy in a growing moon, its moving polar shadow and damaging pop, a rising skeleton pursuing its caster, and
  a 71.6%-confidence degraded moon. Dvorak movement continued while drawing; there were no browser errors.
  `shared/sim/spells.ts` owns the authoritative entities and `tests/spells.test.ts` verifies deterministic replay
  and two room connections receiving the same cast. Runtime cost and live two-browser room play are unmeasured.

- **Record one motion tape across snapshots.** `scripts/compare-video.ts` captures headless Chromium on Metal and
  sends encoding to the fleet. Its Getaway adapter patches HTTP responses for legacy, current and minified deployed
  hooks without editing game files. Named scenarios supply frame-indexed inputs; the last pane supplies full world
  views and camera state by default, so physics changes cannot move the cars between panes. `--input-only` compares
  each version's simulation instead. The seed-7 historical/smoke pair matched all 360 world/camera snapshots at 30 Hz;
  a four-pane seed-11 check also covered the deployed bundle and temporary-worktree cleanup. Two independent seed-11
  deployed runs produced byte-identical PNGs for all 30 frames in input-only mode. Captures are canvas-only,
  with PNG labels, a contact sheet and a JSON manifest. High quality defaults to 2× capture, Lanczos downsampling,
  1080-wide stacked / 2560-wide side output, and 16 / 28 Mbps H.264 High. `--quality draft` retains 720 / 1920-wide
  output at 1× capture. `--zoom` changes the projection only during drawing, leaving the replay camera state intact.
  The 12-second seed-7 example at 1.35× zoom matched all 360 snapshots and produced 24.28 / 42.40 MB videos; full
  decoding and full-resolution frame inspection passed. Capture timing
  includes screenshot readback and is not a performance benchmark.

- **Measure before you edit.** Record a baseline on the unchanged code, then make one change at a time. Use one warmup
  and seven or more measured runs, and compare medians with their spread. Results go in `perf/results.jsonl`.
- **Separate GPU time from frame time.** Frame time is capped by vsync. Use `timestamp-query` where the adapter has it,
  and `device.queue.onSubmittedWorkDone()` otherwise.
- **Headless Chromium on a Mac can use Metal.** Launch it with `--enable-unsafe-webgpu --use-angle=metal` and check that
  `adapter.info.architecture` is not SwiftShader before trusting a number. Linux headless only has SwiftShader.
- **Deterministic video from the real game, no source changes.** Carrier's `scripts/video-weather.ts` replaces
  `performance.now`, `Date.now` and `requestAnimationFrame` with a virtual clock in a Playwright init script, wraps
  `game.update` from `page.evaluate` to place the camera, and steps exactly 1/60 s per frame. Two traps: the renderer
  draws in a microtask and drops frames while two are in flight, so drain the queue before each step; and offset the
  clock half a sim tick from the 60 Hz ship grid, or float drift gives 0- or 2-step frames. Raw BGRA readback through
  the game's device piped into ffmpeg: 1,800 1080p frames in ~5.5 min on the M4 Max; frame-difference spikes only at
  cuts and lightning.
- **Capture the game's own audio in lockstep with a frame-stepped video.** Carrier's `scripts/video-epic.ts` moves the
  game's mixer onto one `OfflineAudioContext` (`mixer.use`, then a synthetic `pointerdown` so the weather and weapon
  sounds start on it) and, after every 1/60 s step, schedules `ctx.suspend` at that step's sample, resumes and awaits it:
  engines, flybys, rain, thunder, guns and recorded explosions render in sync. Copy the swapchain texture before that
  await, or the page yields, presents and destroys it (black frames). The camera goes in the flight module's per-frame
  hook (`flight.frame`), not after `game.update`, so weapon effects, lights and the listener all see the video camera.
  Cuts are free time skips: setups run muted and their sample ranges are dropped. 1,920 frames plus ~60 s of unseen
  setup in ~6 min on the M4 Max.
- **Encode frame-stepped video inside the page, on the GPU's media engine: 18× faster.** Carrier's `scripts/video/`
  (`page.ts` clock and recorder, `core.ts` host, `remote.ts` sync/build/run/fetch on hailmary, `bench.ts`) drives
  `scripts/video-epic-fast.ts`. The old per-frame cost was overhead: a DevTools round trip per step, 8 MB of BGRA as
  base64 through the protocol and a CPU master encode. On the M4 Max at 1080p, `bench.ts` measured 5.7 fps for that
  path, against 830–885 steps/s for an in-page loop and 820 fps for `new VideoFrame(canvas)` alone. One
  `page.evaluate` runs a whole setup, preroll or shot. After the renderer's draw microtask, the page hands the canvas
  to a WebCodecs `VideoEncoder` (`prefer-hardware`: VideoToolbox, H.264 or HEVC Annex B, `quantizer` mode supported).
  Only the bitstream leaves, over a local WebSocket. Fetch POST uploads crawl: 3.8 fps raw and 147 fps H.264 at 80 Mb/s.
  The socket reaches 21 fps raw, 333 fps at 80 Mb/s and 409 fps at 40 Mb/s. The host tees each shot into ffmpeg
  (`-hwaccel videotoolbox`, title overlay, libx264 medium, one pass with VBV) while the page renders. The CPU encode
  is the floor: 1,920 frames take 14.7 s at medium, 20 s at slow and 47 s for the old two-pass slower. Splitting
  libx264 by shot gained nothing; two pages encoding at once reached 422 fps.
  The offline audio lockstep costs about half of each frame. Three extra audio pages run it with
  `renderer.render` stubbed, since nothing reads the GPU back. They replay earlier shots silently, start the mixer 1.5 s
  before their run and keep their own samples. Muted setup steps sync audio every 8 steps. Every page must report the
  same ship and jet state at each shot end, so the audio stays on the picture's steps. Runs repeat exactly: the clock
  stays frozen during load, start-up takes 60 fixed steps and `Math.random` is seeded. Decoded frames matched
  bit-for-bit across runs; audio differed by −130 dB. Each shot gets a fresh encoder, so `--only=<shot>` splices
  bit-identically after an undrawn replay.
  Measured on one build: the old script took 415 s; the fast one takes 23 s on hailmary (26 s from here with
  sync and fetch), 12.7 s for `--preview` (540p30) and 6–7 s for `--only`. A lossless readback reference
  (`--truth`) scored the old chain at Y-PSNR 42.43 dB, average 42.01 dB and SSIM 0.9762. The new default (HEVC
  40 Mb/s, then x264 medium) scored 42.15 dB, 42.23 dB and 0.9768. Both outputs were compared after conversion to the
  same BT.709 4:4:4 form, because old masters are untagged BT.601. Traps: Chrome writes a 240 Hz VUI clock (force
  ffmpeg's input `-r`) and tags transfer sRGB (retag BT.709). On macOS, Bun stops reporting child-process exits once a
  Playwright browser closes, so close browsers last. About one audio page in ten has Chrome's `OfflineAudioContext`
  stuck at its last suspend point while "running"; `resume()` does not revive it, so a 1.5 s timeout reruns that page.
- **Score a trailer to generated music, then cut to the music.** Carrier's `scripts/video-ship.ts` generates four
  ElevenLabs Music takes from one prompt. It uses none of the prompt's timeline: it picks the take whose structure fits
  (0.1 s band-energy curves and onset spacing from ffmpeg show a light intro, a boom and silence, a riser, a drop, then a
  final hit). Shot boundaries, the storm drop, lightning strikes and the title land on those onsets. The night breakdown
  crossfades to a low-passed copy, and the game's own audio sits 10-18 dB under. Night lightning in the game is graded
  down to almost nothing, so the script adds ambient and cloud glow during a strike after `weather.update`. Forced
  strikes peak about 0.1 s after they fire, so fire them that much early.
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
- **Bot-played difficulty curves as a test.** Outbreak's survivor bots play fixed seeds while a read-only per-tick
  probe (`BotRunConfig.observe`, `shared/difficulty-ramp.ts`) buckets pressure, damage, resources and deaths per game
  hour and phase. `tests/difficulty-ramp.test.ts` runs 16 games to dawn 3 on up to 4 workers (~4 s on an M-series Mac; one thread on CI took 70 s for 24 games) and holds ratios (night over day,
  Night 3 over Night 2, ramp-in) and survival per preset inside loose bands; `scripts/difficulty-ramp.ts` is the full
  report. It found the director's ramp ending at Night 2 (16 zombies, 3 chasers on every later night); the D-40 night
  ramp (`shared/night-ramp/`, a per-tick `DirectorEscalation`) now lifts both every night up to a ceiling. See
  [outbreak-difficulty.md](outbreak-difficulty.md).

## Rendering (WebGPU)

- **Rectangular ceiling panels need their actual footprint.** `packages/kit/gpu/lights/rect.ts` clips a downward
  rectangle against each receiver's horizon and integrates its spherical polygon for diffuse irradiance; shared
  physical-light hooks use the rectangle's mirror-ray point for approximate GGX specular and the existing area
  shadow filter. Opt in with `physicalLightHooks({rect:true})` and `SceneLight.rect` (half-extents in metres, yaw).
  `rect.test.ts` compares floors, walls, near-field and horizon-clipped receivers against independent 160² area
  quadrature within 0.1%; behind-panel emission is zero. Lot's lobby uses a 0.6 × 1.2 m panel and four weighted
  samples of that footprint in the shared fog integrator. Specular, fog and shadow filtering remain approximations;
  the diffuse polygon integral is exact. Non-panel games do not compile the polygon shader.

||||||| parent of 714185bb (Lot walking: SSR and fog keep their history in motion (variance clip, compressed blend), spot shadows fade by distance (AR-118))
- **Screen-space reflection and fog slots must keep their history while walking (Lot, AR-118, 2026-10-21).** The
  kit volume slots dropped their history once the view moved 2 slot texels a frame, so walking or turning showed a raw
  quarter-res SSR march each frame: a far lamp head caught by a few reflection rays blinked on the wet road (Kit's
  "glittering", "the light flashes"). `VolumeInput.moving` (Ssr/Fog `historyMoving`, 1 = Today) keeps it in motion with a
  mean ± 1.25σ clip that blends in from the padded min/max by motion (still-camera noise averaging unchanged) and a
  luminance-compressed blend (Karis), so one bright texel has to persist to show. Lot SSR 0.2; the fog stays at 1,
  because its in-scatter follows the view ray rather than the surface it reprojects by, so a kept history made the booth
  head's near halo jump (pops 4.8 → 7.9).
  `games/lot/scripts/motion.ts`: turning pops/frame 148 → 3.7, block flashes 31 → 0 frames; the far head's wet
  reflection (mirror ROI) 4.7 → 0 pops/frame. Turning the fog bank or fog-depth blur off multiplied the reflection glitter
  15× and 7×: atmosphere hides temporal faults, so attribute with it off as well as on.
- **Far glow decals need a depth offset in steps, not millimetres (Lot, AR-118, 2026-10-21).** With depth24 and near
  0.15 one depth step is ≈ d²/(near·2²⁴): 9 mm at 150 m. The facility stairwell's lit panes sat 5 mm off their opaque
  backing and the sodium lenses 0–5 mm (some −0.9 mm) off their housings, so from the gate they tied with the wall and
  swapped as the camera moved and jittered: Kit's "flashing lights to the left". `SceneHooks.depthBias` (kit
  `gpu/shaders.ts`, vsStatic) subtracts N × 2⁻²⁴ × w from clip z: a constant step margin at every distance, whose
  world overlap stays sub-pixel. The lot pulls MAT glow 4 steps and its interior-window panes (3 cm proud of the glow
  proxies) 8 (Glass › Glow decal depth offset, 0 = Today). `games/lot/scripts/motion.ts` (reprojected per-pixel change
  around a projected world ROI) on the gate walk: stairwell pops 7.86 → 0 per frame, frames with a pop 33 → 0 of 179;
  near 0.5 alone only halves it (2.56, 13 frames), TAA off makes it worse, rooms off doesn't change it. Scan for coplanar
  emitters by brute force over the baked triangles (glow vs parallel non-glow within 20 cm), not by eye.
- **Temporal upscaling buys Outbreak's 2× Retina frame back; keep MSAA in the smaller scene pass and add volumetrics
  after the resolve.** `@arcade/kit/gpu/temporal` (AR-72, after three.js r186 `TAAUNode` + FSR1 RCAS; rules for passes in
  [rendering-techniques.md](rendering-techniques.md#entries--post--grade)). Outbreak Lab › Anti-aliasing: MSAA (today) /
  TAA / TAA + upscale, render scale, sharpen, history weight. One combined Studio run (`games/outbreak/scripts/taa-proof.ts`,
  headless Metal, 3456×1894, 5 rotated rounds, another browser job sharing the GPU, so MADs are wide): GPU (timestamps)
  MSAA → TAA + upscale 0.67 (2316×1269 internal) street night 9.54 → 7.29 ms, horde night 13.88 → 8.86 ms (paired Δ
  −2.62, MAD 2.4), start house 11.33 → 8.51 ms (Δ −3.75, MAD 0.51), street day 11.96 → 8.57 ms (Δ −3.92, MAD 1.77);
  harness step (sim + draw + GPU done) 15.5–18.2 → 12.4–14.3 ms, i.e. under the 16.7 ms budget in every scene where
  MSAA was over it. TAA at native costs +0.6 to +2.9 ms (one noisy +5 ms). Walking flicker (look-beauty's metric, 1536×1024)
  night street high-pass P90 0.0135 → 0.0070 TAA → 0.0057 TAA + upscale, start house 0.0128 → 0.0090 → 0.0073, day
  street 0.0134 → 0.0125 → 0.0112. Lessons: the first run's TAA columns lost the shroud because the resolve clamped
  the HDR alpha to 0..1 and Outbreak packs `1 + 4 × unseen` there (fixed: alpha unclamped, clipped to the 3×3 range),
  so the night flicker figures above flatter TAA where the shroud's noise film was missing and the look and ghosting
  sign-off needs a second run; flame, beam and fast-zombie crops showed no trail, and moving actors are softer under
  upscaling (no history, wide kernel). Default stays MSAA until then.
- **From a steep top-down camera, mirror known lights analytically instead of tracing reflections.** The things a
  puddle would show (lamp heads, lit windows, fire) are mostly off screen, so SSR would miss them and a planar pass
  doubles the scene. Outbreak (`games/outbreak/src/reflections/`, AR-73) picks up to 8 outdoor lights per frame on the
  CPU and computes each one's image in flat water there (`k = h / (h + eye height)` of the way to the eye, the kit
  floor-highlight math; cone lights only where they point), passing image, size, plan distance and colour in two vec4f
  each, so the ground shader's loop is a distance test per light and never reads the light buffer or the shadow map.
  The first build, which read the light buffer and did the image maths per pixel, measured `+2.22 ms` paired on a wet
  street at 3456×1894 (`pro`). Figures occlude lights behind them by comparing plan distance from the eye. A mirror
  needs no pass either: its glass intersects the reflected ray with the floor plane and the people's cylinders. Mirrors
  placed from the interior's free wall spans must also avoid fixtures the house plan builds itself (Ash's kitchen run is
  geometry, not a prop): the first placement hid the mirror inside the cabinets.
- **Bake detailed textures off the main thread into a small texture-array pool, nearest rooms first, and carry their UV
  in the vertex colour.** Outbreak's rugs (`packages/kit/textures/rug.ts`, `games/outbreak/src/interiors/`) are
  generated from a seed (Persian field, medallion, spandrels, nested borders, knot grid, abrash, wear, fade, fringes;
  also Turkmen gul, kilim, Art Deco, braided oval, 70s shag) by `packages/kit/textures/rug-worker.ts` at 1024 px with
  mips and pile height in alpha. `RugPool` keeps 8 layers plus one interior-tile mask layer (≈50 MB) in the renderer's
  detail array (bindings 15/16), uploads at most one finished bake per frame (0.6–2.2 ms measured on the Air) and reuses the least
  recently needed layer. A rug quad's vertex colour holds `(u, v, axis)` and its aux holds `streamSlot × 4 + index`, so
  the shader looks the layer up in a 9×4 directory in the OL uniform; no per-rug material or draw call. Measured:
  bakes 0.15–1 s each in the Worker (up to 5 s on a busy Air), pool settled 0.8–1.6 s after teleporting into a house,
  paired GPU Δ −0.5 ms on a 180–250 ms Air frame at 3456×1894 (MAD 1.1 ms, inside noise). Lessons: the noir look's moon
  rim read `o.color` and showed the UV gradient until `SceneHooks.lookBaseColor` let games supply their albedo; WGSL
  reserves `macro`; Lab sections that bake asynchronously report `busy()` so `prove-station.ts` waits for them.
- **At night, colour comes only from light: drive the grade's selective-colour mask from what a surface receives, and
  give the sight area only a small lift.** Kit's rule for the Resident Evil house (AR-42): the world is near-monochrome
  unless a real light falls on it. Outbreak already wrote received flashlight and practical irradiance into the HDR
  alpha (`outbreakColorMask`), but the grade also kept the whole sight area at saturation 0.42 and lifted any warm
  pixel by hue (`warmBias`), so dark brown floors stayed brown. Under the rule (Look · Light colour, default on,
  `look/world.ts` `trimLook` and `lightRuleWeight`) the grade's unlit saturation drops to 0.06, the hue lift is off,
  baked lamp bounce counts as light (`outbreakBounce` leaves its luminance for the mask), lit memory keeps its colour
  in the fog of war, lit surfaces keep it wherever the scenery is known, and the sight area adds 0.08 of the mask. The
  moon gives no colour (scotopic, and it reads right). The rule fades in with darkness from the sun term, the same
  smoothstep on the CPU (grade) and in WGSL (`outbreakLightRule`), so the day is untouched (noon stills differ by 1
  pixel). One float of mask, no new target: paired GPU Δ −0.005 ms hall / −0.006 ms street at 3456×1894 on the M5 Max.
- **Dust motes are a world-anchored lattice drawn per light, shaded in the vertex stage and shadowed in the fragment
  stage.** `games/outbreak/src/air/dust.ts` is a kit `ScenePass` in the alpha slot (the renderer now rebinds the scene
  group before alpha plugins). Air is a lattice of cells with at most one mote each, orbiting slowly inside its cell, so
  a sweeping beam reveals motes that stay put and parallax comes from their real heights. Each light draws only the
  cells in its own volume (the flashlight's cone box at 0.32 m cells, 18 432 instances; a box under each lamp, 768
  each with the cell size grown to fit), the vertex stage keeps a mote only where its light reaches it (beam profile
  and falloff, lamp falloff and the same sconce, window and ceiling cuts as the surfaces) and the fragment stage
  shadows it through that light's polar row and hides it outside sight, so motes never glint behind a wall. Additive,
  depth-tested, destination alpha kept. Lab: Look · Air. Lamps get motes on High (12) and Balanced (6), not Low. Cost:
  paired GPU Δ +0.049 ms hall / +0.017 ms street at 3456×1894 (`scripts/ab-gpu.ts`). Stills:
  `games/outbreak/scripts/re-light-stills.ts`.
- **Bake the room lamps that are not live indoors as line-of-sight floor pools in the bounce texture.** Indoors only the
  shadow-casting lamp of each house is a live light (unshadowed lamps would light through walls), so the other room
  lamps lit nothing but a faint Dijkstra bounce, and Kit's paint-over rooms have warm lamp pools. `lightbake.ts` adds
  each accent lamp's direct pool (cos³ inverse-square from the bulb height, windowed to its reach, marched against the
  wall grid so it stops at walls and spills through doorways) into the same 0.5 m `bounceTex` the origin bake and every
  streamed chunk already write, so it costs no GPU work beyond the existing fetch and follows the hour, room-lamp power,
  cutaway and streaming. Indoors the bake is scaled by Look · Lights › Baked room light (default ×4); because it is
  light, the colour rule gives the pools their colour. Bake: 15 ms for the origin town (all of `bakeOutbreakBounce`).
  Client-side table lamps from the furniture library bake the same way (`bakeOutbreakBounce(town, tableLamps)`,
  `tableLampPool`: 2.6 m, the dimmest accent lamp's power), and their shades glow through the fixture slot
  `TABLE_LAMP_SLOT` (MAT.lamp aux), which follows the room lamps' hour and power; no shared state. Indoors the
  nearest table lamps are also live (`games/outbreak/src/table-lamps.ts`, Look · Lights › Live table lamps: 2 on
  High/Balanced, 0 on Low): unshadowed, cut in the shader to the rect between the walls around the lamp
  (`tableLampClip`, cone.w −3) so they never light through a wall. The baked pool stays: it is the doorway spill and
  the bounce, and the live light adds direct light and shading on props. Paired GPU Δ at 3456×1894: +0.11 ms.
- **Project a paint-over onto the floor through the gameplay camera, and it becomes a plain top-down texture.** For
  the Resident Evil house study (AR-42) the mansion paint-over of Ash's hall was rectified onto the floor plane with
  a homography fitted to 67 floor points the capture projected (exact to 0.000 px), cleaned of furniture and painted
  light by one image edit, and drawn as albedo for the living room and hall (`interiorPlate` in
  `games/outbreak/src/interiors/wgsl.ts`, one `RugPool` layer loaded by the rug Worker, plate layer and brightness
  packed in `rugCfg.w`). Because the floor is planar the plate is right from every camera position and zoom, unlike an
  RE background, and the flashlight, polar shadows and grade light it live; rugs and furniture draw on top. Lab:
  Look · Detail › Painted floor plate (default on), `outbreak-look` station Detail group. Stills:
  `games/outbreak/scripts/re-house-stills.ts --mode plate`. The board wear reads only where light falls under Noir.
  Study and ranking: `~/code/home/artifacts/2026-10-16-re-house/techniques.md`.
- **Floor every house from a small generated plate library, and flatten each plate before it tiles.** Two gpt-image-2
  top-down albedo plates per theme (mansion walnut herringbone, village oak, farmhouse pine, plain boards; 1024², 4 m
  each, `games/outbreak/src/interiors/plates/floor-<theme>-<a|b>.webp`) replace the procedural board tone; each house
  picks one by its seeded variant (`floorPlateFor`) and the plate tiles in world space with a slow tone noise. Raw
  generations carry big wear patches that repeat as a visible grid, so each plate is divided by its own wrapped
  36 px blur (ImageMagick `-fx "u/max(v,0.005)"`), keeping planks, seams and small stains, then levelled to a mean
  sRGB of ~0.26–0.38. The detail sampler clamps, so the shader wraps with `fract` and an explicit LOD. Plates are
  `RugPool` layers (default raised from 8 to 12 layers, about +22 MB) ranked by distance to the house, slightly ahead
  of its rugs; layer and gain per window building go in `bldPlate`. Station keeps its checker tiles and the authored
  kitchens keep theirs. Paired GPU Δ at 3456×1894: −0.003 ms interior, +0.004 ms street (noise).
- **Dress floors with seeded decals evaluated in the floor shader, not decal geometry.** A 4×4 gpt-image-2 atlas on a
  green screen (cup rings, water stains, mould, scuffs, prints, blood, letters, newspaper, leaves), keyed to straight
  alpha by un-blending the screen colour, is one pool layer loaded with `keepAlpha`. `interiorFloorDetail` hashes a
  1.7 m world cell (pcg4d, seeded by the rug reroll) and places at most one decal per cell, kept inside its cell so a
  fragment needs one fetch; papers draw opaque, stains multiply into the floor. Grime darkens and desaturates the floor
  along the skirting from the baked floor occlusion (`floorData(p).r`). Rugs and furniture cover both. Lab:
  Look · Detail › Floor decals 0.35, Decal strength, Grime along skirting 0.6. Paired GPU Δ: −0.004 ms interior.
- **Give wall tops a moulded profile from the visible faces only.** From the top-down camera the 2.8 m wall tops are
  long bands; `emitWallCapMoulding` adds a dark cove and a walnut bead along both faces of every wall run (cove front,
  bead front, bead top: six triangles a side, `MAT.cap` so the cutaway takes them with the walls, never above 2.80 m so
  the roof cut does not). Full boxes cost +0.17 ms indoors at 3456×1894 (cause not isolated; likely the extra triangles in each shadow pass); the
  front-faces-only version costs +0.089 ms. All AR-42 floor and trim detail together: +0.13 ms interior, ~0 street.
- **Light a pair of wall sconces with one unshadowed half-space light, clipped in the shader.** Outbreak's sconces
  (`games/outbreak/src/interiors/sconces.ts`) are recorded per painting pair while the decor is emitted (in the chunk
  Worker for streamed houses, `collectSconces` for the origin block) and lit only in the house the camera is inside,
  nearest first, up to `QualityProfile.maxSconceLights` (3 pairs high, 2 balanced, 0 low). `cone.w = 1.25` marks them;
  the `lightMask` hook cuts each just behind its wall (so the room behind stays dark without a shadow pass), above the
  wall tops, and to its room along the wall (perpendicular walls found when the decor is laid out), and the attenuation
  hook sums two bulbs `extra.w` either side with a near-field core, ×3 on the wall they hang on to undo
  `wallDirectScale`, which made a single wall light invisible. All bulbs read one reserved `lampPower` slot
  (`SCONCE_LAMP_SLOT`) so they switch with the light. Measured on the mini, paired at
  3456×1894: one light per pair costs +0.42 ms (high, MAD 0.19) in a lit room and +0.21 ms on the interior bench,
  +0.16/+0.10 ms balanced, 0 low; one light per bulb had cost twice that. Also found: the origin houses' north-east
  wing roof never opened (`level.ts` `strictlyInsideHouse` left the wing out of the "outside" chunks).
- **Streamed house roofs are `customCutaway: "outside"` chunks.** Since the TBDR pass (d86d5df) custom-cutaway chunks
  only use the discard pipeline while peeking, so streamed roofs marked `true` never opened when the survivor stood
  inside. They are now skipped whole while the survivor is inside the building's rect, like the origin block's interior
  caps, and each roof's aux is looked up by building id in the window slots (slots are reused, roofless buildings
  have no chunk). `games/outbreak/scripts/interiors-proof.ts` captures procedural houses of each theme to keep this honest.
- **Outbreak's origin block has two looks, so switching between them needs hysteresis and a way back.** At spawn the
  96 m block is drawn by the authored origin build (`src/level.ts`: Ash/Elm foundation hedges, yard trees, driveway
  sedan, dense lawn tufts). The streamed copy of the same chunks (`src/world-streamer.ts`) has none of that. A
  one-way switch that fired when the camera came within 3 m of the block edge made walking down Ash's hall on a
  1728 px window swap the yards for the bare copy for the rest of the run (drawn level chunks 48 → 22). Now
  `useOriginBuild` leaves only when the camera footprint passes the edge and comes back once it is 3 m inside it.
  `games/outbreak/scripts/foliage-house-proof.ts` walks in and out of houses (solo and `--coop`) and checks this.
- **The streamed origin chunks are now cut from the origin build, so the switch is invisible.** `compileOriginChunk`
  (`src/world-streamer.ts`) slices `buildLevel`'s tagged chunks (`OriginChunk.origin`: source mesh, role, building)
  and floor/moon/bounce maps per 32 m chunk instead of re-emitting a simplified copy. The shader needed matching
  rules too: streamed-window slots carry an L-plan bit and an authored-kitchen bit (`OL.u17.w`,
  `windowBuildingBits`) so roof cuts, `interior()` and the tiled kitchen follow the bungalow's wings, not its rect;
  origin roof parts keep their own cutaway mode (`true` or `"outside"`) and only roof vertices get the slot id.
  `games/outbreak/scripts/origin-switch-proof.ts` draws both at seven poses (porches, crossroads, stores, the west
  edge, inside Ash): 1–24% of beauty pixels and 3–25% of albedo pixels changed on main, ≤ 0.14% and ≤ 0.004% after
  (the rest is street lamps beyond the block edge, which only the streamed window has). Renderer stream slots grow in 768 KB steps
  (a 256 KB step is not a whole number of 24-byte vertices and scrambles every slot after the first).
- **Streamed lots are dressed by the origin's rules.** `houseFrontage` and `housePlanting` (`src/architecture.ts`)
  and `src/yard.ts` (lawn patches, walkway and driveway tufts, gravel, tree collars, street verges) are what
  `house()` and `compileLevel` call, and `emitStreamedLot` calls them per streamed lot, seeded per chunk. Shrubs are
  anchored to the west corner, door and east corner, so narrower façades drop door-blocking ones and keep the rest
  under window sills; framing plants keep clear of neighbouring chunks' buildings and trees. Plants are copied from
  templates per (height, radius, 4 seed buckets) rather than built (`plant()` costs ~0.1 ms each, ~3 ms a lot), so a
  dressed bungalow chunk compiles in ~5 ms instead of ~3 ms. Opaque buffers above 768 KB come from per-size pools: pooling them in the 768 KB
  tile pool ratcheted the retained heap by 7 MB over three round-trip walks.

- **Anchor camera-wrapped weather volumes on the ground focus point, gate streaks by light cones (`litOnly`), and fold wet-asphalt puddle sheen into existing lamp pools without extra shader registers.**
  `packages/kit/weather/` (`@arcade/kit/weather`), `packages/kit/lab/weather.ts` and `games/outbreak/src/weather/`
  share one `WeatherSettings` contract and six presets (`Clear`, `Drizzle`, `Rain`, `Storm`, `Fog`, `Snow`) across the
  unified Lab (`/arcade/lab/?section=weather`) and Outbreak (`Renderer.draw` via `FrameInput.weather`).
  - In top-down / three-quarter views (`zoom = 34–46 m`, `pitch = 1.1 rad`), the camera eye sits `30–40 m` above and
    south of the visible ground patch; anchoring the wrapped two-layer streak/snowflake volume (`24 m` near + `42 m`
    far), ground splash rings/crowns (`26 m`), and mist billows on `focusXZ` (`anchor = [focusX, groundY, focusZ]`)
    instead of `eye` keeps every droplet and splash inside the visible streetlamp pools and flashlight cone.
  - `WeatherRenderer` evaluates up to 12 active scene lights (point lamps + directional cones) in the vertex shader with
    a forward/backscatter Mie boost, scaling opacity by `litOnly` (`0..1`) so rain outside practical pools fades into
    darkness while drops slicing through the survivor's flashlight beam or 2100 K sodium streetlamp flare brightly. Up
    to 8 building interior AABBs (`excludeRects`) cull indoor drops so cutaway rooms stay dry while roof overhang
    segments (`eaves`) emit concentrated drip lines. Omitting `discard` in premultiplied-alpha `streakFs`/`splashFs`/`mistFs`
    preserves Apple Silicon TBDR early-Z, and folding `OL.u8.yzw` (`wetness`, `puddleCoverage`, `snowAmount`)
    into `applySceneLightBounceAndHaze` and `evalFlashlightBeam` avoids crossing the 32-register SIMD occupancy cliff in
    `fsSolid`. Because the 6.2 m streetlamp's geometric mirror point for Outbreak's steep camera lands at `z ≈ 49.3` on
    the far sidewalk under the tree canopy, wet-road and puddle sheen is shaped on the road/walk pools themselves with
    `4.5 : 1` band-limited streaks elongated toward `F.cam.xz` (producing zero single-pixel fireflies or bloom shimmer).
  - Across 7 alternating Metal rounds in the Lab (`1280×800`, `perf/weather-lab.json`), whole-frame GPU medians are
    **`1.32 ms` (`Clear`)**, **`1.39 ms` (`Drizzle`)**, **`1.72 ms` (`Rain`)**, **`1.53 ms` (`Storm`)**, **`1.26 ms` (`Fog`)**,
    and **`1.28 ms` (`Snow`)**. In Outbreak (`1000×680`), whole-frame GPU medians are **`3.85 / 3.69 / 3.37 / 3.24 / 3.11 / 2.99 ms`**
    on the street and **`7.20 / 7.37 / 7.29 / 7.49 / 7.59 / 7.37 ms`** in the interior across `Clear / Drizzle / Rain / Storm / Fog / Snow`.
    In full-resolution `3456×1894` `bench-outbreak.ts` (1 warmup + 7 runs), **Rain** measures **`18.200 ms` street `p95`**
    (`MAD 0.300`, `realtime 0.9967`, `15.605 ms` GPU) and **`18.400 ms` interior `p95`** (`MAD 0.200`, `realtime 0.9959`,
    `15.915 ms` GPU); **Storm** measures **`18.000 ms` street `p95`** (`MAD 0.400`, `realtime 0.9963`, `15.711 ms` GPU)
    and **`18.300 ms` interior `p95`** (`MAD 0.400`, `realtime 0.9980`, `16.061 ms` GPU). Evidence: `perf/weather-lab.json`
    and `~/code/home/artifacts/2026-10-14-weather/`.
  - **Superseded in Outbreak by AR-71 (2026-10-19):** the 4.5 : 1 puddle streaks read as a reflective pattern on the
    road and were removed. See the next entry.

- **Outbreak storm weather (AR-71): weather as a pure function of seed and clock, a puddle mask that other features
  read, and lightning as a presentation-only shroud lift.** `games/outbreak/shared/weather/` and `src/weather/`.
  - The state (clear, drizzle, rain, storm), its intensity, wetness and every lightning strike are pure functions of
    `town.seed`, `sim.time` and `hour`, all already in snapshots, so co-op clients agree with nothing on the wire.
    Fronts are 4 minutes long with a 40% blend; storms are gated by night darkness; the first 3 minutes are dry.
    Measured over long seeded runs: clear about 55%, drizzle 22%, rain 14%, storm 9%, about 1.7 storms per hour of
    play. Wetness is a leaky integral over the last 12 minutes (72 taps of 10 s: soaks in about 45 s, dries over
    about 200 s), so it lags the rain the way a road does.
  - The shared feature sets `ai.weatherSense` each step; `ai.ts` multiplies hearing and sight range by it. That is the
    only gameplay hook (rain masks noise 30%, costs 12% sight), and it moved one difficulty band
    (`docs/outbreak-difficulty.md#weather-ar-71`).
  - Wet ground: `OL.u8.y` is wetness and `OL.u8.z` standing water. `outbreakPuddleMask(xz, onRoad)` in WGSL and
    `puddleMaskAt` on the CPU are the same function: low-frequency value noise biased to gutters and dips, with water
    only above wetness 0.35. Wetness darkens porous ground everywhere; the gloss (`OL.art.w`) is added only where the
    flashlight or a practical already lights the pixel, times `outbreakSeen`, so in the dark a wet street is just
    darker and nothing glitters. Reflections are a separate feature that reads this mask; weather owns the mask, not
    the reflection.
  - Lightning: 0.5 s slots, a strike rate of 4 a minute at full storm, 16% landing within 100 m. A flash is one or two
    flickers over 0.1–0.3 s that scale the shroud, out-of-sight darkening and night floor by `1 − lift`, and blend the
    sun direction toward the strike so sky shadows fall away from it. `Vision.skyFlash` makes in-range, in-line-of-sight
    zombies visible for the flash and they linger as ghosts afterward; the sim never sees it. Near strikes snap to the
    closest street lamp or tree within 14 m and add a point light (blue-white, then orange smoulder) and additive bolt
    and spark sprites, with no fire system. Thunder is delayed by distance / 343 m/s.
  - Rain streaks, splashes and drips still come from the kit `WeatherRenderer`, with settings blended between the kit
    drizzle, rain and storm presets on the cycle's intensity; its own lightning is off and the cycle drives the flash.
    With the vegetation gust field on (AR-66, Lively), the rain takes its wind direction, so streaks slant with the trees.
  - Two traps found on the first clip: lights written after `collectMapAndInteriorLights` builds the lamp grid are never
    shaded (pack extra lights through its `extraLights` chain), and the old weather code fed the flash into
    `render.grade[2]`, which is the red damage vignette, so every strike tinted the screen edges red.

- **Stamp level bakes locally, measure the command-buffer timestamp envelope, pace single-in-flight frames, and pack crowds in `Float32Array` SoA.**
  - **Level bakes (`games/outbreak/src/level.ts`, `games/carrier/shared/seabed.ts`, `islands.ts`):** Replacing Outbreak's per-texel `384×384` `buildingFootprint`/wall/tree/furniture scan with local bounding-box stamping drops the floor contact AO + indoor mask bake from **270.00 ms warm (941 ms cold) → 1.49 ms (181× faster)** and `compileLevel` from **692.33 ms cold / 794.39 ms warm → 291.02 ms cold / 98.24 ms warm** with `diffBytes = 0` and `diffPixels = 0`. In Carrier, memoizing coral clump head offsets in `dotCell`, stamping island/reef/bank blobs over their local bounding boxes instead of scanning open-ocean texels, and skipping uniform EDT columns/rows cuts `bakeSeabed(1024)` from **434.0 → 102.7 ms** (4.2×) and `bakeSeabed(2048)` from **1,934.0 → 418.4 ms warm / 788.8 ms cold** (4.6×) with `diffBytes = 0` across all 16,777,216 bytes.
  - **`GpuPerf` envelope & frame pacing (`packages/kit/gpu-perf.ts`, `packages/kit/gpu/renderer.ts`, `games/carrier/src/render/renderer.ts`, `packages/kit/lab/main.ts`, `stage.ts`):** Summing per-pass timestamps across a single TBDR command buffer inflated `GpuPerf.gpuMs` by 8.1×–11.0× (`25.29 ms` in Blackout Office, `37.92 ms` in Downtown, `128.66 ms` in Getaway Chase); using the command-buffer timestamp envelope `(maxT - minT)` reports the true hardware GPU time (`5.40 ms`, `3.87 ms`, `10.81 ms`). Removing out-of-band `flushPending` submissions inside `onSubmittedWorkDone` microtasks, collecting Lab's periodic 45th-frame HUD timestamps asynchronously after scheduling `requestAnimationFrame`, pre-warming Blackout's `SplatterRenderer`/`ParticleRenderer`, and pacing via `installFramePacer` eliminates the `133.4 ms` (8-vsync) `rAF` stalls: across 60-second continuous headless Metal runs (~3,715 frames each), `> 50 ms` `rAF` stalls drop to **0** in Blackout Office (`p50 16.1 ms, p95 16.1 ms, max 27.4 ms`), Carrier (`p50 16.1 ms, p95 16.1 ms, max 28.0 ms`), and Lab (`p50 16.1 ms, p95 16.2 ms, max 24.2 ms`).
  - **Outbreak 500-zombie crowd SoA & A* repath cap (`games/outbreak/src/zombies.ts`, `packages/kit/sim/ai.ts`):** Raising `MAX_INSTANCES_PER_PART` from `256 → 2048` fixes limb cutoff above 128 zombies (`6,500` vs `2,048` instances at 500 zombies). Adopting `SoAZombieCrowdRenderer` (with `buildZombiePartMeshes()` separated from analytical 2-bone register packing and `26 m` terrain-support LOD) cuts 500-zombie draw CPU from **4.932 ms median / 7.405 ms p95 (11.30 / 36.08 ms in audit) → 0.516 ms median / 0.672 ms p95** (`9.6×` faster while drawing `3.17×` more instances), and 100-zombie draw from **1.160 → 0.249 ms**. Capping `stepAICrowd` A* calls to `MAX_REPATHS_PER_TICK = 4` cuts 500-zombie `ai.step` `p95` from **38.572 → 1.849 ms (20.9× faster)**.

- **Bucket cuttable walls into 2D `(xBand, zBand)` tiles and partition `shadowLightCount` before shadowless lights.**
  In Release 5 (combining `outbreak-lighting`, `architecture-materials`, `ground-clutter`, and `foliage-lab`), 1D `zBand` wall chunking in `games/outbreak/src/level.ts` (`screenChunks`) merged all walls across the 15 m width of a house into one `cutBox`, forcing the entire house's walls into the `discard` pipeline (`levelCut`) whenever the player walked through the hallway. Bucketing `screenChunks` by 2D `4m × 4m` `(xBand, zBand)` tiles keeps 85% of house walls in `fsSolid` with Apple TBDR Hidden-Surface Removal intact. Partitioning shadow-casting lights ahead of shadowless lights in `games/outbreak/src/main.ts` (`render.shadowLightCount`), rejecting cone back-hemispheres (`dot(dv, L.cone.xy) <= 0.0`) before `sqrt` in `lightMask`, replacing the second 5-tap `shadowAt` in `evalFlashlightBeam` with a 1-ray polar check, and precomputing `groundY` per drifter/hinge track in `OutbreakAmbientMotion` cut 3456×1894 M5 Max Metal GPU medians from **17.912→15.450 ms** (street) and **18.793→16.016 ms** (interior), and fresh-submit `p95` from **22.00→18.10 ms** (street, MAD 0.20 ms) and **22.50→19.80 ms** (interior, MAD 0.90 ms) across 1 warmup + 7 measured runs, while reducing Primary 70s Sodium combined ΔE2000 from **13.813→6.677 (-51.7%)**.

- **Unify explosions through one shared blackbody-billow + volumetric-smoke system and thin renderer adapters.**
  `packages/kit/fx/explosion.ts`, `particle-renderer.ts` (`makeParticleShader`, `blackbodyFireWgsl`) and `volume-renderer.ts`
  drive seven typed presets (`grenade`, `propane`, `car`, `barrel`, `missile`, `ship`, `pop`) parameterised by size, energy,
  fuel duration, smoke amount/darkness/shift, debris/sparks, scorch, flash and shockwave ring, with distance and
  concurrent-load LOD scaling (`computeExplosionLod`), proximity volume coalescing (`3.2 m`), 4-slot oldest eviction,
  per-ray 3D volume AABB clipping and fast 1-tap `densityFast` self-shadowing (`packages/kit/fx/volume-shader.ts`).
  Getaway's `StreetProps` and `Renderer` (`games/getaway/src/game/props/index.ts`, `src/render/renderer.ts`), Blackout's
  `Game` and `@arcade/kit/gpu/renderer` (`games/blackout/src/game/game.ts`, `packages/kit/gpu/renderer.ts`), and Carrier's
  `WeaponFx`/`ExplosionFx` (`games/carrier/src/render/weapon-fx.ts`, `explosion-fx.ts`, `explosions.ts`, binding at
  `@group(1)` with reversed-Z `depth32float` `greater-equal` so `@group(0)` `Frame` stays intact) all call `spawnExplosion`
  and `explosionFlashLight`. Legacy per-game fire/ring/scorch sprite loops (`PropParticles` kind 12, `Game.explode` sprite
  loops, `Vehicles.burst`, `FireWater` kind 8 quads, and `WeaponFx` `RockPool` fireball/debris rocks) and duplicate Lab
  Library explosion entries are removed. Across seven alternating pairs of 30 active blast frames on M5 Max/Metal
  (`scripts/lab/prove-explosion-unify.ts`, `perf/explosion-unify.json`), whole-frame GPU mean / peak costs are:
  - **Getaway (`960×720`)**: single blast **0.648→0.761 ms** mean (**0.676→0.803 ms** peak, delta `+0.113 ms`, MAD `0.001`);
    4× simultaneous propane/fuel worst-case **0.697→0.818 ms** mean (**0.735→0.889 ms** peak, delta `+0.121 ms`, MAD `0.001`).
  - **Blackout (`960×720`)**: single grenade **1.000→0.870 ms** mean (**1.421→1.032 ms** peak, delta `-0.130 ms`, MAD `0.263`);
    5× grenade-spam worst-case **1.928→4.862 ms** mean (**2.737→6.657 ms** peak, delta `+1.221 ms`, MAD `0.594`).
  - **Carrier (`960×720`)**: single deck strike **0.351→0.377 ms** mean (**0.400→0.450 ms** peak, delta `+0.039 ms`, MAD `0.051`);
    4× simultaneous ship+airburst+boat worst-case **0.687→0.602 ms** mean (**0.725→0.725 ms** peak, delta `-0.085 ms`, MAD `0.059`).
  All single and worst-case scenarios remain well within the 16.67 ms (60 Hz) frame budget; non-exploding frames add zero draws or passes.
  R-1 follow-up (`explosion-r1`): big hits now throw **burning fragments that lay their own smoke trails** instead of
  straight smoke beams. `ParticleSpec.trail` (metres) marks a particle as a projectile; `Particles.update` lays thinning,
  wind-drifting puffs by distance travelled (capped at ~40 puffs/s per fragment, widened to match), a short hot spark at
  the head, a splash when it crosses `Particles.water`, and `ParticleSpec.pop` fires a delayed fireball burst where a
  particle expires (`packages/kit/fx/projectile-trail.ts`). Presets gain `fragmentCount`/`secondaryPops` (ship 16/3,
  missile 6/0, car 4/1, barrel 3/1, propane 2/0, grenade and pop none); the ship hit also lingers 7 s with a taller
  column. Carrier's faceted white spray balls (the "ice shards" in R-1's boat and bench frames) are replaced by
  `spawnWaterSplash`: velocity-stretched droplets, a crown and soft mist. Peak pool use: ship 1,129 of 2,048 at Lab scale.
  On Mac Studio/Metal against the R-1 head (`perf/explosion-unify.json`, seven alternating pairs, whole frame), paired
  GPU mean deltas stay within noise: Getaway single `-0.014 ms` (MAD `0.257`), 4x `-0.024 ms`; Blackout single
  `+0.005 ms`, 5-grenade `+0.149 ms` (MAD `0.371`, peak 7.92 ms vs 7.51 ms; grenades throw no fragments); Carrier single
  `-0.002 ms` (0.43 ms mean), 4x `-0.013 ms`. The Carrier proof camera now passes radians to `Camera.set` (it was
  clamped to top-down) and clears every effect pool between beats.

- **Preserve destination HDR alpha on blood decals for Noir selective colour, and gate shared `MotionBlur` impulse bursts to active frames (`@arcade/kit/client/camera`, `@arcade/kit/gpu/motion-blur`, `packages/kit/fx/splatter*.ts`).**
  Outbreak's Noir look encodes per-pixel flashlight irradiance in `hdrView.a` (`1.0 - lookFlashIrradiance`). `SplatterRenderer` previously blended alpha with `srcFactor: "one", dstFactor: "one-minus-src-alpha"`, overwriting `hdrView.a` to `~0.95` and erasing the flashlight's selective-colour mask so blood inside the beam desaturated to flat grey, while `zombies.ts` left `prevBones` zeroed on first-frame detachments, launching detached-limb blood upward at `+30 m/s`. Preserving destination alpha (`alpha: { srcFactor: "zero", dstFactor: "one" }`), evaluating flashlight and room-lamp wet meniscus specular in `SplatterRenderer`, splitting exit-wound droplets into immediate under-body pool, directional floor fan, and wall-arc tiers with two-pass coplanar-first terrain receivers, and running `@arcade/kit/gpu/motion-blur` (`MotionBlur` + `MotionBlurBurst`) before bloom/composite only when continuous shutter blur or an impulse burst is active (`0.000 ms` steady-state overhead when inactive; `compositeFast` runs on every Noir frame) raise Outbreak's Noir selective-red ratio from **`7.38× → 36.16×`**, improve street beam-blood $\Delta E_{2000}$ **`10.41 → 8.46`** and wall-splatter $\Delta E_{2000}$ **`17.82 → 12.67`** against the `gpt-image-1.5` paint-over target (`captures/game-feel/blood-metrics.json`), and keep steady-state `3456×1894` GPU time within noise (`+0.007 ms` street / `-0.016 ms` interior).

- **Keep game-owned roof discard out of the opaque entry point, cull off-screen lamps, and pace fixed ticks.**
  Outbreak used its roof hook in `fsSolid`, mixed floors with screen-cuttable walls, routed exterior tree canopies into
  the `discard` pipeline, and clamped visible frame deltas at 50 ms without an accumulator. Its level writer now keeps
  exterior trees and streetlamps in `fsSolid`, gates building roof/chimney `customCutaway` chunks on the player's
  building footprint, and skips completely interior chimney/roof-cap triangles while inside that building. `main.ts`
  culls lamps against the camera ground frustum, skips the zero-power sight slot in `lightSum`, reuses shared adjacent
  rays across `shadowAt` taps, discards the 4× MSAA depth attachment when volumetric smoke is inactive, and paces
  single-in-flight submissions through `FrameClock` (`shared/clock.ts`, 60 Hz fixed ticks, 12-substep frame cap, 0.5 s
  hitch debt cap, timestamped input transitions, pause/hidden anchor reset). All 196,722 seed-7 vertices and every
  captured RGB pixel at 3456×2006 match `main` (`diffPixels = 0` in both street and interior). On M5 Max/Metal at
  3456×2006, dependent whole-frame GPU intervals fall **26.434→11.623 ms (56.0%)** on the street and
  **40.320→17.759 ms (56.0%)** in the interior. Across seven 2-second live traversal runs at 3456×1894, fresh-state
  submission `p95` drops **109.6→32.4 ms** (street) and **138.3→24.4 ms** (interior), fresh states/s rise
  **15.41→48.26** and **13.29→45.23**, and simulated/wall-time ratios recover from **.623/.546** to **.995/.994**
  (3.38 m/s out of 3.40 m/s). See `perf/outbreak-performance.md`.

- **Bake fine window coverage separately from soft AO.** Blackout's 12.5 cm moon mask, 18.75 cm blocker march and
  box blur created stepped diagonals and cloudy mullion bands. Exact world-space segment/rectangle intersections and
  2×2 coverage samples in a separate 3.125 cm R8 moon mask fix those edges without changing AO bytes. This costs
  1.60–1.85 MiB and an extra 31–56 ms once per level for the two office seeds tested. One extra filtered sample added
  no measurable GPU cost in the 1440p M5 Max wood-room fixture (median −0.00048 ms, MAD 0.00249). See
  `perf/blackout-window-light.md` and `scripts/window-proof.ts`; motion/Look toggles produced identical movement poses.

- **Attach splatter to the hit triangle.** `packages/kit/fx/splatter.ts`, `splatter-surfaces.ts` and
  `splatter-renderer.ts` share a seeded ballistic spray and matte deposits across blood, ink, slime, oil and potion
  presets. Blackout supplies packed visible receiver geometry; Outbreak can supply its own triangle/material list.
  Swept-point collision catches thin walls and desk tops before the floor. A surface tangent from impact velocity
  gives grazing elongation, and fragment clipping confines each deposit to up to 12 coplanar receiver triangles.
  Glass stops spray without receiving a stain. At most 256 drops and 256 deposits recycle in fixed arrays.
  - [Godot's decal guide](https://docs.godotengine.org/en/stable/tutorials/3d/using_decals.html) describes normal fade,
    receiver masks, overlap limits and decal overdraw. This small system uses exact receiver triangles and material
    classes instead of a projection volume. Reusing the hit normal prevents a wall hit from becoming a floor decal.
  - The Lab compares the shipped blood against the candidate on pale tile, walls, desk tops and a dark street.
    An inspected 1280×1260 sheet includes the actual Blackout renderer. The Lab's analytic grid initially competed
    with the supplied y=0 floor; scene mode 5 now lets an adapter own its floor. A steeper camera clears foreground
    roofs while keeping the target visible. Existing Lab scene modes retain their behavior.
  - Paired whole-frame GPU deltas at 1000×720 on M2 Max/Metal were +0.050 ms office (MAD 0.078) and +0.043 ms
    downtown (MAD 0.058). Both are smaller than their noise, so cost remains inconclusive. See `perf/lab-splatter.md`
    and its raw JSON. The Blackout style stays opt-in; gameplay damage and detachment remain caller-owned.

- **Give small fire and water effects a continuous silhouette.** The Lab's `Fire and water` section compares current
  emitters with Flowing and Graphic styles in the generated downtown, office and Getaway alley. The shared
  `packages/kit/fx/fire-water.ts` renderer uses three overlapping upright flame quads, a small additive core,
  alpha smoke and rising embers. Upward-scrolling procedural noise erodes the tapered silhouette; the same flicker
  signal changes flame height and light power. A depth-gated post-HDR distortion adds heat shimmer. Water combines
  a continuous pressure sheet with velocity-aligned droplets, impact spray, expanding rings and a growing puddle.
  The puddle perturbs its normal for ripples and samples up to eight scene lights for warm streetlamp and siren sheen.
  Foam stays near the irregular boundary. These are shared Lab candidates; game renderer adoption is still separate.
  Matched Metal captures and paired whole-frame costs are documented in `perf/lab-fire-water.md`.
  - [Febucci's procedural fire breakdown](https://blog.febucci.com/2019/05/fire-shader) combines scrolling noise with
    a gradient mask. The Lab uses that shape/erosion approach with textureless fBm and a hot yellow-white core fading
    through orange to red tips. [Epic's Niagara smoke guide](https://docs.unrealengine.com/4.27/en-US/RenderingAndGraphics/Niagara/HowTo/RecreateSmoke/)
    shows the flipbook alternative; authored frames can give richer billows at a texture-fetch cost, but this study
    keeps all shapes procedural. Ember drift uses a helical path as a cheap curl-like approximation.
  - [Nimue's stylized-water breakdown](https://80.lv/articles/how-to-build-stylized-water-shader-design-implementation-for-nimue)
    separates moving normals, reflections, foam and interactive ripples, and reuses noise for foam. At gameplay zoom,
    the Lab keeps the jet sheet, stretched drops and puddle separate so the jet remains readable between particles.
    The sheen is direct-light specular, not reflected scene geometry. No water simulation or screen-space reflection
    buffer is required. Heat shimmer does require an HDR copy and one extra pass, included in the timing.

- **Keep isolation tools in one Lab.** `packages/kit/lab/` runs in the one Lab app (`games/lab`, `/arcade/lab/`), sharing one device,
  test scene and keyboard panel. Only the active section ticks. Spawn uses real car/chassis, soldier and prop adapters;
  Physics inspects those same bodies. Lighting persists between sections; transient effects reset. Evidence:
  `perf/lab.json`, `perf/lab-spawn.json`, `perf/lab-effects.json`.
- **Keep opt-in rendering styles ("Looks") on a separate pipeline from the identity default.** `packages/kit/gpu/look.ts`
  (`@arcade/kit/look`) and `packages/kit/lab/looks.ts` share a 64-float `LookUniforms` block, six presets (`Current`,
  `Noir / Limbo`, `Painterly`, `Cinematic dusk`, `70s sodium`, `Cozy golden hour`), deterministic per-group `tuningSeed`
  randomization, versioned preset import/export, and `look.preset` / `look.set` / `look.randomize` Lab commands. When
  `isIdentityLook` is true (`Current`), `Renderer` (`packages/kit/gpu/renderer.ts`) keeps its untouched baseline shaders
  and pipelines (`diffBytes = 0` on Outbreak's street frame). Non-identity presets lazily compile `makeLookSceneShader`
  and `makeLookPostShader`, binding `LookUniforms` to existing scene slot 7 and post slot 4 without changing bind-group
  layouts. `Noir / Limbo` reuses Outbreak's already-traced polar sight row 0 for a shadow-casting player flashlight cone
  at zero extra ray cost, while preserving warm practical lamp hues during desaturation; `Painterly` combines 3-band
  smoothstepped wrap diffuse, a 4-quadrant variance-weighted Kuwahara filter, and depth/normal ink outlines. On Metal
  (`1280×800`, 1 warmup + 7 alternating rounds), whole-frame Debug Room GPU medians are `1.442 ms` (`Current`),
  `1.659 ms` (`Noir / Limbo`), and `1.630 ms` (`Painterly`); in Outbreak (`1000×680`), queue-completed frame-span
  medians are `3.313 ms` (`Current`), `4.025 ms` (`Noir / Limbo`), and `3.813 ms` (`Painterly`). Evidence:
  `perf/looks.json` and `scripts/lab/prove-looks.ts`.
- **Share procedural material recipes between the Lab swatch and production scene shader.** `packages/kit/gpu/surface-materials.ts`
  and `packages/kit/lab/materials.ts` evaluate the same WGSL recipes for matte wood planks (`roughness = 0.84`, no broad
  specular sheen, staggered board lengths, butt-joint AO, warm/cool plank tint), 2×2 quadrant Voronoi cobblestone
  (varied stone sizes, worn rounded edges, recessed dirt joints), paint/plaster mixture walls with causal runoff,
  multi-scale asphalt/concrete, warped clump-correlated turf, and clustered foliage/ground cover. Filter widths (`fwidth`)
  band-limit detail before divergent branches and fold unresolved micro-variance into roughness. The Lab exposes Room,
  Ball, and Plane swatches under the stage lighting presets with Before/After/Split comparison and a separate
  `tuningSeed` for deterministic randomization. In Outbreak (`1000×680`, M5 Max Metal, 1 warmup + 7 alternating pairs of
  120 steps against `076fb7c`), static vertices drop `196,722 → 139,620`; median paired frame-span deltas are `-1.1 ms`
  street (`9.0 → 7.9 ms`, range `-3.9 to +0.9 ms`) and `+0.3 ms` interior (`9.0 → 9.9 ms`, range `-4.3 to +2.2 ms`,
  inside spread). Default Blackout and Getaway shaders remain unchanged.
- **Project generated flat-diffuse material textures with linear-light mips and procedural breakup.** `scripts/textures/prepare.ts`
  prepares 16 `gpt-image-1.5` orthographic top-down diffuse textures into a 1,098 KB lossless `256×256` RGBA WebP manifest
  (`packages/kit/textures/`, served prefix-safely under each game's `texture-assets/` route via `scripts/texture-assets.ts`).
  Isotropic materials (`wallpaper_plaster`, `sidewalk_concrete`, `street_asphalt`, `lawn_grass`, `tree_bark`, `leaf_atlas`,
  `cobblestone_pavers`) use Lamplight's mirrored-quadrant wrap; directional course materials (`wood_floorboards`, `kitchen_tile`,
  `clapboard_siding`, `asphalt_shingles`, `brick_masonry`) use toroidal raised-cosine cross-blending so horizontal courses stay
  upright; rectangular rugs (`rug_oriental_sage`, `rug_persian_burgundy`, `rug_braided_runner`) use bilateral symmetry on
  normalized `[0, 1]²` floor rectangles. RGB stores sRGB base-color variation with a 9-level linear-light mip chain
  (`buildLinearMipChain` in `packages/kit/textures/loader.ts`); Alpha stores a restrained linear authored roughness estimate
  (not measured), and `lawn_grass_normal` stores a mild luminance-derived tangent normal + height (labelled derived, not measured).
  In `packages/kit/gpu/surface-materials.ts`, compile-time constant layer indices per material branch avoid Apple Silicon
  `texture_2d_array` slice-divergence stalls (`41.8 → 24.2 ms` interior GPU interval). Evaluating `postLightMaterial` after
  `lightSum` (so material/texture locals do not stay live across the polar shadow loop), packing Outbreak's texture Lab bits into
  unused `F.screen.w` instead of a third uniform buffer, omitting unused `bounceTex`/`floorPattern`/`city` branches when
  `postLightMaterial` is supplied, replacing the 4-iteration `interior(p)` loop with a branchless quadrant `select`, and
  resetting Chromium `DOMTimer` nesting via `MessageChannel` in `scheduleFrame` bring `3456×1894` M5 Max Metal `bench-outbreak.ts`
  (1 warmup + 7 runs) below the pre-texture baseline: street GPU **`15.813 → 12.802 ms` (`-19.0%`, MAD `0.006 ms`)**, street
  fresh-submit `p95` **`19.400 → 16.800 ms` (`-13.4%`, MAD `0.000 ms`, `57.73` states/s)**, interior GPU **`19.252 → 14.473 ms`
  (`-24.8%`, MAD `0.026 ms`)**, and interior fresh-submit `p95` **`22.800 → 18.400 ms` (`-19.3%`, MAD `0.300 ms`, `57.09`
  states/s)**, with `0.12%–0.21%` mean RGB difference (`0.31–0.55 / 255`) against the unoptimized textured output. Lab Materials
  and Outbreak's Backquote panel expose per-recipe texture map selection, scale, rotation, contrast, roughness trim, and
  procedural A/B comparison.
- **Exclude a convex receiver from its own shadow test, and supersample only near analytic edges.** The Lab's fullscreen
  raytraced stage (`packages/kit/lab/stage-shader.ts`) evaluates inside a 4× MSAA pass, where a single fullscreen triangle
  otherwise runs once at pixel center and broadcasts a flat `frag_depth` across all four subsamples. Entry-slab normals
  (`argmax(lo.x, lo.y, lo.z)`) prevent downward normal flips at `y = 0` wall–floor seams; closed-form signed-slab
  clearance (`boxShadow`) replaces the 3-tap 256-bin polar staircase with continuous contact-hardening penumbras; 4× RGSS
  sub-rays run only when the center ray passes within 8 cm of a box/sphere edge (`Edge AA` and shadow `Softness` live in
  the shared Lab panel); and `frag_depth` uses the furthest subsample hit so rasterized 4× MSAA meshes at `y = 0` do not
  fail upper-subsample depth tests. Seated car greenhouse/scoop bases (`games/getaway/src/render/car-mesh.ts`) remove
  shallow mesh self-intersection stair-steps. Nine alternating Metal pairs at 1280×800 (`740×722` viewport) on M5 Max
  measured whole-GPU deltas of +0.2215 ms room (MAD 0.0221) and +0.0252 ms yard (MAD 0.0908, inside noise), with zero
  pixel change across 30 stationary frames (`perf/lab-shadow-edges.json`).
- **Bounded smoke can fill rooms through doors.** `packages/kit/fx/volume.ts` computes corner-safe weighted arrival
  distances through 48² wall-clipped fields. Blackout grenade and wreck plumes use four bounded slots; Volume Smoke
  restores legacy sprites for comparison. The shader combines a height envelope, moving noise, self-extinction and
  eight nearby lights. Rays stop at stored MSAA depth, render at at most 480×320 with 24 steps, then depth-aware
  upsampling places them before bloom. Shots carve temporary cylinders. Walls ≥1.8 m and glass seal the field;
  low wrecks remain depth occluders. This is visual only; fluid pressure and vertical furniture flow are unimplemented.
- **Separate empty gas from solid geometry.** The room-smoke shader previously rejected samples whenever the
  nearest density byte was zero, defeating linear interpolation and producing square columns during growth/fade.
  An independent occupancy channel retains wall clipping while RG16F density preserves the soft onset. A 16-direction
  weighted field replaces Manhattan travel; tests bound angular radius variation to 5% and 60 Hz front jumps to
  0.12 m, less than a quarter cell. The same 24-step/480×320 renderer produces the matched Metal frame-20/40/80/160
  captures in `perf/smoke-volume-refinement.md`. Diagonal filter taps also respect adjacent walls; an actual WGSL
  compute probe reads zero across a blocked corner and positive density in an empty growing-front cell.
  Seven paired measurements show +0.166 ms render GPU time (MAD 0.008 ms); upload-inclusive queue timing is noisier
  at +0.206 ms (MAD 0.032 ms). Storage rises by 83,004 CPU bytes
  and 27,648 field-texture bytes. Both paths remain bounded, and updates allocate no arrays.
- **Couple blackbody fireball crusting to buoyant, billow-eroded soot volumes.** `packages/kit/fx/explosion.ts`,
  `particle-renderer.ts`, `volume.ts` and `volume-shader.ts` replace the Lab's 75 flat orange Gaussian sprites and
  constant-tint linear smoke crawl with a multi-phase explosion. `ParticleRenderer` adds procedural domain-warped
  fireball billows (`kind = 7`) where a Planckian temperature ramp cools convex outer lobes into dark charcoal soot
  first while deep fissures roar white-yellow-orange, plus planar ground shockwave/dust rings (`kind = 5`), charred
  ground scorch decals (`kind = 6`), temperature-cooling ballistic sparks (`kind = 1`) and elongated 3D shrapnel
  splinters (`kind = 2`). For `soot > 0` explosions, `SmokeVolumes` uses a two-stage blast ease-out + buoyant drift,
  keeps the central fireball cavity clear during the initial `0.44 s` flash so low-res smoke does not muddy the
  high-res fireball, erodes outer cloud edges with 3D billow noise to eliminate `0.5 m` grid-cell stepping, and
  shifts smoke albedo from deep charcoal soot (`#13110f`) through warm umber-grey to pale ash-grey (`colorShift`).
  The Lab exposes typed `Fireball`, `Explosion Smoke` and `Blast & Debris` controls, `Loop interval` (default `2.2 s`),
  and deterministic `tuningSeed` randomization (`effect.randomize`, `effect.trigger`, `effect.loop`) that retriggers
  one-shot effects immediately. Across 7 alternating Metal pairs at `1280×800` (20 active explosion frames per run,
  including dynamic polar-shadow flash lighting), median whole-frame GPU time is `0.8041 ms` vs `0.4542 ms` baseline
  (`+0.3464 ms`, MAD `0.0107 ms`; `scripts/lab/prove-explosion.ts`).
- **Keep extracted tyre smoke exact.** The canonical solver and shader live in `packages/kit/fx/smoke-trail.ts` and
  `tyre-renderer.ts`, shared by Getaway and both Lab hosts. Integration adopts the approved main billow algorithm and
  vertex-lit shader, replacing the older connected-field study. Tunable constants retain the shipped defaults.
- **Measure the two volume passes with retained depth on both sides.** The earlier Blackout nine-pair frozen-room
  measurement added 0.947 ms median, MAD 0.016 ms, at 960×640 on M5 Max/Metal (`perf/fx-kit.json`). It excludes the
  depth discard-to-store change and is not a four-cloud bound. The interval covers first polar compute through a
  dependent offscreen final composite; no pass sums.

- **Linux software WebGPU needs presentation support too.** The production smoke browser's ANGLE SwiftShader
  adapter initialized, then lost its instance at the first Outbreak canvas presentation with
  `Could not find SharedImageBackingFactory` / `Instance dropped error in getCompilationInfo`.
  `scripts/smoke.mjs` now enables Vulkan with SwiftShader and disables the native Vulkan surface on Linux.
  The failure reproduced in headless Chromium 1248 on Linux; all three production smokes passed with these flags.
  Keep errors fatal: accepting adapter creation alone would miss this failure.

- **Diagnose washed-out surfaces before changing specular.** Outbreak's ground specular was already zero.
  `games/outbreak/scripts/refine-proof.ts` captures the shared shader's albedo/direct/ambient/specular/bloom
  contributions through the Lab. Smaller practical pools, sheltered ambient and removal of additive blue shadow
  lift corrected the main wash. Room lamps are excluded above the roof underside. Default shared WGSL remains
  equivalent across twelve outputs. See `docs/outbreak-look-v2.md` for aligned evidence and limitations.
- **Cull and simplify generated planting before adding density.** The second Outbreak pass removes covered
  terrain and excess grass/gravel, replaces sphere crowns with fewer folded-leaf sprays, and gives props their
  own render bounds. Static vertices fall 299,238→196,722; street submitted vertices fall 164,820→97,014.
  Seven M5 Max/Metal pairs at 1000×680 have mixed frame results: street aggregate medians 10.0→9.6 ms,
  interior 9.9→10.7 ms. Keep those queue-completed spans distinct from GPU time. The measured Metal render-pass
  timestamp intervals overlap; summing them would falsely attribute cost. Generation uses a three-entry cache,
  and the determinism test explicitly evicts it before comparing independently compiled meshes.
- **Separate scenery memory from actor LOS.** Outbreak's initial cone blacked out most of its neighbourhood.
  Static room discovery now supplies the scenery texture while `Vision.visible` retains strict occlusion for actors.
  A regression discovers a room, closes its door, and confirms its scenery persists without granting actor sight.
  Exterior scenery remains lit, and remembered interior scenery is desaturated instead of hidden behind wedges.
  `docs/outbreak-look.md` contains actual before/target/after captures and the seven-pair cost report.
- **Pass per-pixel 3D flashlight irradiance in the HDR alpha channel for selective-colour Noir grading, and pair feathered memory fog with SoA last-known ghosts and jittered sound ripples.**
  In `packages/kit/gpu/look.ts` and `look-shaders.ts`, `Noir / Limbo` (`selectiveColor = L.u15.w = 1.24`, Outbreak's default look) desaturates the world outside the player's flashlight to near-monochrome (`saturation = 0.04`, `outsideChroma = 0.75 / 255` street, `0.54 / 255` interior) while restoring full natural colour inside the 3D polar-shadow-tested flashlight cone (`beamChroma = 30.48 / 41.19`, `selectiveColorRatio = 40.9× / 76.0×`, `ΔE = 5.69` street / `8.44` interior against `gpt-image-1.5` targets). Encoding `outAlpha = 1.0 - clamp(lookFlashIrradiance, 0.0, 1.0)` in the 4× MSAA `rgba16float` scene pass keeps `1.0` as the fixed point of `one, one-minus-src-alpha` blending so unlit translucent sprites and decals outside the beam never trigger false colour retention, and adds zero render targets or texture bindings. Compiling a dedicated `compositeFast` entry point (1 `src` sample + rational Padé filmic curve without Kuwahara arrays or AgX matrices) and keeping `inst`/`glass` in `fsSolid` inside `ensureLookPipes()` cut `3456×1894` M5 Max Metal whole-frame GPU time from `39.34 → 15.653 ms` (street, MAD `0.026 ms`, fresh-submit `p95 = 18.400 ms`, `realtime_ratio = 0.9975`) and `31.84 → 16.040 ms` (interior, MAD `0.028 ms`, fresh-submit `p95 = 18.800 ms`, `realtime_ratio = 0.9969`). `Vision.actorVisible` (`games/outbreak/shared/vision.ts`) samples an actor's lateral shoulder disk against the polar blocker map so doorway/ray-boundary zombies are never falsely culled while walls/closed doors strictly occlude; `games/outbreak/src/shaders.ts` and `zombies.ts` add a top-down horizontal contour rim (`lumaP92 = 74–88 / 255`, contrast `52–72` in dark LOS), zero-allocation SoA last-known position ghosts (`seenPose` fading over `3.2 s` and clearing when the spot is seen empty), and spatially jittered (`±0.7–1.35 m`) Noir sound ripples across 3 Lab-selectable fog variants (`fogStyle` `0..2`, exposed in the Lab `fog` variation grid).
- **Noir v2: shade the flashlight as a physical spotlight, drive selective colour from received light through a soft
  knee, and render line of sight as a soft, temporally smoothed visibility field.** The survivor's flashlight
  (`games/outbreak/src/lighting.ts`) is packed with `cone.w = 2`, which tells kit's `lightSum` to skip its plan-space
  cone so `flashAttenuation` can shape the beam in 3D: inverse-square falloff softened inside a near-lens radius and
  windowed to the beam range (`(1 - x⁴)²`), an axis tilted down toward a pool distance so the pool stretches at grazing
  angles, a soft cone with a hot core, a wide dim spill and faint reflector rings. Running inside the existing lights
  loop reuses its 5-tap `shadowAt`, wrap diffuse and specular; a new `lightAccumulate` hook leaves the flashlight's
  received irradiance in a private for the colour mask. Air scatter is the top-down closed form (chord grows with
  distance, intensity falls with its square, so the glow fades like 1 / distance from the lens inside the plan cone,
  stopped at the first wall along the aim) and the bounce is one warm diffuse fill from where the axis lands. Paint-over
  comparison on the street aimed down the road (`scripts/noir-proof.ts` + `scripts/noir-profile.py`, 1000×680): the
  old beam was a flat plateau ending in a cliff at 7 m; the new pool peaks at Y `0.60` (target `0.68`) and falls
  smoothly to 10% at 7.8 m (target 7.3 m), with a 28.5° FWHM at 5 m (target 28.5°). The selective-colour mask is
  `1 - exp(-(flash + practicalColor × practical) / knee)`, so saturation rises with light instead of switching on: its
  10–90% edge across the beam widened from 10.5° to 39° (street 9.8° → 30°). Noir keeps the world muted but not
  monochrome (saturation `0.42`, warmer temperature `0.2`, toe `0.12`, black crush `0.004`, no film grain): median
  frame L* rose from 5.4 to 9.2. Line of sight is a compute pass (`VisibilityFieldShader` in
  `packages/kit/gpu/renderer.ts`, `visibilityFieldShader` in `games/outbreak/src/fog-of-war.ts`): 768² texels over the
  map, a 512² window around the eye each frame, feathered vision cone and awareness circle, 7 interpolated polar rays
  across a lateral penumbra that widens with distance (radially tight, so no light through walls), separate reveal
  (0.07 s) and fade (0.25 s) times and a soft fine-grained memory channel; the scene samples it once instead of tracing
  rays per pixel, and 1-code-value IGN dither in `compositeFast` stops 8-bit banding. Gameplay visibility stays in
  `shared/vision.ts`. Sound ripples and unexplored-room grain are off-by-default Lab options. Cost: paired in-page A/B
  says the field pass is unmeasurable (`+0.02 ms`); against `origin/main` on a shared, loaded M5 Max, whole-frame GPU
  is `+0.2 ms` street / `+0.5 ms` interior with realtime ratio ≥ 0.994. A first version that marched the air glow (6
  samples with polar taps) and traced its own shadows in the surface hook cost `+2.2 ms` even with every feature
  switched off at runtime: register pressure, not work. Compile-out bisection found it; runtime toggles could not.
- **Encode per-pixel unseen LOS weight into negative `lookFlashIrradiance` (`hdr.a > 1.0`) and compose all 5 Unseen fog-of-war layers in `compositeFast` with at most one displaced HDR tap.**
  In `games/outbreak/src/unseen/` (`settings.ts`, `shader.ts`, using `@arcade/kit/gpu/wgsl`), Outbreak's opt-in `Unseen` visibility treatment (`unseenMode = 0` off by default) combines the local survivor's 512-ray polar blocker field, wide facing/aim cone, close 360° awareness circle, and active flashlight cone (`evalUnseenFlashCone` in `visibilityFieldShader` and `FlashlightSightInput` in `shared/vision.ts`), plus an edge-depth ramp in `visField.b` (`evalUnseenEdgeDepth`). Keeping the 4× MSAA scene pass branch-free on `uMode` (`applyOutbreakUnseenScene` only sets `outbreakUnseenAlpha = wUnseen * 4.0`, packed into `targets.hdr.a = 1.0 + outbreakUnseenAlpha` via negative `lookFlashIrradiance` while `0..1` stays reserved for selective-colour flashlight retention) avoids VGPR inflation in the MSAA scene shader and requires zero extra bind-group entries or render targets. On the CPU, `packUnseenPostParams` packs all five effective layer weights (`wGlitch`, `wWarp`, `wShroud`, `wMemory`, `wNoise`, scaled automatically with `dayCycle(hour).darkness` and low-health panic), the edge-band glitch factor `uEdgeBand` (`0..1`), and `updateRate` (`2..60 Hz`) into the three 24-bit integer-mantissa floats of `GL.pad.yzw`. In `compositeFast` (`makeLookPostShader` / `postShader`), `applyOutbreakUnseenPost` reads the normalized spatial mask `unseenMask = clamp((centerSamp.a - 1.0) * 0.25, 0.0, 1.0)` (deriving an LOS boundary bell `edgeBell` when `uEdgeBand > 0` so glitch can be restricted to the vision boundary) and composes any solo or multi-layer mix of: (1) **Acid Knife glitch** (Powerhoof-inspired low-Hz stepped horizontal scanline and macro-block UV tear, red/cyan chromatic edge split, and slate-indigo wash), (2) **Warp wobble** (two-octave domain-warped refraction outside the cone), (3) **Dark shroud** (classic soft-edge desaturated darkness), (4) **Stale memory** (faded archival snapshot of explored rooms with static paper grain and last-seen zombie ghosts), and (5) **Noise film** (stepped 16mm silver-nitrate grain and 4×4 Bayer dither thickening away from sight). Even when Glitch and Warp are active together, their UV offsets share a single displaced `src` tap (`lumaRatio = dispHdrLuma / centerHdrLuma`). At full Retina `3456×1894` on Apple M5 Max Metal (`games/outbreak/scripts/prove-unseen.ts`), paired GPU pass deltas measure **`+0.070 to +0.389 ms`** for the 5 solo modes and **`+0.275 ms`** (Combo: Shroud + Noise), **`+0.472 ms`** (Combo: Memory + Warp), and **`+0.760 ms`** (Combo: Edge glitch + Shroud) — all within the `< 1.0 ms` budget — while the CPU 512-ray visibility mask + flashlight cone + unseen evaluation measures **`0.050–0.090 ms`** (`< 0.5 ms` budget).
- **Give a top-down flashlight a visible shaft with a separate reduced-resolution march, and hang it on the rig.**
  From Outbreak's steep camera a flashlight that only lights surfaces reads as a pool starting at the feet. The light
  now rides the survivor rig every frame (`Survivor.light`: under the pistol barrel when drawn, following low-ready,
  raised aim, recoil and reload; otherwise the right hand), at hand height, with the barrel's pitch clamped to the
  pool-distance tilt so low-ready still throws the beam ahead (`beamPose` in `games/outbreak/src/flashlight-beam.ts`);
  the polar shadow pass uses the same origin, remote co-op survivors too. Zombies and other survivors are appended to
  the flashlight's occluder range as round casters, so they cut both the pool and the shaft. The shaft is a kit
  `VolumeLightShader` pass after the scene: per pixel of a 1/2- (Medium) or 1/4-resolution target, the view ray is
  clipped analytically to a slightly widened cone, the beam range and the ground, then 8 samples (static per-pixel
  offset) take the beam's angular profile, softened inverse-square falloff, the polar visibility at the sample's own
  height, slow two-octave dust and a mild forward phase; rain, mist and interiors thicken it, and a small glare sits
  on the lens. A kit composite adds it to the resolved HDR target and multiplies the selective-colour alpha, so the
  warm shaft keeps its colour in Noir. Both passes are scissored to a CPU screen rect around the shaft (lens plus cone
  corners out to `min(range, first wall + 1.5 m, 13 m)`, matched by a fade in the shader). Measured with the pass
  amplified ×5 on one page at 3456×1894: `0.06 ms` street / `0.04 ms` interior aimed north, `0.13 / 0.23 ms` aimed
  across the screen; High (14 samples) `0.10 / 0.09 ms`. Lab: Flashlight › Volumetric beam, Dust, Lens glare,
  Volumetric quality (Off/Low/Medium/High). Proof: `NOIR_SCENES=beam bun scripts/noir-proof.ts`,
  `bun scripts/beam-sweep.ts`.
- **Light casters use the real geometry, not what sight or the cutaway sees.** Sight passes windows (you can look
  out), so Outbreak once packed every window into the shared light occluder list as a 0.85 m sill caster: the
  flashlight, its shaft and bounce, room lamps, muzzle flash, co-op flashlights and headlights all went through
  closed windows, and from the steep camera that read as light passing over the cut-away wall. Now
  `packLightOccluders` (`games/outbreak/src/light-occluders.ts`) packs walls, closed doors and closed windows at
  full height and open windows as their sill, rebuilt on topology revisions and whenever a window opens or closes;
  the flashlight's CPU raycasts (bounce point, shaft reach, lens pull-back) use the same full-height set, and the
  bounce fill takes one tap of the flashlight's polar row so it stays on the lens side of the first wall. The
  vehicle renderer also moves the unshadowed lamp it used to overwrite when adding a shadowed headlight. Regression:
  `bun scripts/wall-light-proof.ts` (origin and streamed houses, indoors facing a wall or closed window: under 2
  8-bit levels of mean gain outside; open door or window: +49 to +128, the low end with the volumetric beam off). Cost: the bounce, gate included, measured
  ≤ 0.07 ms in same-page A/B at every quality tier.
- **Adaptive quality must count missed frames and CPU + GPU together, not GPU medians alone (AR-41).** Outbreak keeps
  one frame in flight, so a frame costs its serial CPU plus its GPU time: a 13.5 ms GPU frame plus 3.5 ms of CPU
  misses 60 fps although neither is over budget. `AdaptiveQualityController` (`packages/kit/quality.ts`) used to shed
  pixels only when GPU time passed `0.85×` budget *and* the median frame missed, so a GPU 2–2.5× slower than the
  Studio's (an M2 Max) sat in a dead band: live, at `2448×1340` CSS (2.25× the bench's pixels) with 2× CPU throttle,
  Auto stayed High 2.0× with 15 ms GPU and 12% of frames over 20 ms. It now sheds pixels when ≥ 12% of a window's
  frames miss and the GPU is ≥ half the budget, or when GPU alone passes `0.9×`; slow frames with an idle GPU and
  ≥ 3 main-thread hitches (> 3× budget) a window drop a tier after 3 windows; a step up undone within 6 s doubles
  the next wait; and a tier drop never adds pixels. Same live run: Auto settles at 1.3–1.5× with 6–7% of frames over 20 ms,
  most of them before it adapts. `bun scripts/quality-sim.ts` replays the controller through a frame model (Studio GPU × factor, pixel
  scaling fitted to Outbreak's tiers, 60 Hz ticks). The Lab header (Backquote) now shows `Quality Auto → … · GPU ms ·
  % slow`. Two measurement lessons: `bench-outbreak.ts`'s isolated GPU timestamp probe varies 2.7–9.3 ms run to run
  on the shared Studio (DVFS between probes and other agents' Playwright jobs), so street `5.2 → 6.5` and interior
  `3.4 → 7.9 ms` were noise, not a regression: paired in-page A/B (`ab-gpu.ts`) of the #142 sconces measures
  `+0.02 ms`, and `games/outbreak/scripts/gpu-sustained.ts` (back-to-back frames) gives the same street ~5.4 / interior
  ~6.4 ms serial frame on #124 and main. `games/outbreak/scripts/play-hitches.ts` plays live with held keys through
  streamed lots and reports frame intervals, draw CPU, long tasks, long animation frames and keydown-to-draw.
- **Inline `MaterialRecipe` struct literals per material branch in `surfaceMaterial`, pace frames across Chromium input deferral, and adapt resolution/passes via `@arcade/kit/quality`.**
  Calling `defaultMaterialRecipe(id)` inside `surfaceMaterial` (`packages/kit/gpu/surface-materials.ts`) prevented Tint/Metal from constant-folding the 12-field `MaterialRecipe` across the six material branches, spilling VGPRs across 4× MSAA fragments and costing `39.7–79.2 ms` GPU time at `3456×1894` Retina (`1728×947` CSS at `2×` DPR) on the merged 5×5 interior/rug scene shader. Emitting `defaultRecipeStructWgsl(recipe)` directly in each branch (`packages/kit/gpu/surface-materials.ts`) and early-outing `evalCanopyCookie`/`evalLampAir` (`games/outbreak/src/lighting.ts`) cut `3456×1894` M5 Max Metal whole-frame GPU time by **`14.6×–23.6×`** across all scenarios (`street_noir` `39.650 → 2.718 ms`, `interior` `79.227 → 3.361 ms`, `zombies_100` `55.642 → 2.685 ms`, `streaming_walk` `41.989 → 2.494 ms`) with **zero pixel difference** (`diffPixels = 0, maxDiff = 0` across `6,545,664` pixels at `3456×1894`). Removing the `MessageChannel` / `setTimeout(0)` busy-spin in `scheduleFrame` (`>11,000 → 42` `TimerFire`/s), resuming `AudioContext` before bounded 12-worker `sampleBank.loadAll` with in-place `trimLoopPadding` (`packages/kit/audio/runtime.ts`, `manifest.ts`), making `SampleBank.seedFallbacks()` lazy (`403.2 → 1.5 ms` startup, `74.4 → 0 MB` upfront PCM), caching dev audio/texture buffers with `Cache-Control` + Vite `server.warmup` (`878 → 299 ms` cold dev load, `644 → 228 ms` warm dev load), ordering `staminaEl`/`batteryEl` DOM writes after `hud.update()` (`2.54 → 0 ms` forced layout), priming the fixed-tick phase on idle-to-moving `keydown` edges (`FrameClock.primeIdleMove` in `games/outbreak/shared/clock.ts`), and keeping the `device.queue.onSubmittedWorkDone()` pacer active across held movement (`games/outbreak/src/main.ts`) bring `games/outbreak/scripts/bench-outbreak.ts` (`3456×1894`, 1 warmup + 3 runs vs `3b0d7de`) from `p50 19.55 → 16.70 ms`, `p95 22.00 → 17.10 ms` (MAD `0.00 ms`), `p99 30.70 → 17.20 ms`, `48.2 → 60.37 states/s`, `GPU 18.90 → 5.24 ms`, `keydown→submit 85.0 → 2.60 ms`, and `keydown→GPU complete 116.0 → 13.90 ms` on `street`, and from `p50 20.65 → 16.70 ms`, `p95 22.10 → 17.10 ms` (MAD `0.00 ms`), `p99 17.40 ms`, `59.91 states/s`, `GPU 18.70 → 3.37 ms`, `keydown→submit 66.3 → 1.00 ms`, and `keydown→GPU complete 87.3 → 13.10 ms` on `interior`. Reusing per-frame buffers in `shambleHandsFK`, `zombieProfile`, `ZombieCrowdRenderer`, `OutbreakWeatherController`, `packFoliageActors`, `CoopSim.sightRects`, and `games/outbreak/src/main.ts` cut steady-state `draw(dt)` heap allocations **`6.2×` (`231.4 → 37.1 KB/frame`)**, and `@arcade/kit/quality` (`packages/kit/quality.ts`) adds shared `low` / `balanced` / `high` / `auto` adaptive quality with hysteresis (`high` `3456×1894`: `2.65–3.35 ms`; `balanced` `2592×1421` `1.5×` DPR: `1.54–2.10 ms`; `low` `1728×947` `1.0×` DPR: `0.94–1.43 ms`; `auto` holds `high` at `2.0×` Retina on M5 Max).
- **Every game draws through `GameQuality` (`@arcade/kit/client/quality`): Auto starts at full Retina and steps
  down only when the GPU is the bottleneck.** Brawl, Blackout and Carrier used to cap at `MAX_DPR = 1.5`, Getaway at
  2×. Each game now declares three tiers (`games/<game>/src/quality.ts`: resolution cap plus the passes it scales —
  bloom levels, smoke volumes, Getaway's motion blur) and calls `quality.frame(now)` and `quality.fit(canvas, …)`
  each frame; the mode is a saved per-game setting with a Lab row (View › Quality; Carrier's dev menu VIEW tab;
  Brawl's playground), and `?quality=` pins it for automation. Balanced is exactly what the 1.5× games drew before
  and High is exactly what Getaway drew before: `scripts/prove-pixel-parity.ts` (now with `--dpr` and the `bench`
  and `clock` drivers) shows 0 differing pixels for Getaway High at 1× and 2×, Brawl High at 1× and Balanced at 2×,
  Carrier High at 1×, and Blackout within its own base-vs-base noise (≤ 56 px of 4.1 M). GPU time at 2560×1440 CSS
  on 2× (5120×2880 at High), M5 Max headless Metal (`scripts/bench-quality.ts`, hardware timestamps): High
  11.7–13 ms, Balanced 4.9–6.5 ms, Low 2.7–5.4 ms for Brawl, Blackout and Carrier; Auto holds High there. Getaway
  runs 50–130 ms frames headless at any resolution (main thread idle, same on `main`), so its Auto pick there
  (Balanced 0.9× to Low 0.8×) is not what a real window would choose.
- **Filter procedural detail before divergent branches.** Shared outdoor material hooks compute a world-space
  pixel footprint at the fragment entry, before material branches or cutaway discards. Computing `fwidth` inside
  those branches failed WGSL uniformity validation on Metal. The corrected shaders pass all four Outbreak views.
  New material IDs also need exclusion from the old dust-expansion branch. Outdoor finishes use four-corner value
  noise while legacy Blackout noise is retained. These hooks add no changes to default Blackout WGSL.
- **Test contact against packed geometry.** Outbreak uses the same seeded terrain vertices and triangle diagonal
  in rendering and support queries. Tests intersect actual packed ground triangles at yard, threshold, interior,
  driveway and curb samples. This caught driveway support returning 3.5 cm beneath a 10 cm sidewalk overlay.
  Final look cost on M5 Max at 1000×680: median queue-completed spans 2.5→9.5 ms, 37,014→299,238 static vertices,
  and sampled allocations 565,965→574,627 bytes/step including the proof harness. Pure GPU time is unmeasured.

- **Reserve a polar row for eye sight.** Outbreak M1 uses row zero at 1.65 m, with zero radiance, in the same
  compute pass as its streetlights. Walls/closed doors feed that row; windows/fences remain collision-only.
  The fragment shader combines its nearest hit with a 110° cone and occluded 2.5 m awareness. A CPU polar pass
  marks a persistent 192² exploration mask with the same ray centres and shared slab tests, without GPU readback.
  The mask is uploaded only after newly explored cells appear. Headless Chromium on Apple Metal checked a closed
  room, opening its door, and turning away into an explored shroud, plus live Lab/input handling, without GPU errors.
  `games/outbreak/scripts/prove.ts` reproduces the six views. The mask is 36 KiB; runtime/GPU cost is unmeasured.

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

- **Day-night as a palette over the sunny base.** Carrier (`games/carrier/src/render/daynight.ts`) keys sky, light,
  grade and water on the true sun elevation, with separate evening and morning rows. The day key reads the live base,
  so noon is the old look exactly. The result becomes the weather's base, and a `daylight` factor turns storm greys
  navy at night. Shader terms read one Frame vec4 (night, twilight, lights, moon as key light), all 0 by day. Practical
  lights are additive sprites with a minimum pixel size, so a distant carrier still reads as a cluster of points.
  Throughput at 1536×1024 on the M4 Max: chase view 0.74 ms by day, 0.77 ms at night; jet view 0.60 ms by day,
  0.65 ms at night.
- **Explosions as alpha-to-coverage faceted puffs, real model chunks and one-ribbon trails.** Carrier
  (`games/carrier/src/render/explosion-fx.ts`, `explosions.ts`, `jet-chunks.ts`): fireballs and smoke are jittered
  icospheres drawn opaque with alpha-to-coverage (the clouds' trick), so a thick cloud costs no blended overdraw and
  sorts itself; each facet cools on its own (hashed per facet), so a ball reads as fire and soot mixed. The jet breaks
  into its own GLB triangles, split by centroid into ~13 chunks. Smoke trails are capsule segments whose drift is one
  closed-form function of age, so a segment's tail (as old as the previous head) lands exactly on it: no beads, no
  ladder. Everything is seeded from (player id, sortie): no network messages. Throughput (1536×1024, M4 Max, 7
  alternating pairs of 60 frames): a kill at 70 m plus two more big bursts (77 puffs, 69 pieces, 211 glows, 197 trail
  segments) cost +0.10 ms per frame (0.692 vs 0.592 ms).
- **Per-pass timestamps lie on an idle Apple GPU.** At a light vsync'd load the M4 Max clocks down, so carrier's
  per-pass timestamps read 5–30 ms for a frame that costs 0.9 ms flat out. Measure throughput instead: encode about
  60 frames back to back through the renderer and divide the wall time (`games/carrier/scripts/ocean-shot.ts --bench`).
- **Branch expensive fragment work behind cheap masks once all derivatives are taken.** On the carrier ocean, gating
  foam noise, coral, glitter and shallows on their coverage, and moving cloud shadows to the vertex shader, cut the
  sea's frame from 29 ms to 6–11 ms under the same (clocked-down) timestamp setup; a normals-only shader read 5 ms.
  Flat-out throughput afterwards is 0.87 ms per frame, against 0.48 ms with no sea (1536×1024, MSAA ×4). Throughput
  before the change was not measured.
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
- **Put the analytic lamp air on the actual lens, and anchor actors with a capsule shadow.** Outbreak's sodium pool
  centre sits 6.7 m from the visible cobra-head lens, so the 2026-10-14 experiments integrate the air cone along the
  camera ray from the lens (`STREET_LAMP_POSTS`/`streetLampHead`, six samples clipped to the lamp's height slab, plus a
  closed-form Gaussian lens/halo line integral) and cast a soft capsule shadow from the survivor and two nearest zombies
  away from that lens with 22 cm boot contact AO (`evalLampAir`, `evalActorGroundShadow` in
  `games/outbreak/src/lighting.ts`; Lab Atmosphere group). Against the sodium-70s target (`scripts/look-compare.py`),
  street lamp-head ΔE2000 fell 9.57 → 1.16, lamp air 3.37 → 1.52, actor ground 3.06 → 2.40, global 6.36 → 6.24. Same-frame
  paired GPU cost (`scripts/ab-gpu.ts`, 20 rounds, 3456×1894) is +0.011 ms street / −0.014 ms interior (MADs 0.23/0.11),
  inside noise. Moving the ground pool under the lens worsened the matched road pool (1.81 → 3.53) and was dropped.
- **Soft character shadows from the rig's bones: analytic capsules per light, not a shadow map.** Outbreak's Lab option
  (AR-113, Look · Character shadows, Today default) feeds every drawn survivor, zombie, downed and dead body to
  `@arcade/kit/gpu/shadows/capsule-shadows`: 14 bone capsules per rig, the 4 strongest frame lights per body and a plan
  grid, so only fragments near a body pay. Each fragment gets a contact term in AO and a contact-hardening soft
  visibility per light (`h/t` vs size/distance) through `SceneHooks.lightVisibility`, so the shadow exists only where
  that light lands. Lessons: a body must skip itself entirely (boxy meshes poke out of their capsules, and per-capsule
  skipping left acne), and the flashlight's volumetric shaft still needs the hard polar casters (kind 2 "shaft only"),
  or bodies stop cutting the beam. Paired GPU at 3456×1894 Metal: +0.18 ms horde (60), +0.22 ms street lamp, +0.23 ms
  day (MADs ≤ 0.13); CPU 0.1–0.5 ms. SwiftShader is ~5.6 s a frame either way (noise 2.2 s), so CI smoke stays on Today. Stills: `games/outbreak/scripts/soft-shadows-stills.ts`.
- **Curves for falloffs: a default that is the formula, a table only once reshaped.** Outbreak's flashlight range
  window (`(1 − x⁴)²`, surface pool and volumetric beam alike), practical lamps' pool edge (`(1 − x²)²`) and the unseen
  effect's strength by depth (0.38 → 1) are Lab curves (`games/outbreak/src/light-ramps.ts`). Each default is its
  formula sampled at nine points; while a curve still reads as its default a per-table flag in the lighting uniforms
  stays 0 and the shader runs the formula, otherwise it reads a 16-sample table (three tables and four flags after the
  unseen block; the custom uniform buffer grew to 1280 bytes). Day-night sky fill, moon fill and street air haze take
  curves over darkness the same way on the CPU (`day-night.ts`). `scripts/hour-capture.ts` against main: 1–15 pixels
  per frame differ by 1 level, the same as a scene and its own repeat in one run, so defaults are unchanged. Paired
  GPU cost of all three tables on vs off (`scripts/ab-gpu.ts`, 10 rounds, 3456×1894, Dark shroud on) is +0.002 ms
  street / −0.020 ms interior (MADs 0.06/0.11). The look's `ambientFill` and `fogDensity` change nothing in Outbreak's
  frame even at their maximum, so they got no curves.

- **Spatial 2D light-list grid (`uLampGrid`) and staged `.prop` loading for start houses.** `packages/kit/gpu/lamp-grid.ts`
  precomputes a `192×192` (`0.5 m` cell, `144 KiB` `rgba8uint` at `@binding(17)`) light-list texture on the CPU for static
  lamps (`lights[directLightCount .. lightCount)`), keeping dynamic lights (player and co-op flashlights, muzzle flashes,
  and vehicle headlights/taillights) in the contiguous direct prefix `[firstLight .. directLightCount)`. Each cell stores up
  to 4 1-based light slot indices in ascending slot order, clipped to table-lamp room rects (`cone.w < -2.5`), sconce
  wall/room bounds (`cone.w = 1.25`), and window spotlight half-spaces (`0.5 < cone.w <= 1.125`), with priority-scored
  overflow eviction at the cell center (2× boost for shadow-casting room lamps) and dirty-row uploads gated on spatial/active
  signatures so lamp flicker and stationary frames skip CPU rebuilds and GPU uploads (`0 B` uploaded). In
  `packages/kit/gpu/shaders.ts`, `sampleLampGrid` packs the 4 `u8` slots into a single `u32` scalar before the `lightSum`
  loop so texture coordinates and `vec4u` texels do not stay live across `shadowAt`. Paired in-page GPU measurements on
  `mini` (`scripts/ab-gpu.ts`, 12 alternating rounds at `3456×1894`) show **`-0.230 ms` (MAD `0.056 ms`)** on close street
  night (`6.557 → 6.283 ms`), **`-0.315 ms` (MAD `0.614 ms`)** on wide street night (`7.470 → 7.150 ms`), **`-0.435 ms`
  (MAD `0.015 ms`)** on interior night (`9.404 → 8.975 ms`), and **`-0.617 ms` (MAD `0.034 ms`)** on a 500-zombie street
  horde at night (`9.519 → 8.918 ms`), with `0.0000%` pixel diff (`maxChannelDiff = 0`, `rmse = 0`) on wide street,
  interior, and horde frames (`rmse = 0.161 / 255`, `0.0015%` pixels `> 1/255` on close street). For start-house furniture
  (`games/outbreak/src/props/furnish.ts`, `games/outbreak/src/props/dressing.ts`, `packages/kit/props/models.ts`),
  `usedPropIds(town)` stages the 16 `.prop` meshes used by `furnishedHouses` (anchors first, then clutter: `2,963,900 B`)
  ahead of the 10 unused library props (`1,367,034 B` deferred to idle after the first furnished frame, **`-31.6%` bytes
  before first furnished frame** vs `4,330,934 B` for all 26 `PROP_IDS`), while `PropModels` (`boxFallback: true`) serves
  `propBoxMesh(id)` placeholders while individual `.prop` assets are in flight or if an asset fails.

- **Lamp fog as a half-res volume slot with its own history (AR-105, 2026-10-20).** Aiden's Afterhours fog is now kit
  code (`packages/kit/gpu/fog-scatter.ts`, `volume-pass.ts`). The approach is analytic height fog plus 4 equiangular
  samples per lamp (top 16 per frame), drawn as a volume slot at half resolution. The slot keeps its own history,
  reprojected with the unjittered view-projection, and composites after TAA through a depth-aware upsample, writing
  alpha 0 so Outbreak's shroud still dims it.
  - Two lessons. First, slide interleaved gradient noise by 5.588 px a frame for the per-pixel jitter. Golden-ratio
    offsets converged to IGN's diagonal pattern in the wet streaks. Second, the slot's own history steadies the
    equiangular noise about 3.6× (`scripts/fog-gpu-proof.ts`) before TAA sees it.
  - It costs **+1.39 ms** on Outbreak street night at 3456×1894 on mini (paired `ab-gpu.ts`, MAD 0.006 ms). Seen from Outbreak's
    top-down camera it adds only a faint glow round each lamp (2% of pixels change by more than 6/255), so it stays
    a Lab option (Backquote › Lamp fog) behind the default Today look. It reads in first person, where the view ray
    runs along the cones.

- **Fog bank, fog-depth blur and lit cloud deck over the lamp fog (AR-109, 2026-10-20, Lot).** The fog volume slot
  can now hide what is behind it: `VolumeLightShader.transmittance` composites `scene · a + rgb` (HDR alpha kept), so a
  noise-modulated low bank marched in 6 jittered half-res steps reads as fog descending between the trunks, and the
  slot's history averages the jitter. A fog-weighted blur after the volume (premultiplied by each tap's own fog
  amount, so near trunks don't bleed into the fogged sky) turns far trees, the dish and the building into soft masses.
  A cloud deck lit from below by a 32² CPU-baked lamp-glow map makes the top of frame shadier with a sodium patch over
  the facility. Lessons: the bloom pyramid can't double as the scene blur once `bloomGate` gates it; a 4-tap first
  level costs ~0.35 ms less than 13 taps at 1440p with no visible difference after the quarter level; transparent
  panes that write no depth (the booth) get the bank drawn over them. Cost about **+1.4 ms** together at 2560×1440 on
  a shared mini; CI smoke compiles Today (`fogScatterVolume({ atmosphere: false })`).

- **Bounced light as a one-level cone gather in plan space (AR-115, 2026-10-20).** `@arcade/kit/gpu/gi/plan-bounce`
  computes one bounce of the frame's lights per frame on a 64 m world-anchored grid (emission with polar shadows, a 2×2
  mip chain, 16 cones per texel with wall transmittance), and Outbreak adds it through its `bounce` hook
  (`games/outbreak/src/bounce-light/`, Lab › Bounced light).
  - Three lessons. First, sample it with openness-weighted bilinear filtering (`planBounceAt`). Plain bilinear lets a
    lit hall's texel bleed through a 0.2 m wall into the dark room behind. Second, feed its luminance into the colour
    rule (`outbreakGiIrr`), or bounce adds grey light to a desaturated room instead of colour. Third, the physically
    normalised ×1 is barely visible after Outbreak's grade, so stills are shown at ×3 and ×5.
  - It reads most in the torch-lit hall (the walls and the kitchen beside the beam warm up) and next to fire (the car
    beside the burning dead). The crossroads lamps are too dim at 22:00 for their bounce to show, which is the shroud
    rule working.
  - It costs nothing measurable on Metal: paired `ab-gpu.ts` on `pro` at 3456×1894 gives Δ −0.02 to +0.04 ms at 0.5 m
    and 0.25 m texels, inside the noise. It stays a Lab option behind Today until Kit picks (D-47).

## Art direction

### Outbreak look: one lab, knobs as trims on the day cycle (2026-10-15)

- **Trims, not overrides.** The Day → Dusk → Noir cycle rewrites the grade and the lights whenever the hour changes,
  so Look · Grade and Look · Lights (`games/outbreak/src/look/world.ts`) scale or offset what the cycle produces
  (`trimLook` on the grade handed to the renderer, `trimLighting` inside `packOutbreakLightingUniforms`). A tuned look
  survives the clock moving; every default is the identity, so today's frames are unchanged.
- **Presets set every knob.** `look/presets.ts` holds named, versioned knob sets (`Today · v8`, `Before: Today v7`,
  Deeper noir, Warmer practicals, Vivid world with a grey hero, Big Walk contrast) and each preset's flashlight beam;
  applying one sets all Look knobs,
  so they never leak into each other, and `Today` is Reset. Lab: the `outbreak-look` lab (the start house at 17:30),
  which also holds the beam and unseen variants that used to be their own stations.
- **Outbreak look overhaul (`AR-47`, `Today · v4` default, 2026-10-17).** Removed the source washes that flattened the image into a warm-grey haze: the 51% interior sepia pre-wash (`roomWash` in `buildOutbreakSurfaceWgsl`), the 72% ochre greyscale wash on yard grass (`groundSurfaceHookWgsl`), the 1-px road stipple (`evalAsphaltConcrete`, replaced with smooth weathered macadam, wheel-rut wear, and edge damp darkening under `groundStyle = 1`), the daytime colour hole where `outbreakColorMask` ignored `day.sun` (`F.monitorBounds.w`), and the warm-grey floor in `makeLookSceneShader` / `applyOutbreakUnseenPost`. Upgraded `compositeFast` (`packages/kit/gpu/look-shaders.ts`, `packages/kit/gpu/look.ts`, `packages/kit/gpu/renderer.ts`) with full 4-mode tonemapping (including Sobotka AgX and Lamplight Filmic), a shared 2-tap diagonal clarity unsharp + corner chromatic aberration sample (`sNE`/`sSW`), a high-threshold bloom/halation gate (`smoothstep(0.045, 0.32, bloomPeak)`) so shadows never glow, cool moonlit shadow split-toning (`effShadowTint`) vs warm practical/beam pigment (`effBeamRetain`), and 2-tap triangular IGN dither. `propDressingState.modelStyle = 1` draws `lod0` furniture at default zoom (`46`) with grounded contact AO and low-plastic satin bevel catch. Paired 3456×1894 Metal GPU cost vs `legacy-today` (`captures/outbreak-look-overhaul/meta.json`): ground `+0.084 ms`, lighting saturation split `+0.163 ms`, LOD0 satin models `+0.702 ms`, post-processing stack `+0.063 ms`; total overhaul `+0.438 ms` street day (`6.226 → 6.664 ms`), `+0.428 ms` street night (`6.982 → 7.414 ms`), `+0.433 ms` horde night (`7.149 → 7.579 ms`), and `+1.035 ms` interior night (`11.060 → 12.088 ms`).
- **Survivor styles** (Look · Hero): today's boxes, a matte mannequin, a flat-tone silhouette and a capsule figure,
  same rig and animation (`tests/look.test.ts` checks every part lands where today's does). Co-op teammates draw with
  the local choice, tinted a little toward their seat colour. Stills: `games/outbreak/scripts/look-stills.ts`.
- At the start house at 17:30 most of the frame is lit by the flashlight and the porch, so grade trims read mostly in
  the lamp pools; world saturation needs ×2 or more before the street visibly gains colour under Noir.
- **Darkwood sight shroud (`AR-52`, `Today · v8` default, 2026-10-18).** Darkwood draws its field of view into a
  blurred mask and greys, darkens and grains everything outside it at every hour. Outbreak already had the mask (the
  visibility field); v8 makes it read: a ~5° cone edge and a halo that ends at the awareness radius (`coneSharpness`),
  the Unseen shroud no longer fading by day nor cancelled by sunlight (`dayShroud`), and two post layers in
  `games/outbreak/src/unseen/shader.ts` — cold-slate charcoal and coarse crawling grit — whose weights ride the free
  `GL.pad.x` slot (`FrameInput.postExtra`). The shroud must not count `explored` outdoors, or remembered blocks show as
  lighter rectangles. Pixel stats at 14:00: meanS 0.234 → 0.089, darkMeanS 0.285 → 0.089; 21:00 street darkMeanS
  0.084 → 0.033 with lit saturation unchanged (0.60). Paired GPU vs v7 (3456×1894, 6 rounds) sits inside the noise
  (−1.7 to +0.8 ms, MAD 1.6–4.4 ms). Stills: `games/outbreak/scripts/look-beauty.ts`. The finished contract is
  [outbreak-art-direction.md](outbreak-art-direction.md).
- **Darkwood finish (`AR-53`, 2026-10-18).** A wide flat-topped beam (inner cone 0.8, near-lens softening 6 m, pool
  2.4 m out, thin volumetric 0.35) lights the ground's texture instead of glowing in the air, and costs 0.7–1.1 ms
  less than v7's dense volumetric at 3456×1894. Outdoor practical pools are gated by the lamps being on, so daylight
  shows no warm wash. A post pass neutralises cool darks outside light (the grade's night split-tone was ringing the
  sight edge blue). A dim albedo-grey lift inside sight at night (`sightGlow`) makes the cone and its wedges read
  behind the survivor. Painterly ground (`paintedGround` in `src/ground.ts`) uses 0.4–3 m world-space stains, scuffs
  and drifts with footprint-widened edges and adds no measurable walking flicker (< 0.0001 hpRms).

### Vegetation looks: tree, bush, grass

- **Three looks, tuned separately** (`packages/kit/gpu/foliage.ts`, Lab Vegetation section `packages/kit/lab/foliage.ts`).
  Trees (Oak, Maple, Pine, Birch), bushes (Clipped hedge, Overgrown shrub, Hydrangea) and grass (Lawn, Overgrown lawn,
  Weeds / dead grass) each have their own presets, typed parameters and seeded Randomize; one look never changes
  another. Outbreak defaults stay Oak + Overgrown shrub + Overgrown lawn, which match the previously shipped values.
- **Opaque leaf mounds under scalloped rosettes beat flat leaf cards from the top-down camera.** Main's 5-sided
  cards rendered as visible pentagon plates (no `discard` in `fsSolid`), and without a mass under them the crowns
  read as dark speckle at 23:00. Each bough cluster and bush lobe is now a jittered ellipsoid mound (~45–54 verts)
  with 2–3 scalloped rosettes and an edge sprig on its outer shell, plus a cool moonlit sheen on upward leaves at
  night. In the aligned `look-proof.ts` yard frame the woodland crowns read as rounded masses (crops in
  `~/code/home/artifacts/2026-10-14-vegetation/sheets/yard-crops.png`, against the gpt-image-1.5 paint-over target).
- **Bushes encode `aux = 3 + flex`.** Shaders decode it with `foliageTipWeight`/`foliageTranslucency`, so bushes get
  their own wind, translucency and actor bending without a new vertex attribute. `bushTrim` clips the emitted
  vertices toward a rounded box (flat top, straight sides, bent normals) to turn a wild shrub into a hedge.
- **Actor bending**: the player and the seven nearest living zombies are packed into `OL.vegActors` each frame
  (`nearestFoliageActors`, `packFoliageActors`); grass and bush leaves bend away with a `(1 - d/R)²` falloff. The
  Lab's `grass-bend-off`/`grass-bend-on` captures (same tick, strength 0 vs 1) differ in 8,205 pixels around the
  walkers. Flashlight transmission lights leaves and blades inside the beam whatever their facing.
- **Contact shade** under every `plant()` call (house trees and foundation shrubs, not only `town.props` trees) is
  stamped locally into the floor map, and bush skirts darken over their lowest 30 cm.
- **Cost** (Mac Studio, Metal, headless; alternating `bench-outbreak.ts` runs vs `origin/main` 5458b60,
  `perf/outbreak-vegetation-paired.json`): static vertices 294k → 321k; GPU street 17.09 → 17.69 ms (three runs each,
  ranges 17.04–17.22 vs 17.66–17.71), interior 17.44 → 18.09 ms; realtime ratio ≥ 0.995 throughout. Fresh-submit p95
  street 19.9 → 20.9 ms (main itself measured 19.1–21.2 here), interior 19.8 → 20.3–21.2 ms. Disabling actor bending
  and the beam/sheen terms did not recover the interior cost (18.28 ms), so it is the fuller canopy coverage and
  vertices. Grass density is cheap: GPU street 17.65 / 17.69 / 17.75 ms at density 0.5 / 1.0 / 1.5.

- **Lively vegetation and one town-wide gust field (AR-66)** (`packages/kit/gpu/foliage.ts` `FoliageBuildOptions`,
  `applyFoliageWindField`; `games/outbreak/src/vegetation/`; Lab › Vegetation, station `outbreak-vegetation`). The old
  wind moved canopies ~3 cm (under a pixel at zoom 38) and limbs not at all, so the town read as still. Now one
  band-limited value-noise gust field (fronts `vegGustScale` m long, travelling downwind at `vegGustSpeed`) reads only
  sim time and world position (co-op clients match) and drives three layers: bough lean and sway (canopy and limbs
  together: limb vertices carry aux = 8 + flex, the trunk barely leans), leaf flutter that rocks the normal and fades
  26–52 m from the camera's ground point (no glitter), and shrubs and blades laid over as fronts pass. Crowns part
  around the survivor (vertex push, no discard, so canopies stay in `fsSolid`). Lively trees pick oak/maple/birch/pine
  by seed, ~14% stand bare, mounds are rounder (four rings) and shaded lit-outward/dark toward the trunk, the flashlight
  reaches the lower crown, and shrubs grow stray shoots. Today (`vegLook` 0) is the old meshes vertex for vertex and the
  old wobble. Origin static vertices 351k → 403k (Medium detail); paired GPU at 3456×1894 on Pro (M-series, Metal, 10 pairs):
  +0.29 ms yard night, +0.23 ms yard day, both inside the MAD (1.1 / 2.2 ms; this worker's clocks swing).
  Stills and clips: `bun scripts/vegetation-stills.ts --clip --gpu` (via `hivemind run --kind browser`).

- **Tree looks A–C for D-41 (AR-74)** (`packages/kit/gpu/foliage-looks.ts`; `games/outbreak/src/vegetation/trees.ts`;
  Lab › Vegetation › Tree look, station `outbreak-vegetation`; C is the default since D-42, Today one setting away). A Deadwood: limbs as two curved
  segments with a lateral kink between them (tangent-continuous, so they twist instead of zig-zagging), kink growing
  with limb level (trunks 0.2×), broken stubs, near-black bark, sparse dark clumps or bare. B Fluffy: overlapping
  clusters of 0.3 m six-point leaf cards on ellipsoid shells over dark inner mounds, with shading normals pushed 88%
  out from the crown centre (the Tiny Glade / Bruno trick), so a crown lights as one soft volume. C: A's structure with
  B's clusters on limb ends and gaps between. Cards are opaque geometry: alpha-to-coverage is not in Outbreak's level
  pipelines and would cost HSR on every tree chunk. Learned: (1) a ground-level torch never lights the crown tops a
  38 m camera sees, and trees cut sight wedges, so crowns in the beam rendered as flat shroud-grey slabs; a plan-cone
  "torch through the crown" term (`outbreakTreeBeam`) that also marks the crown as seen for the fog of war fixes it;
  (2) seeding `Rng` with nearby seeds gives correlated first draws (seed 300000 → 0.997, 0.001), so looks hash the seed
  first (`lookRng`); (3) Outbreak's street lamps were nearly dead at night (power ~0.03, radius ~4.5 m; fixed below).
  (4) The beam's lent colour went moon-grey: the scene's colour rule desaturates whatever `litMask` misses, and the
  through-crown term wasn't in it (C crowns in the beam measured saturation 0.06 against 0.34 on the lit lawn). The
  crown's beam mask now joins the colour rule (`outbreakTreeColourLit`, scaled by "Tree colour in light", default 1.25).
  Blight (D-42): `treeBlight(seed, share)` from its own hash, so the share never reshuffles healthy trees; blighted C
  trees take Deadwood's skeleton, darker bark and fewer, withered clumps, and at blight ≥ 0.7 no leaf cards (Lab
  "Blighted trees", default 25%). Tree vertices for the 36 origin trees: Lively 96.5k, A 78k, B 95k, C 130k. Paired GPU at 3456×1894 on Pro
  (5 pairs, vs Lively): A +0.53 / +0.39 ms (street night / yard day, MAD ≤ 0.06), B −0.02 / −0.04 (noise), C +0.50 /
  +0.47 (MAD ≤ 0.05); A and C's cost is the per-fragment tree shade and beam terms. Stills, clips, GPU:
  `bun scripts/tree-looks-stills.ts --clip --gpu`.
- **Trees stay out of houses** (`games/outbreak/src/vegetation/indoors.ts`, `tests/trees-indoors.test.ts`; Kit: "Why
  are there trees inside the house?"). Outbreak's level pass is `fsSolid` with no cutaway discards, so any crown left in
  the opaque chunks hung over cut-away rooms: Ash's east street tree (trunk 0.52 m off the kitchen wall) had 749
  canopy vertices over the kitchen, and Darkwood crowns droop to 1.8 m up to 1.8× their radius from the trunk, so lower
  boughs and corner shrubs also stood inside rooms. Now leaves and limbs below the wall tops inside a footprint are
  dropped, and a crown over a roof goes in a per-house chunk with `customCutaway: "outside"` and the walls' cutBox, so
  it vanishes with the roof when you step in and overhangs as before outside. Stems keep 0.5 m (trees) / 0.2 m (shrubs)
  off walls and porches. Streamed chunk compile 2.60 → 2.9–3.1 ms (264 chunks, Studio).
- **Street lamps at night** (`games/outbreak/src/day-night.ts`, `lighting.ts`). The night lighting curve took Noir's
  `streetPower` 0.12 (Oct 14), so street lamps faded 8× as night fell to power 0.03, a tenth of a porch light, and fell
  under the 0.2 gate of the shader's per-house sodium ground pool. Night now keeps dusk's 0.96 (power 0.27). That
  sodium pool sits at a fixed spot by every house, not under a real lamp, so Darkwood (`OL.sight.y`) turns it off and
  the real street lamps light the ground. `tests/day-night.test.ts` keeps night lamps at least dusk's power.

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

- **Swap presentation while retaining the rig and map.** Blackout's opt-in Wizards lab study registers a second set
  of meshes against the existing bones, uses a matte team-tinted cloth material, and rebuilds static geometry only
  when the switch changes. `src/render/castle.ts` retains collision footprints and light IDs while replacing office
  furniture and fittings; the existing lamp-power buffer drives smooth torch flicker. `scripts/prove-wizards.ts`
  captured walking, aiming, casting, ragdoll, the furniture fixture and sandbox on Apple's Metal adapter with no
  browser errors, including a live off/on toggle. Two tests check source-map preservation and finite model normals.
  CPU/GPU cost has not been measured. Viewer links and weapon mappings are in `games/blackout/docs/wizards.md`.

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

### Outbreak driving FX: per-wheel slip and multiplied skid decals (2026-10-15)

Outbreak's cars already ran the shared `VehicleEmissions`, but through Getaway's drift proxy: slip came from the
centre-of-mass sideways speed and the controls, its grounded test read Outbreak's absolute terrain height, ordinary
braking never marked, and the sprite skids (RGB 0.02, 9 s) vanished on dark Noir asphalt. Kit saw no marks or smoke.

- Slip is now per wheel from the replicated body (`kinematicContacts`): tyre velocity v + ω × r across its rolling
  direction, fronts on the no-slip path, rear lock on the handbrake, all four locked by a hard stop above 7 m/s, and
  burnouts. Defaults (slide 3 m/s before marking, full at +5 m/s) leave ordinary corners clean; a full-lock turn at
  speed, a handbrake turn, a hard stop and a burnout all mark. Co-op clients derive the same marks from the same
  replicated state.
- Marks are decals that multiply the lit ground (`fx/skids.ts`). In Noir that is the right look for free: visible in
  headlights, the flashlight and lamps, invisible in the dark, no lighting code, and the Look's alpha mask is kept.
  They last 180 s (30 s fade) in a 4,096-segment ring, so a session's drifts stay on the streets in the streaming window.
- Tyre smoke's unlit colour follows the sky ambient (`F.ambient × 2.6 + 0.035`): the old fixed grey glowed in the dark.
  Lower values (0.9×) made the smoke disappear at night; this one reads as grey haze that lights up in the beams.
- Measured (`games/outbreak/scripts/prove-driving-fx.ts`, headless Metal 1280×800): the station drift lays ~180
  segments and peaks at ~110 smoke samples; a hard stop from 14 m/s lays ~90; 4,096 segments on screen cost
  +0.05–0.08 ms GPU (paired). Screech follows slip frame by frame (`after.json` → `stationDrift.screech`).

### Outbreak fire on the kit explosion look, world smoke and soft beam dust (AR-68, 2026-10-19)

Outbreak's analytic flame sprites blew out to white on lit zombies and its dynamite was a flat white disk. Fire now
emits the kit explosion's particles into one kit pool (`games/outbreak/src/scene/fx-particles.ts`), drawn through the
kit renderer's `fxParticles` path; Today is one Lab setting away (Fire style, World smoke, Beam dust = 0).

- Fire: rolling `fireball` billows with soot `smoke` and embers for the stream, burning figures and ground fire;
  dynamite is `spawnExplosion` with the "barrel" preset sized to the blast radius, molotovs the "pop". The fire lights
  (warm, flickering, through the existing light path) are unchanged, so nothing blows out.
- Smoke is a new kit kind (`smoke`, 8): the fireball's noise shape without heat, settling onto `windX`/`windZ`. It is
  lit only by ambient and real lights. The flashlight is passed as a plan-cone spot (`spotCones`), so smoke catches the
  beam and nothing outside it. Point lamps need ×2 and the beam ×5 the scene power to read the same in the air (the
  scene shades with softer falloff curves). At 0.8× sky ambient, unlit smoke read as a grey ghost over the black
  unseen area; 0.4× keeps it dark until lit.
- Fire under the Noir colour mask needs `keepColour` (low destination alpha), or the mask greys it.
- World smoke sources (manholes, drains, cars, wrecks, chimneys) are a pure function of the town and seed; the
  nearest 14 within 30 m emit. Soft beam dust is `air/dust.ts` style 1.
- Measured (`games/outbreak/scripts/fire-smoke-proof.ts`, headless Metal 1280×720, paired Today→kit on one frozen
  frame, quiet worker): flamethrower on eight +0.76 ms, molotov +0.57, burning +0.13, dynamite blast +0.02, steam
  within noise; 300–460 live particles of 2,048, none dropped. On a loaded worker the pairs swing by ±3 ms, so compare
  only runs taken back to back.

### Outbreak fire second pass: capsule fire light, burning trees, backlit dust (AR-62/AR-68, 2026-10-20)

- **Capsule lights** (`LIGHT_CAPSULE`, `cone.w` −1.75 in `packages/kit/limits.ts`): `lightSum` lights from the nearest
  point of the segment `pos ± cone.xyz`; `pos.w` is the reach from the centre (radius plus plan half-length), so the
  plan reject and the lamp grid need no change. A burning tree as one tall capsule lights the yard and walk evenly
  where a point at crown height left a hot pool under the trunk. It sits in the porch-light range, so hosts that keep
  porch lights out of rooms treat capsules the same.
- **Trees burn as a shared rule** (`tree:<k>` ring) and draw through the existing vegetation burn hook; shrubs char from
  negative-radius entries in the same eight `vegBurn` slots. The fold-away briefly shows stretched leaf cards
  mid-transition; fence hedges are lit boxes and don't char.
- **White flame puffs:** hot inner tongues at blackbody heat ≥1.5 and crown billows at ~1 read as white dots at
  gameplay zoom; tongues at 1.12–1.24 and crown billows at 0.78–0.95 stay yellow and orange.
- **Karis-weighted first bloom downsample** (`bloomKaris`): weight each 4-tap group by 1/(1+luma) so lone embers can't
  flash bloom tiles; broad bright areas bloom the same.
- **Backlit dust** (`air/dust.ts` style 2): 0.42 m lattice at 5 %, 6 mm gaussian points drawn ≥1.7 px, curl-noise drift
  about each home cell, HG forward scatter, a seconds-long turn twinkle. At 3 % and 5 mm only ~10 motes showed in a
  whole beam; 5 % and brightness 2.6 gives ~20, subtle against the lit floor.
- Measured (`fire-smoke-proof.ts --mode second`, headless Metal 1280×720): dust backlit vs AR-68 soft +0.12 ms;
  tree capsules vs points +0.66 ms on `mini` and +4.9 ms on a busy Studio, so not yet trustworthy: re-pair on a quiet
  worker before relying on it.

### Lot forest masses and ground dressing (AR-111, 2026-10-20)

- Kit on the Lot vs Ashwood: "his trees are thicker and kind of connect, make a better silhouette" and "he has some stuff on the ground and we don't". Both traced to the first conversion dropping Ashwood's card shading: its `flex` attribute (limb and stem depth) darkens crowns toward the trunk by `0.45 + 0.55·inner`, and its normals blend 45 % of each card's face normal into the crown normal. Without them crowns lit flat and gappy, and the undergrowth clumps by the booth read as pale squares under the fog skylight. Restored in `cardShadingHooks` (`packages/kit/gpu/forest.ts`); the bake keeps `flex` in vertex aux.
- `ForestPass` replaced the static tree bake (every tree frozen at its title-camera LOD): Ashwood's own variant models drawn instanced, nearest-first lists rebuilt per 2 m, per-frame-shifted complementary Bayer cross-fades (Tidewater, MIT), and far thinning to fewer, larger crowns (50 % gone by 320 m, survivors ×1.41·1.15). Shipped geometry 33 → 7.7 MiB, solid triangles 1.33 M → 0.44 M; whole-frame GPU at the title camera within noise of main (two paired runs on Studio Metal 1920×1080: main 4.51/4.44 ms, new 4.44/4.17 ms median, n=48 each).
- Ground dressing is `sim/debris` rules (Tidewater-style feature anchors + padded SDF keep-outs) with Ashwood's plant templates, procedural leaves/pebbles/paper and a CC0 can. Lane capsules matter: the gate apron's edge crosses the road, and without them weeds grew in the lamp pool.
- Stills: `~/code/home/artifacts/lot-2026-10-20/forest-crops.jpg`, `forest-aiden-before-after.jpg`, `forest-far-masses.jpg`.

## Researched, not yet adopted

### Blackout snapshot rate (2026-10-16)

Tried with `scripts/bench-netcode.ts` and `games/blackout/scripts/bench-remote.ts` (2 seeds): snapshots every tick
(30 Hz instead of 15) took the Wi-Fi remote delay from 242 to 208 ms p50 but doubled bandwidth (7.3 → 14.6 KB/s) and
made remote soldiers rougher (velocity jumps 165 → 290 per minute clean: the curve follows tick-level motion more
closely), and starvation rose 2.9 → 5.2%. Kept 15 Hz; adaptive interpolation delay shipped once `SnapshotBuffer.renderTime`
was time-stretched (see Multiplayer).

### Outbreak survey §5 experiments rejected on measurement (2026-10-14)

Evidence and patches: `~/code/home/artifacts/2026-10-14-visual-experiments/progress.md`.

- **Window interior parallax** (virtual room, drapes, valance behind the glass): after Release 5's lamp-box and drape
  geometry behind 22 % glass, five tunings all moved the window regions away from the target (best: street 6.75 → 8.50,
  open 4.56 → 6.12) and read paler. The existing geometry already supplies the warm depth.
- **Light-list grid / static polar rows**: skipping the entire polar dispatch changed GPU time by under 0.15 ms, so
  row caching cannot pay. A pixel-exact 16×10 view bitmask grid (0 scene pixels changed) had no clear win with only 6/3
  lights in the benchmark frames; 11 rejected dummy lights cost +2.2–2.5 ms, so revisit if light counts grow.
- **Directional actor bounce and wet asphalt lamp sheen**: actor pixels moved under 2/255. The 6.2 m lens's mirror point
  for this camera lands on the far sidewalk under the tree canopy, so a physically placed sheen never reaches the road.
  Weather (`@arcade/kit/weather` and `games/outbreak/src/lighting.ts`) now owns wet surfaces, shaping wet-asphalt and
  puddle sheen as camera-stretched streaks on the road/walk pools (`sPos`) driven by `wetness` and `puddleCoverage`
  (`OL.u8.yz`) instead of the geometric mirror point.
- **Foliage contact bend and Karis bloom average**: the bend darkened the shrub mass instead of reading as parting.
  With `bloom = 0.068` and a 0.9 threshold, the Karis average changed the frame by at most 3/255 and frame-to-frame
  shimmer not at all.

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

## Crowds

- **Share one flow field per goal once a crowd is big.** Outbreak's zombies each ran their own capped A*
  (`MAX_REPATHS_PER_TICK = 4`), so at 500–1,000 most hunters waited for a repath and 3.3–3.5% stood still each
  second. `packages/kit/sim/flow-field.ts` builds an integer cost field per goal quantum (Dial's bucket queue,
  10/14 per step, door/window/barricade penalties, 112-cell window, ~0.43 ms per build) and every agent heading
  there steers to the farthest downhill cell it can walk straight to. Fields are keyed by the nav grid's revision
  and a per-tick goal budget counts goals asked for, cached or not, so a restored sim replays bit for bit. Survivors
  get an anchor that only moves after 1.5 m, plus a short trail of old anchors where last-known positions cluster.
  Stuck share fell to 0.6–0.8%; at 400 zombies a crowd crossing the hardware store reached the far side in 45 s
  instead of 90 s, and a door funnel had 0 wall crossings instead of 24. Below 64 zombies the game still uses A*
  and is bit-identical to before, so the survivor-bot curves don't move. Bench: `scripts/horde-bench.ts`.
- **Steer through a doorway's clear span, not its nav cells (AR-65).** Door nav cells are carved to within 0.12 m
  of a jamb, so straight lines and string-pulled paths crossed a 1.4 m door at an angle and the body (r 0.28) caught
  the jamb; the corner slide then took the tangent away from the door on a tie and the zombie rocked there for good.
  `funnelThroughDoor` in `packages/kit/sim/ai.ts` runs after a hunter picks its steering point: if the straight line
  leaves the opening-less-a-radius-each-side while within a radius of the wall, it aims at that span's near mouth,
  then straight across to the far one. The corner slide now picks the side that closes on the steering point. In
  `games/outbreak/scripts/door-stuck.ts` (422 scenarios: every start-block and generated door, open and shut, both
  sides, crowds of 1–6, Brute, Runner) wedged time fell from 553 s to 1.8 s and zombies not through in 20 s from 43
  of 1,418 to 0. Survivor bots die a little more (Skilled alive at dawn 3: 0.5 → 0.25); houses were partly a fortress
  because the dead jammed in their doors. Test: `games/outbreak/tests/door-stuck.test.ts`.
- **A horde off screen is a point, not 800 agents.** `games/outbreak/shared/hordes/` keeps an abstract horde as a
  position, a goal and a head count in JSON feature state. It hears loud noises from radius × 2.5 (× the AI hearing
  scale), through walls, because a building attenuates sound so much that a horde behind one would never react.
  It materializes 64 members a tick once its centre is 8 m inside the active window and within 46 m of a survivor,
  and folds back once every member is 64 m from every survivor and none is fighting. The 18 m gap and an 8 s
  cool-down stop flicker at window edges. Members carry `hordeId`, take ids from 60416–65535 (above every chunk's
  range, inside the wire's u16), and are skipped by chunk deltas, chunk unloads, the director's chaser cap and its
  near-15 m hold.
- **Walk far goals in legs.** A field only covers 56 m around its goal, so an 800-strong horde sent 75 m down the
  street fell back to per-agent A* and crawled. Sending members to a point 30 m along the way (never indoors, or
  the horde files through a front door to cut a corner) and moving it on as they catch up keeps every member on a
  shared field: the horde walked 60 m in 48 s at a steady 1.25 m/s with 4 field builds.
- **A gunshot alone lures a crowd for about 4 s.** Zombie awareness decays, so a shot turns heads but only carries
  them a few metres. Horde directives re-send idle members toward the horde's goal every 0.5 s until half of them
  are there.
- **Measured (fleet Mac mini, Metal):** one live roaming horde closing on a walking survivor costs a sim tick of
  0.51 / 1.61 ms (p50 / p95) at 500 and 0.86 / 2.27 ms at 1,000, and replays bit for bit from a mid-run snapshot.
  Rendered at 1728×947 @2× (high tier): GPU 5.09 ms empty, 5.23 ms with 500, 6.98 ms with 1,000. In co-op with four
  players and a live horde, each player receives 24 KB/s at 500 and 41 KB/s at 1,000 (4 KB/s without a horde);
  the room tick is 2.3 / 3.3 ms (p50 / p95) at 500. Proof: `scripts/horde-proof.ts`, `scripts/coop-bench.ts --horde=`.
- **To watch a horde, move the view with the camera.** Fog of war and actor visibility follow the survivor, so a
  camera on a horde 40 m away showed ghosts. The Lab's "Camera follows horde" also moves vision to the horde's centre
  (360°, 40 m).

## Multiplayer

- **Replicate persistent hazards and the spectator's target.** Outbreak clients inferred Bloater gas from observed
  deaths, so late joiners missed damaging clouds. `shared/specials/net.ts` now sends active, interest-filtered hazards:
  one small-id cloud costs 20 payload bytes and unchanged deltas cost zero. Body rise counters need their own section
  because slot-store inventory serialization omits counters. Four-client room tests also caught the spectator camera
  following a distant teammate while snapshots covered the corpse; one replicated seat now selects both camera and
  interest. Proof: `games/outbreak/tests/coop-{specials,death}-parity.test.ts` and `coop-feature-bandwidth.test.ts`;
  [outbreak-coop.md](outbreak-coop.md) records coverage and remaining limits.
- **Pair snapshot benchmarks on the same source.** `scripts/bench-multiplayer.ts --paired` alternates shared and
  per-recipient preparation order, runs one warmup plus nine measured pairs of 1,000 ticks, and checks serialized
  byte counts and SHA-256 outside the timed interval. Both games produced identical output across all 20 runs.
  On the shared Studio, Getaway's control/shared medians were 169.152 / 121.137 ms; Blackout's were
  45.038 / 60.736 ms with a 189.070 ms shared-run outlier. Preserve those samples: this noisy confirmation does
  not establish a new Blackout speedup. Raw evidence: `perf/*-multiplayer-final-paired.json`.
- **Build the shared part of each tick's snapshot once.** Rooms used to build and serialise a full view per connected
  player. Building shared entities once and adding per-player fields cut 1,000 ticks from 66 → 45 ms (Getaway, 8
  players) and 43.5 → 32.8 ms (Blackout, 10 players). Benchmark: `scripts/bench-multiplayer.ts`.
- **Rollback over an input relay for a deterministic 60 Hz platformer.** Archers' room is the input authority, not the
  world authority: each tick it takes every person's buttons from `InputRelay` (a late input applies on the next
  tick, a missing one holds the last), runs the shared `World` and broadcasts only that frame (about 45 bytes); each
  client steps its own copy with confirmed frames and draws a prediction re-simulated to its head with its own
  buttons as typed and others' held (`@arcade/kit/net/rollback`, `games/archers/shared/match.ts`). A world hash every
  30 ticks catches desyncs; the room sends the whole state only on join, reconnect or mismatch. One step with four
  bots costs 6.4 µs and a clone 10 µs, so re-simulating 20 ticks a frame is free. The `TickPacer` estimates the room's
  tick from the fastest frame of the last half second and learns its lead from the room's measurement of each input's
  arrival, as a running quantile (10% may land less than a tick early), not the worst case: over TCP one lost segment
  holds 200 ms of inputs, and chasing those kept the lead 12–17 ticks instead of 4–5. Learn once per arrival: the first
  version re-applied a 2-second quantile on every frame the room sent, a stale integral that overshot and left
  clients running at 0.6x. Measured with the real room core over `link-sim` (`ONLINE_BENCH=1 bun test
  games/archers/tests/online.test.ts -t bench`, 2 people + 2 bots, 60 s): on Wi-Fi the head runs 4 ticks ahead, 4.1%
  of input changes land late, other people are drawn within 0.25 tile of where the room puts them on 80% of frames
  (median error 0), against 33% for drawing the room's world one round trip plus 100 ms ago (median 0.83 tile); zero hash mismatches on good, Wi-Fi and bad links. Two headless tabs on
  real Durable Objects behind an 80 ms proxy: zero desyncs (`games/archers/scripts/online-proof.ts`). Corrections
  are eased out of the drawn position over about 70 ms, and an event re-simulated within 4 ticks shows once.
- **Determinism across engines:** only + − × ÷, `Math.sqrt`, `Math.floor`/`round`/`min`/`max`/`abs` and integer
  `Math.imul` are bit-identical everywhere. `Math.hypot`, trig, `exp`, `log` and `pow` are not specified to the last
  bit; Archers had one `Math.hypot` in bot goal choice, replaced with `sqrt` before going online.
- **Keep the simulation in `shared/` deterministic** and free of DOM and Worker APIs, so the server, solo mode,
  prediction and benchmarks all run the same code.
- **Version handshake.** Hash `shared/` at build time and send it in `hello`; a server with another hash asks the client
  to reload into the same room (Blackout `scripts/build-id.ts`).
- **Persist lobby room reports** in Durable Object storage so a restarted lobby knows every live room at once instead of
  waiting for heartbeats (Blackout `server/lobby.ts`).
- **Slow vehicles: server sim plus soft-reconciled prediction, no input replay.** Carrier's room runs every ship on the
  shared fixed-step sim; the helm's client predicts its own ship and eases it onto the room's pose (dead-reckoned to its
  own time, 1.5 s lag, snap past 60 m). With orders arriving one trip late, the predicted and room ships stayed 0.6 m
  apart after 6 s of throttle and rudder on hailmary (`games/carrier/src/game/game.ts`, `scripts/mp-shot.ts`).
- **Vehicle-vs-vehicle contact: lockstep steps, convex SAT, anisotropic impulses.** Carrier's room steps every ship
  one fixed tick at a time and resolves each touching pair after it (deck-plan polygons, separating-axis contact with
  two clipped points, sequential impulses with sway/yaw added mass, restitution only above 1 m/s, 25%-per-step overlap
  push). Pick the incident edge among the edges at the deepest vertices, not the most opposed edge of the whole
  polygon: with many near-parallel hull edges the latter clipped to nothing and let hulls sink 2.8 m into each other.
  Resting under full power holds the gap within 1 cm; top-speed crossings from 11 headings × 5 offsets stay under 2 m
  overlap; the helm's client resolves only its own hull against drawn remotes so it stops where the room's does
  (`games/carrier/shared/ship-collide.ts`, `tests/ship-collide*.test.ts`, `scripts/collide-shot.ts`).
- **Hybrid combat authority for fast jets.** Carrier lets each shooter decide its own cannon hits, against the jets
  as it draws them, 120 ms behind. The room only checks they are plausible: alive enemies, a round budget refilled at
  the gun's rate, and range between the relayed jets. Missiles, bombs and flares are events (pose, velocity, target,
  sea time). The room flies them in a shared deterministic `CombatWorld` against the latest relayed jets,
  dead-reckoned, and decides detonation and damage. Clients run the same world without authority to draw them, and
  snap to the room's burst. On hailmary, two pages in one room produced: a gun kill, a missile flared by the target,
  a missile hit, a kill feed and K/D tallies on both pages (`games/carrier/shared/combat.ts`, `server/core.ts`,
  `scripts/weapons-shot.ts --only=mp`). Bandwidth and room CPU are unmeasured.
- **Keep a room ticking until its last socket closes, not its last player.** Carrier's Room stopped its interval when
  the core had no joined players; over a slow link (tunnels, a reverse SSH forward) the first tick came before the first
  `hello`, so a new room froze until another socket arrived (~20 s of stuck ships and bots on hailmary). Counting open
  sockets in `games/carrier/server/room.ts` fixed it; `scripts/bots-shot.ts` then passed every step.
- **Run dev bots in the room as socketless players.** Carrier's bots (`games/carrier/server/bots.ts`) join a carrier
  and run its operations under the crew rules, fly the shared models and hand their output to the room's own message
  handler, so damage, budgets and relays are a player's. The duel, a bomber hitting a carrier and attack boats were
  checked on hailmary in a dev room; `tests/bots.test.ts` checks a production-mode room refuses dev messages.
- **Capture DOM UI over WebGPU** by reading the frame back through the game's device, laying it under the page as an
  `<img>` (canvas hidden) and taking a page screenshot (`games/carrier/scripts/mp-shot.ts`).

- **Carry one-shot edges through the input jitter buffer.** Outbreak co-op (`@arcade/kit/net/jitter-buffer.ts`, Wings's
  playout schedule generalised) never drops a press: an input that arrives after its dry-tick stand-in, or is cut by the
  queue cap, gives fire/interact/reload to the next applied input; catch-up returns two inputs that the room applies as two
  movement steps, so client prediction still matches. Over a 3 + 0–8 tick jittery loopback, all five shots landed and the
  predicted survivor converged within 1 cm (`games/outbreak/tests/coop.test.ts`).
  `@arcade/kit/net/room-core` (Blackout, Brawl) runs the same buffer per seat but hands its World one merged intent
  when catching up (the later movement, both presses), so a catch-up tick costs the client a one-tick correction that
  its smoother hides; two presses consumed in the same tick merge into one. Its rooms tick at 30 Hz over a WebSocket,
  where a lost TCP segment stalls everything behind it for a retransmit and then arrives as a burst, so it uses
  `ROOM_JITTER` (at most 2 ticks deep, up to 8 stand-ins, drain bursts at once): growing the buffer after every stall,
  as `DEFAULT_JITTER` does for Outbreak's 60 Hz stream, pinned it at 6 ticks. One intent per 30 Hz tick over
  80 ± 30 ms with 2% loss (200 ms retransmit), presses every 1–2 s for 120 s × 3 seeds: the old
  `queue.splice(0, length - 3)` trim lost 4/235 presses and sat at 300 ms press latency (its queue never drained below
  the trim depth); `DEFAULT_JITTER` lost 0 at 300–333 ms; `ROOM_JITTER` lost 0 at 133 ms p50 (Brawl p95 233 ms,
  Blackout 133 ms). Clean 20 ms: 0 lost and unchanged latency in all three (`scripts/bench-input-drops.ts`,
  `perf/input-drops-{before,after}.json`).
  Superseded by `socketJitter` (next).
- **Size a WebSocket input buffer from how late inputs arrive, not from underruns.** TCP never reorders, so
  ordinary jitter is all a room's input buffer should cover; retransmits and Wi-Fi stalls (a hold, then a burst) are
  better bridged by stand-ins than buffered for. `socketJitter(tickHz)` (`@arcade/kit/net/jitter-buffer`) sets the
  target to the 90th percentile of arrival lateness over a 3 s window, starts at zero depth, grows only on a tick that
  already needs a stand-in, catches up only past a real backlog, and keeps the measured schedule when re-priming after a
  stall. Rooms whose `step()` advances the tick before taking must push inputs for the next tick, or every on-time
  input looks a tick late (Getaway and Outbreak did). Two playing clients over an 80 ms ± 15, 1% loss, 150 ms
  stalls link (`scripts/bench-netcode.ts`, 3 × 60 s): press → server p50 Outbreak 150 → 83 ms, Blackout 100 → 67,
  Brawl 67 → 67, Getaway 267 → 67 (its old queue never drained after a stall); no presses lost; corrections per
  minute 4 → 6, 11 → 10, 13 → 10, 4 → 11 (`perf/netcode-{before,socket-jitter}.json`).
- **Rewind targets to the shooter's view for hitscan.** Blackout's client sends the server time it draws others at
  (`SnapshotBuffer.renderTime`) while firing; the World records soldiers on foot every tick (`RewindHistory`) and runs
  the shot's pellets with them rewound, capped at 300 ms. Shooter lag (how old the view is when the shot resolves)
  fell from 150 / 201 / 290 ms to 0 on the good / Wi-Fi / bad profiles, about a metre of lead on a strafing soldier
  (`games/blackout/shared/sim/world.ts`, `perf/netcode-blackout-lagcomp.json`). Outbreak (zombies, 250 ms) and Brawl
  (casts, 350 ms) do the same.
- **Measure netcode headless over a TCP link model.** `@arcade/kit/net/link-sim` models one direction of a
  WebSocket (jitter, 200 ms retransmits and Wi-Fi stalls, delivered in order) and `scripts/bench-netcode.ts` drives
  each room core with two playing clients, reporting press → server / confirm / remote latency, remote starvation,
  shooter lag net of rewind, prediction corrections per snapshot, snapshot rate, bandwidth and tick cost.
- **Draw remote players on a cubic through each snapshot's velocity, coast through stalls, and glide out the
  resume.** Blackout (`src/game/remote.ts`) samples `@arcade/kit/net/interpolate`'s `SnapshotBuffer` 100 ms behind
  and, instead of lerping, follows a Hermite curve through both snapshots with their velocities as tangents (a velocity
  more than 2 m/s off the chord, like a soldier pushing into a wall, falls back to the chord so the curve can't bulge),
  so direction carries through each 15 Hz snapshot. A stalled stream (a TCP retransmit) coasts on the last velocity
  for up to 250 ms instead of freezing, and `Glide` turns the jump when it resumes into a 10/s decaying offset. Over
  120 s × 3 seeds at 120 fps (`games/blackout/scripts/bench-remote.ts`, `perf/blackout-remote-{120,60}fps.json`),
  against the exponential chase it replaced: soldiers' velocity jumps (> 1 m/s between frames) fell from 1,494 to
  166 per minute on a clean 30 ms link and from 1,511 to 217 at 80 ± 30 ms with 2% loss, jerk RMS 38,263 → 11,669
  and 42,676 → 16,154 m/s³; a jeep on a figure-eight 209 → 15 and 729 → 181 jumps per minute. The cost is 100 ms more
  delay: soldiers are drawn 0.46 m behind their server position on average instead of 0.27 m (clean). A one-off
  headless practice run at the time showed bots' frame-to-frame speed jumps (> 1.5 m/s) falling from 58% to 1.4% of
  frames on the vehicle lot and 48% to 13% downtown.
- **Pack entity lists as positional arrays behind the decoder.** Blackout's `shared/wire.ts` sends players, vehicles,
  frags, claymores and `you` as arrays with flag bits and decodes them back to the same `Snapshot` in
  `decodeServer`, so nothing past the socket changed. Downtown, 8 soldiers and 5 vehicles: 1,994 → 1,069 B per
  snapshot (−46%); office 1,478 → 807 B. Positions and velocities keep 3 decimals so your own prediction's
  corrections are unchanged (identical in the bench); 2 decimals saved another ~35 B downtown but, in a 20 s trial,
  raised the mean correction from 1.0 to 4.8 mm. Getaway (`games/getaway/shared/wire.ts`) does the same for `WorldView`,
  cars, helicopter, standings, props and `you`: 2-player chase snapshots drop 1,918 → 577 B (−69.9%), downlink
  bandwidth 29.4 → 10.9 KB/s (−62.9%), and server tick time ~30% while keeping `you` and `phaseT` exact for replay.
- **Time-stretch `SnapshotBuffer.renderTime` so clock and adaptive-delay shifts never jump a frame.** Calling
  `localTime - offset - effectiveDelay()` directly stepped `renderTime` by up to ±2 ms on snapshot arrival frames,
  creating 1.5–3 m/s velocity spikes on fast vehicles at 120 fps. Slewing the combined shift (`offset + effectiveDelay()`)
  within ±2% of `dt` per frame (`packages/kit/net/interpolate.ts`) and capping TCP retransmit bursts at 80 ms in the
  jitter EWMA cut Blackout's lossy-link vehicle velocity jumps from 187.2 to 58.2 /min (−68.9%) and clean-link vehicle
  jerk p99 from 10,325 to 3,538 m/s³ while letting `{ min: 0.08, max: 0.1 }` adaptive delay shave 16 ms off clean remote
  latency (`games/blackout/scripts/bench-remote.ts`).
- **Per-bubble interest culling, priority cadence, and bit-packed delta compression against `ackSnapTick`.**
  `packages/kit/net/{interest,rewind,bytes}.ts`, `games/outbreak/shared/net-protocol.ts` and `server/room-core.ts` scope
  each recipient's zombie updates to their `128 × 128 m` (`±64 m`) chunk bubble, throttle non-urgent mid/far/idle
  zombies to 10 Hz / 5 Hz, and delta-encode against the last snapshot acknowledged by that client (`AckHistory`), sharing
  the encoded payload whenever survivors share a `(bubble, baseTick)` pair. Retained zombies omit their 2-byte `id` and
  4-byte `seed`, using a changed-entity bitfield plus 1-byte nibble (`±7 cm`) or 2-byte `i8` (`±127 cm`) position deltas,
  8-bit aim, and optional state/HP/FX sub-flags; unchanged portals (`sim.revision === baseSnap.revision`) and already-acked
  shots cost 0 bytes; personal survivor state packs in binary (44–75 B vs 200 B JSON); and upstream `"I" + base64` input
  batches fold repeated ticks into 1 bit while re-sending one-shot edges across packet loss. Server-side `RectGrid` and
  `SpatialHash` switch to 4,096-bucket spatial hashing on wide maps, `GridNav` caches integer chunk keys, and
  `RewindHistory` rewinds zombie positions to the shooter's `viewTick`. At 4 survivors spread 1 km apart with 300 active
  zombies (`scripts/coop-bench.ts --matrix=1`, `perf/outbreak-net-perf.json`), downstream bandwidth per client drops
  **`138.41 → 6.81 KB/s` (`-95.1%`)**, upstream drops **`2.75 → 1.43 KB/s` (`-48.0%`)**, snapshot size drops
  **`7,085 → 372 B`** (`zombies: 6,602 → 207 B`, `portals: 144 → 1 B`, `personal: 200 → 75 B`), server tick `p95` drops
  **`14.18 → 1.05 ms` (`-92.6%`, mean `0.64 ms`)**, client decode `p95` drops **`0.52 → 0.03 ms` (`-95.1%`)**, and under
  `80 ± 30 ms` jitter with `2%` packet loss max reconciliation correction drops **`0.1121 → 0.0010 m`** (`0.0000 m` mean,
  zero growth). At 1,000 zombies spread 1 km apart, downstream bandwidth drops **`439.19 → 15.16 KB/s` (`-96.5%`)**.
- **Stream 32 m chunks from deterministic `(seed, cx, cy)` hashes, stitch a sliding 3×3 render window, and persist sparse `ChunkDelta`s.**
  `games/outbreak/shared/world.ts` and `games/outbreak/src/world-streamer.ts` extend Outbreak beyond the fixed 96 m block
  while keeping the starting `(0..2, 0..2)` neighbourhood bit-identical in Classic mode (`prove.ts` passes unchanged).
  Macro-blocks (`3×3` chunks = 96 m) align arterial road centerlines (`lx = 1` / `ly = 1`, `40..48 m`) across chunk
  borders and assign five districts (`suburb`, `commercial`, `civic`, `industrial`, `woodland`) and 13 building/POI
  archetypes (`house`, `ranch`, `cottage`, `hardware`, `pharmacy`, `grocery`, `diner`, `gas_station`, `police`, `clinic`,
  `church`, `warehouse`, `cabin`). Each chunk compiles its static meshes, `128×128` floor AO tile, `256×256` moon mask
  tile, and `64×64` bounce tile once into a 45-chunk LRU cache, pre-warmed one chunk per frame (`< 2 ms`) and blitted
  into the `384²`/`768²`/`192²` GPU textures via `writeTexture` without recreating textures or bind groups. `GridNav`
  queries per-chunk `64×64` (`0.5 m`) walkability tiles across arbitrary chunk boundaries, and `net-protocol.ts` uses
  `i32` centimetre coordinates (`±21,474 km`). Across a 1,152 m scripted Metal traversal (`scripts/prove-world.ts`, 117
  chunks, 36 window shifts), frame time measured `11.5 ms` p50 and `16.3 ms` p95 (`22.2 ms` transition p95), JS heap
  stayed bounded (`64.1 → 86.9 MB`), 98/98 client/server chunk hashes matched, unloaded chunk deltas (doors, locks,
  barricades, searched containers, dead zombies) restored on return, and two co-op clients 1,200 m apart reconciled with
  `0.000 m` drift. See `docs/outbreak-world.md`.
- **Unify adaptive interpolation, stall coasting + `Glide`, bridge-aware `OptimisticEvents`, client tick-rate pacing, and private reconnect tokens across games (`docs/netcode.md`).**
  - **Bridge-aware `OptimisticEvents` reconciliation:** When `socketJitter` bridges a TCP retransmit or Wi-Fi stall with up to 4 stand-ins, a late press's edge is carried forward and applied 1–4 ticks after its nominal `seq`. Confirming optimistic predictions immediately when their authoritative effect is visible at `ack` while holding unconfirmed predictions across a 4-tick grace window (`ack - 4`) before rejecting eliminated false mispredictions on `wifi` and `bad` links in Outbreak (`2.94% / 14.71% → 0%`) and Getaway (`0%` across `good` / `wifi` / `bad`).
  - **Slack-gated `JitterBuffer` shrinking & `Predictor.pace` client tick-rate control (`@arcade/kit/net/{jitter-buffer,prediction}`):** Requiring `windowMinSlack >= 1 && windowUnderruns === 0` before shrinking `socketJitter`'s schedule offset stopped false window-end shrinks when a single packet arrived early, cutting Blackout clean `confirmP50` `79 → 51 ms`, `remoteP50` `167 → 142 ms`, and Getaway Wi-Fi `correctionsPerMin` `8 → 5`. Adding `Predictor.pace` (`0.97..1.02` multiplier on the client's fixed-tick accumulator `dt` from in-flight command excess above `baseInFlight`) trims `+1.5%` client clock drift with `0` server catch-up merges over 60 s (`25 → 0` in `packages/kit/net.test.ts`).
  - **Getaway, Outbreak, and Carrier remote interpolation & seat tokens:** Replacing Getaway's stepped tick estimator with `SnapshotBuffer(0.1, 30, 0.25, { min: 0.08, max: 0.1 })` + per-car `Glide(10, 4)` cut `remoteP50` `158 → 142 ms` (`good`) and `242 → 233 ms` (`wifi`) and `shooterLagP50` `150 → 134 ms`. Adding `SnapshotBuffer(..., { min: 0.08, max: 0.1 })`, 250 ms chord coasting + `Glide(12, 2.5)` for remote survivors/zombies, and `hermite2` + `Glide(10, 4)` for remote vehicles in Outbreak cut `remoteP50` `183 → 171 ms` (`good`) and `correctionsPerMin` `8 → 5` (`wifi`, `15 → 12` on `bad`). In Carrier, adaptive `80–120 ms` plane lag cut `remoteP50` `203 → 163 ms` on `good`, and `sessionStorage` reconnect seat tokens (`RECONNECT_MS = 60_000`) reclaim player `id`, `stats`, and locked-ship berths on reload while blocking unverified `hello.back` lock bypasses.

## Input

- **Exploration maps: per-chunk memory, tiles built on demand.** Outbreak's map (`games/outbreak/src/map/`) keeps
  1 m explored cells per 32 m chunk (1 KB each) plus a compact copy of each explored chunk's layout, and draws them
  through a tile pyramid (16 to 1/16 px per metre, halving) where a tile exists only if something in it was explored
  and is rebuilt only when stale and on screen, within 3 ms a frame. Prebuilding the opening view's stale tiles while
  the map is closed (0.6 ms every 120 ms) left 10 of 65 tiles to build on the first open after a 1 km walk (2.2 ms);
  the first draw took 11 ms and the map's per-frame cost with the sheet closed was p95 0.3 ms. Labels and badges are drawn in screen space at
  device resolution, never scaled from a tile, so they stay sharp at DPR 2. `docs/outbreak-map.md`.

- **Render a read-only catalogue on demand.** `packages/kit/dev-hub-viewer.ts` reuses the shipped Lab spawn
  adapters and stage with one canvas. The first headless Metal proof on both hosts registered 25 assets,
  opened no AudioContexts, and submitted no additional frames after switching to Games or dispatching
  a synthetic hidden-document event. `scripts/prove-dev-hub.ts` checks filtering, lighting/feedback identity
  and focus as well. This is a lifecycle check, not a GPU-performance measurement or a physical-trackpad test.

- **Serve every game from one local origin at its production path.** `scripts/dev.ts` mounts each workspace game's
  unchanged Vite config in middleware mode with base `/arcade/<id>/`, strips the prefix before Vite's middleware so
  root-relative plugin routes still match, and shares one HTTP server for every game's HMR socket. Worker `api/` and
  `ws` traffic is forwarded unchanged to an on-demand `wrangler dev` child. The Studio proof loaded all four games,
  connected HMR for each, hot-updated CSS without a reload and opened a Worker WebSocket through the origin.

- **Latch fire presses across input ticks.** Blackout's `src/game/input.ts` keeps one press edge for at most 100 ms,
  consumed by the next 30 Hz input tick. `Intent.firePressed` carries that edge through prediction and the wire so
  consecutive taps remain distinct even without a sampled release. Weapon cooldown/reload gates consume rejected
  presses; disabling play, Lab capture and blur clear pending input. `tests/fire-input.test.ts` covers taps, holds,
  expiry, focus release and server queue delivery. `scripts/prove-fire-input.ts` drives trusted mouse down/up events
  against the real game with manual ticks, silent audio and a mocked room socket. The original build lost the
  between-tick tap in both paths (0 predicted/authoritative shots); the fix produced 1/1. Each fixed path completed
  the consecutive-tap, sniper-hold, double-click, cooldown, Lab and rifle-hold checks with 12/12 shots. Physical
  trackpad gesture recognition and GPU cost were not measured.

- **Latch click edges with their selection.** Blackout's wizard prototype stores canvas mousedown position and spell
  choice until a fixed tick consumes them (`src/game/input.ts`, `game.ts`). Mouseup cannot erase a quick tap, and a
  number-key/wheel change cannot change a pending cast. Blur and Lab interaction clear the bounded queue. A Metal
  browser proof put down/up and a selection change between ticks, exercised five rapid clicks, Dvorak movement and
  a Lab slider click, and checked separate server cooldowns and active caps. `scripts/prove-wizards-spells.ts` also
  captured player/furniture orbit, pop damage, and a skeleton's wind-up and hit on its caster. Runtime cost is unmeasured.

- **Ignore blur releases from the previous input owner.** On an iframe focus change, the old window's blur message can
  arrive after the new window's keydown or mousedown and cancel the new input. `games/blackout/compare.html` releases
  held input when ownership changes, then accepts release messages only from the current owner. The parent header is
  explicitly focusable. The Metal browser check moved from both panes and the parent, fired eight shots in each client,
  and checked shifted Dvorak comma release and Cmd release. Messaging cost is unmeasured.

- **Support any keyboard layout.** Match both `e.code` (physical position) and `e.key` (character), so QWERTY and
  Dvorak both work without settings. Don't bind an action to a key that is a movement key on another layout (Blackout
  used `E` for plant/defuse, which is Dvorak's right strafe).
- **A menu that takes number keys listens in the capture phase.** Carrier's DEPLOY
  (`games/carrier/src/ui/ops-menu.ts`) runs its rows on 1-9, the same keys as the helm's throttle presets, and both
  listen on `window`. Registering the menu's keydown with `capture: true` and calling `stopImmediatePropagation()` on
  the keys it uses means the game's input never records them, so closing the menu on that key can't leak a press into
  the next frame. `scripts/ui-shot.ts` checks the throttle stays at 0 after picking a row by number at the helm. Its
  toggle key, G, is matched by `e.code` and `e.key` and is a movement key on no common layout (QWERTY, AZERTY, Dvorak,
  Colemak); B was rejected because Dvorak's physical B types `x`, the flight's free-look key.
- **Menus take Pointer Lock away and give it back without a click.** Carrier's `games/carrier/src/input.ts` owns one
  lock for the ship's chase camera and the flight stick. Menus call `suspend()` (remember whether it was held, then
  `exitPointerLock()`); when the last menu closes, `resume()` calls `requestPointerLock()` from the frame loop. Chrome
  allows that without a user gesture because the page, not the user, released the lock; after the user's own Esc it
  isn't resumed. Track the held state from `pointerlockchange` rather than `document.pointerLockElement`, so a menu
  that already called `exitPointerLock()` still reads as "was held". `scripts/ui-shot.ts --only=mouse` checks it on
  Metal for Tab, the ops menu and the debug menu, and through a catapult launch and recovery.
- **Release the character a key produced when it went down.** Shift and Option change `e.key` while a key is held
  (Dvorak `,` becomes `<`), so releasing by the keyup's `e.key` leaves the key stuck and the player keeps moving.
  Record the character per `e.code` on keydown and clear it on keyup. Release everything when Cmd comes up, because
  macOS drops keyups for other keys while Cmd is held, and on window blur.
- **Give input focus back to the canvas after debug controls.** Clicking a non-focusable canvas can leave a checkbox
  or button focused, so the panel keeps swallowing gameplay keys. Blackout's `games/blackout/src/game/input.ts` focuses
  the canvas on mousedown; `games/blackout/src/ui/debug-overlay.ts` stops panel events and releases held gameplay input on pointer
  interaction. Chromium checks passed All On/Off, clicking back into the game, B to switch bots, and Backquote to hide
  the panel. Runtime cost is unmeasured.
- **Keep pointer-driven overlays off the rebuild path.** The Lab radial menu (`packages/kit/lab/radial.ts`) used to
  rewrite all eight sectors' `innerHTML` on every pointermove. When a `pointerenter` handler did that, Chrome dispatched
  the matching pointermove to the detached node, so it never reached the viewport listener and the selection skipped
  that move. The ring now builds its sector DOM once per open. A move only rotates the highlight wedge and direction
  pointer, swaps two `data-active` flags and changes caption text when it differs. Its position is a transform, and the
  OS cursor replaces the drawn viewport glyph while the menu is open. `bun scripts/lab/bench-radial.ts`
  (headless-shell, Metal, 1 warm-up + 7 runs) measured main-thread time per open-menu move with the scene loop off:
  2.12 → 1.04 ms task, 0.25 → 0.02 ms layout, 0.26 → 0.02 ms paint. Giving the highlight, pointer and root
  `will-change` layers cost more in Layerize than it saved in paint (0.87 vs 1.31 ms task per move), so they share the
  menu's layer. Every open and hover change painted on the next frame both before and after. Headless frames on the
  display-less Studio arrive every 50–83 ms even on an idle Lab page, so wall-clock latency there is not a valid
  measurement. Physical-display latency is unmeasured.

## Feel

- **Pick the opening hour for the look, then pace with the clock and perception.** Outbreak's first-night pacing
  started at 16:00 for workbench daylight, which made the first frame the undeveloped day grade (mean luminance 29 → 65,
  saturation ×3 against the 18:00 Noir start; renderer PRs #69–#84 were pixel-identical at equal hours). It now starts
  at 17:30 (`shared/pacing.ts`): `openingClock` 0.25× slows the clock until the first 18:00, so nightfall still lands
  60 s in, and `openingCalm` eases zombie perception and director threat in over 50 s, the curve the 16:00 start gave.
  `bun scripts/prove-first-night.ts`: first contact 43.85 → 42.05 s solo and 44.32 → 43.75 s in 4p co-op, peak chasers
  4 and 11 unchanged; the bench now needs the flashlight (0.46 against 0.35). `scripts/hour-capture.ts` diffs two
  builds at fixed hours.
- **Report actions above the actor, not in a corner.** Outbreak's `src/hud/` shows every player action as a short
  DOM callout stacked over the survivor's head: progress rings for reload, search and barricade, item pops that float
  up (`+5 9mm`), amber warnings (`Out of ammo`), red damage, and dashed noise tags for actions heard 9 m or more away.
  `ActorFeedback` diffs the actor's state each frame, so `shared/` is unchanged and co-op snapshots can reuse it;
  `CalloutLayer.callout(actorId, text, kind, { key, progress, duration })` is the API, and a `key` updates a callout in
  place instead of stacking. Progress sits nearest the head, newest pops on top, at most three per actor (Lab HUD).
  The anchor is the highest projected point of the head and shoulders, and it lifts over the floating E / Hold E
  prompt when the two would overlap. Only visible callouts touch the DOM. Metal proof (`scripts/hud-proof.ts`, 14
  stills): `hud.update` averaged 0.025 ms per frame with three callouts live. In a paired same-page A/B, callout mode
  spent 0.039 to 0.049 ms per frame in style and layout, against 0.064 to 0.079 ms for the old status line, which
  rewrote its text every frame. `bench-outbreak` (5 runs): street p95 18.0 ms at realtime 0.996, interior p95
  18.0 ms at 0.9985.

- **Put in-the-moment state on the character and keep it out of the aim.** Outbreak's callouts now sit screen-below
  the survivor's feet by default (the lowest projected point of a 0.2 m feet circle, so the camera tilt is accounted
  for), and stamina, reload, health and battery are small rings beside the body that appear only while they have
  something to say (`src/hud/vitals.ts`, research and choices in [outbreak-hud.md](outbreak-hud.md)). When the
  survivor aims within 55° of the side the HUD is on, it slides to the opposite side and returns past 68°
  (`chooseSide`, `src/hud/placement.ts`), so the flashlight's near field stays clear without flicker. Rings use shape
  for identity and colour for range, as Dead Space's RIG does. The same components run for co-op teammates from
  replicated flags only, at 0.8× with their name tag. Metal proof (`scripts/hud-proof.ts`, 37 stills): `hud.update`
  p95 0.2 ms with three callouts, three rings and a teammate live; a 7-pair same-page A/B against the old log and edge
  bars measured style and layout −0.003 ms per frame (spread −0.016 to +0.006) and script +0.021 ms (−0.043 to
  +0.101), both inside their spread.

- **Share presentation through explicit units and renderer adapters.** `packages/kit/vehicle/` now supplies both
  games' chassis, posed lamps, tyre emissions and procedural audio. Its inputs use +Y up, +Z forward, metres and
  tonnes. Blackout converts its +X-forward mesh basis and kilograms; converting the complete rotation basis keeps
  combined roll/pitch attachments aligned. The noise-lit smoke pipeline accepts each game's depth format
  (`depth24plus` in Blackout, `depth24plus-stencil8` in Getaway). Matched Metal proof kept Getaway's two PNGs
  byte-identical and Blackout's four sampled simulation poses identical. Blackout's drift produced 49 smoke samples
  and 110 skid segments; its bounded four-voice offline mix peaked at 0.852 without clipping and became silent after
  disabling vehicle audio. Full checks passed 177 tests (12 existing skips) in Getaway and 285 in Blackout.
  Reproduction and audio comparison are in `perf/vehicle-kit.md`; runtime CPU/GPU cost has not been measured.

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

- **Audit feel with a scripted headless session, not by playing.** `games/outbreak/scripts/feel-audit.ts` steps the
  real game at 60 Hz through walk, sprint, a miss, shots to a kill, shoves, crowbar swings, getting hit, a door and a
  fight, recording per frame the camera's trauma, kick, punch, hit-stop and damage flash, the zombie's reaction and
  every `SoundDirector` event (it runs muted, so the event log is exact), then measures live keydown-to-moved-draw
  latency, frame intervals and per-call UI/audio cost. It found: zombie strikes with no pose, a camera that trails a
  sprint by 0.89 m, misses with sound but no visual, a whiffed shove playing a body thud, a 22 ms kill-shot hit-stop
  under a 28 ms shove, the zombie renderer decaying sim `hitFlash` a second time, and `Dock.sync` forcing layout every
  frame (0.2–0.3 ms p50, half the per-frame UI cost; now ~0, UI update 0.4–0.5 → 0.2 ms p50). Shared Macs with booted
  simulators make live frame timing useless (sprint p99 43–260 ms between runs on mini against 17.1 ms on Studio);
  judge pacing on an idle machine. `scripts/feel-clips.ts` records deterministic muted clips for decisions.
- **Pair a hit with its attacker from health diffs and show it on the attacker.** Outbreak's zombie strike lunge
  (`src/zombie-strikes.ts`, details in [animation.md](animation.md)) and the bullet impact flash
  (`src/bullet-impacts.ts`: flash 70 ms, sparks 120 ms, dust 260 ms, per surface, at the points `shotImpacts` gives the
  sound, delayed by the round's travel) are presentation fed by state the client already has, so co-op needs no wire
  fields. Hit-stop per hit kind, the impact flash, the lunge and an on-foot camera lead are typed settings in Lab ›
  Feel and Lab › Camera (`src/feel-tuning.ts`). Kit picked the defaults from clips (D-35, D-36): camera distance 38 (was
  46) and a movement lead of 0.3 s of travel, with no aim lead. The follow eases the lead at 3.5/s, so the view runs
  ahead while moving and is centred once you stop. Vehicles, horde watch and peeks skip the foot lead.
- **Give bodies physics from the frame they were drawn on, and derive every blow from replicated events.**
  Outbreak's AR-90 audit (`~/code/home/artifacts/agent-reports/outbreak-oomph.md`) found every kill ended in one of
  four canned 0.24 s collapses at the sim spot whatever the weapon, direction or force; cars and dynamite never moved a
  body; stagger poses were picked per zombie by seed, not by hit direction; and hit-stop was the same for a knife and a
  fire axe. `src/impact/` now drops the dead as `@arcade/kit/avatar/bone-ragdoll` Verlet ragdolls bound to the exact
  pose drawn on the frame of death (no pop: bind error < 1e-4 m), rocks the living with
  `@arcade/kit/avatar/hit-reaction` springs, pushes bodies already down with blasts and cars, and scales melee
  hit-stop and kick by `√(damage × knockback)` against the crowbar (knife 0.6, fire axe 1.37). Blows are pure functions
  of the shot, swing, vehicle-hit and blast events every client already has (`causes.ts`), so co-op needs no wire
  fields and two clients drop the same body identically (`tests/impact.test.ts`); the sim state is byte-identical with
  it on or off. CPU on Studio (Bun, median of 7 × 60 frames): 12 awake ragdolls
  0.10 ms per frame, 16 awake 0.18 ms, 40 live hit reactions 0.05 ms; a settled body is a cached 180-float copy. Start a ragdoll only from a pose drawn last frame where the zombie now is: a death off-screen
  keeps the canned collapse rather than flinging a stale pose.
- **Hit-stop is presentation only.** Freeze or slow what is drawn (`HitStop.step(dt)` in `@arcade/kit/client/camera`),
  never the simulation clock, so prediction and the server stay in step.
- **Scale shake with trauma squared, and keep feel primitives composable.** `Camera.add(trauma, dir?, kick?)` in
  `packages/kit/client/camera.ts` drives `trauma²` 2-octave smooth 1D gradient noise on `(x, z, roll)` plus critically
  damped directional recoil/lunge kicks, `MotionBlurBurst` in `packages/kit/gpu/motion-blur.ts` feeds short directional
  and radial velocity impulses into the shared 8-tap depth-aware `MotionBlur` gather pass (`0.000 ms` steady-state GPU
  overhead when inactive; `+0.007 ms` street / `-0.016 ms` interior paired `ab-gpu.ts` at `3456×1894`), and `G.z`
  (`render.grade[2]`) drives the crimson edge damage flash in the existing post composite. In `SplatterRenderer`
  (`packages/kit/fx/splatter-renderer.ts`), keeping `alpha: { srcFactor: "zero", dstFactor: "one" }` preserves
  `hdrView.a` (`1.0 - lookFlashIrradiance`) so Outbreak's Noir post shader retains deep arterial crimson inside the
  flashlight beam while desaturating blood outside the beam (`36.16×` beam-to-shadow red chroma ratio, up from `7.38×`).
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

## Audio

- **A procedural soundscape that ships no files (AR-86).** Outbreak's `src/audio/soundscape/` synthesizes 28 ambient
  sounds in plain TypeScript (`dsp.ts`: two-pole modes scaled by `sin(w)` so high partials are not buried, bubbles,
  formant babble, swept biquads, crossfaded loops), bakes each at 24 kHz on first use in a Worker (≤ 24 ms per sound
  in Bun, 0 ms on the frame) and registers it as a runtime cue with `SampleBank.setDecoded`. 0 bytes of assets,
  ~106 s of audio if every sound were baked. A pure `ScapeDirector` seeds every event on `town.seed` and sim time in
  fixed windows (co-op clients hear the same sirens at the same moment), costs ~2 µs a frame, and drives both the
  game and an offline reel (`games/outbreak/scripts/soundscape-reel.ts`) that mixes it with the beds, footsteps, the
  runtime's spatialiser, occlusion and both reverb impulses into a WAV with loudness per stem. Measuring spectra first
  caught distant gunshots with 99% of their energy under 250 Hz (silent on laptop speakers) and a raw resonator bank
  whose low modes drowned every tick.

- **Check state changes before finding sound geometry (AR-76).** Outbreak's `src/audio/director.ts` skips door centres
  and portal geometry searches when their remembered state is unchanged. Missing geometry still leaves history
  untouched, preserving sounds when a streamed portal returns. `scripts/cpu-review-bench.ts --baseline=<base-game-dir>`
  alternates old/new production directors: seven Studio M5 Max/Bun pairs with 110 portals reduced median paired CPU
  cost by 48.4% (separate medians 0.1248→0.0663 ms/frame), with identical 3,000-frame event traces. The 20-portal
  case was noisy; no small-scene gain is claimed. This measures sound-event generation, not Web Audio or GPU time.

- **Never start a cue on its synthesized stand-in while the real file is loading (AR-40).** `SampleBank.getBuffer`
  synthesizes a fallback for any sample not yet decoded, and Outbreak starts its three ambience beds on the player's
  first key press, while `loadAll` has only begun. Each bed's stand-in is a constant 2 s sweep from 180 to 90 Hz with
  60% noise at about -14 dBFS RMS, 16 dB over the -30 LUFS beds, and a looping voice keeps that buffer after the real
  file arrives. Three of them were the "really loud alarm at the start". Headless proof with every audio file held
  3 s (`games/outbreak/scripts/audio-start-browser.ts --slow-net 3000`, `--mute-audio`, graph unmuted): on main all
  three beds start at 0.5 s with 0 files decoded; now `AudioRuntime.playCue` returns null while a sample it needs
  `isPending` (counted as `pendingSkips`), beds and holds retry each frame and start on the real files, `loadAll`
  fetches loops first, and a looped stand-in (left for files that fail) is 14 dB quieter. Separately, an alarm-car
  vignette's spent alarm (`old`) rang for the first 0.1 s on seeds whose origin block has one (seed 1);
  `tests/audio.test.ts` now walks five seeds 40 s from spawn with no alarm hold or noise.

- **Render Web Audio offline to check a mix without ears.** Carrier's `scripts/audio-demo.ts` drives the real mixer and
  jet audio on an `OfflineAudioContext`, stepping the scripted scene every 1024 frames with `ctx.suspend(t).then(...)`
  and `resume()`; `scripts/audio-render.ts` runs it in headless Chrome on hailmary (a 15 s scene renders in about
  0.5 s) and writes WAVs. Band levels per second and ffmpeg `showspectrumpic` spectrograms caught a sub-heavy engine
  (lows 8-10 dB over the mids), an afterburner only 1.5 dB louder than military, a whine gliding in from the
  constructor's default frequency, and a far jet 10 dB quieter than intended. Peaks stayed at -3 dBFS behind the
  limiter in every scene.
- **Jet engines: few smooth layers, and quiet.** Carrier's first engine (whine partials, buzz-saw rasp, intake howl,
  noise-torn roar, crackle at military power, recorded flyby takes on top) was called "terrible and loud" in play. Its
  replacement ports Wings' fighter voice (`games/carrier/src/audio/jet-engine.ts`): a soft triangle whine plus a ×2.76
  overtone, pink roar behind a throttle-opened low-pass, brown body, an afterburner-only rumble/sub/crackle, all
  procedural. Offline 0.5 s RMS: your jet in chase at military sits 18 dB under a gun burst, 13 dB under medium weather.
- **Web Audio's compressor adds makeup gain.** A `DynamicsCompressorNode` raises everything by roughly 0.6 × its
  full-scale gain reduction, so a "limiter" quietly made carrier's whole mix 3.7-7 dB louder. Carrier measures it with a
  calibration tone (`scripts/audio-demo.ts` "calib") and trims it back (`MAKEUP_TRIM` in `src/audio/mixer.ts`).
- **Recorded explosions, per scenario, crossfaded by distance.** Carrier's `src/audio/jet-boom.ts`: 3 ElevenLabs takes
  per scenario (air kill, missile, bomb on water/land, crash into sea/land) and 3 distant rumbles; the close take is
  low-passed by air absorption and crossfades into a rumble from 350 m to 1.8 km, after the travel time.
- **Line flybys up with the predicted closest approach.** Carrier predicts each jet's straight-line closest approach
  every frame and swells a procedural air rush to land on the pass, panned with the jet (recorded takes lined up the
  same way by their loudest 100 ms are behind a toggle: they sounded worse than the procedural engine in play). Unit tests in `games/carrier/tests/audio.test.ts` check
  the trigger fires once, at most 2.4 s ahead, landing on the pass. Live feel is unplaytested.

- **When nobody on the team can listen, let the user's ears pick.** Carrier's v1 and v2 sounds were chosen from
  spectrograms and called "cheap" in play. v3 ships 3-4 candidate takes for each of 51 slots and an audition board (the
  SOUNDS tab, `games/carrier/src/audio/sounds-lab.ts`): play each take dry or placed in the world with the reverb, pick,
  trim, rate; picks apply live, persist in localStorage, and a dev-server endpoint (`scripts/sfx-picks-plugin.ts`)
  writes `public/sfx/picks.json`, the shipped defaults. Takes load lazily: only the picks (~4.5 MB of 9.5 MB).
- **Seamless loops through lossy codecs.** `scripts/sfx-cinematic.ts` crossfade-loops each take, appends its first
  0.25 s after the loop point and records the loop length in a manifest; the game loops `[start, start + length)` where
  start skips any leading decoder padding (Safari's Opus pre-skip). Ogg Opus decodes in Chrome, Firefox and Safari
  18.4+ (Safari 26 is the WebGPU floor anyway).
- **Measure loudness with a montage, not per sound.** Carrier's 60 s offline montage (`scripts/audio-demo.ts`, ocean →
  catapult → climb → pass → gun → missile → kill → storm → trap) measures -16.1 LUFS integrated and -1.7 dBTP through
  the real mix; individual scenes put your engine in the chase view 16-18 dB under a gun burst and medium weather ~5 dB.
  Unit-scene levels alone hid a sub-heavy bed (a ship ambience left playing in every scene) and rain carried over.
- **Keep anything that follows a vehicle's live state procedural.** Carrier tried recorded engine loops crossfaded by
  throttle and recorded flybys aligned to the predicted pass; the user ruled them out: throttle, spool, afterburner,
  Doppler and geometry change every frame, and a take can't stay locked to them. v4 synthesizes engines, cockpit, wind,
  flybys and the sonic crack (`games/carrier/src/audio/jet-engine.ts`, `jet-sfx.ts`, `jet-cockpit.ts`) and records only
  discrete events (catapult, trap, gear, guns, missiles, explosions, ambience, UI). Sending the procedural voice into
  the same convolution reverb and water slapback as the recorded one-shots makes them sit in one space.
- **A gun locked to its rate of fire: a looped round train, gated on round boundaries.** Carrier's M61
  (`games/carrier/src/audio/gun-audio.ts`) synthesizes 24 rounds into one loop, each exactly 1 / rate long (50 rps: 960
  samples at 48 kHz), so the cadence is sample-accurate with a single buffer source; the trigger opens and closes a gain
  on the next round boundary, so bursts start on a clean transient and the overheat cut is exact. Offline: a burst at
  -14 dBFS RMS, rounds visibly 20 ms apart in the spectrogram. Rounds zipping past are found by each live round's
  closest approach to the camera within the frame and scheduled at that instant.
- **One clear sound per moment, enforced by a voice budget.** Carrier's takeoff stacked eight one-shots (menu open, hover,
  click, hold-back clank, burner whump, catapult plus an extra thud, shuttle slam, gear) and players called it
  cluttered. Each moment now gets one sound (`games/carrier/captures/audio/v6-sounds.md`), and the bank
  (`games/carrier/src/audio/sfx-bank.ts`) caps recorded one-shots at 6 with per-slot cooldowns and priorities:
  explosions duck and outrank weapons, which outrank deck events, thunder, then accents and UI.
- **Measure amplitude wobble, not just level.** "Feels weird" on carrier's procedural engine (v4) was a 7 dB
  envelope wobble at 1.5-6 Hz (the std of a 20 ms RMS envelope after removing a 1 s moving average, on offline
  renders from `games/carrier/scripts/audio-demo.ts`). Removing Doppler and the angle-dependent cone from your own jet (the camera
  rides with it), slowing the twin-engine beat from 4 cents (≈3 Hz) to 0.6 cents, and halving the afterburner's level
  drift brought it to 1.3-2 dB. Smoothing the heard throttle (0.3 s) removes filter jumps; matching the cockpit
  interior's level to the chase view makes a camera switch change colour, not loudness.
- **Generate many candidates, then let measurements do the first cut.** The shared library
  (`scripts/sfx/library.ts`, [sfx-library.md](sfx-library.md)) asks ElevenLabs for 2–12 takes per sound and scores
  them on numbers that catch bad takes without listening: near-silent takes (the first pistol prompt returned six
  takes peaking at -22 to -39 dBFS), flat-topped runs (real clipping, unlike recoverable decoded overs), SNR over the
  take's own noise floor, one onset for single events, decay by 0.2 s, timbre distance from the family median and
  bed steadiness. Footsteps come from 6 s walking takes sliced at onsets and re-trimmed to each step's transient:
  six consistent steps per surface from two requests. Contact sheets (waveform + spectrogram per candidate) show
  the picks. It cannot tell whether a groan sounds like a zombie; that still needs ears.
- **Pad Opus loops on both sides.** Opus decoding attenuates a stream's first samples, so a loop over the whole file
  jumps at the seam (the interior bed's seam was larger than any sample step inside it). Wrapping the loop region in
  0.25 s of its own tail before and head after, and looping `[loopStart, loopEnd)`, put every seam step inside the
  bed's own distribution.
- **Drive sound from state diffs, like the HUD.** Outbreak's `SoundDirector` reads `CoopSim` each frame (shots,
  zombie states, doors, planks, bashes, each survivor's `FeedbackActor` fields), so co-op clients sound right from
  snapshots with no new wire fields. Crowd sounds need explicit spacing: idle groans every 4.5 s / √n, never closer
  than 0.7 s, each zombie at most every 8 s; alerts one per 0.35 s across the crowd. 100 zombies cost 0.013 ms per
  frame in the director and 0.037 ms for the whole audio update in the browser.
