# Outbreak difficulty ramp

Survivor bots (`games/outbreak/shared/survivor-bot.ts`, presets Novice, Casual, Skilled, Expert, Perfect) play
deterministic headless games, and a read-only probe records what happened in each game hour. Two tools use it:

| Tool | What | When |
| --- | --- | --- |
| `games/outbreak/tests/difficulty-ramp.test.ts` | 4 presets × 4 fixed seeds to dawn 3 on up to 4 workers (~4 s on Studio, ~20 s on CI), curves held inside tolerance bands | Every `bun run check` and CI |
| `games/outbreak/scripts/difficulty-ramp.ts` | Any presets × seeds × nights, `report.md`, JSON and PNG charts | By hand, before and after a difficulty change |

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

## What it showed (2026-10-19)

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
