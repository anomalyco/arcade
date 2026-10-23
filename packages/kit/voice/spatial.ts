export type VoicePoint = { x: number; y: number; z: number }
export type VoiceSpatialSettings = {
  distance: number
  reference: number
  rolloff: number
  occludedHz: number
  reverb: number
  radioDistance: number
}
export const VOICE_SPATIAL: VoiceSpatialSettings = { distance: 36, reference: 2, rolloff: 0.85, occludedHz: 650, reverb: 0.16, radioDistance: 300 }
export const unit = (n: number) => Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0

/** A finite range also bounds the wet send, so reverb cannot reveal friends beyond hearing distance. */
export function voiceSpatial(distance: number, occlusion: number, s: VoiceSpatialSettings = VOICE_SPATIAL) {
  const d = Math.max(0, distance), o = unit(occlusion)
  const edge = unit((s.distance - d) / Math.max(1, s.distance * 0.3))
  const gain = (s.reference / Math.max(s.reference, d)) ** s.rolloff * edge * (1 - 0.6 * o)
  return { gain, cutoff: Math.min(16000 * Math.exp(-d / 80), 16000 * (s.occludedHz / 16000) ** o), delay: Math.min(0.2, d / 343), wet: gain * s.reverb * (0.25 + 0.75 * unit(d / s.distance)) }
}

export function radioStatic(distance: number, battery = 1, s: VoiceSpatialSettings = VOICE_SPATIAL): number {
  return 0.005 + 0.045 * unit(distance / s.radioDistance) + 0.035 * (1 - unit(battery))
}
