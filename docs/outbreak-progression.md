# Outbreak inventory and progression

Outbreak's items live in one ledger (`@arcade/kit/sim/ledger`). Everything a survivor carries, every container's
contents, ground drops and learned knowledge are counted stacks in constrained stores, and every change is an atomic
transaction. `games/outbreak/shared/progression.ts` holds the catalog (items, stores, loot tables, rules) and
`OutbreakProgression`, the module the sim calls. Board decision D-11 chose this direction (option 2, Safehouse
Workbench, on the Inventory First baseline); the design write-up is the D-11 round on the board.

## What a survivor carries

| Store | Holds | Notes |
| --- | --- | --- |
| Hotbar (5 slots) | Fists (slot 1, bound: never dropped or looted), pistol (one each, `unique`), melee weapon, medical, throwable | The flashlight is on the shoulder, not a slot (`F`). Items go to their usual slot when it is free (`preferSlots`). Fists or an empty slot shove on `Mouse0`; `Mouse0` uses the held item; holding a melee weapon swings on `Mouse0` (tap for a 2–3 hit combo, hold for a charged heavy cleave; `V` always shoves). |
| Case (`pack`, a grid store) | Everything else: supplies (9mm boxes of 15, plank bundles of 3, scrap 5, chem 2, batteries 2, keys 4, a gas can each), spare tools and weapons, parts | The Attaché Case (AR-94, D-46): every item lies at its shape (`shared/progression/shapes.ts`, e.g. pistol 2×2, machete 4×1, gas can 2×3) and turns a quarter to fit. What fits is what you carry: there are no per-item caps. Reload, barricade, crafting, keys and fuel draw from it. `Tab` opens it ([outbreak-hud.md](outbreak-hud.md#the-attaché-case-ar-94-d-46)). |
| Worn (counters) | The bag and its pouches | The case is the biggest bag worn (school backpack 6×3 to start, the Breacher's attaché case 7×3, a hiking pack 7×4, a duffel 9×4), a row more per pouch (two at most, made at a workbench). It only grows; the bag stays on you when you fall. |

### Melee weapons (`games/outbreak/shared/combat.ts`)

Every melee weapon is a ledger item (`slot: "hand"`, `preferSlots: [2]`) whose `charge` tracks remaining durability hits (`MELEE_WEAPONS[id].durability`). Connecting with zombies or doors/barricades wears durability by 1 per swing (2 on a heavy swing); at 0 the weapon breaks with a callout and `melee.break` SFX.

| Weapon | Class | Damage | Reach | Arc | Combo | Stamina | Knockback | Durability | Noise | Door dmg | Loot buildings |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --- |
| `knife` | `one-blade` | 28 | 1.35 m | 75° | 3 | 10 | 1.3 | 30 | 3.5 m | 8 | house kitchens/counters, diner, cabin |
| `pipe` | `one-blunt` | 36 | 1.60 m | 95° | 3 | 15 | 2.8 | 28 | 7.5 m | 22 | garage, warehouse, gas_station |
| `hammer` | `one-blunt` | 38 | 1.45 m | 85° | 3 | 14 | 2.6 | 32 | 8.0 m | 30 | hardware, garage, warehouse, house |
| `crowbar` | `one-blunt` | 42 | 1.65 m | 95° | 3 | 16 | 2.5 | 36 | 7.0 m | 34 | hardware, garage, warehouse, gas_station (also pries keyed doors) |
| `bat` | `two-heavy` | 46 | 1.85 m | 115° | 3 | 18 | 3.6 | 26 | 6.5 m | 26 | house, grocery, gas_station, police |
| `machete` | `one-blade` | 52 | 1.70 m | 105° | 3 | 16 | 1.9 | 26 | 5.0 m | 18 | hardware, cabin, grocery |
| `spiked-board` | `two-heavy` | 55 | 1.90 m | 115° | 2 | 22 | 3.8 | 18 | 7.5 m | 32 | crafted (`recipe:spiked-board`), warehouse |
| `axe` | `two-heavy` | 65 | 1.85 m | 105° | 2 | 24 | 3.2 | 28 | 8.5 m | 55 | hardware, cabin, garage |
| `fire-axe` | `two-heavy` | 80 | 2.00 m | 120° | 2 | 28 | 4.0 | 32 | 9.5 m | 75 | police, warehouse, hardware |

The survivor's old fields (`magAmmo`, `reserveAmmo`, `planks`, `channel`) are a projection written by
`OutbreakProgression.project` each tick, for the HUD, the wire and combat animation. Change items through the ledger,
never those fields (tests and scripts use `harness.stock(loaded, supplies)` and `harness.give(item)`).

Grid stores are a kit ledger feature (`StoreSpec.grid`, `ItemDef.grid`, the `place` transaction, `growGrid`,
`occupancy`, `findPlace`): a stack fits only where its cells are free, routing puts it at the first free place (as it
lies, then turned), and a swap puts the outgoing item where the incoming one lay when it fits. Tests:
`packages/kit/sim/ledger-grid.test.ts`.

**Finding bigger bags.** Every town has one hiking pack in a house dresser and one duffel on a police, garage, warehouse or
hardware shelf (`placeBags` in `loot.ts`, from the seed), plus small chances elsewhere (`BAG_LOOT`, cabins most often),
on a random stream of their own so every container keeps the rest of its contents. Taking one wears it; the case
unfolds its new cells the next time you look.

## Containers, drops and pings

- Furniture containers (`dresser`, `nightstand`, `shelf`, `counter`, `fridge`) are `loot:<prop index>` stores
  stocked from `LOOT_TABLES[building.kind][prop.kind]` with the town seed, so new building archetypes only need a
  table. Each archetype's big parts (`ARCHETYPE_PARTS`) go on its back-room shelves; the hardware store's back room is
  keyed (a key opens it quietly, a crowbar pries it loudly).
- `E` searches quietly (1.2 s, 3.5 m), `Shift+E` smashes (0.35 s, 14 m). A searched container stays open for
  everyone: the strip above it lists what is inside, `E` takes all that fits and digits take one. What does not fit
  stays, and the notice says what is in the way and the key that clears it ("No room for Machete: hands and case
  full. G drops your Crowbar", "No room in your case for 9mm. Tab to make room", "You already carry a 9mm Pistol"). A hand item with no
  room is tagged "swap" in the strip: its digit (or `E` on a single item on the floor) drops what is in hand there and
  takes it.
- `G` drops the held item, hold `G` leaves 6 ammo and 2 planks, as `drop:<n>` stores anyone can pick up. Beside a
  standing teammate (1.8 m, in front or touching) either one goes to them instead (`shared/progression/give.ts`): it is
  dropped at their feet and they take it in the same tick, so a full teammate finds it lying there; both get a named
  notice ("Gave Crowbar to Bob", "Ann gave you Crowbar"), and walking up with something in hand says "G to give Bob".
  A seat that expires leaves its whole kit on the floor.
- `Q` pings the target (or a zombie in the aim cone) for 6 s; noisemakers call the dead for 8 s where they land.

## Safehouse workbench

Each house archetype places a workbench on the back bedroom's east wall and the squad's stash by its west wall
(`makeTown`); `benchSites` finds them, so a new house archetype only has to place the two props. Both read one shared
store, `bench:<house>`.

- **Install.** Carrying the hardware toolbox, `E` at the bench installs it; the car battery wires up a generator
  (light 0.8, and an 18 m hum every 3 s at night). Each part fills in recipes on the board (below).
- **Recipes.** Otherwise `E` at the bench opens its recipe board (the same panel as `C`, drawing on the bench's stock).
- **Stash.** `E` stores the held item (not the flashlight or pistol); digits take items back; hold `E` deposits the
  case's materials. Installed parts stay.

## How crafting works

D-39 (Recipe Board) and D-38 (Panel And Tips): every recipe has a place on the workbench from the start, and there is
no guessing. Rules: `shared/discovery/recipes.ts` and `recipe-board.ts`; the HUD: `src/crafting/`.

1. **Pick up materials.** Planks, scrap, chem and batteries go in the case. The first time the squad picks one up
   (`seen:<material>` in `team/known`), every recipe it feeds whose materials have now all been seen **fills in**: the
   squad learns it and its pencil sketch goes up on the corkboard with a brass pin. Nothing is announced in words
   (D-19); a tip above the dock says it is on the workbench.
2. **Bench parts fill in the rest.** A recipe that needs a part shows as a faint idea on the corkboard, with the part
   drawn in red, until one is installed in any of the squad's benches: the toolbox fills in reinforcing, the generator
   (car battery) fills in flashlight batteries. Pages in shops, studying a reinforced window and disarming a can
   tripwire still teach recipes early, pinned in the finder's colour.
3. **Make it.** `C` (physical `KeyC`, on foot; in a vehicle it changes seat) opens the recipe panel above the dock,
   and `E` at a workbench opens the same panel as the bench's board. Every recipe is listed by name with a pencil
   glyph: learned rows have their digit and have/need per material, the short one in caution with where it turns
   up; rows still to find say what fills them in ("Pick up chem", "Install a toolbox", "Disarm a can tripwire"). A
   digit makes that row (2 s; walking off cancels), from the belt plus the bench's stock at a bench or stash. Bench
   recipes say "At a workbench" away from one, and need light 0.35 there (daylight, the generator or a flashlight).
   `C`, `Escape` or walking away from the bench closes it. `Q` only pings.

| Recipe | Fills in when the squad has | Made | Cost | Does |
| --- | --- | --- | --- | --- |
| Bandage | chem | anywhere | 1 chem | Heals 25 in about a second |
| Noisemaker | scrap and a battery | anywhere | 1 scrap, 1 battery | A thrown lure that calls the dead for 8 s |
| Spiked board | plank and scrap | at a lit workbench | 1 plank, 2 scrap | Melee: +30 damage, 1.6× stagger, longer reach |
| Reinforced barricade | scrap and the toolbox installed (or a hardware flyer) | when boarding up | +1 scrap a board | Each board holds 180 instead of 100 |
| Flashlight battery | scrap, chem and the generator wired in | at a lit workbench with the generator | 1 scrap, 1 chem | A spare battery (`R` with the flashlight in hand) |
| Can tripwire | one disarmed | anywhere | 2 scrap | Rattles when something walks through a doorway |
| Molotov | a bottle and chem | anywhere | 1 bottle, 1 chem | Thrown; bursts into a pool of fire that sets the dead alight |
| Flamethrower | a gas can, scrap and a pressure tank installed | at a lit workbench with the tank | the tank, 1 gas can, 3 scrap | See Fire & explosives below |

Costs are Progression › Craft cost × these (the HUD reads the live ledger rule, so they always agree).

**Tips** (Lab: Backquote › Crafting): one line above the dock when a recipe fills in ("Bandage on the workbench · `C`
make it anywhere", or "`E` make it there" for bench recipes), when a pickup makes a learned recipe affordable, and on
walking up to a workbench. Each shows `craftTipUses` times per browser (`localStorage["arcade.outbreak.craftTips"]`,
Lab › Crafting › Forget shown tips), for `craftTipTime` seconds, and never on the first look at a save or room.

Bots make bench recipes at the bench with the same digit (`canCraftUseful` in `shared/survivor-bot.ts`). Proof:
`tests/recipe-board.test.ts` (filling in, parts, pages, the bench's E, where things are made, a restored fork) and
`tests/crafting.test.ts` (rows, costs, hints, tips); stills of a new player's walkthrough:
`bun scripts/crafting-proof.ts` (via `hivemind run --kind browser`).

## Fire & explosives (AR-62)

`shared/fire/` (rules) and `src/fire/` (drawing, Lab). Progression leaves these items alone on the button (`heldUse`
returns "use") and the fire feature uses them. Everything every seat sees is a fixed ring of shared ledger stores
(`fire:`, `burn:`, `scorch:`, `dyn:`, `crack:`, `trap:` and `flamer:<seat>`), made once and reused, so how much burns
is bounded and nothing is added to the wire.

| Item | Where | How it plays |
| --- | --- | --- |
| Flamethrower | The hardware store's keyed back room in 60% of towns (seeded); 1–1.2% on garage and warehouse shelves; or made at a bench with a pressure tank installed | Hold fire to spray a short cone (6.5 m, 16°). A full tank lasts 9 s; `R` or an empty tank refuels from a gas can. The dead in the stream catch fire, panic, burn down (15/s for 6 s), light the street, set alight others they brush and fall charred. It roars (22 m) and its light pulls in the dead who see it, most at night. Friendly fire. Fire licks the ground where it lands (2.4 s) and leaves scorch marks |
| Gas can (`fuel`, belt) | Gas stations and garages (15–35%), hardware, warehouses, cabins, rarely houses | Refuels the flamethrower; one goes into making it. With The Way Out's car project, the only fuel for cars (40% a can) |
| Pressure tank (part) | Always in the hardware back room; 5–6% on garage, gas station and warehouse shelves | Install at a bench to fill in the flamethrower recipe; making one uses it up |
| Dynamite | Hardware 3%, warehouse 5%, cabin 6% shelves | Thrown on a 2.6 s fuse. The blast (4.8 m) kills and throws the dead, hurts survivors, blows in barricades and doors, leaves a crater, flashes and is heard 60 m off |
| Firecrackers | Gas station 12% and grocery 6% counters, garages, houses | Thrown; the string skitters 6 m and pops for 7 s, each burst heard 20 m off: a moving lure |
| Molotov | Made from a bottle and chem | Thrown 11 m; a 2.3 m pool of fire for 7 s |
| Flare gun (3 shots) | Police 4–8%, garage and gas station counters, cabins | Fires a road flare 26 m that pulls the dead into its red light, far from you |
| Bear trap | Cabin 15% and hardware 6% shelves | Set just ahead; the first of the dead to step in takes 45 and is held 8 s |

Rare rolls use their own seeded stream (`RARE_LOOT` and `rollRareLoot` in `shared/progression/loot.ts`), so the
older loot rolls of every town are unchanged. Fire on the ground never spreads unless Lab › Fire & explosives › Fire
spreads is raised. Tunables, the look (flame brightness and density, embers, smoke, light, charring, light budget),
Give and Stage actions are in Lab › Fire & explosives; `arcade cmd fire.give item=dynamite count=2` and
`arcade cmd fire.stage scene=burning` do the same, and the `outbreak-fire` Lab station stages each item. Tests:
`tests/fire.test.ts`; sounds (reused library samples): `src/audio/inventory.ts`, `tests/audio.test.ts`.

## The Way Out (AR-64)

A run can now be won. The Way Out's clues are notes on home furniture, flyers on searched bodies and a torn map on
police station counters; a flare lit at the destination signals the evac; gas cans fuel the car, a toolbox hotwires
it, and dynamite or bolt cutters (`bolt-cutters`, a pack part on hardware, garage and warehouse shelves, rolled after
the fire rolls) clear the roadblocks on the way. Everything it tracks lives in one shared `wayout` ledger counters
store, not in anyone's inventory. How a winning run goes:
[outbreak-way-out.md](outbreak-way-out.md).

## Lab

Every tunable is a typed row in the shared LabPanel's **Progression** group (`progressionControls` in
`shared/progression/tuning.ts`, bound by `src/progression/lab.ts`): loot rate, search, smash, board-up, heal, craft
and pry times, their noise, the light bench recipes need, a recipe cost multiplier, reinforced plank HP, heal
amounts, noisemaker radius and duration, and the generator hum. Costs and times apply at once; a new loot rate
restocks containers nobody has searched. In co-op the room keeps its defaults. The group also has actions to give
bench materials, learn every recipe, restock, and jump to the Ash workbench.

The Lab overworld's **Outbreak inventory and workbench** station (`games/lab/src/stations/outbreak-progression.ts`)
opens the live game and stages each scene with the `progression.stage` command: an unsearched dresser, its strip,
the bench by day and by night, the generator, the recipe panel and hand-offs.

## Rules and channels

Timed actions (search, barricade, heal, pry, craft) are ledger channels. The sim cancels a channel when the
survivor walks more than about 2.9 m from it or sprints, and the ledger re-validates it when it completes, so a
finished channel cannot spend what someone else took meanwhile. Game effects outside the ledger (barricade planks in
the AI, health, door state) run on the `ran` event; vetoes such as "already boarded 3/3" come from `LedgerEnv.check`.

## Co-op

The room sends each seat the ledger stores it can see (shared stores and its own) that changed since the revision it
last received, plus its notices. The client keeps a mirror ledger for the HUD and prompts; it never runs rules. A
take is one transaction on the room, so two survivors grabbing the last item in one tick resolve to one owner
(`tests/coop.test.ts`).

## Proof

- `packages/kit/sim/ledger.test.ts`: conservation, capacity, atomic rejection, channel races, deltas converging a
  mirror, drops removed when emptied.
- `games/outbreak/tests/progression.test.ts`: every call site (routing, both search speeds, take one/all and full,
  cancel by walking away, medkit, crowbar, noisemaker, keyed doors, drops, pings, battery swap, barricade, loot tables,
  the command tuple).
- `games/outbreak/tests/coop.test.ts`: same-tick take race, a recipe the board fills in reaching every client and
  made at the bench by one seat, a bundle hand-off, an expired seat's kit on the floor, all through encoded snapshots and a mirror.
- `games/outbreak/scripts/inventory-proof.ts`: headless Metal stills of the strip, HUD, hand-offs, keyed door, the
  bench, its recipe board, a spiked board made there and the recipe panel in the street.
