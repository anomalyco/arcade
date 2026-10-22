# Woods credits

## Sound

- Every file in `audio/` was generated with ElevenLabs `eleven_text_to_sound_v2` on Kit's account under the ElevenLabs commercial sound-generation licence (Anomaly), then trimmed, loop-crossfaded, loudness-normalised and encoded to Ogg Opus by `scripts/audio/sounds.ts`. The prompt, take, request id and measured loudness of each file are in `src/audio/files.ts`.
- The forest room tone, the string lights' buzz and the forest reverb impulse are original synthesis in `src/audio/soundscape.ts`.
- Footsteps are the shared original synthesis in `@arcade/kit/audio/footsteps`; torch clicks, pings and pack sounds come from the shared kit library (its own credits in `packages/kit/audio/library-files.ts`).

## Voices

- The searchers' lines in `audio/voice/` were generated with ElevenLabs Eleven v4 text-to-speech on Kit's account under the ElevenLabs commercial licence (Anomaly), with premade voices (Bill, Matilda, Callum, Chris, Sarah, Will), then trimmed, levelled by how loud each line is said and encoded to Ogg Opus by `scripts/audio/voices.ts`. Each file's directed text, voice, request id and loudness are in `src/audio/voice-files.ts`.
- Barbara K. Nakamura and the case are Alan's (https://vaprdev.github.io/nakamura-case-file/).

## Map

- `map/paper-wear.jpg` (aged sheet with stains and a coffee ring) and `map/paper-fibre.jpg` (paper fibre, used as a normal map) were generated with OpenAI `gpt-image-2` on Anomaly's account (2026-10-22); prompts are logged in the gallery round `woods-2026-10-21/map/materials/generations.jsonl`. Generated images are ours to use.
- Everything printed on the sheet (contours, water, woodland, grid, lettering) and the compass markings are drawn in code from the shared world (`src/held-map/print.ts`, `compass-face.ts`); the pencil layer comes from each player's map knowledge (`pencil.ts`).
