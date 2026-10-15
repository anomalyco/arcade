# Outbreak map

Press **N** (physical `KeyN`, labelled with its QWERTY name on every layout) to open a full-screen survey sheet of
what your survivor has seen. N or Esc closes it. The game keeps running while it is open, offline and in co-op:
movement keys still move you, and only the mouse over the sheet is taken, so you don't aim or fire at the map. Code:
`games/outbreak/src/map/`. Proof: `games/outbreak/scripts/map-proof.ts`. Lab station: `outbreak-map`.

## What it shows

- Only explored ground. Unexplored areas stay blank paper with the survey grid; the edge of what you've seen is
  softened by about half a metre.
- Roads with kerbs and centre lines, trees, parked cars and fences, each district tinted, and every building you've
  seen from outside or inside, outlined in full (a building counts as seen once three metres of ground touching it
  have been explored).
- POI badges: hardware, pharmacy, grocery, diner, gas station, police, clinic, church, warehouse and ranger cabin.
  Houses with a workbench and stash are safehouses, drawn in amber with a house-and-bench badge; they always win a
  crowded spot. Names appear under badges from 2.4 px/m where they fit.
- District names for each 96 m block (stable per seed; the start block is Ash & Elm) with the district type under
  them, placed around the badges.
- You and your teammates as arrows in seat colours, pointing where each survivor faces. Anyone off the sheet is
  pinned to its edge, pointing the way.
- Pings in the pinging survivor's colour, for as long as the ping lasts.
- Last-known zombie groups. Zombies are recorded into 8 m cells only while you can see them; a cell is cleared when
  you look at it again and it's empty, and forgotten after Map › Horde memory (240 s). Neighbouring cells merge into
  one group. Groups of five or more are dashed red circles with the count and "seen 2 min ago"; smaller sightings
  are small crosses, shown only from 3 px/m.
- Marks: click the sheet to place a lettered pin, click a pin (or right-click near it) to clear it. Marks are kept in
  local storage per seed, house seed and world mode.
- Vehicles from the sim (`CoopSim.vehicles`) at their current position and heading, wherever that ground has been
  explored; wrecks are drawn grey.

Two looks: Survey paper (default) and Noir survey (Lab › Map › Map look).

## Input

| Action | Input |
| --- | --- |
| Open / close | `KeyN` (`Escape` also closes) |
| Pan | Drag, or two-finger swipe on a trackpad. The sheet moves with the fingers in the system's scroll direction |
| Zoom | Trackpad pinch (ctrl+wheel), mouse wheel, `+` / `−` keys, or the buttons; zoom keeps the point under the cursor |
| Centre on you | The ◎ button |
| Mark | Click; click a mark to clear it |

A mouse wheel is told apart from a trackpad swipe by its deltas: line or page deltas, or whole steps of 50 px or more
with no sideways part, zoom; smaller pixel deltas pan. In the Lab, a station embedding the game leaves N to the page
(`<html data-page-keys="KeyN">`), so it opens the map rather than starting a voice note.

## On-screen helpers (off by default)

Kit chose the Diegetic HUD, so nothing map-related is on screen by default. Lab › Map › On-screen map offers:

- **Compass ring**: a thin ring on the ground around the survivor, projected through the game camera like the
  Diegetic ground meters, with N and bearings to marks (with distance), pings (with distance), teammates, safehouses
  and one of each known POI kind within 160 m. Radius 2.4 m, opacity 0.7.
- **Corner minimap**: a north-up circle in the top-right corner drawn from the same tiles, redrawn when you move more
  than a pixel or every 250 ms.

## How it scales

- `MapMemory` keeps exploration per 32 m chunk at 1 m cells (1 KB per chunk), copied from `Vision`'s 0.5 m window
  (2 × 2 max-pool) at most every 200 ms, and only for the chunks your sight range can reach. When the streaming
  window moves it also reads the tiles `Vision` saved for the chunks that left, so nothing seen in the last 200 ms is
  lost. `Vision` itself only remembers 64 chunks; the map remembers every chunk you explored.
- With each newly explored chunk it stores a compact copy of the layout (building footprints, POI kind, trees,
  roads, cars, fences) from the streamer's active chunk, or regenerates it from `(seed, cx, cy)`.
- `MapTiles` is a tile pyramid: levels from 16 down to 1/16 device px per metre, halving each step, one chunk per
  tile at the fine levels and up to 64 × 64 chunks at the coarsest, never more than 512 px square. A tile is built
  from chunk data (ground, then the soft explored mask with `destination-in`, then known buildings on top) only if a
  chunk inside it has been explored. When a chunk changes, the tiles holding it and its neighbours are marked stale
  and rebuilt the next time they are on screen, within 3 ms a frame; a stale tile, or a coarser level scaled up,
  stands in until then. Tiles live in a 96 MB LRU.
- While the sheet is closed the map prebuilds the stale tiles the sheet would open on, at most 0.6 ms every 120 ms,
  so opening it finds them ready.
- The sheet has two canvases at device resolution (DPR capped at 2): a base layer (paper, grid, tiles, labels and
  badges) redrawn only when the view or the data changes, and a moving layer (people, pings, hordes, marks) redrawn
  at up to 30 Hz. Text and badges are drawn in screen space, never scaled from a tile.

## Measured

`map-proof.ts` on headless Metal (Studio) at 1280 × 800, DPR 2, seed 7, peaceful: a scripted 1 km sprinting loop
east along the start street through the commercial, civic and industrial blocks, north, west and back (12,082 fixed
steps). Timer resolution is 0.1 ms.

- Explored 65 chunks, 39 known POIs and 41 known buildings; the map holds 65 KB of cells and 32 MB of tiles.
- Map update with the sheet closed (observe, sightings, prewarm): p50 0.0 ms, p95 0.3 ms, max 2.1 ms.
- Opening the sheet: prewarm had built all but 10 of the tiles it needed, which took 2.2 ms in total (each under
  1.2 ms). The first base draw took 11 ms, most of it the first upload of each cached tile; later base redraws
  after a pan or zoom are cheaper. With the sheet open the map's update was p50 0.4 ms, p95 0.7 ms, max 13.8 ms.
- Walking the same street with the sheet open against closed, four alternating pairs: game step p50 15.1 against
  14.1, 14.6 against 20.7, 18.9 against 14.4 and 14.6 against 13.6 ms. The differences go both ways and are within
  the run-to-run spread of a shared headless worker; the map's own update in those runs was p95 0.5 to 2.1 ms open
  and 0.1 to 0.7 ms closed.
- Real time (no `bench`): with the sheet open the simulation advanced 0.9 s in 0.9 s, and holding W moved the
  survivor 3 m.
- Input: a pinch zooms about the cursor (the world point under it stays within 0.01 m), a two-finger swipe up and
  left moves the sheet up and left with the fingers, a click places a mark and a second click on it clears it.

Captures: `captures/outbreak-map/` (survey, close-up, overview, noir, horde, co-op, compass ring, minimap, real time).

## Known gaps

- Exploration is per player; teammates' explored ground isn't shared, though their positions and pings are.
- Marks are local: they aren't sent to teammates (a shared mark would need a wire field, like pings).
- The sheet doesn't pause single-player either. Zomboid pauses its map offline; Outbreak keeps one rule for both.
- No interior room layouts: buildings are footprints.
