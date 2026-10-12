# Blackout: screenshot-style mockups

These are **screenshot-style mockups of what the game could look like**. They are AI-generated, not captures of an implemented game. Every image uses the gameplay camera (fixed top-down, true in-game scale) or an in-game menu, framed as a browser game viewport with a HUD.

Rejected versions (wrong camera angle or not on-style) are in `_rejected/`.

## 1. Art directions (same core moment: dark level, lamp pool, one visible player, footstep and gunshot ripples, a thrown flare, HUD)

### A. Noir minimal
- `dir-a-noir-1.png`: A warehouse that's almost all black. One hard white lamp pool with a player crossing it, crisp white footstep and gunshot rings, a red flare with its throw arc, and the full HUD.
- `dir-a-noir-2.png`: An office tower floor. A teal player at the edge of the light, a footstep trail down a corridor, a gunshot ring, a jagged ring from breaking glass, a shot-out lamp and a flare among the cubicles.

### B. Night-vision / thermal
- `dir-b-nightvision-1.png`: A phosphor-green night-vision warehouse with scanlines, a blown-out lamp pool, green ripple rings, a flare bloom and a bracketed tactical HUD with a circular radar.
- `dir-b-thermal-2.png`: An amber tactical-display industrial yard. A player sprints through a floodlight, with a shotgun ring, a door-slam ring and a hot flare.

### C. Moody realistic
- `dir-c-realistic-1.png`: A rain-soaked rooftop with a sodium lamp, wet reflections, cyan footstep rings, an enemy's gunshot rings and a red smoke flare.
- `dir-c-realistic-2.png`: A wet warehouse with hanging lamp cones. A player sneaks at the edge of the light, with footstep rings, gunshot and glass-break rings, and a red flare down an aisle.

### D. Stylized low-poly 3D
- `dir-d-lowpoly-1.png`: A flat-shaded office diorama lit by a warm desk lamp, a cyan vending machine and a magenta EXIT sign. It shows a footstep trail, an enemy's gunshot ring behind a partition and a red flare with faceted smoke. Both D images use a tilted diorama camera rather than a strict top-down one.
- `dir-d-lowpoly-2.png`: A low-poly container yard with an orange floodlight, a crossbow player, an enemy's gunshot rings, a green-lit doorway with a door-slam ring and a flare with faceted smoke.

## 2. Key moments (Noir direction)
- `moment-1-shoot-out-light.png`: A bullet tracer hits a lamp. The glass shatters with a jagged ring, a dashed outline marks where the pool was, the enemy who was standing in it fades out, and a "LIGHT DESTROYED · ZONE DARK" toast appears.
- `moment-2-flare-reveal.png`: A flare is thrown from a doorway into a dark storeroom. The glow reveals two crouched enemies with "!" markers, and a burn-time ring sits on the flare.
- `moment-3-ripple-standoff.png`: A free-for-all match point at 9–9. The enemy is visible only as a trail of fading footstep rings, while you sit hidden behind a pillar with a dotted aim line.
- `moment-4-killcam.png`: The killcam after a one-hit kill. A tracer runs from killer to victim, a frozen gunshot ring hangs in the air, the kill feed's new line is highlighted with weapon and distance, and the screen reads "KILLED BY JONAS · RESPAWN IN 3".

## 3. Menus
- `menu-1-loadout.png`: The loadout select. Primary weapons are the suppressed pistol, shotgun and crossbow, each with noise and range stats. Gadgets are picked two at a time from flare, noise decoy, light-breaker EMP and motion mine. It also shows a player preview and a ready bar.
- `menu-2-lobby.png`: The room lobby, with a shareable `blackout.game/room/k7x2` link, red and blue player lists with ready checks, match settings with a map thumbnail, chat and a start button.
- `menu-3-scoreboard.png`: The end-of-match scoreboard, showing kills, deaths, shots, lights out and flares, plus awards (Ghost, Lights Out, Loudest, Patience) and rematch, map and lobby actions.

## 4. HUD
- `hud-closeup.png`: A tighter crop of the full HUD: a minimap with lamp dots and ripple pings, the round timer and score, a three-line kill feed, a "1 HIT" health readout, a visibility meter ("EXPOSED · IN LIGHT"), a noise state ("SILENT (SNEAKING)"), ammo, and flare and decoy slots with key hints.

## 5. Maps
- `map-select.png`: The map vote screen. Warehouse, Office Tower FL 12, Rooftop (Rain) and Industrial Yard each show a top-down floor plan with its light placements and stats.

## Chosen direction: D. Stylized low-poly (`dir-d-lowpoly-1.png`)

This is the target the game is built against. Flat-shaded low-poly diorama under a fixed tilted camera, a dark navy base that still reads, and saturated coloured practical lights as the only strong colour: warm desk lamps, a cyan vending machine, a magenta EXIT sign, red flares with faceted smoke. White ripple rings for sound. `_rejected/dir-d-lowpoly-1-isometric.png` is the same look from a 45° isometric angle and is an acceptable alternative camera. The `_rejected/iso-spooky-*` images were too realistic and too black.

## Earlier recommendation: A. Noir minimal (superseded)

As an actual playable screen, **Noir minimal is the strongest direction**, and it's what the key moments, menus and HUD were built around.

- **Readability at small sizes:** It has three values (black level, white light, white rings) plus team colors, so the light pools, ripples and players read instantly even in a small browser tab or a shared screen. The realistic and night-vision styles turn to mush when scaled down, because the rain, grain and texture compete with the ripple rings.
- **Sells the tension:** Darkness is truly empty, which makes the ripples the main source of information. The standoff (`moment-3`) shows the core read-and-bait loop better than any other style could. Shooting out a light visibly erases part of the map.
- **Cheap to build:** It's flat 2D, so it fits Canvas2D or Pixi/WebGL with a light-mask render target, circle sprites for the ripples and a handful of tile shapes. There are no 3D assets, normal maps or post-processing to make.

The runner-up is **D. Low-poly**. It gives the maps more identity and color, and the colored practical lights are a nice tool for gameplay, but it costs a Three.js pipeline, modeled assets and shadow tuning, and its tilted camera makes visibility harder to judge. One option is to borrow D's colored practical lights (a red EXIT sign, a cyan vending machine) as accent colors in the noir renderer. **B** works well as an alternate filter, such as a "night-vision goggles" gadget, rather than as the base look. **C** looks the richest but is the most expensive, and it's the hardest to read.

Note for implementation: some mockups show multi-segment health bars. Since one hit kills, the real HUD should use a single "1 HIT" pip, as in `hud-closeup.png`.
