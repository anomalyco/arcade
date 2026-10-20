# Outbreak

- Unlisted prototype: deployed at `/arcade/outbreak/`, accessible by link without login. Keep `noindex`, no landing panel, and no sitemap entry until promoted.
- Simulation lives in `shared/` (deterministic, no DOM or Worker APIs), presentation in `src/`. `shared/coop-sim.ts` is the one
  world simulation: offline `LocalSession` runs it with one survivor, the co-op room (`server/room-core.ts`, Durable Object
  `OutbreakRoom`) with up to four. Read `../../docs/outbreak-coop.md` before touching the sim, the wire protocol or
  `src/net-session.ts`.
- New features go in a folder and register; never edit `coop-sim.ts` or `src/main.ts` for a feature. A shared feature
  lives in `shared/<feature>/`: domain modules plus an `index.ts` that only calls `registerOutbreakSharedFeature`
  (`shared/feature-registry.ts`: sim step hooks, interactions, per-sim state and cloning, tuning namespace, net section
  codec), and one import line in `shared/features.ts`. Features program against `OutbreakSim` and the other shapes in
  `shared/sim-types.ts`, `shared/types.ts` and `shared/net-types.ts`, never `coop-sim.ts` or `net-protocol.ts`, and
  other modules import a feature's domain files, never its `index.ts`. The client half lives in `src/<feature>/`,
  registers with `src/feature-registry.ts` (Lab settings and controls, commands, harness, feel events, net hooks) and
  gets one import line in `src/features.ts`. Central client modules (`harness`, `lab-controls`, `game-commands`,
  `feel-events`, `net-session`) never import the registry; `main.ts` passes it in as `features`, and tests or scripts
  that build a `NetSession` pass `outbreakClientFeatures` from `src/features.ts`.
- `shared/build.gen.ts` (gitignored) hashes `shared/`; `bun run check/build/dev` regenerate it. Co-op clients with another hash reload.
- Every adjustable presentation value goes in the shared Lab panel. URL parameters are for session routing and automation only.
- Proof: `bun scripts/prove.ts` from this directory, using headless Metal Chromium; no visible window or audio.
- Refactors that must not change behaviour prove it three ways, base vs branch: `bun scripts/parity.ts --out before.json`
  then `--against before.json` (SimState hashes from `CoopSim` and pure `stepSim`, snapshot wire bytes and survivor-bot
  batch results for fixed seeds), the Outbreak tests, and `bun scripts/parity-capture.ts --label <name>` on one worker
  (`hivemind run --kind browser --worker studio --fetch captures/parity`) then `--compare <dirA> <dirB>`.
- Difficulty: `tests/difficulty-ramp.test.ts` (in `bun run check`) holds the bot-played ramp inside tolerance bands;
  `bun scripts/difficulty-ramp.ts` writes the full report and charts. Change a band only with a deliberate difficulty
  change, in the same PR (`../../docs/outbreak-difficulty.md`). The night ramp (D-40, `shared/night-ramp/`, Lab › Night
  ramp; "Today" turns it off) raises population, chasers, specials and late rounds each night through the director's
  `DirectorEscalation`.
- `bun scripts/check-cycles.ts` (part of `bun run check`) fails on any import cycle between Outbreak modules, type
  imports included.
- Sound lives in `src/audio/` and plays the shared library (`../../docs/sfx-library.md`, mix & material rules in
  `../../docs/audio-design.md#4-outbreak-sound-pass-mix-hierarchy-11-surface-materials--voice-priority`). `SoundDirector`
  turns `CoopSim` state changes into sounds; `surfaceAt(town, x, y, extra)` resolves 11 floor/ground materials for
  gait-scaled footsteps and impacts; Lab: Backquote › Sound (`Today` vs `Sound pass`, bus levels, per-surface footstep
  sliders, occlusion, falloff, reverb, voice cap). Never play sound audibly in proofs: `bun scripts/prove-audio.ts`
  (via `hivemind run --kind browser`) uses `--mute-audio`.
