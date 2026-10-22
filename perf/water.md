# Shared water, 2026-10-22

Target: convincing continuous water at 60 fps on mini (M4 Pro), 1920×1080.
Primary metric: paired whole-frame GPU timestamp median delta; budget 1.5 ms for the
first shading-only ocean candidate. Secondary: shader errors, default pixel parity,
far-wave stability, CPU/GPU swell agreement. Measurements below are whole-frame, not water-pass isolation.

Baseline: origin/main 52e5b830. Carrier's existing deterministic Gerstner sea,
camera-relative clipmap, crest-memory taps and camera-centred wake field stay authoritative.

Hypothesis 1: continuous analytical normals, band-limited short waves and physically
bounded specular produce most of the reference's improvement without replacing the
physics sea or paying for a spectral simulation. Keep/discard awaits the matched captures.

Commands: `HIVEMIND_STRICT_PIN=1 hivemind run --worker mini --kind browser --browser-approval "Kit: Astra water" --fetch captures/water -- bun scripts/water-proof.ts`.

Targets must precede appearance changes. Carrier revised target is published; woods paint-over pending.

## Capture setup

1. Initial mini run failed before rendering: missing `shared/build.gen.ts`. Fixed the harness to call the existing build-ID writer before starting Vite.
2. Next run spilled from busy mini to Studio, where fixed port 5297 was occupied. No frame captured. Added strict HiveMind pin, a mini hostname guard and a dynamically allocated server port.
3. Strict-mini run passed: `captures/water/carrier-today.png`, 1280×720 viewport, seed 7, sea time 120 s, hour 15, camera `0,0,30,18,550`. No page errors. Adapter-info serialization initially produced `{}`; corrected to copy explicit fields for the next run. No GPU timing was collected in this baseline run.

Observed: large individual blue facets, bright crest foam, sparse glitter, and a capture-zone ring over the left half of the sea. The ring and sky are outside this water experiment. Target edit requested against this exact screenshot.

Research checkpoint: `~/code/home/artifacts/water-2026-10-22/RESEARCH.md`.

## Candidate 1

Continuous normals from the existing packed Gerstner waves, six filtered short-wave normal bands, unresolved slope variance in GGX roughness, sky Fresnel, existing foam/wakes. Separate lazy pipeline, Today by default; no geometry or physics change.

First GPU attempt: Carrier typecheck passed; shader failed because `filter` is a reserved WGSL word. Renamed it to `bandWeight`. This attempt's captures/timings are invalid and must not be cited. The proof now fails before recording timings on shader errors.

Corrected run: no shader/page errors on mini, Metal, 1920×1080. Whole-frame
ABBA medians 3.588 / 4.068 / 5.729 / 6.499 ms; p95 11.654 / 11.586 / 15.050 /
7.987 ms. Baseline drift overwhelms the budget, so cost is **inconclusive**, not
a measured saving. The still exposes an over-wide bright sun path, regular wave
bands and remaining flat-interpolated crest tint. Not a keeper yet.

Candidate 2 corrects the finite sun's missing lobe-energy normalisation, smoothly
interpolates the presentation crest tint, uses the actual shaded normal for sky
Fresnel and distributes the detail across twelve weaker bands at 9.6–0.72 m.
Geometry and authoritative sea stay unchanged. Next measurement uses seven
alternating pairs rather than one long ABBA sweep.

## Candidate 2

Mini M4 Pro, Metal timestamps, 1920×1080, 120 warmup frames and 40 samples per block,
seven alternating pairs. No shader/page errors. Raw results: `captures/water/candidate-2/`.

| Pair | Today median ms | Candidate median ms | Delta ms |
| --- | ---: | ---: | ---: |
| 1 | 6.482026 | 4.177477 | -2.304549 |
| 2 | 6.497651 | 3.954064 | -2.543587 |
| 3 | 6.498193 | 4.948174 | -1.550019 |
| 4 | 6.062408 | 6.326903 | +0.264495 |
| 5 | 6.493568 | 4.933424 | -1.560144 |
| 6 | 6.494859 | 4.365933 | -2.128926 |
| 7 | 6.506735 | 6.322238 | -0.184497 |

Median paired delta -1.560144 ms, range -2.543587 to +0.264495 ms. All observed
median deltas fit the +1.5 ms experiment budget, but the wide candidate spread
precludes claiming a reliable saving. This is not a frame-time or 60 fps guarantee.
The sun path remains bright and distant bands regular; retain as an opt-in candidate
for comparison, not an approved default.

