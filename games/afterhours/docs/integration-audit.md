# Integration audit (2026-10-17)

Frozen production build of HEAD `011b6dca` plus the uncommitted working tree at audit time (doors.ts, lighting.ts,
mirrors.ts, dock.ts, shell.ts, services.ts, s0/west.ts, washroom.ts; diff saved as `$TMPDIR/ah-audit/snapshot.diff`),
built with `bunx vite build -c scripts/audit/vite.config.ts` and served on :5231. Headless Chromium on Metal, muted.
Evidence paths below are relative to `$TMPDIR/ah-audit/out/` (`$TMPDIR/ah-audit/out/`).

## Summary

- **"Fell through most floors" no longer reproduces.** Storeys 0–4, the core hall and lift lobby, every stair landing,
  the annex and the fire-escape landings have **no holes** at 0.25 m. The stair climbs ground → roof with no step
  over 0.18 m. The scripted walk found no falls on any storey.
- **The real falls are on the roof:** you can walk into the lift shaft through the shaft wall above the storey-4 lift
  doors, and off the roof stair landing into the stairwell.
- **Fire escape:** the flights are 0.63 m wide between guard colliders, against a 0.60 m body, so going down jams at
  the top of every flight. The drop ladder can't be climbed from the ground.
- **Dock / receiving:** the s0 steps climb into the facility's bay back wall. The shut roll-up opens onto a 1.1 m
  leveller that dead-ends at the FL-1 car wall.
- **Perf:** outdoor views draw **1190–1370 calls a frame** (the perf-audit baseline was 475), and main-thread CPU is
  12–13.6 ms a frame at 1×. Storeys 0 and 3 are over the lamp budget (52 and 51, budget 48).
- **No page errors** in any run. There are 17 console warnings, the same set every load.

## Ranked bug list

