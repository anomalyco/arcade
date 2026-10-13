# boat.glb: low-poly Mk VII Fast Interceptor Craft

A flat-shaded carrier-launched fast patrol, light-attack, and utility craft. It is 100% enclosed with an armored stealth wheelhouse and opaque gold-tinted bridge windows, a stabilized remote weapon station (RWS) autocannon turret on the foredeck, a raked sensor mast with a surface-search radar bar and team-accent beacon cap, and twin vectoring waterjets at the stern. Built from the concept sheets (`games/carrier/concept/boat-*.png`) with a 13-camera calibrated multi-view fit in Blender 5.2.

## Axes and units

- Same convention as `hornet.glb` and `f35.glb`: metres, glTF standard, **+Y up, bow toward +Z**, and **+X is port (left when facing forward)**.
- Mapping from Blender model coordinates `(bx, by, bz)`: `gltf = (bx, bz, −by)`.
- **Origin `(0, 0, 0)`**: at the **waterline (`Y = 0`)**, **amidships (`Z = 0`)**, on the **centreline (`X = 0`)**, so the game can float and pitch/roll the boat on the ocean surface just like `carrier.glb`.
- **Bounding box** (glTF coordinates):
  - **X (beam):** `−2.761 m … +2.761 m` (**5.52 m** maximum beam across the midships chine).
  - **Y (vertical):** `−0.544 m` (deepest forefoot V-keel) … `+4.884 m` (mast beacon top); overall height **5.43 m** (**0.54 m** draft below the waterline, **4.88 m** air draft above the waterline).
  - **Z (length):** `−9.000 m` (waterjet nozzle exit tips; hull transom at `−8.350 m`) … `+9.000 m` (bow tip); **18.00 m** length overall (LOA).
- **Key heights & reference points** (glTF coordinates):
  - Bow tip: `(0.00, 1.71, +9.00)`
  - Foredeck RWS turret yaw base: `(0.00, 2.30, +4.97)`
  - Autocannon muzzle tip: `(0.00, 2.48, +6.75)`
  - Bridge eye / windshield centre: `(0.00, 2.95, +2.70)`
  -Enclosed cabin roof crown: `Y = +3.55 m` (`Z = −1.87 … +2.07 m`)
  - Radar bar spin pivot: `(0.00, 4.50, −0.94)`
  - Mast top cap: `(0.00, 4.88, −0.92)`
  - Aft working deck surface: `Y = +1.94 m` (`Z = −7.45 … −3.25 m`)
  - Port & starboard waterjet nozzle exits: `(±1.21, 0.75, −9.00)`

## Nodes

All nodes are flat-shaded with per-face normals and no shared vertices across faces. Every node has identity rotation and scale in the rest pose.

| node | parent | tris | node translation (glTF coords, relative to parent) | world pivot (glTF coords) | notes |
| --- | --- | --- | --- | --- | --- |
| `BOAT` | — | 0 | `0, 0, 0` | `0, 0, 0` | Root node at waterline amidships on centreline |
| `BOAT_hull` | `BOAT` | 664 | `0, 0, 0` | `0, 0, 0` | Faceted deep-V stealth hull, red lower hull below waterline, forward `BOAT_accent` sheer stripe, recessed foredeck & aft cargo deck, bow hatch, side coaming hatches, flush side exhaust ports, stern hood, tonal panel insets |
| `BOAT_cabin` | `BOAT_hull` | 344 | `0, 0, 0` | `0, 0, 0` | Enclosed stealth wheelhouse, V-swept visor frame, stepped side cheek sponsons with square ports, tonal roof/wall panel insets |
| `BOAT_glass` | `BOAT_cabin` | 10 | `0, 0, 0` | `0, 0, 0` | 5-panel wraparound gold-amber armored bridge glass (3 front visor trapezoids + 2 side windows) |
| `BOAT_mast` | `BOAT_cabin` | 48 | `0, 3.50, −0.92` | `0, 3.50, −0.92` | Flared roof pedestal, raked stealth mast pylon, upper pedestal, and `BOAT_accent` top beacon cap |
| `BOAT_radar` | `BOAT_mast` | 12 | `0, 1.00, −0.02` | `0, 4.50, −0.94` | Horizontal surface-search radar crossbar; rotate about local **+Y** to spin |
| `BOAT_turret` | `BOAT_hull` | 32 | `0, 2.30, +4.97` | `0, 2.30, +4.97` | Foredeck plinth and faceted RWS cupola; yaw pivot at its base — rotate about local **+Y** for azimuth |
| `BOAT_turret_gun` | `BOAT_turret` | 52 | `0, 0.18, +0.30` | `0, 2.48, +5.27` | Mantlet and 6-sided 25 mm autocannon barrel pointing toward `+Z`; elevation pivot at trunnion — rotate about local **+X** for elevation |
| `BOAT_waterjet_L` | `BOAT_hull` | 44 | `+1.21, 0.75, −8.35` | `+1.21, 0.75, −8.35` | Port (`+X`) vectoring waterjet steering nozzle; rotate about local **+Y** to steer |
| `BOAT_waterjet_R` | `BOAT_hull` | 44 | `−1.21, 0.75, −8.35` | `−1.21, 0.75, −8.35` | Starboard (`−X`) vectoring waterjet steering nozzle; rotate about local **+Y** to steer |

