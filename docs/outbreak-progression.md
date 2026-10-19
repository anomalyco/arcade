# Outbreak inventory and progression

Outbreak's items live in one ledger (`@arcade/kit/sim/ledger`). Everything a survivor carries, every container's
contents, ground drops and learned knowledge are counted stacks in constrained stores, and every change is an atomic
transaction. `games/outbreak/shared/progression.ts` holds the catalog (items, stores, loot tables, rules) and
`OutbreakProgression`, the module the sim calls. Board decision D-11 chose this direction (option 2, Safehouse
Workbench, on the Inventory First baseline); the design write-up is the D-11 round on the board.

## What a survivor carries

| Store | Holds | Notes |
| --- | --- | --- |
| Hotbar (5 slots) | Flashlight, pistol, melee weapon, medical, throwable | Items go to their usual slot when it is free (`preferSlots`). `Mouse0` uses the held item; holding a melee weapon swings on `Mouse0` (tap for a 2–3 hit combo, hold for a charged heavy cleave; `V` always shoves). |
| Belt (counters) | 9mm (24), planks (6), scrap (10), chem (6), batteries (3), keys (4) | Never in the hotbar. Reload, barricade, crafting, keys and battery swaps draw from it. |
| Pack (4 slots) | Parts (toolbox, car battery takes 2), spare tools | `Tab` shows it; a digit swaps that pack slot into the selected hand slot. |

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
never those fields (tests and scripts use `harness.stock(loaded, belt)` and `harness.give(item)`).

## Containers, drops and pings

- Furniture containers (`dresser`, `nightstand`, `shelf`, `counter`, `fridge`) are `loot:<prop index>` stores
  stocked from `LOOT_TABLES[building.kind][prop.kind]` with the town seed, so new building archetypes only need a
  table. Each archetype's big parts (`ARCHETYPE_PARTS`) go on its back-room shelves; the hardware store's back room is
  keyed (a key opens it quietly, a crowbar pries it loudly).
- `E` searches quietly (1.2 s, 3.5 m), `Shift+E` smashes (0.35 s, 14 m). A searched container stays open for
  everyone: the strip above it lists what is inside, `E` takes all that fits and digits take one. What does not fit
  stays, with an "Inventory full" notice.
- `G` drops the held item, hold `G` leaves 6 ammo and 2 planks, as `drop:<n>` stores anyone can pick up. A seat that
  expires leaves its whole kit on the floor.
- `Q` pings the target (or a zombie in the aim cone) for 6 s; noisemakers call the dead for 8 s where they land.

## Safehouse workbench

Each house archetype places a workbench on the back bedroom's east wall and the squad's stash by its west wall
(`makeTown`); `benchSites` finds them, so a new house archetype only has to place the two props. Both read one shared
store, `bench:<house>`.

- **Install.** Carrying the hardware toolbox, `E` at the bench installs it (tier 2); the car battery wires up a
  generator (light 0.8, and an 18 m hum every 3 s at night).
- **Stash.** `E` stores the held item (not the flashlight or pistol); digits take items back; hold `E` deposits belt
  materials. Installed parts stay.

## How crafting works

Crafting is two steps in two places: **learn** a recipe once, then **make** it anywhere.

1. **Find materials.** Planks, scrap, chem (cloth and alcohol) and batteries go on the belt. Where each turns up most
   comes from `LOOT_TABLES` (`whereToFind` in `src/crafting/model.ts`): chem in pharmacies and groceries, scrap in
   garages and hardware stores, and so on.
2. **Learn at a workbench** (D-19: tried, not told; `docs/outbreak-discovery.md` slice 2). Every safehouse has one in
   the back bedroom. Tap `E` lays the next pair of belt materials you can make up on its mat; hold `E` tries them
   (2.5 s, needs light 0.35: daylight, or a flashlight on at night). A right pair makes the thing on the mat, teaches
   the whole squad and pins a sketch on the corkboard. A pair that needs the toolbox pins a faint idea; any other pair
   clatters (a 6 m noise) and a crossed-out scrap remembers it. Recipes are also learned from pages in shops, by
   studying reinforced boards, and by disarming a can tripwire.
