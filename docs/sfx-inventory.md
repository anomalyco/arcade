# Sound file inventory

Every sound file in the repository, measured silently by `bun scripts/sfx/inventory.ts` (BS.1770 loudness from 48 kHz PCM decoded with ffmpeg). M-max is the loudest 400 ms window, the level one-shots are matched by. Quality flags: clipped samples, hot peaks above -0.3 dBFS, leading silence over 50 ms, DC offset, very quiet. Regenerate with `bun scripts/sfx/inventory.ts > docs/sfx-inventory.md` and keep this header.

| File | Category | Used by | s | LUFS | M-max | Peak dB | Codec | KB | Quality |
| --- | --- | --- | --: | --: | --: | --: | --- | --: | --- |
| games/blackout/public/sfx/vehicles/crash-crunch-1.mp3 | impact | blackout | 0.44 | -18.8 | -18.8 | -0.8 | mp3 1ch 66k | 4 | ok |
| games/blackout/public/sfx/vehicles/crash-crunch-3.mp3 | impact | blackout | 0.69 | -16.7 | -13.5 | -1.1 | mp3 1ch 77k | 7 | ok |
| games/blackout/public/sfx/vehicles/crash-heavy-1.mp3 | impact | blackout | 0.92 | -15.9 | -12.4 | -1.4 | mp3 1ch 82k | 10 | ok |
| games/blackout/public/sfx/vehicles/crash-heavy-3.mp3 | impact | blackout | 1.08 | -17.4 | -12.9 | -1.0 | mp3 1ch 83k | 11 | ok |
| games/blackout/public/sfx/vehicles/crash-thump-1.mp3 | impact | blackout | 0.42 | -16.0 | -16.0 | -2.8 | mp3 1ch 48k | 3 | ok |
| games/blackout/public/sfx/vehicles/crash-thump-2.mp3 | impact | blackout | 0.40 | -17.5 | -17.5 | -1.0 | mp3 1ch 49k | 3 | ok |
| games/blackout/public/sfx/vehicles/door.mp3 | foley | blackout | 0.54 | -20.3 | -18.1 | -0.9 | mp3 1ch 72k | 5 | ok |
| games/blackout/public/sfx/vehicles/horn.mp3 | vehicle | blackout | 1.79 | -20.0 | -19.4 | -9.5 | mp3 1ch 62k | 14 | ok |
| games/blackout/public/sfx/vehicles/jeep-drive.mp3 | vehicle | blackout (unreferenced) | 3.70 | -19.9 | -19.7 | -7.9 | mp3 1ch 72k | 33 | ok |
| games/blackout/public/sfx/vehicles/jeep-idle.mp3 | vehicle | blackout (unreferenced) | 3.74 | -19.9 | -19.4 | -6.1 | mp3 1ch 74k | 34 | ok |
| games/blackout/public/sfx/vehicles/scooter-drive.mp3 | vehicle | blackout (unreferenced) | 2.58 | -20.0 | -19.1 | -7.4 | mp3 1ch 73k | 23 | ok |
| games/blackout/public/sfx/vehicles/scooter-idle.mp3 | vehicle | blackout (unreferenced) | 2.63 | -19.9 | -19.5 | -5.1 | mp3 1ch 81k | 26 | ok |
| games/blackout/public/sfx/vehicles/skid.mp3 | tyre | blackout | 4.03 | -19.9 | -18.5 | -10.0 | mp3 1ch 74k | 37 | ok |
| games/blackout/public/sfx/vehicles/start.mp3 | vehicle | blackout | 1.60 | -17.9 | -16.1 | -4.4 | mp3 1ch 89k | 18 | ok |
| games/blackout/public/sfx/vehicles/van-drive.mp3 | vehicle | blackout (unreferenced) | 3.53 | -20.0 | -19.7 | -8.7 | mp3 1ch 74k | 32 | ok |
| games/blackout/public/sfx/vehicles/van-idle.mp3 | vehicle | blackout (unreferenced) | 3.27 | -20.0 | -19.2 | -5.7 | mp3 1ch 76k | 31 | ok |
| games/carrier/public/sfx/boom/bomb-water-2.mp3 | impact | carrier (alternate take) | 4.00 | -15.8 | -10.2 | -0.5 | mp3 1ch 96k | 48 | ok |
| games/carrier/public/sfx/boom/far-1.mp3 | other | carrier (alternate take) | 4.04 | -18.1 | -14.2 | -0.5 | mp3 1ch 96k | 48 | ok |
| games/carrier/public/sfx/v3/boat-engine-1.ogg | vehicle | carrier (alternate take) | 6.85 | -20.0 | -19.7 | -11.8 | opus 2ch 90k | 76 | ok |
| games/carrier/public/sfx/v3/boat-engine-2.ogg | vehicle | carrier (alternate take) | 6.85 | -20.0 | -19.5 | -12.5 | opus 2ch 69k | 58 | ok |
| games/carrier/public/sfx/v3/boat-engine-3.ogg | vehicle | carrier (picked take) | 6.85 | -19.9 | -19.7 | -12.4 | opus 2ch 89k | 75 | ok |
| games/carrier/public/sfx/v3/bomb-release-1.ogg | impact | carrier (picked take) | 1.48 | -18.1 | -14.4 | -1.5 | opus 2ch 98k | 18 | ok |
| games/carrier/public/sfx/v3/bomb-release-2.ogg | impact | carrier (alternate take) | 1.48 | -16.0 | -13.0 | -0.8 | opus 2ch 94k | 17 | ok |
| games/carrier/public/sfx/v3/bomb-release-3.ogg | impact | carrier (alternate take) | 1.48 | -17.6 | -14.0 | -1.0 | opus 2ch 87k | 16 | ok |
| games/carrier/public/sfx/v3/bomb-whistle-1.ogg | impact | carrier (alternate take) | 4.00 | -16.0 | -12.9 | -12.7 | opus 2ch 108k | 53 | ok |
| games/carrier/public/sfx/v3/bomb-whistle-2.ogg | impact | carrier (picked take) | 4.00 | -16.0 | -13.8 | -10.9 | opus 2ch 111k | 54 | ok |
| games/carrier/public/sfx/v3/bomb-whistle-3.ogg | impact | carrier (alternate take) | 4.00 | -15.9 | -14.8 | -13.3 | opus 2ch 103k | 50 | ok |
| games/carrier/public/sfx/v3/boom-air-1.ogg | impact | carrier (alternate take) | 6.00 | -16.0 | -12.3 | -5.4 | opus 2ch 83k | 61 | ok |
| games/carrier/public/sfx/v3/boom-air-2.ogg | impact | carrier (picked take) | 5.79 | -16.0 | -11.6 | -3.7 | opus 2ch 78k | 55 | ok |
| games/carrier/public/sfx/v3/boom-air-3.ogg | impact | carrier (alternate take) | 6.00 | -16.0 | -11.4 | -5.9 | opus 2ch 70k | 51 | ok |
| games/carrier/public/sfx/v3/boom-air-4.ogg | impact | carrier (alternate take) | 6.00 | -16.0 | -11.8 | -4.2 | opus 2ch 76k | 55 | ok |
| games/carrier/public/sfx/v3/boom-bomb-land-1.ogg | impact | carrier (picked take) | 6.00 | -16.0 | -11.2 | -0.7 | opus 2ch 87k | 64 | ok |
| games/carrier/public/sfx/v3/boom-bomb-land-2.ogg | impact | carrier (alternate take) | 6.00 | -16.0 | -11.9 | -4.9 | opus 2ch 91k | 67 | ok |
| games/carrier/public/sfx/v3/boom-bomb-land-3.ogg | impact | carrier (alternate take) | 6.00 | -16.0 | -11.5 | -4.2 | opus 2ch 88k | 65 | ok |
| games/carrier/public/sfx/v3/boom-bomb-land-4.ogg | impact | carrier (alternate take) | 6.00 | -16.0 | -10.9 | -2.7 | opus 2ch 95k | 70 | ok |
| games/carrier/public/sfx/v3/boom-bomb-water-1.ogg | impact | carrier (alternate take) | 6.00 | -16.0 | -10.3 | -2.3 | opus 2ch 84k | 62 | ok |
| games/carrier/public/sfx/v3/boom-bomb-water-2.ogg | impact | carrier (alternate take) | 6.00 | -16.1 | -12.6 | -2.2 | opus 2ch 85k | 63 | ok |
| games/carrier/public/sfx/v3/boom-bomb-water-3.ogg | impact | carrier (picked take) | 6.00 | -16.1 | -8.7 | -1.8 | opus 2ch 95k | 70 | ok |
| games/carrier/public/sfx/v3/boom-bomb-water-4.ogg | impact | carrier (alternate take) | 6.00 | -15.8 | -12.5 | -2.7 | opus 2ch 98k | 72 | ok |
| games/carrier/public/sfx/v3/boom-crash-land-1.ogg | impact | carrier (alternate take) | 6.00 | -16.0 | -12.7 | -6.2 | opus 2ch 95k | 69 | ok |
| games/carrier/public/sfx/v3/boom-crash-land-2.ogg | impact | carrier (alternate take) | 6.00 | -15.9 | -11.1 | -4.5 | opus 2ch 91k | 67 | ok |
| games/carrier/public/sfx/v3/boom-crash-land-3.ogg | impact | carrier (picked take) | 5.48 | -16.1 | -10.9 | -3.0 | opus 2ch 96k | 64 | ok |
| games/carrier/public/sfx/v3/boom-crash-land-4.ogg | impact | carrier (alternate take) | 6.00 | -16.0 | -12.8 | -5.7 | opus 2ch 94k | 69 | ok |
| games/carrier/public/sfx/v3/boom-crash-sea-1.ogg | impact | carrier (alternate take) | 5.00 | -15.7 | -13.3 | -7.6 | opus 2ch 87k | 53 | ok |
| games/carrier/public/sfx/v3/boom-crash-sea-2.ogg | impact | carrier (alternate take) | 5.00 | -16.0 | -14.3 | -8.2 | opus 2ch 86k | 53 | ok |
| games/carrier/public/sfx/v3/boom-crash-sea-3.ogg | impact | carrier (picked take) | 5.00 | -16.0 | -10.9 | -5.1 | opus 2ch 87k | 53 | ok |
| games/carrier/public/sfx/v3/boom-crash-sea-4.ogg | impact | carrier (alternate take) | 5.00 | -15.8 | -11.6 | -6.2 | opus 2ch 91k | 56 | ok |
| games/carrier/public/sfx/v3/boom-far-1.ogg | impact | carrier (picked take) | 6.00 | -16.7 | -11.5 | -1.2 | opus 2ch 89k | 65 | ok |
| games/carrier/public/sfx/v3/boom-far-2.ogg | impact | carrier (alternate take) | 6.00 | -15.9 | -11.7 | -3.6 | opus 2ch 89k | 65 | ok |
| games/carrier/public/sfx/v3/boom-far-3.ogg | impact | carrier (alternate take) | 6.00 | -16.3 | -10.2 | -1.3 | opus 2ch 95k | 69 | ok |
| games/carrier/public/sfx/v3/boom-far-4.ogg | impact | carrier (alternate take) | 6.00 | -16.0 | -10.4 | -1.5 | opus 2ch 87k | 64 | ok |
| games/carrier/public/sfx/v3/boom-missile-1.ogg | impact | carrier (alternate take) | 4.00 | -16.0 | -12.7 | -6.9 | opus 2ch 90k | 44 | ok |
| games/carrier/public/sfx/v3/boom-missile-2.ogg | impact | carrier (alternate take) | 4.00 | -16.1 | -13.8 | -8.8 | opus 2ch 90k | 44 | ok |
| games/carrier/public/sfx/v3/boom-missile-3.ogg | impact | carrier (picked take) | 4.00 | -16.0 | -13.3 | -5.4 | opus 2ch 95k | 46 | ok |
| games/carrier/public/sfx/v3/boom-missile-4.ogg | impact | carrier (alternate take) | 3.58 | -16.0 | -13.6 | -8.1 | opus 2ch 88k | 39 | ok |
| games/carrier/public/sfx/v3/carrier-bed-1.ogg | ambience | carrier (alternate take) | 7.85 | -20.0 | -19.5 | -7.9 | opus 2ch 102k | 97 | ok |
| games/carrier/public/sfx/v3/carrier-bed-2.ogg | ambience | carrier (alternate take) | 7.85 | -20.0 | -19.5 | -6.9 | opus 2ch 102k | 97 | ok |
| games/carrier/public/sfx/v3/carrier-bed-3.ogg | ambience | carrier (alternate take) | 7.85 | -20.0 | -19.3 | -8.0 | opus 2ch 102k | 98 | ok |
| games/carrier/public/sfx/v3/carrier-bed-4.ogg | ambience | carrier (picked take) | 7.85 | -20.0 | -19.3 | -10.0 | opus 2ch 104k | 100 | ok |
| games/carrier/public/sfx/v3/ciws-1.ogg | weapon | carrier (picked take) | 4.85 | -20.0 | -19.4 | -12.0 | opus 2ch 90k | 53 | ok |
| games/carrier/public/sfx/v3/ciws-2.ogg | weapon | carrier (alternate take) | 4.85 | -19.9 | -18.7 | -9.0 | opus 2ch 75k | 44 | ok |
| games/carrier/public/sfx/v3/ciws-3.ogg | weapon | carrier (alternate take) | 4.85 | -20.0 | -19.0 | -11.5 | opus 2ch 96k | 57 | ok |
| games/carrier/public/sfx/v3/deck-fire-1.ogg | other | carrier (alternate take) | 5.85 | -20.0 | -19.4 | -9.7 | opus 2ch 97k | 69 | ok |
| games/carrier/public/sfx/v3/deck-fire-2.ogg | other | carrier (picked take) | 5.85 | -19.9 | -18.5 | -7.3 | opus 2ch 86k | 61 | ok |
| games/carrier/public/sfx/v3/deck-fire-3.ogg | other | carrier (alternate take) | 5.85 | -20.1 | -18.9 | -1.1 | opus 2ch 104k | 74 | ok |
| games/carrier/public/sfx/v3/flares-1.ogg | other | carrier (picked take) | 3.00 | -16.0 | -15.6 | -9.1 | opus 2ch 72k | 26 | ok |
| games/carrier/public/sfx/v3/flares-2.ogg | other | carrier (alternate take) | 2.99 | -16.0 | -15.7 | -9.2 | opus 2ch 69k | 25 | ok |
| games/carrier/public/sfx/v3/flares-3.ogg | other | carrier (alternate take) | 3.00 | -16.0 | -13.3 | -7.7 | opus 2ch 78k | 29 | ok |
| games/carrier/public/sfx/v3/flares-4.ogg | other | carrier (alternate take) | 2.96 | -16.0 | -15.0 | -9.3 | opus 2ch 71k | 26 | ok |
| games/carrier/public/sfx/v3/hull-creak-1.ogg | ambience | carrier (picked take) | 5.00 | -15.7 | -12.0 | -3.0 | opus 2ch 94k | 57 | ok |
| games/carrier/public/sfx/v3/hull-creak-2.ogg | ambience | carrier (alternate take) | 4.91 | -16.0 | -11.2 | -1.8 | opus 2ch 88k | 53 | ok |
| games/carrier/public/sfx/v3/hull-creak-3.ogg | ambience | carrier (alternate take) | 4.57 | -15.9 | -11.9 | -2.9 | opus 2ch 84k | 47 | ok |
| games/carrier/public/sfx/v3/hull-slam-1.ogg | impact | carrier (picked take) | 4.00 | -17.1 | -10.9 | -0.4 | opus 2ch 95k | 46 | ok |
| games/carrier/public/sfx/v3/hull-slam-2.ogg | impact | carrier (alternate take) | 2.87 | -16.7 | -11.3 | -0.1 | opus 2ch 93k | 33 | hot peak |
| games/carrier/public/sfx/v3/hull-slam-3.ogg | impact | carrier (alternate take) | 4.00 | -15.9 | -10.9 | -1.2 | opus 2ch 90k | 44 | ok |
| games/carrier/public/sfx/v3/hull-slam-4.ogg | impact | carrier (alternate take) | 4.00 | -17.6 | -12.1 | 0.2 | opus 2ch 96k | 47 | clips 4, hot peak |
| games/carrier/public/sfx/v3/impact-metal-1.ogg | impact | carrier (picked take) | 2.00 | -16.1 | -12.2 | -1.2 | opus 2ch 83k | 20 | ok |
| games/carrier/public/sfx/v3/impact-metal-2.ogg | impact | carrier (alternate take) | 1.57 | -15.9 | -12.8 | -1.5 | opus 2ch 86k | 17 | ok |
| games/carrier/public/sfx/v3/impact-metal-3.ogg | impact | carrier (alternate take) | 1.82 | -16.0 | -12.5 | -6.0 | opus 2ch 94k | 21 | ok |
| games/carrier/public/sfx/v3/impact-water-1.ogg | impact | carrier (alternate take) | 2.00 | -16.1 | -12.9 | -0.8 | opus 2ch 86k | 21 | ok |
| games/carrier/public/sfx/v3/impact-water-2.ogg | impact | carrier (alternate take) | 1.84 | -16.0 | -13.0 | -1.0 | opus 2ch 103k | 23 | ok |
| games/carrier/public/sfx/v3/impact-water-3.ogg | impact | carrier (picked take) | 2.00 | -19.3 | -14.1 | 0.0 | opus 2ch 86k | 21 | clips 1, hot peak |
| games/carrier/public/sfx/v3/lightning-crack-1.ogg | ambience | carrier (picked take) | 1.95 | -16.2 | -14.1 | -1.5 | opus 2ch 122k | 29 | ok |
| games/carrier/public/sfx/v3/lightning-crack-2.ogg | ambience | carrier (alternate take) | 2.45 | -16.0 | -14.0 | -5.0 | opus 2ch 114k | 34 | ok |
| games/carrier/public/sfx/v3/lightning-crack-3.ogg | ambience | carrier (alternate take) | 2.42 | -16.0 | -12.3 | -3.2 | opus 2ch 119k | 35 | ok |
| games/carrier/public/sfx/v3/missile-launch-1.ogg | impact | carrier (picked take) | 4.00 | -15.6 | -11.1 | -3.6 | opus 2ch 91k | 44 | ok |
| games/carrier/public/sfx/v3/missile-launch-2.ogg | impact | carrier (alternate take) | 3.96 | -16.0 | -13.5 | -4.4 | opus 2ch 94k | 46 | ok |
| games/carrier/public/sfx/v3/missile-launch-3.ogg | impact | carrier (alternate take) | 4.00 | -16.0 | -11.3 | -5.7 | opus 2ch 72k | 35 | ok |
| games/carrier/public/sfx/v3/missile-launch-4.ogg | impact | carrier (alternate take) | 4.00 | -16.0 | -12.0 | -6.3 | opus 2ch 89k | 43 | ok |
| games/carrier/public/sfx/v3/missile-motor-1.ogg | impact | carrier (alternate take) | 3.85 | -20.0 | -19.7 | -10.7 | opus 2ch 89k | 42 | ok |
| games/carrier/public/sfx/v3/missile-motor-2.ogg | impact | carrier (picked take) | 3.85 | -20.0 | -19.8 | -11.8 | opus 2ch 89k | 42 | ok |
| games/carrier/public/sfx/v3/missile-motor-3.ogg | impact | carrier (alternate take) | 3.85 | -19.9 | -19.6 | -11.1 | opus 2ch 89k | 42 | ok |
| games/carrier/public/sfx/v3/naval-gun-1.ogg | weapon | carrier (picked take) | 4.00 | -16.0 | -11.6 | -1.6 | opus 2ch 100k | 49 | ok |
| games/carrier/public/sfx/v3/naval-gun-2.ogg | weapon | carrier (alternate take) | 4.00 | -16.0 | -14.0 | -7.2 | opus 2ch 102k | 50 | ok |
| games/carrier/public/sfx/v3/naval-gun-3.ogg | weapon | carrier (alternate take) | 4.00 | -16.0 | -13.2 | -8.4 | opus 2ch 90k | 44 | ok |
| games/carrier/public/sfx/v3/ocean-calm-1.ogg | ambience | carrier (picked take) | 7.85 | -20.0 | -14.9 | -4.5 | opus 2ch 100k | 96 | ok |
| games/carrier/public/sfx/v3/ocean-calm-2.ogg | ambience | carrier (alternate take) | 7.85 | -20.0 | -16.1 | -6.5 | opus 2ch 99k | 95 | ok |
| games/carrier/public/sfx/v3/ocean-calm-3.ogg | ambience | carrier (alternate take) | 7.85 | -19.9 | -15.2 | -3.2 | opus 2ch 99k | 95 | ok |
| games/carrier/public/sfx/v3/ocean-calm-4.ogg | ambience | carrier (alternate take) | 7.85 | -20.0 | -15.0 | -2.3 | opus 2ch 99k | 95 | ok |
| games/carrier/public/sfx/v3/ocean-rough-1.ogg | ambience | carrier (alternate take) | 7.85 | -20.0 | -18.1 | -5.7 | opus 2ch 101k | 97 | ok |
| games/carrier/public/sfx/v3/ocean-rough-2.ogg | ambience | carrier (alternate take) | 7.85 | -19.9 | -15.9 | -4.3 | opus 2ch 99k | 95 | ok |
| games/carrier/public/sfx/v3/ocean-rough-3.ogg | ambience | carrier (alternate take) | 7.85 | -20.0 | -17.6 | -6.6 | opus 2ch 101k | 97 | ok |
| games/carrier/public/sfx/v3/ocean-rough-4.ogg | ambience | carrier (picked take) | 7.85 | -20.0 | -15.5 | -3.9 | opus 2ch 99k | 95 | ok |
| games/carrier/public/sfx/v3/ocean-storm-1.ogg | ambience | carrier (alternate take) | 7.85 | -20.0 | -17.0 | -7.1 | opus 2ch 101k | 97 | ok |
| games/carrier/public/sfx/v3/ocean-storm-2.ogg | ambience | carrier (alternate take) | 7.85 | -20.0 | -17.2 | -8.6 | opus 2ch 100k | 96 | ok |
| games/carrier/public/sfx/v3/ocean-storm-3.ogg | ambience | carrier (picked take) | 7.85 | -20.0 | -16.1 | -5.5 | opus 2ch 100k | 96 | ok |
| games/carrier/public/sfx/v3/ocean-storm-4.ogg | ambience | carrier (alternate take) | 7.85 | -19.9 | -17.1 | -8.0 | opus 2ch 101k | 97 | ok |
| games/carrier/public/sfx/v3/rain-canopy-1.ogg | ambience | carrier (picked take) | 6.85 | -20.0 | -17.9 | -2.5 | opus 2ch 119k | 100 | ok |
| games/carrier/public/sfx/v3/rain-canopy-2.ogg | ambience | carrier (alternate take) | 6.85 | -20.0 | -18.3 | -2.1 | opus 2ch 118k | 99 | ok |
| games/carrier/public/sfx/v3/rain-canopy-3.ogg | ambience | carrier (alternate take) | 6.85 | -20.0 | -17.8 | -2.4 | opus 2ch 119k | 100 | ok |
| games/carrier/public/sfx/v3/rain-heavy-1.ogg | impact | carrier (alternate take) | 6.85 | -20.0 | -19.8 | -10.8 | opus 2ch 104k | 87 | ok |
| games/carrier/public/sfx/v3/rain-heavy-2.ogg | impact | carrier (alternate take) | 6.85 | -20.0 | -19.8 | -10.9 | opus 2ch 103k | 86 | ok |
| games/carrier/public/sfx/v3/rain-heavy-3.ogg | impact | carrier (picked take) | 6.85 | -20.0 | -19.8 | -11.6 | opus 2ch 103k | 86 | ok |
| games/carrier/public/sfx/v3/rain-heavy-4.ogg | impact | carrier (alternate take) | 6.85 | -19.9 | -19.8 | -10.8 | opus 2ch 105k | 88 | ok |
| games/carrier/public/sfx/v3/rain-light-1.ogg | ambience | carrier (picked take) | 6.85 | -22.4 | -19.5 | -1.4 | opus 2ch 108k | 90 | ok |
| games/carrier/public/sfx/v3/rain-light-2.ogg | ambience | carrier (alternate take) | 6.85 | -22.0 | -20.4 | -1.0 | opus 2ch 108k | 90 | ok |
| games/carrier/public/sfx/v3/rain-light-3.ogg | ambience | carrier (alternate take) | 6.85 | -20.8 | -18.8 | -1.9 | opus 2ch 117k | 98 | ok |
| games/carrier/public/sfx/v3/sam-launch-1.ogg | other | carrier (alternate take) | 5.00 | -16.0 | -11.3 | -6.6 | opus 2ch 69k | 42 | ok |
| games/carrier/public/sfx/v3/sam-launch-2.ogg | other | carrier (picked take) | 5.00 | -15.8 | -12.3 | -5.9 | opus 2ch 83k | 51 | ok |
| games/carrier/public/sfx/v3/sam-launch-3.ogg | other | carrier (alternate take) | 5.00 | -16.0 | -12.1 | -7.0 | opus 2ch 82k | 50 | ok |
| games/carrier/public/sfx/v3/ship-horn-1.ogg | vehicle | carrier (picked take) | 5.00 | -16.0 | -15.3 | -10.4 | opus 2ch 104k | 63 | ok |
| games/carrier/public/sfx/v3/ship-horn-2.ogg | vehicle | carrier (alternate take) | 5.00 | -15.9 | -15.4 | -10.9 | opus 2ch 98k | 60 | ok |
| games/carrier/public/sfx/v3/ship-horn-3.ogg | vehicle | carrier (alternate take) | 5.00 | -16.0 | -15.5 | -11.0 | opus 2ch 94k | 57 | ok |
| games/carrier/public/sfx/v3/sinking-1.ogg | ambience | carrier (picked take) | 5.72 | -17.1 | -13.7 | -1.0 | opus 2ch 96k | 67 | ok |
| games/carrier/public/sfx/v3/sinking-2.ogg | ambience | carrier (alternate take) | 5.30 | -15.9 | -13.8 | -2.9 | opus 2ch 91k | 59 | ok |
| games/carrier/public/sfx/v3/sinking-3.ogg | ambience | carrier (alternate take) | 6.00 | -17.5 | -12.8 | -0.9 | opus 2ch 87k | 64 | ok |
| games/carrier/public/sfx/v3/thunder-far-1.ogg | ambience | carrier (picked take) | 7.83 | -18.7 | -12.4 | -0.5 | opus 2ch 90k | 86 | ok |
| games/carrier/public/sfx/v3/thunder-far-2.ogg | ambience | carrier (alternate take) | 7.63 | -16.0 | -11.3 | -1.9 | opus 2ch 96k | 90 | lead 211 ms |
| games/carrier/public/sfx/v3/thunder-far-3.ogg | ambience | carrier (alternate take) | 7.80 | -18.2 | -11.7 | -0.8 | opus 2ch 91k | 87 | ok |
| games/carrier/public/sfx/v3/thunder-far-4.ogg | ambience | carrier (alternate take) | 7.55 | -16.0 | -11.5 | -2.2 | opus 2ch 89k | 82 | ok |
| games/carrier/public/sfx/v3/thunder-near-1.ogg | ambience | carrier (picked take) | 5.93 | -16.0 | -11.8 | -3.1 | opus 2ch 80k | 58 | ok |
| games/carrier/public/sfx/v3/thunder-near-2.ogg | ambience | carrier (alternate take) | 7.00 | -16.0 | -11.1 | -2.5 | opus 2ch 82k | 70 | ok |
| games/carrier/public/sfx/v3/thunder-near-3.ogg | ambience | carrier (alternate take) | 6.32 | -16.0 | -9.8 | -0.7 | opus 2ch 82k | 64 | ok |
| games/carrier/public/sfx/v3/thunder-near-4.ogg | ambience | carrier (alternate take) | 5.47 | -16.0 | -11.0 | -2.2 | opus 2ch 82k | 55 | ok |
| games/carrier/public/sfx/v3/trap-1.ogg | other | carrier (alternate take) | 5.00 | -15.6 | -13.0 | -8.9 | opus 2ch 75k | 46 | ok |
| games/carrier/public/sfx/v3/trap-2.ogg | other | carrier (alternate take) | 5.00 | -15.9 | -13.7 | -10.1 | opus 2ch 79k | 48 | ok |
| games/carrier/public/sfx/v3/trap-3.ogg | other | carrier (alternate take) | 4.76 | -16.0 | -11.6 | -4.8 | opus 2ch 77k | 45 | ok |
| games/carrier/public/sfx/v3/trap-4.ogg | other | carrier (picked take) | 4.71 | -16.0 | -10.0 | -4.4 | opus 2ch 63k | 36 | ok |
| games/carrier/public/sfx/v3/ui-click-1.ogg | ui | carrier (picked take) | 0.48 | -26.0 | -26.0 | -5.3 | opus 2ch 125k | 7 | ok |
| games/carrier/public/sfx/v3/ui-click-2.ogg | ui | carrier (alternate take) | 0.18 | -35.9 | -35.9 | -14.4 | opus 2ch 166k | 4 | very quiet |
| games/carrier/public/sfx/v3/ui-click-3.ogg | ui | carrier (alternate take) | 0.32 | -33.2 | -33.2 | -14.0 | opus 2ch 141k | 6 | very quiet |
| games/carrier/public/sfx/v3/ui-kill-1.ogg | ui | carrier (picked take) | 1.48 | -27.1 | -21.6 | -7.6 | opus 2ch 118k | 21 | ok |
| games/carrier/public/sfx/v3/ui-kill-2.ogg | ui | carrier (alternate take) | 1.48 | -24.3 | -22.0 | -6.7 | opus 2ch 104k | 19 | ok |
| games/carrier/public/sfx/v3/ui-kill-3.ogg | ui | carrier (alternate take) | 1.48 | -26.1 | -21.4 | -9.0 | opus 2ch 114k | 21 | ok |
| games/carrier/public/sfx/v3/water-geyser-1.ogg | other | carrier (picked take) | 5.00 | -16.0 | -12.3 | -4.7 | opus 2ch 78k | 48 | ok |
| games/carrier/public/sfx/v3/water-geyser-2.ogg | other | carrier (alternate take) | 5.00 | -16.0 | -12.8 | -5.9 | opus 2ch 78k | 48 | ok |
| games/carrier/public/sfx/v3/water-geyser-3.ogg | other | carrier (alternate take) | 4.94 | -16.0 | -12.7 | -6.3 | opus 2ch 82k | 49 | ok |
| games/carrier/public/sfx/v3/wind-gale-1.ogg | ambience | carrier (picked take) | 6.85 | -19.9 | -19.1 | -8.6 | opus 2ch 104k | 87 | ok |
| games/carrier/public/sfx/v3/wind-gale-2.ogg | ambience | carrier (alternate take) | 6.85 | -20.0 | -18.7 | -9.4 | opus 2ch 107k | 90 | ok |
| games/carrier/public/sfx/v3/wind-gale-3.ogg | ambience | carrier (alternate take) | 6.85 | -20.0 | -18.6 | -8.8 | opus 2ch 102k | 86 | ok |
| games/carrier/public/sfx/v3/wind-gale-4.ogg | ambience | carrier (alternate take) | 6.85 | -20.0 | -16.4 | -7.9 | opus 2ch 101k | 85 | ok |
| games/carrier/public/sfx/v3/wind-light-1.ogg | ambience | carrier (picked take) | 6.85 | -20.0 | -19.1 | -8.8 | opus 2ch 99k | 83 | ok |
| games/carrier/public/sfx/v3/wind-light-2.ogg | ambience | carrier (alternate take) | 6.85 | -19.9 | -19.7 | -8.9 | opus 2ch 104k | 87 | ok |
| games/carrier/public/sfx/v3/wind-light-3.ogg | ambience | carrier (alternate take) | 6.85 | -20.0 | -19.5 | -10.5 | opus 2ch 104k | 87 | ok |
| games/getaway/public/sfx/bust_sting.mp3 | voice | getaway | 3.48 | -14.4 | -10.1 | -3.7 | mp3 2ch 112k | 49 | ok |
| games/getaway/public/sfx/city_ambience_loop.mp3 | ambience | getaway | 13.38 | -20.5 | -18.4 | -4.8 | mp3 2ch 112k | 184 | ok |
| games/getaway/public/sfx/crash_bump_1.mp3 | impact | getaway | 0.28 | -21.0 | -21.0 | -1.3 | mp3 1ch 96k | 4 | ok |
| games/getaway/public/sfx/crash_bump_2.mp3 | impact | getaway | 0.37 | -19.8 | -19.8 | -1.4 | mp3 1ch 96k | 5 | ok |
| games/getaway/public/sfx/crash_bump_3.mp3 | impact | getaway | 0.21 | -19.7 | -19.7 | -1.3 | mp3 1ch 96k | 3 | ok |
| games/getaway/public/sfx/crash_crunch_1.mp3 | impact | getaway | 0.45 | -19.4 | -19.4 | -1.6 | mp3 1ch 96k | 6 | ok |
| games/getaway/public/sfx/crash_crunch_2.mp3 | impact | getaway | 0.43 | -18.3 | -18.3 | -1.0 | mp3 1ch 96k | 6 | ok |
| games/getaway/public/sfx/crash_crunch_3.mp3 | impact | getaway | 0.70 | -17.1 | -13.8 | -1.4 | mp3 1ch 96k | 9 | ok |
| games/getaway/public/sfx/crash_debris_1.mp3 | impact | getaway | 1.17 | -22.3 | -17.9 | -3.8 | mp3 1ch 96k | 14 | ok |
| games/getaway/public/sfx/crash_debris_2.mp3 | impact | getaway | 0.88 | -23.9 | -19.7 | -1.5 | mp3 1ch 96k | 11 | ok |
| games/getaway/public/sfx/crash_heavy_1.mp3 | impact | getaway | 1.03 | -15.4 | -11.8 | -1.1 | mp3 1ch 96k | 13 | ok |
| games/getaway/public/sfx/crash_heavy_2.mp3 | impact | getaway | 1.04 | -15.3 | -12.2 | -1.1 | mp3 1ch 96k | 13 | ok |
| games/getaway/public/sfx/crash_heavy_3.mp3 | impact | getaway | 1.09 | -17.7 | -13.2 | -1.2 | mp3 1ch 96k | 14 | ok |
| games/getaway/public/sfx/crash_thump_1.mp3 | impact | getaway | 0.42 | -15.2 | -15.2 | -2.0 | mp3 1ch 96k | 6 | ok |
| games/getaway/public/sfx/crash_thump_2.mp3 | impact | getaway | 0.40 | -18.0 | -18.0 | -1.5 | mp3 1ch 96k | 6 | ok |
| games/getaway/public/sfx/crash_thump_3.mp3 | impact | getaway | 0.38 | -17.0 | -17.0 | -0.7 | mp3 1ch 96k | 5 | ok |
| games/getaway/public/sfx/crash_wall_1.mp3 | impact | getaway | 0.61 | -20.8 | -18.1 | -1.1 | mp3 1ch 96k | 8 | ok |
| games/getaway/public/sfx/crash_wall_2.mp3 | impact | getaway | 0.61 | -20.0 | -20.0 | -1.4 | mp3 1ch 96k | 8 | ok |
| games/getaway/public/sfx/crash_wall_3.mp3 | impact | getaway | 0.61 | -22.5 | -19.8 | -1.2 | mp3 1ch 96k | 8 | ok |
| games/getaway/public/sfx/engine_cop_loop.mp3 | vehicle | getaway | 5.48 | -18.4 | -18.2 | -7.9 | mp3 1ch 80k | 54 | ok |
| games/getaway/public/sfx/engine_robber_loop.mp3 | vehicle | getaway | 5.48 | -18.5 | -17.8 | -4.6 | mp3 1ch 80k | 54 | ok |
| games/getaway/public/sfx/escape_tick.mp3 | ui | getaway | 0.80 | -20.0 | -17.8 | -1.4 | mp3 1ch 96k | 10 | ok |
| games/getaway/public/sfx/flat_tire_loop.mp3 | tyre | getaway | 2.63 | -20.5 | -17.5 | -1.2 | mp3 1ch 80k | 26 | ok |
| games/getaway/public/sfx/heli_rotor_loop.mp3 | vehicle | getaway | 5.48 | -18.8 | -17.2 | -1.5 | mp3 1ch 80k | 54 | ok |
| games/getaway/public/sfx/near_whoosh.mp3 | ui | getaway | 1.20 | -17.2 | -15.5 | -2.1 | mp3 1ch 96k | 15 | lead 100 ms |
| games/getaway/public/sfx/nitro_burst.mp3 | vehicle | getaway | 1.60 | -17.1 | -12.5 | -0.5 | mp3 1ch 96k | 20 | ok |
| games/getaway/public/sfx/nitro_rush_loop.mp3 | vehicle | getaway | 4.38 | -18.5 | -18.1 | -5.5 | mp3 1ch 80k | 43 | ok |
| games/getaway/public/sfx/radio/bust_custody.mp3 | voice | getaway | 2.95 | -16.6 | -13.9 | -1.7 | mp3 1ch 64k | 24 | ok |
| games/getaway/public/sfx/radio/bust_driver.mp3 | voice | getaway | 2.65 | -16.4 | -14.2 | -2.0 | mp3 1ch 64k | 21 | ok |
| games/getaway/public/sfx/radio/chase_start.mp3 | voice | getaway | 3.53 | -16.6 | -13.0 | -1.8 | mp3 1ch 64k | 28 | ok |
| games/getaway/public/sfx/radio/flat_limping.mp3 | voice | getaway | 3.37 | -16.5 | -13.6 | -1.8 | mp3 1ch 64k | 27 | ok |
| games/getaway/public/sfx/radio/flat_strip.mp3 | voice | getaway | 4.14 | -16.4 | -13.3 | -2.0 | mp3 1ch 64k | 33 | ok |
| games/getaway/public/sfx/radio/heli_eyes.mp3 | voice | getaway | 3.03 | -16.4 | -13.7 | -2.0 | mp3 1ch 64k | 24 | ok |
| games/getaway/public/sfx/radio/heli_light.mp3 | voice | getaway | 2.98 | -16.5 | -13.1 | -1.8 | mp3 1ch 64k | 24 | ok |
| games/getaway/public/sfx/radio/lost_gone.mp3 | voice | getaway | 2.61 | -16.5 | -14.0 | -1.8 | mp3 1ch 64k | 21 | ok |
| games/getaway/public/sfx/radio/lost_marked.mp3 | voice | getaway | 3.11 | -16.5 | -14.0 | -1.6 | mp3 1ch 64k | 25 | ok |
| games/getaway/public/sfx/radio/radio_squelch.mp3 | voice | getaway | 0.46 | -20.1 | -20.1 | -1.5 | mp3 1ch 64k | 4 | ok |
| games/getaway/public/sfx/radio/spotted_east.mp3 | voice | getaway | 3.17 | -16.6 | -12.5 | -1.8 | mp3 1ch 64k | 25 | ok |
| games/getaway/public/sfx/radio/spotted_eyes.mp3 | voice | getaway | 1.63 | -16.4 | -13.7 | -1.8 | mp3 1ch 64k | 13 | ok |
| games/getaway/public/sfx/radio/spotted_moving.mp3 | voice | getaway | 1.99 | -16.5 | -14.5 | -1.5 | mp3 1ch 64k | 16 | ok |
| games/getaway/public/sfx/radio/spotted_north.mp3 | voice | getaway | 3.20 | -16.6 | -12.3 | -1.8 | mp3 1ch 64k | 26 | ok |
| games/getaway/public/sfx/radio/spotted_south.mp3 | voice | getaway | 3.24 | -16.6 | -12.9 | -1.9 | mp3 1ch 64k | 26 | ok |
| games/getaway/public/sfx/radio/spotted_sting.mp3 | voice | getaway | 1.30 | -15.5 | -14.7 | -5.9 | mp3 1ch 64k | 11 | ok |
| games/getaway/public/sfx/radio/spotted_west.mp3 | voice | getaway | 3.18 | -16.6 | -12.9 | -1.8 | mp3 1ch 64k | 25 | ok |
| games/getaway/public/sfx/radio/tip_area.mp3 | voice | getaway | 4.41 | -16.5 | -13.8 | -1.9 | mp3 1ch 64k | 35 | ok |
| games/getaway/public/sfx/radio/tip_maps.mp3 | voice | getaway | 3.16 | -16.6 | -14.1 | -1.7 | mp3 1ch 64k | 25 | ok |
| games/getaway/public/sfx/radio_chatter.mp3 | voice | getaway | 3.73 | -18.6 | -14.9 | -1.5 | mp3 1ch 96k | 44 | ok |
| games/getaway/public/sfx/repair.mp3 | other | getaway | 1.00 | -7.0 | -5.3 | 1.4 | mp3 2ch 128k | 34 | clips 67, hot peak |
| games/getaway/public/sfx/round_start_sting.mp3 | vehicle | getaway | 3.60 | -15.5 | -11.4 | -2.9 | mp3 2ch 112k | 50 | ok |
| games/getaway/public/sfx/scrape_loop.mp3 | tyre | getaway | 3.43 | -18.4 | -16.0 | -3.3 | mp3 1ch 80k | 34 | ok |
| games/getaway/public/sfx/shove_chirp_1.mp3 | other | getaway | 0.19 | -18.5 | -18.5 | -7.6 | mp3 1ch 96k | 3 | ok |
| games/getaway/public/sfx/shove_chirp_2.mp3 | other | getaway | 0.18 | -18.4 | -18.4 | -7.8 | mp3 1ch 96k | 3 | ok |
| games/getaway/public/sfx/siren_wail_loop.mp3 | vehicle | getaway | 9.20 | -16.4 | -14.8 | -7.5 | mp3 1ch 80k | 91 | ok |
| games/getaway/public/sfx/siren_yelp_loop.mp3 | vehicle | getaway | 2.68 | -16.5 | -16.0 | -5.2 | mp3 1ch 80k | 27 | ok |
| games/getaway/public/sfx/skid_short.mp3 | tyre | getaway | 0.38 | -18.5 | -18.5 | -5.7 | mp3 1ch 96k | 5 | ok |
| games/getaway/public/sfx/spike_deploy.mp3 | impact | getaway | 1.62 | -18.3 | -15.8 | -0.6 | mp3 1ch 96k | 20 | lead 199 ms |
| games/getaway/public/sfx/stems/arcane_cast_burst.mp3 | spell | getaway | 1.00 | -31.4 | -27.8 | -10.7 | mp3 2ch 128k | 17 | ok |
| games/getaway/public/sfx/stems/arcane_charge_loop.mp3 | spell | getaway | 2.25 | -13.2 | -11.8 | -5.5 | mp3 2ch 128k | 36 | ok |
| games/getaway/public/sfx/stems/chassis_impact_deep.mp3 | impact | getaway | 0.88 | -32.2 | -28.1 | -10.9 | mp3 2ch 128k | 15 | ok |
| games/getaway/public/sfx/stems/metal_shard_clink.mp3 | spell | getaway | 0.80 | -15.9 | -13.4 | -1.7 | mp3 2ch 128k | 14 | ok |
| games/getaway/public/sfx/tire_pop.mp3 | impact | getaway | 1.74 | -14.6 | -12.6 | -1.1 | mp3 1ch 96k | 21 | ok |
| games/getaway/public/sfx/tire_screech_loop.mp3 | tyre | getaway | 4.53 | -18.4 | -16.4 | -5.4 | mp3 1ch 80k | 45 | ok |
| games/getaway/public/sfx/tire_scrub_loop.mp3 | tyre | getaway | 5.48 | -20.4 | -18.2 | -5.1 | mp3 1ch 80k | 54 | ok |
| games/getaway/public/sfx/ui_click.mp3 | ui | getaway | 0.48 | -20.8 | -20.8 | -0.8 | mp3 1ch 96k | 6 | ok |
| games/getaway/public/sfx/ui_whoosh.mp3 | ui | getaway | 1.00 | -20.4 | -18.1 | -2.1 | mp3 1ch 96k | 13 | ok |
| packages/kit/audio/sfx/ambience.day.suburb.1.ogg | ambience | library ambience.day.suburb (outbreak) | 23.90 | -30.4 | -24.2 | -12.8 | opus 2ch 72k | 210 | ok |
| packages/kit/audio/sfx/ambience.night.suburb.1.ogg | ambience | library ambience.night.suburb (outbreak) | 23.90 | -30.0 | -28.4 | -23.5 | opus 2ch 98k | 287 | ok |
| packages/kit/audio/sfx/ambience.threat.1.ogg | ambience | library ambience.threat (outbreak) | 23.90 | -32.0 | -27.5 | -17.3 | opus 2ch 74k | 215 | ok |
| packages/kit/audio/sfx/barricade.break.1.ogg | foley | library barricade.break (outbreak) | 1.04 | -25.0 | -24.1 | -1.5 | opus 1ch 71k | 9 | ok |
| packages/kit/audio/sfx/barricade.break.2.ogg | foley | library barricade.break (outbreak) | 1.11 | -24.9 | -23.6 | -1.4 | opus 1ch 66k | 9 | ok |
| packages/kit/audio/sfx/barricade.break.3.ogg | foley | library barricade.break (outbreak) | 1.15 | -24.7 | -23.1 | -1.8 | opus 1ch 69k | 10 | ok |
| packages/kit/audio/sfx/barricade.hammer.1.ogg | foley | library barricade.hammer (outbreak) | 1.35 | -18.6 | -17.9 | -2.3 | opus 1ch 47k | 8 | ok |
| packages/kit/audio/sfx/barricade.hammer.2.ogg | foley | library barricade.hammer (outbreak) | 1.34 | -19.1 | -18.0 | -3.1 | opus 1ch 47k | 8 | ok |
| packages/kit/audio/sfx/barricade.hammer.3.ogg | foley | library barricade.hammer (outbreak) | 1.13 | -20.0 | -18.7 | -5.1 | opus 1ch 48k | 7 | ok |
| packages/kit/audio/sfx/barricade.hammer.4.ogg | foley | library barricade.hammer (outbreak) | 1.36 | -19.0 | -18.0 | -3.6 | opus 1ch 48k | 8 | ok |
| packages/kit/audio/sfx/bench.deposit.1.ogg | other | library bench.deposit (outbreak) | 1.20 | -23.6 | -22.0 | -5.8 | opus 1ch 46k | 7 | ok |
| packages/kit/audio/sfx/bench.deposit.2.ogg | other | library bench.deposit (outbreak) | 1.15 | -23.4 | -22.0 | -5.9 | opus 1ch 46k | 7 | ok |
| packages/kit/audio/sfx/bench.deposit.3.ogg | other | library bench.deposit (outbreak) | 0.93 | -22.8 | -21.6 | -8.4 | opus 1ch 45k | 5 | ok |
| packages/kit/audio/sfx/bench.research.done.1.ogg | other | library bench.research.done (outbreak) | 0.43 | -26.0 | -26.0 | -2.0 | opus 1ch 44k | 2 | ok |
| packages/kit/audio/sfx/bench.research.done.2.ogg | other | library bench.research.done (outbreak) | 0.39 | -23.7 | -23.7 | -1.4 | opus 1ch 49k | 2 | ok |
| packages/kit/audio/sfx/bench.research.loop.1.ogg | other | library bench.research.loop (outbreak) | 5.90 | -27.9 | -23.4 | -1.5 | opus 1ch 47k | 34 | ok |
| packages/kit/audio/sfx/body.breath.exhausted.1.ogg | creature | library body.breath.exhausted (outbreak) | 2.41 | -27.2 | -23.9 | -13.6 | opus 1ch 47k | 14 | ok |
| packages/kit/audio/sfx/body.breath.exhausted.2.ogg | creature | library body.breath.exhausted (outbreak) | 2.34 | -26.3 | -24.7 | -13.5 | opus 1ch 49k | 14 | ok |
| packages/kit/audio/sfx/body.hurt.1.ogg | creature | library body.hurt (outbreak) | 0.68 | -20.8 | -18.2 | -2.9 | opus 1ch 46k | 4 | ok |
| packages/kit/audio/sfx/body.hurt.2.ogg | creature | library body.hurt (outbreak) | 0.54 | -19.5 | -18.3 | -6.3 | opus 1ch 52k | 3 | ok |
| packages/kit/audio/sfx/body.hurt.3.ogg | creature | library body.hurt (outbreak) | 0.68 | -21.1 | -18.9 | -1.7 | opus 1ch 46k | 4 | ok |
| packages/kit/audio/sfx/body.hurt.4.ogg | creature | library body.hurt (outbreak) | 0.68 | -20.1 | -20.1 | -1.2 | opus 1ch 40k | 3 | ok |
| packages/kit/audio/sfx/body.vault.1.ogg | creature | library body.vault (outbreak) | 1.20 | -31.3 | -25.0 | -1.2 | opus 1ch 41k | 6 | ok |
| packages/kit/audio/sfx/body.vault.2.ogg | creature | library body.vault (outbreak) | 0.66 | -26.8 | -23.9 | -8.8 | opus 1ch 48k | 4 | ok |
| packages/kit/audio/sfx/craft.medical.done.1.ogg | other | library craft.medical.done (outbreak) | 0.80 | -24.5 | -24.5 | -3.1 | opus 1ch 43k | 4 | ok |
| packages/kit/audio/sfx/craft.medical.done.2.ogg | other | library craft.medical.done (outbreak) | 0.56 | -23.1 | -23.1 | -0.8 | opus 1ch 45k | 3 | ok |
| packages/kit/audio/sfx/craft.medical.loop.1.ogg | other | library craft.medical.loop (outbreak) | 5.90 | -29.7 | -22.9 | -1.0 | opus 1ch 46k | 33 | ok |
| packages/kit/audio/sfx/craft.tinker.done.1.ogg | other | library craft.tinker.done (outbreak) | 0.65 | -22.2 | -22.0 | -2.2 | opus 1ch 59k | 5 | ok |
| packages/kit/audio/sfx/craft.tinker.done.2.ogg | other | library craft.tinker.done (outbreak) | 0.71 | -23.5 | -22.6 | -1.5 | opus 1ch 66k | 6 | ok |
| packages/kit/audio/sfx/craft.tinker.loop.1.ogg | other | library craft.tinker.loop (outbreak) | 5.90 | -26.0 | -22.6 | -2.3 | opus 1ch 56k | 41 | ok |
| packages/kit/audio/sfx/craft.wood.done.1.ogg | other | library craft.wood.done (outbreak) | 0.80 | -23.2 | -22.0 | -4.6 | opus 1ch 45k | 4 | ok |
| packages/kit/audio/sfx/craft.wood.done.2.ogg | other | library craft.wood.done (outbreak) | 0.49 | -22.7 | -22.7 | -3.7 | opus 1ch 44k | 3 | ok |
| packages/kit/audio/sfx/craft.wood.loop.1.ogg | other | library craft.wood.loop (outbreak) | 5.90 | -29.1 | -26.3 | -1.5 | opus 1ch 50k | 36 | lead 131 ms |
| packages/kit/audio/sfx/door.bash.1.ogg | foley | library door.bash (outbreak) | 1.06 | -23.8 | -21.2 | -1.5 | opus 1ch 58k | 8 | ok |
| packages/kit/audio/sfx/door.bash.2.ogg | foley | library door.bash (outbreak) | 0.85 | -21.8 | -21.8 | -1.6 | opus 1ch 62k | 6 | ok |
| packages/kit/audio/sfx/door.bash.3.ogg | foley | library door.bash (outbreak) | 1.20 | -22.4 | -20.0 | -2.3 | opus 1ch 61k | 9 | ok |
| packages/kit/audio/sfx/door.bash.4.ogg | foley | library door.bash (outbreak) | 1.19 | -22.6 | -20.0 | -3.5 | opus 1ch 62k | 9 | ok |
| packages/kit/audio/sfx/door.locked.1.ogg | foley | library door.locked (outbreak) | 0.93 | -24.8 | -23.7 | -2.0 | opus 1ch 47k | 5 | ok |
| packages/kit/audio/sfx/door.locked.2.ogg | foley | library door.locked (outbreak) | 1.00 | -25.5 | -23.9 | -2.9 | opus 1ch 43k | 5 | ok |
| packages/kit/audio/sfx/door.locked.3.ogg | foley | library door.locked (outbreak) | 0.91 | -28.2 | -27.0 | -2.7 | opus 1ch 45k | 5 | ok |
| packages/kit/audio/sfx/door.pry.loop.1.ogg | foley | library door.pry.loop (outbreak) | 4.90 | -25.6 | -19.8 | -1.7 | opus 1ch 45k | 27 | lead 364 ms |
| packages/kit/audio/sfx/door.wood.close.1.ogg | foley | library door.wood.close (outbreak) | 0.71 | -23.9 | -21.5 | -2.5 | opus 1ch 45k | 4 | ok |
| packages/kit/audio/sfx/door.wood.close.2.ogg | foley | library door.wood.close (outbreak) | 1.00 | -27.2 | -24.5 | -1.5 | opus 1ch 40k | 5 | ok |
| packages/kit/audio/sfx/door.wood.close.3.ogg | foley | library door.wood.close (outbreak) | 0.77 | -23.0 | -20.9 | -2.4 | opus 1ch 46k | 4 | ok |
| packages/kit/audio/sfx/door.wood.open.1.ogg | foley | library door.wood.open (outbreak) | 1.20 | -23.3 | -19.7 | -4.6 | opus 1ch 47k | 7 | ok |
| packages/kit/audio/sfx/door.wood.open.2.ogg | foley | library door.wood.open (outbreak) | 1.20 | -23.3 | -18.9 | -7.7 | opus 1ch 45k | 7 | ok |
| packages/kit/audio/sfx/door.wood.open.3.ogg | foley | library door.wood.open (outbreak) | 0.97 | -22.2 | -20.5 | -3.3 | opus 1ch 45k | 5 | ok |
| packages/kit/audio/sfx/flashlight.battery.1.ogg | foley | library flashlight.battery (outbreak) | 0.99 | -32.4 | -29.0 | -2.3 | opus 1ch 44k | 5 | ok |
| packages/kit/audio/sfx/flashlight.battery.2.ogg | foley | library flashlight.battery (outbreak) | 0.98 | -29.4 | -28.0 | -1.4 | opus 1ch 45k | 5 | ok |
| packages/kit/audio/sfx/flashlight.click.1.ogg | ui | library flashlight.click (outbreak) | 0.12 | -25.9 | -25.9 | -5.0 | opus 1ch 70k | 1 | ok |
| packages/kit/audio/sfx/flashlight.click.2.ogg | ui | library flashlight.click (outbreak) | 0.12 | -26.1 | -26.1 | -5.9 | opus 1ch 73k | 1 | ok |
| packages/kit/audio/sfx/flashlight.click.3.ogg | ui | library flashlight.click (outbreak) | 0.14 | -26.0 | -26.0 | -4.5 | opus 1ch 66k | 1 | ok |
| packages/kit/audio/sfx/foot.concrete.run.1.ogg | foley | library foot.concrete.run (outbreak) | 0.30 | -24.9 | -24.9 | -1.3 | opus 1ch 51k | 2 | ok |
| packages/kit/audio/sfx/foot.concrete.run.2.ogg | foley | library foot.concrete.run (outbreak) | 0.30 | -26.2 | -26.2 | -1.6 | opus 1ch 50k | 2 | ok |
| packages/kit/audio/sfx/foot.concrete.run.3.ogg | foley | library foot.concrete.run (outbreak) | 0.30 | -25.2 | -25.2 | -1.3 | opus 1ch 51k | 2 | ok |
| packages/kit/audio/sfx/foot.concrete.run.4.ogg | foley | library foot.concrete.run (outbreak) | 0.28 | -25.4 | -25.4 | -3.7 | opus 1ch 52k | 2 | ok |
| packages/kit/audio/sfx/foot.concrete.run.5.ogg | foley | library foot.concrete.run (outbreak) | 0.29 | -25.3 | -25.3 | -5.0 | opus 1ch 52k | 2 | ok |
| packages/kit/audio/sfx/foot.concrete.run.6.ogg | foley | library foot.concrete.run (outbreak) | 0.30 | -25.2 | -25.2 | -2.6 | opus 1ch 50k | 2 | ok |
| packages/kit/audio/sfx/foot.concrete.walk.1.ogg | foley | library foot.concrete.walk (outbreak) | 0.41 | -27.2 | -27.2 | -2.2 | opus 1ch 48k | 2 | ok |
| packages/kit/audio/sfx/foot.concrete.walk.2.ogg | foley | library foot.concrete.walk (outbreak) | 0.42 | -26.9 | -26.9 | -4.0 | opus 1ch 43k | 2 | ok |
| packages/kit/audio/sfx/foot.concrete.walk.3.ogg | foley | library foot.concrete.walk (outbreak) | 0.36 | -26.9 | -26.9 | -1.3 | opus 1ch 48k | 2 | ok |
| packages/kit/audio/sfx/foot.concrete.walk.4.ogg | foley | library foot.concrete.walk (outbreak) | 0.33 | -26.9 | -26.9 | -2.0 | opus 1ch 50k | 2 | ok |
| packages/kit/audio/sfx/foot.concrete.walk.5.ogg | foley | library foot.concrete.walk (outbreak) | 0.30 | -27.2 | -27.2 | -2.3 | opus 1ch 50k | 2 | ok |
| packages/kit/audio/sfx/foot.concrete.walk.6.ogg | foley | library foot.concrete.walk (outbreak) | 0.33 | -27.6 | -27.6 | -5.3 | opus 1ch 50k | 2 | ok |
| packages/kit/audio/sfx/foot.grass.run.1.ogg | foley | library foot.grass.run (outbreak) | 0.28 | -25.0 | -25.0 | -6.2 | opus 1ch 55k | 2 | ok |
| packages/kit/audio/sfx/foot.grass.run.2.ogg | foley | library foot.grass.run (outbreak) | 0.30 | -25.0 | -25.0 | -6.4 | opus 1ch 53k | 2 | ok |
| packages/kit/audio/sfx/foot.grass.run.3.ogg | foley | library foot.grass.run (outbreak) | 0.20 | -25.0 | -25.0 | -9.1 | opus 1ch 61k | 2 | ok |
| packages/kit/audio/sfx/foot.grass.run.4.ogg | foley | library foot.grass.run (outbreak) | 0.24 | -25.4 | -25.4 | -7.8 | opus 1ch 54k | 2 | ok |
| packages/kit/audio/sfx/foot.grass.run.5.ogg | foley | library foot.grass.run (outbreak) | 0.23 | -24.9 | -24.9 | -8.0 | opus 1ch 58k | 2 | ok |
| packages/kit/audio/sfx/foot.grass.run.6.ogg | foley | library foot.grass.run (outbreak) | 0.19 | -25.5 | -25.5 | -9.7 | opus 1ch 57k | 1 | ok |
| packages/kit/audio/sfx/foot.grass.walk.1.ogg | foley | library foot.grass.walk (outbreak) | 0.32 | -27.0 | -27.0 | -12.8 | opus 1ch 52k | 2 | ok |
| packages/kit/audio/sfx/foot.grass.walk.2.ogg | foley | library foot.grass.walk (outbreak) | 0.40 | -27.0 | -27.0 | -10.4 | opus 1ch 52k | 3 | ok |
| packages/kit/audio/sfx/foot.grass.walk.3.ogg | foley | library foot.grass.walk (outbreak) | 0.39 | -28.1 | -28.1 | -13.1 | opus 1ch 52k | 2 | ok |
| packages/kit/audio/sfx/foot.grass.walk.4.ogg | foley | library foot.grass.walk (outbreak) | 0.42 | -27.0 | -27.0 | -11.5 | opus 1ch 51k | 3 | ok |
| packages/kit/audio/sfx/foot.grass.walk.5.ogg | foley | library foot.grass.walk (outbreak) | 0.36 | -27.0 | -27.0 | -12.9 | opus 1ch 52k | 2 | ok |
| packages/kit/audio/sfx/foot.grass.walk.6.ogg | foley | library foot.grass.walk (outbreak) | 0.40 | -26.9 | -26.9 | -7.1 | opus 1ch 48k | 2 | ok |
| packages/kit/audio/sfx/foot.wood.run.1.ogg | foley | library foot.wood.run (outbreak) | 0.30 | -24.9 | -24.9 | -3.6 | opus 1ch 49k | 2 | ok |
| packages/kit/audio/sfx/foot.wood.run.2.ogg | foley | library foot.wood.run (outbreak) | 0.29 | -25.7 | -25.7 | -1.7 | opus 1ch 48k | 2 | ok |
| packages/kit/audio/sfx/foot.wood.run.3.ogg | foley | library foot.wood.run (outbreak) | 0.20 | -25.0 | -25.0 | -9.0 | opus 1ch 60k | 1 | ok |
| packages/kit/audio/sfx/foot.wood.run.4.ogg | foley | library foot.wood.run (outbreak) | 0.30 | -25.0 | -25.0 | -8.1 | opus 1ch 49k | 2 | ok |
| packages/kit/audio/sfx/foot.wood.run.5.ogg | foley | library foot.wood.run (outbreak) | 0.30 | -25.1 | -25.1 | -3.0 | opus 1ch 51k | 2 | ok |
| packages/kit/audio/sfx/foot.wood.run.6.ogg | foley | library foot.wood.run (outbreak) | 0.28 | -25.0 | -25.0 | -2.4 | opus 1ch 52k | 2 | ok |
| packages/kit/audio/sfx/foot.wood.walk.1.ogg | foley | library foot.wood.walk (outbreak) | 0.38 | -27.4 | -27.4 | -7.3 | opus 1ch 44k | 2 | ok |
| packages/kit/audio/sfx/foot.wood.walk.2.ogg | foley | library foot.wood.walk (outbreak) | 0.39 | -27.1 | -27.1 | -5.6 | opus 1ch 43k | 2 | ok |
| packages/kit/audio/sfx/foot.wood.walk.3.ogg | foley | library foot.wood.walk (outbreak) | 0.39 | -27.2 | -27.2 | -8.3 | opus 1ch 49k | 2 | ok |
| packages/kit/audio/sfx/foot.wood.walk.4.ogg | foley | library foot.wood.walk (outbreak) | 0.37 | -27.0 | -27.0 | -7.1 | opus 1ch 47k | 2 | ok |
| packages/kit/audio/sfx/foot.wood.walk.5.ogg | foley | library foot.wood.walk (outbreak) | 0.32 | -27.1 | -27.1 | -11.4 | opus 1ch 51k | 2 | ok |
| packages/kit/audio/sfx/foot.wood.walk.6.ogg | foley | library foot.wood.walk (outbreak) | 0.42 | -27.1 | -27.1 | -9.9 | opus 1ch 49k | 3 | ok |
| packages/kit/audio/sfx/generator.loop.1.ogg | other | library generator.loop (outbreak) | 5.90 | -26.1 | -25.5 | -10.2 | opus 1ch 53k | 38 | ok |
| packages/kit/audio/sfx/glass.break.1.ogg | other | library glass.break (outbreak) | 1.60 | -18.7 | -15.9 | -4.1 | opus 1ch 61k | 12 | ok |
| packages/kit/audio/sfx/glass.break.2.ogg | other | library glass.break (outbreak) | 1.60 | -18.3 | -16.0 | -4.4 | opus 1ch 60k | 12 | ok |
| packages/kit/audio/sfx/gun.casing.1.ogg | weapon | library gun.casing (outbreak) | 0.80 | -24.0 | -24.0 | -8.4 | opus 1ch 52k | 5 | ok |
| packages/kit/audio/sfx/gun.casing.2.ogg | weapon | library gun.casing (outbreak) | 0.80 | -26.5 | -24.0 | -15.0 | opus 1ch 55k | 5 | ok |
| packages/kit/audio/sfx/gun.casing.3.ogg | weapon | library gun.casing (outbreak) | 0.80 | -25.8 | -24.0 | -13.0 | opus 1ch 51k | 5 | ok |
| packages/kit/audio/sfx/gun.dry-fire.1.ogg | weapon | library gun.dry-fire (outbreak) | 0.48 | -24.0 | -24.0 | -3.3 | opus 1ch 62k | 4 | ok |
| packages/kit/audio/sfx/gun.dry-fire.2.ogg | weapon | library gun.dry-fire (outbreak) | 0.48 | -23.9 | -23.9 | -2.8 | opus 1ch 62k | 4 | ok |
| packages/kit/audio/sfx/gun.dry-fire.3.ogg | weapon | library gun.dry-fire (outbreak) | 0.23 | -24.0 | -24.0 | -7.1 | opus 1ch 73k | 2 | ok |
| packages/kit/audio/sfx/gun.pistol.mag-in.1.ogg | weapon | library gun.pistol.mag-in (outbreak) | 0.35 | -21.8 | -21.8 | -2.3 | opus 1ch 75k | 3 | ok |
| packages/kit/audio/sfx/gun.pistol.mag-in.2.ogg | weapon | library gun.pistol.mag-in (outbreak) | 0.53 | -24.4 | -23.5 | -1.2 | opus 1ch 72k | 5 | ok |
| packages/kit/audio/sfx/gun.pistol.mag-in.3.ogg | weapon | library gun.pistol.mag-in (outbreak) | 0.30 | -22.1 | -22.1 | -1.2 | opus 1ch 73k | 3 | ok |
| packages/kit/audio/sfx/gun.pistol.mag-out.1.ogg | weapon | library gun.pistol.mag-out (outbreak) | 0.56 | -25.8 | -25.0 | -4.1 | opus 1ch 69k | 5 | ok |
| packages/kit/audio/sfx/gun.pistol.mag-out.2.ogg | weapon | library gun.pistol.mag-out (outbreak) | 0.45 | -25.1 | -25.1 | -4.5 | opus 1ch 65k | 4 | ok |
| packages/kit/audio/sfx/gun.pistol.mag-out.3.ogg | weapon | library gun.pistol.mag-out (outbreak) | 0.57 | -26.2 | -25.0 | -6.9 | opus 1ch 67k | 5 | ok |
| packages/kit/audio/sfx/gun.pistol.mag-release.1.ogg | weapon | library gun.pistol.mag-release (outbreak) | 0.16 | -26.1 | -26.1 | -5.9 | opus 1ch 80k | 2 | ok |
| packages/kit/audio/sfx/gun.pistol.mag-release.2.ogg | weapon | library gun.pistol.mag-release (outbreak) | 0.22 | -26.3 | -26.3 | -1.9 | opus 1ch 72k | 2 | ok |
| packages/kit/audio/sfx/gun.pistol.mag-release.3.ogg | weapon | library gun.pistol.mag-release (outbreak) | 0.48 | -26.0 | -26.0 | -2.4 | opus 1ch 58k | 3 | ok |
| packages/kit/audio/sfx/gun.pistol.reload.1.ogg | weapon | library gun.pistol.reload (Lab) | 1.30 | -23.0 | -22.0 | -3.4 | opus 1ch 60k | 10 | ok |
| packages/kit/audio/sfx/gun.pistol.reload.2.ogg | weapon | library gun.pistol.reload (Lab) | 1.20 | -22.0 | -22.0 | -4.0 | opus 1ch 57k | 8 | ok |
| packages/kit/audio/sfx/gun.pistol.reload.3.ogg | weapon | library gun.pistol.reload (Lab) | 1.33 | -22.6 | -22.1 | -2.6 | opus 1ch 59k | 10 | ok |
| packages/kit/audio/sfx/gun.pistol.shot.1.ogg | weapon | library gun.pistol.shot (outbreak) | 1.48 | -22.8 | -18.9 | -2.0 | opus 1ch 55k | 10 | ok |
| packages/kit/audio/sfx/gun.pistol.shot.2.ogg | weapon | library gun.pistol.shot (outbreak) | 1.48 | -25.8 | -20.9 | -1.5 | opus 1ch 55k | 10 | ok |
| packages/kit/audio/sfx/gun.pistol.shot.3.ogg | weapon | library gun.pistol.shot (outbreak) | 0.58 | -22.7 | -20.1 | -2.1 | opus 1ch 60k | 4 | ok |
| packages/kit/audio/sfx/gun.pistol.shot.4.ogg | weapon | library gun.pistol.shot (outbreak) | 0.45 | -19.0 | -19.0 | -2.4 | opus 1ch 66k | 4 | ok |
| packages/kit/audio/sfx/gun.pistol.slide.1.ogg | weapon | library gun.pistol.slide (outbreak) | 0.24 | -21.0 | -21.0 | -5.7 | opus 1ch 79k | 2 | ok |
| packages/kit/audio/sfx/gun.pistol.slide.2.ogg | weapon | library gun.pistol.slide (outbreak) | 0.60 | -21.0 | -21.0 | -3.8 | opus 1ch 61k | 5 | ok |
| packages/kit/audio/sfx/gun.pistol.slide.3.ogg | weapon | library gun.pistol.slide (outbreak) | 0.38 | -21.1 | -21.1 | -4.8 | opus 1ch 68k | 3 | ok |
| packages/kit/audio/sfx/impact.bullet.concrete.1.ogg | impact | library impact.bullet.concrete (outbreak) | 0.80 | -20.6 | -20.6 | -1.4 | opus 1ch 65k | 6 | ok |
| packages/kit/audio/sfx/impact.bullet.concrete.2.ogg | impact | library impact.bullet.concrete (outbreak) | 0.80 | -19.9 | -19.9 | -3.1 | opus 1ch 71k | 7 | ok |
| packages/kit/audio/sfx/impact.bullet.concrete.3.ogg | impact | library impact.bullet.concrete (outbreak) | 0.80 | -20.1 | -20.1 | -3.5 | opus 1ch 71k | 7 | ok |
| packages/kit/audio/sfx/impact.bullet.concrete.4.ogg | impact | library impact.bullet.concrete (outbreak) | 0.80 | -19.9 | -19.9 | -1.4 | opus 1ch 61k | 6 | ok |
| packages/kit/audio/sfx/impact.bullet.glass.1.ogg | impact | library impact.bullet.glass (outbreak) | 0.46 | -21.5 | -21.5 | -1.6 | opus 1ch 72k | 4 | ok |
| packages/kit/audio/sfx/impact.bullet.glass.2.ogg | impact | library impact.bullet.glass (outbreak) | 0.81 | -25.8 | -22.7 | -1.6 | opus 1ch 64k | 6 | ok |
| packages/kit/audio/sfx/impact.bullet.glass.3.ogg | impact | library impact.bullet.glass (outbreak) | 0.83 | -20.3 | -19.3 | -1.6 | opus 1ch 66k | 7 | ok |
| packages/kit/audio/sfx/impact.bullet.glass.4.ogg | impact | library impact.bullet.glass (outbreak) | 0.93 | -22.1 | -19.9 | -0.7 | opus 1ch 67k | 8 | ok |
| packages/kit/audio/sfx/impact.bullet.metal.1.ogg | impact | library impact.bullet.metal (outbreak) | 0.88 | -21.6 | -19.0 | -5.6 | opus 1ch 57k | 6 | ok |
| packages/kit/audio/sfx/impact.bullet.metal.2.ogg | impact | library impact.bullet.metal (outbreak) | 0.88 | -22.2 | -19.5 | -1.4 | opus 1ch 57k | 6 | ok |
| packages/kit/audio/sfx/impact.bullet.metal.3.ogg | impact | library impact.bullet.metal (outbreak) | 0.88 | -22.8 | -19.0 | -2.8 | opus 1ch 59k | 6 | ok |
| packages/kit/audio/sfx/impact.bullet.metal.4.ogg | impact | library impact.bullet.metal (outbreak) | 0.88 | -21.6 | -19.0 | -2.3 | opus 1ch 57k | 6 | ok |
| packages/kit/audio/sfx/impact.bullet.plaster.1.ogg | impact | library impact.bullet.plaster (outbreak) | 0.80 | -25.4 | -22.6 | -1.8 | opus 1ch 59k | 6 | ok |
| packages/kit/audio/sfx/impact.bullet.plaster.2.ogg | impact | library impact.bullet.plaster (outbreak) | 0.80 | -21.9 | -21.9 | -3.5 | opus 1ch 54k | 5 | ok |
| packages/kit/audio/sfx/impact.bullet.plaster.3.ogg | impact | library impact.bullet.plaster (outbreak) | 0.80 | -24.8 | -22.2 | -2.5 | opus 1ch 58k | 6 | ok |
| packages/kit/audio/sfx/impact.bullet.plaster.4.ogg | impact | library impact.bullet.plaster (outbreak) | 0.73 | -26.3 | -23.5 | -1.9 | opus 1ch 55k | 5 | ok |
| packages/kit/audio/sfx/impact.bullet.wood.1.ogg | impact | library impact.bullet.wood (outbreak) | 0.30 | -24.4 | -24.4 | -4.6 | opus 1ch 66k | 3 | ok |
| packages/kit/audio/sfx/impact.bullet.wood.2.ogg | impact | library impact.bullet.wood (outbreak) | 0.80 | -24.5 | -24.5 | -6.8 | opus 1ch 58k | 6 | ok |
| packages/kit/audio/sfx/impact.bullet.wood.3.ogg | impact | library impact.bullet.wood (outbreak) | 0.80 | -28.0 | -28.0 | -2.1 | opus 1ch 59k | 6 | ok |
| packages/kit/audio/sfx/impact.bullet.wood.4.ogg | impact | library impact.bullet.wood (outbreak) | 0.54 | -25.8 | -25.8 | -1.4 | opus 1ch 61k | 4 | ok |
| packages/kit/audio/sfx/item.drop.1.ogg | other | library item.drop (outbreak) | 0.40 | -31.1 | -31.1 | -2.1 | opus 1ch 46k | 2 | ok |
| packages/kit/audio/sfx/item.drop.2.ogg | other | library item.drop (outbreak) | 0.54 | -31.6 | -28.9 | -1.2 | opus 1ch 45k | 3 | ok |
| packages/kit/audio/sfx/lure.land.1.ogg | other | library lure.land (outbreak) | 0.80 | -25.5 | -22.2 | -3.8 | opus 1ch 51k | 5 | ok |
| packages/kit/audio/sfx/lure.land.2.ogg | other | library lure.land (outbreak) | 0.63 | -24.7 | -22.1 | -2.4 | opus 1ch 55k | 4 | ok |
| packages/kit/audio/sfx/lure.loop.1.ogg | other | library lure.loop (outbreak) | 3.90 | -24.0 | -23.5 | -12.5 | opus 1ch 56k | 27 | ok |
| packages/kit/audio/sfx/melee.shove.1.ogg | other | library melee.shove (outbreak) | 0.60 | -20.9 | -20.0 | -1.7 | opus 1ch 46k | 3 | ok |
| packages/kit/audio/sfx/melee.shove.2.ogg | other | library melee.shove (outbreak) | 0.68 | -23.1 | -22.5 | -2.6 | opus 1ch 48k | 4 | ok |
| packages/kit/audio/sfx/melee.shove.3.ogg | other | library melee.shove (outbreak) | 0.72 | -22.5 | -20.0 | -3.8 | opus 1ch 46k | 4 | ok |
| packages/kit/audio/sfx/pack.close.1.ogg | other | library pack.close (outbreak) | 0.64 | -28.7 | -28.0 | -17.4 | opus 1ch 49k | 4 | ok |
| packages/kit/audio/sfx/pack.close.2.ogg | other | library pack.close (outbreak) | 0.59 | -28.0 | -27.9 | -14.0 | opus 1ch 48k | 3 | ok |
| packages/kit/audio/sfx/pack.open.1.ogg | other | library pack.open (outbreak) | 0.57 | -26.7 | -26.6 | -14.6 | opus 1ch 50k | 4 | ok |
| packages/kit/audio/sfx/pack.open.2.ogg | other | library pack.open (outbreak) | 0.63 | -27.6 | -26.7 | -14.1 | opus 1ch 49k | 4 | ok |
| packages/kit/audio/sfx/pickup.ammo.1.ogg | foley | library pickup.ammo (outbreak) | 0.59 | -25.4 | -25.3 | -2.2 | opus 1ch 48k | 4 | ok |
| packages/kit/audio/sfx/pickup.ammo.2.ogg | foley | library pickup.ammo (outbreak) | 0.68 | -24.9 | -24.7 | -1.7 | opus 1ch 48k | 4 | ok |
| packages/kit/audio/sfx/pickup.ammo.3.ogg | foley | library pickup.ammo (outbreak) | 0.56 | -24.7 | -24.7 | -4.3 | opus 1ch 49k | 3 | ok |
| packages/kit/audio/sfx/pickup.battery.1.ogg | foley | library pickup.battery (outbreak) | 0.48 | -26.5 | -26.5 | -1.2 | opus 1ch 64k | 4 | ok |
| packages/kit/audio/sfx/pickup.battery.2.ogg | foley | library pickup.battery (outbreak) | 0.42 | -27.5 | -27.5 | -1.5 | opus 1ch 55k | 3 | ok |
| packages/kit/audio/sfx/pickup.battery.3.ogg | foley | library pickup.battery (outbreak) | 0.45 | -25.9 | -25.9 | -1.6 | opus 1ch 55k | 3 | ok |
| packages/kit/audio/sfx/pickup.item.1.ogg | foley | library pickup.item (outbreak) | 0.56 | -23.8 | -23.3 | -8.3 | opus 1ch 49k | 3 | ok |
| packages/kit/audio/sfx/pickup.item.2.ogg | foley | library pickup.item (outbreak) | 0.53 | -23.6 | -23.4 | -8.4 | opus 1ch 50k | 3 | ok |
| packages/kit/audio/sfx/pickup.item.3.ogg | foley | library pickup.item (outbreak) | 0.59 | -23.6 | -22.9 | -8.3 | opus 1ch 52k | 4 | ok |
| packages/kit/audio/sfx/pickup.key.1.ogg | foley | library pickup.key (outbreak) | 0.59 | -25.0 | -25.0 | -11.0 | opus 1ch 52k | 4 | ok |
| packages/kit/audio/sfx/pickup.key.2.ogg | foley | library pickup.key (outbreak) | 0.56 | -25.0 | -25.0 | -9.2 | opus 1ch 50k | 3 | ok |
| packages/kit/audio/sfx/pickup.key.3.ogg | foley | library pickup.key (outbreak) | 0.60 | -26.9 | -25.1 | -12.9 | opus 1ch 52k | 4 | ok |
| packages/kit/audio/sfx/pickup.medical.1.ogg | foley | library pickup.medical (outbreak) | 0.67 | -25.6 | -24.5 | -5.7 | opus 1ch 50k | 4 | ok |
| packages/kit/audio/sfx/pickup.medical.2.ogg | foley | library pickup.medical (outbreak) | 0.67 | -27.8 | -24.7 | -4.4 | opus 1ch 47k | 4 | ok |
| packages/kit/audio/sfx/pickup.medical.3.ogg | foley | library pickup.medical (outbreak) | 0.65 | -25.8 | -23.0 | -1.7 | opus 1ch 49k | 4 | ok |
| packages/kit/audio/sfx/pickup.part.1.ogg | foley | library pickup.part (outbreak) | 0.54 | -21.2 | -20.9 | -1.2 | opus 1ch 43k | 3 | ok |
| packages/kit/audio/sfx/pickup.part.2.ogg | foley | library pickup.part (outbreak) | 0.88 | -23.2 | -21.0 | -2.4 | opus 1ch 43k | 5 | ok |
| packages/kit/audio/sfx/pickup.part.3.ogg | foley | library pickup.part (outbreak) | 0.74 | -23.1 | -21.0 | -3.6 | opus 1ch 46k | 4 | ok |
| packages/kit/audio/sfx/pickup.plank.1.ogg | foley | library pickup.plank (outbreak) | 0.51 | -24.1 | -23.7 | -8.4 | opus 1ch 54k | 3 | ok |
| packages/kit/audio/sfx/pickup.plank.2.ogg | foley | library pickup.plank (outbreak) | 0.59 | -24.4 | -23.6 | -4.7 | opus 1ch 51k | 4 | ok |
| packages/kit/audio/sfx/pickup.plank.3.ogg | foley | library pickup.plank (outbreak) | 0.49 | -22.9 | -22.9 | -6.6 | opus 1ch 46k | 3 | ok |
| packages/kit/audio/sfx/pickup.scrap.1.ogg | foley | library pickup.scrap (outbreak) | 0.68 | -23.8 | -23.1 | -7.2 | opus 1ch 44k | 4 | ok |
| packages/kit/audio/sfx/pickup.scrap.2.ogg | foley | library pickup.scrap (outbreak) | 0.68 | -24.7 | -23.0 | -9.8 | opus 1ch 43k | 4 | ok |
| packages/kit/audio/sfx/pickup.scrap.3.ogg | foley | library pickup.scrap (outbreak) | 0.44 | -23.1 | -23.1 | -7.5 | opus 1ch 57k | 3 | ok |
| packages/kit/audio/sfx/pickup.tool.1.ogg | foley | library pickup.tool (outbreak) | 0.80 | -23.6 | -22.0 | -8.7 | opus 1ch 49k | 5 | ok |
| packages/kit/audio/sfx/pickup.tool.2.ogg | foley | library pickup.tool (outbreak) | 0.80 | -22.9 | -22.9 | -7.8 | opus 1ch 41k | 4 | ok |
| packages/kit/audio/sfx/pickup.tool.3.ogg | foley | library pickup.tool (outbreak) | 0.80 | -23.6 | -23.6 | -7.5 | opus 1ch 41k | 4 | ok |
| packages/kit/audio/sfx/search.rummage.1.ogg | foley | library search.rummage (outbreak) | 1.95 | -25.3 | -21.0 | -1.7 | opus 1ch 44k | 10 | ok |
| packages/kit/audio/sfx/search.rummage.2.ogg | foley | library search.rummage (outbreak) | 2.00 | -25.6 | -22.3 | -2.7 | opus 1ch 46k | 11 | ok |
| packages/kit/audio/sfx/search.rummage.3.ogg | foley | library search.rummage (outbreak) | 2.00 | -26.5 | -21.0 | -3.4 | opus 1ch 46k | 11 | ok |
| packages/kit/audio/sfx/ui.ping.1.ogg | ui | library ui.ping (outbreak) | 0.60 | -26.6 | -24.0 | -11.0 | opus 1ch 51k | 4 | ok |
| packages/kit/audio/sfx/ui.ping.2.ogg | ui | library ui.ping (outbreak) | 0.60 | -26.8 | -24.1 | -8.9 | opus 1ch 46k | 3 | ok |
| packages/kit/audio/sfx/window.slide.1.ogg | ambience | library window.slide (outbreak) | 1.16 | -22.2 | -20.8 | -4.0 | opus 1ch 44k | 6 | ok |
| packages/kit/audio/sfx/window.slide.2.ogg | ambience | library window.slide (outbreak) | 1.05 | -25.8 | -23.9 | -1.9 | opus 1ch 45k | 6 | ok |
| packages/kit/audio/sfx/window.slide.3.ogg | ambience | library window.slide (outbreak) | 0.97 | -24.1 | -23.4 | -1.0 | opus 1ch 46k | 5 | ok |
| packages/kit/audio/sfx/zombie.alert.1.ogg | creature | library zombie.alert (outbreak) | 1.33 | -19.6 | -17.1 | -8.6 | opus 1ch 49k | 8 | ok |
| packages/kit/audio/sfx/zombie.alert.2.ogg | creature | library zombie.alert (outbreak) | 1.36 | -18.5 | -16.9 | -7.8 | opus 1ch 49k | 8 | ok |
| packages/kit/audio/sfx/zombie.alert.3.ogg | creature | library zombie.alert (outbreak) | 1.38 | -18.3 | -17.2 | -10.2 | opus 1ch 47k | 8 | ok |
| packages/kit/audio/sfx/zombie.alert.4.ogg | creature | library zombie.alert (outbreak) | 1.36 | -17.7 | -16.9 | -9.9 | opus 1ch 49k | 8 | ok |
| packages/kit/audio/sfx/zombie.attack.1.ogg | creature | library zombie.attack (outbreak) | 0.95 | -20.1 | -18.3 | -6.8 | opus 1ch 46k | 5 | ok |
| packages/kit/audio/sfx/zombie.attack.2.ogg | creature | library zombie.attack (outbreak) | 1.00 | -19.6 | -18.2 | -6.7 | opus 1ch 45k | 5 | ok |
| packages/kit/audio/sfx/zombie.attack.3.ogg | creature | library zombie.attack (outbreak) | 0.95 | -19.6 | -16.9 | -3.6 | opus 1ch 50k | 6 | ok |
| packages/kit/audio/sfx/zombie.attack.4.ogg | creature | library zombie.attack (outbreak) | 0.88 | -19.5 | -17.8 | -6.7 | opus 1ch 50k | 5 | ok |
| packages/kit/audio/sfx/zombie.death.1.ogg | creature | library zombie.death (outbreak) | 1.83 | -21.1 | -18.1 | -8.4 | opus 1ch 51k | 12 | ok |
| packages/kit/audio/sfx/zombie.death.2.ogg | creature | library zombie.death (outbreak) | 1.81 | -21.2 | -18.2 | -9.2 | opus 1ch 52k | 11 | ok |
| packages/kit/audio/sfx/zombie.death.3.ogg | creature | library zombie.death (outbreak) | 1.83 | -21.2 | -18.3 | -11.3 | opus 1ch 49k | 11 | ok |
| packages/kit/audio/sfx/zombie.death.4.ogg | creature | library zombie.death (outbreak) | 1.80 | -21.0 | -17.9 | -7.9 | opus 1ch 50k | 11 | ok |
| packages/kit/audio/sfx/zombie.foot.drag.concrete.1.ogg | foley | library zombie.foot.drag.concrete (outbreak) | 0.71 | -31.3 | -30.0 | -9.4 | opus 1ch 72k | 6 | ok |
| packages/kit/audio/sfx/zombie.foot.drag.concrete.2.ogg | foley | library zombie.foot.drag.concrete (outbreak) | 0.72 | -32.1 | -29.9 | -8.4 | opus 1ch 72k | 6 | ok |
| packages/kit/audio/sfx/zombie.foot.drag.concrete.3.ogg | foley | library zombie.foot.drag.concrete (outbreak) | 0.75 | -30.5 | -30.0 | -15.1 | opus 1ch 68k | 6 | ok |
| packages/kit/audio/sfx/zombie.foot.drag.concrete.4.ogg | foley | library zombie.foot.drag.concrete (outbreak) | 0.75 | -31.8 | -29.9 | -14.2 | opus 1ch 65k | 6 | ok |
| packages/kit/audio/sfx/zombie.foot.drag.concrete.5.ogg | foley | library zombie.foot.drag.concrete (outbreak) | 0.75 | -32.0 | -30.0 | -16.4 | opus 1ch 65k | 6 | ok |
| packages/kit/audio/sfx/zombie.foot.drag.grass.1.ogg | foley | library zombie.foot.drag.grass (outbreak) | 0.75 | -31.6 | -30.0 | -18.9 | opus 1ch 59k | 5 | ok |
| packages/kit/audio/sfx/zombie.foot.drag.grass.2.ogg | foley | library zombie.foot.drag.grass (outbreak) | 0.69 | -30.3 | -30.0 | -18.4 | opus 1ch 64k | 5 | ok |
| packages/kit/audio/sfx/zombie.foot.drag.grass.3.ogg | foley | library zombie.foot.drag.grass (outbreak) | 0.69 | -30.2 | -30.0 | -17.7 | opus 1ch 63k | 5 | ok |
| packages/kit/audio/sfx/zombie.foot.drag.grass.4.ogg | foley | library zombie.foot.drag.grass (outbreak) | 0.75 | -31.9 | -30.0 | -18.9 | opus 1ch 62k | 6 | ok |
| packages/kit/audio/sfx/zombie.foot.drag.grass.5.ogg | foley | library zombie.foot.drag.grass (outbreak) | 0.75 | -32.8 | -30.0 | -17.6 | opus 1ch 62k | 6 | ok |
| packages/kit/audio/sfx/zombie.foot.drag.wood.1.ogg | foley | library zombie.foot.drag.wood (outbreak) | 0.68 | -31.6 | -29.9 | -12.6 | opus 1ch 58k | 5 | ok |
| packages/kit/audio/sfx/zombie.foot.drag.wood.2.ogg | foley | library zombie.foot.drag.wood (outbreak) | 0.71 | -30.7 | -30.0 | -7.2 | opus 1ch 64k | 6 | ok |
| packages/kit/audio/sfx/zombie.foot.drag.wood.3.ogg | foley | library zombie.foot.drag.wood (outbreak) | 0.73 | -30.3 | -29.9 | -9.4 | opus 1ch 62k | 6 | ok |
| packages/kit/audio/sfx/zombie.foot.drag.wood.4.ogg | foley | library zombie.foot.drag.wood (outbreak) | 0.70 | -31.4 | -30.0 | -16.1 | opus 1ch 60k | 5 | ok |
| packages/kit/audio/sfx/zombie.foot.drag.wood.5.ogg | foley | library zombie.foot.drag.wood (outbreak) | 0.75 | -31.8 | -30.0 | -17.8 | opus 1ch 61k | 6 | ok |
| packages/kit/audio/sfx/zombie.foot.shuffle.concrete.1.ogg | foley | library zombie.foot.shuffle.concrete (outbreak) | 0.45 | -30.0 | -30.0 | -11.2 | opus 1ch 61k | 3 | ok |
| packages/kit/audio/sfx/zombie.foot.shuffle.concrete.2.ogg | foley | library zombie.foot.shuffle.concrete (outbreak) | 0.42 | -30.0 | -30.0 | -11.6 | opus 1ch 63k | 3 | ok |
| packages/kit/audio/sfx/zombie.foot.shuffle.concrete.3.ogg | foley | library zombie.foot.shuffle.concrete (outbreak) | 0.42 | -29.9 | -29.9 | -14.8 | opus 1ch 66k | 3 | ok |
| packages/kit/audio/sfx/zombie.foot.shuffle.concrete.4.ogg | foley | library zombie.foot.shuffle.concrete (outbreak) | 0.45 | -30.0 | -30.0 | -14.0 | opus 1ch 64k | 4 | ok |
| packages/kit/audio/sfx/zombie.foot.shuffle.concrete.5.ogg | foley | library zombie.foot.shuffle.concrete (outbreak) | 0.38 | -30.0 | -30.0 | -17.9 | opus 1ch 66k | 3 | ok |
| packages/kit/audio/sfx/zombie.foot.shuffle.grass.1.ogg | foley | library zombie.foot.shuffle.grass (outbreak) | 0.45 | -30.0 | -30.0 | -16.6 | opus 1ch 67k | 4 | ok |
| packages/kit/audio/sfx/zombie.foot.shuffle.grass.2.ogg | foley | library zombie.foot.shuffle.grass (outbreak) | 0.45 | -30.0 | -30.0 | -13.1 | opus 1ch 67k | 4 | ok |
| packages/kit/audio/sfx/zombie.foot.shuffle.grass.3.ogg | foley | library zombie.foot.shuffle.grass (outbreak) | 0.45 | -29.9 | -29.9 | -15.4 | opus 1ch 67k | 4 | ok |
| packages/kit/audio/sfx/zombie.foot.shuffle.grass.4.ogg | foley | library zombie.foot.shuffle.grass (outbreak) | 0.45 | -30.0 | -30.0 | -13.5 | opus 1ch 67k | 4 | ok |
| packages/kit/audio/sfx/zombie.foot.shuffle.grass.5.ogg | foley | library zombie.foot.shuffle.grass (outbreak) | 0.45 | -30.0 | -30.0 | -17.5 | opus 1ch 68k | 4 | ok |
| packages/kit/audio/sfx/zombie.foot.shuffle.wood.1.ogg | foley | library zombie.foot.shuffle.wood (outbreak) | 0.45 | -30.0 | -30.0 | -8.3 | opus 1ch 64k | 4 | ok |
| packages/kit/audio/sfx/zombie.foot.shuffle.wood.2.ogg | foley | library zombie.foot.shuffle.wood (outbreak) | 0.39 | -30.1 | -30.1 | -5.8 | opus 1ch 59k | 3 | ok |
| packages/kit/audio/sfx/zombie.foot.shuffle.wood.3.ogg | foley | library zombie.foot.shuffle.wood (outbreak) | 0.45 | -30.0 | -30.0 | -7.9 | opus 1ch 60k | 3 | ok |
| packages/kit/audio/sfx/zombie.foot.shuffle.wood.4.ogg | foley | library zombie.foot.shuffle.wood (outbreak) | 0.42 | -30.0 | -30.0 | -10.0 | opus 1ch 61k | 3 | ok |
| packages/kit/audio/sfx/zombie.foot.shuffle.wood.5.ogg | foley | library zombie.foot.shuffle.wood (outbreak) | 0.42 | -30.0 | -30.0 | -9.9 | opus 1ch 62k | 3 | ok |
| packages/kit/audio/sfx/zombie.foot.step.concrete.1.ogg | foley | library zombie.foot.step.concrete (outbreak) | 0.40 | -28.0 | -28.0 | -7.3 | opus 1ch 68k | 3 | ok |
| packages/kit/audio/sfx/zombie.foot.step.concrete.2.ogg | foley | library zombie.foot.step.concrete (outbreak) | 0.40 | -28.0 | -28.0 | -7.6 | opus 1ch 67k | 3 | ok |
| packages/kit/audio/sfx/zombie.foot.step.concrete.3.ogg | foley | library zombie.foot.step.concrete (outbreak) | 0.36 | -28.0 | -28.0 | -9.3 | opus 1ch 68k | 3 | ok |
| packages/kit/audio/sfx/zombie.foot.step.concrete.4.ogg | foley | library zombie.foot.step.concrete (outbreak) | 0.40 | -28.1 | -28.1 | -8.3 | opus 1ch 68k | 3 | ok |
| packages/kit/audio/sfx/zombie.foot.step.concrete.5.ogg | foley | library zombie.foot.step.concrete (outbreak) | 0.40 | -28.1 | -28.1 | -3.1 | opus 1ch 67k | 3 | ok |
| packages/kit/audio/sfx/zombie.foot.step.grass.1.ogg | foley | library zombie.foot.step.grass (outbreak) | 0.40 | -28.0 | -28.0 | -8.0 | opus 1ch 72k | 4 | ok |
| packages/kit/audio/sfx/zombie.foot.step.grass.2.ogg | foley | library zombie.foot.step.grass (outbreak) | 0.40 | -27.9 | -27.9 | -3.8 | opus 1ch 70k | 3 | ok |
| packages/kit/audio/sfx/zombie.foot.step.grass.3.ogg | foley | library zombie.foot.step.grass (outbreak) | 0.40 | -28.0 | -28.0 | -7.2 | opus 1ch 72k | 4 | ok |
| packages/kit/audio/sfx/zombie.foot.step.grass.4.ogg | foley | library zombie.foot.step.grass (outbreak) | 0.40 | -28.0 | -28.0 | -8.0 | opus 1ch 70k | 3 | ok |
| packages/kit/audio/sfx/zombie.foot.step.grass.5.ogg | foley | library zombie.foot.step.grass (outbreak) | 0.40 | -28.0 | -28.0 | -13.4 | opus 1ch 69k | 3 | ok |
| packages/kit/audio/sfx/zombie.foot.step.wood.1.ogg | foley | library zombie.foot.step.wood (outbreak) | 0.39 | -28.0 | -28.0 | -8.5 | opus 1ch 60k | 3 | ok |
| packages/kit/audio/sfx/zombie.foot.step.wood.2.ogg | foley | library zombie.foot.step.wood (outbreak) | 0.35 | -27.8 | -27.8 | -9.6 | opus 1ch 62k | 3 | ok |
| packages/kit/audio/sfx/zombie.foot.step.wood.3.ogg | foley | library zombie.foot.step.wood (outbreak) | 0.38 | -27.8 | -27.8 | -8.9 | opus 1ch 66k | 3 | ok |
| packages/kit/audio/sfx/zombie.foot.step.wood.4.ogg | foley | library zombie.foot.step.wood (outbreak) | 0.39 | -28.0 | -28.0 | -8.7 | opus 1ch 61k | 3 | ok |
| packages/kit/audio/sfx/zombie.foot.step.wood.5.ogg | foley | library zombie.foot.step.wood (outbreak) | 0.40 | -28.0 | -28.0 | -8.9 | opus 1ch 59k | 3 | ok |
| packages/kit/audio/sfx/zombie.groan.idle.1.ogg | vehicle | library zombie.groan.idle (outbreak) | 2.41 | -22.8 | -20.4 | -7.4 | opus 1ch 49k | 15 | ok |
| packages/kit/audio/sfx/zombie.groan.idle.2.ogg | vehicle | library zombie.groan.idle (outbreak) | 2.35 | -21.7 | -20.3 | -7.7 | opus 1ch 54k | 16 | ok |
| packages/kit/audio/sfx/zombie.groan.idle.3.ogg | vehicle | library zombie.groan.idle (outbreak) | 2.24 | -22.8 | -20.5 | -8.0 | opus 1ch 49k | 14 | ok |
| packages/kit/audio/sfx/zombie.groan.idle.4.ogg | vehicle | library zombie.groan.idle (outbreak) | 2.24 | -21.7 | -20.0 | -4.5 | opus 1ch 51k | 14 | ok |
| packages/kit/audio/sfx/zombie.groan.idle.5.ogg | vehicle | library zombie.groan.idle (outbreak) | 2.17 | -23.2 | -20.4 | -8.4 | opus 1ch 49k | 13 | ok |
| packages/kit/audio/sfx/zombie.groan.idle.6.ogg | vehicle | library zombie.groan.idle (outbreak) | 2.23 | -23.6 | -20.4 | -7.1 | opus 1ch 50k | 14 | ok |
| packages/kit/audio/sfx/zombie.hit.1.ogg | creature | library zombie.hit (outbreak) | 0.54 | -23.1 | -21.0 | -2.0 | opus 1ch 62k | 4 | ok |
| packages/kit/audio/sfx/zombie.hit.2.ogg | creature | library zombie.hit (outbreak) | 0.60 | -21.0 | -21.0 | -5.5 | opus 1ch 59k | 4 | ok |
| packages/kit/audio/sfx/zombie.hit.3.ogg | creature | library zombie.hit (outbreak) | 0.60 | -23.8 | -21.0 | -2.7 | opus 1ch 61k | 5 | ok |
| packages/kit/audio/sfx/zombie.hit.4.ogg | creature | library zombie.hit (outbreak) | 0.22 | -20.8 | -20.8 | -2.8 | opus 1ch 72k | 2 | ok |
| packages/kit/audio/sfx/zombie.horde.shuffle.1.ogg | creature | library zombie.horde.shuffle (outbreak) | 7.90 | -27.9 | -23.3 | -9.7 | opus 1ch 57k | 55 | ok |