## Regression evidence and outstanding integration

- Today restored after candidate activation is pixel-identical to the Today control:
  1280×720, RGB max difference 0, mean difference 0. This checks the live toggle, not
  original-main binary parity (`captures/water/candidate-2/today-restored-parity.json`).
- `bun scripts/water-pins.ts` passes. Original generated Today WGSL tokens, Carrier's
  authoritative sea and existing other-game source are pinned to the starting main.
  The documentation-only architecture catalogue is explicitly excluded.
- The six-second wake capture completed both 180-frame tapes and their exact
  boat/ship/camera trace comparison. Encoding then failed because mini's ffmpeg lacks
  `drawtext`. Recovering the clip from those existing H.264 streams avoids rerendering.
  The script now saves the trace manifest before encoding and uses a plain stacked
  clip with its labels on the evidence page. The failed run did not save its traces.
- Standalone Carrier typecheck on pro found only missing generated `shared/build.gen`.
  The required root verification generates that file before checking the game.
- The first woods capture was obscured by its title overlay. The corrected capture
  hides that overlay and preserves the actual north-dock pose and look settings.
  The resulting default night view is too dark to establish useful shoreline detail.
  Its generated paint-over invented a far lantern and shoreline objects; rejected.
- Woods and `packages/kit/forest` are absent from the starting main revision. The
  preview on :5322 is a static exported woods build, not the owner's live worktree.
  A stable forest prerequisite and integration boundary are still needed. The lake
  settings are currently a proposal, not a working lake adapter or Water Lab variant.

## Verification round 1

Required `hivemind run --kind browser -- bun run verify`, strictly pinned to mini,
finished after 1,412 s. Worker has no Git checkout, so this checked every workspace
target. All application/server typechecks, production builds and deploy dry-runs passed.
Carrier and Lot smoke timed out; many unchanged simulation/performance tests timed out
or exceeded wall-time budgets under the shared load. The full log is published as
`verify.log`; this run is **red**, not a successful verification.

Two failures were introduced by this work and fixed:

- Water station order 115 collided with Survivor aim; changed it to unused order 134.
- Root proof type imports pulled Carrier's browser entry graph into Getaway's script
  typecheck, including its `*.glb?url` module and conflicting DOM event overloads.
  Proofs now declare only the small automation structure they actually read.

Targeted Carrier production smoke passed on mini: lobby ready, Metal adapter,
frames presented at approximately 11.8 seconds. Getaway's script typecheck passed
on pro, followed by all five Lab station tests (15 assertions, zero failures).

The editor proof was never admitted after 30 minutes of full worker slots. Its
five-minute retry also exited 75 without running. Drag, Edit/Play input ownership
and the Today control therefore remain unverified through real input.

Wake encoding on both mini and pro expired at admission without running. Recovered
both captured H.264 streams with container-only `ffmpeg -c:v copy` remuxing into
MP4, with no decoding, rendering or re-encoding. Each is 1280×720, 180 frames,
6.000 seconds, 30 fps, approximately 6 MB. Published as paired clips controlled
by the Today player, rather than a single stacked encode. The final captured stills
were inspected; playback has not been independently reviewed. No new timing claim.

## Local checkpoints

- `33144d7e`: shared water settings, controls, original WGSL and credits.
- `e0d608e6`: Carrier opt-in continuous pipeline; Today remains the default.
- `401fe011`: experimental ocean Water Lab and boat editor, marked in progress.

These commits are local. The full requested deliverable is not ready: the lake
adapter, faithful woods target, torch-response still and lake station are missing,
and real-input editor proof has not run. Requests for a stable forest prerequisite
were initially refused while the woods owner was mid-turn. No unrelated forest
branch was imported.

## Published checkpoint

Research, Today/candidate/target stills, paired wake clips, source pins, pixel-parity
result, timings and full verification log are at
<https://studio.taila8e7c7.ts.net:8444/raw/water-2026-10-22/index.html>.
The page, both MP4 clips and this ledger returned HTTP 200 from pro after publication.
Raw H.264 scratch was removed after remuxing; final MP4s and stills are retained.
All owned worker jobs have exited. The latest integration question was finally
delivered when the woods owner became idle; its answer is pending.
