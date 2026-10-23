# arcade

[docs/README.md](docs/README.md) lists every shared doc and when to read it. Game-specific notes live in each
game's own `AGENTS.md`. Practical guides live in `docs/`; measurements, studies and history live in
[docs/research/](docs/research/README.md).

## Visual work, by task

Anything visual starts from [docs/quality-checklist.md](docs/quality-checklist.md) and the `arcade-quality` skill:
target first, a method per asset, the finish pass, shared kit effects, pre-flight gates, then showing Kit.

| Task | Read | Skill |
| --- | --- | --- |
| Building a prop or model | [assets.md](docs/assets.md#pick-the-right-method) | `arcade-props` |
| A creature | [assets.md](docs/assets.md#pick-the-right-method), [animation.md](docs/animation.md) | `arcade-lookdev`, `arcade-props`, `procedural-animation-iteration` |
| A room or interior | [assets.md](docs/assets.md#pick-the-right-method), [realism.md](docs/realism.md#glass-interiors-and-built-structures) | `arcade-lookdev`, `arcade-props` |
| Lighting a scene (lights, shadows, fog, weather, materials) | [realism.md](docs/realism.md) | `arcade-lookdev` |
| A camera look (grade, lens, filters, stability) | [realism.md](docs/realism.md#camera-lens-and-post) | `arcade-lookdev` |
| A new game | [prototyping.md](docs/prototyping.md), [game-shell.md](docs/game-shell.md) | |

New realism techniques go in `packages/kit/` with the game supplying hooks, unless they are truly game-specific.
Once one is proven, give it a `docs/realism.md` entry with its cost and Kit's decision.

## Workspace and checks

- [packages/kit/TESTING.md](packages/kit/TESTING.md) documents the fast tests and nightly network, audio, physics and training soaks.

- Bun workspace: `games/blackout/`, `games/getaway/`, `games/outbreak/`, `games/carrier/`, `games/brawl/`,
  `games/archers/`, `games/lab/` and `packages/*` share the root `bun.lock`. Run `bun install --frozen-lockfile` at the root; `bun run
  verify` (below) runs the checks.
- `bunfig.toml` selects hoisted dependencies for shared tooling and historical benchmark exports. Keep Vite,
  Wrangler, TypeScript and Playwright versions aligned across workspace games.
- `landing/` and `redirects/` are independent projects with their own lockfiles and install/check
  commands; do not add them to the workspace implicitly.
- While iterating, run `bun run verify:remote`: it snapshots changed paths on the submitter and runs
  `hivemind run --kind cargo -- bun run verify` with that snapshot. It runs incremental typechecks and Bun tests
  only, plus their required build-ID preparation, for targets whose CI workflow paths match your changes
  (vs `origin/main`, including uncommitted files). No Vite build or Playwright runs in this tier; docs-only checks
  nothing. Don't rerun when nothing changed. Use `bun run verify:remote --worker mini -- --all` to pass HiveMind
  options before `--` and verify options after it; `--all` stays headless.
- At PR pitch time, use `hivemind run --kind browser -- bun run verify:smoke --game <name>` to build and smoke
  one game, with one still of the changed behavior when visual proof is warranted. The wrapper equivalent is
  `bun run verify:remote -- --smoke --game <name>`; it selects browser admission automatically.
- At merge or nightly, run the full suite with `hivemind run --kind browser -- bun run verify:release`: a clean
  `git archive` export of HEAD, root frozen install, then every workspace target's check commands, smoke and dry-run
  with cold caches. Commit first; it ignores uncommitted changes. Dry-runs do not deploy. The per-game
  `bun run check` and `bun run check:packages` still work and are what CI runs.
  Run any required full browser proofs at this tier, following `browser_proofs_default` below. Budget for minutes:
  the Oct 22 remote-mini full plan, before the headless default, took 1,204 s at 2 jobs (including existing test and
  smoke failures); release also adds export and frozen install. The old ~30 s estimate no longer applies.
- HiveMind workers sync files without a usable `.git`. A bare remote `verify` fails unless given
  `--changed <file>` or `ARCADE_VERIFY_CHANGED_FILE` (newline-separated paths); an empty file checks nothing.
  `verify:remote` ships that snapshot automatically, including committed, staged, unstaged and untracked paths
  versus `origin/main`. Use `--all` explicitly for every workspace target. The plan prints its targets and reason.
  `verify:release` copies the synced tree, minus ignored
  output, as its export, so uncommitted files are included. `--export <dir|tar>` verifies a pre-made `git archive`.
- Worker budgets default to `--jobs 2 --test-workers 2`. Precedence is flags, then `ARCADE_VERIFY_JOBS` /
  `ARCADE_VERIFY_TEST_WORKERS`, then `HIVEMIND_JOBS` / `HIVEMIND_TEST_WORKERS`, then 2 each.
  `HIVEMIND_CPUS`, when supplied by the worker, caps both to its allocation (rounded down, minimum 1).
  `verify:remote` forwards the two Arcade budget variables; it never forwards the submitter's CPU allocation.
- Every `tests/` and `scripts/` file is typechecked. Game configs cover their own scripts/tests; root `scripts/`
  has `scripts/tsconfig.json`, checked by `bun run check:scripts`, the `scripts` CI workflow, and the workflow-scoped
  `scripts` target in `verify` / `verify:release`. This
  config also owns Blackout's cross-game `scripts/animation/` harnesses and `tests/motion-*.test.ts`, excluded from
  its game script check (the game still runs those tests).
  Proof scripts for kit code go in root `scripts/` (Lab proofs in `scripts/lab/`), not in `packages/kit/`.
- Local smoke uses the Metal adapter on macOS (~80x faster than SwiftShader); `SMOKE_GPU=swiftshader` reproduces CI.
- Browser scripts use `scripts/browser-budget.ts` with `await using`: 180 s per script, `ARCADE_BROWSER_BUDGET_S` override ≤300 s; CPU-only sweeps run directly in Bun (`--kind cargo`).

## Routing and deploy

- Everything is served under https://anoma.ly/arcade/. A game owns `/arcade/<name>` and `/arcade/<name>/*`. The
  landing owns only `/arcade`, `/arcade/` and `/arcade/assets/*`. Never add a wildcard `/arcade/*` route.
- Pushing to `main` deploys affected projects (`.github/workflows/`). All workspace games also check and deploy on
  `packages/**`, root `scripts/**`, `package.json`, `bun.lock` and `bunfig.toml` changes. The `scripts` CI workflow
  watches all games and packages to cover cross-game benchmarks. Blackout watches Getaway's `src/**` and
  `shared/**` because its fire/water Lab imports Getaway's environment and props. Blackout and
  Outbreak also watch `games/getaway/public/sfx/**`: the shared audio asset plugin copies the manifest's samples into
  each game's own `audio-assets/` route for prefix-safe Lab loading.
- The Lab (`games/lab`, Worker `arcade-lab`, `/arcade/lab`) bundles Getaway, Blackout and Outbreak's Lab adapters,
  so its workflow also watches those games. Each game Worker redirects its old `/lab.html` to
  `/arcade/lab/?game=<game>`.
- Keep installs at the root in both check and deploy jobs; checks build and smoke-load each production bundle before
  deployment. Local `bun run deploy` still runs inside a game. Cloudflare Builds must install from the repository
  root before running the game's build/deploy command (for example `bun run --cwd games/getaway build`).
- Adding a game: put it in `games/<name>`, give its Worker the name `arcade-<name>` with the routes above, set Vite's
  outDir to `dist/arcade/<name>`, strip the `/arcade/<name>` prefix in the Worker, add a workflow, add it to the root
  `package.json` workspaces and `WORKSPACE_GAMES` in `scripts/verify.ts`, and add a panel to `landing/index.html`. If it had an old `anoma.ly/labs/<name>` URL, add it to `redirects/` (GAMES and routes).
  Put it on the shared game shell from the first commit ([docs/game-shell.md](docs/game-shell.md#checklist-for-a-new-game)):
  title, Escape menu, Settings and lobby from `@arcade/kit/shell`, quality from `createShellQuality`.
- New game ideas start as a single-screen low-res toy prototype (`bun scripts/new-toy.ts <name>`, [docs/prototyping.md](docs/prototyping.md)) on `@arcade/kit` primitives to prove the feel of movement, camera and the core verb before adding custom meshes, shaders or multiplayer. Cheap presentation, shared feel on by default: test models, but the kit's camera shake, hit-stop, effects, sounds, rig and bots from day one; add missing pieces to the kit, not the toy.
- Prototypes are unlisted: deploy normally, skip the landing panel, add `noindex`, and list the game in the README's
  prototypes section. Promote a game by adding the landing panel and removing `noindex`.

## Shared code and conventions

- `packages/kit/` is the private, versionless `@arcade/kit` source package. Import subpaths such as
  `@arcade/kit/lab-panel` and `@arcade/kit/compare.css`; Vite and Wrangler bundle source directly, with no package
  build. Declare tooling dependencies in the package that uses them; never import another game's `node_modules`.
- [docs/shared-code.md](docs/shared-code.md) lists what the games still duplicate and what to extract into
  `packages/kit/`; [docs/architecture.md](docs/architecture.md) shows which kit modules each game already uses. Check
  both before writing something a game already has. `games/*/shared/` imports only pure kit modules (`sim/`, `net/`,
  `limits`).
- Read [docs/assets.md](docs/assets.md) before adding or generating assets: CC0 or credited CC BY only, a
  `CREDITS.md` per game, hashed sources, compressed files under 25 MiB.
- Before rendering, performance, input, multiplayer or feel work, check what was already measured in
  [docs/research/game-notes.md](docs/research/game-notes.md) and
  [docs/research/rendering-techniques.md](docs/research/rendering-techniques.md); read
  [docs/netcode.md](docs/netcode.md) before any multiplayer or net work. Add a technique to
  `docs/research/game-notes.md` once it is proven in a game, with where it lives and what it measured (animation
  techniques go in `docs/animation.md`).

## Game shell

- Read [docs/game-shell.md](docs/game-shell.md) before touching a title screen, lobby, pause menu, settings, volume,
  mute, graphics quality or loading screen. Every game uses `@arcade/kit/shell` for settings, pause, title and lobby.
  Default graphics is High (Auto starts High and steps down only on slow frames). Volume and mute are always reachable
  from the title and the Escape menu. No game ships its own volume or quality UI.

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
- Look, light, weather, materials, vegetation and effects labs share the base debug world (`packages/kit/lab/world/`)
  and differ by knobs and presets: to show a new idea, add a preset to `WORLD_PRESETS` (and a knob if it needs one),
  not a new lab or bespoke room. Separate labs are only for scenes that are a game's own page.
- Labs show only what their subject needs; every panel is opt-in per lab kind (`LabKind.panels`), the subject's knobs
  come first and largest, and there is no voice-notes panel (Kit uses Scrawl). Don't add a panel, card or toolbar
  button to every lab; give it to the kinds that need it.
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

## Agent workflow and coordination

- **Live state ([docs/agent-state.md](docs/agent-state.md))**: Read `docs/agent-state.md` (or run `bun scripts/agent-ops.ts state`) before opening a PR, merging, or deploying. It defines `deploys: on|off`, `allowed_base` (`main`), `retired_branches`, `browser_proofs_default`, and hot-file contention rules. `.github/workflows/pr-guard.yml` enforces it in CI.
- **Worktrees & branches**: Work in a dedicated worktree under `/Users/kit/worktrees/arcade/<branch>` (`git worktree add`). Never share a worktree with another active agent and never use `/Users/kit/worktrees/arcade/release-4` (the live `:5187` Dev Hub preview worktree) for feature work. Never push to or recreate a retired branch (`release-4`, `release-5`, `release-6`, `release-7`).
- **Verification & proofs**: Iterate through `bun run verify:remote` (HiveMind cargo admission). Smoke is explicit at PR pitch time; the full suite and any required browser proofs run at merge or nightly. When `browser_proofs_default: off` in `docs/agent-state.md`, skip multi-minute Playwright video/capture proofs unless your brief asks for visual proof or you changed shaders, lighting, camera framing, or HUD layout. Never open visible windows (`headless: true` only) and never play audio (`--mute-audio` only).
- **Proof diet**: Record each revision once and coalesce duplicate capture requests. Prefer stills and preview links over clips; clips are for motion. Respect `browser_proofs_default: off`: mechanical changes need no captures. Don't repeat checks or captures when nothing changed.
- **PRs & deploys**: Rebase onto `origin/main` before opening a PR (`gh pr create --base main`). When `deploys: on` and CI is green, merge (`gh pr merge --squash --delete-branch`) and fast-forward `/Users/kit/worktrees/arcade/release-4` (`git -C /Users/kit/worktrees/arcade/release-4 fetch origin main && git -C /Users/kit/worktrees/arcade/release-4 merge --ff-only origin/main`). Do not run `bun run deploy` manually unless Kit explicitly asks.
- **Durable reports & safe messaging**: Before finishing a subagent task, save your full report to `~/code/home/artifacts/agent-reports/<session>.md` (`bun scripts/agent-ops.ts report write --session <ses_...> --file <path>`) and post a summary on the `AR-n` board card (`board.ts comment`). Coordinators must use `bun scripts/agent-ops.ts msg <ses_...> "<text>"` to message child sessions (refuses if mid-turn so queued messages do not overwrite `<subagent>` completion summaries) and `bun scripts/agent-ops.ts watchdog` / `bun scripts/agent-ops.ts board-hygiene` to catch stalled sessions, overwritten reports, and board drift.
- **Gallery links**: Register capture directories with `bun scripts/agent-ops.ts gallery-link <capture-dir> <slug>` (symlinks into `/Users/kit/worktrees/arcade/release-4/captures/<slug>` and verifies HTTP 200 on `:5187`) before sharing any `arcade.lwoyjcaeyxv6.opentunnel.xyz/captures/<slug>/...` URL.
