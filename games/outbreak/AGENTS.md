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
- `bun scripts/check-cycles.ts` (part of `bun run check`) fails on any import cycle between Outbreak modules, type
  imports included.
- Sound lives in `src/audio/` and plays the shared library (`../../docs/sfx-library.md`). `SoundDirector` turns `CoopSim`
  state changes into sounds; add a sound there by diffing state, not by adding wire fields or sim events. Never play
  sound audibly in proofs: `bun scripts/prove-audio.ts` (via `hivemind run --kind browser`) uses `--mute-audio`.
- The survivor (`src/survivor.ts`) and zombies (`src/zombies.ts`) use the shared rig's IK, arms and profiles but keep their own stride clocks and terrain support. Motion rules and known gaps: `../../docs/animation.md`. All shared docs: `../../docs/README.md`.
- Rugs and Resident Evil interior themes live in `src/interiors/` (plan, mesh emitters, WGSL, `RugPool`); the rug
  generator and its Worker are in `@arcade/kit/textures`. Lab: Backquote › Rugs & interiors, the Lab's Rugs section and the
  `rugs-interiors` station. Proof: `bun scripts/interiors-proof.ts --phase after` (via `hivemind run --kind browser`).
- Generated furniture (`@arcade/kit/props`, pipeline in `scripts/props/README.md`) furnishes the start block's houses
  from `src/props/`: anchors replace the gameplay furniture's boxes one for one (collisions stay `PROP_SHAPES`), and
  clutter is client-only. The level bake reads the same plan through `propDressingState`: floor clutter over 0.3 m
  is grounded like furniture (`propFloorFootprints`), and table lamps bake pools (`propLamps`), with shades glowing on
  `TABLE_LAMP_SLOT`. On by default; Lab: Backquote › Props ("Furnish start houses") and the Lab's `props` station.
  Stills and paired GPU cost: `bun scripts/props-stills.ts` (via `hivemind run --kind browser`).
- The look (survivor style, grade, lamps and sky as trims on the day cycle, curated presets) lives in `src/look/`;
  Lab: Backquote › Look · Presets/Hero/Grade/Lights and the `outbreak-look` lab. Stills: `bun scripts/look-stills.ts`
  (via `hivemind run --kind browser`). Defaults stay today's look until Kit picks.
- Driving FX (skid marks, tyre smoke/dust, screech) come from per-wheel slip in `src/vehicles.ts` via `@arcade/kit/vehicle/slip`
  and `@arcade/kit/fx/skids`; Lab › Driving FX and the `outbreak-vehicles` station's drift/burnout variants. Proof:
  `bun scripts/prove-driving-fx.ts` (via `hivemind run --kind browser --fetch captures/driving-fx`).
