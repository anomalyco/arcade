# Shared Audio Engine & Audio Lab (`@arcade/kit/audio`)

The shared sound library (semantic ids, variants, generation and curation) and Outbreak's positional sound are in
[sfx-library.md](sfx-library.md).

This is an additive library and Lab candidate. It does not replace either game's approved audio path.
The original branch report below describes implementation and source-branch checks; integrated verification is
in the release 1 PR (#13).

## Integration boundary

- The Lab app (`/arcade/lab/`) registers **Audio** in the shared section selector. Entering the section, changing
  controls, and returning after leaving create no live audio context. **Audition** is the only live unlock action;
  **Render offline** and **Render A/B** use native browser offline rendering. Stop, blur, hidden documents, section
  changes and page exit interrupt playback. Returning does not restart it.
- `scripts/audio-assets.ts` serves and emits the manifest's 20 MP3 files under each host's `audio-assets/` directory.
  The source files remain owned by Getaway's `public/sfx` tree. Blackout and Outbreak also watch that tree in CI.
  Relative asset roots resolve beneath `/arcade/<game>/`, including all four generated stems, with no cross-origin
  request to a development preview. Outbreak gets the asset route; its current visual/game UI is unchanged.
- Character specs, gearbox, tyre-slip policy, nitro gating, and deterministic noise come from the existing vehicle
  package. `EngineSynthVoice` and `TyreSynthVoice` retain candidate graph/lifecycle adapters with explicit ownership
  and disposal. Their output has not been established as waveform-equivalent to the shipped `EngineVoice`/`TyreVoice`.
  Neither game switches to these candidates. The only existing synth edit exports its unchanged noise helper.
- The deterministic test context is imported only by tests, and the Vite integration rejects it in browser module
  graphs. Production offline rendering uses the actual `OfflineAudioContext`; unsupported browsers report that
  limitation rather than substituting a software simulation.
- Sample telemetry separates fetched/decoded assets from procedural fallbacks. Native-browser proof must establish
  decode success, not merely a nonzero fallback-buffer count. Source-ended callbacks disconnect complete cue graphs;
  runtime interruption/reset/disposal also owns continuous emitters.

## 1. Audit & Reuse Boundary

| Existing Source | Proven Mechanism | Reuse in `@arcade/kit/audio` | Stays in Game / Sibling Package |
| --- | --- | --- | --- |
| `games/getaway/src/audio/audio.ts` | Single `AudioContext` / `OfflineAudioContext` graph, `scheduleTime` clock, `duck` → `daze` low-pass → `master` → compressor (`-14 dB`, ratio `3`) → limiter (`-3 dB`, ratio `20`) → `0.66` output headroom, synthetic street-canyon impulse convolver (`1.7 s` with slap-back taps and 1-pole darkening), loop zero-padding trim, `KeyM` mute and `visibilitychange` suspend. | Promoted into `AudioRuntime` (`packages/kit/audio/runtime.ts`) with six typed category buses (`engine`, `tyre`, `impact`, `ambience`, `spell`, `ui`), seeded selection, voice budget/stealing, and `dispose()`. | Getaway's HUD mute badge and game-specific `SFX` list stay in `games/getaway/`. |
| `games/getaway/src/audio/{drivetrain,nitro,synth}.ts` & `packages/kit/vehicle/audio/*` | Class-specific specs, hysteresis gearbox, tyre-slip policy, nitro exhaustion latch, firing harmonics and deterministic noise. | Specs, gearbox, slip policy, gate and noise are shared directly. Candidate voice graphs adapt those mechanisms to the new runtime's buses and lifecycle. | Shipped vehicle voice graphs stay in use; candidate waveform parity is not established. |
| `games/getaway/src/audio/{environment,game-audio,offline}.ts` | 2D segment/AABB slab test `blocked()`, distance rolloff + stereo pan + air-absorption low-pass + distance reverb send, bounded Doppler (`SOUND = 260 m/s`), velocity-layered `crash()` with no-repeat variant picking, `OfflineAudioContext` WAV rendering and click/clip diagnostics. | Promoted into `AudioRuntime.spatialize()`, `createBoxOcclusionQuery()`, `impact_crash_layered` recipe, and `packages/kit/audio/offline.ts`. | Getaway round phase stingers, police radio chatter, and helicopter rotor tracking stay in `games/getaway/src/audio/game-audio.ts`. |
| `games/blackout/src/audio/{sound,vehicle-sound}.ts` | Procedural multi-layer transient bursts + pitched sine/triangle drops (`shot`, `clink`, `step`, `explode`) and equal-power idle/drive loop crossfading. | Generalized into declarative `SynthLayerSpec` + `SampleLayerSpec` recipes (`packages/kit/audio/cues.ts`) and procedural presets (`impact`, `metalClink`, `magicCharge`). | Blackout weapon-specific `EV.*` animation bitmask bindings stay in `games/blackout/`. |
| Reference: `cuelume` (MIT, studied for approach only) | Fast linear attack (`1–8 ms`) into exponential `-60 dB` decay (`fallTime`), inharmonic modal bar/mallet partials (`[1, 2.76, 5.4]`, `[1, 3.99]`) with faster upper-mode damping, coupled strike `{ pitch, force }` variation (harder hits are louder and brighter together), and voice handoff on retrigger. | Adopted in `CueRecipe` envelope scheduling, modal synth layers, coupled strike variation, and `"replace"` / `"steal-oldest"` voice policies. | No runtime dependency; DOM `data-cuelume-*` UI bindings are out of scope. |

---

## 2. Ideal Consumer Call Sites

### 2.1 Runtime, Mix Buses, Occlusion & One-Shot / Layered Cues

```ts
import {
  AudioRuntime,
  DEFAULT_CUES,
  DEFAULT_SAMPLE_MANIFEST,
  createBoxOcclusionQuery,
} from "@arcade/kit/audio"

const audio = new AudioRuntime({
  seed: 7,
  maxVoices: 24,
  storageKey: "arcade.mute",
  visibilityQuery: createBoxOcclusionQuery(city.boxes),
})

audio.registerManifest(DEFAULT_SAMPLE_MANIFEST, new URL("./audio-assets/", document.baseURI).href)
audio.registerCues(DEFAULT_CUES)

// Explicit user-gesture unlock (never autoplays on load)
auditionButton.addEventListener("click", () => void audio.unlock())

// Update listener pose once per frame
audio.setListener({
  x: camera.fx,
  z: camera.fz,
  vx: player.vx,
  vz: player.vz,
  rightX: cameraRight[0],
  rightZ: cameraRight[1],
  earHeight: 16,
})

// Trigger a layered cue (sample + procedural synth layers, seeded round-robin,
// coupled strike pitch/gain/brightness variation, spatial attenuation & occlusion)
audio.playCue("impact_crash_layered", {
  intensity: 0.82,
  force: 0.82,
  material: "metal",
  position: { x: hit.x, z: hit.z, vx: car.vx, vz: car.vz },
})
```

### 2.2 Continuous World-Driven Emitters (Vehicles & Spells)

```ts
import { VehicleAudioEmitter, SpellAudioEmitter } from "@arcade/kit/audio"

const vehicleEmitter = new VehicleAudioEmitter(audio, {
  id: "player-car",
  vehicleClass: "muscle",
})

const spellEmitter = new SpellAudioEmitter(audio, {
  id: "player-mage",
})

// Inside the fixed or interpolated frame update:
vehicleEmitter.update(
  {
    speed: car.speed,
    throttle: input.throttle,
    boost: input.boost,
    fuel: car.boostFuel,
    lateralSlip: car.drift,
    handbrake: input.handbrake,
    airborne: car.airborne,
    surface: acoustics.surface(car.x, car.z),
    position: { x: car.x, z: car.z, vx: car.vx, vz: car.vz },
  },
  dt,
)

// Transient collision routed through emitter cooldown + re-arm hysteresis:
if (car.impact > 2.5) {
  vehicleEmitter.impact(car.impact / 20, "metal", { x: car.x, z: car.z })
}

// Continuous spell charge with one-start-per-press mana gate:
spellEmitter.update(
  {
    active: input.castHeld,
    charge: mage.chargeProgress,
    mana: mage.mana,
    position: { x: mage.x, z: mage.z },
  },
  dt,
)

// Interrupt emitters and schedule a short fade before suspending on focus loss:
window.addEventListener("blur", () => {
  vehicleEmitter.stop()
  spellEmitter.stop()
  audio.suspend()
})
```

### 2.3 Audio Lab Section Registration (`fx-kit` / Shared Lab Compatible)

```ts
import { lab } from "@arcade/kit/lab/main"
import { createAudioLab } from "@arcade/kit/audio/lab"

void lab({
  camera,
  sections: [createAudioLab],
})
```

---

## 3. Supported Capabilities vs. Deferred Scope

### Source-branch capabilities (see integration verification for the combined build)
- **Unified Live & Offline Graph (`AudioRuntime`)**: Identical node graph, buses (`engine`, `tyre`, `impact`, `ambience`, `spell`, `ui`), ducking, daze low-pass, 32 Hz sub-cut high-pass, synthetic stereo street/room convolver reverb, and two-stage dynamics compressor + limiter for both `AudioContext` and `OfflineAudioContext`.
- **Layered Cue Recipes (`CueRecipe`)**: Sample and procedural synth layers (`sine`, `triangle`, `sawtooth`, `square`, `noise`, `modal-bar`, `modal-mallet`, `harmonic-swarm`), sample-accurate linear attack / hold / exponential `-60 dB` decay envelopes, frequency and filter glides, seeded `mulberry32` round-robin (no immediate repeat) and weighted sample selection, coupled strike variation, per-cue cooldowns, and `"drop" | "steal-oldest" | "replace"` voice policies.
- **World-Driven Emitters (`VehicleAudioEmitter`, `SpellAudioEmitter`, `ActivationGate`)**: Smoothed parameter automation (`setTargetAtTime`), 2D spatial attenuation, stereo panning, bounded Doppler, segment/AABB visibility occlusion filtering, exactly one start per activation press, latch-off on fuel/mana depletion while held, and idempotent silence on `stop()`, `reset()`, `suspend()`, and `dispose()`.
- **Offline Asset Manifest & Provenance (`SampleManifest`, `SampleBank`)**: Decoded buffer cache transferable across contexts, MP3 encoder zero-padding trim for seamless loops, existing Getaway/Blackout project samples plus curated ElevenLabs `eleven_text_to_sound_v2` stems generated offline during development with recorded prompts and metadata.
- **Offline WAV & Spectrogram Proof (`renderWorldSignalReplayOffline`, `renderOcclusionReverbAb`)**: Deterministic event scheduling, 16-bit PCM WAV export, peak/RMS/estimated-LUFS/clipping/discontinuity diagnostics, quiet-window verification, and Radix-2 FFT log-frequency spectrograms.

### Intentionally Not Claimed
- **Independent pitch/time stretching**: Sample layers expose `rate` (`AudioBufferSourceNode.playbackRate`), which shifts pitch and duration together. Phase-vocoder or WSOLA time-stretching is not implemented.
- **Granular sample synthesis**: Continuous engine and spell voices use band-limited procedural synthesis (`PeriodicWave` cylinder harmonics, modal partials, and filtered noise) plus crossfaded loops rather than a granular cloud scheduler.
- **Node-graph authoring UI**: All interactive tuning lives in the shared `LabPanel` (`packages/kit/lab-panel.ts`).

---

## 4. Outbreak Sound Pass: Mix Hierarchy, 11-Surface Materials & Voice Priority

### 4.1 Sample Envelope Semantics & Priority Voice Stealing (`@arcade/kit/audio`)
- **Recorded Sample vs. Procedural Envelope**: In `AudioRuntime.scheduleSampleLayer`, recorded one-shot samples from `SFX_LIBRARY` (`layer.envelope === undefined`) play at their curated natural envelope with click-free fade-in (`fadeInSeconds`, default `2 ms`) and tail fade-out (`fadeOutSeconds`, default `8 ms`), rather than being crushed by the procedural synth fallback's `0.22 s` exponential `-60 dB` decay curve (`DEFAULT_ENVELOPE.decay`). Procedural sample+synth recipes in `DEFAULT_CUES` retain explicit `envelope.decay` curves.
- **Priority-Based Voice Stealing**: `CueRecipe`, `SfxSpec`, `PlayCueOptions`, and Outbreak's `SoundEvent` carry an integer `priority` (`1..100`, default `50`). When `activeVoices.size >= maxVoices`, `AudioRuntime.enforceVoiceBudget` first evicts the oldest non-looping voice whose `priority` is strictly lower than the incoming cue's priority (lowest priority first, oldest tie-breaker), before falling back to stealing the oldest voice of equal priority (`steal-oldest`) or dropping (`drop`). Continuous loops (`ownerKey` / `loop: true`) are never stolen by one-shots.
- **Scheduled Cooldowns**: `AudioRuntime.playCue` checks `playAt - lastAt < cooldownSeconds` (where `playAt = max(now, options.time)`), so future-delayed cues such as shell casings (`+0.38 s`) and bullet impacts (`+d / 360 s`) never falsely trip their own cooldown when another cue was scheduled slightly further ahead.

### 4.2 6-Tier Mix Hierarchy & Measured Offline Loudness
Outbreak enforces a clear 6-tier loudness hierarchy across 6 independent Lab mix buses (`audioWeapons: 100%`, `audioZombies: 100%`, `audioImpacts: 95%`, `audioMovement: 85%`, `audioUi: 80%`, `audioAmbience: 65%`), with `32` voices (`CROWD_HEADROOM = 8` reserved above zombie footsteps), steeper spatial rolloff (`audioFalloff = 1.55`, `refDistance × 0.78`), and stronger wall low-pass occlusion (`22000 → 520 Hz` and `(1 - 0.58 * occ)²` gain):

| Tier | Category | Bus | Priority | Representative Cues | Offline Measured Level (at listener / 1 m) |
| --- | --- | --- | --: | --- | --- |
| **1 (Loudest)** | Gunshots, explosions, Screamer shriek, car alarm | `weapon` / `voice` / `foley` | `85–100` | `gun.pistol.shot` (`-9 LUFS`, `0.88`), `bomb.explode` (`-8 LUFS`, `0.95`), `zombie.screamer.scream` (`-10 LUFS`, `0.92`) | `-11.0` to `-14.0 LUFS` (`-1.4` to `-3.5 dBFS` peak) |
| **2** | Zombie attacks, alerts, deaths, Brute slam, survivor hurt | `voice` / `impact` | `72–88` | `zombie.attack` (`-16 LUFS`, `0.58`), `zombie.alert` (`-17 LUFS`, `0.52`), `body.hurt` (`-17 LUFS`, `0.55`) | `-17.4` to `-20.0 LUFS` (`-5.1` to `-6.9 dBFS` peak) |
| **3** | Bullet/melee impacts, glass break, door bash, barricade break | `impact` (`95%`) | `55–78` | `zombie.hit` (`0.54`), `impact.bullet.*` (`0.40–0.46`), `glass.break` (`0.62`), `door.bash` (`0.62`) | `-19.3` to `-22.5 LUFS` (`-6.2` to `-9.5 dBFS` peak) |
| **4** | Doors, windows, reload parts, pickups, teammate & zombie steps | `foley` (`85%`) / `impact` | `18–60` | `door.wood.open` (`0.38`), `gun.pistol.slide` (`0.36`), `zombie.foot.*` (`0.18–0.22`, `drop`) | `-24.5` to `-31.0 LUFS` (`-11.0` to `-16.5 dBFS` peak) |
| **5 (Quiet)** | Local player self-footsteps (`crouch` / `walk` / `run`) | `foley` (`85%`) | `28` | `foot.<surface>.{walk,run}` × `profile.gain` × `modeGain` × `0.62` self-scale | Crouch: `-43` to `-49 LUFS`; Walk: `-34` to `-36 LUFS`; Sprint: `-28` to `-29 LUFS` (**16–22 dB below pistol shot**) |
| **6 (Bed)** | Day/night suburb beds, threat drone, distant life | `ambience` (`65%`) | `45–50` | `ambience.day.suburb` (`0.16`), `ambience.night.suburb` (`0.18`), `ambience.threat` (`0.20`), `creature.crow.caw` (`0.30`) | `-34.5` to `-39.5 LUFS` outdoor; `-45+ LUFS` muffled indoors (`750 Hz` LPF) |

### 4.3 Pure 11-Surface Material Resolver (`surfaceAt`) & Material Impacts
`surfaceAt(town, x, y, extra?)` in `games/outbreak/src/audio/space.ts` resolves any world coordinate `(x, y)` to one of 11 `FootSurface` materials, matching `ground.ts`, `level.ts`, `interiors/plan.ts`, `interiors/wgsl.ts`, `discovery/vignettes.ts`, and `blood/stains.ts`:

| Surface | World Geometry | Footstep Cue (`walk` / `run`) | `profile.gain` | `rate` | `cutoffHz` |
| --- | --- | --- | --: | --: | --: |
| `concrete` | Asphalt streets (`39.78..48.22`), sidewalks (`37.9..39.28`, `48.72..50.1`), front walkways, commercial concrete | `foot.concrete.{walk,run}` | `0.62` | `1.00` | `5200 Hz` |
| `grass` | Open lawns and yards outside road bands and driveways | `foot.grass.{walk,run}` | `0.68` | `1.00` | `4200 Hz` |
| `wood` | House interiors (outside kitchen/bath/rugs), front porches, garden sheds, church | `foot.wood.{walk,run}` | `0.72` | `1.00` | `4800 Hz` |
| `tile` | House SE kitchen & NE washroom wing, pharmacy, grocery, diner, clinic, police station | `foot.tile.walk` / `foot.concrete.run` | `0.74` | `1.08` | `7800 Hz` |
| `carpet` | Interior rugs (`planInterior(b, houseSeed).rugs`) | `foot.grass.{walk,run}` | `0.42` | `0.88` | `1550 Hz` |
| `gravel` | West gravel driveways (`[x0 - 3.0, x0 - 0.35]`) | `foot.gravel.walk` / `foot.grass.run` | `0.82` | `1.06` | `6800 Hz` |
| `dirt` | Curb-verge moss/dirt strips (`39.28..39.78`, `48.22..48.72`) and tree dirt rings (`r <= 0.72 m`) | `foot.grass.{walk,run}` | `0.64` | `0.88` | `2600 Hz` |
| `puddle` | Wet street potholes (`STREET_PUDDLES` in `ground.ts`) | `foot.puddle.walk` | `0.85` | `1.08` | `5800 Hz` |
| `metal` | Manhole covers, storm drain grates, exterior vehicle roofs/bonnets, warehouse floor | `impact.bullet.metal` | `0.52` | `1.16` | `4600 Hz` |
| `glass` | Broken bottle/window shard stores (`glass:*`) and vignette glass (skipped when crouching) | `foot.glass.step` | `0.68` | `1.04` | `7400 Hz` |
| `blood` | Live spreading blood pools (`currentBloodStains().poolUnder`) and ambient blood pools | `foot.puddle.walk` | `0.56` | `0.84` | `2200 Hz` |

Bullet (`shotImpacts`) and melee (`meleeImpact`) world impacts resolve hit geometry to `zombie.hit` (flesh), `impact.bullet.wood` (wooden doors, boards, house wood siding, wood fences, trees, indoor wood furniture), `impact.bullet.plaster` (interior plaster walls), `impact.bullet.concrete` (commercial brick/concrete facades, street), `impact.bullet.metal` (vehicles, warehouses, chain-link fences, dumpsters, appliances), and `impact.bullet.glass` (intact window panes).

### 4.4 Lab `Sound` Group Controls
`games/outbreak/src/audio/settings.ts` exposes all tunables in the shared `LabPanel` under **Sound**:
- **Sound profile** (`audioMode`): `Sound pass (balanced & materials)` (`1`, default) vs `Today` (`0`, pre-pass 3-surface baseline) one click away.
- **Mix buses**: `audioWeapons`, `audioZombies`, `audioImpacts`, `audioMovement`, `audioAmbience`, `audioUi` (`0..100%`).
- **Footsteps by surface**: `audioSelfStep` plus per-surface loudness sliders (`audioStepConcrete`, `audioStepGrass`, `audioStepWood`, `audioStepTile`, `audioStepCarpet`, `audioStepGravel`, `audioStepDirt`, `audioStepPuddle`, `audioStepMetal`, `audioStepGlass`, `audioStepBlood`, `0..200%`).
- **Spatial & engine**: `audioOcclusion` (`0..1`), `audioFalloff` (`0.8..2.5×`), `audioReverb` (`0..1`), and `audioVoiceCap` (`8..48 voices`, default `32`).
