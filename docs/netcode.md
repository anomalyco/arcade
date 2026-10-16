# Netcode

Read this before adding multiplayer to a game or changing room, prediction, interpolation, or wire code in
`@arcade/kit/net` or `games/*`.

## Why online games feel laggy, and how we split authority

On a normal home Wi-Fi link, a WebSocket frame takes about 80 ms to make a round trip, with ±15 ms of jitter, 1% packet
loss that pauses TCP delivery for 200 ms while a lost segment retransmits, and occasional 150 ms radio stalls. If a
game waits for the room server before moving your character, playing a gunshot, starting a swing, or lighting up boost,
every button press feels 80 to 250 ms late. If the client draws other players at the latest snapshot without velocity
extrapolation or stall coasting, every TCP retransmit freezes everyone else in place and snaps them forward when the
burst arrives.

Arcade games avoid both problems by splitting what happens on the press frame from what waits for the room:

1. **Your own motion and action feedback happen on the press frame (`0 ms`).** The client steps your character or
   vehicle immediately using the shared deterministic simulation in `shared/` and triggers local audio, animation,
   muzzle flashes, and cooldown UI through `OptimisticEvents`.
2. **Other players and enemies render 80–100 ms in the past along velocity curves.** `SnapshotBuffer` adapts its delay
   to measured jitter, slews clock shifts within ±2% per frame, coasts up to 250 ms through TCP stalls along each
   entity's velocity (`hermite2`), and blends out the post-stall jump with `Glide`.
3. **The server decides shared outcomes against the world the player saw.** Damage, kills, loot transfers, and phase
   changes come from the room. For hitscan and fast projectiles, the room rewinds targets (`RewindHistory`) to the
   client's rendered timestamp (`renderTime`), capped at 250–350 ms.

| Layer | Authority | Perceived latency | Kit module |
| --- | --- | --- | --- |
| Local movement & driving | Client predicts at tick rate; server reconciles at `ack` | `0 ms` | `@arcade/kit/net/prediction` (`Predictor`, `Smoother`) |
| Local action cosmetics & cooldowns | Client fires on press (`seq`); server confirms or rolls back at `ack` | `0 ms` | `@arcade/kit/net/prediction` (`OptimisticEvents`) |
| Hitmarkers | Client shows tentative tick on press; server upgrades to confirmed hit | `0 ms` tentative, `1 RTT` confirmed | `@arcade/kit/net/prediction` (`OptimisticEvents`) |
| Remote players, vehicles, enemies | Server snapshots interpolated 80–100 ms behind with `hermite2` + coast + `Glide` | `½ RTT + 80–100 ms` | `@arcade/kit/net/interpolate` (`SnapshotBuffer`, `hermite2`, `Glide`) |
| Hitscan & fast casts vs moving targets | Server rewinds target history to shooter's `renderTime` (capped 250–350 ms) | `0 ms` lead error | `@arcade/kit/net/rewind` (`RewindHistory`) |
| Deterministic 60 Hz one-hit games | Input relay + client rollback + `TickPacer` | `0 ms` local, near-real-time remote | `@arcade/kit/net/rollback` (`RollbackClient`, `InputRelay`, `TickPacer`) |
| Server WebSocket input queue | Sized from p90 arrival lateness (`socketJitter`), carries one-shot edges | `0` extra ticks on clean links | `@arcade/kit/net/jitter-buffer` (`JitterBuffer`, `socketJitter`) |

---

## 1. Client-side prediction and smooth reconciliation

Keep all movement, collision, and vehicle physics in `games/<name>/shared/` free of DOM and Worker APIs so the room
Durable Object, solo mode, and client prediction run the exact same code.

Before recording or stepping a local input on the client, quantize it with the same function the wire codec uses
(`quantizeInput` in Getaway and Blackout, `unpackCommand(packCommand(cmd))` in Outbreak). If the client predicts with
full 64-bit floats while the server steps 3-decimal or bit-packed numbers, every snapshot will produce a false
reconciliation correction.

