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

- **Discover.** The first time anyone picks up scrap, chem, planks or batteries, everyone hears which recipes it feeds,
  and the bench lists every recipe whose materials the squad has seen.
- **Deposit.** `E` at the bench (or hold `E` at the stash) moves belt materials and pack parts into it; ammo and
  keys stay on you. Installing the hardware toolbox makes it tier 2, and the car battery wires up a generator.
- **Research.** A digit at the bench researches a recipe (2.5 s) using the bench's stock first, then yours. It needs
  light of 0.35: daylight indoors gives 0.9, the room lamp at night 0.2, each flashlight at the bench 0.2, the
  generator 0.8. At night one survivor with a flashlight on can research; with it off it is too dark. The generator
  also hums (18 m) every 3 s at night. What one survivor learns, the squad knows.
- **Craft.** Hold `Q` anywhere for the field-craft strip and press a digit (2 s, cancelled by sprinting). At a bench
  the same rows craft from its stock too.
- **Stash.** `E` stores the held item (not the flashlight or pistol); digits take items back. Installed parts stay.

| Recipe | Research (tier) | Craft | Does |
| --- | --- | --- | --- |
| Bandage | 2 chem (1) | 1 chem | Heals 25 in about a second |
| Noisemaker | 2 scrap, 1 battery (1) | 1 scrap, 1 battery | A thrown lure that calls the dead for 8 s |
| Spiked board | 1 plank, 2 scrap (1) | 1 plank, 2 scrap | Melee: +30 damage, 1.6× stagger, longer reach |
| Reinforced barricade | 2 planks, 3 scrap (2) | none | Each board also takes a scrap and holds 180 instead of 100 |
| Flashlight battery | 2 scrap, 1 chem (2) | 1 scrap, 1 chem | A spare battery (`R` with the flashlight in hand) |

## Lab

Every tunable is a typed row in the shared LabPanel's **Progression** group (`progressionControls` in
`shared/progression.ts`, bound by `src/progression-lab.ts`): loot rate, search, smash, board-up, heal, craft,
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
