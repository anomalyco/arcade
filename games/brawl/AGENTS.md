# brawl

- Unlisted prototype: a top-down hero brawler on the shared engine. Lobby → character select (pick, ready, random) →
  stock round with knockback that grows with damage → results → select again. 2–8 humans per room; bots top a room
  up to `BOT_FILL`. The working name lives only in `GAME` (`shared/config.ts`); rename there.
- The game is thin on purpose. Abilities (`@arcade/kit/sim/abilities`), shoveable props (`sim/props`), bee/boid
  flocks (`sim/boids`), movement (`sim/move`), rooms (`server/*`, `net/room-socket`), the avatar rig, `gpu/boot`
  and `gpu/scene-frame` are kit code. Anything else Blackout already has belongs in the kit too, not copied here.
- A character is one data file in `shared/characters/` (stats and four ability specs: slot 0 LMB, 1 Q, 2 E,
  3 Space dodge) plus its look in `src/looks/roster.ts`. Characters are original parodies: no real names or
  likenesses.
- `shared/world.ts` is the authoritative, deterministic rules (server and practice share it); `shared/view.ts`
  packs snapshots. `src/game/game.ts` interpolates, predicts, turns events into fx and sound and builds the frame.
- `INTENT_OPS` (`shared/world.ts`) says which `Intent` field is a one-shot press (`cast`) for the room's jitter buffer
  (`@arcade/kit/net/room-core`); a new press field must go there too.
- Look: kit `night_ring` preset (`packages/kit/gpu/look.ts`) with `spotlit_ring` as the default arena theme (`src/render/arena-mesh.ts`, alongside `neon_club`, `back_alley` and `party_pop`). Portraits in `public/portraits/` are crops of
  `concept/jpg/05-roster-lineup.jpg`.
- `bun run dev` runs Wrangler (:8790) and Vite (:5195). `bun run check` before pushing; pushing to `main` deploys
  https://anoma.ly/arcade/brawl/.
- URL params (automation only): `?practice` (offline vs bots), `?watch` (bots only, no HUD), `&pick=<id>`,
  `&auto=1` (auto-ready), `&seed=N`, `&bots=N`, `&zoom=N`, `?room=code`. `window.brawl` is the client Game;
  `globalThis.practice` is the offline World.
- Captures: `bun scripts/capture.ts --query "watch&seed=4" --video 25 --out captures/v` against a built `dist`; run
  it through `hivemind run --kind browser`.
