import type { LabControl, LabSettings } from "../lab-panel"

/** Mix buses. `weapon`, `foley` and `voice` carry the shared sound library's guns, movement/handling and creatures. */
export type MixCategory = "engine" | "tyre" | "impact" | "ambience" | "spell" | "ui" | "weapon" | "foley" | "voice"

export type MaterialTag =
  | "metal"
  | "concrete"
  | "wood"
  | "glass"
  | "flesh"
  | "rubber"
  | "road"
  | "kerb"
  | "grass"
  | "arcane"
  | "fire"
  | "ice"

export type SurfaceTag = "road" | "kerb" | "grass"

export type StealPolicy = "drop" | "steal-oldest" | "replace"

export type SampleSelectionMode = "round-robin" | "weighted" | "random"

export type ListenerState = {
  x: number
  y?: number
  z: number
  vx?: number
  vz?: number
  /** Screen/camera right unit vector on the XZ plane for stereo panning. Defaults to (1, 0). */
  rightX?: number
  rightZ?: number
  /** Minimum vertical ear clearance above the ground plane in metres. Defaults to 16. */
  earHeight?: number
  /** Lateral distance in metres for near-full stereo pan. Defaults to 38 (a street seen from a car camera). */
  panScale?: number
}

export type SourcePose = {
  x: number
  y?: number
  z: number
  vx?: number
  vz?: number
  /** Reference distance in metres before rolloff begins. */
  refDistance?: number
  /** Distance in metres where attenuation reaches zero. Defaults to 150. */
  maxDistance?: number
  /** Inverse-distance rolloff exponent. Defaults to 1.25. */
  rolloff?: number
  /** Multiplier for Doppler pitch shift. Defaults to 1. */
  dopplerScale?: number
}

export type SpatialMix = {
  gain: number
  pan: number
  cutoffHz: number
  wet: number
  distance: number
  doppler: number
  occlusion: number
}

/**
 * Returns true/false or a 0..1 occlusion amount between listener (lx, lz) and source (sx, sz).
 */
export type VisibilityQuery = (listenerX: number, listenerZ: number, sourceX: number, sourceZ: number) => number | boolean

export type OccluderBox = {
  x0: number
  x1: number
  z0: number
  z1: number
  h?: number
}

export type EnvelopeSpec = {
  /** Delay after cue trigger before this layer starts, in seconds. */
  offset?: number
  /** Linear attack ramp duration in seconds (e.g. 0.002..0.05). */
  attack: number
  /** Optional flat sustain hold before decay, in seconds. */
  hold?: number
  /** Time in seconds for the tail to decay by 60 dB after attack + hold. */
  decay: number
  /** Peak linear gain at the end of attack. */
  peak: number
}

export type WeightedSampleRef = string | { id: string; weight?: number; rate?: number; gain?: number }

/**
 * Sample-backed voice layer.
 * Note: `rate` controls `AudioBufferSourceNode.playbackRate`, which scales pitch and duration together.
 * Independent pitch/time stretching is not claimed.
 */
export type SampleLayerSpec = {
  kind: "sample"
  samples: readonly WeightedSampleRef[]
  selection?: SampleSelectionMode
  gain?: number
  /** Playback rate multiplier (scales pitch and duration together). */
  rate?: number
  pitchVariation?: number
  gainVariation?: number
  timingVariation?: number
  filterType?: BiquadFilterType
  cutoffHz?: number
  filterGlideToHz?: number
  q?: number
  wet?: number
  loop?: boolean
  envelope?: Partial<EnvelopeSpec>
  /** Minimum normalized cue intensity (0..1) required for this layer to fire. */
  minIntensity?: number
  /** Maximum normalized cue intensity (0..1) where this layer remains active. */
  maxIntensity?: number
  /** Optional intensity crossfade curve: "fade-in" | "fade-out" | "bell". */
  intensityCurve?: "fade-in" | "fade-out" | "bell"
}

export type SynthWaveform = OscillatorType | "noise" | "modal-bar" | "modal-mallet" | "harmonic-swarm"

