# Outbreak

- Unlisted prototype: deployed at `/arcade/outbreak/`, accessible by link without login. Keep `noindex`, no landing panel, and no sitemap entry until promoted.
- Simulation lives in `shared/` (deterministic, no DOM or Worker APIs), presentation in `src/`. `shared/coop-sim.ts` is the one
  world simulation: offline `LocalSession` runs it with one survivor, the co-op room (`server/room-core.ts`, Durable Object
  `OutbreakRoom`) with up to six. Read `../../docs/outbreak-coop.md` before touching the sim, the wire protocol or
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
  until someone walks up and the machine answers, smoke alarms chirping on dying batteries for three nights, open
  doors creaking on gusts. Outside: rain on cars, puddles and leaves, gutters after rain, porch chimes on gusts,
  insects by day, a dawn chorus that grows each night, street lamps humming (dying sodium ones stutter), neon buzzing,
  dispatch calling the abandoned cruisers (fewer calls each night, then none), shop alarm bells running down. Distance: sirens and other survivors' gunfire that thin out each night and
  stop (the last sirens wind down mid-wail, the fourth night's shots are three and then one), a far car alarm, an owl
  from night 2, a church bell striking the hours for the blocks around it (thirteen at midnight on night 3). Seeded on
  town seed and sim time; presentation only (nothing reaches zombie hearing). Other features ask for sounds through
  `soundscape/hooks.ts` (`playAmbientSound`, `holdAmbientSound`, `registerAmbientSound`); ready for them: `scape.tv`,
  `scape.life.rustle|scurry|hooves`, `scape.habit.knock|pans|bedsprings|fence|dance`, `scape.secret.*`. Two features
  are heard from the audio side, reading their pure placements: life (`soundscape/life.ts`: the dawn sprinkler, washing
  snapping on gusts, door-open chimes that sag with the dome light's battery, animals bolting) and the secrets
  (`soundscape/secrets.ts`: stopped clocks ticking each second at their stuck mark, the radio man's set hissing and
  beeping once per lit pulse, the padlock's dial clicks and the unlock and hatch from the ledger, and the 3 AM message
  repeating his number via `ScapeInput.machineCount`). Don't also call the hooks for those.
  Listening reel and loudness: `bun scripts/soundscape-reel.ts` (offline, never plays). Tests: `tests/soundscape.test.ts`,
  `tests/soundscape-secrets.test.ts`.
- Weapon sounds (AR-102, `src/audio/weapons/`, Lab: Backquote › Sound › Weapons, "Today (shared pistol, 3 melee
  hits)" one setting away, a toggle per weapon): procedural and zero-asset like the soundscape, baked per sound in a
  Worker on first use (`bank.ts`; each event carries Today's sound as `fallback` until then), round-robin takes plus
  pitch/level jitter, every take baked to a LUFS target (`level.ts`). A report is its near layers (action, crack,
  punch, thump), the tail of where it rang (`weaponSpace`: room, alley slapback, street, open) and its far version,
  crossfaded by the listener's distance so teammates sound right down the street. Also: draw sounds, the pistol's
  staged reload with the magazine clattering down, dry-fire, brass by floor, a swing per melee weapon, hits as flesh
  + the weapon's own layer + bone (metal tools keep the library's ringing `melee.hit.metal` as the heavy/head-hit
  bell), wall and door misses, bullet impacts by surface, the flare gun's break-open reload, flamethrower, molotov,
  dynamite (near, tail, far), firecrackers, bear traps and thrown things (AR-96). `SoundDirector.weapons` and
  `InventorySounds.weapons` call it; nothing reaches zombie hearing. Reel and loudness: `bun scripts/weapon-reel.ts`;
  per-sound stats: `bun scripts/weapon-sounds-stats.ts` (offline, never play). Credits: `src/audio/weapons/CREDITS.md`.
  Tests: `tests/weapon-sounds.test.ts`.
- The survivor (`src/survivor.ts`) steps on the shared rig's contact solver (`locomotion` + `poseLegs`, terrain added per foot; Lab › Survivor strafe › Legs › Today is its old stride clock) and zombies (`src/zombies.ts`) use the shared rig's IK, arms and profiles with their own stride clock and terrain support. WASD leg metrics: `games/blackout/scripts/animation/survivor-legs.ts`. Motion rules and known gaps: `../../docs/animation.md`. All shared docs: `../../docs/README.md`.
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
  Today): moths circling lit fixtures (`swarms.ts`, glow from the frame's `lampPower`; at a porch they flutter at the
  canopy edge, since the bulb on the wall is under the roof and out of the camera's sight), flies over bodies and bins seen
  only in light, eyes at the edge of yard trees (south of the crown, where the camera sees) that catch the torch and bolt plus one rare pair from night 2 that does not
  (`eyeshine.ts`), breath in the cold over the torch (`breath.ts`, lit by the lens's spill, `BeamProbe.near`). All are renderer alpha/additive sprites (in the TAA reactive
  mask) lit on the CPU by `BeamProbe` (`light-probe.ts`) from the frame's torch slots. Leftover life (`leftovers.ts`,
  `sprinkler.ts`): washing on lines in the side yards (or well behind the house: the roof hides the near back yard)
  swinging with the gust field, parked cars (still where they spawned,
  empty) left with a door open and a dome light that dies over nights 2–4, a front-lawn sprinkler on a 06:36–07:18
  timer losing pressure daily, brass from every shot that stays where it fell (seeded from the shot), and televisions
  and lit windows that go dark house by house when that house loses power, the hour its fridge stops humming in the
  soundscape (`housePlan(...).powerLoss`, `DetailsPresenter.powered`, `setWindowPower` in `look/lit-windows.ts`)
  ("Town runs down night by night"; the night is `townNight`: the Way Out's shared count, else the night ramp's).
  Weather traces: rings from eave and tree drips that keep falling after the rain and fade as the ground dries
  (`drips.ts`, from the weather's wetness and rain), and wet prints behind anyone walking out of a puddle or wet
  grass that dry in 45 s outdoors (on wet ground only mud shows, and puddles rinse it off), the dead's shuffling with
  one foot dragged into a smear (`prints.ts`). Stills of each touch by day and night, a contact sheet, a rain-night clip
  and paired GPU: `bun scripts/life-stills.ts --out <dir>` (via `hivemind run --kind browser`); Lab station
  `outbreak-details` › Life and the "Porch moths" / "After the rain" shots. Tests: `tests/details.test.ts`,
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
  `world/scene-level.ts`, sent to the world Worker, part of every level/chunk cache key). Yard plants stay out of houses
  (`vegetation/indoors.ts`): stems keep 0.5 m (trees) or 0.2 m (shrubs) off walls and porches, leaves and limbs below
  the wall tops inside a footprint are trimmed off, and a crown leaning over a roof goes in that house's own "outside"
  chunk, skipped while you are inside like the roof (the level's solid pass never runs the cutaway's discards); test:
  `tests/trees-indoors.test.ts`. Stills, wind clips and paired
  GPU: `bun scripts/vegetation-stills.ts --clip --gpu` (via `hivemind run --kind browser`). Tree look (D-41/D-42, AR-74,
  Lively only; C is the default, Today one setting away): A Deadwood, B Fluffy, C Darkwood from
  `@arcade/kit/gpu/foliage-looks`, dispatched by `plant()`; "Blighted trees" (default 25%) gives a seeded share of C
  trees Deadwood's limbs with withered clumps or none. A and C sink to near-black grey outside light in
  `outbreakTreeSurface` (`src/vegetation/trees.ts`), take their colour in the torch beam, and bake long moon shadows. Burning trees are a shader hook for the fire feature: `setTreeBurnSource((treeIdAt(x, z)) =>
  0..1)`, plus `setFoliageBurnSpots` for burning and scorched ground that chars shrubs (negative-radius entries in the
  same eight `vegBurn` slots, after the trees). Fence hedges are lit boxes, not foliage, and don't char. Stills, night clips and paired GPU per look: `bun scripts/tree-looks-stills.ts --clip --gpu`.
- The look (survivor style, grade, lamps and sky as trims on the day cycle, curated presets) lives in `src/look/`;
  Lab: Backquote › Look · Presets/Hero/Grade/Lights and the `outbreak-look` lab. The look's contract is
  `../../docs/outbreak-art-direction.md`; beauty stills, flicker and paired GPU: `bun scripts/look-beauty.ts`. Stills: `bun scripts/look-stills.ts`
  (via `hivemind run --kind browser`). Defaults stay today's look until Kit picks. Soft Bean (Hero › Survivor style) has
  its own shape, colour and surface knobs; stills and paired GPU cost: `bun scripts/bean-stills.ts`.
- Character shadows (AR-113, `src/soft-shadows/`, Lab: Backquote › Look · Character shadows, on by default
  since D-48, "Today" = `softShadowMode` 0): soft capsule shadows from the rig's bones for survivors, zombies, the downed and the dead (kit
  `@arcade/kit/gpu/shadows/capsule-shadows`): a contact shadow plus one per strong nearby light and the sun or moon.
  Presenters note bodies (`forEachDrawnBody`, `forEachDrawnRig`, `noteLyingBody`); `scene/frame-renderer.ts` packs them.
  Stills: `bun scripts/soft-shadows-stills.ts --out <dir>` (via `hivemind run --kind browser`); paired GPU:
  `AB_A='{"softShadowMode":0}' AB_B='{"softShadowMode":1}' bun scripts/ab-gpu.ts`. Tests: `tests/soft-shadows.test.ts`.
