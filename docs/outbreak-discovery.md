# Outbreak: Discovered, Not Told

D-19 option 2 (AR-29). Kit's rule: state is read from the world, not labels; you discover things and learn over time;
the fewer words the better. The design is `~/code/home/artifacts/2026-10-15-survival-loop/design.md`.

Code: `shared/discovery/` (simulation, deterministic) and `src/discovery/` (presentation), registered as the
`discovery` client feature. Lab: Backquote › **Discovery**, and the `outbreak-discovery` station
(`games/lab/src/stations/outbreak-discovery.ts`), which stages scenes with the `discovery.stage` command.

## Slice 1: diegetic state, labels removed

| Was | Now | Where |
| --- | --- | --- |
| Battery ring, "Battery low", "Battery dead" | Below the flicker threshold the beam narrows (25%), shortens (30%) and warms to amber on top of the sim's dimming and sputter | `src/discovery/flashlight.ts`, applied in `main.ts` for the local beam, vision cone and lighting pack |
| "New material: Scrap. Bench recipes: …" on first pickup | Nothing. The material is still noted (`seen:*` in `team/known`) | `shared/progression.ts` |
| Belt pills always on screen | Belt counts show only while the pack (Tab) or the recipe panel (C) is open. Since the HUD polish (#141) the dock owns this: always there, dimmed when idle (`src/hud/dock.ts`) | `src/hud/dock.ts` |
| Barricades flat at any health | Boards bow inward and split at half health and hang from one nail near the end; damage comes off the last board nailed | `shared/discovery/barricade.ts`, `src/discovery/barricades.ts` |
| Container strip `[1] 9mm ×6 …` | A searched container stays open (dresser drawer pulled out, cabinet and fridge doors swung wide, shelf top) with what is left inside as small props; the prompt is a bare key cap | `src/discovery/props.ts`, `src/discovery/items.ts` |
| Drop and noisemaker labels | Drops lie on the floor as props; a thrown noisemaker rattles where it landed | `src/discovery/props.ts` |
| Prompt verbs forever | A kind of prompt (door, window, container…) loses its words after three uses in this browser, leaving the key cap | `InventoryHud.noteUse`, `localStorage["arcade.outbreak.familiar"]` |

The battery and flashlight callouts are dropped by the Diegetic HUD style's `worldState` flag; other HUD styles keep
them. Pings keep their labels: they are how teammates talk.

### Barricade wear

Wear is the barricade's hit points over a nominal 100 per plank, clamped to 1, so reinforced boards (180) stay flush
until they have lost more than the extra. Each board's health is `clamp(wear × planks − index)`, first nailed first:
above 0.5 flush, above 0.2 bowed (two halves meeting in a V pushed into the room), otherwise hanging from the nail
that held (which end is fixed per board). On the wire the plank count byte carries six bits of wear
(`packPlanks`); full snapshots send it with the portals and every bash entry carries it, so boards bow on every
client the moment they are hit. The AI's portal state already snapshots and restores; nothing new joins `SimState`.

### Proof

- `tests/discovery.test.ts`: board looks by wear, the wire byte, co-op wear after a bash and on a full snapshot,
  wear through `toSnapshot`/`fromSnapshot`, the low beam, container layouts.
- `scripts/discovery-proof.ts` (via `hivemind run --kind browser --fetch captures/outbreak-discovery`): stills of
  the beam at full and 12%, boards at three wears, opened containers, drops, and the dock dim until Tab.

## Slice 2: the recipe board and the corkboard

Superseded on 2026-10-18 by D-39 (Recipe Board), after Kit found blind pair-tinkering inscrutable. The mat and its
pairs, clatters and crossed-out tries are gone; what the squad finds out still goes up on the corkboard. How crafting
works now is in `docs/outbreak-progression.md#how-crafting-works`.

- **Filling in** (`shared/discovery/recipes.ts`, `recipe-board.ts`): each recipe has a sketch of two materials and,
  for some, a bench part. Once every material in a recipe's sketch has been picked up (`seen:<material>`) and its part
  is installed in any of the squad's benches, `RecipeBoard.fillIn` (once a tick) grants `learned:<id>` and creates its
  `pin:<id>` store with no seat (a brass pin). Pages, study and taking cans down still call `learnRecipe`, which pins in
  the learner's seat colour (owner = actor id, `seat` = slot index + 1, `found` = the page style).
- **The bench's E**: carrying a part installs it; otherwise it is `board` ("Recipes"), which the sim treats as a no-op
  and the client answers by opening the recipe panel on the bench's stock.
- Everything is ledger state (pin stores, knowledge tokens), so it is deterministic, survives
  `toSnapshot`/`fromSnapshot`, saves with the ledger and reaches co-op clients through ledger deltas. No notice says a
  recipe filled in; "Too dark", "At a workbench" and the missing part are the refusals.

**Corkboard** (`src/discovery/workbench.ts`, `sketches.ts`): every recipe has a fixed slot, so bare cork shows how
much is left to find. A sketch is pencil strokes on paper: the two materials, a plus, an arrow down, and what they
make; its pin is the learner's seat colour, or brass when the board filled it in. A recipe whose materials are all in
but whose part is not shows as a faint idea with the part (toolbox or car battery) drawn in red. The board is tilted
40° back from the bench top so the game camera reads it. **Leaning in**: at a bench, or while making something there,
the camera eases to 7.5 m (`discoveryBenchZoom`) and 80% of the way to the bench (`discoveryBenchCentre`); the
prompt hangs below the bench.

Lab: Discovery › Stage: recipe board, corkboard, dark bench; the station's matching variants.

### Proof

- `tests/recipe-board.test.ts`: the fill-in rules; picking up materials fills in with a brass pin and no notice;
  the toolbox and generator fill in what waits on them; a page pins as the finder's; the bench's E opens the board and
  spends nothing; a carried part installs; bandages anywhere, spiked boards only at a lit bench, batteries only with
  the generator; a restored fork fills in the same recipes on the same tick.
- `tests/coop.test.ts`: a recipe the board fills in reaches both clients' mirrors, and one seat makes it at the bench.
- `scripts/discovery-proof.ts bench`: stills of the bench's board, a full corkboard, the dark bench refused then lit,
  and the recipe panel.

## Slice 3: found knowledge

Recipes can be learned away from the bench, and hands get better with use. None of it is announced; what you learned
shows on the corkboard and in how fast the next board goes up.

**Pages** (`shared/discovery/found.ts`): every building of a type that has one holds a single wordless page, lying on
its first counter, shelf, table or dresser (houses hold none). Each is a ledger store `page:<building>` with
`{ page: 1 }`, created when the building first enters the world, so a read page stays read when its chunk streams out
and back.

| Building (`archetype ?? kind`) | Page | Recipe |
| --- | --- | --- |
| hardware, warehouse | flyer: red band, the result knocked out in paper, bold ink pair and arrow, tear-off tabs | reinforced boards |
| pharmacy | chart: ruled grid, red cross, each material boxed, the result circled | bandage |
| gas station | flyer | flashlight battery |
| police | photo: the thing itself light on dark, the pair pencilled in the margin | noisemaker |
| garage | photo | spiked board |

Walking up to a page the camera leans in as it does at a bench. E reads it (`read`, appended to the wire's action
list): the page is drained, the squad learns the recipe, and unless someone already knew it the page itself is pinned
to the corkboard in the reader's colour (`pin:<recipe>` with `found` = 1 flyer, 2 chart, 3 photo; `readPin().source`).
For two seconds (`discoveryGlanceTime`) the page is held up beside the survivor, drawings only (`src/discovery/glance.ts`);
it watches the page stores, so co-op readers see it the same way. A page candidate carries `priority: 3` so it wins
over the shelf it lies on.

**Practice** (`OutbreakProgression.mastery`, per survivor and skill, snapshotted): each board nailed adds 1 to
`barricade`; each board a teammate sees nailed adds `watchShare` (0.5) to theirs, if they are within `watchRange`
(8 m), facing within 1.3 rad and in clear sight (`sightRects`). A board's time and noise scale by
`practiceFactor(practice, floor)`, linear from 1 to `practiceTimeFloor` (0.6) and `practiceNoiseFloor` (0.63) over
`PRACTICE_FULL` (10) boards. The ledger channel's duration and noise are scaled right after `start`. There is no bar.

**Learning by looking**: streamed warehouses were held out from inside before the game began. Their southernmost
window (the face the camera sees; `heldOutWindow`) starts with two planks of `reinforcedPlankHp` (360 hp in all), once
per building (`OutbreakProgression.heldOut`, snapshotted), seeded by the room's step when the building streams in (and
when a sim is built with it already in the world); its chunk then carries a delta. Boards make a window bashable, so a
held-out window is also a way in for the dead; the classic town's hardware store is left alone so its horde routes stay
as tuned, and teaches reinforcing with its flyer. Reinforced boards show two steel straps crossed on each face for as
long as they hold over 110% of plain boards (`looksReinforced`); the plank wire byte now carries strength up to twice
nominal so clients can tell. Standing still (under 0.4 m/s), within 2.2 m, squarely facing (0.6 rad) a reinforced
barricade, a player's own included, for `studyTime` (1.5 s) teaches it and pins the student's sketch
(`OutbreakProgression.study`, snapshotted).

