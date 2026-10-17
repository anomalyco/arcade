# Washroom fixtures (WC-M / WC-W, every storey)

Library models (`src/render/models.ts`; front faces −Z, so the back that goes against the wall is the +Z side.
`yawToward(nx, nz)` with the wall's outward normal gives the yaw. The pivot is at the centre of the footprint on the
model's lowest point.) Review renders: `captures/models-wc.png`, `captures/models-wc2.png`, `captures/models-wc3.png`,
and lit by a single warm spot: `captures/models-wc-night.png`.

| Name | Size w×h×d (m) | Tris (LOD1) | Mount |
|---|---|---|---|
| `toilet` | 0.48 × 1.00 × 0.93 | 12.0k (2.5k) | floor; back of the flushometer 0.02 m off the wall; seat 0.40 m |
| `urinal` | 0.29 × 1.15 × 0.35 | 4.8k (1.5k) | floor-standing stall urinal; back against the wall; centres 0.75 m apart |
| `lavatory` | 0.56 × 0.56 × 0.55 | 7.5k (1.5k) | wall-hung: the pivot is the bottom of the P-trap. Put it at y = FLOOR + 0.49 so the rim sits at 0.86 m; centres 0.76 m |
| `tp_holder` | 0.17 × 0.09 × 0.10 | 1.8k | stall side panel or wall, pivot y = FLOOR + 0.62 |
| `towel_dispenser` | 0.30 × 0.38 × 0.10 | 0.2k | wall beside the basins, pivot y = FLOOR + 1.12 (outlet at ~1.15 m) |
| `hand_dryer` | 0.28 × 0.24 × 0.21 | 2.6k (1.2k) | wall, pivot y = FLOOR + 1.0 |
| `waste_basket` | 0.35 × 0.36 × 0.35 | 11.5k (1.5k) | floor under the towel dispenser |

Static fixtures: place them with `mergeModels` per washroom (one call for the whole room) plus `modelColliders`.
Credits are in `public/models/CREDITS.md` (all CC BY 4.0).

No acceptable model was found for the items below. Build them in the kit to these specs (1984 commercial,
"overhead-braced" baked-enamel steel partitions):

## Toilet partitions (stall set)

- **Panels** (between stalls): 25 mm thick, 1.47 m long (the stall depth minus the 0.08 m gap at the wall end), 1.47 m
  high, bottom edge 0.30 m above the floor (top at 1.77 m). Edges rounded r 6 mm, a 3 mm continuous seam/bevel
  round the face 12 mm in from the edge. Baked enamel, a period colour (almond `#cbbf9f`, putty grey `#a7a397`, or
  "harvest gold" `#b8913a`), roughness 0.35, slight orange-peel normal; dents and scratched graffiti as decals.
- **Pilasters** (front posts): 32 mm thick × 0.10–0.20 m wide (wider at the wall end), floor to 1.88 m, with a
  **stainless floor shoe**: a 0.10 m tall sleeve 4 mm proud of the pilaster all round (chrome, roughness 0.2) and two
  visible fixing screws.
- **Doors**: 25 mm, 0.61 m wide (0.91 m for the accessible stall), 1.47 m high, bottom 0.30 m above floor, swing in.
  Gap 6 mm to the pilasters. **Hardware** (chrome): 3 wrap-around gravity hinges (top, bottom) each 0.15 × 0.05 m
  wrapped round the pilaster edge; a slide latch + keeper (0.09 × 0.03 m) on the inside at 1.0 m, with the
  occupied/vacant tab outside; a coat hook/bumper (0.06 m) on the inside at 1.55 m; an emergency-access notch.
  Leave one door ajar (15–30°) and one swung shut.
- **Headrail**: anti-grip stainless tube 25 × 38 mm with a fluted underside, running across the pilaster tops at
  1.88 m and turning into the wall with a flanged wall bracket; panels hang from it with U-brackets at the top corners.
- **Brackets**: chrome U-brackets (0.05 m) where panels meet pilasters and the wall, 2 per joint, at 0.45 m and
  1.6 m above the floor.

## Floor drain

0.15 m square (or 0.16 m round) nickel-bronze strainer flush with the tile: 6 mm thick plate with 20 slots (3 × 25 mm)
or a pattern of 8 mm holes, 4 corner screws; a 25 mm dark ring of grout/rust stain round it and a slightly darker,
glossier wet patch (roughness 0.15) spreading 0.3–0.6 m toward the drain (the floor falls to it). One per washroom,
centre of the room under the basins.

## Mirror (stainless angle frame)

Plate mirror 0.46 × 0.76 m per basin (or one 1.8 × 0.76 m over a run), bottom edge at 1.02 m. Frame: 19 mm stainless
angle (bright polished, roughness 0.15, metalness 1) with mitred corners and hidden fixing clips; mirror material:
metalness 1, roughness 0.02, very slight dirt/water-spot roughness map along the bottom 0.1 m and silvering decay
(dark grey blotches) at two corners. Needs the reflection probe/SSR the room already gets; otherwise a static env.

## Soap dispenser

The library candidate was a 2000s plastic unit (rejected). Build: chrome **valve-type lavatory soap dispenser**
mounted on the basin deck behind the faucet (a 0.10 m chrome spout on a 25 mm stem with a push-down head), or a
wall **glass-globe dispenser**: chrome bracket plate 0.08 × 0.06 m at 1.05 m, an inverted clear glass globe
(radius 0.055 m, IOR 1.5, transmission or simply glass material) with a pale pink/green liquid fill at 60%, chrome
push valve at the bottom.
