---
name: procedural-animation-iteration
description: Measure-first loop for tuning or fixing procedural character animation in arcade (shared human rig, gait, walk/run/sprint cycles, foot contact, COM bob, arm swing, rig poses, IK). Use when Kit says a walk, run, arm, stride or pose "looks wrong", before changing human-locomotion.ts or human-pose.ts, or when comparing the rig against mocap or Williams key poses.
---

# Procedural animation iteration

Never tune locomotion by eye alone. Turn Kit's feel note into numbers and line-rig sheets, find
the cause in the shared rig, fix it there, measure again, then show Kit. Two passes on 2026-10-14
showed this works:

- Walk audit (`~/code/home/artifacts/2026-10-14-walk-audit/`): survivor run L/R step ratio went
  from 1.45 to 1.00, step-time CV from 18.5% to 1.2%, contact foot speed from 0.63 to 0.03 m/s.
  The walk's COM subharmonic ratio fell from 0.92 to 0.03 and touchdown jerk from 279 to 90 m/s³.
- Pose diff (`~/code/home/artifacts/2026-10-14-pose-diff/`): arm angle RMSE against mocap went
  from 12.7° to 2.6° for the walk and from 31.7° to 7.6° for the run.

Read `docs/human-rig.md` (especially "Pose diff workflow") and the "Human animation" section of
`docs/game-notes.md` first.

## The loop

1. **Write down Kit's note as a claim you can test.** "The run limps" means unequal L/R step time
   or length. "The body bounces twice" points at a COM subharmonic. "The arms look stiff" means a
   small elbow range or a phase lag. Pick the metric before opening any code.
2. **Drive the rig with deterministic inputs.** Use fixed `dt = 1/60`, a constant speed per mode
   (walk 1.4, run 4.2, sprint 6.3 m/s), a warm-up, then several full cycles. Call `animate` or
   `locomotion` directly from a Bun script, not through the browser, so runs are repeatable and
   fast. Cover every consumer: Blackout survivor, Blackout soldier and Outbreak survivor.
3. **Compute metrics.** These are the ones that caught real bugs:
   - step duration and step length L/R ratio (target 1.00 ± 0.01) and step-time CV (under 2%)
   - cadence in steps/min, double-support % for walks and flight % for runs
   - pelvis/head vertical amplitude, plus a spectrum of the pelvis curve. Energy at half the step
     frequency (the subharmonic ratio) means the left and right steps differ.
   - peak pelvis acceleration and jerk, especially around touchdown
   - contact foot speed while planted (should be close to zero)
   - arm vs opposite-leg correlation and phase lag (target above 0.9 and under 10°)
4. **Render line-rig key-frame sheets.** Show 8 and 16 evenly spaced phases from left heel strike
   to left heel strike, orthographic side and front views. Normalise to hip height 1 with the
   pelvis at the origin. Draw left limbs blue, right limbs orange, the spine white and the weapon
   gold. Flat sheets show pose errors that shaded 3D frames hide.
5. **Get reference joints.** Retarget CMU BVH mocap onto the exact `RIG` link lengths and build
   Richard Williams key poses (Contact, Down, Passing, Up) with `jointsFromAngles`. Phase-align both
   at left heel strike. Optionally paint over a sheet to show the intended pose and run a pose
   estimator on it to get a third target.
6. **Diff against the references.** Overlay our rig on each reference with per-joint error vectors
   and Δangle labels. Plot shoulder flexion and abduction, elbow flexion, forearm pitch, wrist
   path relative to the hip, and hip/knee/ankle across the cycle. Report RMSE per angle.
7. **Find the cause in the shared rig.** Most problems live in `packages/kit/human-locomotion.ts`
   or `packages/kit/human-pose.ts`, not in one game. Find the cause before changing constants. A
   tweaked amplitude that hides a coupling bug will come back in another mode.
8. **Fix it, then run the same script with a new tag.** Put before and after numbers side by side.
   Check that metrics you did not target have not regressed.
9. **Keep soldier parity and tests green.** Run `bun games/blackout/scripts/prove-human-parity.ts`.
   It checks soldier posture, weapon stability and 900-frame pose hashes. If the soldier's motion is
   meant to change, update the `new` hash on purpose and say why in the comment beside it. Add unit
   assertions for the metric you fixed to `packages/kit/human.test.ts` or
   `games/blackout/tests/anim.test.ts`, run `bun run check:packages` at the root, then
   `bun run check` in each affected game.
