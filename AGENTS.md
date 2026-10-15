# arcade

[docs/README.md](docs/README.md) lists every shared doc and when to read it. Game-specific notes live in each
game's own `AGENTS.md`.

## Workspace and checks

- Bun workspace: `games/blackout/`, `games/getaway/`, `games/outbreak/`, `games/carrier/`, `games/lab/` and
  `packages/*` share the root `bun.lock`. Run `bun install --frozen-lockfile` at the root, `bun run check:packages`,
  then `bun run check` inside each affected game.
- `bunfig.toml` selects hoisted dependencies for shared tooling and historical benchmark exports. Keep Vite,
  Wrangler, TypeScript and Playwright versions aligned across workspace games.
- `landing/`, `redirects/` and `games/wings/` are independent projects with their own lockfiles and install/check
  commands; do not add them to the workspace implicitly.
- While iterating, run `hivemind run --kind browser -- bun run verify`: it checks only the targets whose CI workflow
  paths match your changes (vs `origin/main`, including uncommitted files), in parallel, with incremental typecheck,
  then smoke and `wrangler deploy --dry-run`. A one-game change takes ~5 s; `--all` ~17 s; docs-only checks nothing.
- Before opening or merging a PR, run `hivemind run --kind browser -- bun run verify:release` (~30 s): a clean
  `git archive` export of HEAD, root frozen install, then every workspace target's check commands, smoke and dry-run
  with cold caches. Commit first; it ignores uncommitted changes. Dry-runs do not deploy. The per-game
  `bun run check` and `bun run check:packages` still work and are what CI runs.
- Local smoke uses the Metal adapter on macOS (~80x faster than SwiftShader); `SMOKE_GPU=swiftshader` reproduces CI.

## Routing and deploy

- Everything is served under https://anoma.ly/arcade/. A game owns `/arcade/<name>` and `/arcade/<name>/*`. The
  landing owns only `/arcade`, `/arcade/` and `/arcade/assets/*`. Never add a wildcard `/arcade/*` route.
- Pushing to `main` deploys affected projects (`.github/workflows/`). All workspace games also check and deploy on
  `packages/**`, root `scripts/**`, `package.json`, `bun.lock` and `bunfig.toml` changes. Blackout additionally
  watches `games/getaway/shared/**` because its script typecheck includes the cross-game benchmark. Blackout and
  Outbreak also watch `games/getaway/public/sfx/**`: the shared audio asset plugin copies the manifest's samples into
  each game's own `audio-assets/` route for prefix-safe Lab loading.
- The Lab (`games/lab`, Worker `arcade-lab`, `/arcade/lab`) bundles Getaway, Blackout and Outbreak's Lab adapters,
  so its workflow also watches those games. Each game Worker redirects its old `/lab.html` to
  `/arcade/lab/?game=<game>`.
- Keep installs at the root in both check and deploy jobs; checks build and smoke-load each production bundle before
  deployment. Local `bun run deploy` still runs inside a game. Cloudflare Builds must install from the repository
  root before running the game's build/deploy command (for example `bun run --cwd games/getaway build`).
- Adding a game: put it in `games/<name>`, give its Worker the name `arcade-<name>` with the routes above, set Vite's
  outDir to `dist/arcade/<name>`, strip the `/arcade/<name>` prefix in the Worker, add a workflow, and add a panel to
  `landing/index.html`. If it had an old `anoma.ly/labs/<name>` URL, add it to `redirects/` (GAMES and routes).
- Prototypes are unlisted: deploy normally, skip the landing panel, add `noindex`, and list the game in the README's
  prototypes section. Promote a game by adding the landing panel and removing `noindex`.

## Shared code and conventions

- `packages/kit/` is the private, versionless `@arcade/kit` source package. Import subpaths such as
  `@arcade/kit/lab-panel` and `@arcade/kit/compare.css`; Vite and Wrangler bundle source directly, with no package
  build. Declare tooling dependencies in the package that uses them; never import another game's `node_modules`.
