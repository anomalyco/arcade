# Outbreak

Unlisted local-session prototype at `/arcade/outbreak/?solo`. Physical WASD (`KeyW`, `KeyA`, `KeyS`, `KeyD`) or arrows move,
`Shift` sprints with stamina and exhaustion recovery, the mouse aims, `E` (`KeyE`, with `KeyF` alias) interacts with
doors, windows (peek interior with a localised cutaway bubble, open/close, climb through), and fences (vault), `Space`
vaults over fences or climbs through open windows, and `Q` cycles contextual actions.
On-screen prompts adapt to the user's keyboard layout (`navigator.keyboard.getLayoutMap()`). Backquote opens the shared Lab.

The [2026-10-13 look study](../../docs/outbreak-look.md) records screenshot paintovers, procedural houses/terrain,
shared-material work, actual comparison captures, seven paired cost runs and remaining visual gaps.

The [zombie profile adapter](../../docs/outbreak-zombie-profile.md) prepares lurch/asymmetry/drag/reach tuning for
the shared human rig in flight, with shared-Lab descriptors and the server/client limb-state boundary.

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
```

The Metal proof uses the built production bundle and six real screenshots. It checks blocked/revealed/explored
room states, the actual time slider, Lab input isolation, F interaction and WASD/Dvorak movement, with no browser
or WebGPU errors. The sheet is 1160 × 1260. Unit tests cover seeded generation, walls/windows/fences, door reach
and collision, exploration persistence, awareness occlusion and clock/daylight math.

## Follow-ups

M2 adds zombies and noise. M3 adds survival inventory and barricades. M4 replaces the local Session implementation
with co-op snapshots and persistence; M5 adds audio, fire and vehicles. There is no networking or save storage yet.
Furniture and trees are visual props in M1. Sun/moon direction shades surfaces, but does not cast a directional
shadow map. Practical lights use polar shadows. The look study reports measured queue-completed frame spans;
pure GPU time and higher-DPR devices remain unmeasured.

`docs/shared-code.md` records the shared renderer, input, camera, rig and geometry extractions and the remaining
animation/material seams. Promotion requires a landing panel and removing `noindex`; the prototype has neither a
landing link nor a sitemap entry.
