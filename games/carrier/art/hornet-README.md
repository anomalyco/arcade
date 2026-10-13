# hornet.glb: low-poly F/A-18E Super Hornet

A stylised, flat-shaded carrier fighter. The gear is retracted and there are no stores; only the wingtip launch rails are fitted. It was built from the v2 concept sheets (`concept/hornet-v2-*.png`) with a calibrated-camera fit.

## Axes and units

- Metres, glTF standard: **+Y up, nose toward +Z**, and **+X is the pilot's left**.
- Origin: on the centreline, with Y = 0 at the lowest belly point. The jet sits at Y = 0 with the gear up; add the gear height when you place it on deck.
- Bounding box: X −7.00…7.00, Y 0…4.71, Z −9.05 (stabiliser trailing edge)…+9.15 (pitot tip).
  - Length 18.2 m (real 18.3 m).
  - Span 14.0 m over the rails (real 13.6 m; the turnaround sheet draws it slightly wider).
  - Height 4.71 m (real 4.9 m).

## Nodes

All nodes are flat-shaded, with per-face normals and no shared vertices across faces.

| node | tris | pivot (node translation, glTF coords) | notes |
| --- | --- | --- | --- |
| `HORNET` | 0 | origin | root |
| `HORNET_body` | 790 | 0,0,0 | fuselage, LERX, wings + rails, canted fins, intakes, nozzles |
| `HORNET_canopy` | 158 | 0,0,0 | gold canopy with windscreen and mid frame bows |
| `HORNET_stab_L` | 20 | 1.28, 1.069, −6.354 | all-moving stabiliser; pivot on its spindle; rotate about local X for pitch |
| `HORNET_stab_R` | 20 | −1.28, 1.069, −6.354 | as above |
| `HORNET_tailhook` | 24 | 0, 0.473, −6.35 | stowed; rotate about local X (positive = hook down) |

The canopy, stabilisers and tailhook are children of `HORNET_body`.

**Total: 1,012 triangles** (budget 3,000). The validator reports 3,036 vertices, 9 materials and 13 primitives (draw calls); `gltf-validator` gives 0 errors and 0 warnings.

## Materials

The materials use base colour only. They are linear factors; the sRGB values are shown here.

- `HORNET_grey` 176,184,196: upper surfaces
- `HORNET_grey_low` 196,202,211: undersides
- `HORNET_radome` 198,204,212
- `HORNET_antiglare` 70,76,86
- `HORNET_grey_dark` 120,128,140: rails, pitot, hook
- `HORNET_nozzle` 62,66,74
- `HORNET_intake` 24,26,31
- `HORNET_gold` 150,112,36: metallic 0.4, roughness 0.35
- `HORNET_frame` 120,126,136

## How it was made: calibrated reference cameras

1. **Crop the references.** The turnaround sheet was cropped into TOP, SIDE, FRONT and REAR, and the yaw sheet into 8 panels. The hero image is used whole. Each reference gets a silhouette mask: background-difference for the sheets, sea and sky removal for the hero.
2. **Block out a proxy at real F/A-18E dimensions.** The generator is parametric and runs on the host and in Blender: 14 fuselage rings, wings, canted fins, stabilisers, nozzles, intakes and canopy.
3. **Solve one camera per reference.**
   - Orthographic views: scale + offset.
   - Perspective views: yaw, pitch, roll, distance, focal length and lens shift.
   - Each camera minimises (1 − silhouette IoU) plus a landmark reprojection term.
   - A joint landmark bundle adjustment triangulates the nose, wingtip-rail fronts, fin tips and nozzle centres from all 13 views.
   - The yaw panels were solved as free cameras. Some are **not** at their labels:
     - "135°" is really drawn from about 217°.
     - "225°" is about 147°.
     - "315°" is about 32°: a mirrored copy of the 45° panel.
4. **Fit the model to all views at once.** The cameras were then fixed and the model parameters fitted with Powell on a weighted multi-view IoU (turnaround 1.0, hero 0.7, yaw 0.35) plus a prior that keeps them near the real jet. The facet layout was edited by hand between rounds. There were 6 overlay rounds: render each camera in Blender, then alpha/edge overlay on the host.

### Per-camera results (final model)

| camera | type | silhouette IoU | landmark RMS (bundle) | solved camera |
| --- | --- | --- | --- | --- |
| top | ortho | 0.930 | 8.7 px / 0.18 m | 48.6 px/m |
| side | ortho | 0.932 | 14.3 px / 0.30 m | 47.8 px/m |
| front | ortho | 0.794 | 10.6 px / 0.21 m | 50.8 px/m |
| rear | ortho | 0.726 | 8.8 px / 0.17 m | 53.1 px/m |
| hero | persp | 0.746 | 14.2 px / 0.16 m | yaw 20°, 16° down, roll 14°, 47 mm |
| yaw000 | persp | 0.798 | 3.5 px / 0.13 m | yaw 1°, 22° down |
| yaw045 | persp | 0.834 | 8.1 px / 0.40 m | yaw 40°, 29° down |
| yaw090 | persp | 0.780 | 8.2 px / 0.42 m | yaw 90°, 32° down |
| yaw135 | persp | 0.791 | 5.8 px (nose only) | yaw 217°, 23° down |
| yaw180 | persp | 0.684 | 5.2 px / 0.23 m | yaw 180°, 19° down |
| yaw225 | persp | 0.837 | 5.6 px / 0.26 m | yaw 147°, 21° down |
| yaw270 | persp | 0.836 | 3.8 px / 0.19 m | yaw 270°, 30° down |
| yaw315 | persp | 0.834 | 6.5 px / 0.29 m | yaw 32°, 29° down |

Notes on the low scores:

- **FRONT/REAR IoU** is held down by the reference's fat drawn wing and stabiliser cross-sections and by its wider intake boxes.
- **yaw180** is held down by a drawn LERX/fuselage that is much fatter than in the turnaround.
- **The hero** is drawn with about 14° of bank relative to its sea horizon. A level-horizon camera could not fit the jet (IoU 0.52), so the hero camera has free roll.

## Files

- `art/hornet.glb`: written by the pipeline's own GLB writer from the same geometry that was built and rendered in Blender (Blender's bevel modifier was not applied).
  - Why not Blender's exporter: the Blender session crashed during the glTF-export call.
- No `art/hornet.blend`: under MCP safe mode `bpy.data.libraries.write` is blocked, and saving the session file was off-limits.
- The renders are in `concept/hornet-blender-*.png`.
