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
| Belt pills always on screen | Belt counts show only while the pack (Tab) or field craft (hold Q) is open. Since the HUD polish (#141) the dock owns this: always there, dimmed when idle (`src/hud/dock.ts`) | `src/hud/dock.ts` |
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

## Slice 2: workbench tinkering and the corkboard

The bench's recipe list is gone. Each workbench has a felt **mat** (`mat:<house>`, two slots) and a **corkboard**
leaning on its pegboard. Nothing says what makes what; you try pairs.

| Input | What happens |
| --- | --- |
| Carrying a toolbox or car battery, tap E | It is installed: the red toolbox sits on the bench top, the car battery on the shelf below. No tier notice |
| Tap E | The mat takes the next pair you can make up from your belt plus what is on it (plank+plank, plank+scrap, … battery+battery, then empty, which gives everything back). Bots use `pick: { mode: "bench", index }` with an `ALL_PAIRS` index |
| Hold E (two materials on the mat, enough light) | A 2.5 s try (`researchTime`, light ≥ `researchLight`). The tap is deferred while E is held (`deferPrimary`), so a hold never swaps the pair first |
| Tap E with something made on the mat | Take it |

What a try does (`judgeMat` in `shared/discovery/tinker.ts`):

| Pair | Bench | Outcome |
| --- | --- | --- |
| plank+scrap → spiked board, chem+chem → bandage, scrap+battery → noisemaker | any | **Assemble**: the pair is used up, the thing lies on the mat, `learned:<id>` goes into `team/known`, and the first time a `pin:<id>` store records the maker (owner = actor id, `seat` = slot index + 1) for the pin's colour |
| scrap+chem → flashlight battery, scrap+scrap → reinforced boards | no toolbox | **Almost**: nothing used; `idea:<id>` pins a faint, dashed sketch with a red toolbox in its corner |
| same | toolbox installed | Assemble |
| anything else (or reinforcing again once known) | any | **Clatter**: nothing used, a 6 m noise (`clatterNoise`) at the bench, and the first time `tried:<pair>` pins a crossed-out scrap at the board's foot so nobody tries it twice |

The game picks the ledger rule from the mat (`tinker:<id>`, `tinker:idea:<id>`, `tinker:clatter`), all labelled
"Tinkering" so the hold gives nothing away; a rule's cost is exactly the mat's pair, consumed from the mat. When a try
finishes the ledger re-checks the mat, so if a teammate swapped it mid-try the try comes to nothing ("mat changed"
veto). Two survivors holding E on one pair: the first to finish (actor id order, as the ledger steps channels)
assembles it and is credited; the other's try is vetoed.

Everything is ledger state (mat stores, pin stores, knowledge tokens), so it is deterministic, survives
`toSnapshot`/`fromSnapshot`, saves with the ledger and reaches co-op clients through ledger deltas. "Squad learned …",
"Workbench tier 2 …" and the other learning notices are gone; "Too dark" stays as the one refusal.

**Corkboard** (`src/discovery/workbench.ts`, `sketches.ts`): every recipe has a fixed slot, so bare cork shows how
much is left to find. A sketch is pencil strokes on paper: the two materials, a plus, an arrow down, and what they
make; its pin is the maker's seat colour (brass when the knowledge came another way). The board is tilted 40° back
from the bench top so the game camera reads it. **Leaning in**: at a bench, or while tinkering, the camera eases to
7.5 m (`discoveryBenchZoom`) and 80% of the way to the bench (`discoveryBenchCentre`); the prompt hangs below the
bench. A try that came to nothing shakes the mat's materials (`discoveryClatterTime`) and plays the item-drop sound;
an assembly plays the bench chime.

**Field craft** (hold Q) is drawn, not written: per learned recipe, a pencil glyph of what it makes and glyphs of
what it takes, dimmed when you are short (`src/discovery/icons.ts`).

Lab: Discovery › Stage: bench tinker, corkboard, dark bench; the station's matching variants. Progression keeps the
tinker time, light and clatter tunables.

### Proof

- `tests/tinker.test.ts`: pair rules; E cycling and giving back; assemble, pin and take; clatter noise and one
  crossed-out scrap; the tier-2 idea then assembling with the toolbox; too dark then lit; a hold that does not swap;
  co-op attribution (Bob makes it, his seat); two holds on one pair assemble once; a mid-try snapshot whose fork
  finishes the same way; two rooms fed the same commands end with identical ledgers.
- `tests/coop.test.ts`: a sketch made at the bench reaches both clients' mirrors with its maker's seat.
- `scripts/discovery-proof.ts bench`: stills of the laid-out pair, the assembled board and its sketch, an idea and a
  crossed-out try, a full corkboard, the dark bench refused then lit, and the wordless field-craft strip.

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

Can tripwire disarming and repair practice arrive with their verbs in slice 4.

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