| # | Sev | Bug | Repro (world coords, m) | Evidence | Owner |
|---|---|---|---|---|---|
| 1 | **Critical** | **Roof: walk through the lift shaft's front wall into the shaft.** The wall looks solid, but nothing stops you, and you fall onto the car (or to the pit if the car is at 0). Root cause: `wall()` in the kit registers colliders only for solid spans and sills, never for the lintel above an opening. The storey-4 shaft walls run up to `HEAD_TOP`, so the strip above the storey-4 landing doors (x −38.4…−37.3) has no collider at roof level. | Stand in the roof lift lobby at (−37.9, 19.15, 17.5) and walk south (+z). Fall at (−37.9, 17.26, 20.76). The flood fill finds 2.6 m² of reachable hole at x −38.65…−37.15, z 19.6…21.6, falling to y 0.16. | `walk-roof+stair.json` ("roof lift shaft"), `floors.json` (roof deck) | `interior/kit.ts` `wall()`: add a lintel collider when `top` > opening top + ~1.8 m (or always). `interior/lift.ts` storey-4 shaft walls. |
| 2 | **High** | **Roof stair landing has an open edge.** At the roof level, the west half of the stair south of `zFlight` drops 3.3 m onto the storey-4 west flight. There is no balustrade and no collider; the only rail there is the short well-return rod. | From the roof landing (−41.5, 19.16, 17.4), walk south along x −42.3. You fall at (−42.3, 17.66, 19.7). Hole x −42.9…−39.9 (roof side) and x −42.85…−41.35, z 18.7…19.45. | `shots/roof-well.png`, `walk-roof+stair.json` ("roof well"), `floors.json` | `interior/core.ts` `landing()`/`railings()` for `i === STOREYS`: rail and collider across x ST.x0…wellX0 at z = zFlight. |
| 3 | **High** | **Fire-escape flights jam going down.** The treads are x −56.42…−55.79 (0.63 m). At each landing, the hole guard (x −55.79…−55.71) and the outer rail (x −56.55…−56.42) are colliders at landing height, so a 0.30 m-radius body has 1.5 cm of play. Stepping down from landings 4 and 2 stalls at the top tread. Going up works only by luck. | From (−56.1, 15.35, −0.5), walk north (−z) down the flight. Stuck at (−56.09, 15.35, −0.82). Same at (−56.09, 7.75, −0.83). | `walk-spines+outside+fire.json` ("fire down 4/2"), collider probe in the report notes | `facility/firescape.ts` `landing()` hole rail, `flight()` guards. Make the rail colliders thin and outside the tread width, or widen `FIRE_ESCAPE.depth` (`layout.ts`, request). |
| 4 | **High** | **Drop ladder can't be climbed from the ground; descending it drops you.** While on a ladder, W/S still move the body horizontally (0.4 × walk). Facing the ladder, W carries you through the 0.7 m-deep volume (x −56.45…−55.75) and out the far side at y ≈ 1.2, so you fall back. Going down with S backs you out at y ≈ 1.9, a 1.9 m drop. The caged ladder to the roof works. | Ground (−57.2, 0, 5.4), face +x, hold W: on the ladder at y 0.72, off at (−55.72, 1.24), back on the ground. From landing 1 at (−56.12, 4.07, 5.6), hold S: off at y 1.94. | `$TMPDIR/ah-audit/ladder-trace.ts` output (in this report) | `src/player.ts` ladder branch (clamp horizontal motion to the ladder volume, or block motion towards the rungs). `facility/firescape.ts` `dropLadder()` volume depth. |
| 5 | Medium | **The receiving steps climb into a wall.** s0's six steps up to the dock floor (x −24.55…−23.35, z −15.5…−13.8) run into the facility bay's back wall. That wall is a collider and a glowing block wall at z −15.5…−15.3, y −0.5…4.4. The bay (35 m² at y 1.25) is sealed off from receiving. | Look north from (−23.95, 0.16, −11.2). | `shots/dock-bay-steps.png`, `floors.json` (storey 0 "sealed 35.3 m²") | Conflict between `facility/dock.ts` (bay back wall, lines 83–86, 100) and `interior/storeys/s0/west.ts` `receiving()`. One of them owns the bay edge: drop the wall or drop the steps. |
| 6 | Medium | **The shut roll-up opens onto nothing usable.** Behind `dock-rollup-closed`, the dock leveller is only 1.1 m deep (z −21.66…−20.52) and ends at the FL-1 car wall (z −20.5, x −36.85…−33.25). Its steps at x −32.9…−31.85 lead into a 3.2 m² pocket closed off by a crate at (−32.0, −14.6). The doors check can't walk in from the dock (stops 1.10 m short). From inside, the open door isn't targetable, so E can't close it. | Dock (−33.9, 1.25, −23): E, then W. | `doors-ext.log`, `floors.json` (storey 0 sealed 3.2 m²) | `interior/storeys/s0/west.ts` `dockLeveller()`. Layout: `FREIGHT.car` sits directly behind the closed dock door (`layout.ts` request). |
| 7 | Medium | **West façade door `door-main-west--10` (ground, z ≈ −10) can't be walked through from one side.** It opens, but the walk stops 1.10 m short. This matches the s0 note that `room()` doesn't cut façade-lining openings. | `bun scripts/audit/doors.ts --all --only door-main-west--10$ --view lot` | `doors-ext.log` | `interior/kit.ts` `room()` lining / `storeys/s0` |
| 8 | Medium | **Fire-escape door leaves block the landing.** `fire-escape-1…4` (hinge z −0.49, 0.98 m leaf, opens 1.9 rad outwards) sweep across the whole 0.75 m inner walkway. Until the closer shuts the leaf, you can't get north to the flight. | Go out at storey 1 and turn north: stuck at (−55.39, 3.95, −0.31). | `walk-spines+outside+fire.json` ("fire up 1") | `facility/doors.ts` / `firescape.ts` (hinge on the north jamb so it opens against the wall, or a shorter swing) |
| 9 | Medium | **Lamp budget exceeded.** interior:0 has 52 lamps (30 fluorescent, 12 incandescent, 5 window, 2 exit; 3 shadow hints) and interior:3 has 51. The budget is ≤ 48. There are 246 registered lamps in total and the scene has 250 lights. | n/a | lamp census (numbers below) | `storeys/s0*`, `storeys/s3*` (counts include each storey's core-hall lamps) |
| 10 | Medium | **Draw calls tripled outdoors.** Road, gate, lot and dock draw 1190–1367 calls a frame, against 475 in `docs/perf-audit.md`. Main-thread CPU is 12–13.6 ms a frame at 1× and ~42–50 ms at 4×. From outside, every storey's static group draws (`s < 0` → all visible), and there are 1631 meshes (565 before), 302 materials and only 4 InstancedMeshes. | Views road / gate / lot / dock | `frame-std.json` | `src/world/interior.ts` outdoor visibility (window-facing storeys only, or merged far proxies), plus the storey modules' static draw counts |
| 11 | Low | **Boom button can't be targeted.** With the crosshair on `ctl-boom`'s centre from 0.7 m, the gate button `ctl-gate` (0.2 m above) gets the focus. The vehicle lane stays blocked by the boom (walk stuck at z 125.1). The gate button works from the booth's west face. | Stand at (6.5, 0.12, 128.8), aim at (7.205, 1.15, 128.8). | `walk-outside+spines.json`, `gate-boom.png` | `compound/gate.ts` button hit boxes / `doors.ts` `pick()` |
| 12 | Low | **Roof: 0.13 m² gap** between the core stair-head floor (ends at z 18.94, x ≤ −38.9) and the facility's roof lobby floor (starts at x −38.9), at x −39.4…−38.9, z 18.94…19.1. It falls to 15.36. The walker didn't drop into it (too small for the body centre to reach in practice). | (−39.15, 19.16, 19.0) | `floors.json` | `interior/core.ts` `landing()` roof `zEast` / `facility/shell.ts` `buildRoofDecks()` (extend one floor to z 19.6) |
| 13 | Low | **Doors check flakes.** `s0:0-16` "E closes it" failed on one side. `s0:0-17` and `s3:3-25c` "E opens it" failed on one side (no response, but the walk through succeeded). Every other s0–s3 check passed. These look like the known load flakiness. | `bun scripts/audit/doors.ts --all --only s0:0-17$ --at -20,0.16,0 --view corridor` | `doors-s0.log`, `doors-s3.log` | `world/doors.ts` (re-run first) |
| 14 | Low | **Coplanar overlaps that should be visible** (see the Overlaps section). Storey-4 corridor linoleum laid twice (4.8 m²); fire-escape tread grating coplanar with the steel nosing tops (≥ 9 m²); façade door frames coplanar with wall reveals (annex 4.4 m², fire-escape doors 3.7 m²); s3 plot coplanar with its wall (2.4 m²); riser W-1 floor/ceiling doubled with room finishes (1.44 m² per storey). | coords in the Overlaps section | `overlap-summary.txt` | per row |
| 15 | Low | **Console warnings (every load).** 16× `BufferGeometry.toNonIndexed(): already non-indexed` and 1× "Multiple active KTX2 loaders". | n/a | all logs | `render/documents.ts:227`, `world/facility/grounds.ts:133` (guard on `geo.index`); `render/materials.ts:303` + `render/models.ts:129` (share one KTX2Loader) |
| 16 | Info | **Sealed pocket on every storey:** 19.7 m² at x −38.15…−36.4, z 1.85…13.1 (east of the core hall) has no way in. Probably a chase; confirm it's intended. Also sealed by design: 4-14, the Director's office (236 m², barricaded), and every keycard room. | n/a | `floors.json` | `interior/core.ts` / services |
| 17 | Info | **4-14 barricade blocks its doorway** (collider [22.64, 15.36, −0.53]–[23.36, 16.15, 1.03]). Intended: the door is locked and barricaded. | n/a | `doors-s4.log` | n/a |

## 1. Floor coverage (`scripts/audit/floors.ts`)

The script uses a 0.25 m grid. It counts a point as standable when it is at least 0.30 m from every collider in the
body band, using the same test as `Player.move`. A hole is a standable point where `Player.groundAt` finds ground
more than 0.45 m below the expected level. It flood-fills from seed points so only reachable holes count.

| Area | Expected y | Reachable cells | Holes | Notes |
|---|---|---|---|---|
| Storey 0 | 0.16 | 46 199 | 0 | raised +0.36 at the receiving steps; sealed: dock bay 35 m², leveller pocket 3.2 m², chase 19.7 m² |
| Storey 1 | 3.96 | 45 212 | 0 | chase 19.7 m² |
| Storey 2 | 7.76 | 43 976 | 0 | chase |
| Storey 3 | 11.56 | 44 672 | 0 | chase |
| Storey 4 | 15.36 | 45 192 | 0 | chase; 4-14 sealed (intended) |
| Stair landings 0–4 | storey | 90 each | 0 | |
| Stair flights (centre lines) | n/a | n/a | n/a | each storey → next reached exactly, largest step 0.18 m |
| Annex | 0.15 | 16 472 | 0 | |
| Fire-escape landings 1–4 | storey | 71–90 | 0 | the railed flight-arrival holes are excluded |
| **Roof deck** | 19.15 | 43 364 | **164 cells / 3 clusters** | stair well (bug 2), lift shaft (bug 1), stair-head gap (bug 12) |
| **Roof stair head** | 19.16 | 285 | **19 cells / 2 clusters** | same holes, seen from the landing |

## 2. Scripted walk (`scripts/audit/walk.ts`)

Paths are planned with A* against the colliders. The script drives the real player with W/Shift/E and logs stuck
points, falls of more than 1 m, and arrivals at the wrong level.

| Leg | Result |
|---|---|
| Spines s0–s4: hall → west end → east end (s4: to the 4-14 pair at x 22) → hall | ok, ~100 s each, no snags |
| Stair ground → roof (out the roof door, round the roof deck) → ground | ok (217 s), no events |
| Lift: call from storey 2, then ride 2→3→4→0→1→2 with E in the car, stepping out to the lobby at each stop | ok; rider stayed on the car floor every ride |
| Roof edges | **two falls** (bugs 1 and 2) |
| Fire escape | **stuck** at the storey-1 door leaf (bug 8) and at the top of the flights going down (bug 3); caged ladder ok, drop ladder broken (bug 4) |
| Outside: lobby → entrance → lot → gate button → through the gate → forest edge (−70, 175) | gate opens from its button; the boom can't be raised (bug 11); otherwise ok |
| Rooms: all 151 registry rooms (door E, walk to the room centre) | no falls. The stuck events are almost all harness artefacts: keycard/locked rooms reached through their locked doors, room centres inside furniture, and already-open doors E-toggled. The genuine door/entry problems are the ones the doors check reports. Full log: `walk-rooms.log`, `walk-rooms.json` |

## 3. Doors check (`scripts/audit/doors.ts`, the copy of doors-check with `--unlock`)

| Set | Doors checked | Fails |
|---|---|---|
| s0 (`--at -20,0.16,0`) | 45 (5 locked skipped) | 0-16 close (1 side), 0-17 open (1 side). Flaky, see bug 13. |
| s1 | 25 | 0 |
| s2 | 35 | 0 |
| s3 | 35 | 3-25c open (1 side), flaky |
| s4 | 23 | 4-14 barricade (intended) |
| FL-1W / FL-1S, temporarily unlocked | 2 | **0**: 30 checks ok (open, swing, walk through both ways, close) |
| Facility + compound (fire-escape 1–4, roof-door, dock roll-ups, façade doors, annex, booth, gates; vehicle-gate unlocked) | 14 | dock-rollup-closed (bug 6), door-main-west--10 (bug 7). vehicle-gate doesn't respond to E even when unlocked: it is button-driven, as designed. |

## 4. Coplanar overlaps (`scripts/audit/overlap.ts`, adapted from the kit agent's zfight script)

The scan finds 483 coplanar same-facing groups. It already drops faces hidden by construction: wall bottoms on
floors, the plenum above the ceiling, and wall tops. Groups over 0.05 m² split into three kinds:

- 122 groups with **different materials** (453 m²). Most of this area is still buried: shell slab edges against wall
  faces, and faces pressed into the shell inner faces (−z at z −21.65, +z at z 21.65, and so on).
- 14 groups with the same **patterned** material (7.3 m²).
- 161 groups with the same **plain** material (1151 m²). These cause no visible fighting, only duplicate cost.

These are the ones you can see:

| Area | Where | Owner |
|---|---|---|
| 4.83 m² linoleum laid twice | storey 4 corridor around (−33.8, 15.364, 1.35) | `storeys/s4.ts` / `spine.ts` |
| 9.2 m² (+y) and 2.1 m² (+x) | fire-escape tread grating top = steel nosing top on every tread, e.g. (−56.42, 5.95, −2.66) | `facility/firescape.ts` `flight()` |
| 4.4 m² | annex door frame jamb faces = wall reveal, z −7.4 (x 35) | `facility/shell.ts` |
| 3.7 m² | fire-escape door frame = wall reveal, z −0.5 (x −55) | `facility/shell.ts` / `doors.ts` |
| 2.36 m² | s3 plot sheet in the wall plane at x 0.74 | `storeys/s3*` |
| 1.44 m² per storey | riser W-1 (5.4…6.6, −4.6…−3.4): riser floor = room floor finish; s0/s4 ceiling tile = riser ceiling paint | `interior/services.ts` / storey floors |
| 14.3 m² (check visually) | s0 painted lining and green-tile lining in one plane, z −21.615, x −47.8…−41.5, y 0.31…2.56 | `storeys/s0/west.ts` |
| 3.5 m² | dish yoke, metal_dark = galvanized, y 27.8 | `facility/dish.ts` |
| 0.08–0.44 m² | tile_green/epoxy edges, e.g. x −26.2, z 9.75 on every storey | kit `wall()` ends |
| 587 m² (cost only) | `facility-details:pine_needles` drawn twice, identical | `facility/grounds.ts` |

## 5. Flicker (`scripts/audit/flicker.ts`)

Each camera stands still for 3 s in the Look Lab with grain and lamp flicker off. The counts are pixels whose
range over the run exceeds 24 or 8 (of 255) at 1280×800.

| Cam | >24 | >8 | Mean range |
|---|---|---|---|
| s0 spine | 0 | 57 | 1.01 |
| s1 spine | 1 | 928 | 1.04 |
| s2 spine | 1 | 208 | 1.01 |
| s3 spine | 31 | 385 | 1.02 |
| s4 spine | 0 | 33 | 1.03 |
| s0 east spine | 0 | 66 | 1.02 |
| lot | 45 | 850 | 1.08 |
| gate | 193 | 3187 | 1.18 (fence mesh and barbed wire edges) |

The image is clean everywhere; there is nothing to fix here. Maps are in `flicker/*.png`.

## 6. Performance

**Boot** (`scripts/audit/boot-profile.ts`, view road, 1536×1024, median):

| | 1× (3 runs) | 4× CPU (2 runs) |
|---|---|---|
| first frame visible | 754 ms | 1.66–1.93 s |
| everything in (`complete`) | 6.97 s | 24.5–30.4 s |
| interior build / compile | 1.80 s / 2.72 s | 5.8–8.5 s / 11.0–12.2 s |
| interior shown at | 6.94 s | 24.4–30.3 s |
| longest task | 235 ms | 725–931 ms |
| steady frame (median of the last 60) | 16 ms (vsync) | 42–50 ms |

Interior is the critical path: about 60% of the time to `complete`.

**Frames** (`bench/frame-profile.ts`, 2000×1050 CSS at DPR 2): the auto-scale ran at a pixel ratio of 1.5, so the
canvas was 3000×1575. "GPU" is pipelined throughput for the full frame; per-pass timestamps are unusable on Metal.

| View | Draws/frame | CPU ms (median) | GPU ms | Triangles | Visible meshes | Pipelines |
|---|---|---|---|---|---|---|
| road | 1279 | 12.5 | 14.2 | 4.14 M | 1162 | 116 |
| gate | 1367 | 13.6 | 14.0 | 4.53 M | 1162 | 136 |
| lot | 1190 | 12.1 | 12.7 | 4.65 M | 1162 | 134 |
| entrance | 957 | 11.9 | 13.0 | 3.42 M | 1166 | 138 |
| dock | 1218 | 12.9 | 12.2 | 3.47 M | 1162 | 134 |
| lobby | 631 | 8.7 | 11.7 | 2.97 M | 834 | 136 |
| corridor (s0) | 592 | 7.7 | 12.2 | 2.85 M | 834 | 135 |
| s0 spine (icam −12, 1.8, 1.1) | 566 | 7.0 | 10.8 | 2.72 M | 834 | 135 |
| s1 spine | 652 | 7.5 | 12.8 | 4.09 M | 954 | 117 |
| s2 spine | 612 | 7.7 | 13.4 | 3.70 M | 939 | 117 |
| s3 spine | 615 | 10.3 | 14.1 | 3.25 M | 920 | 118 |
| s4 spine | 487 | 7.4 | 13.6 | 2.52 M | 759 | 118 |

The scene has 2400 objects, 1631 meshes, 302 materials, 1253 geometries, 250 lights (3 shadowed) and 75 vertex /
92 fragment programs.

All views fit 60 fps on an M5 at the user's size, but CPU per frame has doubled since the perf audit because the
draw count has. Storey 1 (4.09 M triangles in view) and storey 3 (10.3 ms CPU) are the heaviest interiors.

**Lamps per storey** (budget ≤ 48 registered, ≤ 3 shadow hints):

| Zone | Lamps | Shadow hints | Within budget? |
|---|---|---|---|
| interior:0 | **52** | 3 | **over** |
| interior:1 | 31 | 0 | yes |
| interior:2 | 37 | 0 | yes |
| interior:3 | **51** | 1 | **over** |
| interior:4 | 31 | 2 | yes |
| exterior | 44 | 6 | n/a |

## 7. Errors

No page errors in any run: floors, walk (all legs), doors (all sets), flicker, boot, frames and captures. The
console warnings are bug 15.

## Tools (all new, under `scripts/audit/`; no game source touched)

- `vite.config.ts` + `audit.html` + `entry.ts`: the frozen build, with the room/door registry on `__ahRegistry`.
- `serve.ts` (static server, :5231) and `lib.ts` (launch, open, in-page helpers).
- `floors.ts` (coverage), `walk.ts` (scripted walk), `doors.ts` (doors-check copy with `--unlock`), `overlap.ts`,
  `flicker.ts`, `boot-profile.ts` (copy pointed at the frozen build), `captures.ts` (evidence shots).
- Throwaway probes are in `$TMPDIR/ah-audit/`: `probe.ts` (floors/colliders in a box), `ladder-trace.ts`, `gate.ts`,
  `states.ts`, `lamps.ts`.

Re-run: `bunx vite build -c scripts/audit/vite.config.ts --outDir $TMPDIR/ah-audit/build`, then
`bun scripts/audit/serve.ts $TMPDIR/ah-audit/build &`, then any of the scripts above.
