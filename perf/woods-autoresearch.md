# Woods look benchmark

The production forest renderer, seed 1987, High, 1600×900, DPR 1, frozen poses and lights at time 12 s.
Headless Metal and muted. Run on the Mac mini with approved HiveMind browser admission:

```sh
hivemind run --worker mini --kind browser --browser-approval "Kit: Astra autoresearch on the woods look" -- bun -e '
  const build = Bun.spawn(["bun", "run", "build"], {cwd: "games/woods", stdout: "inherit", stderr: "inherit"});
  if (await build.exited) process.exit(1);
  process.env.AUTORESEARCH_OUT = "captures/woods-autoresearch/run";
  await import("./games/woods/scripts/autoresearch.ts")'
uv run games/woods/scripts/autoresearch-score.py captures/woods-autoresearch/run ~/code/home/artifacts/woods-2026-10-21
```

HiveMind may spill an occupied mini to another worker. Check its receipt and the adapter in `capture.json`; do not label
Pro results as mini timings. Browser jobs fetch `captures/` automatically. Give the shell at least 15 minutes per full run.

`AUTORESEARCH_VARIANTS` accepts JSON rows `{id, look?, quality?, debug?}`. Each row resets to shipped defaults; changes never stack.
`AUTORESEARCH_SHOTS` selects a comma list. `AUTORESEARCH_MOTION=0` skips the temporal probe for early-rejected candidates.
Capture and score files retain every view, raw GPU sample, pose, torch, region and constraint result.
`AUTORESEARCH_ZERO_CONE=off` serves a control bundle with only experiment 8's exact-zero guard removed (asserts exactly
one match). It never changes source or defaults. Bracket a normal run with these controls on the same worker.
`AUTORESEARCH_CALIBRATE=1` also records potential signal gaps from the real depth buffer and terrain heights.
`AUTORESEARCH_SETTLE_FRAMES=1440` selects a separate 24-second long-hold protocol (default remains 240 frames).
`AUTORESEARCH_EXPOSURE=1` records real-meter 16 s dark → 8 s four lights → 24 s dark adaptation trajectories.
An optional third scoring argument supplies the fixed between-beam mask's baseline image directory.

## Score

Lower target distance is better: 60% Lab marginal-histogram Wasserstein distance, 25% regional luminance quantile error,
15% coarse multi-scale luminance SSIM. Upper, middle and ground regions are equally weighted. The paint-overs are not
registered: this is a composition/tone guide, not a realism score. Check images before keeping a numeric win.

- Four original paint-overs: camp, beam, trail and marker.
- Scrawl 1/3/4/6: approximate reconstructed viewpoints from `capture.ts`, scored against checkpoint 2's paint-overs.
  Original Scrawl camera poses were not recorded. Its unwanted washed-out frames are reference evidence, not targets.
- Tone: display-luminance p5, median, p95, fraction below 0.04, and local contrast. Linear-light quantiles are also saved.
- Guards: nondecreasing dark fraction with 0/1/2/4 lights; p5 <0.025; signal at 60 m has on-minus-off p90 ≥0.02 and ≥25%
  of background in the projected shaft. Baseline violations must be reported, not silently waived. The signal uses a
  depth-calibrated −33.25 m lateral offset at 60 m plan distance. At least 40/80 shaft points must be unoccluded;
  only these contribute to the ROI. Missing coverage is invalid evidence, not a brightness failure.
- Motion: 60 frames, 2.1 m/s forward walk, real scene colour and temporal depth readback. Lot's four-texel reprojected
  range comparison counts excursions ≥12/255 as pops and rejects disocclusion; at least 40% valid coverage required.
  Moving illumination and particles also count. Compare only the same scripted path and report baseline repeat noise.
- GPU: discard one warmup, retain nine timestamp samples per view. This uses `ForestView.measure`, which redraws its
  prepared frame. Shadow updates and CPU work are outside that measurement; it is not total application frame latency.

## Results and dead ends

