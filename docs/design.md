# Getaway: design

A browser driving game. One player is the getaway driver; everyone else in the room is a cop. Low-poly 3D,
rendered with WebGPU, seen from a high three-quarter camera at night (see `concept/dir-d-lowpoly-1.png`
and `-2.png`).

## Scope

Driving only. Nobody leaves their car. The heist has already happened when the round starts: the robber
is at the curb outside the job with the take and the alarm going off.

## Round

| Phase       | Length | What happens                                                              |
| ----------- | ------ | ------------------------------------------------------------------------- |
| `intro`     | 4 s    | Camera on the job site, exit revealed to the robber. Everyone frozen.      |
| `headstart` | 5 s    | Robber drives. Cops wait at the precinct.                                 |
| `chase`     | 180 s  | Cops dispatched with the robber's position as the first last-seen ping.   |
| `end`       | 9 s    | Result, awards, standings. Then the next round starts.                    |

- **The ride arrives 40 s into the chase** (`EXTRACT_OPEN_SECONDS`). Until then the extraction point is
  closed and the robber has to stay loose; `WorldView.exitOpenIn` counts down and an `exit` event fires when
  it opens.
- **Robber wins** by holding inside the extraction zone (radius 14 m, under 12 m/s) for 3 s of progress.
  Progress runs at 70% while boxed by cops and 60% under the helicopter's spotlight (both stack), and
  drains at 1/s outside the zone. They bank the loot value of the job (bank $412K, jewelers $236K,
  gallery $980K).
- **Cops win** by busting (see below) or when the timer runs out.
- **Robber rotation:** humans take turns. A lone human alternates with a bot robber so both roles get
  played when testing solo. Everyone else is a cop; bots fill the cop side up to 3 units.
- **Heat** rises 0.35/s, 0.8/s while the robber is seen, plus 1.2/s more inside the spotlight, +3 per near
  miss, +2 per robber gadget or spike hit, +1 per hard robber-cop collision. Stars = 1 + heat / 25 (max 5).
  Each star above 2 calls a backup unit (interceptor or SWAT van) from the precinct, up to three.

## Bust

The robber is *boxed* when moving under 7 m/s with a cop inside 9 m. Bust progress fills in 4 s with
two cops, faster with more, and at 45% speed with a single cop (pinning against a wall works). It drains
at 0.4/s when the robber breaks free. Cops that contributed share 1000 + loot/1000 points.

## Fog of war

A cop sees the robber when within 70 m **and** the line between them is not blocked by a building (alleys
and parked cars do not block) or a smoke cloud. Within 20 m (hearing range) buildings do not matter, but
smoke still does; a robber inside a smoke cloud is invisible to everyone, the helicopter included. The
helicopter's spotlight (radius 12 m) also counts as seeing. Otherwise the cop view gets a **last-seen**
ping: the robber car appears as a `ghost` at the last-seen position and heading with zero speed and no
gadget or body state. The server never sends the live robber position to cop clients while unseen.

**Helicopter:** launches 20 s into the chase from the precinct roof, flies at 26 m/s. While the robber is
seen it follows them with the beam; once the trail goes cold it flies an expanding spiral (up to 170 m)
around the last sighting and sweeps the beam around itself.

**Cop bots:** chase the robber directly when it is visible within 55 m; otherwise follow the last-seen
ping for 10 s, then fan out along the same search spiral. Every other unit stakes out the extraction
point, and all unseeing units converge there 15 s before the ride arrives. **Robber bot:** lies low at a
road node far from every cop until it can just make the exit as it opens, then drives for it.

## Driving

Arcade bicycle model in `shared/sim/vehicle.ts`: world-space velocity split into forward and sideways
parts each tick, sideways velocity damped by grip. Tunables live in `DRIVE`.

- **Acceleration:** `accel × (1 − (v/vmax)²)` with light drag on throttle, so every car reaches 90% of
  `maxSpeed` in 3.3–4.8 s and tops out at ~97%. Coasting slows the car to a stop.
- **Handbrake (Space)** puts the car in a drift (`Body.drift` = 1): grip drops to 20% and steering yaw is
  ×1.5. A handbrake turn at 30 m/s slides at ~20 m/s sideways and turns 90° in ~0.6 s.
