# Wings audio

All sound is procedural Web Audio, so it ships zero audio bytes and doesn't block loading. `src/audio.ts` keeps the
`GameAudio` contract and re-exports `createAudio()` from `engine.ts`.

| File | Role |
| --- | --- |
| `buffers.ts` | Sample bank rendered once at unlock (~25 ms): white, pink, and brown noise; crackle; Vulcan, GAU-8, and rotor pulse-train loops; reverb impulse. |
| `core.ts` | Buses, limiter, reverb, the `Spatial` chain (distance gain → air-absorption lowpass → panner), the `Shot` one-shot builder, and the `Held` sustain loop. |
| `engines.ts` | Per-vehicle `EngineVoice` (jets and the rotor) plus the shared own-vehicle `Wind`. |
| `sfx.ts` | Weapons, impacts, explosions, flares, the radar pulse, stings, UI blips, and cockpit tones. |
| `engine.ts` | `createAudio()`: voice selection, event routing, lifecycle. |
| `preview.html/.ts` | Audition page: `/arcade/wings/src/audio/preview.html`. |

## Signal flow

```
engineBus (0.55) ─┐
sfxBus    (0.90) ─┼─► limiter (-8 dB, 14:1, 2 ms) ─► master (volume/mute) ─► destination
uiBus     (0.50) ─┤                                                  └──► analyser (peak())
reverb return ────┘   (one shared ConvolverNode with a 2.8 s procedural "big sky" impulse)
```

Spatial sounds set `PannerNode.rolloffFactor = 0`, and we compute distance gain ourselves (inverse distance with a
per-sound reference distance). That gives one consistent loudness number for culling and voice selection. Air absorption
is `20 kHz / (1 + d/220 m)`, so a jet sounds bright at 200 m and only rumbles at 3 km. Explosions also arrive late by the
speed-of-sound delay (`d / 343`, capped at 1.2 s). Reverb sends scale with `sqrt(distanceGain)`, so distant sounds are
relatively wetter.

## Sound design

- **F/A-18:** triangle turbine whine at 420→1320 Hz, plus an inharmonic ×2.76 overtone (sounds like a turbine rather
  than a musical note), and a pink-noise roar whose lowpass opens with throttle. Above throttle 0.95 the afterburner
  adds brown-noise rumble below 280 Hz, a 42 Hz sub, and high-passed crackle.
- **A-10:** the TF34 "vacuum-cleaner" whistle, a 3.6→5.2 kHz sine plus a ×0.53 fan tone, with a soft roar. There is no
  afterburner because the real aircraft has none. Throttle above 0.95 pushes the whistle 35% harder instead.
- **YF-12:** dominated by deep brown-noise roar, with a low whine and a heavy afterburner (32 Hz sub).
- **Apache:** a pre-rendered 4-blade chop loop at 19.2 Hz blade-pass, with deliberately uneven blades (1, .82, .93,
  .78). Rotor rpm is governed, so collective changes rpm by only ±3%. Collective mostly adds loudness and brightness;
  forward speed adds blade-slap brightness. Also: a sawtooth tail-rotor buzz at ×5.6 blade-pass, a quiet T700 turbine
  whine, and rotor-wash noise.
- **Own vehicle:** centered (no panner) and 25% brighter. A shared wind layer (band-passed pink noise) rises with
  airspeed.
- **Doppler:** relative radial velocity between the source and an estimated listener velocity. The ratio is clamped to
  0.5–2 and raised to the power 0.6, so a fly-by gives about ×1.5 approaching and ×0.75 receding. Real Doppler at
  260 m/s would be ×4 and make the turbine tones cartoonish. The ratio scales every oscillator frequency and noise
  playback rate.
- **Guns:**
  - `cannon20` and `gau8` are sustain loops (`Held`), not one-shots. Each `fire` event extends the gain automation on
    the audio clock (hold of 0.16 s and 0.12 s), so 30 events/s cost about 3 AudioParam calls each and you hear a
    continuous buzz-saw or BRRRT.
  - The GAU-8 loop is 65 rounds/s of pitch-dropping thumps with heavy tanh saturation, plus a 65 Hz sub. On release it
    plays a spin-down growl and a canyon-echo rumble.
  - `chaingun30` uses individual thumps.
- **Rockets and missiles:** an ignition pop or thump plus crackle, then a band-swept noise whoosh. The `aim47` is longer
  and louder.
- **Impacts:**
  - A remote hit is a bright noise snap plus an inharmonic plate ring at 1870, 2730, and 4110 Hz.
  - When we get hit, the sound is centered: a 100→36 Hz thud, crunch, and a lower ring. Engines duck by 6 dB for 120 ms.
  - When our rounds connect, a dry UI tick plays (needs `setLocalPlayer`).