Durable ledger: `~/code/home/artifacts/woods-2026-10-21/autoresearch/LEDGER.md`.
Baseline target distance 0.0700114–0.0700221; pops/frame 1794.88–1808.88. Shared-mini GPU median 14.535–15.218 ms,
with per-view changes up to 3 ms between identical runs: inadequate to resolve a 0.3 ms cost claim.
Dark fraction already falls 62.95% → 22.00% → 22.16% → 20.52%; several p5 values also exceed 0.025.
Those are existing constraint failures, not introduced regressions. The original +14 m signal probe was behind trees
(79/80 points occluded); its apparent 14–16% contrast is invalid. Scoring v2 requires depth evidence and keeps the
original contrast/brightness thresholds. The eight target-view poses and scoring weights are unchanged.

Initial diagnostic captures were invalidated when a CSS selector accidentally made the hidden map's descendant canvases
visible. The fixed harness hides every canvas except `#view`. Do not use the original `baseline` directory's score.

| Experiment | Target distance ↓ | Outcome |
|---|---:|---|
| Baseline / repeat | 0.0700114 / 0.0700221 | Existing darkness and p5 failures |
| phaseG 0.6 | 0.0699377 | Discard: more lit-frame wash |
| mistDensity 0.04 | 0.0706909 | Discard: target regression |
| meterGain 6 | 0.0691818 | Discard: darkness constraints still fail |
| beamAir 1.5 | 0.0697576 | Discard: more lit-frame wash |
| beamMist 2 | 0.0698132 | Discard: constraints still fail |
| fogSamples 6 | 0.0700180 | Discard: within score noise, cost unresolved |
| glare 0 | 0.0702712 | Discard: target regression |
| Exact-zero fog-cone early-out | 0.0700114 | Image-equivalent cost reduction; inherited darkness failures remain |

Experiment 8 is a performance change only, under the existing `torches` opt-in. The same zero product is omitted before
terrain-relative bank lookups and extinction integrals. Classic WGSL hashes pass. Maximum image MAE across 14 views:
0.001192/255 (baseline-repeat maximum 0.266345/255). Pops/frame 1794.95 versus baseline 1794.88–1808.88.

Bracketed mini controls / candidate / controls, one discarded warmup and nine timestamp samples per view:

| View | Control before ms | Candidate ms | Control after ms |
|---|---:|---:|---:|
| Camp | 13.903 | 12.938 | 14.748 |
| Marker | 11.932 | 12.071 | 12.640 |
| Log broadside (k3) | 17.173 | 14.575 | 15.207 |
| Four lights | 17.751 | 15.348 | 16.420 |

All nine candidate samples are below all eighteen control samples for camp, k3 and four lights; marker is inconclusive. Four-light savings are at least
1.071 ms against the faster control. This does **not** meet the 10–12 ms budget across the scene. Full-run medians
were 14.535–15.218 ms before and 13.465 ms after, but those non-bracketed aggregate values include shared-worker load.
Stop after eight experiments: seven appearance trials failed and no look default qualifies. The optimization preserves
the existing image; it does not claim the fixed appearance limits pass. No five-kept-change paint-over checkpoint reached.

The corrected signal probe passes on control, candidate and repeat: 51–57 unoccluded points, p90 luminance delta
0.0801–0.0815, contrast 117–120% (required 0.02 / 25%). The intermediate −12 m gap was too sensitive to foliage
(37–43 visible points); calibration picked −33.25 m before the final repeat.

Checks: Woods app/scripts + server typechecks, production build, 30 Woods tests, 21 fog tests including classic hashes.
Naga is absent on Pro, so shader compilation evidence is the successful mini Metal render, not the skipped validator.
`ws-smoke` passes all five assertions (3.20 KB/s per client), but logs an inherited RPC exception in
`packages/kit/server/room-object.ts:142`: `JsRpcPromise.then(undefined, handler)` rejects its missing success callback.
That server source is byte-identical to starting head `0c9d8cf6`; this is not a clean Worker log and needs a separate fix.

## Round 2: night exposure

