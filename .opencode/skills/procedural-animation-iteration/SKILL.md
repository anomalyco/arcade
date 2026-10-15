---
name: procedural-animation-iteration
description: Measure-first loop for tuning or fixing procedural character animation in arcade (shared human rig, gait, walk/run/sprint cycles, foot contact, COM bob, arm swing, rig poses, IK). Use when Kit says a walk, run, arm, stride or pose "looks wrong", before changing human-locomotion.ts or human-pose.ts, or when comparing the rig against mocap or Williams key poses.
---

# Procedural animation iteration

Never tune locomotion by eye alone. Turn Kit's feel note into numbers and line-rig sheets, find
the cause in the shared rig, fix it there, measure again, then show Kit. Two passes on 2026-10-14
showed this works:

- Walk audit: survivor run L/R step ratio went from 1.45 to 1.00, step-time CV from 18.5% to 1.2%,
  contact foot speed from 0.63 to 0.03 m/s. The walk's COM subharmonic ratio fell from 0.92 to 0.03
  and touchdown jerk from 279 to 90 m/s³.
- Pose diff: arm angle RMSE against mocap went from 12.7° to 2.6° for the walk and from 31.7° to
  7.6° for the run; in the run-realism pass, leg angle RMSE fell from 12.2° to 9.2° (walk), 24.5° to
  16.9° (run, peak foot lift 19.5 → 38.9 cm, peak knee flexion 102.6° → 119.0°), and 31.8° to 15.2°
  (Outbreak run), with seeded per-step blue-noise variation (`stepVariation = 0.35`).

Read `docs/animation.md` first. It has the rules the rig follows, current values for every metric
below, the causes of past bugs and the known gaps. `docs/human-rig.md` has the module API.

## The loop

1. **Write down Kit's note as a claim you can test.** "The run limps" means unequal L/R step time
   or length. "The body bounces twice" points at a COM subharmonic. "The arms look stiff" means a
   small elbow range or a phase lag. Pick the metric before opening any code.
2. **Measure the current code first.** Run `gait-metrics.ts` and `pose-diff.ts` with `--tag before`
   (see Tools). They drive `animate`/`locomotion` from Bun with fixed `dt = 1/60`, constant speeds
   (walk 1.4, run 4.2, sprint 6.3 m/s), a warm-up and several cycles, for every consumer: Blackout
   survivor, Blackout soldier and Outbreak survivor. Add a case to the script if the note concerns
   a situation they do not cover, such as a reversal or a strafe.
3. **Read the metrics.** These caught real bugs; targets and current values are in
   `docs/animation.md`.
   - step duration and step length L/R ratio and step-time CV
   - cadence in steps/min, double-support % for walks and flight % for runs
   - pelvis and head vertical amplitude, and the subharmonic ratio (energy at half the step
     frequency means the left and right steps differ)
   - peak pelvis acceleration and jerk, especially around touchdown
   - contact foot speed while planted
   - arm vs opposite-leg correlation and phase lag
4. **Look at the line-rig sheets.** `pose-diff.ts` draws 8 and 16 evenly spaced phases from left
   heel strike to left heel strike, orthographic side and front, normalised to hip height 1 with the
   pelvis at the origin: left limbs blue, right orange, spine white, weapon gold. Flat sheets show
   pose errors that shaded 3D frames hide.
5. **Diff against the references.** `pose-diff.ts` retargets the mocap clips onto the exact `RIG`
   link lengths and builds Richard Williams key poses (Contact, Down, Passing, Up), both phase-aligned
   at left heel strike. Read the overlays (per-joint error vectors and Δangle labels), the angle plots
   (shoulder flexion and abduction, elbow, forearm pitch, wrist path relative to the hip, hip, knee
   and ankle) and the RMSE per angle. Optionally paint over a `render-sheets.ts` sheet to show the
   intended pose and save it as `<mode>-sheet-ideal-side.png` in the output folder; `pose-diff` and
   `render-sheets` then add it to their comparisons.
6. **Find the cause in the shared rig.** Most problems live in `packages/kit/human-locomotion.ts`
   or `packages/kit/human-pose.ts`, not in one game. Check `docs/animation.md` for a past cause that
   matches. Find the cause before changing constants: a tweaked amplitude that hides a coupling bug
   comes back in another mode.
7. **Fix it, then rerun with `--tag after`.** Both scripts plot before and after together when both
   tags are in the same output folder. Check that metrics you did not target have not regressed.
8. **Keep soldier parity and tests green.** Run `bun games/blackout/scripts/prove-human-parity.ts`.
   It checks soldier posture, weapon stability and 900-frame pose hashes. If the soldier's motion is
   meant to change, update the `new` hash on purpose and say why in the comment beside it. Add unit
   assertions for the metric you fixed to `packages/kit/human.test.ts` or
   `games/blackout/tests/anim.test.ts`, run `bun run check:packages` at the root, then
   `bun run check` in each affected game.
9. **Ship, then show Kit.** Put the before/after sheets, plots and a summary under
   `~/code/home/artifacts/<date>-<topic>/`. Open the live result with `arcade tour` or
   `arcade note` (`docs/dev-control.md#show-kit-things`), or the Characters page
   (`/arcade/blackout/characters.html`).
