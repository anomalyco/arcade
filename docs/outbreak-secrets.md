# Outbreak: secrets and lore

Kit, before streaming Outbreak (AR-85): "Go through a few passes of extra details, really subtle touches, strange
hidden secrets. Go all out, go a little crazy. Be very thoughtful at the same time."

The rule is the discovery rule ([outbreak-discovery.md](outbreak-discovery.md)): discovered, not told, and the fewer
words the better. Nothing here announces itself. There is no "Secret found!", no journal, no marker. The art rule holds
too ([outbreak-art-direction.md](outbreak-art-direction.md)): colour only inside light, so most of these are things
a torch finds.

Code: `games/outbreak/shared/secrets/` (which secrets a run has and where, the cellar's lock; deterministic, the same
on every client) and `games/outbreak/src/secrets/` (drawing, noticing, the glances, the tally, Lab). Lab: Backquote ›
**Secrets**; `arcade cmd secrets.stage secret=<id>`; station `outbreak-secrets`. Tests: `tests/secrets.test.ts`,
`tests/coop-secrets.test.ts`.

## What happened here

This is never stated in the game. Every secret is a piece of it, and none of them is all of it.

1. **The notice.** Late that summer a crew reopened the old pumping station in the woods north of town, shut since
   before anyone remembered. The water board put a notice through every door: the water would be off for one day. In
   every kitchen somebody circled that day on the calendar, and crossed off the days as they came.
2. **The water.** It came back the next morning tasting faintly of pennies. The dogs would not drink it. People did.
3. **The children.** The children noticed first. They all began to chalk the same picture on their driveways: the
   house, the sun, the family, and beside the house a thin man much taller than the house. Parents hosed the drawings
   away. They came back.
4. **The radio man.** An old man with a mast in his yard heard a station that was not there: between the stations, a
   flat voice reading the same number over and over. He wrote it down. He started a notebook.
5. **The minute.** One night the station's pumps ran up and the power sagged across the whole town at once. Every
   clock on the mains stopped at the same minute. Nobody wound them again. That was the night people began to get up
   in their sleep and walk out into the dark, north.
6. **The faces.** In the houses where someone walked out first, the family scratched that face out of the photos,
   so they would not have to look at it. Nobody crossed off another day on the calendar after that week.
7. **The cellar.** The radio man understood enough to be afraid. He locked what he had worked out in his cellar, under
   a lock only someone who had noticed the same things could open: the hour the clocks stopped, the day on the
   calendars, the number the voice repeats. Then he went north to look for himself, and did not come back.
8. **The tall man.** Never explained. The children drew him before anyone else saw him.

Who noticed first, in order: the dogs, the children, the radio man, everyone else.

## The catalogue

Rarity is per run: a run's secrets are a pure function of the town's seeds (`town.seed`, `town.houseSeed`) and the
Secrets tuning, so the room and every client agree without sending anything. Subtle ones are in every run; nothing
else is. A run always has at least two strange ones (Secrets › Fewest strange per run). Every number below is a
default in Backquote › Secrets; Rarity scale multiplies the strange and hidden chances.

The three numbers behind the cellar are seeded per run, each 1–9: **the hour** every clock stopped at, **the day**
circled on every calendar, and **the number** the radio man's set repeats.

### Subtle (every run; nobody tells you)

| Secret | Where | What you notice | Rewards |
| --- | --- | --- | --- |
| **The circled day** (`calendar`) | A calendar on a kitchen or living-room wall in 55% of homes (fixed per house) | Walk up and look: a month page with the same day circled in red in every house in town, the days before it crossed off, and only two or three crossed off after. Nobody crossed off a day after that week | The day is the cellar's second number |
| **The stopped clocks** (`clock`) | A wall clock in 40% of homes | Every clock in town shows the same time. The second hand twitches and never gets past the same mark | The hour is the cellar's first number |
| **The scratched faces** (`photo`) | A framed family photo on a wall in 35% of homes | In about four in ten of them one face is scratched out with frantic white strokes, never the same family member twice in a row | |
| **The chalk drawings** (`chalk`) | Children's chalk by the front path (or on the driveway) of 22% of homes | A house, a sun and stick figures in pastel chalk. From the second night on, every drawing in town has a thin figure much taller than the house standing beside it, and the sun is coloured in black | |
| **A moving company** (`nod`, 25% of runs) | One moving box in one house, among the others | A stencilled company name on the side: **anomaly**. The game's makers; a stranger reads a removals firm | |

### Strange (rare; uncanny, never a jump scare)

