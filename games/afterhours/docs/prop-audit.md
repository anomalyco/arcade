# Prop realism audit (2026-10-16)

Sweep of every procedural prop that reads low-poly, boxy or toy-like at walking distance. Captures were taken with
the pinned-camera automation params (`ccam` booth/compound, `icam` interior storeys, `fcam` facility grounds) by a
throwaway walker; full frames are in `captures/audit/*.png`, the crops below in `captures/audit/crops/`. Library
models are in `src/render/models.ts` (`loadModel(name, { lod })`, `instanceModel(name, placements, { lod })`; front
faces −Z, pivot on the ground at the footprint centre). The 12 models marked **new** were fetched for this audit
(all with the shared atlas/KTX2 pipeline, so they add no shaders; see `captures/models-audit-new.png`).

Severity: **A** = the user will notice at once (flat colour slabs, cubes standing for machines), **B** = reads
procedural up close, **C** = acceptable but would benefit.

## Compound (owner: compound agent — `src/world/compound/*`)

| # | Item | Where | Sev | Fix |
|---|---|---|---|---|
| C1 | Space heater: rounded box with an orange glow slab | `booth.ts` `furnish()`, heater child at booth NE corner (≈ x 10.4, z 126.3) | A | Replace with **`space_heater`** (new, 0.36×0.42×0.27 m, LOD1 1.5k). Keep the warm point lamp; put a small emissive strip behind its grille (or rely on the lamp) instead of the flat glow box. |
| C2 | Wall clock: flat beige cylinder | `booth.ts` `furnish()`, over north window (≈ x 9.6, y 2.5, z 126.3) | B | **`wall_clock`** (new, Poly Haven CC0), front −Z → yaw so it faces into the booth. |
| C3 | Thermos, mug, pencil cup: 10–12-segment plain cylinders | `booth.ts` `furnish()` counter | C | Fine at distance; if wanted, `desk_fan` (new) or `telephone` already there carry the counter. Raise segments to 24 and add a lid/handle. |
| C4 | Mop bucket by the entrance: square yellow box with a box wringer | `props.ts` `mopBucket()` at (−2.9, 23.4) | A | No good mop-bucket model exists (two candidates rejected, see CREDITS). Reuse the interior's swept-tub `bucket()` shape from `interior/rooms.ts` (rounded, casters, wringer) or drop the prop; `wet_floor_sign` beside the doors reads better than a bad bucket. |
| C5 | Extinguisher (none) | booth interior | C | Add **`fire_extinguisher`** (new) on the wall by the door: guard booths had one. |

![booth heater](../captures/audit/crops/booth-heater.png) ![booth counter](../captures/audit/crops/booth-counter.png) ![mop bucket](../captures/audit/crops/mop-bucket.png)

## Facility grounds (owner: facility agent — `src/world/facility/*`)

| # | Item | Where | Sev | Fix |
|---|---|---|---|---|
| F1 | Standby generator: stacked boxes with two black rectangles for doors | `grounds.ts` "Standby generator enclosure" at (ANNEX.max.x + 5.5, −16) ≈ (67.5, −16) | A | No CC0/CC-BY genset of the right size and period was found that is unbranded (the Sketchfab ones are modern portable units). Detail it: bevelled housing (`RoundedBoxGeometry` r 0.03), louvred door panels (repeat thin slats like the condenser), hinges/latches, a rain cap on the exhaust, a fuel-fill cap on the belly tank, conduit elbows, a stencilled panel decal. |
| F2 | Pad-mounted transformer: green box, flat orange rectangle "warning sign" | `grounds.ts` "Transformer pad" (41–49, 10–16.5) | A | Same treatment: rounded cabinet with door seam, padlock hasp, cooling-fin bank as proper fins, bushings as stacked discs; the warning sign as a textured decal (yellow/black "DANGER HIGH VOLTAGE" generic, no logo) on the gate instead of a plain orange plane. |
| F3 | Conduit risers: square boxes | `grounds.ts` utility-cabinet risers | C | Use 12-segment cylinders (galvanised conduit is round) with LB elbow boxes at the top. |

![generator](../captures/audit/crops/generator.png) ![transformer](../captures/audit/crops/transformer.png)

The dock itself (`props.ts`) is already library models (box truck, pallets, drums, hand truck, AC units, security
lights) and reads well.

## Interior (owner: interior agent — `src/world/interior/*`)