10. **Ship, then show Kit.** Put the before/after sheets, plots and a summary JSON under
    `~/code/home/artifacts/<date>-<topic>/`. Open the live result with `arcade tour` or
    `arcade note` (`docs/dev-control.md#show-kit-things`). Record any technique that proved itself
    in `docs/game-notes.md`.

## Tools

- `packages/kit/pose-diff.ts` (`@arcade/kit/pose-diff`): joint extraction (`extractBodyJoints`,
  `extractBonePoseJoints`), `normalizeJoints`, `projectOrtho`, `computePoseAngles`, `parseBvh`,
  `extractBvhCycle`, `retargetBvhFrame`, `buildWilliamsReferenceCycle`, `jointsFromAngles`,
  `buildCycleFromJointFrames` and `compareCycles` (angle RMSE, position RMSE, error vectors).
- `games/blackout/scripts/pose-diff.ts`: samples Blackout survivor, soldier and Outbreak survivor
  walk/run cycles, compares them with mocap and Williams, writes `pose-diff-<tag>.json` and calls
  `pose-diff-render.py` (matplotlib) for line-rig sheets, overlays and angle plots.

  ```sh
  bun games/blackout/scripts/pose-diff.ts --tag before --out ~/code/home/artifacts/<date>-pose-diff \
    --bvh-dir ~/code/home/artifacts/2026-10-14-walk-audit/mocap [--baseline <repo>] [--no-render]
  ```

  The BVH files (`walk_normal_001.bvh`, `dataset-2_run_normal_001.bvh`) are not in the repo, so pass
  `--bvh-dir`.
- Walk audit scripts, kept in `~/code/home/artifacts/2026-10-14-walk-audit/` and not yet in the repo:
  `measure-and-plot.ts` computes the gait metrics in step 3, `plot_curves.py` plots them, and
  `render-sheets.ts`, `render-video.ts` and `stitch_sheets.py` render shaded 3D sheets through Vite
  and Playwright. They import from an absolute worktree path, so repoint the imports before
  reuse. Move them into `games/blackout/scripts/` when they are next needed.
- `games/blackout/scripts/prove-human-parity.ts [baselineRepo]`: soldier parity gate. It exits
  non-zero on failure.

## Pitfalls we hit

- **IK chord coupling.** Cartesian hand offsets fed into two-bone IK tie the elbow angle to the
  shoulder-to-hand distance. The elbow flexed at mid-swing and straightened at the peak, the
  opposite of mocap. Drive arms with FK shoulder and elbow angles calibrated from mocap, and
  build the hand target from those angles (`unarmedHands` in `human-pose.ts`).
- **Pole vectors crossing.** A fixed pole can pass through the arm plane on the backswing and
  flip the elbow, which produced 41° of abduction. Make the pole adapt to chord length so the
  elbow stays behind the shoulder-to-wrist line (`poseUnarmedArms`).
- **Abduction collapse.** Hand targets inside shoulder width drive abduction to zero, so the arms
  look pinned to the body. Give abduction its own baseline angle (about 12° walking, 14° running)
  rather than letting it fall out of the hand position.
- **Independent foot oscillators.** Separate per-foot timers drift into a locked stagger (45% in
  the run, 12.5% in the walk). Schedule steps from one phase-locked, anti-phase stride clock.
- **Phase wrap from stride mismatch.** If the stride length disagrees with distance travelled,
  the phase wraps unevenly and causes a bob that beats every few steps. It shows up as a
  subharmonic, not as a visible single-frame glitch.
- **Impulses cause jerk.** A touchdown dip added as an impulse produces large jerk spikes. Build
  the COM as one smooth Contact→Down→Passing→Up curve sampled from phase.
- **Double attenuation.** Outbreak scaled arm swing down in the shared rig and again in
  `survivor.ts`. Before a game damps a shared output, check whether the rig already damps it.
- **Stale Vite prebundle.** Render scripts that serve a game through Vite can show old
  `@arcade/kit` code. Use `optimizeDeps: { force: true }` and check that a known change shows up.
- **Headless video frame rate.** Headless Chrome cannot hold 60 fps, so recorded motion stutters
  even when the animation is smooth. Judge from deterministic stills, sheets and numbers. Use video
  only to show the result to Kit.
- Leg angles still differ from mocap (knee about 15° RMSE, ankle about 19° RMSE in the walk). These
  have not been fixed yet, so do not report them as solved.