On each fixed client tick:

1. Quantize the sampled input and record it in `Predictor<Cmd>` (`const seq = predictor.record(cmd)`).
2. Step your local player or vehicle immediately with `cmd`.
3. Send `{ seq, cmd }` to the room.

When a snapshot arrives with `ack` (the last input `seq` the server applied) and `you` (your authoritative state after
that tick):

1. Save your currently drawn position `(beforeX, beforeY)`.
2. Call `predictor.reconcile(ack, () => copyState(local, you), (cmd, seq) => stepLocal(local, cmd, seq))`.
3. Pass `(beforeX, beforeY, local.x, local.y)` to `Smoother.correct(...)`.

`Smoother` (`@arcade/kit/net/prediction`) stores the visual offset `(ox, oy)` between where you were drawn before the
snapshot and where replay put you, then decays that offset exponentially every rendered frame (`exp(-rate * dt)`,
typically `rate = 12..14/s`) while snapping outright if the error exceeds `snapDist` (`2..6 m`, such as a respawn or
tunnel teleport). Render your character at `(local.x + smoother.ox, local.y + smoother.oy)` so a 1-tick server catch-up
or collision push never pops the camera.

### Nearby vehicle proxies (`Getaway`)

In a car chase where players ram each other at 40 m/s, drawing remote cars 100 ms in the past means a car you hit in
your predicted world is still two car-lengths behind on screen. Getaway (`games/getaway/src/game/netcode.ts`) solves
this by rebuilding lightweight collision proxies for other cars on each snapshot and stepping them forward (`coast`)
alongside your predicted car during replay and live ticks. Other cars beyond `FAR = 28 m` render at their smooth
interpolated snapshot pose; inside `NEAR = 10 m` they blend to their predicted proxy pose so impacts connect visually on
the exact frame they happen in prediction.

---

## 2. Predict the feedback, confirm the outcome (`OptimisticEvents`)

Never wait for a server round trip to play the sound, animation, muzzle flash, or HUD cooldown of the local player's
own action. Instead, split every action into immediate local feedback and server-confirmed outcome:

- **Immediate on the press frame (`0 ms`):** gunshot or melee swing sound, muzzle flash and tracer, weapon recoil,
  ability cast pose, door swing start, nitro ignition, gadget deploy cue, and optimistic cooldown or ammo decrement.
- **Wait for server confirmation (`1 RTT`):** health loss, kill banners, score increments, shared physics impulses on
  other players, and permanent inventory mutations when another player races for the same item.

Use `OptimisticEvents<Kind, Payload>` (`@arcade/kit/net/prediction`) to track every predicted one-shot action by the
input `seq` that triggered it:

```ts
this.optimistic.predict({
  seq,
  kind: "fire",
  key: "weapon",
  payload: { shotId, targetId },
  rollback: () => {
    this.local.ammo = Math.min(this.local.maxAmmo, this.local.ammo + 1)
    this.predictedCooldown = 0
  },
})
```

When a server event or snapshot arrives:

1. **Match and confirm** the pending entry (`confirmWhere` or `confirmByKey`) so the echoed server event does not play
   a duplicate gunshot, swing sound, or tracer for the local player.
2. **Reconcile at `ack`** (`this.optimistic.reconcile(ack, (ev) => isConfirmedBySnapshot(ev))`). Any entry whose
   `seq <= ack` was not confirmed by the server (for example, you were stunned on the server one tick before your press
   arrived, or a teammate grabbed the pickup first) is rejected: `OptimisticEvents` invokes its `rollback()` closure
   once and increments `stats.rejected`.

Rollbacks should restore state quietly (resetting the cooldown bar, restoring the round in the magazine, or easing a
door back shut) without playing an error buzzer.

### Two-tier hitmarkers

In shooters (`Blackout`, `Outbreak`), run a local raycast against the currently drawn positions of targets on the press
frame:

