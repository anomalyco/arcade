# Docs

Shared notes for every game in this repository. Game-specific notes stay in each game's `AGENTS.md` and its own
docs folder. Start with `AGENTS.md` at the root; it says which of these to read before each kind of work.

## Techniques

- [game-notes.md](game-notes.md): proven techniques for proving changes, rendering, art direction, multiplayer,
  input, feel and audio. Read before rendering, performance, input, multiplayer or feel work; add an entry once a
  technique is proven.
- [rendering-techniques.md](rendering-techniques.md): catalogue of rendering techniques with have/missing status,
  cost and location. Read before adding lighting, shadows, materials, post-processing or GPU performance work.
- [animation.md](animation.md): rules and measured values for procedural human animation (gait, contacts, arms,
  posture, transitions, weapons) and the known gaps. Read before touching any character's motion.
- [audio-design.md](audio-design.md): the shared audio engine and Audio Lab. Read before changing game sound.
- [sfx-library.md](sfx-library.md): the shared sound library (semantic ids, variants, licences, loudness targets),
  its offline generation and curation pipeline, and Outbreak's positional sound. Read before adding or replacing a
  sound; [sfx-inventory.md](sfx-inventory.md) measures every sound file in the repository.

## Shared code and conventions

- [shared-code.md](shared-code.md): what the games duplicate and what belongs in `packages/kit/`. Check before
  writing something another game already has.
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
- [lab-effects.md](lab-effects.md): how to tune Blackout and Getaway effects in the Lab.
- [dev-control.md](dev-control.md): the `arcade` CLI for driving Kit's open browser tab, tours and pinned notes.
- [dev-hub.md](dev-hub.md): the local Dev Hub that serves every game from one origin.

## Releases and game plans

- [integration.md](integration.md): how the release integration branch was assembled and verified. Read before
  merging several feature branches together.
- [zomboid-slice.md](zomboid-slice.md): the plan for Outbreak's co-op survival game.
- [outbreak-coop.md](outbreak-coop.md): how Outbreak's 2–4 player co-op works (rooms, prediction, snapshots) and
  what it measured. Read before changing `shared/coop-sim.ts`, the room or `@arcade/kit/net`.
- [outbreak-world.md](outbreak-world.md): how Outbreak's procedural world generation, chunk streaming, districts,
  POIs, incremental bakes and chunk deltas work.
- [outbreak-progression.md](outbreak-progression.md): Outbreak's inventory (hotbar, belt, pack, containers, drops)
  and the safehouse workbench, built on the `@arcade/kit/sim/ledger` store-and-rule engine. Read before changing
  items, loot, crafting or `shared/progression.ts`.
- [outbreak-hud.md](outbreak-hud.md): Outbreak's character HUD, what other games put on the character, and the defaults.
- [outbreak-look.md](outbreak-look.md), [outbreak-look-v2.md](outbreak-look-v2.md): Outbreak's look studies.
- [style-playground.md](style-playground.md): the 9-style rendering playground on Outbreak's room sim, measured GPU costs, and full-game scaling verdicts.
- [outbreak-zombie-profile.md](outbreak-zombie-profile.md): Outbreak's zombie art controls on the shared rig.

## Agent skills

- [`procedural-animation-iteration`](../.opencode/skills/procedural-animation-iteration/SKILL.md): the
  measure-first loop and scripts for tuning character animation.
