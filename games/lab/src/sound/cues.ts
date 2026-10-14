import type { CueRecipe } from "@arcade/kit/audio"

/** Lab scene cues on the shared runtime. Continuous beds are looped noise layers that fade on stop. */
const BED = { attack: 0.45, hold: 36000, decay: 0.8 } as const

export const LAB_CUES: readonly CueRecipe[] = [
  {
    id: "lab_explosion", label: "Explosion", category: "impact", masterGain: 1, wet: 0.3, maxVoices: 3,
    pitchVariation: 0.06, gainVariation: 0.1, duck: { seconds: 0.7, depth: 0.5 }, daze: { seconds: 0.5, cutoffHz: 2200 },
    layers: [
      { kind: "sample", samples: ["crash_heavy_1", "crash_heavy_2"], rate: 0.55, gain: 0.8, cutoffHz: 2600 },
      { kind: "synth", waveform: "sine", frequency: 64, glideToHz: 26, glideSeconds: 0.9, envelope: { attack: 0.004, decay: 1.5, peak: 0.95 } },
      { kind: "synth", waveform: "noise", frequency: 1, filterType: "lowpass", cutoffHz: 2600, filterGlideToHz: 160, q: 0.7, envelope: { attack: 0.006, decay: 2.4, peak: 0.7 } },
      { kind: "synth", waveform: "noise", frequency: 1, filterType: "bandpass", cutoffHz: 1100, q: 0.9, envelope: { attack: 0.002, decay: 0.32, peak: 0.45 } },
    ],
  },
  {
    id: "lab_glass", label: "Glass", category: "impact", material: "glass", masterGain: 0.85, wet: 0.18, maxVoices: 4,
    pitchVariation: 0.08, gainVariation: 0.12,
    layers: [
      { kind: "sample", samples: ["stem_metal_shard_clink"], rate: 1.5, gain: 0.45 },
      { kind: "synth", waveform: "modal-bar", frequency: 2300, envelope: { attack: 0.002, decay: 0.5, peak: 0.32 } },
      { kind: "synth", waveform: "modal-bar", frequency: 3700, envelope: { offset: 0.03, attack: 0.002, decay: 0.36, peak: 0.24 } },
      { kind: "synth", waveform: "modal-mallet", frequency: 5200, envelope: { offset: 0.08, attack: 0.002, decay: 0.26, peak: 0.16 } },
      { kind: "synth", waveform: "noise", frequency: 1, filterType: "highpass", cutoffHz: 3800, envelope: { attack: 0.001, decay: 0.3, peak: 0.45 } },
    ],
  },
  {
    id: "lab_gunshot", label: "Gunshot", category: "impact", masterGain: 0.8, wet: 0.22, maxVoices: 6, pitchVariation: 0.05, gainVariation: 0.08,
    duck: { seconds: 0.12, depth: 0.75 },
    layers: [
      { kind: "synth", waveform: "noise", frequency: 1, filterType: "bandpass", cutoffHz: 2000, q: 0.8, envelope: { attack: 0.001, decay: 0.13, peak: 0.9 } },
      { kind: "synth", waveform: "sine", frequency: 150, glideToHz: 48, glideSeconds: 0.12, envelope: { attack: 0.002, decay: 0.16, peak: 0.6 } },
    ],
  },
  {
    id: "lab_pop", label: "Pop", category: "impact", masterGain: 0.6, maxVoices: 6, pitchVariation: 0.15, gainVariation: 0.2,
    layers: [
      { kind: "synth", waveform: "noise", frequency: 1, filterType: "lowpass", cutoffHz: 1800, envelope: { attack: 0.001, decay: 0.06, peak: 0.6 } },
      { kind: "synth", waveform: "sine", frequency: 95, envelope: { attack: 0.002, decay: 0.08, peak: 0.45 } },
    ],
  },
  {
    id: "lab_splat", label: "Splat", category: "impact", masterGain: 0.5, maxVoices: 4, pitchVariation: 0.15, gainVariation: 0.2,
    layers: [
      { kind: "synth", waveform: "noise", frequency: 1, filterType: "lowpass", cutoffHz: 650, filterGlideToHz: 240, envelope: { attack: 0.002, decay: 0.12, peak: 0.55 } },
    ],
  },
  {
    id: "lab_footstep", label: "Footstep", category: "impact", masterGain: 0.55, wet: 0.08, maxVoices: 4, pitchVariation: 0.12, gainVariation: 0.2,
    layers: [
      { kind: "synth", waveform: "noise", frequency: 1, filterType: "lowpass", cutoffHz: 1100, envelope: { attack: 0.001, decay: 0.07, peak: 0.6 } },
      { kind: "synth", waveform: "sine", frequency: 110, glideToHz: 55, glideSeconds: 0.05, envelope: { attack: 0.002, decay: 0.06, peak: 0.45 } },
    ],
  },
  {
    id: "lab_fire_bed", label: "Fire", category: "impact", loop: true, masterGain: 0.7, wet: 0.12, maxVoices: 1, steal: "replace",
    layers: [
      { kind: "synth", waveform: "noise", frequency: 1, filterType: "lowpass", cutoffHz: 520, q: 0.6, envelope: { ...BED, peak: 0.55 } },
      { kind: "synth", waveform: "noise", frequency: 1, filterType: "bandpass", cutoffHz: 1500, q: 1.2, envelope: { ...BED, peak: 0.14 } },
    ],
  },
  {
    id: "lab_fire_crackle", label: "Fire crackle", category: "impact", masterGain: 0.4, maxVoices: 6, pitchVariation: 0.3, gainVariation: 0.5,
    layers: [
      { kind: "synth", waveform: "noise", frequency: 1, filterType: "highpass", cutoffHz: 2400, envelope: { attack: 0.001, decay: 0.035, peak: 0.6 } },
    ],
  },
  {
    id: "lab_water_bed", label: "Water", category: "impact", loop: true, masterGain: 0.6, wet: 0.1, maxVoices: 1, steal: "replace",
    layers: [
      { kind: "synth", waveform: "noise", frequency: 1, filterType: "bandpass", cutoffHz: 3200, q: 0.5, envelope: { ...BED, peak: 0.36 } },
      { kind: "synth", waveform: "noise", frequency: 1, filterType: "lowpass", cutoffHz: 700, envelope: { ...BED, peak: 0.3 } },
    ],
  },
]

