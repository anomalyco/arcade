# Barbara: one night

One night is a whole game: 15–20 minutes, 2–6 friends (or you and bots), a trail of five things Barbara left behind,
and a clock you only see on your watch and in the sky. Act 1 is still the story (STORY.md); this file is the rules.

## The goal

Follow Barbara's trail up to the radio tower, the red light on the ridge everyone can see from camp, before dawn. The
night is won when somebody reaches the last clue there: one strip of tape on a trunk, where a voice called "Over here!"
from. It's lost when dawn comes first, or when every torch in the party is dead.

## The trail

STORY.md's five key moments, in order. Each one tells you where to look next.

| # | Clue | Where | What it tells you |
|---|---|---|---|
| 1 | **Her car**, unlocked now, a pink donut box on the passenger seat | The gravel lot at the head of the old path, by camp. The only clue near camp. | Two sets of footprints leave the lot: two bearings, no distance, one to the page, one to the badge. |
| 2 | **A page from her appointment book** ("Sunday 17: 11:00 Hike? 6:00 R."), tied to a trunk with orange tape that isn't ours | 70–110 m out along the first bearing | A bearing from there to the cassette |
| 3 | **Her ID badge** on a snapped lanyard, in the creek mud | 70–110 m out along the second bearing, in the lowest ground near there | A bearing from there to the cassette |
| 4 | **Her tape recorder** | Where the page's and the badge's bearings cross | Barbara's voice: she was walking up to the radio tower, the one with the red light |
| 5 | **The extra searcher's strip** | On a trunk 12–26 m from the ridge light, on the camp side | A voice calls "Over here!" from where none of the six are. There's only one strip of pink tape, tied the way Walt ties it, and nobody. Act 1 ends; the mystery stays open. |

The fork after the car is the point. One bearing alone means walking a line and sweeping either side of it; two
bearings ruled on the same map cross at the cassette. A party that splits into pairs, one pair per bearing, and then
tells each other what they found gets there much faster. A party that stays together can still win, but the clock gets
tight.

The ridge light is fixed (`world.ridgeLight`), so the destination is the same every night; the car's bearings, the
page, the badge and the cassette move with the seed. Kit's playtest: both players walked towards the red light and
wondered what it was, so the tape names it.

### The extra searcher

After the cassette has played and six seconds have passed, the call is armed. It comes the first time a person is
within 110 m of the ridge light (`CALL_NEAR`), or 180 s after the tape whoever is near (`CALL_LATE`), then every 45 s
(`CALL_EVERY`) until someone reaches the strip. It's Walt's voice (`night.walt.extra.1`), shouted from the strip
through the voice bus like every line, so it's faint or silent far away. Once it has called, everyone's goal line and
every bot go to the strip.

### Placement

`placeNight(world, seed)` in `shared/night.ts` places every clue and the spare batteries from the night's seed alone,
with only + − × ÷ √ and the seeded generator, so solo, a room and a replay of the same seed are the same night. Rules:

- The car is at the lot (a few metres of jitter). Everything else is at least 62 m from camp.
- The strip comes first: a trunk 12–26 m from the ridge light on the side you come up from (no trunk: a clear spot).
  The cassette sits 50–62% of the way from the car to it, 10–40 m to one side.
- The page and the badge are 35–55° either side of the car→cassette line, 70–110 m from the car, so the bearings from
  them cross at the cassette at a usable angle (`tests/night.test.ts` checks the crossing lands within 10 m over 60
  seeds).
- The page is tied to the nearest trunk within 5 m of its point, on the side facing the car (else a stake). The badge
  slides to the lowest ground within 3.5 m (`lowest`, the creek mud).
- Every clue stays `EDGE_MARGIN` (40 m) inside the world's edge, clear of the boundary, and out of deep water; anything
  placed on the ground steps clear of trunks.
- Solo plays the browser's next night (`barbara.night` in local storage, counted when a night ends); `?night=N` replays
  the end card's "Night N". A room seeds from its code and the number of nights it has played.

### Finding one

