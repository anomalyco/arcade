# Outbreak difficulty ramp

Survivor bots (`games/outbreak/shared/survivor-bot.ts`, presets Novice, Casual, Skilled, Expert, Perfect) play
deterministic headless games, and a read-only probe records what happened in each game hour. Two tools use it:

| Tool | What | When |
| --- | --- | --- |
| `games/outbreak/tests/difficulty-ramp.test.ts` | 4 presets × 4 fixed seeds to dawn 3 on up to 4 workers (~4 s on Studio, ~20 s on CI), curves held inside tolerance bands | Every `bun run check` and CI |
| `games/outbreak/scripts/difficulty-ramp.ts` | Any presets × seeds × nights, `report.md`, JSON and PNG charts; `--today` turns the night ramp off, `--set=key=value,…` tries session tuning | By hand, before and after a difficulty change |

D-22 tuned survival per preset (`shared/difficulty-tuner.ts`, `scripts/run-bot-tuning.ts`). This checks the shape of
the challenge over time: how pressure, damage, resources and deaths move from the evening through each night and day.

## How it works

- `BotRunConfig.observe` in `shared/bot-runner.ts` is called once per tick after the world steps. It must not change
  the sim, so a run with a probe is identical to one without (bot digests and `scripts/parity.ts` are unaffected).
- `shared/difficulty-ramp.ts` `runRampProbe` buckets the lead survivor's run by game hour, aligned to phases:
  bucket 0 is the evening (17:30–18:00), then one bucket per game hour. Phases are Evening, Night 1, Day 2, Night 2…
  Each bucket has living zombies, aware zombies (investigating, alerted, chasing, bashing or searching), director
  chasers, living specials, hits (separate damage events), damage, healing, kills, time indoors and hidden, ammo, meds
  (medkits and bandages), flashlight charge and spare batteries at the end of the hour, and found vs spent for ammo,
  meds and batteries (rises and falls of what the survivor carries).
- `summarizeRamp` folds runs into per-phase stats per preset (survival at the end of each phase, death rate, pressure
  means weighted by time alive, levels at phase end). `rampHourCurves` gives per-hour means for the charts.
- Clock: one game hour is 15 sim seconds, the evening is 30 s at the opening clock, dawn after night n is at
  `30 + 180·(2n−1)` s (`secondsToDawn`). The bot runner's old 1260 s cap stops at 04:00 of Night 4.
- Food does not exist in the game, so it has no curve.

## Full batch

```sh
cd games/outbreak
bun scripts/difficulty-ramp.ts                      # 5 presets × 24 seeds × 5 nights → captures/difficulty-ramp
bun scripts/difficulty-ramp.ts --seeds=12 --nights=5 --workers=2 --out=<dir>
bun scripts/difficulty-ramp.ts --presets=Novice,Expert --seeds=101,107 --no-charts
```

It runs bots on Bun workers (`scripts/difficulty-ramp-pool.ts`, shared with the test; `--workers`, default cores − 2) and is CPU only. Charts come from
`scripts/difficulty-ramp-charts.py` through `uv run --with matplotlib`: `survival.png`, `pressure.png`,
`resources.png` and `phases.png`. Route big batches through HiveMind like other heavy jobs.

## Updating the bands

The test's bands are loose on purpose: they catch a broken director (no ramp-in, runaway spawns, nights no harder
than days, a cliff from one night to the next, presets out of order), not tuning drift, and they leave room for float
differences between machines. Each band has today's value in a comment.

When a deliberate difficulty change moves a curve out of its band:

1. Run the full batch before and after the change and read both reports.
2. If the new curve is what you meant, change the band in `tests/difficulty-ramp.test.ts` in the same PR, update the
   comment with the new value, and say in the PR which decision or card asked for it.
3. Never widen a band to get an unrelated change through. A band failing on a change that was not about difficulty
   is the test working.

## Co-op (AR-92, 2026-10-20)