- **Total: 1,250 triangles** (budget 2,500), **3,750 vertices**, **11 materials**, **31 primitives** (draw calls).
- `gltf-validator` 2.0 reports **0 errors, 0 warnings, 0 infos, and 0 hints**.

## Materials

All materials use PBR base-colour factors only (no textures). Linear values are stored in the GLB; the sRGB equivalents are listed below:

- `BOAT_grey` `132, 137, 146` (`#848992`): primary naval haze grey.
- `BOAT_grey_lt` `154, 159, 168` (`#9a9fa8`) and `BOAT_grey_dk` `104, 109, 118` (`#686d76`): sunlit upper bevels, shaded hull bands, and symmetrical inset tonal panels.
- `BOAT_accent` `255, 154, 46` (`#ff9a2e`): **team-colour stripe** along the forward hull sheer/chine (`Z = +2.55 … +9.00 m`) and the mast top beacon cap. The game tints this material per team.
- `BOAT_deck` `66, 70, 78` (`#42464e`): recessed non-skid foredeck and aft working deck.
- `BOAT_frame` `44, 47, 53` (`#2c2f35`): bridge window frames, deck hatch borders, turret slot, side ports, and waterjet collars.
- `BOAT_lower` `152, 44, 38` (`#982c26`): anti-fouling dark red lower hull below the waterline (`Y < 0.28 m` at the bow tapering to `Y < 0` aft), matching `carrier.glb`.
- `BOAT_glass` `156, 110, 30` (`#9c6e1e`) and `BOAT_glass_sheen` `218, 166, 54` (`#daa636`): opaque bronze-gold bridge windows (`metallicFactor = 0.4`, `roughnessFactor = 0.35`).
- `BOAT_jet` `54, 57, 63` (`#36393f`): dark metallic-grey waterjet buckets and autocannon barrel.
- `BOAT_dark` `24, 26, 30` (`#181a1e`): waterjet interior bores, gun muzzle bore, and exhaust cavities.

## How it was made: calibrated reference cameras

1. **Reference cropping & segmentation (`crops.py`, `masks.py`).**
   - `concept/boat-2-turnaround.png` was cropped into `top`, `side`, `front`, and `rear`, and `concept/boat-3-yaw-strip.png` into 8 panels (`yaw000` … `yaw315`). `concept/boat-1-hero.png` was used full-frame.
   - Silhouette masks were extracted by border-connected studio background differencing on the sheets and sky/water/foam colour-space segmentation (preserving cool-grey hull shadow facets) on the water views.
2. **Parametric low-poly generator (`model.py`).**
   - 12 hull stations with faceted deck, sheer, team-stripe bevel, upper chine, lower chine, waterline, bilge, and V-keel vertices, plus symmetric tonal panel insets (`panel_insets`).
   - 7-station enclosed wheelhouse with a V-swept 5-panel bridge visor, stepped side cheek sponsons, flared mast + radar crossbar, foredeck RWS turret + barrel, and octagonal twin waterjet nozzles.
3. **13-camera calibration (`calib.py`, `landmarks.py`) & multi-view model fit (`fitmodel.py`).**
   - Orthographic views (`top`, `side`, `front`, `rear`) solve scale (`px/m`) and 2D translation; perspective views (`hero` and `yaw000` … `yaw315`) solve azimuth, elevation, roll, distance, focal length, and lens shift via coarse grid search followed by Powell minimization of `(1 − IoU) + landmark_rms`.
   - With all 13 cameras calibrated, `fitmodel.py` jointly optimized 17 model shape parameters on a weighted multi-view IoU objective (`top`/`side` 1.0, `hero` 0.8, `front`/`rear` 0.6, `yaw*` 0.35).
4. **8 iterative Blender build/render/overlay rounds (`gen_blender.py`, `overlay.py`).**
   - All work in Blender 5.2 ran inside a private scene `Boat` with `BOAT_`-prefixed datablocks and packed `BOAT_ref_*` camera background images, leaving the default scene untouched.
   - Early Round 1 (`concept/boat-blender-wip-1.png`, 930 tris, mean IoU 0.887) revealed that (a) the bridge windshield needed a V-swept visor planform, (b) the `FRONT` and `REAR` crop boxes needed to extend down to include the full red V-keel, (c) the hull side ports needed to sit flush inside the chine in `TOP`/`FRONT`, and (d) the centre windshield needed coplanar inner crown vertices so no centreline frame bar split the glass.
   - By Round 8 (`fin`, 1,250 tris), mean Blender-render silhouette IoU reached **0.898** across all 13 cameras (with `TOP` at **0.964**, `REAR` at **0.923**, `YAW045` at **0.929**, `YAW315` at **0.914**, `SIDE` at **0.910**, and `HERO` at **0.907**).
