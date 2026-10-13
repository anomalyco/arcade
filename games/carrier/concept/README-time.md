# Time of day: concept targets

Painted over real captures of the current game (seed 7, `scripts/daynight-shot.ts`, M4 Max). The original captures are
in `captures/daynight/base/{chase,jet,reef,wide,sun}.png`. The concepts are `concept/time-<view>-<time>.png`.

| view | golden | dusk / sunset | night | storm night | dawn |
| --- | --- | --- | --- | --- | --- |
| chase (behind the carrier) | `time-chase-golden` | `time-chase-dusk` | `time-chase-night` | `time-chase-storm` | `time-chase-dawn` |
| jet near an island | | `time-jet-dusk` | `time-jet-night` | | |
| reef shelf from above | `time-reef-golden` | | `time-reef-night` | | |
| wide archipelago | | | `time-wide-night` | | |
| low, toward the sun | | `time-sun-sunset` | `time-sun-night` | | |

## Rules (shared with Blackout's night look)

- Night is dark navy, never pure black. The horizon stays lighter than the zenith so islands read as silhouettes.
- Practical lights (deck, nav lights, afterburners) carry the strong, saturated colour, with bloom. Everything else is cool.
- No extra fog or haze at any time of day (the user turned down weather fog). Keep haze at or below the day value.
- Reefs stay readable at night as moonlit teal shapes, as `time-reef-night` and `time-wide-night` show.
- The glitter path follows the low light: orange-gold at golden hour, narrow hot orange at sunset, silver at night.

## Palette per time (linear HDR targets, compared with today's `ATMOSPHERE`)

Today (noon): zenith `0.03,0.15,0.66`, horizon `0.45,0.68,1.0`, sun `1,0.93,0.8` × 3.1, ambient 0.6, fog 7e-5.

| | sky zenith | sky horizon | key light (colour × intensity) | ambient | water deep / shallow | glitter, foam | grade |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dawn (sun −4…+3°) | periwinkle `0.07,0.10,0.30` | rose-peach `0.80,0.55,0.55` | sun `1,0.62,0.55` × 0.9 | 0.40, lilac | steel blue / soft teal | pale pink-gold; foam lilac-white | exposure +0.2 stop, warmth −0.05, last stars at the top |
| noon | unchanged | unchanged | unchanged | 0.6 | unchanged | unchanged | unchanged |
| golden (sun 5…14°) | clear blue `0.05,0.17,0.55` | peach-gold `0.95,0.66,0.40` | sun `1,0.70,0.40` × 2.6, long blue-violet shadows | 0.50 | rich blue / turquoise warmed to green-gold | wide orange-gold path; foam warm cream | warmth +0.15, saturation +5% |
| sunset / dusk (sun +2…−5°) | violet-indigo `0.10,0.05,0.28` | hot coral `1.0,0.42,0.22`, magenta above it | sun `1,0.45,0.18` × 1.2 | 0.32, violet | indigo-purple `0.10,0.06,0.22` / violet-teal | narrow hot orange streak; foam peach | warmth +0.1, lights fade in below +4° |
| night, clear | navy `0.010,0.018,0.060` | steel blue `0.035,0.06,0.13` | moon `0.62,0.75,1.0` × ~0.5 | 0.22, navy tint | navy `0.01,0.025,0.07` / moonlit teal `0.03,0.17,0.22` | long silver path; foam pale blue-white, slightly self-lit | exposure +0.6 stop, saturation 0.9, warmth −0.1, bloom up; stars on |
| night, storm | slate navy `0.012,0.016,0.03` (low cloud deck) | grey-navy `0.03,0.04,0.06` | none: lightning is the key light (cool violet-white flash) | 0.18 | dark navy-grey | torn white streak foam lit by flashes | like clear night, no moon or stars |

The moon sits roughly opposite the sun, follows its phase, and is drawn as a disc with a cool halo, like the sun
disc's `sunView`. Stars fade with sky brightness and hide behind clouds and overcast.

## Night lights (from the concepts)

- Carrier: white deck-edge lights outlining the flight deck, amber centreline and landing-area lights, warm yellow
  bridge windows on the island, red port and green starboard nav lights, a white masthead light, and a soft warm pool of
  light on the deck.
- Jets: red nav light on the left wingtip and green on the right, a white anti-collision strobe on the tail, and much
  brighter afterburners at night (orange-white cores, blue shock diamonds, glow reflected on the sea).
- Islands (optional): a few tiny warm points (huts, campfires) on the bigger islands.
- Reef surf (optional): faint cyan self-lit foam on the reef edges at night (`time-reef-night`).

## As built (phase B)

- Code: `shared/daycycle.ts` (clock, sun and moon, overrides), `src/render/daynight.ts` (palettes `DAYNIGHT_PALETTE`,
  moon `MOON`, sky bending `DAYNIGHT_SKY`), `src/render/stars.ts`, `src/render/lights.ts`, `src/render/daynight-wgsl.ts`
  and the TIME debug tab `src/render/daynight-lab.ts`. Live tuning: `carrier.daynight.palette`, `carrier.stars.look`,
  `carrier.lights.look`.
- Palette keys sit on the true sun elevation, from −15° (night) to +25° (the live sunny base). The table above was the
  starting point. The built values are a little more saturated at dusk, with brighter night water and moon glitter, so
  reefs stay readable.
- No island lights, per the review. Reef surf glows soft cyan at night only (`nightSurf`), not at dusk.
- Captures and comparisons with the concepts: `captures/daynight/b*/` and `captures/daynight/cmp/`.
