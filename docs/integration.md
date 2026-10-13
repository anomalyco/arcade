# Arcade integration

One review branch, based on `origin/main` at `bf5f6277e38ee52e9bfa4ae4a01337b46175c181`.
Sources were snapshotted before merging on 2026-10-13. Each source is merged separately in this order.

| Source | Exact committed tip | Original PR |
| --- | --- | --- |
| fix/blackout-quick-taps | `7519dcc67be91e0077f23c253dc3320d198ba88f` | #11 |
| blackout-look (local) | `111dda9b40c8610e0235fdd0049b4aa37bf930f6` | #8 |
| blackout-anim | `822303310da0bd95901879570e27c5b942ca4aa9` | #9 |
| fx-kit (local) | `452db1806a5978d38c752a515ab8099ef136cc33` | #12 |
| vehicle-kit | `0bbe1a962012f4c2bf2b980c161af1e9d4aa9d91` | #6 |
| outbreak | `e5554a76fc3543ef9ce4ca2a37829005fd0b44b2` | #7 |
| wizards | `2e3177ab673bcdc8163eb7d8cb6e858b34ddd808` | — |
| compare-video | `716b5cdc074038b845a5713905735a3e581b3116` | — |
| architecture-plan | `f05630039bf2ee28f1b142144c0318a7473f4398` | — |
| simplify-review | `81e9a4b94e08a76494dccbdf0dc0cd832813e013` | #10 |

The local Look tip includes the window moonlight coverage fix missing from its remote PR.
The local FX tip includes surface splatter and the completed fire/water work.
Wizards' latest committed change is immediate click casting (`2e3177a`), after the older rune-casting study.

## Excluded

- Rejected experimental Getaway look presets; existing approved Night presentation stays.
- Historical branches already squashed into main.
- Wings changes and public homepage promotion of Outbreak or Wizards.
- Unfinished `shared-human-rig` work: its worktree has modified animation/rig/Lab files and untracked
  `human-locomotion.ts`, `human-pose.ts`, `human-profile.ts`, `human.test.ts`, `rig.ts` and proof/demo files.
  None of that uncommitted work is an integration input.

## Resolution and verification log

- Look/FX: retained tile reflections, separate fine moon mask, and removed sound rings/shot lamp brownouts.
  Explicit Lab lamp sparks remain available without reviving shot-triggered light changes.
- Vehicle/FX: one canonical tyre solver and GPU pipeline in `kit/fx`; `kit/vehicle` holds compatible adapters.
  Moved live effect settings and sprite identities into kit so Lab tuning reaches shared vehicle emitters.
- Outbreak extraction: forward-ported current renderer, input and camera changes into the canonical kit modules.
  Motion stays at binding 7, fine moon mask at 8, exploration at 9. Blackout paths are adapters/re-exports.
- Wizards: immediate click capture and gun tap capture both survive; animation adds wizard pose to the latest gait.
- Simplify: retained `testEffect`, shared motion and dependent GPU timing, and the benchmark emission-study methods
  used by current FX/Lab proof runners. Retained the corresponding smoke proof script; removed obsolete proof
  scripts and unused ghost submission path. Kept shared implementations rather than reviving per-game copies.
- The first remote package check saw stale `kit/playground` files from Hivemind's reused checkout seed, which are
  absent from this branch. Subsequent checks use a clean archive export.

## Local review

Run `bun install --frozen-lockfile` at the root. Start each client from its game directory with
`bunx --no-install vite --host 127.0.0.1`; Blackout also needs `bun scripts/build-id.ts` first.
For the full game server use the existing `bun run dev` script from Getaway or Blackout.

The integration worktree has these named client previews:

- Getaway: <http://arcade-review-getaway.localhost:1355/?peaceful=1&seed=7>
- Blackout: <http://arcade-review-blackout.localhost:1355/?sandbox=1&seed=1>
- Wizards: <http://arcade-review-blackout.localhost:1355/?sandbox=1&mode=wizards&seed=1>
- Shared Lab: <http://arcade-review-blackout.localhost:1355/lab.html>
- Outbreak: <http://arcade-review-outbreak.localhost:1355/?solo&seed=7>

These client previews support local play. The sniper network proof uses a mocked socket feeding the real shared World.

## Combined-tree evidence

- Package check: 30 tests passed. Getaway: 188 passed, 12 existing skips. Blackout: 342 passed. Outbreak: 14 passed.
  All game typechecks and builds passed, with the normal Blackout chunk-size warning.
- Metal on the local named previews: sniper taps passed local and mocked-network paths, each with 12 predicted and
  12 authoritative shots. Click-casting passed independent cooldowns, wheel/1/2 selection, caster-targeting skeletons,
  Moon Ball capture/pop, Dvorak movement and Lab input isolation.
- `scripts/prove-integration.ts` drove the combined Getaway capture hook, observed 33 smoke particles, checked all
  approved light defaults, and crossed the tunnel at 32.43 m/s. Outbreak's closed-door sample changed from unexplored
  to visible after interaction. Blackout retained reflections/default-off motion and absent ring/lamp toggles; a
  forced tyre-smoke fixture also rendered with motion enabled. Spawn, fire/water and splatter Lab sections rendered.
- The GPU proof caught and repaired the shared vehicle-sprite return type in the MRT motion shader and added a
  compatible tyre-smoke pipeline for that attachment layout. No browser/GPU errors remained in the cited proofs.
- Cited local evidence: `~/code/home/artifacts/2026-10-13-arcade-integration/` (screenshots and JSON reports).

Final verification used a clean `git archive` of `c61876d` on the Studio through Hivemind. Frozen install, the package
check, all three game checks, all three production smokes, and all three `wrangler deploy --dry-run` commands passed.
The Blackout/Getaway production smokes check the lobby; their gameplay GPU proof is the separate Metal run above.
No deployment or main-branch push has run.

To repeat from a clean export:

```sh
git archive HEAD | tar -x -C /path/to/empty/export
cd /path/to/empty/export
bun install --frozen-lockfile
bun run check:packages
for game in getaway blackout outbreak; do
  (cd "games/$game" && bun run check && bun ../../scripts/smoke.mjs && bunx --no-install wrangler deploy --dry-run)
done
```

Run the checks through the fleet in this environment. The smoke runner requires an installed Playwright Chromium.
The repair commits after source integration contain the adapter and GPU fixes; this document records their
combined verification rather than relying on any source PR's checks.
