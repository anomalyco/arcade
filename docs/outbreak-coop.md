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
- **Shared per room, private per player.** Doors, windows, barricades, searched containers, zombies, shots and the
  clock are shared. Inventory, ammo, planks, stamina, battery and channels belong to each survivor.
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

## Proof

- `games/outbreak/tests/coop-sim.test.ts`: 2–4 survivors, zombies split targets, shared doors and loot, private ammo.
- `packages/kit/net/*.test.ts`: jitter buffer edges, seats/tokens, interpolation, prediction reconciliation.
- `games/outbreak/scripts/coop-smoke.ts`: two protocol clients against `wrangler dev` (or production): join, move,
  open a door, shoot, and check that both clients agree. Also reports bytes per client per second.
- `games/outbreak/scripts/coop-bench.ts`: server CPU per tick and snapshot bytes at 4 survivors and 60 zombies.
