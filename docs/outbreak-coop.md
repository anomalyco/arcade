# Outbreak co-op

Two to four survivors share one neighbourhood. One player presses **Host co-op**, which creates a room and copies a
link (`/arcade/outbreak/?room=<code>`); friends open the link and drop in. Without `?room`, Outbreak is the same
offline single-player `LocalSession` as before.

## Shape

```
client (per player)                         Durable Object OutbreakRoom (one per room code)
──────────────────                          ───────────────────────────────────────────────
FrameClock 60 Hz command ──[seq, cmd]──▶     JitterBuffer per player (one command per tick)
predict own survivor (CoopSim.movePlayer)    CoopSim: N survivors, shared AI, doors, loot, barricades
                                             60 Hz sim, snapshot every 3rd tick (20 Hz)
reconcile on ack  ◀──[binary snapshot]──     shared part encoded once per snapshot;
interpolate remote survivors + zombies       per-player header: ack + private survivor state
```

- **One simulation.** `shared/coop-sim.ts` owns the multi-survivor world. `LocalSession` is a `CoopSim` with one
  survivor and produces the same trace as before. Zombies pick, per agent, the survivor that gives the strongest sight
  stimulus (`@arcade/kit/sim/ai`'s `stepAICrowd` takes several targets; one target behaves exactly as before). Noise
  from any survivor reaches the bus; attacks damage the survivor they target.
- **Shared per room, private per player.** Doors, windows, barricades, containers and their contents, ground drops,
  zombies, shots, pings, noisemakers and the clock are shared. Hotbar, belt, pack, stamina, battery and channels
  belong to each survivor. Items live in one progression ledger (`docs/outbreak-progression.md`); a take is one
  atomic transaction, so two survivors grabbing the last medkit in the same tick cannot both get it.
- **Authority.** The room decides everything. A client predicts only its own movement, stamina, vault/peek state and
  flashlight toggle; doors, loot, barricades and shots take effect when the room's snapshot arrives (one round trip).

## `@arcade/kit/net`

Game-agnostic pieces, so Blackout and Getaway can adopt them later (their own behaviour is unchanged here):

- `jitter-buffer.ts`: Wings's adaptive playout buffer (`room-engine.ts`), generalised. Exactly one input per tick;
  a dry tick repeats the last movement without its one-shot edges; when two inputs are consumed in a tick, or a late
  input arrives after its stand-in, its one-shot edges are merged forward instead of dropped (the Blackout/Getaway
  `splice` bug). Small sequence gaps (`≤ 6` ticks) from upstream packet drops keep the stream primed so stand-ins
  bridge the gap without stalling movement. Wings itself is an independent project and keeps its copy.
- `seats.ts`: join, leave, reconnect. Each seat has a public `id` (seen by everyone) and a private `token` (only the
  owner sees it, used to reclaim the seat within the grace window).
- `bytes.ts`: a small little-endian `ByteWriter`/`ByteReader` (with unsigned/ZigZag LEB128 varints `uvar`/`ivar`,
  8/12/16-bit angle packers, signed 4-bit nibble pairs and bitsets), and `frame(personal, shared)` which prefixes a
  per-recipient header to a shared payload.
- `interest.ts`: per-recipient spatial interest bubble (`inInterestBubble`), priority cadence scheduling
  (`selectInterestStride`, `isScheduledOnSnapshot`, `PriorityAccumulator`), acked-snapshot ring buffer (`AckHistory`),
  and adaptive snapshot rate pacing (`BandwidthPacer`).
- `rewind.ts`: `RewindHistory`, a zero-allocation server-side position ring buffer that interpolates past entity
  poses and temporarily rewinds hitscan targets to the shooter's rendered `viewTime` (clamped to `maxRewindSeconds`).
- `interpolate.ts`: `SnapshotBuffer`, a time-stamped buffer that renders remote entities between the two snapshots
  bracketing `now − delay`.
- `prediction.ts`: `Predictor`, pending commands keyed by sequence, replay on ack, and a decaying visual error offset
  so corrections never pop.

## Vision and presentation

Each client renders its own line of sight and fog from `shared/vision.ts` (owned by the look/fog work; co-op only
calls `Vision.visible`). Remote survivors are drawn only when inside your sight, but their flashlights always light
the world. Every seat has a colour and a name tag. Lab tuning stays local in co-op: AI and generation controls only
change the offline session.

## Wire format

- Up: compact base64-framed binary batch `"I" + btoa(encodeClientIn(s, c, ackSnap, viewTick))` (with JSON `{t:"in", …}`
  still accepted), carrying two 60 Hz commands per message (repeating identical consecutive commands in 1 bit and
  re-sending the previous batch when it held a one-shot edge), the last snapshot tick received (`ackSnap`), and the
  client's interpolated `viewTick` for server hitscan rewind.
- Down, text: `welcome` (public id, private token, seat index, room options), `roster`, `pong`, `error`, `reload`.
- Down, binary snapshot at 20 Hz (adapted by `BandwidthPacer`): `frame(personal, shared)`.
  - `shared` (cached per `(viewerBubble, baseTick)` so survivors in the same chunk bubble with the same acked tick
    encode once): header (`tick`, `time`, `hour`, `revision`, `sectionFlags`, optional `baseTick`), all 1–4 survivors
    (12 B each: `i32` cm position, 12-bit aim + 4-bit flags, 7-bit light + exhausted bit, health, optional recoil/lift),
    interest-culled zombies inside the recipient's `128 × 128 m` bubble (`±64 m` around their `3 × 3` chunk window)
    delta-compressed against `baseSnap.zombies` via a changed-entity bitfield, 1-byte nibble (`±7 cm`) or 2-byte `i8`
    (`±127 cm`) position deltas, 8-bit aim and optional state/HP/FX sub-flags (with non-urgent mid/far/idle zombies
    throttled to 10 Hz / 5 Hz), door/window bitfields + sparse non-zero barricade planks (omitted completely when
    `revision` is unchanged since `baseTick`), and new shots/bashes/pings/lures since `baseTick`.
  - `personal`: binary-packed `ack`, `f32` position/aim/stamina/battery/flashlight/noise, discrete flags/ammo/planks,
    and an optional bitmask for active timers, peek/hold/vault/channel state, filtered ledger deltas and notices.

## Measured

`scripts/coop-bench.ts --matrix=1 --seconds=10` (`perf/outbreak-net-perf.json`, 14 scenarios across 1/2/4 survivors,
60 / 300 / 1000 zombies, together vs spread 1 km apart in streaming chunks, and clean 50 ms vs lossy 80 ± 30 ms at 2%
packet drop):

| Scenario | Down KB/s (Before → After) | Up KB/s (Before → After) | Snap Bytes (Before → After) | Zombies B (Before → After) | Server Tick p95 ms (Before → After) | Client Decode p95 ms (Before → After) | Max Correction m (Before → After) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `1p · 60z · together · clean` | `31.41 → 5.64` (`-82.0%`) | `2.71 → 1.43` | `1,608 → 300` | `1,322 → 186` | `2.75 → 0.45` | `0.83 → 0.08` | `0.0002 → 0.0000` |
| `2p · 60z · together · clean` | `31.96 → 6.06` (`-81.0%`) | `2.73 → 1.43` | `1,636 → 325` | `1,322 → 194` | `1.47 → 0.51` | `0.31 → 0.06` | `0.0002 → 0.0000` |
| `4p · 60z · together · clean` | `33.06 → 6.90` (`-79.1%`) | `2.75 → 1.43` | `1,692 → 366` | `1,322 → 203` | `3.04 → 0.41` | `0.23 → 0.03` | `0.0002 → 0.0000` |
| `4p · 60z · spread 1km · clean` | `35.28 → 3.92` (`-88.9%`) | `2.75 → 1.43` | `1,805 → 211` | `1,322 → 48` | `2.54 → 0.52` | `0.31 → 0.03` | `0.0007 → 0.0001` |
| `4p · 60z · together · lossy (80±30ms, 2%)` | `33.06 → 7.16` (`-78.3%`) | `2.75 → 1.43` | `1,691 → 404` | `1,322 → 213` | `0.94 → 0.43` | `0.13 → 0.02` | `0.0934 → 0.0013` |
| `1p · 300z · together · clean` | `134.55 → 17.56` (`-86.9%`) | `2.71 → 1.43` | `6,889 → 966` | `6,602 → 851` | `1.30 → 1.28` | `0.09 → 0.08` | `0.0002 → 0.0000` |
| `2p · 300z · together · clean` | `135.09 → 18.25` (`-86.5%`) | `2.73 → 1.43` | `6,916 → 1,016` | `6,602 → 886` | `2.24 → 1.30` | `0.17 → 0.06` | `0.0002 → 0.0000` |
| `4p · 300z · together · clean` | `136.18 → 19.44` (`-85.7%`) | `2.75 → 1.43` | `6,972 → 1,085` | `6,602 → 921` | `2.57 → 1.55` | `0.15 → 0.04` | `0.0002 → 0.0000` |
| **`4p · 300z · spread 1km · clean` (Target)** | **`138.41 → 6.81` (`-95.1%`)** | **`2.75 → 1.43`** | **`7,085 → 372`** | **`6,602 → 207`** | **`14.18 → 1.05`** | **`0.52 → 0.03`** | **`0.0007 → 0.0001`** |
| **`4p · 300z · spread 1km · lossy (80±30ms, 2%)`** | **`138.38 → 6.98` (`-95.0%`)** | **`2.75 → 1.43`** | **`7,084 → 384`** | **`6,602 → 214`** | **`15.95 → 1.64`** | **`0.59 → 0.06`** | **`0.1121 → 0.0010`** |
| `1p · 1000z · together · clean` | `435.32 → 28.23` (`-93.5%`) | `2.71 → 1.43` | `22,289 → 3,075` | `22,002 → 2,936` | `9.64 → 3.26` | `0.19 → 0.12` | `0.0002 → 0.0000` |
| `4p · 1000z · together · clean` | `436.96 → 30.63` (`-93.0%`) | `2.75 → 1.43` | `22,372 → 3,340` | `22,002 → 3,152` | `16.52 → 3.21` | `0.21 → 0.11` | `0.0002 → 0.0000` |
| `4p · 1000z · spread 1km · clean` | `439.19 → 15.16` (`-96.5%`) | `2.75 → 1.43` | `22,485 → 847` | `22,002 → 681` | `8.79 → 4.30` | `0.24 → 0.10` | `0.0007 → 0.0001` |
| `4p · 1000z · spread 1km · lossy (80±30ms, 2%)` | `439.15 → 15.65` (`-96.4%`) | `2.75 → 1.43` | `22,484 → 877` | `22,002 → 706` | `8.51 → 3.43` | `0.24 → 0.06` | `0.1121 → 0.0013` |

With the default 28 zombies, a 4-client headless run of `coop-smoke.ts --players=4` against `wrangler dev` measured
**4.14–4.21 KB/s down and 1.95 KB/s up per client** (down from 18–23 KB/s).

## Sound

Co-op adds nothing to the wire for sound. The client's `CoopSim`, filled from snapshots, drives the same
`SoundDirector` as offline play ([sfx-library.md](sfx-library.md#outbreak)): shots with their shooter, doors, windows,
planks, bashes and zombie states are heard where they happen, and remote survivors' replicated flashlight, reload,
health and exhaustion become sounds at their positions; their footsteps come from their rigs' foot contacts. Like the
rest of the shared world, a remote shot or door is heard one snapshot late.

## Known gaps

- Doors, loot, barricades and shots take a round trip (no client-side muzzle flash prediction yet); server hitscan
  evaluates against zombie positions rewound to the shooter's `viewTick` (`@arcade/kit/net/rewind`, clamped to 250 ms).
- Remote survivors show body, flashlight, name tag, and the character HUD (callouts and health, reload and exhaustion
  rings, see [outbreak-hud.md](outbreak-hud.md)) built from replicated flags, but not their pistol. Reload progress
  is timed on the viewer's side because the snapshot carries only a reloading flag.
- No death or downed state, no persistence: a room resets once every survivor has been gone for 60 s. A survivor
  whose seat expires leaves what they carried on the floor. No lobby or
  quick join; rooms are links only. Lab tuning, spawns and the AI debug overlay only affect the offline session.
- Blackout and Brawl share `@arcade/kit/net/room-core`, which now uses the same `seats` tokens, `jitter-buffer` and
  per-socket rate limit as this room; Getaway still carries its own room loop. `@arcade/kit/net/{interpolate,rewind,interest}`
  are ready for Blackout to replace its exponential remote avatar chase (`SnapshotBuffer`) and add 20-tick server
  hitscan rewind (`RewindHistory`).

## Proof

- `games/outbreak/tests/coop.test.ts`: 2–4 survivors, zombies split targets, shared doors and loot, private ammo,
  binary encode/decode round-trips, 1 km per-recipient interest filtering, and delta compression against ack under 5%
  packet loss.
- `packages/kit/net.test.ts`: jitter buffer edges & gap resilience, seats/tokens, varints/angles/nibbles/bitsets,
  interest bubbles & priority accumulation, `AckHistory`, `BandwidthPacer`, `RewindHistory`, interpolation, and
  prediction reconciliation.
- `games/outbreak/scripts/coop-smoke.ts`: 2–4 headless protocol clients against `wrangler dev` (or production): join,
  move, open a door, shoot, and check that all clients agree. Reports bytes per client per second.
- `games/outbreak/scripts/coop-bench.ts`: server CPU per tick, field-by-field snapshot bytes, client decode cost,
  latency and correction magnitudes across 1/2/4 survivors, 60/300/1000 zombies, together vs spread 1 km apart, and
  simulated packet loss/jitter.
