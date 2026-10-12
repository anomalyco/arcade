# Blackout: approved look

Screenshot-style mockups generated with an image model. They are targets, not captures of a build.

- `look-1-office.png`: the core look. Office Tower FL 12 at night.
- `look-3-flare.png`: a flare thrown into the dark storage room reveals two enemies.

Style: stylized flat-shaded low-poly 3D, mostly top-down camera (about 70° down, north-up, no rotation, slight
perspective). A dark navy base that still reads; saturated practical lights are the only strong colour (warm desk lamps,
cyan vending machine, magenta EXIT, red flares with faceted smoke). Crisp white rings for sound, a coloured ring under
each player (orange and cyan teams). Thin, widely tracked white HUD.

Differences from the mockups in the real game: one hit kills, so health is a single "1 HIT" pip, not a bar; the visibility
meter reads EXPOSED whenever you stand in light. Only the office map ships.

## Environment concepts (`env-*.png`)

Explorations at the game camera (close, ~68° down, ~12-14 m of floor across the screen):

| file | what it explores |
| --- | --- |
| `env-1-corridor.png` | corridor, doorway light wedge, EXIT glow at the end |
| `env-2-fluorescent.png` | open plan under floating fluorescent panels, flicker |
| `env-3-desklamp.png` | one warm desk lamp in a dark private office, long chair shadows |
| `env-4-server.png` | server racks, LEDs, perforated raised floor |
| `env-5-moonlight.png` | moonlight striped by window mullions, city below |
| `env-6-breakroom.png` | vending machine wash on wet linoleum, EXIT door |
| `env-7-maze.png` | corridor maze read from above: wall caps, AO, sparse pools |
| `env-8-props.png` | prop sheet: desk, chair, plant, cabinet, cooler, copier, whiteboard, boxes, sofa, fixtures, rack, cork board |
| `env-9-gameview.png` | **chosen direction**: gameplay view, tube fixtures, lamp cubicle, linoleum vs carpet |
| `env-10-materials.png` | floor material swatches (carpet, linoleum, wet, wood, concrete, raised floor) |
| `env-11-tension.png` | **chosen direction**: dark corridor, lamp wedge from a doorway, EXIT at the far end, long shadows |
| `env-12-openplan.png` | **chosen direction**: cubicle clusters, glowing monitors, glass meeting room, floor tape |

### What the renderer goes for (env-9, env-11, env-12)

- **Walls** are solid navy blocks with a flat, clearly lighter blue cap and a thin bright bevel on the top edge, so the
  maze reads even where it is pitch dark. Inner faces are lighter plaster that picks up light; a dark skirting and soft
  ambient occlusion where they meet the floor. Framed pictures, cork boards and clocks break up long faces.
- **Light** comes only from practical fixtures: fluorescent tube panels floating above head height (no ceiling), warm
  desk lamps, pendants over meeting tables, cyan vending machines, magenta EXIT signs, blue server strips, moonlight
  through windows. Each makes a soft pool with a penumbra; walls, partitions, furniture and people cast shadows, people's
  shadows stretch long away from the light. Between pools: deep navy, never pure black.
- **Floors**: grey linoleum tiles with faint glossy reflections of the fixtures in corridors, blue carpet tiles in open
  plan, warm wood planks in meeting rooms, stained concrete in stairwells, perforated raised floor in server rooms.
- **Props**: chunky low-poly, flat shaded, small bevels. Desks with monitors (some glowing), keyboards, mugs, papers,
  pedestals; five-star chairs; white-potted plants; cabinets; coolers; copiers with LEDs.
- **Post**: faint bloom on fixtures, haze cones under tubes with drifting dust, gentle navy lift in the shadows, warm/cool
  split, vignette, fine grain. Some tubes flicker.
