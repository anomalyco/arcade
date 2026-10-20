# ASHWOOD QA sweep (2026-10-19)

Read-only pass over the play path on the live dev server (:5196). I drove it with one headless Chromium at a time
(Metal, 1280×720, `--mute-audio`). Captures are in `games/ashwood/captures/qa/`, which is gitignored and local only:
`qa-*.png` are the crops, and the other files are the full frames they were cut from. I did not edit any game files.

How states were reached: play mode `/` (home → PLAY → title → intro played in full once and skipped partway once),
then debug `/?view=lot|corridor` with direct `__afterhoursPlayer.pos/yaw/pitch` teleports and
`__ashwoodTransmitter.switchOn/transmit/reveal`. Coordinates are world metres. Eye positions are given as
`x, feetY, z, yaw, pitch` (storey 3 floor y = 11.56). Other agents were editing files during the sweep, and the page
hot-reloaded twice. A few items may already have moved since I looked.

Rank: **A** = every player sees it, breaks immersion. **B** = obvious when you look. **C** = polish.

## Top 15

| # | Rank | Defect | Where | Capture | Likely owner |
|---|---|---|---|---|---|
| 1 | A | **Blood drag in 3-08 is a long, perfectly straight band of parallel stripes.** It is saturated and brighter than the pools and reads like a paint-roller stroke or tyre track, not a body being dragged. The footprints on it are clean, cartoon-red stamps with white specular rims. | 3-08, from the operator chair (≈8.4,−13) running NE past (6,−10) | `qa-drag-smear-stripes.png`, `qa-blood-footprints.png`, `15-drag-close.png` | `world/interior/blood.ts` (drag/foot decal), `storeys/s3/listening.ts` (spot list) |
| 2 | A | **Corpse skin is orange plastic.** Kessler (operator) and the other bodies have flat, saturated orange-yellow skin with no pallor or subsurface. Under the pendant it is the brightest thing in the room. Kessler's short hair is a dark ring with a visible **grid/stripe pattern** floating above a bald scalp: the hair cards are inflated off the head. | 3-08 operator, eye (8.8, 11.56, −13.1, yaw 0.4, pitch −1.0) | `qa-operator-head-grid.png`, `16-desk-papers.png` | `world/npc/blood.ts` (corpse pallor, `applyCorpseBlood`), `world/npc/corpse.ts` `bakePose` hair `inflate` 0.003 |
| 3 | A | **Wall body's head wound reads as a red blindfold.** A solid red band sits across the eyes. Above it is a vertical red **bar** of blood running down the wall, with stamped spatter that looks like clip-art. | 3-08 west wall body (1.21, −12.6), eye (3.2, 11.56, −11.0, yaw 0.89, pitch −0.4) | `qa-wall-body-face.png`, `qa-wall-spatter.png` | corpse wound overlay (`npc/blood.ts`), wall decal in `listening.ts`/`blood.ts` |
| 4 | A | **The "Move the body" push has no animation, and the reveal is mis-sequenced.** On E, Kessler pops from the desk to the floor in one frame. Before that, the blotter warning (TRANSMITTING WAKES IT…) is already visible around his arms. After the push his legs pass through the office-chair base and seat. | 3-08 operator desk (8.27, −13.85), eye (8.4, 11.56, −12.5, yaw 0, pitch −0.55) | `qa-reveal-frame0.png`, `qa-kessler-chair-intersect.png`, `20-reveal-0..3.png` | `storeys/s3/transmitter.ts` `reveal`, `listening.ts` OPERATOR_FLOOR / chair |
| 5 | A | **First-person hands are broken.** The flashlight-hand fingers have black jagged "sawtooth" bands on their undersides (normals or backfaces showing) and the skin is the same orange as the corpses. Looking down, the torch forearm is a black stump in the bottom-left. In the car, the hands on the wheel are mitten blobs with no wrapped fingers. | Any time the torch is on, e.g. 3-08 at the desk; intro drive | `qa-subtitle-hand.png`, `qa-torch-arm-looking-down.png`, `qa-intro-wheel-hands.png`, `qa-intro-wheel-hands-2.png` | `playerb/torch.ts`, `playerb/body.ts`, `playerb/seat.ts` (already on `docs/todo.md`) |
| 6 | A | **Steering wheel is a 12-sided polygon.** In the full-screen interior shot of the intro, the rim has clearly visible flat facets. | Intro drive, whole cabin view | `qa-intro-wheel-hands-2.png`, `04-skip-ring.png` | `game/intro/car.ts` (wheel rim segment count) |
| 7 | A | **Mirrors don't reflect.** Without the torch, the WC mirror is a flat, glowing teal rectangle. With the torch on it goes dark and shows only a hot spot. Each time a mirror was in view the console logged `GPUValidationError: Destroyed texture [ShadowDepthTexture] used in a submit`, ending in "too many warnings". | Storey 1 WC-M mirror, eye (−34.6, 3.96, 3.1, yaw 1.57) | `qa-mirror-flat-teal.png`, `qa-mirror-torch.png`, `26-mirror-*.png` | `render/mirrors.ts` (virtual camera, shadow map lifetime), `interior/washroom.ts` `framedMirror` |
| 8 | A | **Subtitles have no backing.** The call subtitles ("YOU  Ashwood Outpost to County.") are thin white typewriter text drawn straight over the scene. At the desk they land on Kessler's white shirt and become unreadable. The "E MOVE THE BODY" prompt is also tiny, low contrast and sits on his back. | 3-08 desk during the call | `qa-subtitle-on-shirt.png`, `qa-move-body-prompt-on-shirt.png`, `90-play-call.png` | subtitle DOM in `storeys/s3/transmitter.ts`; prompt `world/doors/hud.ts` |
| 9 | A | **Most rooms on storeys 2 and 4 are near-black, flat voids.** There is no fill, and only the window planes show. Even with the torch, open labs look like untextured grey boxes. Rooms on storeys 1 and 0 are lit, so storeys feel inconsistent. | s2 (−10, 7.76, 15), (20, 7.76, −15); s4 (−40, 15.36, −12), (25, 15.36, −12) | `qa-s2-unlit-room.png`, `30-s2-*.png`, `30-s4-*.png`, `32-torch-*.png` | lighting-state per storey (`interior/lighting-state.ts`), `render/lighting.ts` bounce/ambient |
| 10 | B | **Wendigo shows dithered noise.** Its fur and silhouette are a stipple/alpha-hash speckle that boils, and its antlers poke through the ceiling grid. The hunter also roams storey 3 after the reveal, and the console shows `hunter: caught the player (death path not wired yet)` with no death. | s3 terminal pool, around (−13.8, 11.56, 8.4) | `qa-wendigo-dither.png`, `qa-wendigo-antlers-ceiling.png`, `22-hunter-a.png` | `creatures/wendigo`, `creatures/kit/material.ts`; `game/hunter` (catch handler) |
| 11 | B | **Confetti CRT screens.** Through the terminal-pool glazing and in the s3 lit windows, the "on" CRTs are rainbow pixel confetti (orange/green/blue noise blocks), not phosphor text. | s3 spine looking into 3-24, eye (−9.8, 11.56, 9.4) | `qa-s3-speckle-windows.png` | s3 CRT screen material (`storeys/s3/equipment.ts`) or the facility window CRT graph (`facility/windows.ts`) |
| 12 | B | **Exit signs are blank red slabs.** The EXIT lettering does not read at any distance, and up close it is a solid red rectangle. | Lobby storefront (0, 2.77, 21.0); s3 fire-escape door (−54.5, 11.56, 0) | `qa-exit-sign-blank.png`, `12-exit-sign-close.png` | `interior/lights.ts` `exitSign` / `kit.ts` `M.exitSign` (a glow with no legend texture) |
| 13 | B | **The intro's last frame pops.** When the exit move ends and control is handed over, a single frame flashes a much brighter entrance canopy light and exposure, then settles. | Intro t ≈ 65.4 s, looking at the entrance from (2.8, 0.04, 41.3) | `qa-intro-end-light-pop.png`, `05-exit-19/20/21.png` | `game/intro/index.ts` handoff (light/exposure state on finish) |
| 14 | B | **Lift HUD covers the car panel.** The "CHOOSE A STOP" list renders over the real in-car button panel and the floor indicator. An orange progress bar crosses "COMPUTING, SIGNALS". Two copies of the floor list (HUD and buttons) sit side by side. | s0 lift car, eye (−37.85, 0.16, 20.6, yaw 0) | `qa-lift-hud-overlap.png`, `50-lift-car.png` | `world/interior/lift.ts` (panel HUD / aim) |
| 15 | B | **Em dashes in shipped text.** These are in the objective HUD "Find out why the radio went silent — check the map (M)" and "Find the radio room — 3-08" (`game/objectives.ts:19-20`). There is also a comment-only "DO NOT DEMO — SEE DIRECTOR" spec in `s4/west.ts`, and `s4/east.ts` has "DO NOT DISTURB — R.H.". Check that those textures don't carry the dash. | Top-centre objective after the intro | `qa-objective-emdash.png`, `04-afterskip-08.png` | `game/objectives.ts` |

