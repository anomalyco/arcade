---
deploys: off
allowed_base: overnight
retired_branches:
  - release-4
  - release-5
  - release-6
  - release-7
browser_proofs_default: off
preview_worktree: /Users/kit/worktrees/arcade/release-4
preview_hub_port: 5187
---

# Agent State

Live operational state for agents working in `anomalyco/arcade`. Read this file before opening a PR, merging, deploying, or editing a hot file. `bun scripts/agent-ops.ts state` and `.github/workflows/pr-guard.yml` enforce the frontmatter above.

## Deploy & Branch Policy

- **Now (Oct 20, Kit):** deploys are paused while Kit plays live; the server must not restart. PRs target `overnight` and merge there when green; never merge to `main` and never run `bun run deploy`. Fast-forward the preview worktree to `origin/overnight` instead of `origin/main`. The coordinator merges `overnight` into `main` in the morning.

- **`deploys: on`** — PRs target `main` (`allowed_base: main`) and merge when green (`gh pr merge --squash --delete-branch`). Pushing or merging to `main` triggers Cloudflare Workers deploy workflows automatically; do not run `bun run deploy` manually unless Kit explicitly asks.
- **When `deploys: off`** — The coordinator sets `deploys: off` and updates `allowed_base` (for example, to an active integration branch). While `deploys: off`, never merge to `main` and never run `bun run deploy`.
- **Retired branches (`release-4`, `release-5`, `release-6`, `release-7`)** — Never base a PR on a retired branch and never push to or recreate a retired branch on `origin`. When an integration branch ships to `main`, the coordinator adds it to `retired_branches` and deletes it on `origin`.

## Proof & Verification Defaults

- **Default check (`browser_proofs_default: off`)**: Run `hivemind run --kind cargo -- bun run verify` (or `--kind browser` when smoke needs a GPU slot). Do not run multi-minute Playwright video/screenshot capture scripts unless:
  1. Your brief explicitly requests a visual screenshot, video, or Gallery comparison, or
  2. You changed WGSL shaders, post-processing, lighting, camera framing, or HUD layout.
- **Gallery links**: Before posting any `https://arcade.lwoyjcaeyxv6.opentunnel.xyz/captures/<slug>/compare.html` link, run `bun scripts/agent-ops.ts gallery-link <capture-dir> <slug>` so the symlink in `/Users/kit/worktrees/arcade/release-4/captures/<slug>` is created and verified with HTTP 200.

## Shared Preview Worktree

- `/Users/kit/worktrees/arcade/release-4` backs the live `:5187` Dev Hub (`https://arcade.lwoyjcaeyxv6.opentunnel.xyz`).
- Never use `/Users/kit/worktrees/arcade/release-4` as a feature worktree or leave uncommitted edits in it.
- After merging a PR to `main`, fast-forward it cleanly:
  ```sh
  git -C /Users/kit/worktrees/arcade/release-4 fetch origin main && git -C /Users/kit/worktrees/arcade/release-4 merge --ff-only origin/main
  ```

## Hot-File Contention Rules

In the last 36 hours, `games/outbreak/src/main.ts` was touched by 95 commits (62% of Outbreak commits) and caused 98 merge-conflict events. `games/outbreak/src/main.ts` is now a thin composition root (`391` lines); keep edits to these files minimal:

| File | Rule |
| --- | --- |
| `games/outbreak/src/main.ts` | Keep `main.ts` as a thin composition root. Put feature logic in `games/outbreak/src/<feature>/...` and subsystem changes in their owning module (`src/loop/frame-pacer.ts`, `src/input/controller.ts`, `src/hud/frame-ui.ts`, `src/world/scene-level.ts`, `src/scene/frame-lighting.ts`, `src/scene/frame-renderer.ts`). |
| `games/outbreak/shared/coop-sim.ts` | Put self-contained simulation rules in `games/outbreak/shared/<feature>.ts` and call them from `stepSurvivor` / `stepWorld`. |
| `games/lab/src/stations/index.ts` | Add your station in `games/lab/src/stations/<id>.ts` and append one registration import/entry; rebase onto `origin/main` right before opening your PR. |
| `games/blackout/src/game/game.ts` | Keep mode-specific FX and rules in `src/game/` or `shared/sim/modes-*.ts` modules rather than inline in `game.ts`. |
