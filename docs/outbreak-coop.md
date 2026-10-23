# Outbreak co-op

Two to six survivors share one neighbourhood. One player presses **Host co-op**, which creates a room and copies a
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
  bridge the gap without stalling movement.
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
- `prediction.ts`: `Predictor`, pending commands keyed by sequence, replay on ack, a decaying visual error offset
  (`Smoother`) so corrections never pop, and `OptimisticEvents` for press-frame cosmetic feedback (shots, melee swings,
  shoves, reloads, doors/windows, item pickups) with confirm/rollback/reapply hooks.

## Vision and presentation

Each client renders its own line of sight and fog from `shared/vision.ts` (owned by the look/fog work; co-op only
calls `Vision.visible`). Remote survivors are drawn only when inside your sight, but their flashlights always light
the world. Since the Oct 21 playtest ("Why can't I see your flashlight?") a teammate's beam is the same light as your
own (`src/teammates/beams.ts`, cone.w 3 in the scene's light hooks: full range and profile about their lens, wall
shadows, a faint shaft; its own cone and tint whatever your battery), what it lands on shows through your shroud, the
zombies it lights are drawn (`Vision.setBeams`: not through closed windows, not under a roof drawn for you, and never
added to what you have explored), and whoever holds a lit torch shows wherever you have a clear line to them. Backquote › Flashlight › Teammates'
flashlights keeps Today's dim 6 m hint one setting away. Clip: `bun scripts/team-beams-clip.ts` (via
`hivemind run --kind browser`). Every seat has a colour and a name tag. Lab tuning stays local in co-op: AI and generation controls only
change the offline session.

## Wire format

- Up: compact base64-framed binary batch `"I" + btoa(encodeClientIn(s, c, ackSnap, viewTick))` (with JSON `{t:"in", …}`
  still accepted), carrying two 60 Hz commands per message (repeating identical consecutive commands in 1 bit and
  re-sending the previous batch when it held a one-shot edge), the last snapshot tick received (`ackSnap`), and the
  client's interpolated `viewTick` for server hitscan rewind.
