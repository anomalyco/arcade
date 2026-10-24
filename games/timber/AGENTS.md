# timber

- Style: **realistic**. Visual work follows [quality-checklist.md](../../docs/quality-checklist.md),
  [realistic.md](../../docs/realistic.md) and the `arcade-quality` skill. The look is BARBARA's night forest: dark
  stays dark between the beams, no milky wash, fog only where a lamp lights it. The people are still the blocky shared
  rig (Rocketbox is next, below).
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
  two saws meeting clash with sparks instead of cutting. `src/main.ts` turns events into fx and sound, runs the camera,
  lights and HUD; `src/look.ts` (`LOOK` / `LOOK_CONTROLS`) holds every presentation knob (camera, felling look,
  lights, gore), which the sim never reads.
- World: `src/world-view.ts` `TimberView` draws the kit forest (`createForestView`, `packages/kit/forest`).
  `toForestWorld` turns the sim's trees into spruce (pine where a hash < 0.22), trunk radius ×1.2 and height plus
  `HINGE`, lines the edge with deadfall logs, scatters 16 rocks outside, and clears the arena, truck and parts
  (`ForestClearing.ferns: true` keeps the ferns and litter, clearing only saplings and stumps, since the game owns the
  solids). Felling poses the real tree: `ForestView.poseTrees` (kit `forest/posed.ts`: the tree splits at the cut into
  a stump and a log that rotates over the hinge, with crown lag, flutter, whip and thrash on landing, branches clamped
  above the ground; a tree left out stands again) and `cutRadius` for the kerf. The game adds the kerf slit, face
  notch, stump cap and butt fibres on top.
- **Never draw a translucent kit part (alpha < 1) in TIMBER.** Inside the forest pass one blows the whole frame out
  milky white (this was the sawing whiteout). Fade with scale or a dimmer tint on an opaque part instead (the fall
  hint does this).
- Effects: kit `fx/wood.ts` (`WoodFx`, knobs under "Wood fx", `wood*` keys) gives kerf chips and sawdust flecks that
  fall and settle (with a faint haze of fine dust), 2-stroke exhaust that thickens on rev, hinge splinters, branch
  snaps (on landing and when a crown rakes a standing tree, the `brush` event), a dust ring scaled by mass,
  chain-on-chain sparks, and dark blood mist and drops. Particles are lit only by `TimberLights.particles` (point
  lights with plan cones at each beam and lamp, `fxLight`/`fxLightReach`), so exhaust and dust show only where a beam
  crosses them. The game adds a crack-snap-groan sound sequence, a crown whoosh, landing shake (`landingShake`),
  slow-mo on a crush or a domino of 3+ (`slowMoTime`/`slowMoScale`) and chain kickback on the camera (`sawKick`).
- Fall hint (`fallHint`, 0 off): while you cut, a faint line of pale dots on the ground along the fall line, opaque
  and dimmed through their tint, lit only by the lamps.
- Blood: dark wet pools (four `poolMesh` variants) that grow over ~3.5 s, merge when close, max 60; the downed drip a
  new one every 0.9 s (`bloodPool`, `bloodDrops`). Getting hurt is a red vignette from `cam.damageFlash`.
- The shared human rig holds a chainsaw (or an axe) in the rifle's place (`parts.gun.rifle`). The downed and the
  dead are ragdolls; the downed are dragged along as they crawl.
