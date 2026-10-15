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
  `splice` bug). Wings itself is an independent project and keeps its copy.
- `seats.ts`: join, leave, reconnect. Each seat has a public `id` (seen by everyone) and a private `token` (only the
  owner sees it, used to reclaim the seat within the grace window).
- `bytes.ts`: a small little-endian `ByteWriter`/`ByteReader`, and `frame(personal, shared)` which prefixes a
  per-recipient header to a shared payload encoded once per snapshot.
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

- Up: JSON `{t:"in", s, c:[[mx, my, aim, flags, slot?, delta?, action?], …]}`, two 60 Hz commands per message.
- Down, text: `welcome` (public id, private token, seat index, room options), `roster`, `pong`, `error`, `reload`.
- Down, binary snapshot at 20 Hz: `frame(personal, shared)`. `shared` (encoded once): tick, clock, survivors
  (position cm, packed aim, flags, light, health, recoil, vault lift), zombies (15 bytes each: id, state, position,
  aim, hp, hit flash, state time, stagger, clamber), door/window bit fields, barricade planks, pings and noisemakers,
  recent bashes and shots with shooter seat. `personal`: ack, the survivor's fields as a positional JSON array, the
  ledger stores this player can see (shared ones and their own) that changed since the revision they last received
  (everything on join or reconnect), and that player's notices ("Inventory full", recipes learned). Velocities are
  derived from the two interpolated snapshots.

## Measured

`scripts/coop-bench.ts` (in-process room, 4 NetSession clients over a 50 ms loopback, 60 zombies, 60 s, M2 Max
under heavy load from other agents): room tick mean 0.12 ms (p50 0.09, p95 0.23, p99 0.58 ms) at 60 Hz, about
7 ms of CPU per second; snapshots about 1.7 KB, **33.7 KB/s down and 2.8 KB/s up per client**. With the default 28
zombies, `coop-smoke.ts` against `wrangler dev` measured 18–23 KB/s down per client. Over a 3 + 0–8 tick jittery
loopback the jitter buffer made stand-ins and every one of five shots still landed (`tests/coop.test.ts`).

## Known gaps

- Doors, loot, barricades and shots take a round trip (no prediction or local muzzle flash yet); hitscan has no lag
  compensation (the room hits zombies where they are now).
- Remote survivors show body, flashlight, name tag, and the character HUD (callouts and health, reload and exhaustion
  rings, see [outbreak-hud.md](outbreak-hud.md)) built from replicated flags, but not their pistol. Reload progress
  is timed on the viewer's side because the snapshot carries only a reloading flag.
- No death or downed state, no persistence: a room resets once every survivor has been gone for 60 s. A survivor
  whose seat expires leaves what they carried on the floor. No lobby or
  quick join; rooms are links only. Lab tuning, spawns and the AI debug overlay only affect the offline session.
- All zombies are sent to everyone every snapshot (no interest management or deltas); fine at 60, not at 300.

## Proof

- `games/outbreak/tests/coop-sim.test.ts`: 2–4 survivors, zombies split targets, shared doors and loot, private ammo.
- `packages/kit/net/*.test.ts`: jitter buffer edges, seats/tokens, interpolation, prediction reconciliation.
- `games/outbreak/scripts/coop-smoke.ts`: two protocol clients against `wrangler dev` (or production): join, move,
  open a door, shoot, and check that both clients agree. Also reports bytes per client per second.
- `games/outbreak/scripts/coop-bench.ts`: server CPU per tick and snapshot bytes at 4 survivors and 60 zombies.