- [docs/shared-code.md](docs/shared-code.md) lists code the games duplicate and what to extract into
  `packages/kit/`; check it before writing something a game already has.
- Read [docs/game-notes.md](docs/game-notes.md) and [docs/rendering-techniques.md](docs/rendering-techniques.md)
  before rendering, performance, input, multiplayer or feel work. Add a technique to `docs/game-notes.md` once it
  is proven in a game, with where it lives and what it measured (animation techniques go in `docs/animation.md`).

## Rendering

- Rendering techniques, their status and cost are catalogued in
  [docs/rendering-techniques.md](docs/rendering-techniques.md); proven rendering notes are in the Rendering and Art
  direction sections of [docs/game-notes.md](docs/game-notes.md).

## Animation

- Read [docs/animation.md](docs/animation.md) before changing how any character moves: it holds the rig's rules,
  measured values and known gaps. [docs/human-rig.md](docs/human-rig.md) is the rig's API and module ownership.
- Before tuning or fixing character animation (gait, walk/run cycles, arm swing, rig poses, IK), load the
  `procedural-animation-iteration` project skill (`.opencode/skills/procedural-animation-iteration/SKILL.md`):
  measure with the deterministic scripts in `games/blackout/scripts/animation/` and pose-diff against mocap before
  and after every change. Record what you learn in `docs/animation.md`.

## Controls

- Read [docs/controls.md](docs/controls.md) before changing key bindings or HUD input prompts. Bind gameplay actions
  by physical `KeyboardEvent.code` (`KeyE` interact, `KeyW`/`KeyA`/`KeyS`/`KeyD` move, `ShiftLeft` sprint). Prompts
  always show the QWERTY name of that physical key, even on Dvorak (`KeyE` → `E`), via `keyLabel` from
  `@arcade/kit/client/controls`; draw them with the key caps in `@arcade/kit/client/key-cap`, using the hold variant
  instead of the word "Hold". The player's own layout labels are only an opt-in **Key labels** setting.

## Lab and showing Kit

- Read [docs/lab.md](docs/lab.md) before adding or tuning effects, materials, physics, audio or rendering options.
- To show Kit an orientation, asset, or sandbox setup in his open browser tab, use `bun run arcade …`; to walk him
  through a labeled multi-tab tour or highlight a target with a pinned note, use `arcade tour` and `arcade note`
  ([docs/dev-control.md#show-kit-things](docs/dev-control.md#show-kit-things)). For demos he comes back to, add or
  update a Lab station (one file in `games/lab/src/stations/`, [docs/lab.md](docs/lab.md#stations))
  instead of a tour; `arcade station <id>` jumps his tab there.
- All tunable values belong in typed settings bound to the shared `LabPanel` (Backquote), with meaningful labels,
  explicit units/ranges/steps, approved defaults and Reset. Query parameters are for automation only. The panel draws
  with knobs (`packages/knobs`, vendored from Kit's knobs repo; refresh it with `bun packages/knobs/scripts/sync.ts`,
  never edit it in place).
- Use the production effect/material/physics implementation through adapters, never a Lab-only facsimile; label
  unintegrated candidates and renderer stubs honestly. Improve the shared panel rather than adding game-specific UI.
- New authoring paths must keep parameter Randomize reproducible and separate from room/effect seeds, validate
  versioned preset imports, declare live-edit/retrigger boundaries, and preserve environment state across tool
  changes. Preserve text-field input ownership and explicit Edit/Play, require explicit audio audition, and keep
  gameplay authoritative while presentation/clutter stays local.
- Follow the guide's deterministic comparison and timing rules; its planned UX and existing API gaps are not shipped
  features or additional release gates.
- Every showcase video made for a game gets uploaded to the #arcade Slack channel (C0C8JM9SWP7) as soon as it's
  done, with a one-line description and the live URL, signed "— from 𝕺𝖕𝖊𝖓𝕮𝖔𝖉𝖊". Keep files under 50 MB.

## Integration

- Read [docs/integration.md](docs/integration.md) before combining several feature branches into one release branch.
