# timber

- Style: **realistic**. Visual work follows [quality-checklist.md](../../docs/quality-checklist.md),
  [realistic.md](../../docs/realistic.md) and the `arcade-quality` skill. The look is BARBARA's night forest: dark
  stays dark between the beams, no milky wash, fog only where a lamp lights it. It is a horror game: near black past
  your light, a crescent moon (`skyMoon: "crescent"`, `darkAdapt` 0.3, `moonMist` 0.15, `mistDensity` 0.11), and
  mist only where a beam crosses it (in `TimberView.create`).
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
  fall and settle (with a faint haze of fine dust and lit specks), 2-stroke exhaust that thickens on rev (`thin` scales
  it for a motor by the lens), hinge splinters, branch
  snaps (on landing and when a crown rakes a standing tree, the `brush` event), a dust ring scaled by mass,
  chain-on-chain sparks, and dark blood mist and drops (droplets and streaks). The game's chips (`src/debris.ts`) are
  flat, irregular pale flakes and slivers with a bark-dark side that tumble as they fly. Particles are lit only by `TimberLights.particles` (point
  lights with plan cones at each beam and lamp, `fxLight`/`fxLightReach`), so exhaust and dust show only where a beam
  crosses them. The game adds a crack-snap-groan sound sequence, a crown whoosh, landing shake (`landingShake`),
  slow-mo on a crush or a domino of 3+ (`slowMoTime`/`slowMoScale`) and chain kickback on the camera (`sawKick`).
- Fall hint (`fallHint`, 0 off): while you cut, a faint line of pale dots on the ground along the fall line, opaque
  and dimmed through their tint, lit only by the lamps.
- Blood: dark wet pools (four `poolMesh` variants) that grow over ~3.5 s, merge when close, max 60; the downed drip a
  new one every 0.9 s (`bloodPool`, `bloodDrops`). Getting hurt is a red vignette from `cam.damageFlash`.
- People (`src/people-view.ts`, `TimberPeople`): Microsoft Rocketbox avatars on the kit people rig, as in BARBARA. The
  lumberjack is m05 repainted (`public/people/lumberjack.glb`, made by `scripts/lumberjack.ts` → `lumberjack.py`: a
  red and black buffalo-check flannel shirt under a black canvas vest, dark work trousers and boots; tints can't do
  this, since a Rocketbox outfit is one texture), grown by `jackScale` (1.12), both hands on the saw (`SAW_HANDS`
  through `People.drive`'s `reach`, each within 95% of the rig's arm, past which the reach eases and the left hand
  stops short of the wrap handle); survivors are the other cast members with the torch in the right hand (the beam
  starts at the torch in it) and the axe in the left, swung while chopping. The downed and the dead are the game's
  ragdolls posed onto the person (`lie`), so a crush pins the body under the trunk. The downed crawl face down on their
  forearms (`src/downed.ts`, `crawl*` knobs), and their torch drops and keeps shining along the ground: a ground
  `ForestTorch` (`800 + id`, `droppedTorch`) with little of its beam in the mist (`droppedAir`, kit `ForestTorch.air`)
  and no spot shadow (`shadows: false`), since lying in the ground mist it washed the frame grey. The saw, axe and torch models are drawn at the `Held` frames. The blocky shared rig draws anyone still
  loading, the `?smoke` run, and everyone with `realPeople` 0.
- Lighting (BARBARA's look: physical sky, dark adaptation, highlight shoulder): survivors carry
  `ForestTorch` beams (`torchLevel`; only the player's own can be `local`). The lumberjack's helmet lamp (`sawLight`)
  is wired to the saw and dies with the engine. It sits at 1.72 m × `jackScale`, dim (`torchPower` 85, a 12° cone,
  `torchSpill` 0.02), eases towards the kerf while he cuts, and watches
  the falling tree's mid-trunk for `fellCamTime` after a `fell` (the `lamps` map). It is on the helmet, not the saw,
  because a lamp 0.4 m from the bark floods the frame. Your own, in first person, can shine from `sawLampAhead` down its
  axis (its level makes up the shorter throw; off by default: at 0.8 m it lit the mist in front of the lens and lifted
  the black between the beams grey), with `sawFill` standing in for its spill on your hands; your saw takes it from the
  helmet whatever `sawLampAhead` is, as if no nearer than `sawLampNear` (in the beam's core, 50× its spill, it blew out at any albedo). Each pull of the cord flickers it (the
  magneto). While it watches a falling trunk its beam shows little in the mist (`fellLampAir`): pointed up
  through it, along the low felling view, it washed the frame grey. Flares come through `view.lights`; the truck's lamps are
  torches 900/901 plus a glow (`truckLamps`). Veiling glare is TIMBER's own (`glare` 0.1, written into the forest
  settings): at the forest's default 0.5 the lamp spot on the ground a metre ahead lifts the whole frame grey.
- Camera: default `viewStyle: "auto"`, Dead by Daylight's split (`resolvedView()`): you as the lumberjack are in
  first person, saw in hand; you as a survivor get a tight over-the-shoulder view with a narrow FOV (`shoulder*`
  knobs); once you're out and spectating, the low chase. `"first"`, `"chase"`, `"shoulder"`, `"iso"` and `"top"` stay
  on the Camera knob. First person still runs `cam.follow`/`update` for the shake, then overrides `cam.eye` and
  `cam.viewProj` (`mat4.lookAt`, near 0.05): shake becomes a small yaw/pitch jitter plus the saw's buzz (`sawBuzz`,
  harder revving and in wood), the eye is `firstEye` × `jackScale` plus head bob, and mouse Y pitches the view (locked;
  unlocked it eases to `firstPitch`, or down into the cut). Your own body isn't drawn; the viewmodel is (see below),
  and while the bar bites wood, chips fly from under the bar at the lens (`WoodFx.toward`). Click locks the pointer for mouse look (first,
  chase, shoulder); bots, automation and spectating ease the yaw towards the aim. The chase (`chase*` knobs) is low,
  over the right shoulder, pulled in at trunks. The felling cam (`fellCam*`): when a tree you drop (or one within
  22 m) goes over, the view drops to a low eye (`fellCamHeight`) up to `fellCamDist` off your shoulder, on the bearing
  with the clearest view between the trunks, looking a third of the way up the trunk; from chase or shoulder it blends
  in over 0.6 s and out over 0.7 s, from first person it cuts. It holds for `fellCamTime`.
