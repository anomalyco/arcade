# blackout

- After every meaningful change, run `bun run check` then `bun run deploy` so the latest build is live at https://anoma.ly/labs/blackout/.
- WebGPU only runs in secure contexts: test via the deployed URL or `localhost`, never a bare LAN hostname.
- Design and rules live in `docs/design.md`. The simulation in `shared/` runs on both the Durable Object server and the client (prediction and bots); keep it deterministic and free of DOM or Worker APIs.
- Visibility is decided only on the server (`shared/sim/view.ts`, `World.canSee`). Never send hidden players' positions to a client, even dimmed or as ghosts.
- Concept art lives in `concept/` (read `concept/README.md`). Compare screenshots against `concept/dir-a-noir-*.png` and the moment/HUD/menu mockups.
- Screenshots: `bun scripts/shot.ts` drives headless Chromium with WebGPU via playwright-core.
