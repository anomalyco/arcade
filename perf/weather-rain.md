# Rain and flash recovery (22 October 2026)

`weather-rain` extracts opt-in rain and adaptation from the cloud experiment. Both default to Today in Lot and
the shared Lab world. D-59 keeps Today's storm under Kit's delegated decision in chat. Cloud work remains on
`weather-clouds-parked` at `1f439633`.

[Two comparison stills and validation records](https://studio.taila8e7c7.ts.net:8444/raw/weather-rain-2026-10-22/index.html).

## Validation

HiveMind on mini passed Lot and Lab typechecks, strict typechecking of `scripts/lot-storm-proof.ts`, Lot's production
build, and these focused tests:

```sh
bun test --max-concurrency 4 packages/kit/weather/exposure.test.ts packages/kit/weather/weather.test.ts \
  games/lot/tests/weather.test.ts packages/kit/lab/world/world.test.ts games/lab/tests/stations.test.ts
```

The headless, muted `rain-review` capture mode produced lamp and flash comparisons at 1920×1080. Today matched
baseline `f670c2fe` exactly at the lamp, flash peak and 0.5-second aftermath: maximum channel difference 0 in all
three frames. The baseline overlaid Lot `main.ts`, `post.ts`, `weather/storm.ts`, and shared weather `renderer.ts`
and `state.ts` from that commit. Source restoration ran in an exit trap.

The harness pins TAA, volume and forest-dither phases after loading and resets history at each frozen flash instant.
Initial parity mismatches came from capture sampling/history; the fix changed only the proof script. Chromium
crashed in the first combined capture; isolated browser processes completed successfully. Final successful watch:
`wk_VqEfu4jn`.

Adaptation exposure was approximately `0.597×` at 0.5 seconds after peak. This is driven by relative stimulus
`1 + 48 × flash`, not measured scene luminance. The checks establish parity for those Lot frames; other games were
not pixel-tested. Motion quality, continuous temporal behavior and GPU cost remain unmeasured in this extraction.

Kit reviews the stills before PR creation, release checks, merge and release-4 advancement.
