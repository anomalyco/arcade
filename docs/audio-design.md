# Shared Audio Engine & Audio Lab (`@arcade/kit/audio`)

## 1. Audit & Reuse Boundary

| Existing Source | Proven Mechanism | Reuse in `@arcade/kit/audio` | Stays in Game / Sibling Package |
| --- | --- | --- | --- |
| `games/getaway/src/audio/audio.ts` | Single `AudioContext` / `OfflineAudioContext` graph, `scheduleTime` clock, `duck` → `daze` low-pass → `master` → compressor (`-14 dB`, ratio `3`) → limiter (`-3 dB`, ratio `20`) → `0.66` output headroom, synthetic street-canyon impulse convolver (`1.7 s` with slap-back taps and 1-pole darkening), loop zero-padding trim, `KeyM` mute and `visibilitychange` suspend. | Promoted into `AudioRuntime` (`packages/kit/audio/runtime.ts`) with six typed category buses (`engine`, `tyre`, `impact`, `ambience`, `spell`, `ui`), seeded selection, voice budget/stealing, and `dispose()`. | Getaway's HUD mute badge and game-specific `SFX` list stay in `games/getaway/`. |
| `games/getaway/src/audio/{drivetrain,nitro,synth}.ts` & `packages/kit/vehicle/audio/*` | Class-specific `Character` specs, hysteresis `Gearbox` with `160 ms` shift cut, `tyreSlip` road/kerb/grass scrub + resonant squeal, `NitroGate` one-ignition-per-press latch on fuel exhaustion, 720° cycle `PeriodicWave` firing harmonics + triangle crank body + loop-faded 3s deterministic noise (`seed = 1729`). | Reused directly by `packages/kit/audio/synth.ts` and `VehicleAudioEmitter` (`packages/kit/audio/emitters.ts`) with identical constants and behaviour. | `packages/kit/vehicle/audio/` remains untouched so sibling vehicle work merges cleanly. |
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

audio.registerManifest(DEFAULT_SAMPLE_MANIFEST, "/sfx/")
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

// Focus loss, pause, round end, or reset guarantees immediate click-free silence:
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

### Supported and Verified Today
- **Unified Live & Offline Graph (`AudioRuntime`)**: Identical node graph, buses (`engine`, `tyre`, `impact`, `ambience`, `spell`, `ui`), ducking, daze low-pass, 32 Hz sub-cut high-pass, synthetic stereo street/room convolver reverb, and two-stage dynamics compressor + limiter for both `AudioContext` and `OfflineAudioContext`.
- **Layered Cue Recipes (`CueRecipe`)**: Sample and procedural synth layers (`sine`, `triangle`, `sawtooth`, `square`, `noise`, `modal-bar`, `modal-mallet`, `harmonic-swarm`), sample-accurate linear attack / hold / exponential `-60 dB` decay envelopes, frequency and filter glides, seeded `mulberry32` round-robin (no immediate repeat) and weighted sample selection, coupled strike variation, per-cue cooldowns, and `"drop" | "steal-oldest" | "replace"` voice policies.
- **World-Driven Emitters (`VehicleAudioEmitter`, `SpellAudioEmitter`, `ActivationGate`)**: Smoothed parameter automation (`setTargetAtTime`), 2D spatial attenuation, stereo panning, bounded Doppler, segment/AABB visibility occlusion filtering, exactly one start per activation press, latch-off on fuel/mana depletion while held, and idempotent silence on `stop()`, `reset()`, `suspend()`, and `dispose()`.
- **Offline Asset Manifest & Provenance (`SampleManifest`, `SampleBank`)**: Decoded buffer cache transferable across contexts, MP3 encoder zero-padding trim for seamless loops, existing Getaway/Blackout project samples plus curated ElevenLabs `eleven_text_to_sound_v2` stems generated offline during development with recorded prompts and metadata.
- **Offline WAV & Spectrogram Proof (`renderOfflineScenario`)**: Deterministic event scheduling, 16-bit PCM WAV export, peak/RMS/LUFS/clipping/discontinuity diagnostics, quiet-window verification, and Radix-2 FFT log-frequency spectrograms.

### Intentionally Not Claimed
- **Independent pitch/time stretching**: Sample layers expose `rate` (`AudioBufferSourceNode.playbackRate`), which shifts pitch and duration together. Phase-vocoder or WSOLA time-stretching is not implemented.
- **Granular sample synthesis**: Continuous engine and spell voices use band-limited procedural synthesis (`PeriodicWave` cylinder harmonics, modal partials, and filtered noise) plus crossfaded loops rather than a granular cloud scheduler.
- **Node-graph authoring UI**: All interactive tuning lives in the shared `LabPanel` (`packages/kit/lab-panel.ts`).
