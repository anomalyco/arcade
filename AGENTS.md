# arcade

- Monorepo of independent projects: `landing/`, `redirects/`, `games/blackout/`, `games/getaway/`. Each has its own `AGENTS.md`,
  `package.json`, lockfile and `wrangler.jsonc`. Run `bun install` and `bun run check` inside the project you change.
- Read `docs/game-notes.md` before rendering, performance, input, multiplayer or feel work, and add techniques there
  once they are proven in a game, with where they live and what they measured. `docs/shared-code.md` lists code both
  games duplicate and what to extract into `packages/kit/`; check it before writing something a game already has.
- Everything is served under https://anoma.ly/arcade/. A game owns `/arcade/<name>` and `/arcade/<name>/*`. The landing
  owns only `/arcade`, `/arcade/` and `/arcade/assets/*`. Never add a wildcard `/arcade/*` route.
- Pushing to `main` deploys any project whose folder changed (`.github/workflows/`). Local `bun run deploy` also works.
- Adding a game: put it in `games/<name>`, give its Worker the name `arcade-<name>` with the routes above, set Vite's
  outDir to `dist/arcade/<name>`, strip the `/arcade/<name>` prefix in the Worker, add a workflow, and add a panel to
  `landing/index.html`. If it had an old `anoma.ly/labs/<name>` URL, add it to `redirects/` (GAMES and routes).
