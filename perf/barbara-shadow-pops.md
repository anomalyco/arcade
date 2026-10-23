# BARBARA shadow pops

## Status

Camp shipped in [#465](https://github.com/anomalyco/arcade/pull/465), squash commit
`f0577ca81d86e26313d32844635f5558236056aa`, with 13/13 checks passing. `release-4` was fast-forwarded.
`barbara-shadow-pops` starts there in the reused `woods-autoresearch` worktree.

The retained candidate gives the torch contact-hardening shadows from its existing 2 cm lens radius.
Excursions fall 14.0% and the worst spike falls 31.8%. It awaits visual review and is not deployed.
This is a partial improvement: the metric also counts genuine moving illumination and wind, so it cannot
establish that the remaining excursions are sampling errors or that all visible pops are fixed.

## Method

`scripts/barbara-shadow-probe.ts` runs the production BARBARA bundle with the existing depth-reprojected
`autoresearch-motion.ts` walk: seed 1987, High, 1600×900, 120 settled frames at time 12, 180 comparisons at
30 fps and 0.7 m/s. Physical sky and camp remain on. The walk covers 4.2 m north of camp. It holds bot steering,
uses one torch, and records caster membership as well as the image metric. Reprojection coverage stays above
91.89% for every sample. Headless, muted Chromium on mini/Metal through HiveMind; each valid probe ran once.

```sh
HIVEMIND_STRICT_PIN=1 hivemind run --worker mini --kind browser \
  --browser-approval '<Kit requested the three shadow measurements>' -- \
  sh -c 'bun run --cwd games/barbara build && ARCADE_BROWSER_BUDGET_S=300 bun scripts/barbara-shadow-probe.ts'
```

`SHADOW_PROBES` selects individual probes; `SHADOW_OUT` chooses their capture directory. Per-probe JSON includes
source hashes, settings, hardware, every frame, membership counts, rough timing and errors. The candidate uses
`SHADOW_PROBES=candidate`. The `.mp4` files are encoded from the measured frames, not another capture.

## Single-measurement diagnosis

| Probe | Excursions/frame | Peak | Result |
| --- | ---: | ---: | --- |
| Current camp default | 643.544 | 1,983 | Baseline |
| Actual 2048² map instead of 1024² | 735.517 | 2,301 | +14.3%; more resolution alone worsens the metric |
| Freeze visible forest wind at time 12 | 598.544 | 1,910 | −7.0%; motion/mismatch contributes but is not dominant |
| Fixed conservative caster union over the whole walk | 643.883 | 1,984 | +0.05%; admission is immaterial on this path |

`forestShadowInstanceWgsl` has no wind: the shadow geometry is already static. The leaf-motion probe freezes
visible receivers only. It measures their motion and mismatch with static shadows, not a separate animated
caster system. The admission probe uses independent instance buffers and near geometry over the whole path,
without camera-frustum cuts. It admits 1,366 members with zero changes, versus 751–1,074 and 1,005 additions/
removals over 11 frames in the baseline. All eight largest baseline spikes have zero membership changes.
Its shadow triangle count increases from 1.21 M at the first sample to a constant 4.14 M; it is diagnostic only.

Together with round 5's shadow-off result, these observations point toward the moving, sharply sampled shadow
edges. They rule out caster admission as the useful fix on this walk and limit the wind contribution. They do
not prove that every moving-shadow excursion is aliasing.

## Candidate and rejected work

Using the geometric normal for shadow lookup/bias gave 644.206 excursions/frame, so that change was removed.
The retained change reuses `spotShadowVisArea` through an opt-in `PhysicalLightOptions.spotShadowRadius`
expression. BARBARA's forest supplies `L.extra.z`, the torch's existing 0.02 m radius. The blocker search and
receiver distance produce the penumbra; the sampling pattern is fixed rather than rotated each frame. The
default physical-light shader output and other consumers retain their existing path.

| Measure | Baseline | Lens candidate |
| --- | ---: | ---: |
| Excursions/frame | 643.544 | 553.156 (−14.0%) |
| Largest excursion frame | 1,983 | 1,353 (−31.8%) |
| Mean range disagreement, display levels | 0.365188 | 0.363859 |
| Rough renderer timing, ms | 11.97 | 12.73 |

The timing is three samples per variant on a shared worker, not a stable incremental-cost claim. The whole
image's mean disagreement barely changes; the improvement is concentrated in the largest shadow transitions.
Moon and volumetric shadow sampling still use their existing paths. No geometry fade, caster-culling change or
leaf-animation change is retained.

## Verification and setup failures

- BARBARA typecheck and production build pass. The root probe script also passes Getaway's scripts typecheck.
- The earlier spot-shadow and physical-light tests passed (14). After adding the lens path, physical-light and
  default-look tests passed (12). Five WGSL validations in that second run were unavailable because mini has no
  Naga; the real WebGPU candidate compiled and ran with zero browser/GPU errors.
- The first sampling attempt changed the settings object without calling the quality setter, so the GPU map
  stayed 1024². Its 643.806 result is preserved as invalid and excluded. The corrected probe asserts the actual
  GPU texture size is 2048².
- The first leaf-motion attempt matched several shader clock declarations and failed before measurement.
  Its replacement targets only the wind function's clock. The baseline was reused.
- HiveMind once spilled the candidate job onto Studio. The host assertion stopped it before browser launch;
  the successful measurement used a strict mini pin. Typechecks/tests that had already passed were not repeated
  until production code changed again.

Evidence: [synchronized current/candidate review](https://studio.taila8e7c7.ts.net:8444/raw/barbara-shadow-pops-2026-10-22/index.html).
The published folder keeps both final clips and all diagnostic JSON, including the rejected bias result and
invalid sampling attempt. `SHADOW_OUT` defaults to `captures/barbara-shadow-pops/` for future reproductions.
