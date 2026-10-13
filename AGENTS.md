# arcade

- Bun workspace: `games/blackout/`, `games/getaway/` and `packages/*` share the root `bun.lock`. Run
  `bun install --frozen-lockfile` at the root, `bun run check:packages`, then `bun run check` inside each affected game.
  `bunfig.toml` selects hoisted dependencies for shared tooling and historical benchmark exports. Keep Vite, Wrangler,
  TypeScript and Playwright versions aligned across the two games. `landing/`, `redirects/` and `games/wings/` are
  independent projects with their own lockfiles and install/check commands; do not add them to the workspace implicitly.
- `packages/kit/` is the private, versionless `@arcade/kit` source package. Import subpaths such as
  `@arcade/kit/lab-panel` and `@arcade/kit/compare.css`; Vite and Wrangler bundle source directly, with no package build.
  Declare tooling dependencies in the package that uses them; never import another game's `node_modules`.
- Read `docs/game-notes.md` before rendering, performance, input, multiplayer or feel work, and add techniques there
  once they are proven in a game, with where they live and what they measured. `docs/shared-code.md` lists code both
  games duplicate and what to extract into `packages/kit/`; check it before writing something a game already has.
- Anything you can tune or compare (effects, looks, styles, rendering options) goes in the shared lab panel (`packages/kit/lab-panel.ts`, opened with Backquote), never behind a query parameter. Query parameters are only for automation (seeds, benchmarks, comparisons). Improve the shared panel rather than building a game-specific one.
- Everything is served under https://anoma.ly/arcade/. A game owns `/arcade/<name>` and `/arcade/<name>/*`. The landing
  owns only `/arcade`, `/arcade/` and `/arcade/assets/*`. Never add a wildcard `/arcade/*` route.
- Pushing to `main` deploys affected projects (`.github/workflows/`). Both workspace games also check and deploy on
  `packages/**`, root `scripts/**`, `package.json`, `bun.lock` and `bunfig.toml` changes. Blackout additionally watches
  `games/getaway/shared/**` because its script typecheck includes the cross-game benchmark. Keep installs at the root
  in both check and deploy jobs; checks build and smoke-load each production bundle before deployment.
  Local `bun run deploy` still runs inside a game. Cloudflare Builds must install from the repository root before
  running the game's build/deploy command (for example `bun run --cwd games/getaway build`).
- Verify workspace changes from a clean `git archive` export: root frozen install and package checks, each game's
  `bun run check`, then `bunx --no-install wrangler deploy --dry-run` inside each game. Dry-runs do not deploy.
- Adding a game: put it in `games/<name>`, give its Worker the name `arcade-<name>` with the routes above, set Vite's
  outDir to `dist/arcade/<name>`, strip the `/arcade/<name>` prefix in the Worker, add a workflow, and add a panel to
  `landing/index.html`. If it had an old `anoma.ly/labs/<name>` URL, add it to `redirects/` (GAMES and routes).
