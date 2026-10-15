# Outbreak

Unlisted local-session prototype at `/arcade/outbreak/?solo`. Physical WASD (`KeyW`, `KeyA`, `KeyS`, `KeyD`) or arrows move,
`Shift` sprints with stamina and exhaustion recovery, the mouse aims, `F` (`KeyF`) toggles the shadow-casting noir
flashlight (with battery drain, recharge delay, low-battery flicker/dimming, and empty cutout), `1`–`5` (`Digit1`–`Digit5`)
and the mouse wheel select hotbar slots, `E` (`KeyE`) triggers the primary contextual action (peek closed window with a
localised cutaway bubble, climb through open window, vault fence, open/close door), `Hold E` (`0.38 s`) triggers the
secondary action shown simultaneously in the floating object prompt (open/close window sash, lock/unlock door), and
`Space` vaults fences or climbs through open windows. On-screen prompts adapt to the user's keyboard layout
(`navigator.keyboard.getLayoutMap()`). Backquote opens the shared Lab.

Action feedback appears under the survivor (`src/hud/`): reload, search and barricade show a progress ring, loot
pops float out, and warnings, damage and loud noises get their own colours. Stamina, reload, health and battery are
small rings beside the survivor that appear only while they matter. Both move to the other side when you aim into
them, and co-op teammates get the same at a smaller size. The hotbar sits at the bottom centre and a one-line time
and ammo summary sits top left. The Lab's HUD group picks one of five HUD styles (Today,
Below Feet, Hades Style, Zomboid Style, Diegetic), can override callout and ring placement, and can switch back to
the old bottom-left status log.
Research, defaults and measurements: [docs/outbreak-hud.md](../../docs/outbreak-hud.md).

The [2026-10-13 look study](../../docs/outbreak-look.md) records screenshot paintovers, procedural houses/terrain,
shared-material work, actual comparison captures, seven paired cost runs and remaining visual gaps.

The [zombie profile adapter](../../docs/outbreak-zombie-profile.md) prepares lurch/asymmetry/drag/reach tuning for
the shared human rig in flight, with shared-Lab descriptors and the server/client limb-state boundary.

## Co-op

**Host co-op** (top left) creates a room, copies its invite link and joins it; up to three friends open the link
(`/arcade/outbreak/?room=<code>`) and drop into the same neighbourhood. Everyone shares doors, windows, barricades,
searched containers, zombies and the clock; inventory, ammo, planks, stamina and battery are each survivor's own.
Each player sees only what their own survivor can see; other survivors' flashlights light everyone's world. Without
`?room` the game is the offline single-player session. Design, protocol and measurements: [docs/outbreak-coop.md](../../docs/outbreak-coop.md).

```sh
bun run dev:server                 # build + wrangler dev on :8797 (rooms included)
bun scripts/coop-smoke.ts          # two protocol clients: join, door, shot, agreement, bandwidth
bun scripts/coop-browser.ts        # two headless Metal pages with real keyboard/mouse input
bun scripts/coop-bench.ts          # room CPU per tick and bytes per client, 4 survivors + 60 zombies
```

## Milestone 1

The 96 × 96 m neighbourhood has nine 32 m chunks, two houses with separate rooms, a hardware store, a pharmacy,
fences, trees and streetlamps. The seed selects house colours, trees and shelf stock; street topology is fixed.
Walls and closed doors block sight. Windows and fences block walking but pass sight. Vision combines a 110° cone
with 2.5 m close awareness, both occluded by walls. Static room scenery is remembered separately and stays readable
after looking away; actor visibility must still use strict eye LOS.

The clock starts at 18:00 and advances at 120 simulated seconds per second, through night and the next day.
The Lab controls time, time scale, overcast, practical lights, house seed, terrain relief, sight range/cone/awareness,
shroud, exposure and camera distance.
`?seed=7&bench` is a deterministic automation entry point. `window.__arcadeHarness` supplies pose, fixed steps,
reset, state, fog queries and validated Lab setters. The normal game pauses stepping when hidden.

## Verification

From the repository root:

```sh
bun install --frozen-lockfile
sh games/outbreak/scripts/check-workspace.sh
hivemind run --fetch captures/outbreak-m1 -- bun games/outbreak/scripts/prove.ts
python3 games/outbreak/scripts/sheet.py
(cd games/outbreak && bun scripts/hud-proof.ts)   # HUD stills and per-frame cost in captures/outbreak-hud
python3 games/outbreak/scripts/hud-sheet.py       # placement, stamina and style sheets from those stills
(cd games/outbreak && bun scripts/hud-moment.ts)  # frames + timeline for the board's HUD prototype
```

The Metal proof uses the built production bundle and six real screenshots. It checks blocked/revealed/explored
room states, the actual time slider, Lab input isolation, F interaction and WASD/Dvorak movement, with no browser
or WebGPU errors. The sheet is 1160 × 1260. Unit tests cover seeded generation, walls/windows/fences, door reach
and collision, exploration persistence, awareness occlusion and clock/daylight math.

## Follow-ups

M2 adds zombies and noise. M3 adds survival inventory and barricades. Co-op rooms (2–4 survivors) are live; persistence
is not: a room resets once everyone has been gone for a minute. M5 adds audio, fire and vehicles.
Furniture and trees are visual props in M1. Sun/moon direction shades surfaces, but does not cast a directional
shadow map. Practical lights use polar shadows. The look study reports measured queue-completed frame spans;
pure GPU time and higher-DPR devices remain unmeasured.

`docs/shared-code.md` records the shared renderer, input, camera, rig and geometry extractions and the remaining
animation/material seams. Promotion requires a landing panel and removing `noindex`; the prototype has neither a
landing link nor a sitemap entry.