- Down, text: `welcome` (public id, private token, seat index, room options), `roster`, `pong`, `error`, `reload`.
- Down, binary snapshot at 20 Hz (adapted by `BandwidthPacer`): `frame(personal, shared)`.
  - `shared` (cached per `(viewerBubble, baseTick)` so survivors in the same chunk bubble with the same acked tick
    encode once): header (`tick`, `time`, `hour`, `revision`, `sectionFlags`, optional `baseTick`), all 1–6 survivors
    (12 B each: `i32` cm position, 12-bit aim + 4-bit flags, 7-bit light + exhausted bit, health, optional recoil/lift),
    interest-culled zombies inside the recipient's `128 × 128 m` bubble (`±64 m` around their `3 × 3` chunk window)
    delta-compressed against `baseSnap.zombies` via a changed-entity bitfield, 1-byte nibble (`±7 cm`) or 2-byte `i8`
    (`±127 cm`) position deltas, 8-bit aim and optional state/HP/FX sub-flags (with non-urgent mid/far/idle zombies
    throttled to 10 Hz / 5 Hz), door/window bitfields + sparse non-zero barricade planks (omitted completely when
    `revision` is unchanged since `baseTick`), and new shots/bashes/pings/lures since `baseTick`.
  - Special zombie kinds (`shared/specials/`) add no field: a special's kind rides in its zombie seed (low nibble plus a
    12-bit check, `encodeSpecialSeed`), and a special's seed is never the id's default, so the full zombie record
    already carries it. Deltas never resend a seed, so every zombie is rolled before the snapshot that first carries
    it: in the feature's `stepWorld` (chunk and horde spawns) and its `stepWorldLate` (director spawns during the
    crowd step). `tests/specials.test.ts` checks every zombie in every snapshot against the room.
    HP is an unsigned varint in full and delta records: a Brute's 320 HP takes two bytes instead of being clipped
    to 255; ordinary HP up to 127 still takes one byte when present.
  - Death (`shared/death/`) adds a section (bit 256): see [Death](#death).
  - Noises (`shared/noises/`) add a section (bit 512): see [Sound](#sound).
  - Bloater gas (`shared/specials/net.ts`, bit 1024) carries active clouds near the viewer: id, cm position, birth
    and expiry times, and cm radius. Clients draw these hazards even when they missed the Bloater's death.
  - Body lifecycle (`shared/bodies/net.ts`, bit 2048) carries nearby `body:` store ids with `rise` and `risen`.
    Slot-store inventory deltas omit counters, so the client restores these after applying its personal ledger delta.
  - Door breaches (`shared/breach/net.ts`, bit 8192) carry every damaged door and window: index, integrity, flags
    (broken, giving, holed, wedged, slab, grabbing, breached), breach kind, pushers, bracers and side, plus the warning
    and breach times and the fallen slab's position when set. About 5 bytes an opening; late joiners see the same wear.
    Both sections compare against the acked base, omit unchanged state, and send an empty list to clear it.
    One nearby cloud costs 20 payload bytes with a one-byte id; a `body:near` lifecycle record costs 14 with a
    one-byte rise time. Counts, ids and strings make larger payloads variable; quiet deltas cost zero section bytes.
  - Zombie behaviour (`shared/behaviour/net.ts`, bit 4096) carries what each zombie in the bubble is doing as
    id (u16) + activity code (u8) pairs; deltas carry only changed codes (0 clears) and are omitted when nothing
    changed. Everything else (personality, memory, search plans) is derived from the seed or stays on the host; the
    client writes the codes into its minds so poses and the overlay match. A bot-played two-night town averages
    0.23 B per 20 Hz delta (0.04 kbit/s), 13 B at most; a full snapshot of every zombie in town was 43 B at most.
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

## Death

`shared/death/` (AR-61), the same rules offline and in a room. Lab › Death (Backquote) holds every value; "Death:
Today (nobody dies)" is the game as it was, where health stops at 0 and nothing else happens.

```
alive ──0 HP──▶ down ──bleed-out runs out──▶ dead ──squad's next dawn──▶ alive at the safehouse, starting kit
                 │  ▲                          │
   teammate holds E│  │                          └── everyone dead ──▶ run over
   for 4 s ────────┘  └ back up with 30 HP
```

- **Dragged to safety** (AR-96, `docs/outbreak-interactions.md`): a teammate's tap E at a downed survivor hauls them
  behind at 0.55 pace (`haul:<seat>` ledger store, so every seat sees it); hold E still revives.
- **Down** (at 0 HP, checked after the crowd's attacks each tick): out of any car or closet, whatever they were doing
  cancelled. They can only crawl (0.45 m/s); no shots, swings, reloads, items or doors, and no prompt of their own.
  The dead keep feeding: each point of damage takes 0.12 s off the bleed-out instead of health. Bleed-out is 30 s
  while a teammate stands, 6 s alone (solo, or once nobody is left standing).
- **Revive**: a standing teammate within 1.6 m holds E ("Revive" prompt, the `downed` interaction). Progress fills
  over 4 s and resets if they let go for a quarter second or step away.
- **Dead**: the body stays where they fell (`FallenBody`, ledger store `fallen:<seat>:<n>` holding their hotbar, belt
  and pack; a teammate takes one thing with a digit from the strip or everything by holding E, never with a tap, and not
  in the first 1.5 s, so an E held to revive them can't strip them; bare hands stay with the survivor, and a second
  pistol stays on the body because each survivor carries one), their light goes out and the crowd can no longer see or hear them. In
  co-op they watch a standing teammate (camera, sight shroud and listener follow that teammate) until the squad's
  next dawn, then wake at their spawn point beside the Ash House with full health and the standard kit. "The dead
  come back: Never" keeps them dead until the run ends.
  The room selects a `watching` seat before encoding snapshots and centers the dead player's interest bubble on
  that seat. Only seats whose players are connected count (a dropped seat's survivor stands idle for the 60 s grace
  window; after the Oct 20 playtest's "I have the bot the whole time" the dead no longer end up watching it), and
  Space or a click while dead moves to the next standing teammate (`nextWatch`; the banner shows the Space cap when
  there is more than one). The camera consumes the same replicated choice, keeps it while that teammate stands, and switches
  when they fall. A dead record adds one byte for this seat (zero means nobody).
- **Run over** when every survivor is dead: a card with the survivor's name, cause ("Taken by a Brute on Night 3", from
  the nearest zombie when they went down), day, nights survived and kills (the last blow, `lastHitBy`), plus
  Restart, New town (solo) and Lobby. A room's Restart (`{t:"restart"}`, accepted only once the run is over) builds a
  fresh `CoopSim` for every seat and sends `{t:"reload", reason:"restart"}`; clients reload and rejoin with their
  seat tokens.
- **On the wire**: the death section (bit 256; the header's section flags are a varint, so bits past 128 cost a
  byte): the down and dead with cause, bleed-out (0.1 s), revive progress and reviver, the fallen bodies, and at the
  end the dawns and every seat's kills. Sent whole when it differs from the acked base snapshot, omitted otherwise
  (the base's carries over), so a quiet run costs nothing. `NetSession` writes it into its `CoopSim`'s death state,
  which drives the prompt, prediction (a downed client crawls), presentation and sound.
- **Presentation** (`src/death/`, through the client registry's `frame` hooks): a line under the clock for every
  standing survivor when a teammate goes down ("Bob is down · Get to them and hold E Revive") or dies; the down screen tightens and drains of
  colour as the bleed-out runs, with a heartbeat that quickens; "Down" markers over downed teammates with the hold-E
  key cap whose ring fills as you revive; downed and dead survivors lie face down in their seat's colours over a
  blood pool and smear; a death sting. Sounds are library samples re-pitched (`src/audio/death.ts`): there is no
  heartbeat or sting sample yet.
- **Bots** treat a survivor's first fall as final (`shared/bot-runner.ts`), so the ramp's survival numbers keep
  describing the first death. They do not revive teammates.
- Lab › Death has Down me, Kill me, Revive me, Add a teammate, Down teammate and Kill teammate (offline); commands
  `death.down`, `death.kill`, `death.revive` (`who=mate` for the teammate) and `death.mate`. Tests:
  `tests/death.test.ts`.
- When everyone is dead the run is over; when the squad escapes by The Way Out the run is won, and `runOver` is true
  for both so Restart works from either card ([outbreak-way-out.md](outbreak-way-out.md#state-and-co-op)).

## Sound

Co-op adds nothing to the wire for sound. The client's `CoopSim`, filled from snapshots, drives the same
`SoundDirector` as offline play ([sfx-library.md](sfx-library.md#outbreak)): shots with their shooter, doors, windows,
planks, bashes and zombie states are heard where they happen, and remote survivors' replicated flashlight, reload,
health and exhaustion become sounds at their positions; their footsteps come from their rigs' foot contacts. Like the
rest of the shared world, a remote shot or door is heard one snapshot late.

What the dead hear does go on the wire, for the sound cues, the Unseen ripples, crows and callouts that read the noise
bus (`view.noises`): a client never steps the crowd, so its own bus would stay empty. The noises section (bit 512,
`shared/noises/net.ts`) carries each noise the room's bus made since the base snapshot's newest id (`upTo`), once, with
its room id, kind (a byte), cm position and radius, ms age, loudness and ttl, and whose it was (a seat, or the source
id: `zombie-12`, `radio`, a dog). Footsteps stay off it (yours come from `personal`, teammates' draw nothing), and so do
noises too far from the recipient's bubble to be heard (`bubbleHalfExtent + 1.5 × radius + 8 m`); at most 24 a
snapshot, about 18 bytes each, and nothing when the room was quiet. The client feature (`src/noises/`) adds them to its
bus under the same ids and seat ids, prunes it by ttl, and sets the crowd's threat from the replicated hour as the room
does, so cue rings match the room's. `tests/coop-noises.test.ts` checks it through the real room code.

## Training room

The training room (AR-89, [outbreak-onboarding.md](outbreak-onboarding.md)) is solo only: it is an offline
`LocalSession` the client makes from the lobby's Play Solo or Training Room, so a co-op room never sees it, and its
shared feature (`onboarding`) is inert unless that session staged it. Nothing of it is on the wire.

## Known gaps

- Co-op accepts only the default town seed (7). New town remains solo-only, and this seed's Way Out route has no
  chained gates; bolt-cutter gate activation has domain tests but no supported-room scenario.
- Weather timing and lightning ids are shared, but near strikes choose positions relative to each viewer. Two
  separated players can see the same strike hit different trees or lamps.
- Crow sites and incoming shot noises agree. Flight state is client-local: a late joiner after the noise expires
  has no record of the scatter. Local survivor proximity can also produce different flight histories.
- Doors, loot, barricades and shots take a round trip (no client-side muzzle flash prediction yet); server hitscan
  evaluates against zombie positions rewound to the shooter's `viewTick` (`@arcade/kit/net/rewind`, clamped to 250 ms).
- Remote survivors show body, flashlight, name tag, and the character HUD (callouts and health, reload and exhaustion
  rings, see [outbreak-hud.md](outbreak-hud.md)) built from replicated flags, but not their pistol. Reload progress
  is timed on the viewer's side because the snapshot carries only a reloading flag.
- No persistence: a room resets once every survivor has been gone for 60 s. A survivor whose seat expires leaves what
  they carried on the floor. No quick join; rooms are links only. Lab tuning, spawns and the AI debug overlay only
  affect the offline session (so a room always plays the default Death rules).
- Blackout and Brawl share `@arcade/kit/net/room-core`, which now uses the same `seats` tokens, `jitter-buffer` and
  per-socket rate limit as this room; Getaway still carries its own room loop. Blackout draws remote soldiers and vehicles through
  `SnapshotBuffer` and predicts with `Predictor`; `@arcade/kit/net/{rewind,interest}` are ready for it to add 20-tick
  server hitscan rewind (`RewindHistory`).

## Proof

- `games/outbreak/tests/coop-feature-room.ts` runs `CoopRoomCore` and two real `NetSession`s over `Loopback`.
  Tests drive both the host and teammate, then add a late joiner. Fixed scenario positions, inventory grants and
  hidden body rolls set up the cases; actions and binary reconciliation use production code.
- The `coop-*-parity`, `coop-ledger-features`, `coop-reset-ramp` and `coop-feature-bandwidth` tests cover gas and
  all six special kinds' seed/HP/state, body searches/reanimation, all seven fire items, radios, dogs, lamps,
  Recipe Board, Way Out, vehicle repair/fuel and roadblock collision, death/revive/dawn and spectator switches,
  seeded scenery, crow noise inputs, private peek/shared hearing shells, weather, late ammo and room Restart.
  Gas tests also compare CPU-generated sprite data. Other presentation checks assert the state consumed by drawing;
  they do not prove GPU output or audible playback. Special-specific combat rules also have domain tests in
  `specials.test.ts`; the room matrix checks their replicated kind, health and response to a shot.
- `coop-design-gaps.test.ts` records unsupported town seeds, viewer-relative near lightning, and missing crow
  flight history. Passing these tests documents the limits; it does not establish parity for those features.
- Restart tests dirty feature state, request a real room restart from either seat, and construct fresh clients with
  the existing tokens. They check world/ledger/life/peek/vehicle reset; browser reload and GPU/audio resource teardown
  are outside this CPU suite. Air, vegetation, reflections, look, props and anti-aliasing remain local rendering
  features; this suite makes no pixel-parity claim for them.
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