Disarming a can tripwire and practising repairs come with their verbs in slice 4.

Lab: Discovery › Stage: page, page read, found pages, held out; Discovery › page size, page diagram, its time;
Progression › practised board-up time and noise, learn by watching within, practice from watching, study time. The
station has matching variants.

### Proof

- `tests/found.test.ts`: the same pages in the same places in two rooms and none in houses; reading learns, drains and
  pins the page as found with the reader's seat and no notice; a page already known keeps its sketch; a read page
  survives a snapshot; the practice curve; three boards each faster and quieter; practice survives a snapshot and the
  fork's next board matches; a teammate in the room learns by watching, one behind a wall or looking away does not;
  a warehouse's held-out window, boarded once (the classic town's hardware store is left alone); standing and looking
  teaches, pacing past or looking away does not; a study cut by a snapshot finishes the same way in the fork.
- `tests/coop.test.ts`: a page Bob reads is gone on both clients and pinned as his chart.
- `tests/discovery.test.ts`: the plank byte round-trips strength, and plain boards never look reinforced.
- `scripts/discovery-proof.ts found`: stills of the flyer on its shelf, the flyer held up after reading, the chart,
  a corkboard of a sketch, flyer, chart and photo, and a strapped window (staged), which then teaches by looking.

## Slice 4: verbs