3. **Make it anywhere.** Hold `Q` opens field craft above the dock; it stays open until `Q`, `Escape` or a craft. A
   digit makes that row (2 s, sprinting or walking away cancels), from your belt plus the bench's stock when you face
   the bench or the stash. Short rows dim; pressing one anyway leaves the strip open with "Need chem" and the like.
   "Crafted Bandage" confirms it, and the item goes to its usual hand slot.

| Recipe | Learn (mat pair, tier) | Craft | Does |
| --- | --- | --- | --- |
| Bandage | chem + chem (1) | 1 chem | Heals 25 in about a second |
| Noisemaker | scrap + battery (1) | 1 scrap, 1 battery | A thrown lure that calls the dead for 8 s |
| Spiked board | plank + scrap (1) | 1 plank, 2 scrap | Melee: +30 damage, 1.6× stagger, longer reach |
| Flashlight battery | scrap + chem (2) | 1 scrap, 1 chem | A spare battery (`R` with the flashlight in hand) |
| Can tripwire | disarm one | 2 scrap | Rattles when something walks through a doorway |
| Reinforced barricade | scrap + scrap (2), or a hardware flyer | none | Each board also takes a scrap and holds 180 instead of 100 |

Costs are Progression › Field-craft cost × these (the HUD reads the live ledger rule, so they always agree).

**Crafting HUD styles** (Lab: Backquote › Crafting › Style; `src/crafting/`). Today's strip is the default until Kit
picks on the arcade board:

| Style | Hold Q shows | Tips |
| --- | --- | --- |
| Today | one row per learned recipe: digit, a pencil glyph of what it makes and of what it takes; no words; nothing learned is an empty card | none |
| Recipe panel | every recipe by name: learned rows with digit and have/need per material, the short one in caution with where it turns up; unlearned rows say how they are learned | none |
| Teaching tips | today's strip (nothing learned says to try pairs at a workbench) | one line above the dock at the moments that teach: a new material, walking up to the bench, a recipe learned ("hold Q, craft it anywhere"), a pickup that makes a learned recipe affordable |
| Panel and tips | the recipe panel | the tips |

Each tip shows `craftTipUses` times per browser (`localStorage["arcade.outbreak.craftTips"]`, Lab › Crafting › Forget
shown tips), for `craftTipTime` seconds, and never on the first look at a save or room. Proof:
`tests/crafting.test.ts`; stills of every style through a new player's walkthrough:
`bun scripts/crafting-proof.ts --phase variants` (via `hivemind run --kind browser`).

## Lab

Every tunable is a typed row in the shared LabPanel's **Progression** group (`progressionControls` in
`shared/progression/tuning.ts`, bound by `src/progression/lab.ts`): loot rate, search, smash, board-up, heal, craft,
research and pry times, their noise, the light research needs, a recipe cost multiplier, reinforced plank HP, heal
amounts, noisemaker radius and duration, and the generator hum. Costs and times apply at once; a new loot rate
restocks containers nobody has searched. In co-op the room keeps its defaults. The group also has actions to give
bench materials, learn every recipe, restock, and jump to the Ash workbench.

The Lab overworld's **Outbreak inventory and workbench** station (`games/lab/src/stations/outbreak-progression.ts`)
opens the live game and stages each scene with the `progression.stage` command: an unsearched dresser, its strip,
the bench by day and by night, the generator, field crafting and hand-offs.

## Rules and channels

Timed actions (search, barricade, heal, pry, research, craft) are ledger channels. The sim cancels a channel when the
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
- `games/outbreak/tests/coop.test.ts`: same-tick take race, two seats researching the same recipe (learned once,
  paid once), a bundle hand-off, an expired seat's kit on the floor, all through encoded snapshots and a mirror.
- `games/outbreak/scripts/inventory-proof.ts`: headless Metal stills of the strip, HUD, hand-offs, keyed door, the
  bench panel, research in progress and the field-craft strip.
