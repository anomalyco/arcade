# Reject broken captures before showing Kit

Run a quality sweep before presenting rendered evidence. It checks the production canvas at game exposure,
keeps one browser page warm across states, and writes a contact sheet plus a machine-readable scoreboard.
A failed or incomplete sweep is diagnostic evidence. Fix the failed gate or explain a measured exception before
using its captures to ask Kit for a visual decision.

## Run the first adopters

Run from the repository root with FFmpeg/ffprobe and the repo's Playwright Chromium installed on the worker:

```sh
hivemind run --kind browser --worker mini -- \
  bun scripts/quality-gate.ts barbara --states scripts/quality/states/barbara.json
hivemind run --kind browser --worker mini -- \
  bun scripts/quality-gate.ts lab --states scripts/quality/states/spider.json
```

The CLI starts and closes its own Vite server. `--url` uses an existing page that installs `window.look`;
include `?qualityGate` and the desired quality tier. `--out` changes the output directory from
`captures/quality-<target>`. HiveMind fetches repo-root `captures/` automatically. `--benchmark-cold 1` adds
a fresh browser/page capture of the first state after the warm sweep. The whole command shares one 180 s
`browserBudget()`, including cold samples, and launches headless with audio muted.

Exit 0 means every requested state and gate passed with no browser errors. A gate failure, unsupported requested
probe, browser error or incomplete run exits nonzero. Read `scoreboard.json` (`complete`, `pass`, `errors`, `fatal`,
per-state `gates`) before using `index.html` or `contact-sheet.svg`. `ledger.md` includes capture timings.
Incomplete runs overwrite the previous success status before server startup. Old image files may remain in a reused
directory; only rows in the current scoreboard belong to that run.

## States select views and probes explicitly

```json
{
  "version": 1,
  "width": 1280, "height": 720,
  "settleFrames": 24, "probeFrames": 16,
  "states": [{
    "id": "today-torch",
    "state": { "look": "today", "camera": "trail", "torch": true },
    "probes": { "subject": true, "shift": 0.25 }
  }]
}
```

IDs are unique safe filenames. Unknown fields, invalid control values and invalid thresholds fail validation.
Top-level `limits` override defaults; each row can override them again. Record why a threshold differs from the
default in the proof report. Keep resolution fixed when comparing the 300-pixel subject-area threshold.

- BARBARA supports all six Looks and `trail`, `left`, `right`, `lake` cameras. It stages a fixed solo scene with
  friends, freezes simulation time and disables scheduled lightning. Omit `time`. The subject probe toggles the
  player's torch; the shift probe translates the camera sideways in metres without changing its facing.
  Settings overrides are limited to the curated Looks' forest/storm fields exposed by the Lab panel.
- Lab targets the production spider station (`spider.html`). Cameras are `pass`, `distant`, `near`, with deterministic
  `time` from 0 to 120 seconds. Supported settings are `spider.shell`, `spider.sheen`, `spider.beam`.
  The subject probe hides the spider geometry and uses a projected body/joint bounding region.
- Neither first adopter has an albedo debug view. Its albedo gate is explicitly skipped. Asking for an albedo probe
  fails, as does asking the spider for a camera shift.

`spider-dark.json` deliberately lowers subject contrast and should fail. `barbara-slab-probes.json` isolates two
flat-region candidates for a camera-shift follow-up. The regular BARBARA spec includes those shift probes too.

## Gates measure defects at game exposure

`packages/kit/proof/legibility.ts` accepts opaque RGBA8 frames without browser or image-decoder dependencies.
The sweep decodes PNGs with FFmpeg. Luminance is Rec.709-weighted linear sRGB in [0,1]. These defaults are starting
thresholds, not a claim that the image looks good:

| Gate | Default failure condition |
| --- | --- |
| Near-black / blank | p99 < 0.002 or luminance standard deviation < 0.0005 |
| Clipping | More than 2% of pixels have any encoded channel ≥254 |
| White washout | More than 2% of pixels have all encoded channels ≥250 |
| Milky wash | More than 85% of pixels are in tiles with mean ≥0.04 and coefficient of variation <0.08 |
| Subject area | Fewer than 300 pixels differ by at least 4/255 in any encoded channel inside the subject region |
| Subject contrast | Absolute signed Weber contrast <0.2 over those changed pixels |
| Slab | A low-variance, box-filling component moves under a small camera translation |
| Albedo | More than 1% of explicitly masked diffuse samples fall outside linear [0.03,0.89]; an empty requested mask fails |
| Repeated frame | More than 0.5% of pixels change by ≥4 encoded levels without a state change |

