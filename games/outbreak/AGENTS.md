# Outbreak

- Unlisted prototype: deployed at `/arcade/outbreak/`, accessible by link without login. Keep `noindex`, no landing panel, and no sitemap entry until promoted.
- Simulation lives in `shared/` (deterministic, no DOM or Worker APIs), presentation in `src/`. `shared/coop-sim.ts` is the one
  world simulation: offline `LocalSession` runs it with one survivor, the co-op room (`server/room-core.ts`, Durable Object
  `OutbreakRoom`) with up to four. Survivor actions belong in `CoopSim.stepSurvivor`, shared world updates in `stepWorld`.
  Read `../../docs/outbreak-coop.md` before touching either, the wire protocol or `src/net-session.ts`.
- `shared/build.gen.ts` (gitignored) hashes `shared/`; `bun run check/build/dev` regenerate it. Co-op clients with another hash reload.
- Every adjustable presentation value goes in the shared Lab panel. URL parameters are for session routing and automation only.
- Proof: `bun scripts/prove.ts` from this directory, using headless Metal Chromium; no visible window or audio.
- Sound lives in `src/audio/` and plays the shared library (`../../docs/sfx-library.md`). `SoundDirector` turns `CoopSim`
  state changes into sounds; add a sound there by diffing state, not by adding wire fields or sim events. Never play
  sound audibly in proofs: `bun scripts/prove-audio.ts` (via `hivemind run --kind browser`) uses `--mute-audio`.
- The survivor (`src/survivor.ts`) and zombies (`src/zombies.ts`) use the shared rig's IK, arms and profiles but keep their own stride clocks and terrain support. Motion rules and known gaps: `../../docs/animation.md`. All shared docs: `../../docs/README.md`.
- Rugs and Resident Evil interior themes live in `src/interiors/` (plan, mesh emitters, WGSL, `RugPool`); the rug
  generator and its Worker are in `@arcade/kit/textures`. Lab: Backquote › Rugs & interiors, the Lab's Rugs section and the
  `rugs-interiors` station. Proof: `bun scripts/interiors-proof.ts --phase after` (via `hivemind run --kind browser`).
