# Fast tests and opt-in soaks

The full network/audio checks and Walkers physics/training checks run nightly at 03:17 UTC in
[`nightly-soak.yml`](../../.github/workflows/nightly-soak.yml), which also supports manual dispatch.

Run the default suite through a cargo worker from the repository root:

```sh
HIVEMIND_PIN_FALLBACK_S=3600 hivemind run --kind cargo --worker pro -- bun test --max-concurrency 4 packages/kit
```

Rollback tests cover all four room rates over 10 seconds. Seed 3 and a change every four ticks give the pacer's
arrival estimate enough samples to settle: each run requires at least 200 input changes, ten head-of-line holds
and ten packets delayed over 100 ms. Link tests use 4–10 second windows and separately exercise loss and stalls.
TCP delivers in order; loss delays delivery rather than dropping application messages.

`ARCADE_TEST_SOAK` accepts only unset, `0` (fast) or `1` (full); other values fail immediately.

The default audio suite renders a half-second seeded cue twice and checks identical WAV bytes, clipping, audible
signal and silence after stop. The emitter, cooldown, spatialization and lifecycle unit tests still run normally.

## Run long checks explicitly

```sh
HIVEMIND_PIN_FALLBACK_S=3600 hivemind run --kind cargo --worker pro -- bun run --cwd packages/kit test:soak
```

`test:soak` restores the four 60-second rollback runs (original seed 7 and sparse random input changes) and
60/10/120-second link windows with the same assertions.
It also runs `scripts/kit-audio-soak.ts`: the full 3.2-second occlusion/reverb A/B comparison and six-second chase
and spell replays. Those retain the spectral-darkening, reverb-tail, event-count, clipping and post-stop silence
assertions. Run this when changing long-tail DSP or investigating accumulated network drift.
