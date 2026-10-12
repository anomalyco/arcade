# arcade

- Monorepo of independent projects: `landing/`, `games/blackout/`, `games/getaway/`. Each has its own `AGENTS.md`,
  `package.json`, lockfile and `wrangler.jsonc`. Run `bun install` and `bun run check` inside the project you change.
- Everything is served under https://anoma.ly/arcade/. A game owns `/arcade/<name>` and `/arcade/<name>/*`. The landing
  owns only `/arcade`, `/arcade/` and `/arcade/assets/*`. Never add a wildcard `/arcade/*` route.
- Pushing to `main` deploys any project whose folder changed (`.github/workflows/`). Local `bun run deploy` also works.
- Adding a game: put it in `games/<name>`, give its Worker the name `arcade-<name>` with the routes above, set Vite's
  outDir to `dist/arcade/<name>`, strip the `/arcade/<name>` prefix in the Worker, add a workflow, and add a panel to
  `landing/index.html`.
