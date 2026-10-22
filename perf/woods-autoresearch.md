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

`AUTORESEARCH_VARIANTS` accepts JSON rows `{id, look?, quality?}`. Each row resets to shipped defaults; changes never stack.
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

## Source findings

- The camp wire already exists (`forest/build.ts`, 60 sagging segments, 6 mm radius); its visibility is the gap.
- Scanned roots already surround large non-birch trunks (`r >=0.36`), and moss already blends into the ground.
  Increasing detail means changing distribution/material response, not implementing absent asset support.
- Forest-only fog work must remain behind `torches` / stratified-bank opt-ins; default WGSL hashes stay pinned.
