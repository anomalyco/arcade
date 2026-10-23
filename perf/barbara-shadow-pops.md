# BARBARA shadow pops

## Status

Camp shipped in [#465](https://github.com/anomalyco/arcade/pull/465), squash commit
`f0577ca81d86e26313d32844635f5558236056aa`, with 13/13 checks passing. `release-4` was fast-forwarded.
`barbara-shadow-pops` starts there in the reused `woods-autoresearch` worktree.

The retained candidate gives the torch contact-hardening shadows from its existing 2 cm lens radius.
Excursions fall 14.0% and the worst spike falls 31.8%. Kit judged that insufficient to ship alone.
It remains unmerged. The follow-up's four diagnostic probes and three bounded correction attempts did not
establish a clear additional win; all follow-up production changes were reverted (details below).
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

## Round 2: remaining excursions, one layer at a time

Same six-second walk, mini/Metal, seed, resolution and camera protocol as round 1. The control includes the
unmerged lens-radius candidate. Its 553.122 excursions/frame matches the earlier 553.156. Each probe ran once;
the typed-array generic correction was caught by typecheck before any browser launched.

| Single toggle | Excursions/frame | Peak | Rough GPU ms | Change vs lens control |
| --- | ---: | ---: | ---: | ---: |
| Lens control | 553.122 | 1,353 | 12.509 | — |
| Conservative fixed near-detail caster set | 553.200 | 1,353 | 12.502 | +0.014% |
| Texel-snapped torch projection | 553.389 | 1,353 | 12.568 | +0.048% |
| Visible wind amplitude zero | 508.267 | 1,279 | 12.942 | −8.1% |
| Bypass only TAA colour-history clipping | 414.828 | 1,224 | 12.907 | −25.0% |

### Caster admission and culling

The production `ForestPass.update` selects per-chunk near/far geometry and builds raster instances using
camera-frustum and distance tests; `casters` reuses those draws. Round 2's `caster-cone` removes all three
dependencies: fixed independent buffers of near-detail geometry over the entire walk and torch reach +16 m,
with no raster-frustum, near/far LOD or small-object-distance changes. This conservative superset covers the
torch cone even outside the camera view. It is a diagnostic, not a proposed culling implementation.

Control membership changes: 2 baked-chunk members, 5 tree opaque, 5 tree masked (branches), 15 fern opaque,
933 fern masked, 1 rock and 44 floor members. These are mesh-membership events, not unique plant counts.
The conservative fixed set removes the transitions without reducing excursions. Admission is therefore not
the useful correction on this walk, although other paths may expose a culling issue.

### Projection stability

`texel-grid` snaps projected coordinates at a fixed world anchor to the actual map grid and writes the same
matrix to both map rendering and receiver sampling. The probe verifies that near/far remain 0.25/40 m for the
entire run; they were already stable. The original perspective projection still rotates with the torch, so
anchoring one point does not eliminate all rotational resampling. This tested snap gives no useful reduction.

### Foliage animation

`forestShadowInstanceWgsl` transforms static casters with no wind; `vsTree` applies `woodsWind` in the main pass.
This is a real mismatch. Disabling only the visible wind amplitude makes the two geometries agree and removes
8.1% of excursions, but also removes genuine visible motion. It does not quantify a production wind-matching
fix; no wind removal is retained.

### Temporal history

The diagnostic replaces only the colour clip with the unbounded history colour, preserving depth/disocclusion
validation, reactive weighting, blend weight and signed-alpha handling. Its 25% reduction is the largest among
these toggles, but **is not proof that clipping causes 25% of artifacts**: retaining old light can reduce the
metric by smearing a legitimate shadow change. The bounded attempts below did not reproduce that benefit.
The four reductions overlap and cannot be added or used to partition the remaining 86% into causes.

## Rounds 3–5: bounded corrections, rejected

| Round | Change on top of lens candidate | Excursions/frame | Peak | Rough GPU ms | Decision |
| --- | --- | ---: | ---: | ---: | --- |
| 3 | Forest-opt-in 3×3 neighborhood bounds instead of variance bounds | 551.311 | 1,419 | 12.990 | −0.3% vs lens; reject |
| 4 | Same bounds, clamp luminance/chroma independently rather than along a ray to the box centre | 539.761 | 1,419 | 12.522 | −2.4% vs lens, worse peak; reject |
| 5 | Original TAA; no-blocker PCSS fallback uses ordinary PCF instead of fully lit | 551.000 | 1,351 | 12.561 | −0.4% vs lens; reject |

Round 4 is 16.1% below shipped Today (643.544), only slightly beyond the rejected-alone lens candidate's 14.0%.
There is no demonstrated cost blow-up, but also no clear combined win. Its peak is 4.9% worse than lens-only.
Round 5 tests a concrete inconsistency between `spotShadowVisArea`'s documented sharp fallback and its fully-lit
no-blocker return; correcting that branch was not a useful improvement on this walk either.

All three revisions were captured once. Their clips and source-hashed JSON remain on the existing synchronized
page. The production TAA and fallback changes were removed; only the original local lens commit remains as a
production candidate. No shadow PR, merge or deployment was made.

### Sudden-light and trailing regression fixture

`scripts/barbara-temporal-response.ts` constructs the production `TemporalResolve` on the game's WebGPU device.
A 32×16 HDR fixture settles for 24 frames, changes a uniform light from 4 to 0.01 and back, then shifts a bright
one-pixel edge by 16 pixels. It also forces depth rejection and compares with a cold resolve at identical jitter,
and checks signed/tagged alpha (−2 and +5). This is a GPU shader fixture, not a whole-scene torch-response clip.

Rounds 3 and 4 both pass: first-dark-frame maximum linear-HDR error 0.00000550; first-bright-frame error 0.001953;
old edge outside the current neighborhood 0.00000550; depth-rejected versus cold output exactly equal; alpha
exact. Round 5 passes with errors 0.00000214 / 0.003906 / 0.00000550 and exact depth/alpha results. This rules out
long trails in those fixtures, not all motion ghosting or color changes in the game.

### Checks and evidence

- Strict mini pin for every round-2–5 browser job, headless and muted. No browser/GPU errors.
- BARBARA and root-script typechecks passed before round 3; temporal/physical tests reported 10 passes, including
  five Naga validations skipped on mini. Actual production shaders compiled and rendered on Metal.
- Round 5's spot-shadow tests reported 9 passes, including one skipped Naga validation. Each changed shader
  revision built before its one capture. No broad suites or repeat passing capture runs.
- `round2/` on the published page has all four diagnostics, control JSON and its clip. `round3/`, `round4/`,
  `round5/` retain the combined trials and response results. Rejected production patches are archived with the
  trials so source hashes can be checked against reconstructed revisions.

**Outcome:** the requested probes narrow the search, but do not identify a dominant *correctable* cause with a
successful bounded fix. The aggregate metric still mixes real moving illumination/wind with unwanted pops.
The next useful evidence would separate shadow visibility from the composited image at the offending pixels;
relaxing TAA further on the present score alone is not justified.
