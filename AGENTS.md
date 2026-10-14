# arcade

- Bun workspace: `games/blackout/`, `games/getaway/`, `games/outbreak/`, `games/carrier/` and `packages/*` share the root `bun.lock`. Run
  `bun install --frozen-lockfile` at the root, `bun run check:packages`, then `bun run check` inside each affected game.
  `bunfig.toml` selects hoisted dependencies for shared tooling and historical benchmark exports. Keep Vite, Wrangler,
  TypeScript and Playwright versions aligned across workspace games. `landing/`, `redirects/` and `games/wings/` are
  independent projects with their own lockfiles and install/check commands; do not add them to the workspace implicitly.
- `packages/kit/` is the private, versionless `@arcade/kit` source package. Import subpaths such as
  `@arcade/kit/lab-panel` and `@arcade/kit/compare.css`; Vite and Wrangler bundle source directly, with no package build.
  Declare tooling dependencies in the package that uses them; never import another game's `node_modules`.
- Read `docs/game-notes.md` before rendering, performance, input, multiplayer or feel work, and add techniques there
  once they are proven in a game, with where they live and what they measured. `docs/shared-code.md` lists code both
  games duplicate and what to extract into `packages/kit/`; check it before writing something a game already has.
- Read [docs/lab.md](docs/lab.md) before adding or tuning effects, materials, physics, audio or rendering options. To show Kit an orientation, asset, or sandbox setup in his open browser tab, use `bun run arcade …` ([docs/dev-control.md](docs/dev-control.md)).
  All tunable values belong in typed settings bound to the shared `LabPanel` (Backquote), with meaningful labels,
  explicit units/ranges/steps, approved defaults and Reset. Query parameters are for automation only.
  Use the production effect/material/physics implementation through adapters, never a Lab-only facsimile; label
  unintegrated candidates and renderer stubs honestly. Improve the shared panel rather than adding game-specific UI.
  New authoring paths must keep parameter Randomize reproducible and separate from room/effect seeds, validate
  versioned preset imports, declare live-edit/retrigger boundaries, and preserve environment state across tool changes.
  Preserve text-field input ownership and explicit Edit/Play, require explicit audio audition, and keep gameplay
  authoritative while presentation/clutter stays local. Follow the guide's deterministic comparison and timing rules;
  its planned UX and existing API gaps are not shipped features or additional release gates.
- Everything is served under https://anoma.ly/arcade/. A game owns `/arcade/<name>` and `/arcade/<name>/*`. The landing
  owns only `/arcade`, `/arcade/` and `/arcade/assets/*`. Never add a wildcard `/arcade/*` route.
- Pushing to `main` deploys affected projects (`.github/workflows/`). All workspace games also check and deploy on
  `packages/**`, root `scripts/**`, `package.json`, `bun.lock` and `bunfig.toml` changes. Blackout additionally watches
  `games/getaway/shared/**` because its script typecheck includes the cross-game benchmark.
  Blackout and Outbreak also watch `games/getaway/public/sfx/**`: the shared audio asset plugin copies the manifest's
  samples into each game's own `audio-assets/` route for prefix-safe Lab loading.
  Keep installs at the root in both check and deploy jobs; checks build and smoke-load each production bundle before deployment.
  Local `bun run deploy` still runs inside a game. Cloudflare Builds must install from the repository root before
  running the game's build/deploy command (for example `bun run --cwd games/getaway build`).
- Verify workspace changes from a clean `git archive` export: root frozen install and package checks, each game's
  `bun run check`, then `bunx --no-install wrangler deploy --dry-run` inside each game. Dry-runs do not deploy.
- Adding a game: put it in `games/<name>`, give its Worker the name `arcade-<name>` with the routes above, set Vite's
  outDir to `dist/arcade/<name>`, strip the `/arcade/<name>` prefix in the Worker, add a workflow, and add a panel to
  `landing/index.html`. If it had an old `anoma.ly/labs/<name>` URL, add it to `redirects/` (GAMES and routes).
  Prototypes are unlisted: deploy normally, skip the landing panel, add `noindex`, and list the game in the README's prototypes section. Promote a game by adding the landing panel and removing `noindex`.
- Every showcase video made for a game gets uploaded to the #arcade Slack channel (C0C8JM9SWP7) as soon as it's done,
  with a one-line description and the live URL, signed "— from 𝕺𝖕𝖊𝖓𝕮𝖔𝖉𝖊". Keep files under 50 MB.
