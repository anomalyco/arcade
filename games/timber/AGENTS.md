# timber

- Style: **toy prototype** (greybox: prism trunks, stacked-cone crowns, flat ground, night lighting). Visual work
  follows [quality-checklist.md](../../docs/quality-checklist.md) only once the game moves to the realistic phase below.
- Unlisted prototype, 1-vs-all in a packed 52×52 m night forest (`mode: "hunt"`, the default). One **lumberjack**
  with a chainsaw hunts three **survivors** (`survivorCount`) with axes, torches and two flares each. Survivors win by
  carrying the fuel can, spark plug and keys to the logging truck and reaching it once it runs, or by killing him with
  trees. He wins by downing and finishing them all before the clock (`roundTime`, 5 min) runs out. The title's
  `titleSlot` picks the side (`playAs`); bots fill the other seats. `mode: "ffa"` is the v1 chainsaw brawl
  (`botCount` bots, last one standing).
- Lumberjack: a fast saw (`cutTime`), so the clear-cut grows and the woods thin out like a closing circle. The engine
  is loud: survivors hear it within `hearRange` (more when revved) and get a direction ping. Q kills it to sneak. A
  pull-cord restart takes `pullTime`; each pull adds `pullFlood`, and failures get likelier past `floodSafe`. At full
  flood it locks for `floodLock`. Fuel burns while running (`revBurn`× when revved); gas cans refill it. He lunges
  only when revved. Sawing a survivor holds contact with hit-stop and blood and downs him (`downTime` to bleed out);
  a short hold (`executeTime`) on someone downed finishes them. The first tree on him pins him (`pinTime`, engine
  stalls); a crush while pinned, or `treeHitsToKill` trees, kills him.
- Survivors: a stamina sprint (`staminaMax`), a torch (F) and flares (G) that blind him within `flareBlindRange`.
  The axe fells slowly (`axeCutTime`). E (held) revives the downed (`reviveTime`) or shoves over a tree cut past
  `pushAt`. Bots (`shared/bots.ts`, `thinkSurvivor`) gather parts, hide, flee the saw sound, revive, throw flares up
  close and sometimes shove a tree onto him. `thinkHunter` listens, chases torches and cuts trees onto survivors.
- `shared/trees.ts` is the felling maths: the cut vector (`cdx`/`cdy`) picks the fall direction (away from the side
  it was cut from), a creak and lean past `warnAt`, then a rigid-rod fall over a hinge (θ'' = (3g/2L)·sinθ, slow
  start, fast end), one bounce, crush sweep (trunk and crown below body height) and dominoes (a struck tree cut past
  `dominoThreshold` falls the same way and carries `chain` depth; anything less only slows the faller). Fallen trunks
  stay as logs.
- `shared/sim.ts` is the deterministic world with every feel constant in `FEEL` / `FEEL_CONTROLS`, on the LabPanel
  (Backquote). Each tick everyone moves, then every blade picks its target (`aimSaw`), then they cut (`stepSaw`), so
  two saws meeting clash with sparks instead of cutting. `src/main.ts` draws it, turns events into fx and sound, and
  runs the HUD.
- Effects: kit `fx/wood.ts` (`WoodFx`, knobs under "Wood fx", `wood*` keys) gives kerf chips and sawdust that bounce
  and settle, 2-stroke exhaust that thickens on rev, hinge splinters, branch snaps (on landing and when a crown rakes
  a standing tree, the `brush` event), a dust ring scaled by mass, chain-on-chain sparks and blood mist. The game
  adds the kerf slit and face notch, jagged stumps and butt fibres, a crack-snap-groan sound sequence, a crown whoosh,
  slow-mo on a crush or a domino of 3+ (`slowMoTime`/`slowMoScale`) and chain kickback on the camera (`sawKick`).
- The shared human rig holds a chainsaw (or an axe) in the rifle's place (`parts.gun.rifle`). Blood is the kit
  splatter on a flat ground surface. The downed and the dead are ragdolls; the downed are dragged along as they crawl.
- Lighting: `night` blends to a dim blue moon. Torches, his headlamp, flares (kit `FlareFx`) and the truck's lamps do
  the rest (`torchPower`, `torchRange`). Sprites are unlit, so ground markings dim with the night.
- Camera: default `viewStyle: "iso"` (high chase, shows fall lines); `"shoulder"` (mouse look, click for pointer
  lock) and `"top"` are the alternatives on the Camera knob. Crowns (and standing trunks on the camera side) in a
  ground capsule from you towards the camera fade out (`canopyCut`, `canopyAlpha`); faded parts draw through separate
  models so opaque batches stay opaque.
- Sound stand-ins (`shared/sfx.ts`): the library has no chainsaw, so `generator.loop` pitched by revs is the engine
  and `door.pry.loop` the bar biting wood; `vehicle.boat.engine` is the truck. Replace them when real samples land in
  `packages/kit/audio`.

## Controls

WASD move, Shift sprint, hold Mouse0 saw/axe, Space lunge (revved), Q engine, F torch, G flare, hold E revive/shove,
R new round. All by `KeyboardEvent.code`; prompts use `keyPromptHtml`.

## Game shell

- Title, Escape menu and Settings (volume, mute on M, quality) are the kit shell, set up in `src/main.ts`. No
  pointer lock from the shell; the shoulder view asks for it on a canvas click. Escape releases the lock before the
  shell sees the key, so losing the lock mid-play pauses; pausing exits the lock. Leave starts a new round. The
  engine, bite, truck and heartbeat loops only sound in play.

## Automation

- `window.timber`: `world`, `feel`, `wood` (the `WoodFx`), `auto.input` (drive the player with a `JackInput`),
  `auto.camera` (`{ x, y, dist, pitch }`), `stage("fell" | "domino" | "saw" | "hunt")` (fixed proof scenes; all but
  `hunt` make you the lumberjack, with survivor dummies), `paused`, `newRound()`, `frames`. `?seed=N` fixes the
  forest.
- Proof captures: `hivemind run --kind browser -- sh -c 'bunx vite build && bun scripts/proof.ts'` writes
  `fell.webm`, `domino.webm`, saw stills and a hunt still to `captures/proof/`. Studio has no Playwright ffmpeg, so
  video runs need a worker that has it (mini).
- `bun run check` (typecheck, tests, build). Tests run through HiveMind: `hivemind run --kind cargo -- bun run test`.

## Next phase

1. Realistic night forest: swap the greybox for the kit forest trees (`packages/kit/forest`, with BARBARA's look in
   `games/barbara/src/world-view.ts`) and real felling (cut geometry, bark and wood, a falling crown that breaks
   branches), following [realistic.md](../../docs/realistic.md). This is the very next step.
2. A real chainsaw sample (idle, rev, bite, pull-cord) to replace the stand-ins.
3. Multiplayer rooms on the kit room code (`net/room-core`, `net/room-socket`); the sim is already deterministic.