export type SynthLayerSpec = {
  kind: "synth"
  waveform: SynthWaveform
  frequency: number
  glideToHz?: number
  glideSeconds?: number
  detuneCents?: number
  filterType?: BiquadFilterType
  cutoffHz?: number
  filterGlideToHz?: number
  q?: number
  envelope: EnvelopeSpec
  pitchVariation?: number
  gainVariation?: number
  timingVariation?: number
  /** Scales filter cutoff or upper-mode brightness with strike force (0..1). */
  forceBrightness?: number
  wet?: number
  minIntensity?: number
  maxIntensity?: number
  intensityCurve?: "fade-in" | "fade-out" | "bell"
}

export type CueLayerSpec = SampleLayerSpec | SynthLayerSpec

export type CueRecipe = {
  id: string
  label?: string
  category: MixCategory
  material?: MaterialTag
  masterGain?: number
  wet?: number
  loop?: boolean
  cooldownSeconds?: number
  maxVoices?: number
  /** Voice priority (0..100, default derived from category). Higher-priority voices steal lower-priority ones and are never stolen by them. */
  priority?: number
  steal?: StealPolicy
  pitchVariation?: number
  gainVariation?: number
  timingVariation?: number
  duck?: { seconds: number; depth: number }
  daze?: { seconds: number; cutoffHz: number }
  layers: readonly CueLayerSpec[]
}

export type PlayCueOptions = {
  /** Explicit schedule time in seconds; defaults to runtime.now. */
  time?: number
  /** Normalized 0..1 intensity (velocity/impact speed/spell charge) for layer gating & scaling. */
  intensity?: number
  /** Strike force multiplier (0.2..2.0) coupling loudness and brightness. */
  force?: number
  /** Additional pitch/playback-rate multiplier. */
  rate?: number
  gain?: number
  pan?: number
  cutoffHz?: number
  wet?: number
  material?: MaterialTag
  position?: SourcePose
  /** Optional envelope overrides (used by Audio Lab interactive tuning). */
  attackSeconds?: number
  decaySeconds?: number
  pitchVariation?: number
  gainVariation?: number
  /** Optional voice priority override (0..100). */
  priority?: number
  /** Logical owner/emitter key for `"replace"` stealing policy. */
  ownerKey?: string
}

export type VoiceUpdateParams = {
  gain?: number
  rate?: number
  pan?: number
  cutoffHz?: number
  wet?: number
}

export type VoiceHandle = {
  readonly id: number
  readonly cueId: string
  readonly category: MixCategory
  readonly priority: number
  readonly startTime: number
  readonly endTime: number
  readonly active: boolean
  readonly samplesPicked: readonly string[]
  stop(fadeSeconds?: number): void
  setParams(params: VoiceUpdateParams, tau?: number): void
}

export type SampleAssetMeta = {
  id: string
  url: string
  category: MixCategory
  material?: MaterialTag
  source: "project" | "elevenlabs-sound-v2" | "procedural-bake"
  prompt?: string
  modelId?: string
  requestId?: string
  license: string
  provenance: string
  loop?: boolean
  trimSilence?: boolean
  loopStart?: number
  loopEnd?: number
  durationSeconds?: number
  /** Deterministic fallback synthesis recipe when running in offline/unit tests without HTTP fetch. */
  fallbackSynth?: {
    durationSeconds: number
    baseHz: number
    endHz?: number
    noiseMix?: number
    cutoffHz?: number
    harmonicRatios?: readonly number[]
    decayRate?: number
    loop?: boolean
  }
}

export type AudioTelemetry = {
  state: "uninitialized" | "suspended" | "running" | "closed" | "offline"
  muted: boolean
  now: number
  activeVoices: number
  maxVoices: number
  categoryVoices: Record<MixCategory, number>
  droppedVoices: number
  /** Cues skipped because a sample they need was still loading (so no synthesized stand-in played). */
  pendingSkips: number
  stolenVoices: number
  reverbWet: number
  duckGain: number
  dazeCutoffHz: number
  loadedSamples: number
}

/** Compatible with `@arcade/kit/lab` `LabSection` without requiring WebGPU in unit tests. */
export type AudioLabSection = {
  id: string
  label: string
  settings: LabSettings
  controls: readonly LabControl[]
  enter?(): void
  leave?(): void
  update?(dt: number): void
  prepare?(): void
  draw?(pass: GPURenderPassEncoder): void
  telemetry?(): string
  retrigger?(): void
}
