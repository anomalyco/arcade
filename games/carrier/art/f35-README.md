# f35.glb: low-poly F-35C Lightning II (strike bomber)

A flat-shaded carrier strike jet with no gun. It has an internal weapons bay with two hinged doors, two bombs in the bay and one bomb on a pylon under each wing. The gear is retracted. It was built from the approved v4 concept (`concept/f35-v4-*.png`) with a calibrated-camera fit, the same way as `hornet.glb`. The shape follows real F-35C geometry wherever the concept drifts (see "Intended deviations").

## Axes and units

- Same convention as `hornet.glb`: metres, glTF standard, **+Y up, nose toward +Z**, and **+X is the pilot's left**.
- Origin: on the centreline, with Y = 0 at the lowest belly point. The jet sits at Y = 0 with the gear up.
- Bounding box, airframe only: X −6.55…6.55, Y 0…3.51, Z −7.76 (stabiliser trailing edge)…+7.84 (nose tip). The wing bombs hang 0.76 m below the belly.
  - Length 15.6 m (real 15.7 m).
  - Span 13.1 m (real 13.1 m). The horizontal tail span is 8.02 m (real 8.02 m).
  - Height 3.51 m to the fin tips, measured from the belly with the gear up. The real 4.48 m is measured with the jet standing on its gear.
- Wing:
  - Leading-edge sweep 34.9°.
  - Trailing-edge sweep −11.2°: forward-swept, nearly straight.
  - About 62 m² gross area (real 62.1 m²).
- Fins are canted 20° outward. They are short and broad (1.74 m along the cant, root chord 3.05 m, tip chord 1.62 m, 0.36 m thick at the root) and sit at the very rear, beside the nozzle and over the stabilisers.
- Handy points (glTF coordinates):
  - Nozzle exit centre (0, 1.18, −7.11), radius 0.55. The exit is serrated.
  - Wingtip leading edge (±6.55, 1.52, −2.07) and trailing edge (±6.55, 1.52, −3.86).
  - Pilot's eye about (0, 2.15, 3.85).

## Nodes

All nodes are flat-shaded, with per-face normals and no shared vertices across faces.

| node | tris | pivot (node translation, glTF coords) | notes |
| --- | --- | --- | --- |
| `F35` | 0 | origin | root |
| `F35_body` | 1,168 | 0, 0, 0 | Fuselage with chines and a dorsal hump, DSI intakes and bumps, wings, canted fins, tail booms, nozzle, open bay cavity, inset panels |
| `F35_canopy` | 170 | 0, 0, 0 | Slim, low, frameless teardrop of smoked glass with a gold sheen strip on the crown; thin dark sill frame and a dark band on the forebody around it |
| `F35_stab_L` | 24 | 1.08, 1.28, −5.70 | All-moving stabiliser; pivot on its spindle; rotate about local X for pitch |
| `F35_stab_R` | 24 | −1.08, 1.28, −5.70 | As above |
| `F35_bay_door_L` | 32 | 0.653, 0.00, −0.01 | Modelled **closed** and flush. Hinge line runs along Z at the door's outer edge. Open = rotate about local Z by **+90…100°** (inner edge swings down) |
| `F35_bay_door_R` | 32 | −0.653, 0.00, −0.01 | Mirror of the left door: open = rotate about local Z by **−90…100°** |
| `F35_tailhook` | 24 | 0, 0.328, −4.41 | Stowed under the tail. Pivot at its forward end; the hook points aft (−Z); rotate about local X. Same layout as the Hornet's hook: by the right-hand rule a **negative** X rotation lowers it. Check the sign `plane-pass.ts` uses |
| `F35_bombs` | 0 | 0, 0, 0 | Group for the stores: hide this node to fly clean |
| `F35_bomb_bay_L` / `_R` | 150 each | ±0.36, 0.46, 0.015 | Bombs inside the bay, hidden by the closed doors. Pivot at the bomb's centre |
| `F35_bomb_wing_L` / `_R` | 150 each | ±3.45, 0.94, −1.83 | JDAM-style bombs under the wings. Pivot at the bomb's centre (drop them by moving the node) |
| `F35_pylons` | 24 | 0, 0, 0 | The two wing pylons. Hide them with the wing bombs |

- The canopy, stabilisers, doors, tailhook and `F35_bombs` are children of `F35_body`. The five store nodes are children of `F35_bombs`.
- **Total: 2,098 triangles** (budget 3,000), or 1,474 without the stores node.
- The validator reports 6,294 vertices, 14 materials and 36 primitives (draw calls). `gltf-validator` 2.0 gives 0 errors, 0 warnings, 0 infos and 0 hints.
- The game's own `src/dev/glb.ts` parser reads the file and gives the hierarchy, pivots and bounding box above.

