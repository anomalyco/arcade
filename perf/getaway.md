# Getaway performance

## Reproduce

```sh
cd games/blackout
bun scripts/bench-render.ts --game=getaway --base=http://localhost:4828 --experiment=control --main-renderer
bun scripts/bench-render.ts --game=getaway --base=http://localhost:4828 --experiment=repeat
cd ../getaway
bun scripts/compare.ts --phase=after --port=4828
```

Use current Nexus ports. The control substitutes only `main`'s renderer/shader modules inside the proof browser; the preview server is untouched. The current seeded scene and simulation are identical between these runs. One warmup + seven measured 180-frame paths, 1280×720, Metal hardware timestamps, optional effects off (`vanilla=1`).

| Metric (ms) | Control median / MAD / p95 | Final median / MAD / p95 |
| --- | --- | --- |
| Hardware GPU | 58.295 / 1.949 / 60.244 | 38.445 / 0.794 / 40.271 |
| GPU queue wait | 59.928 / 2.205 / 63.804 | 39.929 / 0.392 / 41.683 |
| CPU | 0.804 / 0.049 / 0.858 | 0.823 / 0.046 / 0.869 |
| Path frames 0–59, GPU wait | 58.650 / 1.685 / 66.440 | 43.965 / 0.630 / 45.288 |
| Path frames 60–119, GPU wait | 56.360 / 0.988 / 66.127 | 36.327 / 0.790 / 37.358 |
| Path frames 120–179, GPU wait | 59.023 / 2.282 / 67.672 | 40.238 / 1.712 / 42.403 |

The archived full-build BEFORE capture was 72.071 ms mean frame time, versus 40.180 ms in the regenerated AFTER capture; 6.417M → 0.768M vertices/frame. These gains include the pre-existing city-culling commit. This pass rejected H5 and did not retain a new Getaway rendering optimization.

H4: all seven runs produced 180 distinct light matrices for 180 frames. The proposed exact-matrix static shadow cache has no hits on this moving path. Changing the depth mapping to force hits would violate the graphics constraint. H5: 38.254 → 37.308 ms is inside the observed noise while CPU increased; reverted.

## Multiplayer

```sh
hivemind run --kind render --fetch perf/results.jsonl -- bun scripts/bench-multiplayer.ts --game=getaway --experiment=repeat
```

From repo root: eight recipients plus two bots, seed 7123, 1,000 ticks, one warmup + nine runs. Baseline 65.981 ms (MAD 5.070), shared view 45.037 ms (MAD 1.181). Complete serialized-output digest stayed `2477e2074af95efe792644db15a518f47ea44c14d53e9b9732bdb34f270030a8`. Recipient-specific fog, gadgets, props and repair information remain private. The collision AABB experiment was slower and was reverted.

Videos and sheets: `captures/preview/getaway-before-after.mp4` and `getaway-before-after-sheet.jpg`. Video encoding and composition use the Studio through Hivemind and VideoToolbox H.264, high profile, quality 75.