Kit and four teammates died "almost immediately" and over and over on the live build: "Oh, there's a lot of zombies.
Oh, it scales." "We're not getting past this initial phase." "Dude, they killed me while I was in the van?"

`shared/coop-ramp.ts` is a co-op probe over the same bot runner (now 1–6 survivors): it plays the evening and Night 1
at the co-op clock (`COOP_TIME_SCALE` 120, so the evening is 0–60 s and Night 1 60–420 s; the solo ramp test runs at
240) and records per survivor the first down, downs, death, damage (and damage while seated in a car) and ammo spent,
and per phase the living dead, aware, chasers, specials, the director's wanted population, chaser cap and noise heat,
plus first chase, first special, first dog bark, car alarms and how near new zombies came into the world.

```sh
cd games/outbreak
bun scripts/coop-difficulty.ts                                    # 1/2/4/6 × Skilled, Novice × 6 seeds (~45 s, 2 workers)
bun scripts/coop-difficulty.ts --seeds=12 --players=4,6 --json=out.json
bun scripts/coop-difficulty.ts --set=coopScaleMode=0,carShelter=0 # Today
```

Bots never revive, so "down" (a survivor ever at 0 HP) is the number to read.

### Why four players were overwhelmed

1. **Linear scaling, and Gentle Start applied before it.** Population ×(1 + 0.35(n−1)) (2.05× at 4, 2.75× at 6) and
   the chaser cap ×(1 + 0.6(n−1)) (2.8×, 4×). The night ramp's Night 1 hold of 2 chasers was multiplied by that, so a
   squad of 4 had 6 chasers on it and a squad of 6 had 8 for the whole first night.
2. **The squad's noise was summed.** Every gunshot adds about 1.08 to the director's noise heat (ceiling 3, decay
   0.022/s), so a squad pinned it at 3 within ~35 s. That skips the opening holds (1 chaser before 36 s and 2 before
   85 s, both only while heat is low), adds up to +0.47 to the ramp (wanted population 5 → 21 in the first minute at 6)
   and turns every wave into a horde wave (heat ≥ 0.85). Heat at 6 survivors in the first 120 s: gunshots 56, dog barks
   24, sprinting 11, car alarms 5.