| Secret | Chance | Where and when | What happens | Rewards |
| --- | --- | --- | --- | --- |
| **The tall man** (`tallMan`) | 35% | Outdoors at night, at the edge of a street lamp's or porch light's pool 22–40 m away, ahead of you | A very tall, thin figure standing still and facing you, dark against the light. He is gone the moment he leaves your sight, or when you come within 15 m, or when your torch lands on him. He comes back somewhere else later, never more than once in a few minutes | |
| **The audience** (`audience`) | 25% | One home | Every dining chair in the house set out in rows facing a bare wall, as if for a show. One chair at the front is pushed back, as though someone stood up and walked into the wall | |
| **The lit window** (`litWindow`) | 30% | One home, from dusk | A warm lamp burns in its front window all night, in a town with almost no lamps left on. It goes out when you come within 14 m. Inside there is no lamp, only a chair turned to face the window | |
| **The footprints** (`footprints`) | 35% | One home (the radio man's when he is in this run) | Bare, muddy footprints come up from the road and walk straight into the side wall of the house. Inside, on the other side of the wall, they carry on across the floor and stop | Lead to the cellar when it is in the run |
| **The phone** (`phone`) | 30% | A wall phone in one home's kitchen | At night, when you are in that house with no teammate within 12 m, its handset shakes in its cradle, ringing without a sound. It stops the moment you reach it. Its cord is cut | |
| **The rocking chair** (`rockingChair`) | 30% | A porch at night | A rocking chair on a front porch rocks on its own. It stops dead when your torch finds it or you come within 6 m | |

### Hidden (chains for dedicated players and stream chat)

**The radio man's cellar** (`cellar`, 45% of runs). One home, a short walk from the start, has a radio mast in its
side yard. Inside:

- **His set**, on his table (a desk, bench or counter will do; in a house with none, on the floor by the hatch), its
  dial glowing green. Its needle and dial light pulse in groups, the same count every time, with a long pause
  between: the number the voice repeats.
- **His notebook page** beside it. Look at it: a drawing of a three-dial padlock, with a clock face over
  the first dial, a calendar square over the second and a radio over the third. No words.
- **His own clock and calendar**, stopped and circled like everyone else's, so the chain never depends on finding
  another house.
- **A cellar hatch** in the floor with a three-dial padlock. **E** turns the dial you are on; **hold E** moves to the
  next dial. The three dials show while you stand at it. Set them to the hour, the day and the number and the
  padlock drops open on its own: the lid swings up.
- **Inside**: E takes what he left: a flamethrower, a flare gun, 12 rounds of 9mm and a first aid kit. Then his
  map is held up for a moment: the town in pencil, the pumping station circled to the north, pipes running from it
  to the houses, the houses that went first marked in red, and beside the station, drawn small, the tall man. The
  only explanation the game gives.

The lock's dials and whether it is open are one shared ledger store (`secret:cellar`), so teammates see the dials
turn, a late joiner arrives to the same lock, and Restart or New town shuts it again. Wrong combinations do nothing:
the dials just turn.

**Ultra-rare events** (seeded; most players never see them):

| Event | Chance | When | What happens |
| --- | --- | --- | --- |
| **The procession** (`procession`) | 3% of runs | Night 3, between 03:00 and 03:30, outdoors | A line of nine tall figures walks slowly along the far end of the nearest street, north, out of town, without turning their heads. Light or approach them and the line is gone |
| **The visitor** (`visitor`) | 4% of runs | From the second night, the first time you look through a front door's peephole at night | He is standing right outside, a stride from the door, facing in. Stop looking and open the door: nobody |

## Placement

- **Per-house secrets** (calendar, clock, photo, chalk) roll per building (`hash(seed, houseSeed, building id)`), so
  every client gets the same houses whatever order the chunks stream in. Wall pieces hang on the south face of a wall
  inside the house (the face the camera sees), at eye height, clear of doors, windows and furniture in front.
- **One-house secrets** (audience, lit window, footprints, phone, rocking chair, cellar, the nod) each pick a seeded
  chunk in a ring around the start (−3…5 chunks, about 60–200 m out; the origin block in the classic town), generate it
  with the world generator, and take its first home by seeded order, so the house is fixed before anyone walks there.
  The footprints take the cellar's house when both are in the run.
- **The tall man, the procession and the visitor** are presentation only, each client's own: the dice that decide
  when they appear are seeded from the run and the clock, and where depends on where you stand.

## Noticing and the tally

Each client notices on its own: a wall piece by standing at it and looking (the drawing is held up for a moment, as
pages are), the chalk, the box and the footprints by coming close, the strange ones by seeing them happen, the cellar
by being there when it opens.

On the death card and the escape card, once you have noticed at least one this run, a short row of pencil tally marks
counts them (struck through in fives), and under it a row of small dots, one per secret in the game, filled for each
this browser has ever noticed (`localStorage["arcade.outbreak.secrets"]`). No words. A new run (Restart, New town, a new
room) starts the tally at nothing; the dots stay.

## Lab

Backquote › **Secrets**: **Secrets** (Today = none, On), **Rarity scale**, **Fewest strange per run**, a toggle per
secret, **Force a secret** (puts one in every run, for streams and testing), **Glance time**, **Tall man vanishes
within**, **Forget noticed secrets**, and a **Stage:** action per secret, which puts you in front of it at the right
hour. Offline only; a co-op room plays the defaults.

```
arcade cmd secrets.stage secret=cellar      # calendar, clock, photo, chalk, chalk-late, nod, tallMan, audience,
                                            # litWindow, footprints, phone, rockingChair, cellar, cellar-open,
                                            # procession, visitor, tally
```

## Sound (for the audio pass)

Nothing here plays a sound yet; the audio director has no registration hook for features. Wanted, quietest first:
the stopped second hand's tick, a chair creak for the rocking chair, a soft click as the lit window goes out, the
padlock's dial clicks and the clunk as it opens, the hatch's hinge, and for the radio man's set a voice-less beep on
each pulse. The phone stays silent on purpose.
