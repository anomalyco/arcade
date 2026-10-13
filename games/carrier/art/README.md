# Carrier art (Blender build)

An alternative to the procedural `src/render/carrier-mesh.ts` model. The carrier was modelled in Blender 5.2 against
calibrated reference cameras: every concept view (`concept/carrier-1-hero.png`, the 8 panels of `carrier-3-yaw-strip.png`,
pitch panels 1 and 4 of `carrier-4-pitch-strip.png`, and the port/starboard/bow/stern elevations of
`carrier-2-turnaround.png`) has a camera with the concept as its background image. Each perspective camera was solved
(position, rotation, focal length) by Levenberg–Marquardt so the four flight-deck corners reproject onto the concept.
Island, elevator, mast height and hull depth were then measured by casting rays through those cameras.

- `carrier.glb`: flat-shaded, +Y up, one material per flat colour (base colour only, no textures)
- `carrier.blend`: Blender scene "Carrier" with the model, the stage (sun, sky world, water plane) and all
  `CARRIER_cam_*` reference cameras with their packed concept backgrounds

## Axes

| | glTF / game | Blender |
|---|---|---|
| up | +Y | +Z |
| bow | +Z | −Y |
| starboard (island side) | +X | +X |
| origin | waterline, mid-length, centreline | same |

Mapping: `game = (bx, bz, −by)`. The GLB is written in game space, so no runtime rotation is needed.

## Dimensions (metres)

- Length 330 (z −165 … +165), deck width 76 (x −38 … +38); deck-edge elevator sticks out to x −54
- Flight deck surface y = 20.0, keel y = −11 (draft 11). Hull beam at waterline 40–45, flaring to 71 under the deck
  slab; catwalk sponsons reach |x| = 41.4
- Island: x 22.4 … 39.4, z −72 … −27 (aft of midships, matching `ISLAND` in `shared/carrier-spec.ts`), bridge band
  13–16.5 m above the deck, radar top 49.7 m above the deck, antenna 55 m
- Elevator: x −54 … −38.2, z −76 … −46 (spec `ELEVATOR`)
- Markings are 6 cm above the deck. Runway lines, "07", dashes and threshold all reuse the `shared/carrier-spec.ts`
  positions (`CENTERLINE_X`, `GUIDE_X`, `APRON_LINE_X`, `NUMBER_*`, `THRESHOLD`, `DASH`)
- Overall bounds: x −54 … 44.3, y −11 … 75, z −165.6 … 165.1

The deck is empty. Vehicles and crew are left for the game to add.

## Nodes

| node | triangles | notes |
|---|---|---|
| `hull` | 2262 | hull shell, deck slab, sponsons, elevator, transom hangar, bow details |
| `island` | 926 | superstructure, both radomes, lattice mast, yardarm, antennas |
| `radar` | 44 | separate node, origin at its spin pivot (top of mast): translation (31.75, 63.5, −47.25). Spin about local +Y |
| `markings` | 538 | white/yellow/red deck paint as thin geometry |
| **total** | **3770** | |

All four sit under a root node `carrier`.

Materials: `deck`, `hull`, `band` (light grey upper hull and sponsons), `lower` (dark lower hull), `red` (waterline band),
`dark` (openings and hatches), `island`, `glass`, `radome`, `mast`, `white`, `yellow`, `redmark`.

## Disagreements with `shared/carrier-spec.ts`

- `DECK_Y = 24` / `DRAFT = 7`: the calibrated turnaround and bow elevations put the deck about 20 m above the waterline,
  with a deeper keel (about 11 m). I used 20 / 11. In the hero view the deep flared bow reads correctly at these values.
- The island z-range and elevator positions agree with the spec. The hero concept alone would put the island further
  forward, but the yaw strip, the overhead pitch panel and the elevations all agree on the spec's aft position.
