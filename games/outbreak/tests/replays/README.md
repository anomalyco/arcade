# Outbreak golden replays

`../replay.test.ts` runs two checked-in input tapes through the production `CoopSim`. Each tape is 30 seconds
at 20 Hz, the same integration step as the bot-runner tests it replaces. These are classic-world regressions;
streaming, 60 Hz movement, difficulty bands and bot decision rules keep their focused tests.

| Tape | Players | Covered behavior | Compressed size |
| --- | --- | --- | --- |
| `scavenging.json.gz` | 4 | Seed-7 Skilled bots recorded once: movement, container search, shared inventory/world | 155 KB |
| `combat.json.gz` | 2 | Pistol shots, bat swings, reload, sprint, crouch, flashlight toggles, squad ping | 44 KB |

Tests also assert that search/movement and combat actions actually occur, so an inert tape cannot become a golden.
The golden hashes every `SimState` field, including RNG, feature state and rewind history. Survivor fields get
individual names in failures; other components are named by their snapshot field. Tick 0 is the initial state.
Diagnostics report changed field hashes rather than retaining every full snapshot.

## Run or intentionally update

From the repository root:

```sh
hivemind run --kind cargo -- bun test games/outbreak/tests/replay.test.ts packages/kit/sim/replay.test.ts

# An intentional sim change: replay the existing inputs and replace the golden.
hivemind run --kind cargo --fetch games/outbreak/tests/replays -- bun games/outbreak/scripts/record-replays.ts --write

# An intentional scenario/input change: record fresh inputs as well.
hivemind run --kind cargo --fetch games/outbreak/tests/replays -- bun games/outbreak/scripts/record-replays.ts --write --record-inputs
```

Investigate the first divergent tick before updating. Commit the reviewed fixture with the intentional change.
If setup or the stepping contract changes, bump the adapter's `version` in `scenarios.ts` too. Ordinary tests
never update files. Each gzip contains plain JSON `{ recording, golden }`; `gzip -dc <file>` inspects it.

## Shared adapter contract

`ReplaySim` supplies `version`, `init(header)`, `step(state, inputs, dt)` and `fields(state)`. Include all
authoritative state in `fields`, partitioned by useful diagnostic names. `recordReplay(sim, options, input)`
returns a recording and golden; `replay(sim, recording)` returns per-tick hashes and named field hash streams.
`assertReplayMatches(actual, golden)` throws at the first mismatch and works directly inside `bun:test`.

Record JSON-safe inputs in a fixed player order. State hashes support plain objects, arrays, numbers (including
infinities, NaN and signed zero), strings, booleans, undefined and numeric typed arrays. Object key order does
not matter; array order does. Project Maps/Sets explicitly, sorting only when iteration order is irrelevant.
`replayHash` uses exact IEEE-754 bits. An adapter may provide a pure `normalizeNumber` for state hashing;
input/recording hashes stay exact. Its policy is part of the adapter version.

Outbreak's v2 adapters round finite fractional snapshot values to **nine decimal places** while preserving
integers, signed zero, infinities and NaN. This affects comparison only, never sim state or input tapes.
Differences below that resolution may be hidden; rounding boundaries can still produce a mismatch.
Do not use this policy for simulations that need sub-nanounit checks.

Why: Bun 1.4.2 on Linux x64 first differed from Mac arm64 at tick 4, in a zombie's aim:
`-0.25617535999319324` versus `-0.2561753599931933`. An isolated CI run reproduced it, ruling out test order.
Comparing all 601 scavenging snapshots found 1,877 numeric differences, largest `2.85e-13`, with no structural
differences. Nine-decimal projection removed every observed discrepancy; tests retain the measured counterexample
and check that a `1e-8` change still differs. Shared hashing remains bit-exact by default.

## Timing

`hivemind run --kind cargo --worker mini -- bun games/outbreak/scripts/bench-replays.ts` compares the old
90-second three-pass determinism test plus 60-second squad run against both goldens plus the retained 3-second
runner contracts. Final v2 measurement: one warmup and nine alternating samples on Studio/M5 Max, Bun 1.4.4
(the mini was occupied; use `--worker studio` to reproduce this run):

| Path | Median | Range |
| --- | --- | --- |
| Old runner loops | 635.3 ms | 562.1–1333.7 ms |
| Goldens + short runner contracts | 555.9 ms | 509.8–1145.9 ms |
| Both goldens alone | 525.7 ms | 480.5–1635.5 ms |

The combined replacement's median is 12.5% faster and checks every tick against committed state, rather than
comparing two current runs' summaries and final playback time. Studio was shared and samples were noisy; this
is not a dedicated-worker performance guarantee. The nine targeted helper/Outbreak tests took 981 ms including
imports and fixture reads. Queue and install time are excluded.

Earlier experiments: exact v1 hashing measured 857 → 716 ms on mini/M4 Pro (five samples), but failed on Linux
math drift. A separate rounded snapshot copy made the Studio replacement slower than the old loops (746 vs
693 ms), so v2 projects numbers during the hash traversal instead. Initial byte-at-a-time hashing was also slower;
word-wise hashing cut a two-tape trial from 568 to 501 ms before expanding scavenging to four players.
