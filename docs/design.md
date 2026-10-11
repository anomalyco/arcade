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
- **Radio:** the sim emits `spotted` (eyes back on the driver after 4 s unseen or 60 m from the last sighting, at
  most every 6 s; text `ground|north` or `heli|east`, heading in map terms with north = camera forward), `lost`
  (5 s without eyes), `tip` and `flat`. `src/audio/radio.ts` turns them into police radio voice lines
  (`public/sfx/radio/`): clean on the cops' radio, a quiet muffled scanner for the driver, who also gets an alert sting
  when spotted. One line at a time, one queued.
- **Score:** survival time. Each player's best and the room best are kept for the life of the room.

## Driving

Arcade bicycle model in `shared/sim/vehicle.ts` (`stepAndCollide`, substepped so fast cars can't pass
through thin boxes). Handbrake (Space) drops grip for drifts that hold with throttle and counter-steer.
Nitro (Shift) gives +30% top speed and empties in 3.5 s.

Collisions (`shared/sim/collide.ts`): every car is an oriented box (96% of its drawn length and width), tested with
separating axes against the axis-aligned city boxes and against other cars, with a one- or two-point contact manifold.
Contacts resolve with rigid-body impulses: mass from the vehicle spec, spin through the yaw rate, friction at the
contact and a 0.25 bounce (none below 1.5 m/s, so a car pressed against a wall rests still). Walls: glancing hits slide
along, head-on hits stop with a small bounce. Car hits are resolved at the moment of first touch (no sinking in), and an
off-center hit spins the struck car: a hard knock leaves it loose for up to 1.2 s (low grip and steering, the spin
carries on), which is the PIT. A change in velocity over 9 m/s stuns. Hits of 6 m/s or more raise an `impact` event
(`speed|x|z|nx|nz`, normal into the car); an unseen driver's carry only the speed.

## Going dark

- H (gamepad Start) toggles the engine. With it off the car has no throttle, reverse or nitro; it coasts,
  brakes and steers as it rolls. Restarting cranks for 0.8 s before the throttle answers. Headlights go out
  and the taillights dim.
- The driver is **dark** while the engine is off and they move slower than 1.5 m/s. A dark driver on a
  cop's screen does not count as seen: no live minimap dot for anyone, and the last-seen ping isn't
  refreshed. The helicopter's spotlight doesn't find a dark car either; it keeps searching.
- A cop who has the dark car on their own screen still sees it in the world, just not on radar. The
  server only sends a cop the driver's live position when the driver is seen or on that cop's screen.
- Busting works as usual: a dark car with cops pressed against it is boxed and busted.

## Netcode

- The Worker routes `/labs/getaway/ws/<ROOM>` to a `Room` Durable Object, one per room code.
- The DO runs `World` from `shared/` at 30 Hz and sends per-viewer snapshots at 15 Hz.
- The client predicts its own car with the shared physics and reconciles against acked inputs. Other cars
  are interpolated about 100 ms behind. For prediction, the other cars in the latest snapshot are extrapolated tick by
  tick in step with your car and collide with it (taking the push), so hits land at once instead of a round trip later.
  Cars near yours are drawn at that predicted pose, so they touch on screen when they touch; farther away they blend
  back to the interpolated one. Corrections ease out (faster the bigger they are) and only jumps over 6 m snap.
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
