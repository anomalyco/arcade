# Carrier sound credits

| Asset | Author | Source | Licence | Changes |
| --- | --- | --- | --- | --- |
| `v3/<slot>-<n>.ogg` sound effects (every slot in `src/audio/sfx-slots.ts` except `radio-*`) | Generated with ElevenLabs Sound Effects v2 (`eleven_text_to_sound_v2`), prompts in `sfx-slots.ts` | https://elevenlabs.io | ElevenLabs commercial sound-generation license (Anomaly's paid plan) | Trimmed, crossfade-looped (beds), loudness-normalised, Ogg Opus (`scripts/sfx-cinematic.ts`) |
| `v3/radio-<line>-<n>.ogg` radio chatter (10 lines, 2 takes each) | Generated with ElevenLabs text to speech (`eleven_v4`), ElevenLabs library voices "Rolando" (the carrier), "Jerry B. - Military Commander" (wingman) and "Eryn – Strong Female Military Commander" (controller); lines in `sfx-slots.ts` | https://elevenlabs.io | ElevenLabs commercial text-to-speech license (Anomaly's paid plan) | Trimmed, normalised to -16 LUFS (true peak ≤ -1 dBTP), Ogg Opus (`scripts/sfx-cinematic.ts`); the game plays them through a procedural radio filter (`src/audio/radio.ts`) |

Everything else Carrier plays (engines, guns, wind, the radio's squelch and static) is synthesized in code.
