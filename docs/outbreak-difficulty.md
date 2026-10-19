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