## Further defects

### Home, loading, title, intro
- C: The loading screen says **PRESS ANY KEY** from 0% to 88%. A key press during that time does nothing visible, and
  the menu appears ~7–8 s after load (`01-loading.png`). Hide the prompt until `world=ready`, or acknowledge the
  press. Owner: `game/shell/menu.ts` / `static.ts`.
- C: The title card's typed lines end with a stuck text caret `|` after each line ("…Propagation Studies|") (`03-intro-03.png`).
  Owner: `game/shell/title.ts`.
- C: "SPACE TO SKIP" on the title card is ~7 px and near-invisible at the bottom right. The in-intro "HOLD SPACE TO
  SKIP" ring is fine.
- B: Skipping snaps straight to the player standing at (2.78, 0.04, 41.25). There is no fade, so you get a hard cut
  from the cabin to standing (`04-afterskip-*` sequence was deleted; behaviour verified).
- B: **Building windows are flat emissive cards.** Lit panes are uniform teal or orange quads with no depth, blinds,
  or room parallax, and the teal panes read like screens (`qa-flat-windows.png`, `04-afterskip-01.png`). The shader
  supports blinds and furniture silhouettes (`facility/windows.ts`), but at night distance they wash out flat.
- C: Through the intro, the forest road is mostly near-black. The dashboard gauge arcs are bright cyan lines floating
  in the dark (`qa-intro-wheel-hands-2.png`).