- If the local raycast hits a target, show a **tentative hitmarker** (a lighter, smaller reticle tick) at `0 ms`.
- When the server's authoritative hit event arrives (resolved with lag compensation), upgrade it to the **confirmed
  hitmarker** and play the hit/kill sound.
- If the server rejects the shot, let the tentative tick fade out on its normal `80 ms` decay without a jarring yank.
  With server rewind enabled (`RewindHistory`), tentative hitmarkers have a `0%` false-positive rate on `good`, `wifi`,
  and `bad` links in `scripts/bench-netcode.ts`.

---

## 3. Animation wind-ups covering RTT

Whenever a game design allows a brief wind-up before an effect lands in the world, use that wind-up to hide network
latency completely:

- **Melee swings, heavy abilities, and throws** (`Brawl` ability `windup` of `0.12–0.35 s`, `Blackout` frag throw and
  claymore placement, `Outbreak` `0.14 s` melee wind-up): start the wind-up animation and sound on the press frame
  (`0 ms`) and send the input to the server on the same tick. By the time the local wind-up reaches its release frame
  120–200 ms later, the server has already received the input and broadcast the authoritative projectile or hit.
- **Hold interactions** (`Outbreak` search, barricade, and reload progress rings; `Getaway` repair bays): start the
  progress ring immediately on press while the server validates completion at the end of the hold.
- **Launch and lock sequences** (`Carrier` catapult stroke, arrestor wire trap, missile seeker lock tone): run the
  deck-local motion immediately and let the room arbitrate detonation when the flight finishes.

---

## 4. Interpolating remotes in the past: adaptive time-stretch, `hermite2`, coasting, and `Glide`

Remote players, vehicles, and enemies cannot be drawn at the latest snapshot's timestamp because the next snapshot has
not arrived yet. Draw them slightly in the past using `SnapshotBuffer<T>` (`@arcade/kit/net/interpolate`):

```ts
const snapshots = new SnapshotBuffer<Snapshot>(0.1, { min: 0.08, max: 0.1 })
```

### Adaptive, time-stretched `renderTime`

A fixed `100 ms` delay wastes 20 ms on clean connections, while computing `renderTime = localTime - offset - delay`
directly steps `renderTime` backward or forward whenever `offset` or `delay` updates on snapshot arrival. At 120 fps,
a 2 ms step in `renderTime` produces a 1.5–3 m/s velocity spike on a fast vehicle.

`SnapshotBuffer` avoids both problems:

- **Adaptive delay (`{ min: 0.08, max: 0.1 }`):** tracks an EWMA of inter-arrival jitter (capping single TCP retransmit
  bursts at `80 ms` so one lost packet does not pin the delay at max) and sets target delay to
  `clamp(interval + 2 * jitter, min, max)`. Clean links run at `80 ms`; noisy Wi-Fi widens to `100 ms`.
- **Time-stretch slew (`±2%` of `dt`):** `renderTime(localTime)` slews the combined shift (`offset + effectiveDelay()`)
  by at most `0.02 * dt` per frame (`1.02×` catch-up or `0.98×` slow-down), snapping only on gaps above `250 ms`.
  Render time stays monotonic and velocity-continuous across every frame.

### Velocity-aware cubic Hermite (`hermite2`), coasting (`over`), and `Glide`

Linear interpolation (`lerp`) between 15 Hz or 20 Hz snapshots makes fast entities turn in sharp polygon corners at
every snapshot boundary, and clamping `t` to `[0, 1]` freezes every remote entity solid during a TCP retransmit.

Instead, combine three steps in `@arcade/kit/net/interpolate`:

1. **Sample with `snapshots.sample(now)`**, which returns `{ a, b, t, over }`. Between `a` and `b`, `t` runs in
   `[0, 1]` and `over` is `0`. When `renderTime` runs past the newest snapshot `b` during a stall, `t` is `1` and
   `over` grows up to `maxCoast` (`0.25 s` by default).
