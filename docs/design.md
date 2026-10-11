# Getaway: design

A PvP browser driving game. One player is the getaway driver; everyone else in the room is a cop. The
driver tries to stay free for as long as possible. Low-poly 3D night city rendered with WebGPU, seen from
a fixed high three-quarter camera that never rotates (see `concept/dir-d-lowpoly-1.png` and `-2.png`).

## Scope

- Driving only. No loot, extraction, unlocks or XP. The one gadget is the cops' spike strip; the driver's answer to it
  is a repair shop.
- PvP only. There are no bots on the server. Bots still exist in `shared/sim/bots.ts` for tests, the
  balance runner and the dev staging scenes.
- HUD: a survival clock, the room best, a bust ring, one line of intro text, a short end card and a room
  invite pill. Cops get the spike strip hint; a driver with flats gets a tiny tire glyph and, in a bay, the repair bar.

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
  (5 s without eyes), `tip` and `flat` (`count|tire`, e.g. `2|RL`; at 4/4 the call is that the suspect is limping).
  `src/audio/radio.ts` turns them into police radio voice lines
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

## Spike strips and flat tires

- Cops drop a strip behind them with Q or E (10 s cooldown). Strips stay for the round; each cop keeps at most 3 down
  and laying a fourth picks up their oldest.
- Each pass over a strip pops one tire: the first intact tire to go over it, from the tire positions (32% of the car's
  length from the middle, 40% of its width out) against the strip, in crossing order (an axle square to the strip goes
  left before right). Only tires whose track crosses the strip's length count. A strip bites again only once the car is
  clear of it. A hit marks the strip as the driver's last known position and raises a `flat` event.
- Flats stay until repaired (`Body.wheels`, a mask: 1 FL, 2 FR, 4 RL, 8 RR). By number of flats:

  | Flats | Top speed | Grip | Accel |
  | ----- | --------- | ---- | ----- |
  | 1     | ×0.8      | ×0.85 | ×0.9  |
  | 2     | ×0.6      | ×0.7  | ×0.75 |
  | 3     | ×0.38     | ×0.5  | ×0.55 |
  | 4     | ×0.2      | ×0.35 | ×0.35 |

  Four flats is driving on the rims, about 6-9 m/s depending on the car, with sparks: slow enough to box in, but the
  driver can still limp to a shop. Each flat front keeps ×0.8 steering, each flat rear ×0.88 grip on top. A one-sided
  flat pulls the car toward it (0.1 rad/s per tire of left-right imbalance, at speed), and flats wobble the car with
  distance travelled (rear flats more). No stun.
- Drawn: the body sags at popped corners and shimmies a little.

## Repair shops

- Four mechanic shops (`city.shops`), one per quarter of the district and at least 110 m from the precinct, placed from
  their own seeded stream by taking over a street-front building whose face looks -z or -x (so the bay faces the
  camera). Each keeps the building's footprint: a 7 m wide, 9 m deep open bay in the middle of the street face, solid
  side walls and the workshop behind. The sidewalk in front is cleared for a straight pull-in.
- The driver stopped (under 2 m/s) in a bay with any flats gets every tire fixed after 2.5 s. Leaving the bay resets the
  progress; rolling around inside drains it. A shop that did a repair can't do another for 45 s. Cops never repair.
- Everyone has the shops on the minimap (a wrench), so staking one out is a cop strategy. The driver with flats sees
  working shops lit, an edge arrow to the nearest and a teal pulse on the bay floors; busy ones dim.
- `repair` event when done: to everyone with the shop id when the driver is seen, otherwise only to the driver with no
  text (`SimEvent.to`). Repair progress and shop cooldowns are only in the driver's view.
- Look: cinder block with a yellow stripe, the bay open to the sky under a lintel with AUTO REPAIR and the rolled-up
  door's housing, a canopy over the back, a warm light bar over the tool wall and a red tool chest on the inner wall
  that faces the camera, tyre stacks and an oil drum, a painted bay outline, a dropped apron, and a vertical GARAGE
  neon with a wrench. Impact wrench sound (`public/sfx/repair.mp3`) on the repair.

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
