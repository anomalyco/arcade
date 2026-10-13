# Blackout monitor lights

These measurements describe the pre-Lab lighting revision. The subsequent live-Lab work adds a 1.65 m directional
monitor cone, intensity tuning, switchable chair shadows and AO, and monitor-off baked-light recombination. Its
functional checks are recorded in `docs/game-notes.md`; the GPU costs below have not been remeasured for that revision.

## Scope

Restore the approved cyan monitor lighting, chair shadow casters and multi-bounce AO. Retain the existing opaque
rendering optimization. Generated monitor lights follow the same seeded desk layout as the emissive screen meshes.

- Direct radius: 1.35 × 1.25 = 1.6875 m.
- Monitor occluder count: zero. No `shadowAt` calls or polar-buffer reads.
- Shadowed map/dynamic lights form a contiguous prefix. Only this prefix receives polar compute work.
- Wider cyan spill uses the existing bounce texture, baked with a 3.15 m reach. No additional runtime texture fetch.
- Broken screens stop their direct light. The static baked spill persists, like other baked lighting.
- The comparison page enables the approved monitor lights while keeping other optional effects off.

## Measurement

`bench-render.ts --paired-monitors` alternates OFF/ON order, with one warmup and seven measured pairs. OFF and ON
share chair shadows, AO, baked cyan spill, resolution, view and renderer. The difference isolates the direct monitor
lights. `--capture-views` saves on/off stills. GPU timestamps are hardware measurements; queue idle includes scheduling.

Run in a separate Hivemind worker preview, with one benchmark browser job at a time. The worker is shared with other
fleet jobs; queue-idle and total GPU deltas can therefore be noisy:

```sh
hivemind run --kind render --fetch perf/blackout-monitor-paired.json -- \
  env ARCADE_BENCH_WORKER=1 bun games/blackout/scripts/bench-worker.ts \
  --phase=after --experiment=monitor-paired --paired-monitors --views=openplan_east,openplan_south
```

The worker wrapper starts its own temporary loopback Vite and terminates it when the measurement ends. It does not
restart the existing Nexus previews. The old M2 Max capture must not be compared directly with new M5 Max timings.

## Experiments

1. Before this change, the current opaque renderer with monitors disabled measured 1.370 ms median across six views
   on the Studio (MAD 0.010 ms). This is a current-renderer control, not the historical original renderer.
2. Requested shadowless split: three monitor lights east, one south. Polar work stayed at three and four shadowed
   lights respectively. Added total GPU time: east 0.115 ms, south 0.010 ms median; scene-pass deltas were 0.114 and
   0.031 ms. East did not meet the 0.05 ms target. Raw runs: `blackout-monitor-paired.json`.
3. Position-first rejection: read only position/radius before loading colour, cone and shadow metadata. Added GPU
   medians were 0.069 ms east and -0.003 ms south (noise); east still missed the target. No independent speedup is
   claimed from the small change in total frame GPU time.
4. Conservative monitor bounds: use spare frame-uniform fields to skip the entire monitor suffix outside its combined
   plan bounds. This cannot remove a visible contribution; the bounds contain every monitor radius, padded outward
   for float32 rounding. Reload-based added GPU medians were 0.037 ms east / 0.021 ms south.
5. Fixed-frame confirmation on the final padded bounds: same browser/device, frozen simulation, alternating OFF/ON
   order, one warmup plus seven pairs, 32 hardware samples per block. Total GPU added median / MAD:
   east **0.04898 / 0.04607 ms**, south **0.03735 / 0.06895 ms**. Scene-only added medians: east 0.04341 ms,
   south 0.01464 ms. Both point estimates meet 0.05 ms, but the spread does **not** establish a reliable ceiling.
   Negative deltas reflect noise, not free or negative-cost direct lighting. Raw samples: `blackout-monitor-cost.json`.

Reproduce fixed-frame confirmation and bounds pixel parity:

```sh
hivemind run --kind render --fetch perf/blackout-monitor-cost.json -- \
  env ARCADE_BENCH_WORKER=1 bun games/blackout/scripts/bench-worker.ts --monitor-cost
```

## Historical renderer comparison (same Studio)

One warmup plus seven measured runs per revision. Historical rendering files were unchanged; only benchmark scripts
were added to that checkout. `captures/bench/monitors/blackout-{before,after}.json` contains the per-view median/MAD/raw
run summaries from `blackout-monitor-original.json` and `blackout-monitor-bounds.json`.

| View | Before GPU | After GPU | Before queue idle | After queue idle |
| --- | ---: | ---: | ---: | ---: |
| Open-plan east | 1.505 ms | 1.399 ms | 2.868 ms | 3.096 ms |
| Open-plan south | 1.497 ms | 1.295 ms | 3.016 ms | 3.084 ms |

GPU timestamps improved by 7.0% / 13.5%, with cyan pools, chair shadows and multi-bounce AO enabled. Queue-idle
medians did **not** improve in this comparison, so the requested win on both metrics is not established. These runs
compare complete renderer revisions; the monitor-specific marginal costs are measured separately above.

## Correctness

`tests/lighting.test.ts` checks lights against actual emissive desk geometry, deterministic layouts, broken-screen
filtering, capacity limits, unchanged occluder buffers and shadow prefixes with monitors enabled, and the tight radius.
On/off stills in `captures/preview/monitor-{on,off}-openplan_{east,south}.png` show the direct cyan desk pools.
The final padded bounds produced byte-identical PNGs with the shortcut enabled and disabled in both views:
`captures/preview/monitor-bounds-{on,off}-openplan_{east,south}.png`.

Final `bun run check` passed on Studio: client/server/script typechecks, 187 tests, and Vite production build.
All 28 historical rendering-file hashes still match the saved manifest. Changes remain local, with the existing
comparison previews available; no deployment was performed for this performance pass.