- Reflections (AR-73, `src/reflections/`, Lab: Backquote › Look · Reflections, "Today" = `reflections` 0): lamps,
  lit windows, fire, police lights and headlights mirrored analytically in standing water and wet paving (the CPU picks
  up to 8 outdoor lights per frame into `OL.reflLights`; the street potholes always hold water, the weather's puddle
  mask or the Lab's wetness adds pools), and leaning, foxed floor mirrors whose glass computes its own reflection
  (floor, flashlight, people in front). Ash always has one beside the bedroom door, facing the living room; other
  houses 14 %, some cracked. Placement is `mirrorSpot` in `src/interiors/mesh.ts` (its footprint keeps props and
  details off). Stills and paired GPU: `bun scripts/reflections-stills.ts` (via `hivemind run --kind browser`). Tests:
  `tests/reflections.test.ts`.
- Bounced light (AR-115, D-47, `src/bounce-light/`, Lab: Backquote › Bounced light, on at ×3 by default, "Today (off)" one setting away):
  one bounce of the frame's lights (fire, torches, muzzle flashes, lamps, lit windows) in plan space through the kit's
  `@arcade/kit/gpu/gi/plan-bounce`, held by walls, added through the scene's `bounce` hook and counted as light by the
  colour rule (`outbreakGiIrr`). The feature sets `FrameInput.planBounce` from the `frame.render` hook; off, or a frame
  with no lights (daylight), skips every pass. Stills, sheet and a hall-sweep clip: `bun scripts/bounce-stills.ts --out <dir> --clip`; paired GPU:
  `AB_B='{"bouncedLight":1}' bun scripts/ab-gpu.ts` (both via `hivemind run --kind browser`). Tests:
  `tests/bounce-light.test.ts`, `packages/kit/gpu/gi/plan-bounce.test.ts`.
- Lot ports (AR-124, Lab: Backquote › Look · Street lamps / Low mist / Contact shadows / Lit rooms, each "Today" one
  setting away, on by default since D-49–D-52, the mist and contact shadows per quality tier; the CI smoke's `?smoke` keeps the mist and contact shadows at Today
  so SwiftShader compiles neither): lens street lamps (`src/street-lamps/`, cone.w ≥ 7 in the light slots; the scene,
  bounce, contact-shadow, dust and reflection readers all know it), low mist pooled against walls, in yard hollows and
  gutter pockets on the kit fog bank (`src/mist/`, shared volume slot 2 with the lamp fog, set up in
  `air/lamp-fog.ts`), screen-space contact shadows (`src/contact-shadows/`, volume slot 0) and rooms behind lit windows
  (`src/window-rooms/`, the glass in `shaders.ts`). Stills: `bun scripts/look-ports-stills.ts --out <dir>`; paired GPU:
  `AB_A='{"mistStyle":0}' AB_B='{"mistStyle":1}' bun scripts/ab-gpu.ts` (Lab values persist between variants, so A
  must name every key B sets; both via `hivemind run --kind browser`). Tests: `tests/look-ports.test.ts`.
- Quality tiers (`src/quality.ts`, `OUTBREAK_QUALITY_PROFILES` over the kit's): besides resolution and bloom, each tier
  sets the mist (on, 1/n resolution), contact shadows (on, lights × steps), the bounce grid and soft-shadow lights. High
  is Kit's picks, Balanced the measured cut, Low turns off the mist and contact shadows. Those Lab settings default to
  "Quality tier" (`QUALITY_TIER`, -1), resolved each frame in `scene/frame-renderer.ts` (`resolveMist`,
  `resolveContactShadows`, and `ctx.quality` for bounce and soft shadows); any explicit Lab value wins. What Auto picks
  on a machine: `AQ_VIEWPORT=1920x1000 AQ_DPR=2 bun scripts/auto-quality.ts --out <dir>` (via `hivemind run --kind
  browser`; GPU per tier and scale, a controller replay, and High vs Auto stills at the crossroads).
- Special zombies (Runner, Brute, Screamer, Bloater, Riot cop, Lurker) live in `shared/specials/` (kinds, rarity and
  stats in `kinds.ts`, behaviours in `specials.ts`) and `src/specials/` (silhouettes and accessories drawn by
  `src/zombies.ts`, gas cloud, Lab). The kind is encoded in the zombie's seed, so clients read it with
  `specialKindOf(seed)`. Lab: Backquote › Specials (rarity, stats, "Spawn <kind> ahead"); `arcade cmd specials.spawn
  kind=brute`. Sounds: `src/audio/specials.ts`. Tests: `tests/specials.test.ts`.
- Characters (AR-88, `shared/characters/`, `src/characters/`, Lab: Backquote › Characters, "Today" = `chStyle` 0,
  station `outbreak-characters`, `arcade cmd characters.stage scene=callings|knock|stove|bed|fence|wedding|leash`): the
  dead hint at who they were. Callings come from the seed (`callingIndex`: the six Townsfolk outfits plus mail carrier,
  jogger, bathrobe with one slipper, night guard, courier, bride, groom; meshes in `src/look/refined-figure.ts`), clothes
  and skin by days since turning (`turnedAgo`). Habit loops: `habitSites(town)` (knocking from inside its own shut front
  door, a cold stove, over a bed, tangled in a fence, slow-dancing bride and groom at the church) is a pure function of
  the town; the sim pins a fresh, unaware wanderer to a free site out of everyone's reach (never closer to a survivor
  than it was), re-picks its seed to the site's calling, dulls its senses while it is lost in the habit and gives it a
  beat to let go once it notices. Clients play the habit on any still, wandering zombie standing on a site, so nothing
  is on the wire. The renderer adds empty dog leads, heads turning to noises and a flinch from the torch
  (`src/zombies.ts`, from `characterFrame`). Sounds (`src/characters/sounds.ts`, through the
  soundscape's hooks): each habit's cue once a cycle (the knock's hand is timed to `scape.habit.knock`), the waltz at
  the dancing couple, joggers' earbuds leaking a tinny loop. A porch body with its car in the drive carries the keys (`shared/bodies/bodies.ts`).
  Contact sheet of every calling and habit: `bun scripts/characters-sheet.ts` (via `hivemind run --kind browser`).
  Tests: `tests/characters.test.ts`.
- Zombie behaviour (AR-91, `shared/behaviour/`, `src/behaviour/`): each zombie's personality comes from its seed
  (`personality.ts`) and shapes what it does on top of the crowd's state machine (`mind.ts`): stop and listen, follow
  the one that noticed, remember and search (peering in at the house you went into, then giving up slowly), rest by
  day, herd and gather under lamps at night, feed on bodies, climb fences and car bonnets, flinch from the beam,
  freeze in lightning, pause. It drives the crowd through the `agentSpeed`/`agentSenses` hooks in
  `@arcade/kit/sim/ai` (`ai.behaviour` in `shared/ai.ts`) and only activity codes go on the wire (bit 4096). Other
  features read `zombieActivity(sim, id)` / `zombieAttention(sim, id)` ("noticed", "searching", "lost interest", …).
  Presentation: `src/behaviour/pose.ts` bends the shamble per personality (100STYLE zombie cadence, arms out) and per
  activity; the overlay labels each zombie. Lab: Backquote › Zombie behaviour ("Today" = off), `arcade cmd
  behaviour.stage scene=…`, station `outbreak-zombie-behaviour`. Trace: `bun scripts/behaviour-trace.ts`. Tests:
  `tests/behaviour.test.ts`, `tests/coop-behaviour-parity.test.ts`.
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
  "pop", and scorch is kit decals. Second pass: hot inner tongues and a warm `glow` halo (kit kind 9) per source, an
  uneven flicker, Karis-weighted first bloom downsample (`bloomKaris`) so embers don't flash bloom tiles; fire light is
  capsules (`LIGHT_CAPSULE`, kit `lightSum`) along the jet, a body, a fire or a tree. Trees catch (`tree:<k>` ring:
  ground fire at the trunk, the stream, burning dead, blasts), burn `treeBurnSeconds`, drop small fires, may jump to a
  neighbour, and stand bare and charred for good. Lab › Fire & explosives look › Fire style 0 is Today's analytic
  sprites, Fire light shape 0 Today's points. Lab:
  Backquote › Fire & explosives, `arcade cmd fire.stage scene=…`, station `outbreak-fire`. Items, loot and recipes:
  `../../docs/outbreak-progression.md#fire--explosives-ar-62`. Tests: `tests/fire.test.ts`.
- The air (AR-68, `src/air/`): world smoke from manholes, storm drains, smouldering cars, wrecks and chimneys
  (`air/smoke.ts`, placement a pure function of the town and `smokeSeed`, nearest 14 sources within 30 m) and dust in
  the light (`air/dust.ts`: style 2 backlit motes on a curl-noise current, only in the beam and the nearest lamps and
  fires the CPU picks; style 1 AR-68's soft motes). Smoke and the kit fire share one kit particle pool in `scene/fx-particles.ts`,
  drawn by the kit renderer's `fxParticles` path and lit only by the beam (a plan-cone spot) and the strongest lamps
  and fire lights, so smoke is dark until a light finds it. Lab › World smoke / Beam dust (0 is Today), `arcade cmd
  air.stage scene=steam|car`, station `outbreak-fire` › Smoke & dust. Tests: `tests/air.test.ts`.
- The Way Out (AR-64): a seeded far-off destination found through three tiers of clues, reached by car (gas cans
  only, hotwire with a toolbox, roadblocks cleared by dynamite or bolt cutters), a signal, a stand until dawn and the
  escape card, in `shared/way-out/` (all state in the `wayout` ledger store, nothing on the wire) and
  `src/way-out/`. Lab: Backquote › Way Out (Off = endless survival), `arcade cmd wayout.*`, station
  `outbreak-way-out`. How it works: `../../docs/outbreak-way-out.md`. Tests: `tests/way-out.test.ts`.
- World interactions (AR-96, `shared/interactions/`, `src/interactions/`, Lab: Backquote › Interactions, each "Today"
  one setting away, station `outbreak-interactions`, `arcade cmd interactions.stage scene=…`): throwables (baseballs,
  bricks, rocks, tin cans, bottles) found in yards and on floors, held Mouse0 to wind up with an arc preview, released
  to throw; they bonk, stagger, break windows, jolt car alarms and are heard where they land. Loose furniture dragged
  with E and braced against doors and windows (the crowd's `ai.portalHolds` hook), downed teammates hauled (tap E),
  and a `movementScale` feature hook for the slow walk (`survivorObstacles` lets bots path round the pieces). One B
  boards an opening up all the way; Hold E pries a board off (`boards.ts`, ledger rule `unboard`). Ledger stores only
  (`toss:*`, `drop:t:*`, `drop:v:yard:*`, `furn:*`, `haul:*`). How it works and the inventory of every interaction:
  `../../docs/outbreak-interactions.md`. Tests: `tests/interactions-throwables.test.ts`, `tests/interactions-drag.test.ts`,
  `tests/interactions-boards.test.ts`.
- Secrets (AR-85): subtle, strange and hidden touches picked per run from `town.seed`/`houseSeed` (`shared/secrets/`:
  `select.ts` picks and the run's code, `hosts.ts` the one-house hosts, `places.ts` where each piece stands; the
  cellar lock is the shared `secret:cellar` ledger store, nothing on the wire) and drawn by `src/secrets/` (pieces,
  apparitions, glances, the card tally and per-browser memory). Spoilers and the solution: `../../docs/outbreak-secrets.md`;
  keep it in sync. Lab › Secrets (Today = off, per-secret toggles, rarity, force), `arcade cmd secrets.stage
  secret=<scene>`, station `outbreak-secrets`. Tests: `tests/secrets.test.ts`, `tests/coop-secrets.test.ts`.
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
  passes under it in `../../docs/rendering-techniques.md`; what moves on its own draws into the reactive mask: flying
  breach debris, throws and dynamite are `reactive` batches, beam dust a `drawReactive` pass; Restart, New town and
  regenerate drop the history in `scene/frame-renderer.ts`). Paired GPU, frame time, walking flicker, ghosting crops,
  stills and a side-by-side clip in one run: `bun scripts/taa-proof.ts --out <dir>` (via `hivemind run --kind browser`).
- Motion stability (AR-123): `bun scripts/motion.ts` (via `hivemind run --kind browser`, one job per path under the
  30-minute cap: `MOTION_PATHS=street`) scores pops per frame after depth reprojection on scripted walks and pans
  (street, lamps, rain, pan-lamps, pan-wet, pan-rain, indoor, indoor-lamps) against each path held still, per Lab
  variant (`MOTION_VARIANTS=base,before,…`), with pop maps and `MOTION_RECORD` frames for clips. Fixes so far: lamp
  pools fade across their cull distance (Lab › Anti-aliasing › Motion stability › Lamp reach fade, 0 = Today) and LEAN
  puddle glints (Look · Reflections › Glint anti-aliasing, 0 = Today). Numbers: `../../docs/game-notes.md`.
- Prompt clarity (AR-89, `src/prompt-clarity/`, Lab: Backquote › Controls, "Today" one setting away): verbs beside
  glyphs for each action's first three uses, corner brackets on what E acts on, B (board up) and board pips in door
  and window prompts (B boards the prompt's target), a glyph stamp after a door, window, barricade or container
  changes, and facing weighs more in picking the target. How and why: `../../docs/outbreak-hud.md#prompt-clarity-ar-89`,
  key rules in `../../docs/controls.md`. Tests: `tests/prompt-clarity.test.ts`.
- Combat oomph and body physics (AR-90, `src/impact/`, Lab: Backquote › Feel "Impact" Today / Physical and › Physics,
  station `outbreak-impact`, `arcade cmd impact.stage scene=melee|pistol|blast|car`): directional hit reactions on the
  living (`@arcade/kit/avatar/hit-reaction`) and ragdoll deaths started from the exact pose drawn on the frame of death
  (`@arcade/kit/avatar/bone-ragdoll`), pushed by the killing blow; blasts and cars push bodies already down; hit-stop
  and shake scale by weapon weight (`weaponWeight`, knife 0.6 → fire axe 1.37). `ImpactBodies` plugs into
  `ZombieCrowdRenderer.physics`; blows are a pure function of the replicated shot, swing, vehicle-hit and blast events
  (`causes.ts`), so nothing is on the wire and the sim never reads it. Tests: `tests/impact.test.ts`; deterministic
  clips: `bun scripts/feel-clips.ts oomph` (via `hivemind run --kind browser`).
- Door breaches (AR-97, `shared/breach/` rules + wire bit 8192, `src/breach/` presentation, Lab: Backquote › Doors &
  barricades, "Today" one setting away, station `outbreak-breach`, `arcade cmd breach.stage scene=…`): readable wear
  (cracks by stage, hinges and lock, bowing, light through gaps, crowd-scaled noise, punched panels with grabbing
  arms), bracing, a 1.1 s warning beat, breach kinds (hinges, split, crush, boards, window burst) with a staggered
  spill, and broken doors that can only be barricaded or wedged back with their fallen slab. Hooks for other features:
  `registerBraceSource`, `recentBreaches`, `portalWear`; the AI reads it through `bashRules` in `shared/ai.ts`. The
  damaged leaf is drawn by `src/world/door-leaf.ts` (`setDoorLeafOverride`). How it works:
  `../../docs/outbreak-discovery.md#door-breaches-ar-97`. Tests: `tests/breach.test.ts`; clip: `bun scripts/breach-clip.ts`.
- Inventory (AR-94, D-46 the Attaché Case): the case is the `pack` grid store (kit ledger `grid`), item shapes, stacks
  and bags are `shared/progression/shapes.ts`, `shared/inventory-ops/` is the `inv` command (place, turn, swap, drop,
  give; ledger transactions only) and `src/inventory/` draws what Tab opens, reaching the central input and HUD only
  through `src/inventory/hooks.ts`. Item portraits: `bun scripts/item-portraits.ts` (a new item needs a line there and a
  shape). How it works: `../../docs/outbreak-hud.md#the-attaché-case-ar-94-d-46`. Proof: `bun
  scripts/attache-case-proof.ts` (via `hivemind run --kind browser`). Tests: `tests/inventory-ops.test.ts`,
  `tests/inventory-styles.test.ts`, `packages/kit/sim/ledger-grid.test.ts`.
- Lobby practice and the training room (AR-89, `shared/onboarding/`, `src/onboarding/`, Lab: Backquote › Onboarding,
  station `outbreak-onboarding`): while the lobby is open (solo or a room filling) you play in Ash at dawn in your own
  local session with the kit you picked (swapped live), wordless hints, a chained target that comes back; the lobby
  docks left and keeps only Enter. `CoopView.net` reads null meanwhile, so nothing reaches the room. The guided
  training room before a solo run is one setting away (Off by default). The shared feature is inert unless staged.
  `../../docs/outbreak-onboarding.md`. Tests: `tests/training-room.test.ts`; proof: `bun scripts/lobby-practice-proof.ts`.

## Game shell

- The Escape menu and Settings are the kit game shell (`@arcade/kit/shell`, [docs/game-shell.md](../../docs/game-shell.md)), set up in `src/main.ts`. Outbreak's lobby (`src/lobby/lobby-ui.ts`: the start screen over the practice space, survivor and kit picks, the co-op muster with ready and start) stays its title and lobby, so the shell starts in play and never draws its own title card. The seed and restart tools are the shell's pause slot (`src/lobby/run-tools.ts`). Shell colours are at the end of `src/style.css`.
- Deliberate changes when it moved onto the shell (Oct 22):
  - Escape opens the menu (Resume, the run's seed with Copy replay link and Play seed, Restart, New town, Lobby,
    Settings) when no bag, map, radial or lobby is open; before, only the HUD's Pause button opened it. Solo, it stops
    the night as the old pause menu did; in a room it offers Leave room and the room keeps running.
  - The speaker button opens Settings (Master, Effects, Ambience, Zombies, Mute, Quality, Reduce camera motion, Key
    labels) instead of its own slider panel (`src/volume/menu.ts`, removed). Closing Settings plays on. The Lab's
    Volume rows stay and stay in step with Settings. M is still the map; with Backquote › Controls giving it to mute,
    the shell mutes. The mute is carried over from `outbreak.audio` once (`arcade.mute.outbreak.v1`).
  - Quality uses the shell's slow-frames policy (Auto starts High and steps down only on slow frames) and is saved per
    game as `arcade.quality.outbreak.v1` (the old shared `arcade.quality.v1` is read when that is empty).
  - Reduce camera motion in Settings sets the camera's Reduce motion.
  - The leave-site prompt stays Outbreak's (`src/controls`); the shell's menu counts as a menu there.
