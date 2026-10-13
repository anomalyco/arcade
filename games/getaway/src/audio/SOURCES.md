# Audio sources

The new engine, tyre, nitro, shift, blow-off and overrun sounds are original synthesis in `synth.ts`.
The three-second deterministic noise buffer and periodic-wave coefficients are generated in memory;
no recording, downloaded sample, external code or paid generation service was used for them.

Existing `public/sfx/` files remain the source of impact, scrape, siren, city, flat-tyre and UI sounds.
This change adds no sample files and does not change their provenance. `audio=old` keeps the existing
engine/tyre/nitro recordings for comparison through the common protected master bus.

Design references (not copied implementations):
- Antonio-R1, [Engine Sound Generator](https://github.com/Antonio-R1/engine-sound-generator), MIT.
- Ange Yaghi, [Engine Simulator](https://github.com/ange-yaghi/engine-sim), MIT.
- [Vehicle Engine Design: Project CARS, Forza Motorsport 5 and REV](https://designingsound.org/2014/08/11/vehicle-engine-design-project-cars-forza-motorsport-5-and-rev/).
- Audiokinetic, [Engine Sound Modeling](https://www.audiokinetic.com/en/community/blog/engine-sound-modeling-from-sampling-to-granular-synthesis-in-wwise).

## Offline proof

From `games/getaway`, run `bun src/audio/prove.mjs --fixture` in an isolated worker browser.
It captures the seed-7 benchmark chase at fixed 30 Hz, records the exact views/controls/events,
then schedules both mixers into `OfflineAudioContext`. A real-time `AudioContext` constructor
is blocked, and Chromium also has `--mute-audio`. No speaker or microphone is used.
Outputs live in `src/audio/proof-output/` (untracked). WAVs are raw mixer outputs, not post-normalized.
The phone clip uses the same frame sequence and the new WAV, with hardware H.264 and AAC.

The spectrogram has legacy above, procedural below, on identical log-frequency/level scales.
The final chase measures −16.04 LUFS integrated, −4.28 dBTP and zero clipped samples.
Control-scheduling median/p95: 0.10/0.20 ms on the Studio, one run at coarse browser timer resolution.
This does not measure native audio-thread CPU or establish mobile-device performance.
The discontinuity report records adjacent-sample, isolated-sample and control-boundary deltas;
none is a substitute for listening. All verification here was silent/offline.
