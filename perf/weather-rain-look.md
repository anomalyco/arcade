# Lamp and torch rain (22 October 2026)

The API and adaptation shipped in PR #463 (`973fafaf`), with 13/13 CI checks and 79 HiveMind release checks passing.
`release-4` was fast-forwarded and `barbara-looks` was notified through `agent-ops.ts msg`. This follow-up reuses the
same worktree on `weather-rain-look`.

Kit rejected the previous faint lamp rain. The candidate now applies light attenuation once in streak radiance,
instead of multiplying it into colour and opacity. A bounded forward lobe makes backlit drops brighter while a
broad reflection term keeps the carried torch's rain visible. Streaks add radiance, with zero contribution outside
light and no ambient floor. Existing fall velocity, shutter length and pixel cap still shape the streaks.

The old field also spent most drops above or outside real cones. The existing far-drop budget now samples small
world-anchored tiles around nearby conical lights, and the near field uses a smaller tile. Turning the torch changes
lighting rather than rotating those tiles. The normal capped streak counts are retained at HiDPI instead of being
reduced to 34%. Splash, mist and snow budgets stay unchanged. No new buffers or pipelines were added.

`RainLightingSettings.streakGain` is optional for existing consumers and defaults to 4, with a typed LabPanel control
under Weather. The current captures use 768 near and 512 far streak instances. Both lamp and torch use the shared
production renderer; the torch proof uses Lot's actual carried light, aimed back along the approach road.

## Evidence

[Two Today/candidate comparisons](https://studio.taila8e7c7.ts.net:8444/raw/weather-rain-look-2026-10-22/index.html).
Each includes the full frame and an enlarged matching crop, with no exposure change in the image processing.

Through HiveMind on mini:

- Lot and Lab typechecks passed, as did strict typechecking of `scripts/lot-storm-proof.ts`.
- `bun test --max-concurrency 4 packages/kit/weather/weather.test.ts packages/kit/lab/world/world.test.ts games/lot/tests/weather.test.ts`: 15 tests passed.
- Lot production build and headless, muted lamp/torch captures passed.
- Today matched `973fafaf`'s weather renderer exactly in both views, maximum channel difference 0. Baseline source
  was restored with an exit trap. The final density change affects candidate streaks only.
- Final candidate build/capture watch: `wk_Ri66vutx`. Final targeted weather tests passed after the last density edit.

Reproduce each side with `LOT_STORM_SUBJECTS=lamp|torch`, `LOT_STORM_CANDIDATES=today|candidate`,
`LOT_STORM_W=1920`, `LOT_STORM_H=1080`, `LOT_STORM_OUT=captures/weather-rain-look` and
`bun scripts/lot-storm-proof.ts rain-review`, once per subject/side through HiveMind browser admission. Run
`scripts/weather-rain-look-images.py` on that worker to compare saved baseline frames and compose the two stills.

This review covers appearance in two fixed Lot views. Continuous movement, light-list changes, and GPU cost were
not measured; BARBARA integration remains with its consumer. Both modes still default to Today. Await Kit's review
before a follow-up PR.
