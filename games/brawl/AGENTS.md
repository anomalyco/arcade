# brawl

- Visual work (props, creatures, rooms, lighting, looks): follow [quality-checklist.md](../../docs/quality-checklist.md)
  and the `arcade-quality` skill.
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

## Game shell

- The title, lobby, Escape menu and Settings are the kit game shell (`@arcade/kit/shell`, [docs/game-shell.md](../../docs/game-shell.md)), set up in `src/main.ts`. The roster parade and Watch the bots sit in its title slot (`titleArt` in `src/ui/menus.ts`); the character select and results stay Brawl's own room screens. Shell colours are at the end of `src/style.css`.
- Deliberate changes when it moved onto the shell (Oct 22):
  - The landing page is the shell's title: name, Quick play, Practice vs bots, Play with friends (a private room) and
    Join by code or invite link, with Settings and mute in the corner. An invite link shows "Join room CODE" first.
  - Escape opens the menu (Resume, Settings, Leave room or Quit to title). Practice pauses behind it; a room keeps
    playing. Leave returns to the title with the bots playing behind it.
  - M mutes from the shell (the old `brawl.muted` is read once); Settings has Master and Effects. Quality is in
    Settings, not the Lab's View group, and uses the slow-frames policy.
  - Connection problems show in the shell's reconnect pill; the HUD keeps only the idle warning.
  - Gameplay keys are ignored on the title and the menu.