You must be within 4.5 m (7 m for the car) with your torch lit and on it: the clue at its own height (the page and
strip at chest height, the badge and recorder on the ground) within 0.45 rad (about 26°) of the view axis
(`seesClue`). Bots follow the same rule.

- **Everyone** gets a short caption ("Tess found her ID badge. Ask them where it points.") and hears the finder's
  searcher react in their own voice from where they stand, through the voice bus like every line (far away it's faint
  or nothing).
- **Only the finder** gets the clue on their held map: a red-pencil ringed cross with a word, and its bearing ruled out
  as a dashed red line with an arrowhead; the cassette's lead runs to the ridge light with "she was going up here (red light)" under it. The finder's caption reads the lead ("Drag marks in the mud lead north-east, about 45°."). Everyone else
  has to be told, by voice chat, or by standing together with maps up (comparing maps copies clues, as it already copies
  paths and tape). Bots tell each other when they meet.
- The cassette plays once, a few seconds after it's found, from the finder's hand (Barbara's voice, band-limited with
  wow and hiss). Whoever is near hears it; the rest hear about it.

## The goal line

Kit's playtest: "We have to make it clear what the goal is… there are no clues." So a small line at the top left
(`#goal` in `index.html`) reads FIND BARBARA and, under it, the next step in plain words from `nextStep` in
`shared/night.ts`: from your own map's clues, friends' finds you haven't got yet, and the extra searcher's call. For
example "Start at her car in the lot by the trailhead", "Two trails leave her car: north-east and west. Split up and
follow them", "Rule both bearings on your map (G): her tape recorder is where they cross", "She was going up to the
radio tower, the red light on the ridge. Head for it". It shows from the opening on, hides while the map is up, and is
never a timer.

## Tape

The flagging tape marks ground you've searched. When the search starts a toast teaches it once: "Tie tape on trunks
where you've searched (hold E). The debrief maps the ground your tape covered." The debrief draws every tape left up
with a 12 m pink sweep round it (`TAPE_COVER`), totals the area and its share of the woods within 140 m of camp, and
counts each searcher's tapes. Bots tie tape as they search, so theirs counts too.

## The clock

- Dawn comes `dawnMinutes` (default 18) after the night starts: Lab › Search, solo; a room runs the default.
- The night starts when the first person walks out of camp, so a room can gather first.
- No HUD timer. The time is on the **watch** on your left wrist, worn face-in over the glove's cuff, which you see when
  you raise the map: a black field dial with luminous hour bars and hands, running from 12:40 AM to 6:40 AM (civil
  twilight on 17 November). Two minutes before dawn a searcher says it's getting light. Over the last four minutes the
  **sky greys** (`DawnSky` in `src/night-view.ts`): the forest look's sky glow, skylight and mist glow rise to 40×, 30× and
  12× their night values.

### Torches

- Each torch has one battery, which drains only while lit: `batteryMinutes` (default 8) of light.
- Below 25% it sputters more often and for longer; below 12% the beam browns out towards a third; at 0 it's dead.
- A dead torch with a spare in your pocket swaps itself: `swapSeconds` (4 s) in the dark, fumbling.
- **Spares are scarce**: three on the mess-hall table and one or two out along the trail. You carry at most one; walk over
  one to pocket it.
- Four torches lit all night need about nine batteries, and there are seven or eight. Two people walking together can
  run one torch between them. That's the other reason to pair up.

## Win, lose, debrief

- **Win**: the strip is found ("OVER HERE"; Barbara is still out there). **Lose**: dawn arrives first, or every torch is dead with no spare in anyone's pocket for
  20 s.
- A few seconds later (the last words said) the **end card** (`src/night-hud.ts`): the night, the watch time and how
  long the search took, each clue with who found it and when (and what it said), or "not found". The pointer is freed.
- **See the debrief**: the survey square with every searcher's path in their colour and distance walked, the ground
  their tape covered in pink, every clue numbered (red if found, with the bearing it gave; grey if missed), the lake,
  the path, camp and the radio tower. The paths and tapes come on the end event (`Debrief`), paths thinned to 300 points
  each.