- **Explosion:** a crack (near only), a brown-noise body behind a lowpass that slams shut from 2.6 kHz to 160 Hz, a
  72→26 Hz sub, and a 3 s rumble tail with debris crackle. Nearby explosions duck the engines.
- **Radar pulse** (the cosmic-horror signature): a sonar ping with a tritone shadow and an uneasy vibrato, a dissonant
  root, minor-second, and tritone cluster sliding about 4 octaves into the abyss, a 34 Hz sub swell, and a whispering
  formant breath. Most of it goes heavily into the reverb.
- **Stings:** a kill plays a restrained E5→B5 bell pair. Our own death plays a sinking minor-second drone. Match end
  plays a dark chord.
- **Cockpit tones** (`Held`, so callers can invoke them every frame or once):
  - `lock-tone`: 900 Hz beeps at 6 Hz.
  - `locked`: solid 1.65 kHz tone.
  - `warning`: a 1.0/1.4 kHz warble, gated at 2.5 Hz.
  - Being locked by an enemy (`lock.target === ownId`) triggers `warning`.

## STORMFRONT ambience and fleet AA

Levels are measured against the reduced baseline: `MASTER_TRIM` 0.4, sfx bus 0.6, limiter −16 dB.

- **Ambience** (`ambience.ts`, `ambienceBus` 0.5):
  - No rain hiss. The bed is a very soft storm rumble: brown noise behind two cascaded 140 Hz lowpasses, with a slow
    8–16 s swell.
  - Wind is lowpassed brown noise. It gusts gently, and its cutoff and level rise only a little with own airspeed.
  - Unseen distant thunder rolls every 25–60 s.
  - Measured: 100% of the bed's energy is below 300 Hz, with a peak of about 0.014.
  - `setStorm({ rain, cockpit, enabled })`. `rain` scales the bed. `cockpit` closes a 2.6 kHz lowpass over all world
    sound; UI sounds are not affected.
- **`thunder(delay, intensity)`:** the sound is scheduled `delay` seconds ahead. Strikes under 3 km get a lowpassed
  boom. Every strike gets a long brown-noise rumble behind two lowpasses at 90–300 Hz, with random "rolls", plus a sub
  layer. About 99% of its energy is below 300 Hz.
- **Smoothness rules** (applied after feedback that it sounded "weird" and like "TV static"):
  - No white noise or crackle anywhere.
  - Envelope attacks are at least 3 ms.
  - One-shots get a random ±5% pitch per shot (`Shot.vary`).
  - Rotary-gun and CIWS loops are jittered low thumps behind 1.1–2.4 kHz lowpasses: a rip, not a buzz.
  - Jets are a pink/brown-noise roar with a quiet sine hum. Tones stay below about 2.6 kHz.
  - The reverb impulse is dark.
- **AA:**
  - CIWS is a 75 rounds/s tearing loop (`Held`, one per turret, kept alive by the ~10/s `aa` events), with a short
    echo tail.
  - The 5-inch gun is a deep report with a speed-of-sound delay.
  - A flak burst is a dry "KRAK", a dark puff, and shrapnel crackle. It's much shorter than an explosion.
  - An `explosion` counts as flak when it carries `kind: "flak"` or lands within 150 m of a 5-inch `aa.aim` from the
    last 8 s.
  - Legacy `fire` events whose vehicle id is `aa:*` are routed to CIWS (weapon `gau8`) or the 5-inch gun.

## Performance

- Buffers are rendered once and every voice reuses them. Noise starts at random offsets, so repeats never sound
  identical.
- Up to 8 engine voices, picked by estimated loudness at the listener. The own vehicle is always included. Existing
  voices get a ×1.4 hysteresis bonus so voices don't swap back and forth. At most 2 new voice graphs are built per frame.
- HRTF panning is limited to 6 panners in total: the nearest 3 engines, plus near one-shots. Everything else uses
  equal-power panning.
- One-shots: 40 globally, with per-category caps (for example 6 explosions and 6 hits). There are per-vehicle rate limits
  for every weapon. Inaudible sounds (gain × loudness < 0.002) are culled before any node is built.
- Finished graphs are disconnected by housekeeping, which runs each `updateVehicles` call plus a 250 ms timer.
- A watchdog fades engines if `updateVehicles` stops for 500 ms. The context is suspended while the tab is hidden.
  Muting builds no new graphs.
- Measured in headless Chromium with 40 vehicles, 8 voices, and a GAU-8 loop: `updateVehicles` takes 0.1 ms median and
  0.2 ms p95.