| # | Item | Where | Sev | Fix |
|---|---|---|---|---|
| I1 | Vending machines: red rounded boxes with a blank white glowing panel | `storeys.ts` `lounge()` (storey 1 south room 6 ≈ x −20, z −2.6…−3.8; storey 2 north room 9) | A | **`vending_machine`** (new, 0.62×1.83×0.62 m, LOD1 2.5k, retro coffee machine). Two side by side; keep the fluorescent `b.lamp` for the glow. |
| I2 | Water cooler: beige box + blue cylinder | `storeys.ts` `lounge()` by the opening | A | **`water_cooler`** (new, 1.32 m). |
| I3 | Sofa: stacked rounded boxes; coffee table and round table: slab + sticks | `storeys.ts` `lounge()` | B | **`lounge_chair`** ×2 (new) round the coffee table instead of the box sofa; the round table is acceptable (raise segments to 32). A sofa model can be added if wanted (Poly Haven `sofa_02` CC0 fits the period best). |
| I4 | Drinking fountains: three boxes | `corridor.ts` `fountain()`, every storey corridor (`storeys.ts` `corridorDressing`) and the ground corridor | A | **`drinking_fountain`** (new, wall-hung, 0.46 m wide, LOD1 1.5k) at y = FLOOR_Y, back against the wall. |
| I5 | Fire extinguisher cabinets: red cylinder in a box behind a glass quad | `corridor.ts` `extinguisher()`, 2 per storey | B | Keep the cabinet frame, put **`fire_extinguisher`** (new) inside instead of the cylinder+cone. |
| I6 | Line printer: beige box with a grey lid and a smoked strip | `furnish.ts` `lineprinter()`, storey 3 computer room | A | No model found (period line printers on Sketchfab are absent/branded). Detail: rounded chassis with a sloped acoustic hood, a visible platen/tractor-feed slot, control panel with lamps (`panelLights`), legs/stand, fanfold paper as a proper draped strip (`PlaneGeometry` with segments bent into the catch basket). |
| I7 | Tape drives and mainframe cabinets | `furnish.ts` `tapeDrive()` / `cabinet()` | B | Already bevelled with reels and lamps and read OK at distance; up close they need door seams, handles, vent grilles as relief (not dark stripes) and labels. No usable model (only `IBM 729`-style low-poly, branded). |
| I8 | Lab stools: puck seat on four rods | `rooms.ts` `stool()` (ground lab island, labs storey islands in `furnish.ts` `labs()`) | B | **`lab_stool`** (new, Poly Haven CC0, LOD1 1.2k) via `instanceModel` per storey. |
| I9 | Desk lamp in the ground lab (the one warm key light) | `rooms.ts` `buildLab()` at (−24.35, bench top, z0 + 0.14) | B | **`desk_lamp`** (new, Poly Haven sprung-arm lamp, 0.89 m reach). Keep the `b.lamp` spot; aim it from the model's shade (≈ local (0, 0.62, −0.45)). |
| I10 | Office wastebaskets: open 14-segment cylinders | `furnish.ts` `offices()` | C | Raise to 24 segments with a rolled rim (lathe) — no wastebasket model was good enough. |
| I11 | Radiators (none) — offices/lobby walls under windows are bare | `storeys.ts` `windowDressing()` | C | **`radiator`** (new, 0.92 m, LOD1 2k) under sill height in lit rooms; strong period cue. |
| I12 | Coat stand (none) | offices, lobby | C | **`coat_rack`** (new) in a corner of entered offices and by reception. |
| I13 | Lobby planter: tapered cylinder + flat soil disc | `lobby.ts` `plant()` | B | Library has no potted plant; Poly Haven `potted_plant_02` (CC0) can be fetched if wanted. |
| I14 | Desk fans | offices | C | **`desk_fan`** (new) on one or two desks; good scale cue. |

![vending](../captures/audit/crops/lounge-vending.png) ![cooler](../captures/audit/crops/lounge-cooler.png) ![lineprinter](../captures/audit/crops/lineprinter.png)
![fountain](../captures/audit/crops/fountain.png) ![corridor](../captures/audit/crops/corridor-fittings.png) ![lounge table](../captures/audit/crops/lounge-table.png)

Already fine (library models or well-detailed procedural): office desks/chairs/CRTs/phones/filing cabinets, records
shelving, closet mop bucket (`bucket()` swept tub), safety showers, troffers, doors, lobby shell chairs.

## New library models

| Name | Source | Licence | Tris (LOD1) | Size (m) |
|---|---|---|---|---|
| `space_heater` | "space Heater" by bloodmeat08 | CC BY 4.0 | 5,954 (1.5k) | 0.36×0.42×0.27 |
| `vending_machine` | "Old Caffee Vending Machine" by gorzi90 | CC BY 4.0 | 7,617 (2.5k) | 0.62×1.83×0.62 |
| `water_cooler` | "Water cooler" by tboiston | CC BY 4.0 | 2,184 | 0.30×1.32×0.32 |
| `radiator` | "Old Radiator" by thethieme | CC BY 4.0 | 7,534 (2k) | 0.92×0.62×0.08 |
| `coat_rack` | "Coat Rack" by Whostea | CC BY 4.0 | 5,580 (1.5k) | 0.42×1.85×0.41 |
| `drinking_fountain` | "Drinking Fountain" by MooKorea | CC BY 4.0 | 5,999 (1.5k) | 0.46×0.62×0.57 |
| `desk_fan` | "Retro-style Desk Fan" by futaba_blender | CC BY 4.0 | 6,000 (1.5k) | 0.35×0.36×0.25 |
| `fire_extinguisher` | "Fire Extinguisher" by loichuet1 | CC BY 4.0 | 2,792 | 0.32×0.60×0.17 |
| `wall_clock` | Poly Haven `wall_clock` | CC0 | 3,658 | 0.32×0.32×0.05 |
| `desk_lamp` | Poly Haven `desk_lamp_arm_01` | CC0 | 12,410 (2k) | 0.20×0.89×0.61 |
| `lab_stool` | Poly Haven `metal_stool_02` | CC0 | 6,532 (1.2k) | 0.45×0.46×0.47 |
| `lounge_chair` | Poly Haven `mid_century_lounge_chair` | CC0 | 6,148 (1.5k) | 1.01×1.17×1.19 |

Not found (searched Poly Haven and Sketchfab CC0/CC-BY): unbranded period line printer, tape-drive cabinet,
pad-mount transformer, standby genset, mop bucket, wastebasket — these stay procedural with the detail listed above.
