# Outbreak golden replays

`../replay.test.ts` runs two checked-in input tapes through the production `CoopSim`. Each tape is 30 seconds
at 20 Hz, the same integration step as the bot-runner tests it replaces. These are classic-world regressions;
streaming, 60 Hz movement, difficulty bands and bot decision rules keep their focused tests.

| Tape | Players | Covered behavior | Compressed size |
| --- | --- | --- | --- |
| `scavenging.json.gz` | 4 | Seed-7 Skilled bots recorded once: movement, container search, shared inventory/world | 162 KB |
| `combat.json.gz` | 2 | Pistol shots, bat swings, reload, sprint, crouch, flashlight toggles, squad ping | 49 KB |

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
Numbers use IEEE-754 bits, without decimal rounding; simulation math must itself be deterministic on the target
Bun runtimes. These fixtures were recorded and replayed on Mac arm64 with Bun 1.4.2 and 1.4.4.

## Timing

`hivemind run --kind cargo --worker mini -- bun games/outbreak/scripts/bench-replays.ts` compares the old
90-second three-pass determinism test plus 60-second squad run against both goldens plus the retained 3-second
runner contracts. One warmup and five alternating samples on mini/M4 Pro, Bun 1.4.2:

| Path | Median | Range |
| --- | --- | --- |
| Old runner loops | 856.7 ms | 832.4–878.7 ms |
| Goldens + short runner contracts | 715.5 ms | 714.0–727.2 ms |
| Both goldens alone | 675.6 ms | 673.1–681.4 ms |

The combined replacement is 16% faster and checks every tick against committed state, rather than comparing
two current runs' summaries and final playback time. The targeted `bun test` process took 1.22 s including
imports and fixture reads. Queue and install time are excluded. Initial byte-at-a-time hashing was slower;
word-wise hashing cut a two-tape trial from 568 to 501 ms before expanding scavenging to four players.
