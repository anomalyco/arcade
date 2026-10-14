# Outbreak

- Unlisted prototype: deployed at `/arcade/outbreak/`, accessible by link without login. Keep `noindex`, no landing panel, and no sitemap entry until promoted.
- M1 is local-only. Keep simulation in `shared/`, presentation in `src/`, and the Session boundary ready for later network snapshots.
- Every adjustable presentation value goes in the shared Lab panel. URL parameters are for session routing and automation only.
- Proof: `bun scripts/prove.ts` from this directory, using headless Metal Chromium; no visible window or audio.
- The survivor (`src/survivor.ts`) and zombies (`src/zombies.ts`) use the shared rig's IK, arms and profiles but keep their own stride clocks and terrain support. Motion rules and known gaps: `../../docs/animation.md`. All shared docs: `../../docs/README.md`.