- First-person saw (`src/viewmodel.ts` `SawView`, shader in `src/viewmodel-shader.ts`, knobs under "First-person
  saw"): `public/saw/saw.glb`, a CC BY photogrammetry scan's powerhead (credited in `CREDITS.md`, built by
  `scripts/saw/build-saw.ts` → `build-saw.py` in headless Blender) with a made 18" bar, 66-link chain (the vertex
  shader runs it round the bar, speed ∝ throttle, smearing when fast), T-grip and cord, worn tan leather work gloves
  (creases, grime, oil-dark palms, a stitched gauntlet cuff: baked by `build-saw.py`'s `leather()` and packed under the
  bar in its three maps, so they bind nothing more) and flannel sleeves. The chain has no maps (a palette by UV cell;
  `sawWear` adds its flecks). LOD0 31.7k tris, 2k WebP maps, indexed; LOD1 4.6k tris, vertex coloured, is the lumberjack's saw in third person
  (`sawWorldMesh`, held at `SAW_HANDS`/`SAW_PITCH` in `people-view.ts`). It is a kit `OverlayPass` with its own lens
  (`sawFov`) and near plane, drawn after TAA and motion blur (onto their output, so it never clips trees, never smears
  and never feeds the exposure meter), cropped to its parts' box on screen: there 1× straight onto the scene with a scissor
  (`sawView.msaa` 1, the default), or 4× MSAA in a box-sized target, resolved and copied over (`msaa` 4). On the mini
  (High, 720p, idle first person, Oct 24) it costs ~0.3 ms at 1× and ~1.2 ms at 4× (it was 2.6 ms full-screen at 4×
  before the crop, the light early-outs and the baked gloves); the edges barely differ.
  Back faces culled, gloves and sleeves drawn first. Lit by the scene's own lights (the same count clamp and range
  early-outs as the forest's) (lamps held at least `sawLampNear` away, or the helmet lamp 0.5 m above floods it) plus torch spill and
  sky. Only six maps are bound: the forest's group 0 already uses ten of the stage's sixteen textures. It vibrates
  (finer at idle, harsher revved and in wood), kicks on rev, start, clash and hits, the left hand pulls the cord on a
  start, it lags the look, pushes into the trunk, lunges, and drops to a carry at a sprint. Exhaust comes from its
  muffler, oil mist off the nose, sparks on a clash (`SawPoints`).
- Running: a sprint eases `sprintK` in, which widens the FOV (`sprintFov`), scales the kit `MotionBlur` strength
  (`sprintBlur`, knobs under "Motion") and adds a small radial `MotionBlurBurst` each frame; head bob follows the
  stride (`headBob`). Bursts also come on a lunge, saw contact and tree impacts. A tree landing within 9 m of its trunk
  line makes you stumble (`stumble`). All of it is off with reduced motion.
- Juice (`contact()` within 3 m of the camera): hit-stop, an FOV punch (`fovPunch`), a blur burst and blood on the
  lens (`Dread.splash`, uneven spatters that run and dry over `lensDry`, at most one every 0.25 s). Slow-mo on an
  execution (`executeSlowMo`) as well as a crush or a domino of 3+; the pull cord kicks the view (`pullKick`); the big
  `tree-crack` before a tree goes, then the groan.
