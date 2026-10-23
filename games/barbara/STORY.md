# Woods: Find Barbara

Kit picked this over the D-58 goals (Fire Tower, Missing Hiker, Survey Before Dark): "BARBARA! BARBARA where are you."
It replaces them. This file is act 1 only: the mystery stays open, and the hooks at the end are for Kit to choose from.

## Premise

Sunday 17 November 1996, after dark, in the Santa Cruz Mountains above Redwood City.

Barbara K. Nakamura, 38, Groupware Administrator in Executive Systems at Northstar Communications, walked out of
headquarters at 6:42 PM on Thursday the 14th and nobody has heard from her since (case NC-96-1147, Alan's case file).
This afternoon Camp Tamarack's off-season caretaker found her blue 1993 Lexus ES in the camp's gravel lot at the head
of the old survey path, cold, locked, nobody near it. Her appointment book has Sunday down as "11:00 Hike?".

The sheriff's team can't start until morning. A handful of volunteers won't wait: co-workers, her sister, the
caretaker, a retired search-and-rescue man and a student who saw the flyer. They have torches, a photocopied survey
map, a compass and a roll of orange flagging tape. No phones, no radios worth the name. You are one of them.

Tone: a real night search, not a monster movie. People call her name until their voices go, mark where they've been,
lose each other, and keep their voices down when something in the trees doesn't sound right. Silence does most of the
work; nobody narrates.

## Opening beat

1. You start at the trailhead in the camp lot, beside the Lexus, torches coming on around you.
2. Walt, near you: "Alright. Spread out, keep your lights moving, and call her name."
3. The calls start, around you and ahead in the trees: Joyce close by ("Barb! Barbara!"), Gary further up the path,
   Tess off to one side ("Barbara, where are you?"), and one far ahead that comes back off the hills.
4. About five seconds in, the HUD card: **FIND BARBARA**. It fades on its own; you can walk the whole time.
5. Later nights in the same browser get two calls and a shorter card.

## First goal

**FIND BARBARA.** Search the woods by torchlight: mark where you've searched with tape, keep the map, call and listen.
Today's survey markers become "places worth checking" until Kit picks which hooks are the clues (below). The search
has no win state yet: act 1 ends at a clue, not an answer.

## Later key moments (options for Kit)

Each is a short authored beat the voice director can play; pick 2-3 to build next.

1. **The car.** Back at the lot, someone notices the Lexus's driver door is unlocked now, and there's a pink-frosted
   donut box on the passenger seat that wasn't there this afternoon. Gary: "That door was locked. I checked it."
2. **The appointment-book page.** A torn page tied to a trunk with somebody's flagging tape, not ours: "Sunday 17:
   11:00 Hike? 6:00 R." Tess goes quiet. Who is R.?
3. **The badge.** A Northstar ID on a snapped lanyard in the creek mud: BARBARA K. NAKAMURA, EXECUTIVE SYSTEMS. Joyce
   has to sit down.
4. **The cassette.** A portable recorder in the brush, its tape run out. Rewound and played, it's eleven seconds of
   wind and Barbara saying something none of them can make out. (Her voice is a later addition.)
5. **The extra searcher.** A voice answers "Over here!" from where none of the six are, and when the group gets there,
   only the tape: one strip, tied the way Walt ties it.

Parked: developing photos in a darkroom (Alan's idea).

## The searchers

Up to six. Real players take a searcher too (off-mic: they only bark at key moments, a setting); bots and solo play
get the rest, and any searcher nobody is playing is out in the woods as a distant voice. Each voice is a premade
ElevenLabs voice on Eleven v4, directed per line.

| Searcher | Who | Voice brief (ElevenLabs voice) |
| --- | --- | --- |
| **Walt Hendry**, 64 | Retired county search-and-rescue. Runs the line, unhurried, practised. | Weathered baritone, calm; shouts from the chest with long open vowels. (Bill) |
| **Joyce Nakamura**, 44 | Barbara's older sister, drove down from Sacramento. Brittle hope, won't stop calling. | Warm alto held tight; it cracks when she pushes. (Matilda) |
| **Gary Lindqvist**, 58 | Camp Tamarack's caretaker, found the car. Few words, knows the woods' stories, uneasy. | Low, husky, dry; mutters more than he speaks. (Callum) |
| **Dale Pruitt**, 47 | Northstar facilities manager. Talks when he's nervous, bad jokes, big heart. | Ordinary friendly American, a little breathless. (Chris) |
| **Tess Alvarez**, 29 | Executive assistant who sat outside Barbara's office. Sharp, notices things, knows more about "R." than she says. | Clear, quick, controlled; quiet when it matters. (Sarah) |
| **Owen Becker**, 21 | Stanford student from the flyer. Eager, out of his depth, first search. Solo, you're Owen. | Young, light, earnest; his shout breaks a little. (Will) |

Who plays whom: people take Owen, Tess, Dale, Gary, Walt, Joyce in that order; bots take Walt, Joyce, Gary, Dale,
Tess, Owen from what's left.

## Voices in play

- Line pools by context: calling for Barbara, replying to each other, finding tape, a torch dying, hearing something,
  separated and regrouping, spotting a light, a sighting (shaken and quiet), finding something.
- Short exchanges (two or three lines, call and response) are picked by the director; the opening is authored.
- The director (`shared/voices.ts`) runs in the sim on the seeded RNG, so a room hears the same conversation from the
  same places. It keeps the woods mostly quiet: a few lines a minute at most, long silences, nobody over a distant
  sound or a signal.
- Lines are pre-generated (`scripts/audio/voices.ts`); the page never calls ElevenLabs.
