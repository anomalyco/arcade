# Getaway: screenshot-style mockups

These are AI-generated **screenshot-style mockups of what the game could look like**. Each one is framed as a browser tab showing the game during play or in a menu, with the gameplay camera and the HUD. No part of the game has been built yet, so none of these are captures from a real game.

## 1. Art directions (same chase, 4 styles, one robber view and one cop view each)

- `dir-a-noir-1.png`: Neon noir, robber view. Straight top-down on rainy, reflective streets with BAR/HOTEL neon. The getaway car drifts away from 3 numbered cruisers under a helicopter spotlight. HUD shows wanted stars, loot, an extraction arrow, a minimap with the route, speed, and DRIFT/JAMMER/NITRO.
- `dir-a-noir-2.png`: Neon noir, cop view. Straight top-down from a cruiser as the suspect runs into an alley. HUD shows the dispatch minimap with a LAST SEEN ping, a helicopter panel (spotlight and fuel), a gadget bar with cooldowns and a radio log.
- `dir-b-flat-1.png`: Graphic and flat, robber view. A Mini Motorways-style vector city. An orange getaway car leaves curved skid marks while cruisers chase with flat red and blue light wedges. HUD shows a heat bar, $412K, the extraction arrow and SMOKE/OIL/EMP.
- `dir-b-flat-2.png`: Graphic and flat, cop view. A yellow suspect car sits under a large spotlight circle, a cruiser holds a roadblock, and a flat cop HUD shows the dispatch map and a 1–4 gadget bar.
- `dir-c-gritty-1.png`: Gritty realistic, robber view. Photoreal rain, smoke and rooftop detail with a full robber HUD. The camera is zoomed in tighter than the others.
- `dir-c-gritty-2.png`: Gritty realistic, cop view. A straight-down shot of the rainy docks with a gray muscle car pinned by the helicopter spotlight. HUD shows dispatch, a helicopter camera feed and gadget cooldowns.
- `dir-d-lowpoly-1.png`: Stylized low-poly 3D, robber view. A high three-quarter diorama of a harbor district with a red coupe, smoke puffs, 3 cruisers and a helicopter. HUD shows heat, loot, extraction, a minimap and Q/E gadgets.
- `dir-d-lowpoly-2.png`: Stylized low-poly 3D, cop view. A teal suspect car on a plaza under the helicopter spotlight, with cruisers, a roadblock and a cop HUD.

## 2. Key moments (neon noir)

- `key-1-bank-exit.png`: Four robbers with name tags run out of Pacific Trust Bank to the waiting car. Shows an "ALARM TRIGGERED – COPS INBOUND 0:20" banner and red pings at the screen edge. This one uses a closer zoom for the on-foot phase.
- `key-2-roadblock.png`: Cruisers parked nose to nose with barriers and a spike strip. The getaway car threads the gap in a shower of sparks for "NEAR MISS +500".
- `key-3-spotlight-alley.png`: Cop/helicopter view. The spotlight pins a compact car in a back alley inside a SPOTTED bracket. Shows "SUSPECT LOCKED 6s", the helicopter panel, a voice indicator and the radio log.
- `key-4-bust.png`: Four cruisers box the car in at a dead end. Shows an 80% BUSTING ring, the spike strip behind the car, the score and an event feed.

## 3. Vehicles (garage screens)

- `vehicles-robbers-garage.png`: The robber "Choose your ride" screen with muscle car, compact, van, motorcycle and armored SUV shown top-down on lit pads. Includes stat cards, paint swatches and each teammate's pick.
- `vehicles-cops-garage.png`: The police motor pool screen with cruiser, interceptor, SWAT van and helicopter (on a helipad). Includes role tags, signature gadgets and the squad's picks. A stray loot counter appears top-right and should be ignored.

## 4. Gadgets

- `gadgets-loadout.png`: The loadout screen. Robber column: oil slick, smoke screen, EMP, decoy car. Police column: spike strip, roadblock, helicopter spotlight, police scanner. Each card shows its cooldown, charges and an in-game preview, with Q/E slots and a READY timer.

## 5. HUD mocks

- `ui-robber-hud.png`: The full robber HUD: HEAT 3 / HELI INBOUND, loot and who carries it, a glowing route line to EXTRACTION – MARINA 640m 0:42, a team roster with voice indicators, a minimap with teammates, cops and a roadblock, a speedometer and gadget slots.
- `ui-cop-hud.png`: The full cop HUD: the dispatch map with a LAST SEEN 0:07 trail and allies, the dispatch radio log, the COPS 1–1 ROBBERS score and timer, a helicopter control panel (pilot, altitude, fuel, spotlight, REQUEST SWEEP), and a ROADBLOCK/SPIKE/EMP/SCANNER bar with cooldowns.

## 6. Map

- `map-district.png`: The Riverside District map screen. Shows the bank, jewelry store, art gallery and the armored truck route, extraction points at the Rail Yard, Marina and Tunnel, the precinct and helipad, plus the highway loop, alleys, shortcuts, a legend and a SET WAYPOINT button.

## Other folders

- `_illustrations/`: The first round of painted illustrations of the four directions, made before the brief changed to screenshot-style mockups. Kept for reference.
- `_rejected/`: Screenshot attempts that used a low cinematic chase camera instead of the gameplay camera. They were replaced by the files above.

## Recommendation: A, neon noir (with B's discipline for gameplay readability)

**Neon noir (A)** gives the strongest playable screen.

- **Readability at small sizes:** On dark wet asphalt, the light bars, headlights and spotlight are the brightest things on screen. Cars, sirens and the helicopter beam therefore read clearly even when each car is only a few dozen pixels. Team colors (amber robbers, blue cops, red for suspects and threats) sit cleanly on top of the dark base.
- **Selling the chase:** Sirens lighting the walls red and blue, puddle reflections, smoke from drifts and the sweeping spotlight do most of the cinematic work, with the Drive/Heat tone and no cartoon feel. Key moments 2 to 4 show that it can stage a roadblock, a spotlight pin and a bust from the fixed camera.
- **Cost in the browser:** It's affordable. A dark, simple top-down city can be built from modular tiles plus a lighting pass: additive light sprites or a 2D light map for siren, headlight and spotlight cones, a cheap screen-space or fake reflection layer on the roads, and particles for rain and smoke. The darkness hides missing detail, so the city geometry can stay simple. Use a straight overhead camera to avoid occlusion problems.

How the others compare:

- **B, flat graphic:** The most readable and by far the cheapest (Canvas2D or SVG-level work). It's the safest fallback, but it loses much of the tension and the heist-film mood.
- **C, gritty realistic:** Looks great in a still, but the busy textures muddy the cars at gameplay zoom. Asset costs are high and it would be heavy in a browser.
- **D, low-poly 3D:** Attractive and practical in WebGL. However, the angled camera causes buildings to hide the cars, and it reads closer to "stylish mobile game" than a grown-up heist film.

**Suggested hybrid:** Build A's lighting and mood on top of B's simplified, high-contrast geometry. Keep the roads flat and dark, buildings as simple roof blocks, and put the detail budget into lights, reflections and particles.
