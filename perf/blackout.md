# Blackout performance

## Reproduce

```sh
cd games/blackout
bun scripts/bench-render.ts --game=blackout --base=http://localhost:4898 --experiment=repeat
bun scripts/compare.ts --phase=after --base=http://localhost:4898
```

Use the live port from `nexus list --json`; the runner never starts or stops a preview. One warmup + seven measured runs, 1280×800, seed 1, zoom 17, Apple Metal timestamps. `vanilla=1` disables concurrent optional effects. Existing BEFORE artifacts must be in `captures/bench` for video comparison.

## Final timing

The table below predates Kit's subsequent approval to restore cyan monitor pools, chair shadows and multi-bounce AO.
That follow-up is measured separately in [monitor-lights.md](monitor-lights.md); its Studio measurements must not be
mixed with this MacBook Pro baseline.

Hardware GPU, median / MAD / p95 in milliseconds. p95 across seven runs is their maximum.

| View | Main median | Final median | Final MAD | Final p95 |
| --- | ---: | ---: | ---: | ---: |
| Corridor doorway | 15.240 | 5.581 | 0.234 | 10.365 |
| Open-plan east | 12.987 | 7.306 | 0.342 | 12.554 |
| Open-plan south | 11.380 | 6.266 | 0.391 | 7.131 |
| Meeting glass | 11.408 | 4.927 | 0.819 | 7.419 |
| Breakroom | 10.856 | 4.910 | 0.217 | 10.942 |
| Cafeteria | 14.476 | 5.467 | 1.741 | 19.096 |
| Six-view average per run | 12.734 | 5.849 | 0.308 | 9.353 |

Queue-wait median: 15.339 → 7.589 ms (final MAD 0.521, p95 16.507). Archived one-run baseline: 12.32 ms hardware, 15.12 ms wait, 36.30 ms stress estimate. Final repeated stress estimate: 27.630 ms (MAD 1.549); capture-run estimate 22.83 ms. Stress is not a direct four-pass timestamp measurement.

The first final repeat (`final-vanilla`) had five ~10 ms runs followed by ~6 and ~5 ms while concurrent work was active. It is retained in the ledger. A confirmation gave 5.849 ms median with two larger outliers. All viewpoint medians improve; cafeteria p95 does not. The isolated H1 experiment earlier was 12.972 → 5.007 ms.

## Multiplayer

```sh
hivemind run --kind render --fetch perf/results.jsonl -- bun scripts/bench-multiplayer.ts --game=blackout --experiment=repeat
```

From repo root: 10 recipients, four additional bots, seed 7123, 1,000 ticks, one warmup + nine runs. Baseline 43.531 ms (MAD 4.286); shared entities 32.816 ms (MAD 0.345). Complete serialized-output digest stayed `a537782b1821bd7d5120a56fcf7472c35389af802767faf7030f1ad62106f1ee`.

`BOT PRACTICE` enters a local session directly, retaining the selected mode and player name. Input fixes and strafe hysteresis are retained. See `autoresearch.md` for rejected experiments and visual comparisons.
