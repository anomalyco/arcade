# Woods credits

## Night sky

- Yale Bright Star Catalogue, public-domain JSON conversion by aduboisforge: https://github.com/aduboisforge/Bright-Star-Catalog-JSON
- NASA SVS CGI Moon Kit (2019), Ernie Wright / NASA LRO–LROC: https://svs.gsfc.nasa.gov/4720/
- Source hashes and conversion notes: `packages/kit/sky/assets/CREDITS.md` and `sources.json`.

## Barbara's car

- "Kiri '86 - Low poly model" (a generic mid-80s Japanese saloon) by Daniel Zhabotinsky (https://sketchfab.com/DanielZhabotinsky), https://sketchfab.com/3d-models/5c17c582ef9549798f694b660feea42a, CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Repainted, weathered, re-merged and reduced for the game; details in `car/CREDITS.md`.

## People

- The realistic searchers are the shared kit cast, `packages/kit/people/assets/CREDITS.md`: MakeHuman/MPFB 2 bodies and clothes (CC0), the CMU Graphics Lab Motion Capture Database walk and run (http://mocap.cs.cmu.edu), and the five Microsoft Rocketbox avatars the searchers wear by default (MakeHuman with Lab › Friends › People model or `?cast=makehuman`), `Male_Adult_05`, `Female_Adult_04`, `Male_Adult_04`, `Female_Adult_07` and `Male_Adult_07` (https://github.com/microsoft/Microsoft-Rocketbox), under this licence:

```
MIT License

Copyright (c) 2020 Microsoft

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Sound

- Every file in `audio/` was generated with ElevenLabs `eleven_text_to_sound_v2` on Kit's account under the ElevenLabs commercial sound-generation licence (Anomaly), then trimmed, loop-crossfaded, loudness-normalised and encoded to Ogg Opus by `scripts/audio/sounds.ts`. The prompt, take, request id and measured loudness of each file are in `src/audio/files.ts`. The uncanny tier (`far.howl`, `far.taken`, `far.mimic`, `far.echo`, `far.climb`, `far.stop`) is edited together offline by `scripts/audio/uncanny.ts` from generated takes of the same kind and, for the mimic and the echo, from the searchers' lines and the loon; each file's ingredients are listed in its provenance.
- The forest room tone, the string lights' buzz and the forest reverb impulse are original synthesis in `src/audio/soundscape.ts`.
- Footsteps are the shared original synthesis in `@arcade/kit/audio/footsteps`; torch clicks, pings and pack sounds come from the shared kit library (its own credits in `packages/kit/audio/library-files.ts`).

## Voices

- The searchers' lines in `audio/voice/` were generated with ElevenLabs Eleven v4 text-to-speech on Kit's account under the ElevenLabs commercial licence (Anomaly), with premade voices (Bill, Matilda, Callum, Chris, Sarah, Will), then trimmed, levelled by how loud each line is said and encoded to Ogg Opus by `scripts/audio/voices.ts`. Each file's directed text, voice, request id and loudness are in `src/audio/voice-files.ts`.
- The night's lines in `audio/night/` (each searcher's reaction to a clue, dawn, Barbara's cassette, the extra searcher's call and each searcher's cry when taken) were made the same way by `scripts/audio/night-voices.ts`, with the same premade voices and Bella (premade) for Barbara; her tape also gets a band-limit, wow and tape hiss in that script. Each file's directed text, voice, request id and loudness are in `src/audio/night-voice-files.ts`.
- Barbara K. Nakamura and the case are Alan's (https://vaprdev.github.io/nakamura-case-file/).

## Map

- `map/paper-wear.jpg` (aged sheet with stains and a coffee ring) and `map/paper-fibre.jpg` (paper fibre, used as a normal map) were generated with OpenAI `gpt-image-2` on Anomaly's account (2026-10-22); prompts are logged in the gallery round `woods-2026-10-21/map/materials/generations.jsonl`. Generated images are ours to use.
- Everything printed on the sheet (contours, water, woodland, grid, lettering) and the compass markings are drawn in code from the shared world (`src/held-map/print.ts`, `compass-face.ts`); the pencil layer comes from each player's map knowledge (`pencil.ts`).
