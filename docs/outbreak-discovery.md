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
| Belt pills always on screen | Belt counts show only while the pack (Tab) or field craft (hold Q) is open | `src/hud/hud.css`, `inventory-hud.ts` |
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
  the beam at full and 12%, boards at three wears, opened containers, drops, and the belt hidden until Tab.

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
