# Text stand-ins → readable documents

User rule: **any paper, note, label, plate, board or sign must carry real, readable words.** This lists every place
the storey/kit/compound code fakes text (blank `M.paper` quads, `M.felt`/`M.stencil`/`SPRAY` dash strokes, blank
plates, chalk strokes) and the document from `src/render/documents.ts` that replaces it. Line numbers are as of
2026-10-17 (they may drift; the function name is given too).

How to place (`documentGeometry`/`documentMesh`, or the storeys' existing `docs.add`/`wallDoc`/`paper` helpers):

- `position` = centre of the face **on** the surface; `normal` = out of the surface; `up` defaults to +Y (walls) or
  −Z (flat). Use `rotation` to match the old quad's tilt. Delete the old quad/box and any dash strokes.
- Plates, signs, boards, stencils, labels: `pin: "none", curl: 0`, and `offset` = thickness of whatever they sit on
  (+0.001). Paper on doors/walls: `pin: "tape"` (or `"pin"` on cork). Flat on desks: default (no pin, slight lift).
- `size` defaults to the document's real size (listed); pass `size` to fit an existing frame exactly.
- Ids generated per room: `door_<storey>_<nn>` for every room in the building program (`door_1_09`, `door_4_14`,
  `door_1_01v`; 1-04..07 expand to `door_1_04` … `door_1_07`), and `door_wc_m<s>`, `door_wc_w<s>`, `door_jc_<s>`,
  `door_st_<s>` for the service stack. EL/TC already exist as `plate_el<s>`, `plate_tc<s>`.

## Storey 4 (s4)

| Call site | Stand-in | Document id | Size (m) | Placement |
|---|---|---|---|---|
| `storeys/s4/east.ts:355–356` (`paperOver`, Director's door) | torn sheet + 7 dash strokes | `note_do_not_disturb` | 0.22×0.16 | left leaf face x 22.449, centre (y FLOOR+1.52, z −0.42), normal [−1,0,0], `pin:"tape"`, rotation 0.06; keep the two tape strips or drop them (the doc's `tape` pin draws its own) |
| `storeys/s4/west.ts:138–149` (4-01 north wall) | `SPRAY` boxes and dash strokes | `spray_do_not_demo` | 1.3×0.45 | on the gypsum board, centre (x −26.2, y FLOOR+1.82, z −21.61+0.014), normal [0,0,1], `pin:"none", curl:0`; keep the sprayed rectangle round the hatch, delete the 15 dash strokes |
| `storeys/s4/west.ts:232–234` (drawings pinned on the 4-02 west wall) | blue/white quads with felt strokes | `blueprint_4th_floor` (×2), `whiteprint_ceiling` (×2) | 0.9×0.62 | wall x −26.135, normal [1,0,0], `pin:"tack"`; the 0.6×0.9 one: `whiteprint_ceiling` with `rotation: π/2` |
| `storeys/s4/east.ts:236–237` + `s4/props.ts:289–295` (`nameCard`, 4-12) | blank tent cards | `namecard_01` … `namecard_12` | 0.21×0.095 | two documents per tent (each face), normals ± along the card's facing, tilted ±0.32 rad like the current faces; the face-down card (n === 7) shows `namecard_08` on the table side only |
| `storeys/s4/east.ts:289` (4-10 side table papers) | 3 blank sheets | `memo_next_of_kin`, `work_order_halt`, `letter_regret` | Letter / half | flat, `normal:[0,1,0]` |
| `storeys/s4/east.ts:374` (4-14 desk paper stack) | blank box | `note_repeated` (top), `roster_field_team` | Legal / Letter | flat on the stack top, offsets stacked |
| `storeys/s4/east.ts:193` (4-11 rubidium/bench keys) | 6 felt dots | keep (key caps, not text) | | |
| `storeys/s4/props.ts:174` (`frame`, construction photos) | blank photo face | `polaroid_dish` scaled (`scale: w/0.088`) or leave photos | | |
| `storeys/s4/props.ts:217–223` (shredder strips) | strips | keep (shredded paper) | | |

## Storey 3 (s3)

| Call site | Stand-in | Document id | Size | Placement |
|---|---|---|---|---|
| `storeys/s3/north.ts:370–375` (3-09 chalkboard) | 7 rows of chalk strokes | `chalkboard_equations` | 4.2×1.1 | over the board face (x 11.701), normal [1,0,0], `pin:"none", curl:0, offset:0.001`; delete the stroke loop |
| `storeys/s3/north.ts:240–241` (3-06 whiteboard) | dark-steel rule lines | `whiteboard_ops` | 2.6×1.1 | board face x −15.31+0.004, normal [−1,0,0]; delete the 6 rule boxes |
| `storeys/s3/north.ts:248` (north-array link status panel legend) | felt rectangle | `plate_array_link` | 0.26×0.22 | x −4.765, centre y FLOOR+1.61, z −13.4, normal [−1,0,0], `size:[0.4,0.22]` |
| `storeys/s3/north.ts:259, 379`, `s3/south.ts:289, 307` (`wallPapers`) | blank pinned quads | pick from tags `board`/`wall`: `roster_operators`, `ops_log`, `printout_greenbar`, `calendar_oct84`, `memo_signin`, `directory_extensions` | | see kit `wallPapers` below |
| `storeys/s3.ts:59` (halon panel by the machine-room door) | felt rectangle | `sign_halon_area` | 0.26×0.32 | x −16.75, y FLOOR+1.6, z −1.584, normal [0,0,1], `pin:"none", curl:0` |
| `storeys/s3/equipment.ts:122` (`halonBank` tags) | blank paper | `tag_halon` | 0.12×0.16 | one per bottle, on the bottle face, `size:[0.12,0.16]` |
| `storeys/s3/equipment.ts:161–162` (`teleprinter` paper) | blank sheets | `printout_teletype` | 0.22×0.3 | the rising sheet: normal as the quad, `size:[0.36,0.34]`; the fold-over can stay blank (seen edge-on) |
| `storeys/s3/equipment.ts:391–392` (`teletype` paper roll + sheet) | blank | `printout_teletype` | | front sheet only, `size:[0.24,0.3]` |
| `storeys/s3/equipment.ts:204–206` (`decollator` stacks) | blank boxes | keep body; top sheet `printout_greenbar` flat, `size:[0.38,0.28]` | | |
| `storeys/s3/equipment.ts:229, 233` (`pigeonholes` printouts) | stacked slabs | keep stacks; front sheet of the stuffed cubby: `printout_greenbar` `size:[0.27,0.33]`, plus the existing HALVERSON time-card label | | |
| `storeys/s3/equipment.ts:374` (`stripChart` heap) | crumpled boxes | keep (paper heap); one flat sheet `printout_greenbar` on top | | |
| `storeys/s3/furniture.ts:52` (`lateralFile` label holders) | blank | `label_file_1..8` | 0.08×0.04 | drawer face, `size:[0.08,0.04]`, `pin:"none", curl:0` |
| `storeys/s3/furniture.ts:80` (`cardCatalogue` drawer labels) | blank | `label_catalogue_1..8` (cycle) | 0.04×0.016 | `size:[0.04,0.018]` |
| `storeys/s3/furniture.ts:112` (`printoutStack` top sheet) | blank | `printout_greenbar` | 0.378×0.279 | flat on top, `size:[0.381,0.281]` |
| `storeys/s3/equipment.ts:452` (`flatFile` rolled map) | blank cylinder | keep (rolled) | | |
| `storeys/s3/north.ts:84` DELACROIX cubby label | done (time card) | — | | |
| `storeys/s3/mats.ts:113` `TEXT` terminal shader | procedural glyphs (unreadable by design, scrolling) | keep; for hero screens read closely, a static `printout_teletype`-style emissive doc is possible later | | |

## Storey 2 (s2)

| Call site | Stand-in | Document id | Size | Placement |
|---|---|---|---|---|
| `storeys/s2/props.ts:175–179` (`plate`) | dark plate with a pale "text" strip | by call: `s2.ts:63` → `sign_chem_store`; `s2/north.ts:432` → `sign_cold_room`; `s2/south.ts:199` → `sign_sensor_store` | as listed | replace the plate body + strip with the doc, `size:[w,h]` of the call, `pin:"none", curl:0` |
| `storeys/s2/north.ts:455–456` (`archive` depth labels on shelf lips) | blank paper strip | `label_depth_1..8` (by shelf level) | 0.12×0.025 | shelf-lip face, `size:[0.12,0.025]` |
| `storeys/s2/props.ts:292–296` (`jar` labels) | blank band | `label_jar_1..6` (cycle) | 0.07×0.035 | on the jar's front (curve is negligible), `size:[r*1.1*2, h*0.28]` |
| `storeys/s2/props.ts:306–312` (`coreBox` end label) | blank | `label_core_1..4` | 0.1×0.05 | box end face, `size:[0.1,0.05]` |
| `storeys/s2/north.ts:618` (containment tray label) | blank | `label_tray_na14` | 0.08×0.03 | on the tray rim |
| `storeys/s2/south.ts:373` (`sensorHead` tag) | blank | `tag_north_array` | 0.06×0.04 | `size:[0.04,0.06]` rotated with the tag |
| `storeys/s2/north.ts:502` (2-08 key cabinet label) | blank | `label_chem_key` | 0.12×0.05 | key cabinet face |
| `storeys/s2/props.ts:437` (`tallCabinet` label) | blank plate | `label_cabinet_1..4` (respirators, film, spill kit, glassware) | 0.16×0.06 | door face |
| `storeys/s2/props.ts:202` (`bottle` label bands) | blank band | keep (too small to read; ~2 cm) or `label_jar_*` on hero bottles | | |
| `storeys/s2/north.ts:553` (darkroom prints on the line) | blank / chart | `polaroid_corridor`, `polaroid_dish` `scale:2.3` | | |
| `storeys/s2/north.ts:252` (gowning sticky mat) | paper colour slab | keep (tacky mat, no text) | | |
| `fixtures.ts:47` (`eyewashStation` sign) | stencil box on green | `sign_eyewash` | 0.16×0.12 | same frame (local z 0.137 + 0.003), `pin:"none", curl:0` |
| `fixtures.ts:58–64` (drench shower green sign) | plain green box | `sign_drench` | 0.3×0.3 | same frame |
| `storeys/s2/south.ts:159` (2-24 chalkboard) | kit smears | `chalkboard_titration` | 3.6×1.1 | see kit `chalkboard` |

## Storey 1 (s1)

| Call site | Stand-in | Document id | Size | Placement |
|---|---|---|---|---|
| `storeys/s1/furniture.ts:290–305` (`inOutBoard`, 1-09) | blank name strips, felt rules | `inout_board_1_09` | 1.2×1.15 (rows 22) | covers the board face exactly (built to its geometry: name strips at u −0.5..0, IN/OUT/FIELD columns at 0.05/0.25/0.42); place at the board centre, `offset:0.003`, `pin:"none", curl:0`; keep the magnets on top; delete the paper strips and felt rules |
| `storeys/s1.ts:281` (1-02 chalkboard) | kit smears | `chalkboard_agenda` | 3.0×1.1 | see kit `chalkboard` |
| `storeys/s1/furniture.ts:265–268` (`flipChart` sheets) | blank | `flipchart_contracts` | 0.66×0.84 | pad face; the thrown-over sheet stays blank (back side) |
| `storeys/s1/furniture.ts:556–557` (`fillShelf` label cards) | paper + felt bar | `label_file_1..8` | 0.08×0.04 | `size:[0.14,0.08]` |
| `storeys/s1/furniture.ts:201–204` (`cardCatalogue` drawer labels) | blank | `label_catalogue_1..8` | | `size:[0.04,0.014]` |
| `storeys/s1/furniture.ts:399` (`securityContainer` label) | blank | `label_file_6` ("FIELD TEAMS 81–84") | | |
| `storeys/s1/furniture.ts:114, 223, 235, 242` (briefcase papers, copier trays, printer paper) | blank sheets | top sheets: `memo_next_of_kin` (briefcase, 1-07), `form_requisition` (copier), `letter_regret` (daisy-wheel printer feed, `size:[0.38,0.4]`) | | flat / along the sheet |
| `storeys/s1.ts:220` (records carriage end-panel label) | blank paper | `label_file_*` by range | | `size:[0.24,0.15]` |
| `storeys/s1.ts:243` (sorting table papers) | blank | `envelope_interoffice`, `memo_carbon_inventory` | | flat |
| `storeys/s1/furniture.ts:83` (Rolodex cards) | blank fan | keep (cards edge-on) | | |

## Storey 0 (s0)

| Call site | Stand-in | Document id | Size | Placement |
|---|---|---|---|---|
| `storeys/s0/lobby.ts:168–188` (`directory`, 0-02 felt letter board) | blurred `feltText` bars | `directory_board` | 0.9×1.1 | felt face (zWall + 0.052), normal [0,0,1], `pin:"none", curl:0, offset:0.001`; delete the `feltText` loop |
| `storeys/s0/lobby.ts:161–162` (bronze plaque) | lampShade bars | `plaque_dedication` | 0.42×0.26 | on the plaque face (zw + 0.016), keep the four rivets |
| `storeys/s0/west.ts:182–183` (`rack` labels, time clock) | blank strips, red FIELD TEAM strip | `label_rack_in`, `label_rack_out`, `label_rack_field` | 0.4×0.05 | over each strip, `size:[0.4,0.05]`, normal [−1,0,0] |
| `storeys/s0/west.ts:180` (OUT-rack cards) | blank cards | `timecard_day_1..4` (cycle) | 0.0825×0.187 | in the pockets, `size:[0.08,0.1]` (only the top shows) |
| `storeys/s0/west.ts:120–123` (time clock face) | felt hands/marks | keep (clock hands) | | |
| `storeys/s0/west.ts:515` (0-17 lab chalkboard smears) | smears | `chalkboard_wiped` | 2.4×1.1 | board face |
| `storeys/s0/west.ts:146` (exam couch paper) | blank roll | keep (blank by nature) | | |
| `storeys/s0/west.ts:496, 605` (lab notebooks, duplicator tray) | blank | `form_requisition`, `notice_nightshift` (duplicator output, a stack) | | flat |
| `storeys/s0/east.ts:76` (mail pigeonholes) | blank envelopes | `envelope_interoffice` `scale:0.6` in a few slots | | |
| `storeys/s0/east.ts:109` (hamper papers) | blank | keep | | |
| `storeys/s0/east.ts:126` (PBX jack field) | felt panel | keep (jack field) | | |
| `storeys/s0/east.ts:189` (HVAC chart discs) | blank discs | `chart_circular` | 0.3×0.3 | disc face, `size:[0.36,0.36]` (the doc is square; the disc edge hides corners) |
| `storeys/s0/east.ts:348` (security desk paper roll) | rod | keep; `security_log` is the logbook (already placed?) | | |
| `storeys/s0/east.ts:359` (key box back) | felt | keep (felt) | | |
| `storeys/s0/south.ts:73` (facilities key cabinet back) | felt | keep | | |
| `storeys/s0/lobby.ts:159` (dedication photo mount) | paper mount | keep (mat board; photo is `polaroid_dish`) | | |

## Kit and shared (kit agent)

| Call site | Stand-in | Document id | Size | Placement |
|---|---|---|---|---|
| `doorway.ts:90–91` (label strip under every number plate) | blank paper 0.22×0.05 | room plate `door_<storey>_<nn>` replaces **both** the kit number plate and the strip | 0.16×0.10 | at the plate position (`width/2 + 0.22, 1.5`, front face), `pin:"none", curl:0, offset:0.012`; drop the label strip; for ids without a plate use the `sign.label` text: rooms not in the program fall back to the existing generic plate |
| `kit.ts:931–932` (`door` number plates both faces) | blank `M.plate` | same `door_<id>` on the sign side; the far face can stay blank or use the same id | 0.16×0.10 | |
| `fixtures.ts:320–325` (`chalkboard`) | smears | callers pass a doc: s1 → `chalkboard_agenda`, s2 → `chalkboard_titration`, s3 3-09 → `chalkboard_equations`, s3 3-06 white → `whiteboard_ops`, s0 → `chalkboard_wiped`; add an optional `doc` param and place it at the board face (`size:[w, 1.1]`) | | |
| `fixtures.ts:329–332` (`wallPapers`) and `fittings.ts:63–83` (`bulletin`) | blank pinned quads | take a `DocumentId[]` (default `documentsByTag("board")` shuffled by the seed) and place real docs where the quads go; keep sizes (real Letter etc.) | | `pin:"pin"`/`"tape"` |
| `fixtures.ts:256` (`lockers` number plates "(blank)") | blank brass plate | `locker_01..12` | 0.06×0.03 | `size:[0.06,0.03]` at (u, 1.85, front) |
| `fixtures.ts:569, 591` (`lineprinter` stock / catch basket) | blank folds | top fold `printout_greenbar` `size:[0.38,0.28]` | | |
| `services.ts:80–81` (EL breaker schedule cards "(blank)") | blank cards | `breaker_schedule_<storey>` | 0.24×0.2 | wall x wx + 0.004, normal [1,0,0], `size:[0.24,0.2]`, `pin:"none", curl:0`; two panels → same id twice is fine |
| `services.ts:192–200` (`riserW1` "abstract bars") | stencil bars | `stencil_w1` | 0.36×0.12 | on the cupboard door beside the bars position, `pin:"none", curl:0`; delete the bars |
| `core.ts:95–99` (stair landing storey bars "no readable figures") | stencil bars | `stencil_storey_<i>` (0 = G … 5 = ROOF) | 0.5×0.6 | west wall x ST.x0 + 0.004, centre y + 1.75, z 17.4, normal [1,0,0], `pin:"none", curl:0` |
| `core.ts:329` (hall floor-plan holder) | blank quad 0.44×0.3 | `map_evac_<storey>` | 0.279×0.216 | `size:[0.44,0.3]` exactly, normal [1,0,0] |
| `core.ts:295` (rubbish on the mid-landing) | blank sheets | `envelope_interoffice`, `memo_coffee`, `note_repeated` flat | | |
| `lift.ts:85–88` (floor dial face + stencil ticks) | felt band + ticks | `lift_dial` | 0.34×0.17 | over the felt band; keep the needle |
| `lift.ts:91` (storey marks in the shaft) | stencil bars | `stencil_storey_<s>` `scale:0.5` | | shaft wall |
| `lift.ts:158` (car panel button marks) | stencil ticks | `lift_panel` | 0.1×0.4 | panel face, `size` to the panel |
| `lift.ts:165–167` (inspection certificate "(blank)") | blank quad 0.2×0.26 | `cert_elevator` | 0.2×0.26 | same frame, normal [1,0,0] |
| `doorway.ts:84` (keycard reader legend) | felt bar | keep (reader slot) | | |
| `lights.ts:186` (sconce shade off-state) | paper material | keep (frosted shade) | | |
| `washroom.ts:96` (felt panel) | felt | keep | | |

## Compound (compound agent)

| Call site | Stand-in | Document id | Placement |
|---|---|---|---|
| `compound/booth.ts:346–350` (guard booth clipboard sheet) | two blank slabs | `checklist_rounds` (top) over `security_log` | flat on the clipboard, `size:[0.21,0.27]`, `offset` 0.009 / 0.0075 |

## Not text (kept)

Felt clock hands, jack fields, key-box backs, shredder strips, Rolodex edges, rolled maps, exam-couch roll, gowning
mat, sconce shades and blank backs of sheets seen edge-on are not text and stay as they are.
