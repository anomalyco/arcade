# Integration TODO (orchestrator)

## Stormfront audio hookup (client, after WebGPU migration)
- game.ts: forward `aa` events to `audio.event(e, e.position, false)`.
- On world lightning: `audio.thunder(distance / 343, intensity)`.
- `audio.setStorm({ cockpit })` when in cockpit view; `setStorm({ rain })` from world rain intensity.
- Optional: explosion `kind?: "flak"` field for flak bursts.

## After carrier strike groups land
- Only active teams' fleets should exist: use `activeFleet(config.teams)` (fleet.ts) in combat AA, room engine, bots no-fly, world rendering (client knows config from welcome).
- Bots: switch takeoff logic from runway/corridor to carrier catapult launch; avoid enemy fleet AA range (2.2 km) unless suicidal; heli from deck spots. (Bots session ses_ed34d3943ffefrRH4OjhzZL1Aw)
- Bots: `botInput` reuses returned objects — server must copy if retained.
- Client: render AA tracers/flak from combat `aa` events and aim ship turrets via world `getShipTurret`; call `view.setSpotted(on)` for spotted enemies; practice "bots" setting → createLocalRoom config.
- Types: apply combat's proposed `aa` GameEvent, "aa" WeaponId, VehicleEntity.spawnedAt.

## Pending for UI agent after current rebuild (user feedback)
- Remove PULL UP warning entirely (HUD + sound).
- Remove the giant circles around the crosshair (seeker/lock-cone ring, any large reticle rings). Keep only the small crosshair; lock indication = small box on the target.
- Controls help: "Roll: Q E", "Rudder / Strafe (heli): A D" (controls agent swapping Q/E ↔ A/D).

- Double FOV boost: camera.ts (+6° above cruise) AND scene.ts (+6° while boosting) — keep one (prefer camera.ts).
- Client must call `view.setLocal(true)` on the local player's own AircraftView (prevents distance up-scaling).
- Next style pass: "GOLDEN ELDRITCH" (see STYLE.md top) for world, aircraft, effects, UI once current fixes land.

## Controls help text (unified Battlefield scheme) — apply in spawn.ts/index.html/pause.ts
- Same for all aircraft: "Pitch: Mouse Y (forward = nose down) · ↑ down ↓ up", "Roll: Mouse X · ←→", "Yaw: A D · Q E", "Throttle/Collective: W S", "Boost / brake·auto-hover: Shift X". Drop separate Apache table. Pause checkbox: "Invert mouse Y (mouse forward = nose up)".
- Heli trade-off: self-level means sustained forward flight needs repeated forward nudges. Revisit after playtest (option: hold-tilt when |pitch| > ~8°).

## Audio hookup
- Call `audio.setLocalPlayer(playerId)` after welcome. `event(e, pos, local)`: fire → own vehicle fired; hit → own vehicle was hit; kill → you were the killer. Own death detected via victim == own vehicle id.
- Call `setListener` + `updateVehicles` every frame; `ui("lock-tone"|"locked"|"warning")` every frame while condition holds.
- `explosion.size`: 1 = aircraft destroyed; >5 = splash radius meters.

## Controls (user decision — Daxship-style), apply to src/input.ts after Client agent finishes
- Mouse = direct steering (rate commands), `aim: null`. Mouse Y: up = nose up (Daxship default) + "Invert mouse Y" setting.
- Arrows: Up = nose DOWN, Down = nose UP (inverted), Left/Right = yaw.
- W/S throttle (persistent) / heli collective; wheel = fine throttle. Q/E roll. A/D = rudder (jets) / strafe (heli).
- Shift boost, X brake/hover-hold.
- **Shooting:** Left mouse (hold) = primary guns, Right mouse = secondary/missiles, Space = primary (keyboard/trackpad backup), V = secondary (backup). F flares, R ability, 1/2 seats, **hold C = free-look**, T = chase/cockpit, Enter = chat, Tab scoreboard, Esc menu. (Superseded mapping below: unified Battlefield scheme.)
- Gunner seat: mouse aims turret (aim vector), same fire buttons.
- Flight mapping (direct mode, aim=null): pitch +1 = nose up (Arrow Up sends −1), yaw +1 = turn right (jets: coordinated auto-bank turn), roll = Q/E (jets) and A/D strafe (heli → `roll`, not `yaw`). Jets: A/D → yaw (rudder).

- Duplicate weapon slots (e.g. `tvmissile`/`tvmissile`): combat uses slot 0 ammo for both triggers; aircraft view sums both slots → stores never fully hide. Fix: aircraft view should use slot 0 only when both slots are the same weapon (or collapse duplicates into one slot in `vehicles.ts`).
- Remote afterburner/boost: aircraft guesses boost from `throttle > 0.95`. Consider `FlightState.boosting?` set by flight from input.
- Bots: removed by user decision; `src/sim/bots.ts` unused. Client/server must not expose bot options.
- Room engine must pass `world` to `flightReadout` for HUD agl (client side).
- Cross-engine float drift: reconciliation must tolerate tiny differences.
- AircraftView extras for client: `setFiring(seat, slot, on)`, `setBoost(on)`, `anchors`, `ready`.
- Lighting tuned for hemisphere ~1.3 + sun ~2.6, ACES tone mapping, sRGB output.
- **Client must send exactly one `input` per 60 Hz tick** (server consumes one queued input per tick; client agent was told 30 Hz). Fix in integration.
- `tests/bots.test.ts` has a failing test; bots are unused — delete or skip.
- Wire types live in `room-engine.ts` (`createSnapshotDecoder`); consider moving to `protocol.ts`.
- Aircraft agent killed `vite --host` processes when finishing; restart dev server if needed.