- Fear (`src/dread.ts`, `Dread`): within `fearRange` (15 m) of the lumberjack, survivors' torches flicker
  (`torchFlicker`, each by their own distance), the heartbeat speeds up, breathing gets heavier, and the vignette
  (`fearVignette`, written into the forest's lens vignette) and desaturation (`fearDesat`) grow. When his engine
  dies near a hunted survivor, the cut-out recording plays, then everything goes quiet for `hushTime` (the truck,
  footsteps and breath duck; the heartbeat is louder), the vignette spikes and the HUD says "His saw cut out."
- Sound (`src/sounds.ts`, `TimberSound`): CC0 recordings in `public/sfx/` (credited in `CREDITS.md`, with URL,
  licence and SHA-256 in `public/sfx/sources.json`; `scripts/sounds.ts` fetches, verifies and cuts them). The engine
  is three crossfaded loops (`saw-idle`, `saw-rev`, `saw-cut`) per lumberjack, placed in 3D (pan, distance, a
  low-pass behind trunks) with reverb through the trees; plus `saw-start`, `saw-pull`, `saw-flood`, `saw-cutout`,
  `tree-creak`, `tree-crack`, `tree-groan`, `tree-crash`, footsteps, breath and heart. `shared/sfx.ts` lists the
  library cues still used (the truck, hits, gore, pickups).
- GPU (mini, Metal, 1280×720 headless, High, Oct 23, `bun scripts/proof.ts --perf`): ferns halved (`fernDensity`
  0.5): sawing 30→21–27 ms, hunt 38→19–21 ms, the chase lane ~36–38 ms either way. `--sweep` switches one cost off at a
  time in the chase lane: the tree templates are nearly all of it (off: 2.4 ms; far LOD everywhere: ~23 ms); ferns,
  shadows, mist, motion blur and people are each within the run-to-run noise (±5 ms when the mini is shared). Not yet
  under the 17 ms target; next is a nearer tree LOD (`ForestQuality.near`) or cheaper near trees in the kit.
  Auto quality steps down from High on slow frames.

## Controls

WASD move, mouse look (click to lock; mouse Y pitches the first-person view), Shift sprint, hold Mouse0 saw/axe, Space
lunge (revved), Q engine, F torch, G flare, hold E revive/shove, R new round. All by `KeyboardEvent.code`; prompts use
`keyPromptHtml`.

## Game shell

- Title, Escape menu and Settings (volume, mute on M, quality) are the kit shell, set up in `src/main.ts`. No
  pointer lock from the shell; the first-person, chase and shoulder views ask for it on a canvas click. Escape releases the lock before the
  shell sees the key, so losing the lock mid-play pauses; pausing exits the lock. Leave starts a new round. The
  engine, breath, truck and heartbeat loops only sound in play.

## Automation

- `window.timber`: `world`, `feel`, `look` (the Lab settings: `FEEL`, `LOOK`, camera shake and wood knobs), `wood`
  (the `WoodFx`), `view` (the `TimberView`; `view.forest` is the kit `ForestView`, with `stats()` and `debug`),
  `measure(n)` (whole-frame GPU ms), `auto.input` (drive the player with a `JackInput`), `auto.camera`
  (`{ x, y, dist, pitch, yaw?, height?, fov? }`), `stage("fell" | "domino" | "saw" | "hunt" | "chase" | "flee" |
  "kill")` (fixed proof scenes; `hunt` and `flee` make you a survivor, the rest the lumberjack. `chase` is a lane with
  a half-cut tree and a fleeing bot survivor with no flares; `flee` is you running down an L-shaped lane with your
  torch on and a fast, aggressive bot lumberjack behind; `kill` is first person: a survivor with his back to you and a
  half-cut tree beyond him), `blur` (motion blur settings), `people` (`TimberPeople`), `peopleReady()` (resolves once
  the Rocketbox cast has loaded), `dread`, `sound` (`TimberSound`), `style` (the resolved view), `paused`,
  `newRound()`, `frames`, `sawView` (`enabled` hides the saw, `msaa` 4 or 1). `?seed=N` fixes the forest; `?quality=high` pins quality (Auto
  steps down mid-run on a slow worker); `?smoke` is the software-GPU smoke (low, Today sky, offscreen).
- Proof captures: `hivemind run --kind browser --worker mini -- sh -c 'bunx vite build && bun scripts/proof.ts'`
  writes `flee.webm` (a survivor fleeing him in the dark), `kill.webm` (a first-person saw kill, then a tree drop) and
  a still to `captures/proof/`. `--stills` takes only look stills of flee, kill and fell plus the hunt (fast);
  `--saw` takes the chainsaw's stills (dark, torch, close, third person), the pull-start clip (stage `pull`: engine off
  at a trunk, a survivor's torch nearby) and its GPU cost (shown at 4× and 1× MSAA vs hidden); `--perf` measures GPU ms per scene at both fern densities; `--sweep` turns costs off one at a time in the chase lane.
  Studio has no Playwright ffmpeg, so video runs need the mini.
- `bun run check` (typecheck, tests, build). Tests run through HiveMind: `hivemind run --kind cargo -- bun run test`.

## Next phase

1. Frame time: the near trees are the cost (see GPU above).
2. Multiplayer rooms on the kit room code (`net/room-core`, `net/room-socket`); the sim is already deterministic.