- **Holding a drift:** after the handbrake, throttle keeps the drift alive (it fades at 0.25/s instead of
  3.5/s) with grip at 30%. Power oversteer pushes the tail further on throttle, so a light counter-steer
  holds the angle (~25–35° for 2 s at the muscle car's pace) and scrubbed sideways speed is partly turned
  into forward speed. Counter-steer harder or lift to straighten out.
- **Grip assist:** past ~57° of slide the tyres bite back progressively, so overcooked drifts straighten
  out instead of spinning (slip stays under ~70°).
- **Nitro (Shift):** +30% top speed, +60% acceleration, drains in 3.5 s, refills over 12 s.
- **Reverse:** throttle −1 brakes while rolling forward, then reverses up to 14 m/s; steering inverts.
- **Collisions:** buildings push cars out, bounce the normal velocity back at 30% and keep 55–100% of the
  tangential speed (glancing scrapes keep the most). `stepAndCollide` substeps so a car never moves more
  than 60% of its radius per substep: no tunneling through roadblocks or parked cars even on nitro.
  Car-to-car contact is impulse-based with mass (restitution 0.25); any car whose velocity changes by more
  than 9 m/s is stunned for up to 1.1 s, which in practice is the lighter car (a SWAT van ramming a
  compact stuns only the compact).

Scoring for the robber: drift points (sideways speed × speed), near misses (+500 for passing a cop at
speed within ~6.7 m without contact, once per 1.6 s), and the loot on escape.

## Vehicles

Robber: Muscle, Compact, Van (unlocks at level 2), Motorbike (level 4). Cop: Cruiser, Interceptor
(level 2), SWAT Van (level 4). XP profile in `localStorage`.

## Gadgets

Driving only: Q fires slot 0, E fires slot 1 (`Input.gadget`, edge-triggered: the world fires once per
press, and a value repeated across inputs is ignored until it returns to null). Charges are per round,
with a cooldown after each use. Robber gadgets work from the head start on; cop gadgets once the chase is
on. Specs live in `GADGETS` in `shared/config.ts`.

| Slot | Gadget       | Who    | Charges | Cooldown | Lasts | Effect                                                                 |
| ---- | ------------ | ------ | ------- | -------- | ----- | ---------------------------------------------------------------------- |
| Q    | Oil slick    | Robber | 3       | 8 s      | 12 s  | 6 m patch behind the car. Cops driving through lose almost all grip and steering for 1.2 s and spin out (once per car per slick). |
| E    | Smoke screen | Robber | 2       | 14 s     | 6 s   | 18 m cloud behind the car. Blocks line of sight through it; a robber inside is unseen, even by the helicopter. |
| Q    | Spike strip  | Cop    | 2       | 12 s     | 20 s  | 12 m strip across the road 10 m ahead. The robber driving over it gets a flat for 6 s: top speed ×0.68, grip ×0.55. The strip is used up. |
| E    | Roadblock    | Cop    | 1       | 20 s     | 25 s  | 13 m × 1.6 m solid barrier across the road 8 m ahead. Everyone bumps into it; bots route around it. A car can squeeze past the ends. |

Strips and barriers snap to the road axis and centre on the road line. Visibility (`WorldView.props`):
spike strips are hidden from the robber beyond 40 m (they glint in the headlights up close); robber props
dropped out of sight stay hidden from cops until a cop comes within 70 m of them. Everything else is
visible to everyone. Events: `gadget` ("Reyes deployed SPIKE STRIP"), `spinout`, `flat`.

Bots: the robber drops oil when a cop is close behind and smoke when seen with cops near, bust progress
building or the spotlight on it. Cops drop spikes when the visible robber is driving straight at them
20–65 m out, and roadblocks on the approach to the exit shortly before the ride arrives.

Later: EMP, decoy, police scanner.

## Balance

`bun scripts/sim-smoke.ts [seeds] [rounds] [-v] [--no-heli]` runs bots-only rounds (1 robber, 4 cops).
Over 720 rounds: 43% escapes, chases average 70 s (79 s rounds), max stars average 3.3 with 1.4 backup
units, ~7.6 gadgets per round. Grounding the helicopter raises escapes to ~66%.

## Netcode

- Cloudflare Worker routes `/labs/getaway/ws/<room>` to a `Room` Durable Object (one per room code).
- The DO runs the same `World` from `shared/` at 30 Hz and sends per-viewer snapshots at 15 Hz (cops get
  the fog-filtered view).
- Clients send inputs with a sequence number. The client predicts its own car with the shared
  `stepBody` and reconciles against the server's acked state. Other cars are interpolated ~100 ms behind.
- People who join mid-round spectate until the next round.

## WebGPU render pipeline

1. **Shadow pass**: directional moon light, depth-only, static city plus cars.
2. **Scene pass** (4× MSAA, HDR `rgba16float`): flat-shaded low-poly geometry with per-face normals.
   Static city in one vertex buffer, cars and props instanced. Lighting = moon + ambient + up to 64
   point/spot lights (headlights, sirens, street lamps) from a storage buffer, plus the helicopter
   spotlight cone. Buildings between the camera and the player's car fade with a dither.
3. **Occluded vehicle pass**: cars drawn again with `depthCompare: "greater"` as a team-colored
   silhouette so they read behind buildings.
4. **Particles**: drift smoke, sparks and siren glow, as additive and alpha-blended billboards.
5. **Bloom**: bright-pass, downsampled blur chain, composite with tone mapping and vignette.