## Materials

The materials use base colour only. They are linear factors; the sRGB values are shown here.

- `F35_grey` 110,114,123: haze grey, the base colour.
- `F35_grey_lt` 124,128,137 and `F35_grey_dk` 97,101,110: panel tones. They are scattered over large facets, the undersides lean light, and the spine panel and flaps are dark. About 40% of the larger grey quads also carry an inset panel: a lighter or darker tonal panel inside a thin border, or a small dark access panel. The insets are placed symmetrically.
- `F35_ram` 62,65,72: darker RAM edges and bands on the wing, tail and stabiliser leading edges, the bay-door outlines, the intake lips, the band around the canopy sill, the access panels and the boom ends.
- `F35_accent` 255,154,46 (#ff9a2e): the fin-tip caps and the wingtip edge strips. The game tints this material per team.
- `F35_glass` 58,42,18 (#3a2a12): dark smoked-bronze canopy glass, metallic 0.4, roughness 0.35.
- `F35_glass_sheen` 176,130,50: a thin gold strip on the two crown facets, for engines that shade flat.
- `F35_frame` 30,32,36: canopy sill frame and hook tip. There is no frame bar across the glass; the canopy is frameless like the concept.
- `F35_intake` 22,24,28: intake ducts and the nozzle interior.
- `F35_nozzle` 54,56,60 and `F35_nozzle_ring` 168,104,58: dark nozzle with a warm ring at the serrated exit.
- `F35_bay` 150,156,162: bay walls and ceiling, and the door insides.
- `F35_bomb` 62,66,62 and `F35_bomb_band` 232,192,40: dark bomb bodies with a yellow nose band. Each bomb has 4 X tail fins and JDAM strakes.

## Intended deviations from the concept

The user asked for real F-35C geometry and noted that the image model keeps drifting toward F-22 tails. Where the v4 sheets disagree with the real aircraft on these points, the model follows the real F-35C:

- **Fins.** The concept draws tall fins set well forward, F-22 style; in the hero they start above the wing trailing edge. The model's fins are short and broad (1.74 m along the cant, tips at 3.5 m, chord 3.05 → 1.62 m), canted 20°, and swept about 44°. They sit at the very rear, over the stabilisers and beside the nozzle. This costs about 4–5 IoU points in the hero and the side views, where the drawn fins stand out of the model's silhouette.
- **Stabilisers.** They have the real 8.02 m span and 32° leading-edge sweep, carried on short tail booms beside the nozzle. The sheets draw them a little narrower and further aft.
- **Wing trailing edge.** It is nearly straight (−11°), the real-aircraft value. The concept's trailing edge sweeps more, so the top-view tip chord is about 0.8 m shorter in the sheet than in the model. That difference is the largest landmark residual below.
- **Span.** The real 13.1 m is used. The turnaround draws 12.4 m at its own length scale.
- **Front and rear views.** The model is deliberately leaner than the sheets' fat drawn wing, stabiliser and intake cross-sections, which keeps FRONT and REAR IoU around 0.5.

The concept sets the surface style: large clean facets, sharp chines, the dark haze-grey palette with subtle tonal panels, the frameless gold canopy, and the small orange tips on the fins and wingtips.

## How it was made: calibrated reference cameras

The pipeline is the Hornet's, adapted. Host scripts live in `~/.cache/opencode-f35/` and are not part of the repo.

1. **Crop the references.** The turnaround sheet was cut into TOP, SIDE, FRONT and REAR, and the yaw sheet into 8 panels. The hero image is used whole. Each crop gets a silhouette mask: background-colour segmentation for the sheets, and sky, sea and sun removal for the hero.
2. **Build a parametric model at real F-35C dimensions** with a pure-Python generator.
   - 13 faceted fuselage rings with a raked intake ring, plus a weapons-bay cavity.
   - Faceted 7-point aerofoils for the wings, fins and stabilisers.
   - Nozzle, canopy, booms, doors, hook and stores.
3. **Solve one camera per reference.**
   - TOP, SIDE, FRONT and REAR are orthographic cameras with a fixed px/m scale: the length sets it for TOP and SIDE, the span for FRONT and REAR. The horizontal offset is anchored at the nose or centreline; the vertical offset is solved by silhouette IoU.
   - The hero and the yaw panels are perspective cameras with free yaw, pitch, roll, distance, focal length and lens shift. Each is solved by Powell on (1 − IoU) after a coarse grid search. The hero also uses hand-picked landmarks: the nose and the leading- and trailing-edge corners of both wingtips.
   - The yaw panels were solved without trusting their labels. This sheet is close to its labels; the largest offsets are "45°" at 47°, "90°" at 94° and "225°" at 234°.
4. **Fit the model to all views at once.** The wing and stabiliser planforms, wing height and dihedral, nose height, canopy, and body width and height scales were fitted on a weighted multi-view IoU: TOP and SIDE 1.0, hero 0.7, yaw panels 0.35, FRONT and REAR 0.3. A prior keeps them at real F-35C values (34–35° leading-edge sweep, a near-straight trailing edge, about 62 m² of wing).
5. **Overlay rounds in Blender.** Each round re-solved the cameras, built the geometry in a private scene, rendered every calibrated camera, and composited the renders over the reference crops on the host. There were 9 rounds; facet layout, ring shapes, belly line, intakes, booms and paint were edited by hand between them.
6. **Polish pass** (2 more rounds, after the user's review of the first version). Compare `concept/f35-blender-polish-compare.png`.
   - **Canopy:** rebuilt as a slim, low teardrop. It is 0.93 m wide, 3.95 m long and 0.42 m tall above its sill, which sits on the forebody surface and blends into the chines. The glass is dark smoked with a thin gold strip, and the windscreen arch is gone.
   - **Fuselage:** a dorsal hump over the engine raises the top line behind the cockpit by about 0.22 m (about 11% of the height there). The forebody chines are crisper, and the DSI bumps are bigger, six-faceted and two-tone.
   - **Fins:** shorter and broader in chord, and 2.8× thicker at the root.
   - **Panels:** inset tonal and dark access panels, a RAM band around the canopy sill, and wider intake lips.

### Per-camera results (final model after the polish pass, Blender renders)

| camera | type | silhouette IoU | landmark residual | solved camera |
| --- | --- | --- | --- | --- |
| top | ortho | 0.853 | nose 1.5 px; wingtip corners 21–50 px, of which ≤ 3.3 px (LE) / 45 px (TE) is chordwise, the rest the deliberate span difference | 56.7 px/m |
| side | ortho | 0.862 | nose 0.2 px / 0.00 m | 51.1 px/m |
| front | ortho | 0.552 | wingtips 8.0 px / 0.15 m rms | 54.0 px/m |
| rear | ortho | 0.523 | wingtips 12.4 px / 0.22 m rms | 55.3 px/m |
| hero | persp | 0.815 | 13.8 px rms: nose 4.3, wingtip LE 4.3 / 5.6, wingtip TE 26 / 14 | yaw 27°, 19° down, roll 13°, 67 mm |
| yaw000 | persp | 0.795 | n/a | yaw 0°, 19° down |
| yaw045 | persp | 0.775 | n/a | yaw 47°, 28° down |
| yaw090 | persp | 0.807 | n/a | yaw 94°, 21° down |
| yaw135 | persp | 0.818 | n/a | yaw 139°, 20° down |
| yaw180 | persp | 0.794 | n/a | yaw 182°, 18° down |
| yaw225 | persp | 0.749 | n/a | yaw 234°, 17° down |
| yaw270 | persp | 0.803 | n/a | yaw 270°, 21° down |
| yaw315 | persp | 0.790 | n/a | yaw 319°, 26° down |

**Why the trailing-edge residuals are large.** The wingtip trailing-edge residuals in TOP and the hero come from choosing the real nearly-straight trailing edge, a 1.9 m tip chord, over the concept's more swept one. With the concept's trailing edge, the hero trailing-edge residual was 9 px, at the cost of a −16° trailing edge.

**The hero camera** is drawn with about 13° of roll against its horizon, as the Hornet hero was, so it was solved with free roll.

## Files

- `art/f35.glb`: written by the pipeline's own GLB writer from the same geometry that was built and rendered in Blender.
  - It does not use Blender's glTF exporter, which crashed an earlier session.
  - No bevel modifier was applied; the facets are the geometry.
- No `.blend` file: under MCP safe mode `bpy.data.libraries.write` is blocked, and saving the session file was off-limits. The private `F35` scene and all `F35_` datablocks were removed from the session afterwards.
- Renders:
  - `concept/f35-blender-hero.png`: hero camera, bay doors rotated open.
  - `concept/f35-blender-yaw-strip.png` and `concept/f35-blender-turnaround.png`: the same layout as the reference sheets.
  - `concept/f35-blender-overlay-hero.png` and `concept/f35-blender-overlay-yaw.png`.
  - `concept/f35-blender-wip-1.png`, `-2.png` and `-3.png`: the in-progress renders.
  - `concept/f35-blender-polish-compare.png`: concept | hero before the polish pass | hero after it.