New things to do, each read from the world rather than explained. Simulation in `shared/progression.ts` (handlers,
`stepVerbs`) and `shared/discovery/verbs.ts` (store ids and geometry); presentation in `src/discovery/verbs.ts`
(`VerbProps`) and `src/discovery/closet.ts`. Tunables are the Progression › **Verbs** group.

| Verb | Input | What it does | State |
| --- | --- | --- | --- |
| Crouch | hold Ctrl (`ControlLeft`/`ControlRight`) | Half speed (`crouchSpeed`), footsteps at `crouchNoise` (1.2 m), no sprint, and 55% as much of you to see (`crouchVisibility`, scaling the AI's sight and close-range sensing through `PerceptionTarget.visibility`). The rig drops its hips and leans over its knees | `Command.crouch`; wire bit 0x80 of the action byte, remote survivors in bit 7 of the health byte, the personal snapshot's flag 32 |
| Hide | E at a bedroom closet | One survivor per closet: still, silent, flashlight off and invisible to the dead (visibility 0). The view goes dark behind louvre slats; E steps back out in front of it. A chaser that loses you walks to where it last saw you and searches | `hide:<closet>` {in, owner}. Every house bedroom has one closet (`closetSpot`), pushed after the other props so nothing seeded earlier moved |
| Peephole | Shift+E at a shut outer door | Looks out through the door (120° cone) the way a window peek does; E or opening the door stops. Bedroom and back-room doors (`-room`) have none | `peekingWindowId` = the door id |
| Can tripwire | E at a line; Mouse0 with cans in hand near a doorway (`tripSetTime`) | Pharmacies, police stations and clinics start with cans across their front door. Walking through upright springs them: a 13 m rattle (`tripNoise`) and the cans on the floor. Crouching steps over; the dead always spring them. E works an armed line loose quietly (`tripDisarmTime`), leaves the cans in hand and teaches the recipe (pinned as a sketch, nothing else fills it in; crafted from two scrap). Sprung cans: E picks them up, hold E strings them again | `trip:<portal>` {armed, down}. A line hangs a stride from the opening on the side the camera sees (`tripLine`): inside an east, west or north wall, across the step outside a south one, whose height hides two metres of floor |
| Bottle | Mouse0 with a bottle in hand | Thrown up to `bottleRange` (12 m), it breaks where it lands: a 15 m noise and glass on the ground. Bottles turn up in counters, fridges and shelves on their own random stream, so other loot is unchanged | `glass:<n>` {t} |
| Car alarm | E at an abandoned car, or a bottle breaking near one | About half the cars have a working alarm, fixed per car. E puts a window in (glass on the road). An alarm car wails at `alarmNoise` (30 m) on a beat for `alarmTime` (20 s), flashing its indicators, then the battery is dead | `car:<key>` {smashed, alarm, start, until} in deciseconds |
| Repair | B with a crowbar in hand at a damaged barricade | Re-nails it to full (planks × 100) in `repairTime`, scaled by practice like boarding up (mastery `repair`; watchers gain `watchShare`). A sound barricade still takes a board as before | the AI's portal state |

The prompts follow slice 1: key caps that lose their words after three uses. A tripwire's prompt floats past its wire
so it never hides it. Sounds: glass breaking for a bottle or a car window, the lure rattle when cans spring, the lure
loop while an alarm wails (`verbSound` in `src/audio/inventory.ts`).

Lab: Discovery › Stage: crouch, closet, peephole, tripwire, bottle, car alarm, repair; the station's matching
variants. The harness reports `discovery.verbs` {lines, sprung, glass, smashed, flashing, hidden, crouching}.

### Proof

- `tests/verbs.test.ts`: crouch speed, noise, sprint and visibility; the crouch bit beside an interact action; one
  closet per bedroom, clear of other furniture in streamed houses; hiding, a taken closet, and a chaser searching where
  it lost you; peepholes on outer doors only; trapped front doors, rattling versus crouching over, disarming teaches,
  stringing a new line; bottles, car alarms and a bottle setting one off; crowbar repairs with practice; hidden
  survivors, lines, alarms and glass through a snapshot, both copies ticking the same.
- `tests/coop.test.ts`: cans one survivor takes down are down for everyone, the lesson is pinned as theirs, and a
  crouch shows remotely. `packages/kit/ai.test.ts`: visibility scales sight.
- `scripts/discovery-proof.ts verbs`: stills of the crouch over a line, sprung cans, an armed line with its prompt,
  the closet's slats, the peephole view, a bottle in hand and thrown, a car with its window in and indicators
  flashing, and a barricade before and after a re-nail.

### Survivor bots

The procedural survivor bots (`shared/survivor-bot.ts`) use the same verbs through `Command` and the interact paths,
from what they have seen:

- **Crouch** within 1.7 m of a line they know is armed, within 1.1 m of broken glass (slice 5), and (Skilled and up)
  past the dead that have not noticed them. Never with the dead within 6 m: then speed wins.
- **Closets**: chased while worn out (exhausted, low stamina, no ammo or under 45 HP) or by three or more, a free closet
  they know within 10 m, with the dead further from it than they are. In for at least 6 s, out once nothing has been
  within 7 m for 3 s.
- **Tripwires**: disarm lines they did not string when calm; string carried cans across a safehouse door at night.
- **Bottles** only at the dead that are coming but have not locked on (investigating, searching, alerted), at a car
  it can see (it may have an alarm) or past them. One chasing by sight ignores the noise.
- **Peephole** before opening a shut outer door at night (map knowledge 0.5 and up), holding it shut if the dead are
  outside.
- **Crowbar repair** of a building's worst barricade (30% worn or more), swapping the crowbar in from the pack.
- **Cars**: never smashed on purpose (the alarm would bring the horde to them), and the door path never presses E on
  a car or closet.

Usage is counted per run in `BotRunResult.verbs` (`bot-runner.ts`). On 32 seeds × 5 presets, survival is unchanged
within noise and glass crunches fall by a third to 40%. Lab: the `survivor-bots` station's `verb-*` variants hand a
staged scene to a bot. Proof: `tests/bot-verbs.test.ts`.

## Slice 5: environmental vignettes

Small scenes of what happened to the people before you, seeded per home, shop and abandoned car so a few turn up in
every district. Each teaches one rule without a word. Geometry: `shared/discovery/vignettes.ts` (`chooseVignettes`,
`vignetteScene`, pure functions of the town); drawing: `src/discovery/vignettes.ts` (`VignetteProps`).

| Kind | Where (chance) | What you see | What it teaches |
| --- | --- | --- | --- |
| `broken-in` | a home: house, ranch, cottage, cabin (30%) | a side window put in, glass sprayed across the floor, a survivor down with a snapped bat, the zombie that came through; the bat left a scrap | glass is loud, bats break |
| `hid` | a home with a bedroom closet (25%) | the dead in front of the closet, spent casings at its door, a battery left a step away | closets save you |
| `lured` | a shop: hardware, pharmacy, grocery, diner, gas station (40%) | bottles broken in a line away from the front door, the dead bunched at the last one, one bottle left unthrown | a bottle pulls them away |
| `alarm-car` | an abandoned car with an alarm (50%) | its window in, its battery long dead, the dead it called piled round it | an alarm calls every zombie in earshot; other cars still have theirs |

The roll is fixed per target (`hash(seed, id)`), so every room and every client gets the same scenes, whatever order
chunks stream in. The classic town (seed 7) has Ash broken into, a closet hidden in at Elm, and bottles thrown from the
pharmacy door.

**State**: ledger stores, seeded once by `OutbreakProgression.seedVignette` when the target is first in the world
(from `ensureVerbStores`): a marker `vignette:<kind>:<target>` so it is never seeded again, glass stores
`glass:v:<kind>:<target>:<i>` with `keep` (never swept), a real ground drop `drop:v:<kind>:<target>` and, for a car,
its store with the alarm spent (`until` in the past, `old` so no sound plays when it streams in). A battery taken stays
taken through a snapshot and when its chunk streams back. Bodies, blood, casings, the bat and the broken pane cost the
simulation nothing: the client draws them from the same geometry for every marker near the survivor.

**Placement**: bodies, bats and drops settle on the nearest spot clear of walls, every door (open or shut), furniture
and wrecks, inside the home or outside every building, and outside the ~2.4 m of floor a wall to the south hides from
the camera (`WALL_SHADOW`). A broken-in window is an east or west one for the same reason. A drop is kept clear of the
door and closet prompts beside it.

**Glass underfoot** (new): a survivor walking upright onto any broken glass (within 0.4 m) crunches it, a 9.5 m noise
(`glassStepNoise`, Verbs group) and a quiet break sound; crouched, hidden or standing still, nothing. Stateless: a step
is a foot that was outside the patch a tick ago. The store's `steps` count tells clients to play the crunch.

Lab: Discovery › Stage: broken in, hid, lured, spent alarm; the station's matching variants. The harness reports
`discovery.vignettes` {scenes, bodies}.

### Proof

- `tests/vignettes.test.ts`: the classic town's three scenes, the same in two rooms, with their drops and kept glass;
  streamed homes get a few, and every body, glass patch and drop lies clear of walls, doors and furniture; glass
  crunches upright and not crouched; a vignette's glass is never swept and a bottle's is; a taken battery stays taken
  through a snapshot and a re-seed; a spent alarm car stays quiet.
- `tests/coop.test.ts`: a vignette reaches every client, and the battery one survivor picks up is gone for everyone.
- `scripts/discovery-proof.ts vignettes`: stills of each scene, and a step onto the broken-in glass that crunches.

## House radios (AR-56)

The first of the new world interactions Kit asked for after playing ("We need to have other sort of interesting
interactions in the world"); the rest are proposed in D-37. Code: `shared/radios/` (shared feature `radios`, order 26)
and `src/radios/` (client feature: Lab, `radios.stage`, harness); drawn by `RadioProps` inside the Discovery props;
heard through `InventorySounds`.

| | |
| --- | --- |
| Where | About 70% of homes (house, ranch, cottage, cabin), fixed per building, on the living-room coffee table (else a dining table). Both classic houses, Ash and Elm, have one |
| Verb | E at it: **Switch on** / **Switch off** (radio glyph, slashed to switch off) |
| While it plays | A burst every `radioBeat` (1.5 s) the dead hear out to `radioNoise` (32 m) from the radio itself, muffled by the house's shell like any noise (`shared/hearing.ts`): shut, it carries about half as far (0.6× − 3 m), so open a door or window to let it reach the street |
| Battery | `radioBattery` (60 s) across every time it is switched on; switching off keeps what is left. A flat radio offers nothing |
| The dead | They investigate the sound to the house, bash their way in if it is shut, and one standing within `radioReach` (1.6 m) of it for `radioBreakTime` (2.5 s) knocks it to the floor: a thud, and it never plays again |
| State | One ledger store `radio:<building>` {on, start, until, left, beats, near, broken}, times in deciseconds, created on first use, so it snapshots, saves, streams and replicates with no wire changes |
| Look | Bakelite cabinet with a speaker cloth, knobs and a whip aerial; the dial glows amber (`radioDialGlow`) and the cabinet buzzes (`radioShake`) while it plays; knocked down, it lies on its back on the floor south of the table |
| Sound | `radio.loop` (an old valve radio playing a scratchy big-band song through static, generated and curated with `scripts/sfx/library.ts`) held while it plays; the switch clicks; it lands with `item.drop` |

Lab: Backquote › **Radios** (simulation: reach, burst beat, battery, knock-down time and reach; look: dial glow, shake;
stage: off, playing, lure, broken). The values sit in the Discovery settings, which the client already sends as session
tuning (the shared feature reads its namespace with `discovery` as a legacy source), so no new settings subsystem.
Station: `outbreak-discovery` › House radio, Radio as a lure.

### Proof

- `tests/radios.test.ts`: the classic houses' radios on their coffee tables; streamed homes deterministic; switching on,
  bursts on the beat, switching off keeps the battery; a flat radio goes quiet and offers nothing; one of the dead in
  the house walks over and knocks it down after the break time; one on the street turns towards it; a playing radio
  through a snapshot ticks the same in both copies; tunables resolve from the Discovery settings.
- `tests/coop.test.ts`: a radio Bob switches on plays on both clients (his as owner), and one the dead knock down is
  down for everyone.
- `scripts/radios-proof.ts` (via `hivemind run --kind browser --fetch captures/outbreak-radios`): stills off, playing and
  broken, and a muted clip of the lure.

## World interactions: Lights Out, road flares, bodies, chained dogs (AR-56, D-37)

Kit's picks from D-37 (1, 4, 7, 8). Each is a shared feature (`shared/<feature>/`: domain file, `runtime.ts`,
`index.ts` registration) and a client feature (`src/<feature>/index.ts`: Lab controls, `<feature>.stage` command,
harness), one line each in `shared/features.ts` and `src/features.ts`. State is ledger stores only, so it snapshots,
streams and replicates with no wire changes. Tunables are spread into the Discovery settings; each shared feature reads
its own namespace with `discovery` as a legacy source. AI hooks stay small: lures go through `ai.emitNoise` and through
the zombies' existing investigate target, never `ai.ts`.

| | Lights Out (`lights`, order 27) | Road flares (`flares`, 28) | Bodies To Search (`bodies`, 29) | Chained dogs (`dogs`, 30) |
| --- | --- | --- | --- | --- |
| Where | Every street lamp and porch light | Loot: garages, police, gas stations, hardware, warehouses, a few house shelves, bodies (rolls of their own, so old containers keep their contents) | The `broken-in` vignette's survivor, plus ~16% of buildings (by the front door) and ~12% of abandoned cars (beside it) | ~20% of homes in a side yard, and always Elm, next to the start house |
| Verb | Shoot a lamp's head (pistol); E at a porch switch beside the front door, only when faced (else the door keeps the prompt) | Fire with a flare selected throws it (`flareThrow` 11 m, stops at walls) | E **Search** (`bodySearchTime` 1.6 s, `bodySearchNoise` 4 m), then **Take all** or digits | E **Feed** (needs Canned Food: kitchens, grocery, diner, bodies) |
| Effect | Dark for good (shot) or until switched on; `lamp.power` is 0 on the sim's town so `samplePointLightLevel` (zombie sight) drops; glass on the ground (verbs' `glass:` store, crunches, swept like a bottle's); pop noise `lampPopNoise` 9 m | Burns `flareSeconds` 30 s; every `flareBeat` the dead in `flareReach` (16 m at night, shorter by day) with clear sight past walls and shut doors, not chasing, go to investigate a spot of their own round it | `bodyRiseChance` 8% (fixed per body; never the vignette's) rise `bodyRiseDelay` 0.7 s after you reach: a zombie spawns chasing you and the loot drops as `drop:body:<key>` | Barks every `dogBeat` 1.1 s (noise `dogBarkNoise` 22 m) while the dead or an unfed survivor are within `dogSense` 11 m in sight; fed: quiet for `dogHushTime` 120 s and never barks at survivors again; the dead within its chain for `dogKillTime` 3 s kill it |
| State | `lamp:<x>,<y>` {broken, off, t} | `flare:<n>` {t, until}, deleted when out | `body:<key>` slots + {rise, risen} | `dog:<building>` {bark, since, fed, hush, near, dead} |
| Look | Night-lights presenter's `trimLamp` zeros the lamp and its bulb from the ledger | `FlareProps` stick with a glowing tip; red sputtering light packed by the night-lights presenter even with practicals off (`nlFlarePower`, `nlFlareRadius`); smoke and core as feel sprites (`nlFlareSmoke`) | `BodyProps`: the vignettes' survivor mesh, a satchel until emptied, a shudder as it rises; a blood pool each (`src/blood/placement.ts`) | `DogProps`: kennel, stake, chain links; strains and lunges barking, lies at the kennel quiet, wags fed (bowl by the kennel), on its side dead (`dogLunge`, `dogWag`) |
| Sound | `impact.bullet.glass`; switch `flashlight.click` | `flare.ignite`, `flare.loop` (new, ElevenLabs) | `search.rummage` (channel); a groan as it stirs | `dog.bark`, `dog.yelp`, `dog.eat` (new, ElevenLabs) |
| Glyph | `light-on`, `light-off` (slashed) | n/a | search, take-all | `feed` (a bone) |

Items: `flare` (Road Flare, hotbar slot 4, stack 3, rule `throw:flare`) and `food` (Canned Food, slot 3, stack 3, rule
`feed:dog`; held, the button shoves). Lab: Backquote › Lights out, Flares, Bodies, Dogs (stages included). Station:
`outbreak-discovery` › World interactions.

### Proof

- `tests/world-interactions.test.ts` (15): a shot past a street lamp breaks it once (glass, pop, power 0, darker under
  it); a lamp behind a wall is safe; the porch switch toggles off and on and the door keeps its prompt when faced; a
  dark lamp stays dark in a restored fork; throwing a flare uses one, burns and goes out; the dead in sight go to it,
  chasers do not, walls hide it; bodies are deterministic and searchable, a rising one spawns a chaser and drops its
  loot, vignette bodies never rise; Elm's dog barks on a beat, feeding hushes it and needs food, a fed dog still barks
  at the dead, the dead kill it.