3. **New zombies close by.** The director spawned as near as 16 m from a survivor (12.75 m for a new chunk's dead);
   about 3 a run came in within 20 m at 4 and 6.
4. **Specials multiplied with the crowd.** Each new zombie rolls for a special, so 4–6 survivors met 3–4× the solo
   specials on Night 1 and the first a minute sooner (67 s against 141 s).
5. **Cars were no shelter.** The crowd's normal claws (23 a hit × seat armour 0.3–0.45) reached a seated rider through
   the doors from the first second, on top of the window chip damage: four of the dead round a sedan put its driver
   down in ~10 s with damage from 0.5 s. That is the van kill.

Real death (#263) made all of this final, and a teammate without melee (fixed by AR-93, #313) made it worse.

### What changed

Lab › **Co-op scaling** (in the night ramp's tuning namespace, `shared/night-ramp/coop.ts`; the director reads it
from `PacingDirector.coop`, `shared/pacing.ts`). **Co-op scaling: Today (linear)** restores the old director exactly
(checked: the probe reproduces the before table byte for byte). One survivor plays the same either way.

| Setting | Default | Does |
| --- | --: | --- |
| `coopPopulationPerSurvivor` / `coopChasersPerSurvivor` / `coopCurve` | 0.3 / 0.45 / 0.7 | Population and chaser cap grow by `per × (n−1)^curve`: population 1.3, 1.65, 1.93× at 2, 4, 6 (was 1.35, 2.05, 2.75); chasers 1.45, 1.97, 2.39× (was 1.6, 2.8, 4) |
| `coopNoiseShare` | 0.75 | Director heat from loud noise is divided by n^0.75 (2.8 at 4, 3.8 at 6): a squad heats it like fewer shooters, not n of them. The dead still hear every shot |
| `coopNightOneChasers` | 0.4 | Gentle Start in co-op: Night 1's hold (2) gains `0.4 × (n−1)^curve`, so 2, 3, 3 chasers at 2, 4, 6 |
| `coopSpawnClearance` | 22 m | A squad's new zombies (director trickle, the opening top-up and a new chunk's dead) never come into the world nearer than this to any survivor |
| `coopSpecialShare` | 1 | Special chance ÷ population scale^share: specials don't multiply with the squad |

Vehicles (Lab › Vehicle): **Car shelter: Windows first** (`carShelter`, `windowsGiveAt` 0.5, `shared/vehicles.ts`
`carShelters`). Until the dead batter a car to half its health, they can't hurt anyone inside: their claws only dent
the car (30% of the hit) and the window chip damage waits. One zombie can't break in; four take ~5 s on a sedan
(longer on the van: 850 health against 500) before riders take damage at seat armour as before, ~13.5 s to a down
against ~10.7 s, with no damage at all for the first ~5 s instead of from 0.5 s. Drive off.
**Car shelter: Today** restores the claws through the doors. `tests/car-shelter.test.ts`.

### Before and after (12 seeds, evening and Night 1)

| Preset | Survivors | Down before → after | Down in first 120 s (survivors) | First down s | Night 1 living | Night 1 chasers (peak) | Night 1 specials | New zombies < 20 m a run |
| --- | --: | --- | --- | --- | --- | --- | --- | --- |
| Skilled | 1 | 17% → 17% | 0 → 0 | 168 → 168 | 9.4 → 9.4 | 1.4 (2) → same | 0.19 → 0.19 | 0.6 → 0.6 |
| Skilled | 2 | 8% → 25% | 0 → 0 | 370 → 297 | 13.2 → 13.1 | 2.8 (3) → 1.8 (2) | 0.48 → 0.25 | 1.7 → 0.1 |
| Skilled | 4 | 33% → 6% | 2% → 0 | 173 → 291 | 19.7 → 15.9 | 5.7 (6) → 2.8 (3) | 0.83 → 0.47 | 3.5 → 0 |
| Skilled | 6 | 53% → 8% | 10% → 1% | 102 → 200 | 27.1 → 18.8 | 7.6 (8) → 2.9 (3) | 1.01 → 0.52 | 3.2 → 0 |
| Novice | 1 | 67% → 67% | 0 → 0 | 164 → 164 | 8.9 → 8.9 | 0.5 (2) → same | 0.17 → 0.17 | 0.3 → 0.3 |
| Novice | 2 | 79% → 46% | 13% → 8% | 138 → 192 | 12.6 → 13.1 | 1.1 (3) → 0.9 (2) | 0.38 → 0.26 | 1.0 → 0.1 |
| Novice | 4 | 100% → 73% | 31% → 4% | 102 → 199 | 17.7 → 15.8 | 4.0 (6) → 2.1 (3) | 0.62 → 0.33 | 1.5 → 0 |
| Novice | 6 | 100% → 53% | 39% → 1% | 90 → 173 | 24.5 → 18.8 | 5.2 (8) → 2.3 (3) | 1.20 → 0.39 | 2.5 → 0 |

Every squad of Novices was wiped by dawn before (4 and 6: 100%); now 33% and 8%. A squad is now no deadlier per
survivor than playing alone, before revives (which bots never do). Skilled 2 moved within noise (2–3 of 24 survivors).
Noise heat still reaches its ceiling for every squad and for solo bots, who shoot a lot; with it divided by the squad,
Night 1's caps hold instead.

`tests/difficulty-ramp.test.ts` › co-op holds Skilled squads of 2, 4 and 6 (4 seeds) to: at most 5% of survivors down in
the first 120 s, at most 30% by dawn 1, Night 1 chasers within the co-op hold (peak ≤ 3), Night 1 living 1.1–1.6,
1.3–2.0 and 1.5–2.4× the solo run's, no new zombie within 20 m and Night 1 specials at 6 below 0.75. Today fails the
chaser, population, spawn and specials bands. The solo bands did not move (solo is unchanged).

Still open: chasers are capped for the whole squad but the cap picks the highest-priority pursuers, so a survivor who
strays far from the others can draw all of Night 1's chasers (the one early down left at 6). Bots don't drive, so the
car numbers come from the staged test, not the batch.

## Out of town (2026-10-19)

Kit drove out of town and "zombies just stopped appearing". Out of the first town's 96 m square nothing spawned at
all: the director clamped every backstage spawn point (and every nudge, scout and hold) to that square, and a newly
loaded chunk's own dead were checked against nav tiles that were not built yet, so all of them were dropped. Now the
director works inside the active chunks' bounds (`worldBoundsOf`), the town and nav tiles take a new chunk in before
its dead are placed, and those residents come in only up to the director's wanted population, so the night ramp's
Night 1 0.65× and its later rises hold wherever you are (residents left out return when their chunk next loads).
`bun scripts/population-trace.ts --hours=30` logs the living dead against the wanted population each half hour while a
survivor walks and then drives out; `tests/population-streaming.test.ts` holds them within half of it to 4 over it
while driving the town's road for 15 game hours. The bot batch plays in town, so no difficulty band moved.

## Characters (AR-88)

Habit loops (`shared/characters/habits.ts`) pin a fresh, unaware wanderer to a site (a front door, a stove, a bed, a
fence, the church) at least 16 m from every survivor and never closer than it already was. While it is lost in the
habit it stands still and sees, hears and feels at 0.55× (`chHabitSenses`; a torch beam on it still wakes it, as it
would any zombie); when it notices someone it is fully alert at once but
takes a 1 s beat to let go (`chHabitLetGo`) before it moves. Callings, wear and the rest are presentation only.

3 presets × 72 seeds × 5 nights, `--workers=2`, habits on against `--set=habits=0` on the same base (pre-rebase on
91c32da2). The CI bands pass with habits on and none moved. Each cell is the fraction alive at that dawn:

| Preset | Off median nights | D1 | D2 | D3 | D4 | D5 | On median nights | D1 | D2 | D3 | D4 | D5 |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| Casual | 1.57 | 79% | 35% | 6% | 3% | 0% | 1.39 | 74% | 25% | 7% | 4% | 1% |
| Skilled | 2.29 | 89% | 61% | 40% | 29% | 18% | 2.37 | 94% | 64% | 43% | 33% | 19% |
| Expert | 3.70 | 97% | 78% | 60% | 47% | 35% | 3.21 | 92% | 76% | 56% | 43% | 32% |

At 72 runs a cell is good to about ±6 points. Skilled does slightly better, dawn 5 is unchanged for everyone, and
Expert sits 2–5 points lower all the way through. The one gap past the noise is Casual at dawn 2 (35% → 25%): a
zombie at a door or a stove stays inside a house the survivor walks into, where a wanderer would have drifted out.
Expert's median moves half a night because its curve crosses 50% between dawn 3 and 4, so a few points move the median a
lot. If a band breaks early in the run, try `chHabitSenses` 0.4 before changing the band.

## Zombies through doors (AR-65)

Zombies used to wedge on door jambs (`docs/game-notes.md`, Crowds). With the doorway funnel they come through, and the
CI batch (4 presets × 4 seeds × 3 nights) moved inside its bands: Skilled alive at dawn 3 0.5 → 0.25 (median nights
2.65 → 1.63), Expert 1 → 0.75, Novice at dawn 1 0.25 → 0; Night 2 / Night 3 chasers 2.62 / 3.89 → 2.89 / 3.94. No
band changed. Skilled dawn 3 now sits on its lower edge: if a later change drops it below, check whether doors (or
anything else) made houses safer or deadlier before touching the band.

## Throwables (AR-96)

Throwables are lying in 70% of houses (`drop:v:yard:*` ground drops) and bottles fly the new way. Bots still press
fire once with a bottle, which throws at full strength at once, as their old fixed-range throw did; they do not pick
up or throw the new items on purpose (they may pick one up as "dropped supplies"). The banded test
(`tests/difficulty-ramp.test.ts`) passed unchanged; no band moved.

## Door breaches (AR-97)

Readable breaches (`shared/breach/`) add a 1.1 s warning beat before a door gives, bracing, and a broken door that
cannot be shut again (only barricaded), with a staggered spill. The CI batch (measured on `overnight` 0eb51905, before AR-92/AR-96; the banded test still
passes on top of them) stayed inside every band: Novice alive at
dawn 1 0 → 0.5 (dawn 3 0, median nights 1.25), Casual dawn 1 1 → 0.75 (median 1.44), Skilled 1 / 0.25 (median 2.80),
Expert 1 / 0.75 (median 3.01); Night 1 / 2 / 3 chasers 1.02 / 2.89 / 3.94 → 3.73; Night 3 / Night 2 aware 1.06. No band
changed. Lab › Doors & barricades › "Today" restores the old pop-open doors.

## Weather (AR-71)

Rain masks noise (zombies hear 30% less at full rain) and costs them 12% of their sight range, so on a wet night fewer
zombies notice the survivors. Storms come only after dark, so the effect lands mostly on Night 2–3. In the CI batch
the Night 3 / Night 2 aware ratio dropped from 1.17 to 1.08 and nothing else moved out of its band, so
`nightThreeOverTwo`'s lower edge went from 1.1 to 1.0. That is the deliberate change: weather makes some nights a
little easier to sneak through rather than adding a difficulty step. Survival and chaser bands are unchanged. Lab ›
Weather › "Rain masks noise" and "Rain shortens zombie sight" tune it; "Today (always clear)" restores the old ratio.

## The night ramp (D-40, Gentle Start, Rising)

`games/outbreak/shared/night-ramp/` raises the challenge every night instead of letting the director's own ramp level
off at Night 2. It counts nights (darkness ≥ 0.5) and hands the director a `DirectorEscalation` each tick before the
crowd steps (`shared/pacing.ts`). Lab: Backquote › Night ramp. **Night ramp: Today** switches all of it off and is
byte-identical to the game before D-40 (checked with bot runs against origin/main).

| Setting | Default | Does |
| --- | --: | --- |
| `nightOneChasers` | 2 | Solo chaser ceiling during Night 1 (and the evening) |
| `nightOnePopulation` | 0.65× | Solo population target during Night 1 |
| `nightPopulationStep` / `nightPopulationCeiling` | +3 / 30 | Zombies added per night after the first, and the most there will be (solo) |
| `nightChaserStep` / `nightChaserCeiling` | +0.5 / 6 | Chasers added per night after the first (floored: +0, +1, +1, +2…), and the most |
| `nightSpecialStep` / `nightSpecialCap` | 0.03 / 0.20 | Special-zombie chance per night and its cap, in place of the Specials group's 0.012 / 0.08 |
| `lateAmmoFromNight`, `lateAmmoChance`, `lateAmmoMin`/`Max` | 2, 0.5, 2–5 | From Night 2, half the dead leave 2–5 rounds where they fall (`drop:rounds:<id>`) |
| `dawnAmmoCaches` | 2 | Each dawn from Day 3, two containers already searched and emptied hold 2–5 rounds again |

Special zombies are rolled when a zombie appears. Under Today the population stops growing at Night 2, so few new
zombies appear and the rising chance was barely felt (0.3–0.7 alive at once). With the population rising every night
there are new rolls, and Expert bots met 1.1, 2.1 and 3.2 specials at once on Nights 3, 4 and 5.

### Before and after (small sample)

5 presets × 12 seeds × 5 nights on main 8b6d70d2 (with Recipe Board crafting), `--today` against the defaults. These
are 60 runs each, so treat them as indicative. Each cell is the fraction alive at that dawn.

| Preset | Today median nights | D1 | D2 | D3 | D4 | D5 | Rising median nights | D1 | D2 | D3 | D4 | D5 |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| Novice | 0.60 | 8% | 0% | 0% | 0% | 0% | 0.85 | 50% | 0% | 0% | 0% | 0% |
| Casual | 1.79 | 67% | 50% | 25% | 17% | 17% | 1.41 | 92% | 42% | 0% | 0% | 0% |
| Skilled | 4.60 | 92% | 75% | 67% | 58% | 50% | 2.38 | 100% | 75% | 42% | 42% | 17% |
| Expert | 5.01 | 83% | 75% | 67% | 67% | 67% | 4.08 | 100% | 67% | 67% | 50% | 33% |
| Perfect | 5.01 | 100% | 100% | 92% | 83% | 83% | 4.52 | 100% | 100% | 83% | 67% | 42% |

Skilled bots while alive, Night 1 → Night 5:

| | Today | Rising |
| --- | --- | --- |
| Living zombies | 11 → 15 → 16 → 16 → 16 | 7 → 18 → 22 → 25 → 27 |
| Night chasers | 2.0 → 2.4 → 2.8 → 2.8 → 2.6 | 1.0 → 2.6 → 3.9 → 3.9 → 4.8 |
| Specials at once | 0.3 → 0.3 → 0.4 → 0.5 → 0.3 | 0.1 → 0.5 → 0.7 → 2.0 → 1.1 |

Ammo picked up on Day 3 and later rose from mostly zero to roughly 0.5–1.8 rounds a day for the bots. They rarely kill,
so a player who fights will find more. A first draft with +4 zombies and +1 chaser per night and no Night 1 population
cut was a cliff at Night 2 (Skilled alive at dawn 2: 92% → 33%).

The CI bands moved with D-40 in the same change: the Night 1 hold (chasers ≤ 2), Night 2 population above 16,
Night 3 over Night 2 (living and aware) and Night 3 chasers ≥ 3 all fail with the night ramp off.

## What it showed before D-40 (2026-10-19)

Small sample on main with special zombies, flares, dogs, bodies and Lights Out: 5 presets × 12 seeds × 5 nights
(`--seeds=12 --nights=5`), 60 runs. Treat the numbers as indicative.

| Preset | Median nights | Alive at dawn 1 | dawn 2 | dawn 3 | dawn 4 | dawn 5 |
| --- | --: | --: | --: | --: | --: | --: |
| Novice | 0.54 | 0% | 0% | 0% | 0% | 0% |
| Casual | 2.20 | 83% | 58% | 25% | 25% | 25% |
| Skilled | 3.17 | 100% | 100% | 58% | 42% | 42% |
| Expert | 2.21 | 92% | 75% | 42% | 42% | 42% |
| Perfect | 5.01 | 100% | 92% | 83% | 83% | 67% |

- The director's ramp ends by Night 2: living zombies reach 16.0 (the solo population) and stay there; night chasers
  sit at 2–2.9 against the cap of 3. Aware zombies at night are about 4.5 on Nights 2–5 with no rise.
- Nights beat days clearly (aware zombies 2× by night) and the Night 1 ramp-in is smooth (2 → 9–12 zombies).
- Novice bots never survive Night 1 (all 12 die 2.5–9.7 game hours after dusk, 17.5 damage per game hour).
- Deaths cluster on Night 2–3; anyone alive after Night 4 rarely dies after it.
- Expert bots do worse than Skilled (median 2.21 vs 3.17 nights): they spend less time indoors on Night 1 and take
  more hits there. That is bot behaviour, not game difficulty, but it makes Expert a weak upper reference.
- Ammo found after Day 2 is near zero for every preset; Casual is out of ammo from Night 1 on.
- Specials average 0.2–0.8 alive at once.

The tuning question (how nights 1–3 and later should ramp) is decision D-40 on the arcade board.