2. **Evaluate `hermite2(a, b, span, t, over, maxDeviation)`** when velocities `(vx, vy)` are replicated (or coast along
   the chord velocity `(b.x - a.x) / span * over` when only positions are replicated). `hermite2` follows a cubic
   Hermite curve matching both snapshots' positions and velocities, falls back smoothly to the chord if a wall clamp
   pushes a tangent more than `maxDeviation` (`2–4 m/s`) off the chord, and coasts linearly along `b`'s velocity for
   `over` seconds during a stall.
3. **Pass the sampled position through a per-entity `Glide(rate = 10, maxJump = 3..4)`** (`glide.step(x, y, vx, vy,
   over > 0, dt)`). While coasting (`over > 0`), `Glide` tracks the extrapolated velocity. On the frame a stalled
   snapshot burst arrives and `over` drops back to `0`, `Glide` absorbs the position jump into a decaying offset
   (`exp(-10 * dt)`) so the remote entity curves smoothly onto its new path instead of teleporting.

---

## 5. Server lag compensation (`RewindHistory`, capped)

When a player fires a hitscan weapon or fast cast at a moving target, the target on the shooter's screen is drawn at
`SnapshotBuffer.renderTime(now)` (`80–100 ms` behind the server's clock), and the fire command takes another `½ RTT`
(`40–75 ms`) to reach the server. Without lag compensation, the server tests the shot against where the target is
`150–290 ms` later, forcing players to lead a `5 m/s` target by `0.75–1.45 m` even with a hitscan weapon.

Fix this with `RewindHistory<Id, Pose>` (`@arcade/kit/net/rewind`):

1. **Client sends `view` (`renderTime`):** When firing, include the current `snapshots.renderTime(now)` (in seconds or
   ticks) on the input frame.
2. **Server records poses every tick:** At the end of each simulation tick, call
   `rewind.record(simTime, entities, (e) => ({ id: e.id, x: e.x, y: e.y, ... }))`.
3. **Server rewinds during hit resolution:** When resolving a shot with `viewTime`, call
   `rewind.sampleAt(viewTime, simTime)` (which clamps `viewTime` to `[simTime - maxRewind, simTime]` and linearly
   interpolates between the two bracketing ticks) or `rewind.withRewound(viewTime, simTime, applyPose, runRaycast)` to
   temporarily move targets to their historical positions, run the raycast, and restore their present positions.

Always cap `maxRewind` (`250 ms` in Outbreak, `300 ms` in Blackout, `350 ms` in Brawl). The cap prevents a player on a
frozen or 1,000 ms connection from shooting targets that moved behind cover a full second ago.

### Hybrid combat authority for fast jets (`Carrier`)

When targets move at 250 m/s in 3D (`Carrier` dogfights), even a small clock-sync error is several metres of cannon
dispersion. Carrier (`games/carrier/shared/combat.ts`, `server/core.ts`) uses hybrid authority: each shooter steps its
own cannon rounds locally against the enemy jets at the exact poses it draws them (`120 ms` behind) and reports hits to
the room; the room checks that the shooter and target are alive enemies within gun range and that the hit count fits a
token-bucket ammo budget refilled at the gun's fire rate. Slower ordnance with counterplay (heat-seeking missiles,
flares, bombs, and 5-inch/CIWS/SAM naval gunnery) runs authoritatively in the room's `CombatWorld`.

---

## 6. Deterministic rollback for one-hit games (`@arcade/kit/net/rollback`)

For fast, small-arena games where every frame's exact contact decides a hit and the entire simulation steps in a few
microseconds (`Archers`: `6.4 µs` per 60 Hz step with 4 players, `10 µs` per clone), use deterministic rollback instead
of client-only prediction plus interpolated remotes:

- **Room as `InputRelay`:** The room does not broadcast world snapshots every tick. Each 60 Hz tick it takes one input
  per player from `InputRelay`, steps its copy of `World` for late-joiners and hash checks, and broadcasts only the
  packed input frame (`~45 B`) plus a 32-bit FNV-1a world hash every 30 ticks.