- **Search again** starts the next night: solo the next seed from camp; in a room anyone can start it once the night is
  over (`again`), and the room puts everyone back at camp with fresh torches and clean maps. **Keep walking** goes back
  to the woods; Tab brings the card back.

## Bots

Bots are searchers too (Walt, Joyce, Gary, Dale, Tess) and follow the same rules: same beams, batteries, find rule and
maps.

- Everyone knows where the car is, so the first bots out check it.
- After that a bot works the leads on its own map (`botWaypoint`): an open bearing line (zigzag out along it 4 m either
  side, 6 m steps), a crossing of two lines (spiral round it), or the ridge light from the cassette (spiral out to 28 m). Once the extra searcher has called, they all go to the
  strip. Bots
  spread over the open leads rather than all taking one.
- Searching, a bot walks at 0.55 of its pace with its beam low and swinging, and stops 1–2.5 s at each point of a
  sweep to work the ground round it with its beam. Walked into a trunk, boulder or wall without
  getting closer, it steps round it (the other way each time) and skips that point after three goes.
- When a bot finds something it says so, holds its beam up for a few seconds, then moves on.
- A bot walking within 5 m of a lit friend (a person, or a bot ahead of it in the list) turns its own torch off. A bot
  with no light and no spare goes for one on the mess table, or keeps by a lit friend.
- Measured (`scripts/night-sweep.ts`, seeds 1–16, you standing out of camp with your torch off): bots alone win 16 of 16
  nights, median 14.9 minutes, slowest 17.1, against 18-minute dawn. Most of that is the climb to the ridge waiting on
  the late call; you heading up and helping is what gives the night slack.

## Sim and wire

- `shared/night.ts` owns the night: placement, finds, batteries, spares, the clock, win and lose. `stepWoods` calls
  `stepNight` once a tick after everyone moves. Placement has its own seeded stream; stepping draws no random numbers,
  so the voices', distant sounds' and creature's schedules are unchanged.
- `WoodsState.night`: `seed, layout, phase ("camp" | "search" | "won" | "lost"), start, dawn, end, reason, finds, taken,
  dark, tapeAt/tapeBy, dawnSaid, callAt, calls, bots, rev`. The layout carries `ridge`; clues carry `h` (height above the
  ground) and `tree` (the trunk tied to, or −1). Per player: `charge`, `spare`, `swap`, `isolated`, `capture`; maps gain
  `clues`.
- Events: `clue-found`, `spare-taken`, `torch` (`low`, `dead`, `swap`, `fresh`), `night` (started; won or lost with the
  debrief). The voice director reacts to `clue-found` with the clue's own pool and says `dawn`/`daylight`; `sayTape`
  plays the cassette and `sayExtra` the extra searcher's call. The strip is drawn as a real tape (`nightTapes` in
  `src/night-view.ts`, through `TapeView`).
- Wire: `Snapshot.night` (`NightWire`: seed, phase, times, finds, taken) when its rev changes; a client places the layout
  from the seed itself. Player rows gain the charge (and `spare`/`swap` bits); map deltas gain `clues`. A new night's
  seed makes the room resend everything, and the client takes its position outright.

## Voices

- 36 lines in `public/audio/night/` (856 KB): each searcher's reaction to each clue, dawn and daylight lines, Barbara's
  tape, and Walt's "Over here! Over here!" for the extra searcher. `scripts/audio/night-voice-specs.ts` directs them; `scripts/audio/night-voices.ts generate|stt|build`
  makes them the same way as the searchers' lines (Eleven v4, premade voices, stability 0.45, the same loudness
  classes; Barbara is Bella), adds the tape treatment, and writes `shared/night-lines.gen.ts` and
  `src/audio/night-voice-files.ts`. Work files in `$TMPDIR/opencode/barbara-night-voice`.

## Hooks for later

- **Isolation** (`Player.isolated`): seconds a person has had their own torch off or dead with no lit walker within
  25 m. The spider reads it; nothing else does yet.
- **Capture** (`Player.capture`): `null` today. When something sets it (`{ by, left }`), that walker can't move, their
  torch is out and they count as out for the torch-loss rule. Rescue is for the spider's branch.