Weber is `(mean_on - mean_off) / max(mean_off, 0.005)`. Positive and negative contrasts both count. The denominator
floor prevents tiny near-black quantization changes from claiming infinite visibility. Signed cancellation can make
a mixed bright/dark subject fail conservatively; `absoluteWeber` is also recorded for diagnosis.

Slab candidates must occupy ≥0.2% of the frame (at least 16 pixels), fill ≥70% of their bounding box, and have
coefficient of variation ≤0.12 above luminance 0.65. The night spec uses brightness 0.012 and CV 0.3, calibrated on the
archived rain-drip defect. With a shift, the candidate must lose >25% of its original footprint and move ≥1% of frame
width, or disappear. A candidate without a shift fails as `slab-needs-probe`; it is not yet a confirmed near-camera slab.
This heuristic can flag legitimate nearby flat surfaces and can miss irregular or textured defects.

p5, p50, p95, dark share and tile contrast are recorded for diagnosis. The plan's proposed p5 and dark-share bands
are not universal gates: the repaired night still has p5 0.00037 and 95.7% dark pixels. Enforcing daytime-like bands
would reject that approved scene. There is no ΔE2000 fog-effect gate in this first implementation.

## Matched probes hold time, exposure and sampling phase

`window.look` is an opt-in version-1 hook from `packages/kit/proof/look.ts`. An adapter implements absolute
`apply(state)`, `settle(frames)` and `grab()`, with capability flags for optional `subject`, `shift`, `albedo` probes.
Control patches validate the entire patch before invoking any Lab callbacks. Adapters must restore their baseline
before applying another state and reject settings they cannot restore deterministically.

The sweep warms the game meter, then captures the base, an unchanged repeat, and each requested probe after equal
history lengths. `Renderer.resetProofHistory()` restarts TAA and volume sampling phases as well as clearing history.
The ordinary gameplay history reset keeps its existing behavior. Captures copy the canvas synchronously immediately
after the render, before Chromium can discard it.

Simulation advances only while applying a state; comparisons render with zero delta time. The game's exposure meter
snaps after a camera cut, then stays fixed for each pair. Every repeat/subject/shift capture must report the same time
and exposure within 0.1%; mismatches fail. A review-only brightness lift is not a valid gate input. The repeat check
catches residual instability but does not prove a semantically correct adapter; verify each new adapter against the
real state it claims to toggle.

## Measured first-adopter proof

On mini Metal, the 24-state BARBARA sweep (six Looks × torch on/off × trail/right) completed in 45.6 s including
decoding, scoring and one cold sample. Warm capture/probes took 0.64–2.09 s per state; startup was 2.96 s. The matched
Today state took 2.09 s warm versus 4.79 s in a fresh browser, a 2.30× ratio. Spider's first state took 2.08 s warm versus
2.99 s fresh, 1.44×. Cold samples reuse Vite's module cache and OS caches; these are browser-startup measurements,
not cold-build or GPU-frame-time benchmarks.

Both current spider views passed (Weber 0.305/0.224, 21,104/530 changed pixels). A dark-shell variant failed at 0.187;
an unlit subject failed at 0.013. All spider repeats matched exactly. BARBARA repeats changed at most 0.095% of pixels,
below the 0.5% limit. Both adapters and cold samples completed in 58.7 s with no browser errors.

BARBARA passes 22/24 states. The night slab heuristic falsely flags the genuine nearby trunk at the left frame edge
in `newmoon-torch` and `groundfog-torch`. Matched shifts confirm that it moves; they cannot distinguish a legitimate
trunk from a flat rain drip. The scoreboard keeps these failures visible. This is a conservative preflight with known
false positives, not a zero-false-positive visual acceptance test.

The archived BARBARA near-strike r1 still is rejected: one 4,428-pixel component at `(361,29,47,130)`, CV 0.288.
The repaired r2 still has no candidate and passes available gates. Reproduce that CPU-only regression with:

```sh
bun scripts/quality/history.ts --regression /path/to/r1/strike-near-peak.png /path/to/r2/strike-near-peak.png
```

Route decoding through HiveMind cargo with the two files available on the worker. No historical matched shift pair
exists, so this proves rejection pending a probe, not retrospective motion classification. Spider r2 has videos only;
the dark-shell state above recreates the failure class, not the exact old renderer. The plan's proposed four-defect /
eight-good-frame historical recall target remains unverified.

`bun scripts/quality/prove.ts` runs the 24 BARBARA states, both current spider views and the two diagnostic failures
under one budget, writing `captures/quality-proof/`. This diagnostic driver exits nonzero for incomplete captures or
browser errors, while the public `quality-gate.ts` exits nonzero for any failed gate.