- The soundscape (AR-86, `src/audio/soundscape/`, Lab: Backquote › Sound › Ambience, "Today (beds only)" turns it off):
  procedural, zero-asset ambient layer. Interiors per house (`houses.ts`): clocks (some stopped, one limps, mantel
  clocks strike the hour), dripping taps, fridges that hum until the house's power fails (`housePowered`, pure, for
  anyone who wants TVs to agree), creaks, settling, pipe knocks, wind and curtains at open or broken windows, a music
  box that plays once a night when someone steps in, phones, and one haunted phone per few houses that rings at 3 AM
  until someone walks up and the machine answers. Outside: rain on cars, puddles and leaves, gutters after rain,
  porch chimes on gusts, insects by day. Distance: sirens and other survivors' gunfire that thin out each night and
  stop (the last sirens wind down mid-wail, the fourth night's shots are three and then one), a far car alarm, an owl
  from night 2. Seeded on town seed and sim time; presentation only (nothing reaches zombie hearing). Other features
  ask for sounds through `soundscape/hooks.ts` (`playAmbientSound`, `holdAmbientSound`, `registerAmbientSound`).
  Listening reel and loudness: `bun scripts/soundscape-reel.ts` (offline, never plays). Tests: `tests/soundscape.test.ts`.
- The survivor (`src/survivor.ts`) and zombies (`src/zombies.ts`) use the shared rig's IK, arms and profiles but keep their own stride clocks and terrain support. Motion rules and known gaps: `../../docs/animation.md`. All shared docs: `../../docs/README.md`.
- Rugs and Resident Evil interior themes live in `src/interiors/` (plan, mesh emitters, WGSL, `RugPool`); the rug
  generator and its Worker are in `@arcade/kit/textures`. Lab: Backquote › Rugs & interiors, the Lab's Rugs section and the
  `rugs-interiors` station. Proof: `bun scripts/interiors-proof.ts --phase after` (via `hivemind run --kind browser`).
  Windows (`windows.ts`), fitted cabinets (`cabinetry.ts`), skirting and wall wear follow the interior material
  standard in [docs/outbreak-art-direction.md](../../docs/outbreak-art-direction.md); the **Interior craft** setting
  (Today / Craft pass) gates them.
- Generated furniture (`@arcade/kit/props`, pipeline in `scripts/props/README.md`) furnishes the start block's houses
  from `src/props/`: anchors replace the gameplay furniture's boxes one for one (collisions stay `PROP_SHAPES`), and
  clutter is client-only. The level bake reads the same plan through `propDressingState`: floor clutter over 0.3 m
  is grounded like furniture (`propFloorFootprints`), and table lamps bake pools (`propLamps`), with shades glowing on
  `TABLE_LAMP_SLOT`. On by default; Lab: Backquote › Props ("Furnish start houses") and the Lab's `props` station.
  Stills and paired GPU cost: `bun scripts/props-stills.ts` (via `hivemind run --kind browser`).
- World details (`src/details/`, Lab: Backquote › Details, station `outbreak-details`): the lived-in, then-abandoned
  layer from the RE Mansion direction (D-30). Indoors: mail behind front doors, moving boxes, and turned-over houses
  (toppled chairs, dumped drawers, books, broken crockery; always where Blood put prints on the walls or a vignette
  broke in). Outdoors: bins and dumpsters, mailboxes, dropped luggage, bikes and prams, police tape on cones round the
  Night lights police cars, spray-painted search marks and warnings on front walls. Life: crows on lawns and at
  bodies that scatter from survivors and gunshots (`crows.ts`, wing flaps from the library), televisions left on that
  flicker on their room (`TV_LAMP_SLOT`, clipped like table lamps), dogs barking far off at night (`life.ts`). Placement is a pure function of
  the town and `dtSeed` per building and car (`placement.ts`), meshes are box-built (`models.ts`), drawn instanced
  from `scene/frame-renderer.ts`. Life touches (Backquote › Details · Life, `touches.ts`; "Life touches" off is
  Today): moths circling lit fixtures (`swarms.ts`, glow from the frame's `lampPower`), flies over bodies and bins seen
  only in light, eyes under yard trees that catch the torch and bolt plus one rare pair from night 2 that does not
  (`eyeshine.ts`), breath in the cold beam (`breath.ts`). All are renderer alpha/additive sprites (in the TAA reactive
  mask) lit on the CPU by `BeamProbe` (`light-probe.ts`) from the frame's torch slots. Leftover life (`leftovers.ts`,
  `sprinkler.ts`): washing on lines in the yards swinging with the gust field, parked cars (still where they spawned,
  empty) left with a door open and a dome light that dies over nights 2–4, a front-lawn sprinkler on a 06:36–07:18
  timer losing pressure daily, brass from every shot that stays where it fell (seeded from the shot), and televisions
  that go dark one by one, lit windows going out house by house (`setWindowPowerLeft` in `look/lit-windows.ts`)
  ("Town runs down night by night"; the night is `townNight`: the Way Out's shared count, else the night ramp's).
  Weather traces: rings from eave and tree drips that keep falling after the rain and fade as the ground dries
  (`drips.ts`, from the weather's wetness and rain), and boot prints that stay wet behind anyone walking out of a
  puddle or wet grass and dry in 45 s outdoors (`prints.ts`). Tests: `tests/details.test.ts`,
  `tests/details-life.test.ts`, `tests/details-touches.test.ts`, `tests/details-leftovers.test.ts`,
  `tests/details-weather.test.ts`.
- Houses (AR-79, `shared/houses/` generator, `src/houses/` meshes, Lab: Backquote › World · Variety, station
  `outbreak-houses`): streamed homes outside the origin block get a form (bungalow, colonial, ranch, duplex, shotgun,
  farmhouse, trailer, apartment, corner store), a condition (kept, derelict, burnt, under construction), their own
  plan, roof, siding, porch, garage, fence, yard and household, stored on `Building.style` and drawn by the chunk
  streamer. "Today" is one setting away and bit-identical; co-op always uses the defaults (`NetSession` resets them).
  How it works: `../../docs/outbreak-world.md#styled-homes-ar-79`. Plans on the CPU: `bun scripts/house-variety-dump.ts`;
  stills: `bun scripts/house-variety-sheet.ts` (via `hivemind run --kind browser`). Tests: `tests/house-variety.test.ts`.
- Vegetation (AR-66, `src/vegetation/`, Lab: Backquote › Vegetation, station `outbreak-vegetation`): Lively (default)
  gives trees species, bare trees and swaying limbs, shrubs stray shoots, and drives every canopy, limb, shrub and blade
  from one gust field (`applyFoliageWindField` in `@arcade/kit/gpu/foliage`, sim time + position only); Today restores
  the old meshes and wobble. Build options reach `plant()` through `vegetationBuild` (synced each frame by
  `world/scene-level.ts`, sent to the world Worker, part of every level/chunk cache key). Stills, wind clips and paired
  GPU: `bun scripts/vegetation-stills.ts --clip --gpu` (via `hivemind run --kind browser`). Tree look (D-41/D-42, AR-74,
  Lively only; C is the default, Today one setting away): A Deadwood, B Fluffy, C Darkwood from
  `@arcade/kit/gpu/foliage-looks`, dispatched by `plant()`; "Blighted trees" (default 25%) gives a seeded share of C
  trees Deadwood's limbs with withered clumps or none. A and C sink to near-black grey outside light in
  `outbreakTreeSurface` (`src/vegetation/trees.ts`), take their colour in the torch beam, and bake long moon shadows. Burning trees are a shader hook for the fire feature: `setTreeBurnSource((treeIdAt(x, z)) =>
  0..1)`. Stills, night clips and paired GPU per look: `bun scripts/tree-looks-stills.ts --clip --gpu`.
- The look (survivor style, grade, lamps and sky as trims on the day cycle, curated presets) lives in `src/look/`;
  Lab: Backquote › Look · Presets/Hero/Grade/Lights and the `outbreak-look` lab. The look's contract is
  `../../docs/outbreak-art-direction.md`; beauty stills, flicker and paired GPU: `bun scripts/look-beauty.ts`. Stills: `bun scripts/look-stills.ts`
  (via `hivemind run --kind browser`). Defaults stay today's look until Kit picks. Soft Bean (Hero › Survivor style) has
  its own shape, colour and surface knobs; stills and paired GPU cost: `bun scripts/bean-stills.ts`.
- Reflections (AR-73, `src/reflections/`, Lab: Backquote › Look · Reflections, "Today" = `reflections` 0): lamps,
  lit windows, fire, police lights and headlights mirrored analytically in standing water and wet paving (the CPU picks
  up to 8 outdoor lights per frame into `OL.reflLights`; the street potholes always hold water, the weather's puddle
  mask or the Lab's wetness adds pools), and leaning, foxed floor mirrors whose glass computes its own reflection
  (floor, flashlight, people in front). Ash always has one beside the bedroom door, facing the living room; other
  houses 14 %, some cracked. Placement is `mirrorSpot` in `src/interiors/mesh.ts` (its footprint keeps props and
  details off). Stills and paired GPU: `bun scripts/reflections-stills.ts` (via `hivemind run --kind browser`). Tests:
  `tests/reflections.test.ts`.
- Special zombies (Runner, Brute, Screamer, Bloater, Riot cop, Lurker) live in `shared/specials/` (kinds, rarity and
  stats in `kinds.ts`, behaviours in `specials.ts`) and `src/specials/` (silhouettes and accessories drawn by
  `src/zombies.ts`, gas cloud, Lab). The kind is encoded in the zombie's seed, so clients read it with
  `specialKindOf(seed)`. Lab: Backquote › Specials (rarity, stats, "Spawn <kind> ahead"); `arcade cmd specials.spawn
  kind=brute`. Sounds: `src/audio/specials.ts`. Tests: `tests/specials.test.ts`.
- Driving FX (skid marks, tyre smoke/dust, screech) come from per-wheel slip in `src/vehicles.ts` via `@arcade/kit/vehicle/slip`
  and `@arcade/kit/fx/skids`; Lab › Driving FX and the `outbreak-vehicles` station's drift/burnout variants. Proof:
  `bun scripts/prove-driving-fx.ts` (via `hivemind run --kind browser --fetch captures/driving-fx`).
- Crafting (D-39 Recipe Board, D-38 Panel And Tips): picking up materials fills recipes in on the workbench board
  (`shared/discovery/recipes.ts`, `recipe-board.ts`); the recipe panel on `C` (or `E` at a bench) and the teaching tips
  live in `src/crafting/`; `Q` only pings. Lab: Backquote › Crafting. How it works:
  `../../docs/outbreak-progression.md#how-crafting-works`. Stills of a new player's walkthrough:
  `bun scripts/crafting-proof.ts` (via `hivemind run --kind browser`).
- Death (AR-61, `shared/death/`, `src/death/`): at 0 HP a survivor goes down, a teammate holds E to revive, bleed-out
  or being alone kills, the body keeps their kit, the dead watch a teammate until dawn, and everyone dead ends the run.
  Lab: Backquote › Death ("Today" = nobody dies) with Down/Kill/Revive me and teammate actions; `arcade cmd death.kill`.
  Rules and wire: `../../docs/outbreak-coop.md#death`. Tests: `tests/death.test.ts`.
- Fire & explosives (AR-62): the flamethrower, dynamite, firecrackers, molotovs, the flare gun and bear traps live in
  `shared/fire/` (rules over fixed rings of shared ledger stores, nothing on the wire) and `src/fire/` (fire light
  packed after the night lights in `extraLights`, rigs and charring, drawn from `scene/frame-renderer.ts`). The look
  (AR-68) is the kit explosion fire: `src/fire/kit-fx.ts` emits kit `fireball`/`smoke`/`spark` particles for the stream,
  burning figures, ground fire and crackers, dynamite is `spawnExplosion` with the kit "barrel" preset, molotovs the
  "pop", and scorch is kit decals. Lab › Fire & explosives look › Fire style 0 is Today's analytic sprites. Lab:
  Backquote › Fire & explosives, `arcade cmd fire.stage scene=…`, station `outbreak-fire`. Items, loot and recipes:
  `../../docs/outbreak-progression.md#fire--explosives-ar-62`. Tests: `tests/fire.test.ts`.
- The air (AR-68, `src/air/`): world smoke from manholes, storm drains, smouldering cars, wrecks and chimneys
  (`air/smoke.ts`, placement a pure function of the town and `smokeSeed`, nearest 14 sources within 30 m) and soft
  beam dust (`air/dust.ts` style 1). Smoke and the kit fire share one kit particle pool in `scene/fx-particles.ts`,
  drawn by the kit renderer's `fxParticles` path and lit only by the beam (a plan-cone spot) and the strongest lamps
  and fire lights, so smoke is dark until a light finds it. Lab › World smoke / Beam dust (0 is Today), `arcade cmd
  air.stage scene=steam|car`, station `outbreak-fire` › Smoke & dust. Tests: `tests/air.test.ts`.
- The Way Out (AR-64): a seeded far-off destination found through three tiers of clues, reached by car (gas cans
  only, hotwire with a toolbox, roadblocks cleared by dynamite or bolt cutters), a signal, a stand until dawn and the
  escape card, in `shared/way-out/` (all state in the `wayout` ledger store, nothing on the wire) and
  `src/way-out/`. Lab: Backquote › Way Out (Off = endless survival), `arcade cmd wayout.*`, station
  `outbreak-way-out`. How it works: `../../docs/outbreak-way-out.md`. Tests: `tests/way-out.test.ts`.
- Hearing, sound cues and peek (AR-67): the dead hear through building shells (`shared/hearing.ts`; shut houses keep
  footsteps in, open doors and windows carry; Lab › Hearing, "Today" = walls only), the HUD's sound cues draw the
  reach they hear (`src/sound-cues/`, Lab › Sound cues, `../../docs/outbreak-hud.md#sound-cues`), and peeking eases
  camera, sight and roof cut together (`src/peek-view.ts`, Lab › Peek). Tests: `tests/hearing.test.ts`,
  `tests/sound-cues.test.ts`, `tests/peek-view.test.ts`.
- Weather (AR-71): a seeded cycle per town (clear, drizzle, rain, storm; storms rare and only after dark) that is a
  pure function of `town.seed`, `sim.time` and `hour`, so nothing is on the wire (`shared/weather/`: `schedule.ts`,
  `lightning.ts`; rain masks zombie hearing and sight through `ai.weatherSense`). `src/weather/` draws it: rain only in
  light through the kit `WeatherRenderer`, wet ground and the puddle mask other features read (`puddles.ts`:
  `outbreakPuddleMask`/`outbreakWetness` in WGSL, `puddleMaskAt` on the CPU, `OL.u8.yz`), lightning that lifts the
  shroud for a beat (`Vision.skyFlash`, presentation only) with near strikes on lamps and trees, and rain beds and
  thunder (`audio.ts`). Lab: Backquote › Weather ("Today (always clear)" turns it off), `arcade cmd weather.set
  state=storm|rain|drizzle|clear|cycle`, `arcade cmd weather.flash`, station `outbreak-weather`. Tests:
  `tests/weather-cycle.test.ts`, `tests/weather.test.ts`.
- Anti-aliasing (AR-72, `src/anti-aliasing/`, Lab › Anti-aliasing; values in the view settings): MSAA (today, default),
  TAA, or TAA + upscale from a render scale, on the shared temporal resolve (`@arcade/kit/gpu/temporal`; rules for scene
  passes under it in `../../docs/rendering-techniques.md`). Paired GPU, frame time, walking flicker, ghosting crops,
  stills and a side-by-side clip in one run: `bun scripts/taa-proof.ts --out <dir>` (via `hivemind run --kind browser`).
