# Getaway: design

A PvP browser driving game. One player is the getaway driver; everyone else in the room is a cop. The
driver tries to stay free for as long as possible. Low-poly 3D night city rendered with WebGPU, seen from
a fixed high three-quarter camera that never rotates (see `concept/dir-d-lowpoly-1.png` and `-2.png`).

## Scope

- Driving only. No loot, extraction, gadgets, garage, unlocks or XP.
- PvP only. There are no bots on the server. Bots still exist in `shared/sim/bots.ts` for tests, the
  balance runner and the dev staging scenes.
- HUD: a survival clock, the room best, a bust ring, one line of intro text, a short end card and a room
  invite pill. Nothing else.

## Round

| Phase       | Length   | What happens                                                         |
| ----------- | -------- | -------------------------------------------------------------------- |
| `waiting`   | open     | Fewer than 2 players. Everyone free-drives. Share the invite link.   |
| `intro`     | 4 s      | Roles shown. Everyone frozen.                                        |
| `headstart` | 5 s      | The driver goes; cops wait at the precinct.                          |
| `chase`     | open     | Cops dispatched. The survival clock runs until the driver is busted. |
| `end`       | 9 s      | Survival time, room best, standings. Next round.                     |

- Players take turns as the driver, in join order.
- **Bust:** the driver is boxed when moving under 7 m/s with a cop within 9 m. Bust progress fills in 4 s
  with two cops, faster with more, and at 45% speed with one cop (pin them against a wall). It drains when
  the driver breaks free.
- **Pressure:** cops see the driver in line of sight, and dispatch radios the driver's position to every
  unit every 4 s. The helicopter launches 20 s into the chase and sweeps its spotlight over the driver.
- **Score:** survival time. Each player's best and the room best are kept for the life of the room.

## Driving

Arcade bicycle model in `shared/sim/vehicle.ts` (`stepAndCollide`, substepped so fast cars can't pass
through thin boxes). Handbrake (Space) drops grip for drifts that hold with throttle and counter-steer.
Nitro (Shift) gives +30% top speed and empties in 3.5 s. Ramming is mass-based, and heavy hits stun the
lighter car.

## Netcode

- The Worker routes `/labs/getaway/ws/<ROOM>` to a `Room` Durable Object, one per room code.
- The DO runs `World` from `shared/` at 30 Hz and sends per-viewer snapshots at 15 Hz.
- The client predicts its own car with the shared physics and reconciles against acked inputs. Other cars
  are interpolated about 100 ms behind.
- Players who join mid-round watch until the next round. A dropped player keeps their seat for 15 s.

## WebGPU render pipeline

1. Shadow pass from the moon (depth only).
2. HDR scene pass with 4× MSAA: flat-shaded low-poly geometry, a decal atlas painted at runtime
   (POLICE lettering, signs, billboards), up to 96 dynamic lights (headlights, sirens, street lamps), the
   helicopter spotlight, a damp-asphalt sheen, and a dithered cutaway of buildings between the camera and
   the player's car.
3. Instanced cars, lit low-poly smoke puffs, additive volumetric light cones (spotlight, headlights) and
   particle sprites.
4. Occluded cars drawn as team-colored silhouettes (stencil plus depth `greater`).
5. Bloom chain, then ACES tone mapping, color grade and vignette.
