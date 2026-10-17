# Model credits

Regenerate with `bun scripts/fetch-models.ts` (`--force` to rebuild). Every file is a single web-optimised .glb
(meshopt + quantised geometry, WebP textures ≤1K, 2K for the hero wagon), normalised to metres with the pivot at the
footprint centre on the ground and the front facing -Z. Total 19.4 MB.

No brands or real logos: vehicles are invented marques ("Fairheaven", "Negotiator", "Conquer", "Shvan", "LCT").

- Poly Haven assets are **CC0 1.0** (https://polyhaven.com/license); no attribution required.
- Sketchfab assets were fetched from the Objaverse 1.0 mirror (https://huggingface.co/datasets/allenai/objaverse),
  which redistributes each model under its original licence. **CC BY 4.0 assets require attribution**: ship the
  credit lines below in the game's credits.

| File | Asset | Author / site | Licence | Tris | Size | Use |
| --- | --- | --- | --- | --- | --- | --- |
| `car_wagon.glb` | [Fairheaven SW '84 - Low poly model](https://sketchfab.com/3d-models/aa0becb6e854422596cac6b21bf79787) | Daniel Zhabotinsky | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 23,581 | 1056 KB | hero: early-80s mid-size station wagon (compound lot) |
| `car_sedan.glb` | [Fairheaven LT '80 - Low poly model](https://sketchfab.com/3d-models/e2678da920cc4be68dbc193727919ffb) | Daniel Zhabotinsky | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 22,168 | 981 KB | 1980 full-size four-door sedan |
| `car_sedan_b.glb` | [Negotiator '80 - Low poly model](https://sketchfab.com/3d-models/892b2684fb37442299bfad9222cf331c) | Daniel Zhabotinsky | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 21,556 | 1026 KB | late-70s/1980 four-door sedan (detective green) |
| `car_pickup.glb` | [Conquer '89 Pickup - Low poly model](https://sketchfab.com/3d-models/6c48c94be8974dc7a5932f697c0ba68f) | Daniel Zhabotinsky | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 22,502 | 841 KB | compact two-door pickup (80s body) |
| `van.glb` | [Shvan '92 - Low poly model](https://sketchfab.com/3d-models/09d718c9cf72401b8534d265a06a803f) | Daniel Zhabotinsky | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 23,940 | 1014 KB | full-size cargo van (body style 1971–96) |
| `box_truck.glb` | [LCT 3000 '95 - Low poly model](https://sketchfab.com/3d-models/663a0953c038434a918cb85725c88ffa) | Daniel Zhabotinsky | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 18,998 | 962 KB | cab-over box truck (loading dock) |
| `covered_car.glb` | [covered_car](https://polyhaven.com/a/covered_car) | Poly Haven | CC0 1.0 | 12,592 | 389 KB | car under a dusty cover (creepy, compound/dock) |
| `dumpster.glb` | [Dumpster](https://sketchfab.com/3d-models/e8b38df736994cf8b4f7a3a9d2980f6b) | adjective.george | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 12,622 | 429 KB | front-load steel dumpster |
| `fire_hydrant.glb` | [fire_hydrant](https://polyhaven.com/a/fire_hydrant) | Poly Haven | CC0 1.0 | 12,000 | 404 KB | cast-iron fire hydrant |
| `bench.glb` | [Classic Park Bench (Low Poly)](https://sketchfab.com/3d-models/01a5b64427984632bb44242da3813bb1) | berkgedik | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 4,796 | 580 KB | slatted park bench with cast legs |
| `trash_can.glb` | [metal_trash_can](https://polyhaven.com/a/metal_trash_can) | Poly Haven | CC0 1.0 | 7,532 | 567 KB | rusted galvanised trash can, lid propped against it |
| `traffic_cone.glb` | [Worn Traffic Cone](https://sketchfab.com/3d-models/1cbffb4169684e5a84ba186882bd55d7) | kuuttisiitonen | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 1,136 | 356 KB | worn 28" traffic cone |
| `drum_steel.glb` | [barrel_03](https://polyhaven.com/a/barrel_03) | Poly Haven | CC0 1.0 | 1,473 | 296 KB | blue steel 55-gal drum |
| `drum_hazard.glb` | [Barrel_01](https://polyhaven.com/a/Barrel_01) | Poly Haven | CC0 1.0 | 2,682 | 379 KB | red drum with hazard label |
| `pallet.glb` | [Pallet](https://sketchfab.com/3d-models/d30bd5cc3eeb4052904fd85988402868) | maestronoov | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 2,160 | 299 KB | wooden shipping pallet |
| `crate_wood.glb` | [wooden_crate_02](https://polyhaven.com/a/wooden_crate_02) | Poly Haven | CC0 1.0 | 5,176 | 355 KB | wooden crate |
| `milk_crate.glb` | [plastic_crate_03](https://polyhaven.com/a/plastic_crate_03) | Poly Haven | CC0 1.0 | 12,720 | 595 KB | red plastic milk crate |
| `cardboard_box.glb` | [cardboard_box_01](https://polyhaven.com/a/cardboard_box_01) | Poly Haven | CC0 1.0 | 16,952 | 373 KB | taped cardboard box |
| `utility_box.glb` | [utility_box_01](https://polyhaven.com/a/utility_box_01) | Poly Haven | CC0 1.0 | 4,404 | 247 KB | grey electrical cabinet |
| `utility_box_b.glb` | [utility_box_02](https://polyhaven.com/a/utility_box_02) | Poly Haven | CC0 1.0 | 6,268 | 272 KB | green double-door electrical cabinet |
| `ac_unit.glb` | [exterior_aircon_unit](https://polyhaven.com/a/exterior_aircon_unit) | Poly Haven | CC0 1.0 | 9,493 | 780 KB | wall-mounted condenser unit |
| `security_light.glb` | [security_light](https://polyhaven.com/a/security_light) | Poly Haven | CC0 1.0 | 4,668 | 471 KB | caged wall/pole flood light head |
| `tyre.glb` | [old_tyre](https://polyhaven.com/a/old_tyre) | Poly Haven | CC0 1.0 | 2,880 | 402 KB | old car tyre |
| `trashbag.glb` | [trashbag](https://polyhaven.com/a/trashbag) | Poly Haven | CC0 1.0 | 4,482 | 288 KB | full black bin bag |
| `hand_truck.glb` | [hand_truck](https://polyhaven.com/a/hand_truck) | Poly Haven | CC0 1.0 | 13,220 | 683 KB | two-wheel hand truck (dock) |
| `office_desk.glb` | [metal_office_desk](https://polyhaven.com/a/metal_office_desk) | Poly Haven | CC0 1.0 | 6,898 | 214 KB | steel tanker desk |
| `office_chair.glb` | [Office Chair](https://sketchfab.com/3d-models/b228a29fa84544c2be501c295653ffe7) | nokillnando | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 9,450 | 741 KB | fabric swivel task chair |
| `stack_chair.glb` | [SchoolChair_01](https://polyhaven.com/a/SchoolChair_01) | Poly Haven | CC0 1.0 | 5,072 | 235 KB | moulded stacking chair |
| `filing_cabinet.glb` | [File Cabinet](https://sketchfab.com/3d-models/f0742791a0ea432db1f432c24de83867) | LtxxwSibeRia | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 2,227 | 422 KB | four-drawer steel filing cabinet |
| `filing_cabinet_open.glb` | [File Cabinet](https://sketchfab.com/3d-models/e7fec8b453ef4105ace383dde017485c) | Shorty_Digitan | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 1,432 | 97 KB | dark filing cabinet, one drawer pulled open |
| `crt_terminal.glb` | [Vintage Terminal](https://sketchfab.com/3d-models/847c174b86e24d868d25217ca2297886) | NoMoreFeelings | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 2,557 | 207 KB | beige CRT terminal + keyboard |
| `television.glb` | [television_02](https://polyhaven.com/a/television_02) | Poly Haven | CC0 1.0 | 2,310 | 163 KB | 80s CRT television |
| `telephone.glb` | [Vintage Telephone](https://sketchfab.com/3d-models/5b5d2f1ece3745279f2129fff13933d5) | mvrc.art | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 3,184 | 290 KB | black rotary desk telephone |
| `metal_rack.glb` | [worn_metal_rack](https://polyhaven.com/a/worn_metal_rack) | Poly Haven | CC0 1.0 | 6,372 | 294 KB | worn steel shelving unit |
| `steel_shelves.glb` | [steel_frame_shelves_03](https://polyhaven.com/a/steel_frame_shelves_03) | Poly Haven | CC0 1.0 | 8,396 | 456 KB | steel-frame shelves |
| `chemistry_set.glb` | [chemistry_set](https://polyhaven.com/a/chemistry_set) | Poly Haven | CC0 1.0 | 29,997 | 635 KB | lab glassware on stands |
| `glassware.glb` | [Chemistry Glassware](https://sketchfab.com/3d-models/b8594f7dc7e8442dbaaae7a11da4a962) | maxdragon | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 4,004 | 81 KB | beakers, flask, graduated cylinders |
| `microscope.glb` | [industrial_microscope](https://polyhaven.com/a/industrial_microscope) | Poly Haven | CC0 1.0 | 16,598 | 482 KB | lab microscope |
| `wet_floor_sign.glb` | [WetFloorSign_01](https://polyhaven.com/a/WetFloorSign_01) | Poly Haven | CC0 1.0 | 228 | 113 KB | yellow wet-floor sign |
| `fluorescent_light.glb` | [mounted_fluorescent_lights](https://polyhaven.com/a/mounted_fluorescent_lights) | Poly Haven | CC0 1.0 | 3,540 | 169 KB | surface-mount fluorescent tube fixture |
| `security_camera.glb` | [security_camera_01](https://polyhaven.com/a/security_camera_01) | Poly Haven | CC0 1.0 | 13,571 | 302 KB | housed CCTV camera on bracket |

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