Thirteen more experiments (#9–21) compared bounded/slower centre metering, geometric metering, fixed night keys with
small adaptation, fixed exposure, and continuous toes at several strengths. The retained model uses the existing
scene-referred geometric mean, gain 3, key 0.003, offset +1.5 stops, response 0.85 and ±1.5-stop bounds. Exponential
time constants are 0.8 s stopping down / 6 s opening. It adds no GPU pass. The old centre meter remains selectable.

The deeper toes and weakly adaptive fixed keys lost too much faint detail. Their implementation is archived as
`exposure-trials.patch` in the gallery, applied against `9ed0d3c2`; they are not production options. Raw capture JSON
records their exact overrides. The default now uses the retained model; reproduce the old control with
`{exposureModel:"metered",adaptDarken:0.35,adaptBrighten:1.8}`.

| Evidence | Before | Retained |
|---|---:|---:|
| Eight-view distance, equal 24-second holds | 0.0701846 | 0.0673780 (−4.0%) |
| Four-light dark coverage | 17.30% | 45.83% |
| Fixed between-beam dark coverage | 34.78% | 84.21% |
| Four-light p5 | 0.02800 | 0.01766 |
| Scrawl 1 dark coverage | 14.23% | 26.91% |
| Scrawl 6 dark coverage | 0.11% | 8.29% |
| 60 m signal contrast / visible samples | 114.47% / 52 | 114.36% / 56 |
| Reprojected pops/frame | 1811.63 | 1661.70 |
| Maximum exposure step per frame | 0.02328 stops | 0.02207 stops |

The 24-second hold is within ~0.03 stop of the capped dark target. In the 0→4→0-light trace, the candidate opens to
+0.318 / +0.783 / +1.132 / +1.474 stops at 1 / 4 / 8 / 24 seconds after lights go off. Four-second slow-adaptation
screens were transients and are reported separately.

Guard calibration is explicit in the ledger: the old p5 <0.025 guard rejects the camp (0.03980) and marker (0.02802)
targets themselves. Proposed review aids are each target's p5 +0.008 and dark coverage ±12 percentage points. Old
guards stay in scoring output. Several proposed bounds still fail too: k1/k6 are not dark enough, and camp is darker
than its target. This is a retained aggregate/beam-wash improvement for review, not a claim of full target compliance.
The fixed between-beam mask is a screen-space proxy from the previous build's l0/l4 pair, shared by every candidate.

Final production GPU control/candidate/control: camp 12.895/12.849/12.842 ms, k1 11.485/11.467/11.463,
k3 14.419/14.428/14.309, k6 12.559/12.539/12.549, four lights **15.138/15.129/15.162 ms**. Four-light candidate
MAD 0.008 ms. No attributable increase; the 10–12 ms budget is still exceeded. The earlier fog optimization remains.

Checks: Woods app/scripts + server typechecks, build, 30 Woods tests, 5 exposure tests and classic fog pins passed.
Naga remains unavailable (14 validator cases skipped); the production Metal renderer compiled and ran without errors.
Worker code is out of scope and unchanged. Stopped exposure tuning after the toe variants stalled; material work is
deferred at the mandatory paint-over checkpoint.

- [Paint-over checkpoint](https://studio.taila8e7c7.ts.net:8444/raw/woods-2026-10-21/autoresearch/exposure-checkpoint/index.html)
- [Full exposure report](https://studio.taila8e7c7.ts.net:8444/raw/woods-2026-10-21/autoresearch/EXPOSURE-REPORT.md)
- [Live retained preview](https://studio.taila8e7c7.ts.net:5322/arcade/woods/?quality=high)

## Round 3: exposure reset, near-field fog and indexed templates

Rebased onto Woods' updated people and server RPC fix (`4f529455`). Centre meter restores its 0.35/1.8 s response
times in one selection; the other model is labelled **Night log mean**. Benchmark source/output paths resolve from
`import.meta.dir`. Camera cuts invalidate cached and in-flight meter reads; short explicit teleports, regeneration
and eye jumps over 3 m reset exposure and snap to the first new valid meter reading. The Metal probe passes all four
reset cases with zero first-reading stop error.

Experiments #22–32 stopped after eleven trials. Near-camera density falloff (8/12 m), stronger short-range forward
phase, height-dependent thinning and the existing 2 m beam-near radius all preserve a valid 60 m signal, but worsen
the fixed target score. Clearing the air opens auto exposure, lifting the surroundings. A −0.25 stop compensation
restores darker forest frames but makes camp darker too: density-comp distance 0.069345, radius-comp 0.068900 versus
0.067322 baseline; camp darkness 31.7% versus 24.8%. None becomes the default. Exact settings, images and the trial
patch remain in the ledger/checkpoint; the production fog shader and controls retain their pre-trial state.

Three paired removal rounds identify foliage as the main cost: l4 all 15.23 ms, no fog 13.09, no shadow sampling
14.59, no ferns 10.17, no trees 10.20. These removal deltas overlap and cannot be summed. A zero-alpha early return
regressed; specialized foliage shaders and instance culling were removed to keep the retained optimization small.

**Retained #32: byte-exact vertex indexing of instanced forest templates.** Deduplicate complete 32-byte vertices,
preserving triangle order, normals and UV seams. Raster draws use unique vertices plus uint32 indices; shadow draws
keep the original expanded buffers. Static meshes retain their existing path. Additional raster buffers trade memory
and upload-time CPU work for vertex reuse; neither memory nor whole-application frame latency is claimed improved.

Final auto-exposure run (`index-final`): mini/Metal, High, 1600×900, seed 1987, time 12, 1440 settling frames,
one GPU warmup plus nine samples per view. Every one of the 14 candidate view medians is below 12 ms (8.42–11.91).

| View | Before GPU ms | Indexed GPU ms | Candidate MAD ms | Mean absolute pixel difference /255 |
|---|---:|---:|---:|---:|
| Four lights (l4) | 15.1255 | 11.2989 | 0.0116 | 0.1102 |
| Own beam (k6) | 12.5640 | 9.4211 | 0.0051 | 0.0834 |
| Torch off (k1) | 11.4517 | 9.4401 | 0.0142 | 0.0021 |

This is a **25.3% reduction** in the l4 renderer interval. GPU timing excludes CPU work and the separate shadow-update
submission. Isolated fixed-exposure control/candidate/control brackets independently measured l4
15.095/11.315/15.120 ms, k6 12.514/9.400/12.518, k1 11.441/9.421/11.429.

Eight-view distance is effectively stable, 0.06733084→0.06733821 (+0.011%). Final l4/k6/k1 dark coverage is
45.769/8.273/25.560%; p5 is 0.01790/0.03867/0.02635. The original dark-monotone and p5 guards **still fail**;
thresholds and scoring targets did not move. Signal contrast is 113.74%, delta 0.08319, with 56/80 depth-visible
samples. Geometry is byte-equivalent, not a claim of identical final pixels: temporal/raster noise remains.

The capture harness now aligns Halton phase explicitly; dropping temporal history alone does not reset its phase.
Earlier culling/indexing screen edge differences therefore overstate the candidate's pixel impact. The walking
probe also moves the solo state continuously rather than calling the camera-cut API on every frame; older motion
figures from this round are camera-cut stress measurements, not a continuous-walk comparison.
Corrected continuous-walk control/indexed/control: 1645.43/1644.90/1643.25 pops per frame; flicker
0.404860/0.404849/0.404833, with ≥91.78% reprojection coverage. The difference is within repeat noise.
The same short final bracket measured l4 15.108/11.330/15.153 ms, k6 12.546/9.431/12.534,
k1 11.439/9.414/11.609. Its shorter settling is used for timing only, not the final tone comparison.

Checks: packed vertex reconstruction/seam test, exposure tests and classic fog pin pass (27 test entries; 14 Naga
validator cases skip because Naga is absent). Woods app/scripts and server typechecks pass after generating the
build ID. The final Metal run reports zero browser errors. Earlier Woods tests pass after the one distant-simulation
case exceeded five seconds under load and passed its targeted 30-second rerun. Room ws-smoke passes all five
assertions at 3.18 KB/s/client; the post-reload Worker log is free of the inherited `JsRpcPromise.then` error.

- [Before/after and fresh paint-over checkpoint](https://studio.taila8e7c7.ts.net:8444/raw/woods-2026-10-21/autoresearch/index-checkpoint/index.html)
- [Full ledger](https://studio.taila8e7c7.ts.net:8444/raw/woods-2026-10-21/autoresearch/LEDGER.md)
- [Look preview](https://studio.taila8e7c7.ts.net:5322/arcade/woods/?quality=high)
- [Room preview](https://studio.taila8e7c7.ts.net:5298/arcade/woods/)

## Review follow-up: optional clear near air

The density8 idea from #28 is now an off-by-default typed `clearAir` setting. On preview **5322**, press
**Backquote → Mist → Clear air near you**. Off is Today; no other setting needs changing. The forest-only fog hook
multiplies torch in-scatter by 0.1→1 over 8 m, leaving extinction, surface lighting and classic lamps alone.
The −0.25 stop compensation now applies only while the local torch is on (and before exposure clamping). Camp with
the local torch off avoids the former global-offset darkening. With your torch on at camp, compensation still applies.

| View | GPU Today → clear air, ms | Dark coverage Today → clear air | Exposure Today → clear air |
|---|---:|---:|---:|
| l4 | 11.3506 → 11.4031 | 45.78% → 54.44% | 1.077 → 1.096 |
| k6 | 9.4365 → 9.4537 | 8.29% → 15.42% | 0.956 → 0.927 |
| Camp, local torch off | 11.6639 → 11.6329 | 24.78% → 24.77% | 0.803 → 0.803 |

Same 1440-frame fixed protocol on mini/Metal, one warmup + nine GPU samples. Three requested views only; the
original global p5 guard still fails, and this is not an eight-target rerun. The visual trade-off is for Kit to judge.
[Today / clear air / existing paint-over sheet](https://studio.taila8e7c7.ts.net:8444/raw/woods-2026-10-21/autoresearch/clear-air-checkpoint/index.html).

Two review fixes accompany the toggle: pending exposure initially held zero stops until the first valid reading
(bounded by the blocker fix below). Centre-meter response is derived in `adaptForestExposure`, so
0.35/1.8 s applies to preset imports, query params and direct assignments. The configurable response fields now
explicitly tune the night model only; changing models no longer overwrites them through a panel callback.

Checks: 30 Woods tests, app/scripts + server typechecks, seven exposure tests, packed reconstruction test and classic
fog pin pass (29 focused test entries, of which 14 skip Naga validation because Naga is absent). The real-GPU reset
probe holds neutral for three meter-less updates and snaps to the first reading with zero stop error; other reset
cases still pass. The probe first drains automatic renderer work left queued when pausing, so a later scheduled
startup frame cannot be mistaken for an old in-flight readback. The Metal run has no browser errors.

### Exposure-hold blocker fix

Only an enabled, pending meter holds neutral exposure after a cut, for at most 0.5 s. Timeout or readback failure
clears the hold and starts normal adaptation; a late recovery cannot snap. Readback failures invalidate the cached
reading and are generation-guarded, so a stale rejection cannot poison a new scene. A successful read/reset clears
failure. With no meter, every frame takes the fallback target immediately, preserving smoke before `0c2cdc70`.

Woods tests, app/scripts and server typechecks, production build and 35 focused test entries pass, including the
classic fog pin, no-meter and never-arriving-reading regressions, timely/late recovery and actual readback callback
failure/reset tests. Fourteen Naga entries still skip validation because Naga is absent. The headless, muted Metal
production smoke passes and compares the real forest exposure against the pre-hold fallback law: eight exact
matches across both exposure models, torch on/off and changing sky. Checks ran on Pro through HiveMind and skulk.

## Source findings

- The camp wire already exists (`forest/build.ts`, 60 sagging segments, 6 mm radius); its visibility is the gap.
- Scanned roots already surround large non-birch trunks (`r >=0.36`), and moss already blends into the ground.
  Increasing detail means changing distribution/material response, not implementing absent asset support.
- Forest-only fog work must remain behind `torches` / stratified-bank opt-ins; default WGSL hashes stay pinned.
