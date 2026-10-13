# Game notes

Techniques that have worked in one arcade game and should carry to the others. Add an entry once something is proven:
what it does, where it lives, and what it measured. Mark candidates that have not been measured or playtested yet.
Shared code that bakes these decisions in is tracked in `docs/shared-code.md`.

## Proving a change

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
- **A performance pass must not change the look.** Compare before/after stills of the same seeded frame. If they differ,
  the change is a look change and needs its own review. (Getaway: a widened helicopter spotlight slipped into a perf
  pass; the tight original read better.)
- **Expect machine noise as large as the win.** On a shared machine, one Blackout run measured 10.0 ms against a real
  5–6 ms; a confirmation round without code changes came back at 5.8 ms. Alternate the variants in pairs, keep raw
  runs and outliers, and never claim a win inside the spread.
- **Read timestamps only after they resolve.** Queue completion does not mean the timestamp readback finished; await
  the readback before clearing samples. Render-pass timestamp ranges can overlap, so don't sum per-pass times into a
  total.
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

- **What makes the Getaway concept art read** (`games/getaway/concept/dir-d-lowpoly-*.png`), compared with the game on
  2026-10-12: small warm lamp pools with dark navy road between them (ours were large, even and hazy); flat, matte
  ground (ours too shiny); everything grounded by dark contact areas under cars and at building bases, curbs and
  trees; walls and roofs with tonal gradients and lit edges rather than one flat colour; dense set dressing on
  sidewalks and plazas; warm shop-window light spilling onto the sidewalk; a clear cool-fill, warm-pool, saturated
  siren colour split; and chunky white smoke. Kit agreed on the pools, the ground and the shop light. Being built as
  separate Look switches; record what each costs and whether it stays.
- **Soft smoke can overshoot.** Replacing Getaway's hard faceted puffs with soft sprites fixed the hard look but made
  the trail barely visible; the concept's smoke is full and opaque. Aim for readable volume first, softness second.

## Researched, not yet adopted

Candidates from the code audits; measure and playtest before moving any into the sections above.

- A hue-preserving tone curve (AgX-style) so red/blue sirens and warm lamps keep their colour instead of skewing
  orange or cyan; brightness-weighted first bloom downsample to stop specular fireflies; one-code-value dither before
  8-bit output to remove banding in dark gradients.
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