- **Client `RollbackClient` + `TickPacer`:** The client maintains a confirmed `World` (advanced only as room frames
  arrive) and a predicted `World` stepped to its local head (`confirmedTick + lead`). `TickPacer` estimates the room's
  current tick from the fastest-arriving frame over a `0.5 s` window and learns its input lead (`3–5 ticks` on Wi-Fi)
  from the 90th percentile of room-reported arrival margins (`lateTicks`), updating the quantile **once per arriving
  frame** so a stale integral never overshoots.
- **Rollback and visual smoothing:** When a room frame reveals that a remote player's buttons changed `k` ticks ago
  (up to `maxCoast = 12` ticks), `RollbackClient` clones the confirmed world and re-simulates forward to the predicted
  head. Position corrections decay over `~70 ms`, and `EffectGate` suppresses duplicate sounds/particles when a
  re-simulated tick fires the same event within `4` ticks.
- **Cross-engine determinism rule:** In `shared/` code used for rollback, use only `+`, `-`, `*`, `/`, `Math.sqrt`,
  `Math.floor`, `Math.round`, `Math.min`, `Math.max`, `Math.abs`, and `Math.imul`. Never use `Math.hypot`, `Math.sin`,
  `Math.cos`, `Math.atan2`, `Math.exp`, `Math.log`, or `Math.pow` in simulation state transitions, because their last
  bit is not specified across JS engines.

---

## 7. WebSocket input buffering (`socketJitter`) and tick-rate pacing

WebSockets run over TCP, which guarantees in-order delivery. That changes how the server's input jitter buffer must
work compared to UDP:

- **Why underrun-grown buffers fail on TCP:** Over TCP, a single lost packet stalls the entire stream for `~200 ms`
  while the OS retransmits it, then delivers all held inputs at once in a single burst. A jitter buffer that increases
  its target depth whenever it underruns treats that retransmit stall as jitter, ratchets its target depth up to `4–6
  ticks`, and never drains back down, adding `150–250 ms` of permanent input lag (`Getaway` previously sat at `267 ms`
  press-to-server p50 on Wi-Fi).
- **Size from arrival lateness (`socketJitter(tickHz)`):** `socketJitter(tickHz)` in `@arcade/kit/net/jitter-buffer`
  measures how many ticks behind the ideal schedule each input arrives (`lateness = arrivalTick - expectedTick`),
  clamps single-packet TCP retransmit spikes to `2 ticks` so they are bridged by stand-ins rather than buffered for, and
  sets `targetDepth` to the 90th percentile of arrival lateness over a `3 s` window (`0` ticks on a clean link, `1`
  tick on Wi-Fi, at most `2` ticks).
