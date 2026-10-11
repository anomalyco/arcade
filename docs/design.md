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

- **Robber wins** by holding inside the extraction zone (radius 14 m, under 16 m/s) for 3 s. They bank
  the loot value of the job (bank $412K, jewelers $236K, gallery $980K).
- **Cops win** by busting (see below) or when the timer runs out.
- **Robber rotation:** humans take turns. A lone human alternates with a bot robber so both roles get
  played when testing solo. Everyone else is a cop; bots fill the cop side up to 3 units.
- **Heat** rises with time and near misses. Stars = 1 + heat / 25. Each star above 2 calls a backup unit
  (interceptor or SWAT van), up to three.

## Bust

The robber is *boxed* when moving under 7 m/s with a cop inside 9 m. Bust progress fills in 4 s with
two cops, faster with more, and at 45% speed with a single cop (pinning against a wall works). It drains
when the robber breaks free. Cops that contributed share 1000 + loot/1000 points.

## Fog of war

Cops see the robber only within 70 m of any cop. Otherwise the cop view gets a **last-seen** ping. Cop
bots chase the ping, and half of them stake out the extraction point. The server never sends the live
robber position to cop clients while unseen.

## Driving

Arcade bicycle model in `shared/sim/vehicle.ts`: world-space velocity split into forward and sideways
parts each tick, sideways velocity damped by grip. Handbrake drops grip to ~28% and boosts yaw for drifts.
Nitro (Shift) gives +30% top speed and +60% acceleration and drains over 4 s, refilling slowly. Car-to-car
contact is impulse-based with mass; heavy hits stun the lighter car briefly. Buildings push cars out with
a bounce.

Scoring for the robber: drift points (sideways speed × speed), near misses (+500 for passing a cop at
speed within ~6.7 m without contact), and the loot on escape.

## Vehicles

Robber: Muscle, Compact, Van (unlocks at level 2), Motorbike (level 4). Cop: Cruiser, Interceptor
(level 2), SWAT Van (level 4). XP profile in `localStorage`.

## Gadgets (planned)

Robber: oil slick, smoke screen, EMP, decoy. Cop: spike strip, roadblock, helicopter spotlight (the
helicopter reveals the robber inside its beam), police scanner (brief ping of the robber's position).

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