5. **Direct mesh dump & GLB export (`glb.py`).**
   - Rather than calling Blender's built-in glTF exporter, the final mesh vertices, polygon material indices, and node transforms were dumped as JSON from `bpy.data.scenes["Boat"]` and assembled into `games/carrier/art/boat.glb` on the host, then verified with `gltf-validator`. The temporary `Boat` scene and all `BOAT_` datablocks were then purged from Blender.

### Per-camera results (final model, Blender renders)

| camera | type | silhouette IoU | landmark RMS | solved camera |
| --- | --- | --- | --- | --- |
| `top` | ortho | **0.964** | 12.8 px / 0.26 m (bow 3.8 px, waterjets 4.4 px, mast 24.6 px) | 49.9 px/m |
| `side` | ortho | **0.910** | 12.0 px / 0.25 m (bow 11.6 px, mast 16.1 px, waterjet 7.4 px, keel 11.3 px) | 48.7 px/m |
| `front` | ortho | **0.882** | 16.3 px / 0.33 m (mast 13.0 px, chines 7.4–8.2 px, keel 27.7 px) | 48.8 px/m |
| `rear` | ortho | **0.923** | 12.0 px / 0.24 m (mast 8.0 px, chines 15.4 px, keel 5.7 px) | 49.2 px/m |
| `hero` | persp | **0.907** | 37.1 px (bow 1.7 px, stern 10.8 px, mast 38.7 px) | yaw 39°, 15° down, roll 0.1°, 35 mm |
| `yaw000` | persp | **0.853** | 17.3 px (bow 1.5 px, mast 24.4 px) | yaw 0°, 23° down, 34 mm |
| `yaw045` | persp | **0.929** | 6.5 px (bow 3.7 px, mast 8.4 px) | yaw 27°, 17° down, 50 mm |
| `yaw090` | persp | **0.848** | 22.7 px (bow 9.0 px, mast 30.8 px) | yaw 86°, 21° down, 69 mm |
| `yaw135` | persp | **0.893** | 18.0 px (bow 6.3 px, mast 24.7 px) | yaw 147°, 18° down, 81 mm |
| `yaw180` | persp | **0.892** | 19.6 px (mast 18.5 px, waterjets 20.1 px) | yaw 180°, 27° down, 50 mm |
| `yaw225` | persp | **0.876** | 31.1 px (bow 8.8 px, mast 43.0 px) | yaw 212°, 20° down, 68 mm |
| `yaw270` | persp | **0.878** | 22.2 px (bow 12.3 px, mast 28.8 px) | yaw 271°, 25° down, 51 mm |
| `yaw315` | persp | **0.914** | 18.8 px (bow 5.0 px, mast 26.1 px) | yaw 334°, 21° down, 50 mm |

## Deviations & notes on the concept sheets

- **Mast longitudinal station (`s = 9.92 m` vs `9.41 m` in `TOP`/`HERO` and `10.45 m` in `SIDE`):** The turnaround's `SIDE` profile draws the mast about 1.0 m further aft than `TOP` and `HERO`. The model places the mast at `s = 9.92 m` (`Z = −0.92 m`), splitting the difference; this accounts for almost all of the ~20–38 px mast landmark residual while keeping both `TOP` (`IoU 0.964`) and `SIDE` (`IoU 0.910`) above 0.91.
- **Forefoot keel in `FRONT` (`IoU 0.882`):** The `FRONT` view on the turnaround sheet draws a slightly deeper V-keel relative to its beam (`h/w = 1.14`) than `SIDE` and `REAR` (`h/w = 0.97`). The model uses a deeper forefoot V (`Y = −0.54 m` at `Z = +5.5 … +6.8 m`) that fairs smoothly into the planing bottom (`Y = −0.32 m` aft), giving `REAR` an IoU of `0.923` and `FRONT` `0.882`.
- **Waterline occlusion in `yaw090` / `yaw270` (`IoU 0.848 / 0.878`):** In the hero and yaw-strip references, the boat sits in low-poly water with white foam along the waterline, whereas the turnaround sheet (`TOP`, `SIDE`, `FRONT`, `REAR`) shows the full drydock hull including the red lower hull. The exported `boat.glb` includes the full red lower hull so the game's ocean shader can submerge it naturally at `Y = 0`.