export type EffectSound = { cue: string; intensity: number }

/** One-shot sounds for an effect firing in a section (ids from the game adapters and shared Effects). */
export function effectSounds(effect: string, variant?: string): EffectSound[] {
  switch (effect) {
    case "explosion": case "fireball": return [{ cue: "lab_explosion", intensity: 1 }]
    case "glass": return [{ cue: "lab_glass", intensity: 0.9 }]
    case "monitor": return [{ cue: "lab_glass", intensity: 0.5 }, { cue: "impact_metal_clink", intensity: 0.4 }]
    case "shot": return [{ cue: "lab_gunshot", intensity: 0.9 }, variant === "glass" || variant === "monitor" ? { cue: "lab_glass", intensity: 0.8 } : { cue: "impact_metal_clink", intensity: 0.5 }]
    case "muzzle": case "tracer": case "holes": return [{ cue: "lab_gunshot", intensity: 0.8 }]
    case "sparks": case "scrape": case "impact": case "casings": case "magazines": case "debris": return [{ cue: "impact_metal_clink", intensity: 0.6 }]
    case "vehicle": case "landing": return [{ cue: "impact_crash_layered", intensity: effect === "vehicle" ? 0.85 : 0.5 }]
    case "blood": case "splats": case "corpse": return [{ cue: "lab_splat", intensity: 0.7 }]
    case "pops": case "scorch": case "nitro": return [{ cue: "lab_pop", intensity: 0.7 }]
    default: return []
  }
}

/** Continuous bed an effect keeps running while it plays. */
export function effectBed(effect: string, section = ""): "fire" | "water" | null {
  if (effect === "fire" || effect === "wreck" || effect === "fireball") return "fire"
  if (effect === "explosion" && section === "fire-water") return "fire"
  if (effect === "water" || effect === "hydrant") return "water"
  return null
}