- **Never drop a one-shot edge:** Every game supplies `InputOps<Cmd>` (`merge`, `standIn`, `hasEdges`). When a tick runs
  dry, `JitterBuffer.take()` stands in with the last held movement (`standIn(last)`), clearing one-shot presses so a
  shot or dash does not fire twice. If the real input for that tick arrives late (or is trimmed by `maxQueue`), its
  one-shot presses (`hasEdges`) are folded into a `carried` slot and merged into the next applied input. When a post-stall
  burst leaves the queue deeper than `targetDepth + catchUpSlack`, `take()` returns two inputs that the room merges
  (keeping the newer movement and both ticks' presses).
- **Tick alignment rule:** If your room's `step()` increments `this.tick++` *before* calling `jitter.take(this.tick)`,
  you must push incoming socket inputs with `jitter.push(seq, input, this.tick + 1)`. Passing `this.tick` makes every
  on-time input look 1 tick late and inflates the buffer by 1 tick.
- **Client tick-rate pacing (`±2%`):** When a client's `requestAnimationFrame` clock runs slightly faster or slower
  than the Durable Object's `setInterval` tick clock, the server's input buffer slowly fills (triggering catch-up
  merges and 1-tick prediction corrections) or drains (triggering stand-ins). Reporting the server buffer's slack
  (`queueDepth - targetDepth`) in snapshots and nudging the client's tick accumulator rate by up to `±2%` keeps the
  queue centered at `targetDepth` without catch-up merges during steady play.

---

## 8. What NOT to do

1. **Do not re-send previous inputs (`prevCommands`) on every tick over a WebSocket.**
   Sending the last 2–3 commands in every packet is a UDP technique for surviving dropped datagrams without a
   retransmit. Over a TCP WebSocket, packets are never dropped out of order; re-sending `prev` on every tick only bloats
   upstream frames and gets discarded by `seq <= lastSeqPushed` on the server.
2. **Do not use a fixed `100 ms` interpolation delay or un-slewed `renderTime`.**
   Always pass `{ min: 0.08, max: 0.1 }` to `SnapshotBuffer` so clean links render at `80 ms` and `renderTime` slews
   clock and delay changes within `±2%` of `dt`.
3. **Do not suppress echoed server events with wall-clock timers (`ignoreUntil = now + 0.25`).**
   A fixed timer either swallows a second fast action on a low-ping link or lets a delayed server echo play a duplicate
   sound after a TCP stall. Always track optimistic actions by input `seq` in `OptimisticEvents` and reconcile against
   `ack`.
4. **Do not clamp remote interpolation to `t <= 1` without `over` coasting and `Glide`.**
   Using plain `lerp(a, b, t)` with `t` clamped to `[0, 1]` freezes every remote player, vehicle, and enemy during
   every TCP retransmit stall and snaps them when the burst arrives. Use `bracket.over` (up to `250 ms`) and `Glide`.
5. **Do not trust client-supplied player IDs on `hello`, or keep reconnect tokens only in memory.**
   Use `@arcade/kit/net/seats` (`Seats`) or an equivalent server-generated random token (`128-bit` hex), store it in
   `sessionStorage` keyed by room (`<game>:token:<room>`), and only resume a seat when the client presents the matching
   private token. Include `BUILD` (`shared/build.gen.ts`) in `hello` so a client running stale code reloads into the
   same room automatically, and enforce a per-socket token-bucket message rate limit (`90–120 msg/s`).

---

## 9. New-game multiplayer checklist

Before shipping or promoting an online game, verify every item below:

- [ ] **Deterministic `shared/` sim:** Movement, collision, and rules live in `shared/` with no DOM/Worker globals;
      inputs are quantized identically before local prediction and wire encoding.
- [ ] **Client movement prediction + `Smoother`:** Local player/vehicle steps on the press frame (`0 ms`), replays
      unacked inputs (`seq > ack`) on snapshot arrival, and eases visual corrections with `Smoother` (`12–14/s`, snap at
      `2–6 m`).
- [ ] **Optimistic action feedback (`OptimisticEvents`):** Every player-initiated action (fire, swing, dash, cast,
      reload, interact, gadget, boost, engine toggle) plays its local sound/animation/cooldown at `0 ms`, confirms by
      `seq` on server event/snapshot, and rolls back cleanly if rejected at `ack`.
- [ ] **Two-tier hitmarkers (shooters):** Local raycast triggers a tentative reticle tick at `0 ms`; server confirmation
      upgrades it to a confirmed hitmarker (`0%` false-positive rate in `bench-netcode.ts`).
- [ ] **Wind-up animations covering RTT:** Heavy swings, casts, throws, and hold actions start their wind-up or progress
      ring on the press frame so the server outcome lands as the wind-up completes.
- [ ] **Adaptive time-stretched `SnapshotBuffer`:** Remotes use `new SnapshotBuffer(0.1, { min: 0.08, max: 0.1 })` so
      `renderTime` slews within `±2%` of `dt`.
- [ ] **Velocity interpolation (`hermite2`), coasting (`over`), and `Glide`:** Remotes interpolate along velocity
      tangents, coast up to `250 ms` during TCP stalls (`bracket.over`), and decay post-stall jumps with `Glide`.
- [ ] **Server lag compensation (`RewindHistory`) or rollback (`RollbackClient`):** Hitscan/casts rewind targets to the
      shooter's `renderTime` (capped at `250–350 ms`), or the game runs full deterministic rollback (`Archers`).
- [ ] **WebSocket jitter buffer (`socketJitter`) + tick pacing:** Server uses `socketJitter(tickHz)` with `InputOps`
      edge carry-over (`merge`, `standIn`, `hasEdges`), pushes for `this.tick + 1` when `step()` increments `tick`
      first, and paces client ticks within `±2%` from buffer slack.
- [ ] **Wire packing, private seat tokens, `BUILD` handshake, and rate limits:** Snapshots pack entities into positional
      arrays (`shared/wire.ts`) or binary deltas; reconnect tokens persist in `sessionStorage`; `hello` checks `BUILD`
      and never trusts client-chosen IDs; incoming socket messages are rate-limited.

---

## 10. Measuring with `scripts/bench-netcode.ts`

Run the headless cross-game benchmark over `@arcade/kit/net/link-sim`:

```bash
bun scripts/bench-netcode.ts                  # 60 s × 3 seeds across all games and link profiles
bun scripts/bench-netcode.ts --seconds=20     # quick 20 s check while iterating
```

`link-sim` models both directions of a TCP WebSocket (base one-way delay, Gaussian jitter, in-order `200 ms` packet-loss
retransmit holds, and periodic Wi-Fi radio stalls) across three standard profiles:

- **`good` (`30 ms` RTT):** `15 ± 2 ms` one-way, `0%` loss, no stalls.
- **`wifi` (`80 ms` RTT):** `40 ± 7.5 ms` one-way, `0.5%` loss per leg (`200 ms` TCP retransmit hold), and a `150 ms`
  Wi-Fi stall every ~10 s.
- **`bad` (`150 ms` RTT):** `75 ± 15 ms` one-way, `1%` loss per leg (`250 ms` TCP retransmit hold), and a `220 ms`
  stall every ~7 s.

The benchmark prints two tables:

1. **Transport & movement table:**
   - `lost`: One-shot presses dropped by the room (`must be 0/N` on all profiles).
   - `feedbackMs`: Press-to-local-feedback latency (`must be 0 ms`).
   - `serverP50` / `serverP95`: Milliseconds from client press to the server tick that applies it (`~67–83 ms` p50 on
     `wifi`).
   - `confirmP50` / `confirmP95`: Milliseconds from press until the confirming snapshot arrives back at the client.
   - `remoteP50` / `remoteP95`: Milliseconds from client A's press until client B's rendered view shows the action.
   - `starvedPct` / `longestStarveMs`: Percentage of 60 fps frames where a remote entity had no bracket and no coasting
     (`over > maxCoast`), and the longest freeze duration.
   - `shooterLagP50` / `missCmAt5ms`: Uncompensated age of the shooter's view at server hit resolution, and the
     resulting aim error against a `5 m/s` target (`0 ms` / `0 cm` on `good` and `wifi` when `RewindHistory` is wired).
   - `correctionsPerMin` / `correctionP95Cm`: Prediction reconciliation corrections (`> 1 cm`) per minute and their 95th
     percentile size before `Smoother`.
   - `snapHz`, `downKBs`, `tickMeanMs`, `tickP99Ms`: Snapshot rate, downstream bandwidth per client, and room CPU cost.
2. **Optimistic action & hitmarker audit table:**
   - `pressToFeedbackMs`: Local cosmetic feedback delay (`0 ms`).
   - `actionsPredicted`, `actionsConfirmed`, `actionsRejected`, `actionMispredictPct`: Every action registered with
     `OptimisticEvents` and how often the server confirmed vs rolled it back.
   - `hitsPredicted`, `hitTP`, `hitTN`, `hitFP`, `hitFN`, `hitFalsePositivePct`, `hitDisagreePct`: Agreement between the
     client's press-frame tentative hitmarker raycast and the server's lag-compensated hit outcome.
