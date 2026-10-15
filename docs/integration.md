# Release integration

How to combine several finished feature branches into one release branch. The per-release logs that used to live
here (source tips, conflict resolutions, check totals, Outbreak perf passes) are in the release PR bodies listed
below and in this file's git history.

## Method

1. Create `release-<n>` from `origin/main` and note the base commit in the PR body.
2. Merge each finished source branch separately, with its own merge commit, in a stated order. Record each source's
   exact committed tip in a table in the PR body. Leave out unfinished or exploratory branches and say why.
3. Resolve conflicts by keeping both sides' behaviour. When two branches add the same thing (a light pool, a Lab
   control, an ambient term), keep one and delete the duplicate. Note each non-trivial resolution in the PR body.
4. Verify the combined tree from a clean `git archive` export on the Studio through hivemind. A reused checkout can
   carry stale files that hide breakage, and mini sync doesn't delete removed files.

   ```sh
   git archive HEAD | tar -x -C /path/to/empty/export
   cd /path/to/empty/export
   bun install --frozen-lockfile
   bun run check:packages
   for game in getaway blackout outbreak carrier lab; do
     (cd "games/$game" && bun run check && bunx --no-install wrangler deploy --dry-run)
   done
   ```

5. Run the Metal browser proofs for anything visual that the merge touched, and repeat the Outbreak frame-time bench
   (`games/outbreak/scripts/bench-outbreak.ts`) when renderer or Outbreak code changed. Record before and after.
6. Pushing to `main` deploys. The integration branch never deploys by itself. While deploys are paused, feature PRs
   target the current integration branch instead of `main`.

## Past releases

| Release | PR | Notes |
| --- | --- | --- |
| 1 (`arcade-integration`) | #13 | Blackout, shared FX, vehicles, Outbreak M1, Audio Lab, first Lab workbench |
| 2 | #18 | Dev Hub, Lab workbench and interaction, smoke volumes, shared human rig, materials, shadow edges, dev control |
| 3 | #20 | View controls, Outbreak interaction and art, locomotion, explosion FX |
| 4 | #21 | Lab layout, generated textures, foliage, zombie AI, looks, Outbreak vignette, Outbreak perf pass |
| 5 | #29, #31 | Outbreak lighting, architecture materials, ground clutter, foliage; ΔE2000 and perf pass below |

Release 5 measured the merged Outbreak look against the 70s sodium paint-over targets with
`LOOK_PHASE=release5 bun games/outbreak/scripts/look-proof.ts`. Combined ΔE2000 went from 13.8 to 6.7: street at
18:00 from 12.8 to 5.8, and the open interior at 19:00 from 14.8 to 7.6. The perf pass brought street and interior
fresh-submit p95 to 18.4 ms at 3456×1894 on the Studio. Full numbers are in #29.
