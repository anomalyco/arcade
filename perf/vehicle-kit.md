# Shared vehicle presentation proof

Baseline: `8dff83439c254a6a70daaf2f934c12e918941f5c`. Captured on Apple Metal (`metal-3`),
960×640, with real-time audio blocked. The fixture intercepts changed module bodies from the baseline commit,
so both sides use the same preview, viewport and scripted controls. Blackout advances a seeded clock at 60 Hz;
Getaway advances its existing seeded benchmark at 30 Hz.

## Results

| Check | Result |
| --- | --- |
| Getaway chase frames 60 and 119 | PNGs byte-identical before/after |
| Getaway offline audio | 672,000 PCM samples; 178 differed by at most one 16-bit unit |
| Normalized audio difference | RMS `4.966785786985669e-7` |
| Getaway events | Three shifts and two nitro ignitions on both sides, zero clipping |
| Blackout jeep | All four sampled simulation poses identical before/after |
| Jeep stationary lamps | Zero smoke, skids, roll and pitch after fixture reset |
| Jeep handbrake turn | 49 smoke samples, 110 skid segments |
| Jeep braking capture | 63 remaining smoke samples, 158 skid segments, one earlier lift-off pop |
| Van and scooter | Moving captures with finite poses and sprung bodies |
| Lab | All nine vehicle switches present; All Off/On updates each setting |
| Blackout offline audio | Five sources select at most four voices; jeep, van and scooter included |
| Blackout mix | Peak `0.851973831653595`, zero clipped samples, zero tail after mute |
| Browser/GPU errors | None |

The smoke renderer uses the shipped Getaway noise, advection and lighting in both games. An intermediate
Blackout sprite-only adapter was rejected because individual particles were too obvious. The final capture
shows continuous wisps behind the tyres. The contact sheet compares Getaway and the Blackout jeep at matched
poses; its Getaway row intentionally has no visual difference.

Both games passed `bun install --frozen-lockfile` and `bun run check` in clean staging on the Studio.
Getaway: 177 pass, 12 existing skips. Blackout: 285 pass. Client/server/script typechecks and production builds
passed. Tests cover springs, contacts, flight/teleport resets, rigid lamp transforms, slip, smoke lifetime,
gearbox hysteresis, nitro gating and Blackout's rotation adapter.

These are appearance, behavior and offline signal checks. No listening test or new CPU/GPU performance
measurement was made.

## Reproduce

Run the game previews through Nexus as `vehicle-kit-getaway` and `vehicle-kit-blackout`, then from the repo root:

```sh
bun scripts/prove-vehicle-kit.mjs getaway before
bun scripts/prove-vehicle-kit.mjs getaway after
bun scripts/prove-vehicle-kit.mjs blackout before
bun scripts/prove-vehicle-kit.mjs blackout after
```

For remote checks after the workspace rebase, export the committed tree so unrelated files in the remote cache
cannot enter the test tree. The check installs at the root, checks the package and games, dry-runs both Worker
bundles and smoke-loads both production builds:

```sh
git archive HEAD -o captures/vehicle-kit-workspace.tar
hivemind run --kind render -- sh -c '
  clean=$(mktemp -d)
  trap '\''rm -rf "$clean"'\'' EXIT
  tar -xf captures/vehicle-kit-workspace.tar -C "$clean"
  sh "$clean/scripts/check-vehicle.sh"
'
```

Raw JSON results are in `perf/vehicle-kit/`. Ignored PNG/WAV originals are in `captures/vehicle-kit/` and the
retained local evidence is under `~/code/home/artifacts/2026-10-12-vehicle-kit/`. The inspected 1352×1476 contact
sheet is also at `~/code/open-source/lamplight/captures/preview/vehicle-kit-sheet.jpg`.