10. **Record what you learned.** Update the rule, numbers and known gaps in `docs/animation.md`.
    Change this skill only when the procedure or tools change.

## Tools

All live in `games/blackout/scripts/animation/` and run from the repository root or `games/blackout`.
Output goes to `captures/animation/<tool>/` (git-ignored) unless you pass `--out`. The first bare
argument or `--tag` names the pass.

```sh
bun games/blackout/scripts/animation/gait-metrics.ts --tag before [--out dir] [--no-plot]
bun games/blackout/scripts/animation/pose-diff.ts --tag before [--out dir] [--baseline <checkout>] [--no-render]
bun games/blackout/scripts/animation/render-sheets.ts --tag before [--out dir]
bun games/blackout/scripts/animation/render-video.ts [--out dir]
bun games/blackout/scripts/animation/strafe.ts --tag before [--out dir] [--no-render]
bun games/blackout/scripts/animation/render-strafe-video.ts --tag before|after [--outbreak-root dir] | --stitch
```

- `gait-metrics.ts`: the step-3 metrics for nine actor/speed cases plus mocap reference curves, saved
  as `<tag>-data.json`. `gait-plots.py` (Pillow) draws `*-curves-<tag>.png`, and
  `*-curves-overlay.png` when a `before` run is in the same folder. Takes about 2 s.
- `pose-diff.ts`: joint cycles compared against mocap and Williams, saved as `pose-diff-<tag>.json`.
  `pose-diff-render.py` (Pillow) draws `line-rig-*`, `overlay-diff-*`, `overlay-compare-*` and
  `angles-*` PNGs. `--baseline <checkout>` also samples another checkout's arm and Outbreak code as
  the `before` pass. Takes about 4 s.
- `render-sheets.ts`: shaded 3D sheets of the unarmed survivor (8 phases, side and three-quarter, with
  onion skins and contact markers) through the real Characters page on headless Chrome/Metal.
  `stitch-sheets.py` builds `*-sheet-<tag>-*.png` and before/ideal/after comparisons. Takes about 2 min.
- `render-video.ts`: a 4 s side-view clip, 2 s walking then 2 s running, encoded with ffmpeg. Use it
  only to show Kit, not to judge timing (see Pitfalls).
- `strafe.ts`: travel-vs-aim sweep (0° to 180°, slow/walk/jog/run) for survivor, soldier and Outbreak's
  aimed survivor, aim sweeps and circle strafes, against the mocap walk-left/right/back clips and the authored
  side-step and crossover references in `strafe-reference.ts`; saved as `strafe-<tag>.json`.
  `strafe-render.py` (Pillow) draws top and front `line-rig-*` sheets (before | reference | after),
  `angles-*` and `sweep-*` plots.
- `render-strafe-video.ts`: muted top-down Outbreak clip circle-strafing a target while aiming at it;
  capture each checkout's frames, then `--stitch` before | after.
- `common.ts`: argument parsing, paths, and the mocap loader. The walk and run BVH clips download
  into `fixtures/mocap/` on first use and are hash-checked; pass `--bvh-dir` to use local copies.
- `@arcade/kit/pose-diff` (`packages/kit/pose-diff.ts`): `extractBodyJoints`, `extractBonePoseJoints`,
  `normalizeJoints`, `projectOrtho`, `computePoseAngles`, `parseBvh`, `extractBvhCycle`,
  `retargetBvhFrame`, `buildWilliamsReferenceCycle`, `jointsFromAngles`,
  `buildCycleFromJointFrames` and `compareCycles`.
- Other proofs in `games/blackout/scripts/`: `prove-human-parity.ts [baselineRepo]` (soldier parity
  gate, exits non-zero on failure), `prove-characters.ts` and `prove-human.ts` (Characters page,
  profiles, detach), `prove-animation.ts --video` with `animation-film.sh` and `animation-sheet.py`
  (Old/New film and contact sheet), `prove-running.ts` with `running-metrics.ts`, `running-sheet.py`
  and `running-film.py` (run posture and weapon stability), `prove-soldier-run.ts`.

## Pitfalls

- **Stale Vite prebundle.** Scripts that serve a game through Vite can show old `@arcade/kit` code.
  The render scripts use `optimizeDeps: { force: true }`; check that a known change shows up.
- **Headless video frame rate.** Headless Chrome cannot hold 60 fps, so recorded motion stutters
  even when the animation is smooth. Judge from deterministic stills, sheets and numbers.
- **Equal time is not equal phase.** When comparing two versions with different stride clocks,
  align frames by left heel strike, not by timestamp.
- **Paint-overs are art targets.** They show the intended pose; mocap and the metrics are the
  biomechanical reference.
- **Check late-swing knee extension.** Walk leg RMSE is 9.2° and run leg RMSE is 16.9° (Outbreak run
  15.2°); the remaining run knee error is concentrated in late swing (`7/8`) where the heel-tuck
  tapers before touchdown (`docs/animation.md`, Known gaps).