### Lot, entrance, lobby, north gate
- B: At the entrance the hood/canopy above the doors has one dim lamp. The rest of the facade between the lit windows
  is a black void with no sodium spill, and the concept's glow and fog halos are missing at the doors
  (`11-entrance.png`, `04-afterskip-08.png`).
- C: The lobby is mostly fine. The front desk is a dark, unlit box with a hard edge (`12-lobby.png`). Grain is visible
  in the floor reflections, but there is no shimmer: frame differencing showed only film grain
  (`60-shim` diff checked).
- C: The north gate is very dark without the torch. The fence mesh vanishes against the fog, the leaves read as thin
  lines, and with the torch the trees look like flat cards at the clearing edge (`qa-north-gate.png`, `40-*`, `41-*`).

### Storey 3 corridor, 3-08
- B: The 3-08 booth window crack is drawn as thin, white, perfect spider-web lines (a vector overlay), and it stays
  bright where it is not lit (`qa-booth-crack.png`). Owner: `listening.ts` booth glass.
- B: The spectrum analysers and receivers on the operator desk are rounded procedural boxes with flat knob discs that
  read as toys. This conflicts with the "realism above all" rule (`90-play-hide.png`, `19-call-2.png`). Owner:
  `storeys/s3/equipment.ts`.
- B: Half of 3-08 is pitch black. The face-down body at the door (9.7, −7.95) and the TX rack are invisible without
  the torch, and the single pendant lights only the desk (`14-308-*`, `15-*`). The brief calls for one pendant, but
  the body nearest the door should catch some spill so the room reads on entry.
- B: The warning blotter is legible but too clean and evenly lit. The block marker text sits on top of the blood,
  with no soak-through, and the blotter edge glows orange like a light box (`qa-warning-scrawl.png`). Owner:
  `render/documents.ts` `blotter_warning`.
- B: The 3-07 door leaf has dense, regular cream speckles that read like a texture tiling artefact, not worn paint.
  The wire-glass grid is a coarse checkerboard (`qa-door-speckle-sign.png`, `70-door-307-*`). Owner: the door leaf
  material in `world/doors` / interior kit.
- C: A blood splash on the TX-1 faceplate is a sharp red stamp floating on the panel face. The chart-body pool under
  (2.75, −16.55) looks fine.
- C: The face-down body's blood pool looks good. The jeans are low-res with a soft texture (`qa-door-body.png`).

### Washrooms, other rooms, storeys
- B: Washrooms on s1 are very dark with the lights off, so the stalls and urinals read as silhouettes. The flashlight
  hotspot makes the tile pure white (`24-*`, `25-*`).
- C: The s2 lab counter has three dark puck-like objects (`qa-s2-pucks.png`). These are probably flasks or caps
  without a material; I could not identify them.
- C: Storey 1 records room is fine with the torch (`qa-s1-records.png`).
- C: The stairwell is near-black on every landing. Its only light is one wall pack, and a long dark handrail line
  crosses the frame diagonally (`120-stair-*`).

### Systems and console
- B: The debug hint bar overlaps the lower screen in every frame and sits in front of subtitles. This affects debug
  only. In play mode, the hint key caps at bottom-left are legible (`qa-hud-hints-tiny.png`).
- B: Console: `hunter: caught the player (death path not wired yet)` (×3). One run went to the red death screen
  (RESTART FROM CHECKPOINT / START OVER) while I was teleporting around the lot, with no jump-scare visible
  (`qa-death-screen.png`).
- C: Console spam on every load: ~80× `BufferGeometry.toNonIndexed(): already non-indexed` and 4×
  `Multiple active KTX2 loaders`.

## Not found or OK
- No floating props spotted in the lobby, corridor or 3-08. Chairs, mugs and the mic stand sit on surfaces.
- No z-fighting seen on the corridors or lot. Frame-to-frame differences at a static camera are grain only.
- Doors and their signs moved together on 3-07 (`70-door-307-*`).
- The intro drive and parking are smooth, and the subtitles and title card typography are good.
