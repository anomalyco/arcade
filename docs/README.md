# Docs

Shared notes for every game in this repository. Game-specific notes stay in each game's `AGENTS.md` and its own
docs folder. Start with `AGENTS.md` at the root; it says which of these to read before each kind of work.

## Techniques

- [game-notes.md](game-notes.md): proven techniques for proving changes, rendering, art direction, multiplayer,
  input, feel and audio. Read before rendering, performance, input, multiplayer or feel work; add an entry once a
  technique is proven.
- [netcode.md](netcode.md): how Arcade games hide network latency (client prediction, `OptimisticEvents`, wind-ups,
  adaptive time-stretched `SnapshotBuffer`, `hermite2` + coasting + `Glide`, `RewindHistory`, `RollbackClient`,
  `socketJitter`, and the new-game checklist). Read before any multiplayer or net work.
- [rendering-techniques.md](rendering-techniques.md): catalogue of rendering techniques with have/missing status,
  cost and location. Read before adding lighting, shadows, materials, post-processing or GPU performance work.
- [animation.md](animation.md): rules and measured values for procedural human animation (gait, contacts, arms,
  posture, transitions, weapons) and the known gaps. Read before touching any character's motion.
- [audio-design.md](audio-design.md): the shared audio engine and Audio Lab. Read before changing game sound.
- [sfx-library.md](sfx-library.md): the shared sound library (semantic ids, variants, licences, loudness targets),
  its offline generation and curation pipeline, and Outbreak's positional sound. Read before adding or replacing a
  sound; [sfx-inventory.md](sfx-inventory.md) measures every sound file in the repository.

## Shared code and conventions

- [prototyping.md](prototyping.md): the toy-first workflow (`bun scripts/new-toy.ts <name>`): how to prove game feel
  on `@arcade/kit` primitives and `LabPanel` knobs before building custom meshes, shaders or multiplayer rooms.
- [shared-code.md](shared-code.md): what the games still duplicate and what belongs in `packages/kit/`. Check
  before writing something another game already has.
- [human-rig.md](human-rig.md): API and module ownership of the shared human rig, profiles, attachments,
  detachment and the Characters page. Read before using the rig in a game.
- [controls.md](controls.md): cross-game key bindings and HUD prompts. Read before changing input or prompts.
- [architecture.md](architecture.md): the current engine map (layers, `@arcade/kit` and `@arcade/knobs` areas,
  generated per-game shared-module adoption table, core patterns, and staged roadmap). Read before a cross-game
  refactor.

## Lab and showing Kit

- [lab.md](lab.md): the Lab authoring contract for tunable effects, materials, physics, audio and rendering
  options. Read before adding or tuning any of them.
- [lab-workbench.md](lab-workbench.md): the current Lab shell and its input API.
- [lab-adapters.md](lab-adapters.md): how a game adds Lab sections, material and physics adapters, and spawnables.
- [knobs-requests.md](knobs-requests.md): what Arcade has asked knobs for, and whether a sync has brought it yet.
- [lab-effects.md](lab-effects.md): how to tune Blackout and Getaway effects in the Lab.
- [lab-scenes.md](lab-scenes.md): proposal for focused labs, lab kinds and collections (AR-25), and its data-model spike.
- [dev-control.md](dev-control.md): the `arcade` CLI for driving Kit's open browser tab, tours and pinned notes.
- [dev-hub.md](dev-hub.md): the local Dev Hub that serves every game from one origin.

## Releases and game plans

- [agent-state.md](agent-state.md): live deploy/branch policy (`deploys: on|off`, `allowed_base`, `retired_branches`),
  proof defaults, preview worktree rules, and hot-file contention rules enforced by `scripts/agent-ops.ts` and `pr-guard.yml`.
- [integration.md](integration.md): how to assemble and verify a release integration branch, and the past release
  PRs. Read before merging several feature branches together.
- [zomboid-slice.md](zomboid-slice.md): the plan for Outbreak's co-op survival game.
- [outbreak-coop.md](outbreak-coop.md): how Outbreak's 2–4 player co-op works (rooms, prediction, snapshots) and
  what it measured. Read before changing `shared/coop-sim.ts`, the room or `@arcade/kit/net`.
- [outbreak-world.md](outbreak-world.md): how Outbreak's procedural world generation, chunk streaming, districts,
  POIs, incremental bakes and chunk deltas work.
- [outbreak-progression.md](outbreak-progression.md): Outbreak's inventory (hotbar, the case and bags, containers, drops)
  and the safehouse workbench, built on the `@arcade/kit/sim/ledger` store-and-rule engine. Read before changing
  items, loot, crafting or `shared/progression.ts`.
- [outbreak-way-out.md](outbreak-way-out.md): The Way Out (AR-64), Outbreak's win condition: a hidden seeded
  destination found through clues, a signal, a stand until dawn and the escape card. Read before changing
  `shared/way-out/` or how a run ends.
- [outbreak-interactions.md](outbreak-interactions.md): world interactions (AR-96): throwables (baseballs, bricks,
  rocks, cans, bottles with a wound-up arc), what interactions already existed, and how each is taught. Read before
  adding a way to act on the world.
- [outbreak-difficulty.md](outbreak-difficulty.md): the difficulty-ramp playtest (survivor bots, per-hour probe,
  banded test in `bun run check`, full batch with charts) and how to update its bands. Read before tuning difficulty.
- [outbreak-discovery.md](outbreak-discovery.md): D-19 "Discovered, Not Told": state read from the world instead of
  labels (beam, boards, open containers), and how the squad learns recipes. Read before adding HUD text or recipes.
- [outbreak-strategy.md](outbreak-strategy.md): co-op strategy (AR-99, D-45): what makes survival co-op strategic
  in other games and six ranked systems for Outbreak. Read before adding team mechanics, specials or roles.
- [outbreak-secrets.md](outbreak-secrets.md): the town's unstated backstory and its secrets in three tiers (subtle,
  strange, hidden), with the cellar chain's solution. Spoilers. Read before adding lore, easter eggs or world details.
- [outbreak-onboarding.md](outbreak-onboarding.md): the training room (AR-89): Ash at dawn, wordless beats, skip and
  persistence, solo only.
- [outbreak-hud.md](outbreak-hud.md): Outbreak's character HUD, what other games put on the character, and the defaults.
- [outbreak-map.md](outbreak-map.md): Outbreak's map (N): what it shows, its input, the optional compass ring and
  minimap, and how per-chunk memory and cached tiles keep it cheap in a streamed world.
- [outbreak-art-direction.md](outbreak-art-direction.md): Outbreak's shipped look (Darkwood v8): rules, targets by
  hour, the flashlight spec, what not to do and how to prove a change. Read before touching its shaders, lighting
  or look settings.
- [outbreak-look.md](outbreak-look.md), [outbreak-look-v2.md](outbreak-look-v2.md): Outbreak's look studies.
- [style-playground.md](style-playground.md): the 9-style rendering playground on Outbreak's room sim, measured GPU costs, and full-game scaling verdicts.
- [outbreak-zombie-profile.md](outbreak-zombie-profile.md): Outbreak's zombie art controls on the shared rig.

## Agent skills

- [`procedural-animation-iteration`](../.opencode/skills/procedural-animation-iteration/SKILL.md): the
  measure-first loop and scripts for tuning character animation.
