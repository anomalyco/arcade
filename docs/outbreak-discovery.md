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