- Lighting (BARBARA's look: physical sky, full moon, dark adaptation, highlight shoulder): survivors carry
  `ForestTorch` beams (`torchLevel`; only the player's own can be `local`). The lumberjack's helmet lamp (`sawLight`)
  is wired to the saw and dies with the engine. It sits at 1.72 m, eases towards the kerf while he cuts, and watches
  the falling tree's mid-trunk for `fellCamTime` after a `fell` (the `lamps` map). It is on the helmet, not the saw,
  because a lamp 0.4 m from the bark floods the frame. Flares come through `view.lights`; the truck's lamps are
  torches 900/901 plus a glow (`truckLamps`). Veiling glare is TIMBER's own (`glare` 0.1, written into the forest
  settings): at the forest's default 0.5 the lamp spot on the ground a metre ahead lifts the whole frame grey.
- Camera: default `viewStyle: "chase"`, a low third-person chase (`chase*` knobs: pitch, distance, look height, FOV,
  look-ahead, `chaseSide` over the right shoulder, turn rate, pull in at trunks), so trunks fall side-on and the saw
  fight is close. Click locks the pointer for mouse look (chase and shoulder); bots, automation and spectating ease
  the yaw towards the aim. The felling cam (`fellCam*`): when a tree you drop (or one within 22 m) goes over, the view
  drops to a low eye (`fellCamHeight`) up to `fellCamDist` off your shoulder, on the bearing (45–100° off the
  reverse fall line) with the clearest view between the trunks. It looks a third of the way up the trunk as it falls,
  blends in over 0.6 s and out over 0.7 s, and holds for `fellCamTime`. `"iso"`, `"shoulder"` and `"top"` are
  alternatives on the Camera knob.
- GPU (mini, Metal, 1280×720 headless, High, Oct 23): ~28 ms sawing up close, ~23 ms hunt, 24–38 ms in the chase
  lane. Ferns are the biggest single cost (about 10 ms of the sawing frame); `fernDensity` 0.5–0.6 saves 3–12 ms.
  Auto quality steps down from High on slow frames.
- Sound stand-ins (`shared/sfx.ts`): the library has no chainsaw, so `generator.loop` pitched by revs is the engine
  and `door.pry.loop` the bar biting wood; `vehicle.boat.engine` is the truck. Replace them when real samples land in
  `packages/kit/audio`.

## Controls

WASD move, Shift sprint, hold Mouse0 saw/axe, Space lunge (revved), Q engine, F torch, G flare, hold E revive/shove,
R new round. All by `KeyboardEvent.code`; prompts use `keyPromptHtml`.

## Game shell

- Title, Escape menu and Settings (volume, mute on M, quality) are the kit shell, set up in `src/main.ts`. No
  pointer lock from the shell; the chase and shoulder views ask for it on a canvas click. Escape releases the lock before the
  shell sees the key, so losing the lock mid-play pauses; pausing exits the lock. Leave starts a new round. The
  engine, bite, truck and heartbeat loops only sound in play.

## Automation

- `window.timber`: `world`, `feel`, `look` (the Lab settings: `FEEL`, `LOOK`, camera shake and wood knobs), `wood`
  (the `WoodFx`), `view` (the `TimberView`; `view.forest` is the kit `ForestView`, with `stats()` and `debug`),
  `measure(n)` (whole-frame GPU ms), `auto.input` (drive the player with a `JackInput`), `auto.camera`
  (`{ x, y, dist, pitch, yaw?, height?, fov? }`), `stage("fell" | "domino" | "saw" | "hunt" | "chase")` (fixed proof
  scenes; all but `hunt` make you the lumberjack. `chase` is a lane with a half-cut tree and a fleeing bot survivor
  with no flares), `paused`, `newRound()`, `frames`. `?seed=N` fixes the forest; `?quality=high` pins quality (Auto
  steps down mid-run on a slow worker); `?smoke` is the software-GPU smoke (low, Today sky, offscreen).
- Proof captures: `hivemind run --kind browser --worker mini -- sh -c 'bunx vite build && bun scripts/proof.ts'`
  writes `fell.webm` (a felling up close), `chase.webm` (running a survivor down and dropping a tree after them) and
  a still to `captures/proof/`. `--stills` takes only look stills of both scenes and the hunt (fast). Studio has no
  Playwright ffmpeg, so video runs need the mini.
- `bun run check` (typecheck, tests, build). Tests run through HiveMind: `hivemind run --kind cargo -- bun run test`.

## Next phase

1. Rocketbox people like BARBARA's (`games/barbara/src/people-view.ts` over `@arcade/kit/people`). It needs a
   two-handed chainsaw and axe grip in the kit's `People.drive` (it knows torch carry and hand grips today) and
   ragdolls for the downed and dead on the people rig.
2. A real chainsaw sample (idle, rev, bite, pull-cord, CC0 or CC BY, credited) to replace the stand-ins.
3. Multiplayer rooms on the kit room code (`net/room-core`, `net/room-socket`); the sim is already deterministic.
