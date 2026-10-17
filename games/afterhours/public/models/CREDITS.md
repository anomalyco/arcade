# Model credits

Regenerate with `bun scripts/fetch-models.ts` (`--force` to rebuild). Every file is a single web-optimised .glb
(meshopt + quantised geometry; at most two materials over one baked KTX2 atlas: base colour ETC1S, normal UASTC, ORM
ETC1S; 2048 vehicles, 1024 ≥ 0.5 m, 512 small props), normalised to metres with the pivot at the
footprint centre on the ground and the front facing -Z. Total 24.5 MB.

No brands or real logos: vehicles are invented marques ("Fairheaven", "Negotiator", "Conquer", "Shvan", "LCT").

- Poly Haven assets are **CC0 1.0** (https://polyhaven.com/license); no attribution required.
- Sketchfab assets were fetched from the Objaverse 1.0 mirror (https://huggingface.co/datasets/allenai/objaverse),
  which redistributes each model under its original licence. **CC BY 4.0 assets require attribution**: ship the
  credit lines below in the game's credits.

| File | Asset | Author / site | Licence | Tris | Size | Use |
| --- | --- | --- | --- | --- | --- | --- |
| `car_wagon.glb` | [Fairheaven SW '84 - Low poly model](https://sketchfab.com/3d-models/aa0becb6e854422596cac6b21bf79787) | Daniel Zhabotinsky | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 23,581 | 1049 KB | hero: early-80s mid-size station wagon (compound lot) |
| `car_sedan.glb` | [Fairheaven LT '80 - Low poly model](https://sketchfab.com/3d-models/e2678da920cc4be68dbc193727919ffb) | Daniel Zhabotinsky | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 22,168 | 954 KB | 1980 full-size four-door sedan |
| `car_sedan_b.glb` | [Negotiator '80 - Low poly model](https://sketchfab.com/3d-models/892b2684fb37442299bfad9222cf331c) | Daniel Zhabotinsky | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 21,556 | 971 KB | late-70s/1980 four-door sedan (detective green) |
| `car_pickup.glb` | [Conquer '89 Pickup - Low poly model](https://sketchfab.com/3d-models/6c48c94be8974dc7a5932f697c0ba68f) | Daniel Zhabotinsky | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 22,502 | 1127 KB | compact two-door pickup (80s body) |
| `van.glb` | [Shvan '92 - Low poly model](https://sketchfab.com/3d-models/09d718c9cf72401b8534d265a06a803f) | Daniel Zhabotinsky | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 23,940 | 1215 KB | full-size cargo van (body style 1971–96) |
| `box_truck.glb` | [LCT 3000 '95 - Low poly model](https://sketchfab.com/3d-models/663a0953c038434a918cb85725c88ffa) | Daniel Zhabotinsky | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 19,222 | 947 KB | cab-over box truck (loading dock) |
| `covered_car.glb` | [covered_car](https://polyhaven.com/a/covered_car) | Poly Haven | CC0 1.0 | 12,592 | 640 KB | car under a dusty cover (creepy, compound/dock) |
| `dumpster.glb` | [Dumpster](https://sketchfab.com/3d-models/e8b38df736994cf8b4f7a3a9d2980f6b) | adjective.george | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 12,622 | 310 KB | front-load steel dumpster |
| `fire_hydrant.glb` | [fire_hydrant](https://polyhaven.com/a/fire_hydrant) | Poly Haven | CC0 1.0 | 12,000 | 621 KB | cast-iron fire hydrant |
| `bench.glb` | [Classic Park Bench (Low Poly)](https://sketchfab.com/3d-models/01a5b64427984632bb44242da3813bb1) | berkgedik | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 4,796 | 313 KB | slatted park bench with cast legs |
| `trash_can.glb` | [metal_trash_can](https://polyhaven.com/a/metal_trash_can) | Poly Haven | CC0 1.0 | 7,532 | 669 KB | rusted galvanised trash can, lid propped against it |
| `traffic_cone.glb` | [Worn Traffic Cone](https://sketchfab.com/3d-models/1cbffb4169684e5a84ba186882bd55d7) | kuuttisiitonen | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 1,136 | 410 KB | worn 28" traffic cone |
| `drum_steel.glb` | [barrel_03](https://polyhaven.com/a/barrel_03) | Poly Haven | CC0 1.0 | 1,473 | 465 KB | blue steel 55-gal drum |
| `drum_hazard.glb` | [Barrel_01](https://polyhaven.com/a/Barrel_01) | Poly Haven | CC0 1.0 | 2,682 | 523 KB | red drum with hazard label |
| `pallet.glb` | [Pallet](https://sketchfab.com/3d-models/d30bd5cc3eeb4052904fd85988402868) | maestronoov | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 2,160 | 391 KB | wooden shipping pallet |
| `crate_wood.glb` | [wooden_crate_02](https://polyhaven.com/a/wooden_crate_02) | Poly Haven | CC0 1.0 | 5,176 | 546 KB | wooden crate |
| `milk_crate.glb` | [plastic_crate_03](https://polyhaven.com/a/plastic_crate_03) | Poly Haven | CC0 1.0 | 12,720 | 347 KB | red plastic milk crate |
| `cardboard_box.glb` | [cardboard_box_01](https://polyhaven.com/a/cardboard_box_01) | Poly Haven | CC0 1.0 | 2,630 | 505 KB | taped cardboard box |
| `utility_box.glb` | [utility_box_01](https://polyhaven.com/a/utility_box_01) | Poly Haven | CC0 1.0 | 4,404 | 497 KB | grey electrical cabinet |
| `utility_box_b.glb` | [utility_box_02](https://polyhaven.com/a/utility_box_02) | Poly Haven | CC0 1.0 | 6,268 | 519 KB | green double-door electrical cabinet |
| `ac_unit.glb` | [exterior_aircon_unit](https://polyhaven.com/a/exterior_aircon_unit) | Poly Haven | CC0 1.0 | 9,493 | 328 KB | wall-mounted condenser unit |
| `security_light.glb` | [security_light](https://polyhaven.com/a/security_light) | Poly Haven | CC0 1.0 | 4,668 | 305 KB | caged wall/pole flood light head |
| `tyre.glb` | [old_tyre](https://polyhaven.com/a/old_tyre) | Poly Haven | CC0 1.0 | 2,880 | 488 KB | old car tyre |
| `trashbag.glb` | [trashbag](https://polyhaven.com/a/trashbag) | Poly Haven | CC0 1.0 | 4,482 | 457 KB | full black bin bag |
| `hand_truck.glb` | [hand_truck](https://polyhaven.com/a/hand_truck) | Poly Haven | CC0 1.0 | 13,220 | 723 KB | two-wheel hand truck (dock) |
| `office_desk.glb` | [metal_office_desk](https://polyhaven.com/a/metal_office_desk) | Poly Haven | CC0 1.0 | 6,898 | 409 KB | steel tanker desk |
| `office_chair.glb` | [Office Chair](https://sketchfab.com/3d-models/b228a29fa84544c2be501c295653ffe7) | nokillnando | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 9,450 | 431 KB | fabric swivel task chair |
| `stack_chair.glb` | [SchoolChair_01](https://polyhaven.com/a/SchoolChair_01) | Poly Haven | CC0 1.0 | 5,072 | 401 KB | moulded stacking chair |
| `filing_cabinet.glb` | [File Cabinet](https://sketchfab.com/3d-models/f0742791a0ea432db1f432c24de83867) | LtxxwSibeRia | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 2,227 | 538 KB | four-drawer steel filing cabinet |
| `filing_cabinet_open.glb` | [File Cabinet](https://sketchfab.com/3d-models/e7fec8b453ef4105ace383dde017485c) | Shorty_Digitan | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 1,432 | 285 KB | dark filing cabinet, one drawer pulled open |
| `crt_terminal.glb` | [Vintage Terminal](https://sketchfab.com/3d-models/847c174b86e24d868d25217ca2297886) | NoMoreFeelings | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 2,557 | 160 KB | beige CRT terminal + keyboard |
| `television.glb` | [television_02](https://polyhaven.com/a/television_02) | Poly Haven | CC0 1.0 | 2,310 | 126 KB | 80s CRT television |
| `telephone.glb` | [Vintage Telephone](https://sketchfab.com/3d-models/5b5d2f1ece3745279f2129fff13933d5) | mvrc.art | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 3,184 | 197 KB | black rotary desk telephone |
| `metal_rack.glb` | [worn_metal_rack](https://polyhaven.com/a/worn_metal_rack) | Poly Haven | CC0 1.0 | 6,372 | 507 KB | worn steel shelving unit |
| `steel_shelves.glb` | [steel_frame_shelves_03](https://polyhaven.com/a/steel_frame_shelves_03) | Poly Haven | CC0 1.0 | 8,396 | 348 KB | steel-frame shelves |
| `chemistry_set.glb` | [chemistry_set](https://polyhaven.com/a/chemistry_set) | Poly Haven | CC0 1.0 | 29,997 | 529 KB | lab glassware on stands |
| `glassware.glb` | [Chemistry Glassware](https://sketchfab.com/3d-models/b8594f7dc7e8442dbaaae7a11da4a962) | maxdragon | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 4,004 | 100 KB | beakers, flask, graduated cylinders |
| `microscope.glb` | [industrial_microscope](https://polyhaven.com/a/industrial_microscope) | Poly Haven | CC0 1.0 | 16,598 | 352 KB | lab microscope |
| `vending_machine.glb` | [Old Caffee Vending Machine](https://sketchfab.com/3d-models/eb605bea59574e43a6abc4109798d36d) | gorzi90 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 7,617 | 193 KB | retro coffee vending machine (lounge) |
| `water_cooler.glb` | [Water cooler](https://sketchfab.com/3d-models/4b88c4c4e94c497ca39f831f374e89fc) | tboiston | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 2,184 | 105 KB | bottled water cooler |
| `radiator.glb` | [Old Radiator](https://sketchfab.com/3d-models/8a1a2e0263aa401591c1e87d824a79ef) | thethieme | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 7,534 | 507 KB | cast-iron column radiator under a window |
| `space_heater.glb` | [space Heater](https://sketchfab.com/3d-models/7b35843ab9364ca695f11224698efabe) | bloodmeat08 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 5,954 | 142 KB | vintage radiant space heater on a wire stand (booth) |
| `coat_rack.glb` | [Coat Rack](https://sketchfab.com/3d-models/72e821fc75d9473183a63d548959693b) | Whostea | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 5,580 | 575 KB | bentwood coat stand |
| `drinking_fountain.glb` | [Drinking Fountain](https://sketchfab.com/3d-models/796e0b2660a440e3a2e8a24c6ed0fe72) | MooKorea | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 5,999 | 130 KB | wall-hung steel drinking fountain (corridors) |
| `desk_fan.glb` | [Retro-style Desk Fan](https://sketchfab.com/3d-models/79bb384f2ed545a5ae8c2b9cfa06cd8f) | futaba_blender | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 7,373 | 261 KB | steel desk fan |
| `fire_extinguisher.glb` | [Fire Extinguisher](https://sketchfab.com/3d-models/5676b179b3b744c0aaae53a3dcea2300) | loichuet1 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 2,792 | 349 KB | red stored-pressure extinguisher (corridor cabinets, booth) |
| `wall_clock.glb` | [wall_clock](https://polyhaven.com/a/wall_clock) | Poly Haven | CC0 1.0 | 3,658 | 84 KB | institutional wall clock |
| `desk_lamp.glb` | [desk_lamp_arm_01](https://polyhaven.com/a/desk_lamp_arm_01) | Poly Haven | CC0 1.0 | 12,410 | 406 KB | sprung-arm desk lamp |
| `lab_stool.glb` | [metal_stool_02](https://polyhaven.com/a/metal_stool_02) | Poly Haven | CC0 1.0 | 6,532 | 250 KB | steel lab stool with a wooden seat |
| `lounge_chair.glb` | [mid_century_lounge_chair](https://polyhaven.com/a/mid_century_lounge_chair) | Poly Haven | CC0 1.0 | 6,148 | 562 KB | leather swivel lounge chair |
| `wet_floor_sign.glb` | [WetFloorSign_01](https://polyhaven.com/a/WetFloorSign_01) | Poly Haven | CC0 1.0 | 228 | 185 KB | yellow wet-floor sign |
| `fluorescent_light.glb` | [mounted_fluorescent_lights](https://polyhaven.com/a/mounted_fluorescent_lights) | Poly Haven | CC0 1.0 | 3,540 | 165 KB | surface-mount fluorescent tube fixture |
| `security_camera.glb` | [security_camera_01](https://polyhaven.com/a/security_camera_01) | Poly Haven | CC0 1.0 | 13,571 | 303 KB | housed CCTV camera on bracket |

## Required attribution (CC BY 4.0)

- "Fairheaven SW '84 - Low poly model" by Daniel Zhabotinsky (https://sketchfab.com/3d-models/aa0becb6e854422596cac6b21bf79787), CC BY 4.0, modified (rescaled, re-centred, optimised).
- "Fairheaven LT '80 - Low poly model" by Daniel Zhabotinsky (https://sketchfab.com/3d-models/e2678da920cc4be68dbc193727919ffb), CC BY 4.0, modified (rescaled, re-centred, optimised).
- "Negotiator '80 - Low poly model" by Daniel Zhabotinsky (https://sketchfab.com/3d-models/892b2684fb37442299bfad9222cf331c), CC BY 4.0, modified (rescaled, re-centred, optimised).
- "Conquer '89 Pickup - Low poly model" by Daniel Zhabotinsky (https://sketchfab.com/3d-models/6c48c94be8974dc7a5932f697c0ba68f), CC BY 4.0, modified (rescaled, re-centred, optimised).
- "Shvan '92 - Low poly model" by Daniel Zhabotinsky (https://sketchfab.com/3d-models/09d718c9cf72401b8534d265a06a803f), CC BY 4.0, modified (rescaled, re-centred, optimised).
- "LCT 3000 '95 - Low poly model" by Daniel Zhabotinsky (https://sketchfab.com/3d-models/663a0953c038434a918cb85725c88ffa), CC BY 4.0, modified (rescaled, re-centred, optimised).
- "Dumpster" by adjective.george (https://sketchfab.com/3d-models/e8b38df736994cf8b4f7a3a9d2980f6b), CC BY 4.0, modified (rescaled, re-centred, optimised).
- "Classic Park Bench (Low Poly)" by berkgedik (https://sketchfab.com/3d-models/01a5b64427984632bb44242da3813bb1), CC BY 4.0, modified (rescaled, re-centred, optimised).
- "Worn Traffic Cone" by kuuttisiitonen (https://sketchfab.com/3d-models/1cbffb4169684e5a84ba186882bd55d7), CC BY 4.0, modified (rescaled, re-centred, optimised).
- "Pallet" by maestronoov (https://sketchfab.com/3d-models/d30bd5cc3eeb4052904fd85988402868), CC BY 4.0, modified (rescaled, re-centred, optimised).
- "Office Chair" by nokillnando (https://sketchfab.com/3d-models/b228a29fa84544c2be501c295653ffe7), CC BY 4.0, modified (rescaled, re-centred, optimised).
- "File Cabinet" by LtxxwSibeRia (https://sketchfab.com/3d-models/f0742791a0ea432db1f432c24de83867), CC BY 4.0, modified (rescaled, re-centred, optimised).
- "File Cabinet" by Shorty_Digitan (https://sketchfab.com/3d-models/e7fec8b453ef4105ace383dde017485c), CC BY 4.0, modified (rescaled, re-centred, optimised).
- "Vintage Terminal" by NoMoreFeelings (https://sketchfab.com/3d-models/847c174b86e24d868d25217ca2297886), CC BY 4.0, modified (rescaled, re-centred, optimised).
- "Vintage Telephone" by mvrc.art (https://sketchfab.com/3d-models/5b5d2f1ece3745279f2129fff13933d5), CC BY 4.0, modified (rescaled, re-centred, optimised).
- "Chemistry Glassware" by maxdragon (https://sketchfab.com/3d-models/b8594f7dc7e8442dbaaae7a11da4a962), CC BY 4.0, modified (rescaled, re-centred, optimised).
- "Old Caffee Vending Machine" by gorzi90 (https://sketchfab.com/3d-models/eb605bea59574e43a6abc4109798d36d), CC BY 4.0, modified (rescaled, re-centred, optimised).
- "Water cooler" by tboiston (https://sketchfab.com/3d-models/4b88c4c4e94c497ca39f831f374e89fc), CC BY 4.0, modified (rescaled, re-centred, optimised).
- "Old Radiator" by thethieme (https://sketchfab.com/3d-models/8a1a2e0263aa401591c1e87d824a79ef), CC BY 4.0, modified (rescaled, re-centred, optimised).
- "space Heater" by bloodmeat08 (https://sketchfab.com/3d-models/7b35843ab9364ca695f11224698efabe), CC BY 4.0, modified (rescaled, re-centred, optimised).
- "Coat Rack" by Whostea (https://sketchfab.com/3d-models/72e821fc75d9473183a63d548959693b), CC BY 4.0, modified (rescaled, re-centred, optimised).
- "Drinking Fountain" by MooKorea (https://sketchfab.com/3d-models/796e0b2660a440e3a2e8a24c6ed0fe72), CC BY 4.0, modified (rescaled, re-centred, optimised).
- "Retro-style Desk Fan" by futaba_blender (https://sketchfab.com/3d-models/79bb384f2ed545a5ae8c2b9cfa06cd8f), CC BY 4.0, modified (rescaled, re-centred, optimised).
- "Fire Extinguisher" by loichuet1 (https://sketchfab.com/3d-models/5676b179b3b744c0aaae53a3dcea2300), CC BY 4.0, modified (rescaled, re-centred, optimised).
