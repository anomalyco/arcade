import type { VehicleKind } from "../../shared/vehicles"
import type { NoiseBank } from "./mixer"

/**
 * The engine graph of each jet type (jet-engine.ts JetVoice owns the output: level, air, panner, sends, cockpit path):
 * oscillators and filtered noise loops feeding the voice's three inputs, `front` (radiates ahead), `rear` (behind: jet
 * noise, afterburner) and `mix` (no direction: sub-bass). All procedural, driven every frame from core speed, throttle,
 * afterburner and Doppler, and every parameter glides, so nothing steps or pumps.
 *
 * The Hornet is "Jet Wash" (picked by ear from six candidates, captures/audio/hornet-pitch/): pure jet noise, no tones.
 * The F-35C keeps the Wings-derived voice (whine, roar, body, breathing burner). Rules from play: no high, pure or
 * sweeping tones (a ×2.76 overtone and a bright flyby tear were "eagle screech"), no level wobble (no detuned beats,
 * no breathing modulation on the Hornet), one clear sound per moment.
 */

export type EngineCharacter = {
  engines: number
  /** Whine at idle and at full core speed (Hz), and its level. */
  whine: readonly [number, number]
  whineGain: number
  /** Roar low-pass at idle and its opening with throttle (Hz), and level. */
  roar: readonly [number, number]
  roarGain: number
  /** Body low-pass at idle and its opening (Hz), and level. */
  body: readonly [number, number]
  bodyGain: number
  /** Afterburner rumble low-pass (Hz), sub tone (Hz), and level. */
  burnLp: number
  sub: number
  burnGain: number
}

/** Live tuning (the AUDIO debug tab). */
export const ENGINE_TUNE = { whine: 1, roar: 1, burner: 1 }

/** What a model reads each frame (a subset of jet-engine.ts VoiceInput). */
export type ModelInput = { throttle: number; burner: number; doppler: number }

export type Osc = { osc: OscillatorNode; gain: GainNode }
export type Noise = { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode }
export type Set = (p: AudioParam, v: number, tc?: number) => void

/** Node factories bound to the voice (every node is tracked for disposal; every source starts on the first update). */
export type Kit = {
  ctx: BaseAudioContext
  noise: NoiseBank
  c: EngineCharacter
  /** Your own jet: two decorrelated engines spread a little left and right. */
  twin: boolean
  front: GainNode
  rear: GainNode
  mix: GainNode
  gain(v: number, to?: AudioNode | AudioParam): GainNode
  filter(type: BiquadFilterType, f: number, q: number, to?: AudioNode): BiquadFilterNode
  osc(type: OscillatorType, f: number, to: AudioNode): Osc
  loop(buf: AudioBuffer, type: BiquadFilterType, f: number, q: number, to: AudioNode | AudioParam, g0?: number): Noise
  /** The same filtered noise once per engine: one loop for another jet, two (left/right, half bled across) for yours. */
  engines(buf: AudioBuffer, type: BiquadFilterType, f: number, q: number, to: AudioNode): Noise[]
}

export type EngineModel = {
  /** Output trim. */
  trim: number
  /** Per frame: `n` core speed 0 (idle) .. 1 (military). */
  update(s: ModelInput, n: number, set: Set): void
}

/** The F-35C (and before Jet Wash, the Hornet): Wings-derived, v4 tuning. */
function classic(k: Kit): EngineModel {
  const c = k.c
  const n = k.noise
  const whineLp = k.filter("lowpass", 1100, 0.5, k.front)
  const whines: Osc[] = []
  for (let i = 0; i < c.engines; i++) {
    // The second engine sits 0.6 cents off: a beat slower than a second, felt rather than heard.
    const w = k.osc("triangle", c.whine[0], whineLp)
    w.osc.detune.value = i ? 0.6 : 0
    whines.push(w)
  }
  const roars = k.twin && c.engines > 1 ? k.engines(n.pink, "lowpass", c.roar[0], 0.5, k.rear) : [k.loop(n.pink, "lowpass", c.roar[0], 0.5, k.rear)]
  const body = k.loop(n.brown, "lowpass", c.body[0], 0.5, k.rear)
  const deep = k.osc("sine", c.sub * 1.25, k.mix)
  // Afterburner: a rumble that breathes (its level drifts with slow, low-passed brown noise), and a soft crackle.
  const breathe = k.gain(1, k.rear)
  const burn = k.loop(n.brown, "lowpass", c.burnLp, 0.6, breathe)
  k.loop(n.brown, "lowpass", 3, 0.5, breathe.gain, 1.2)
  const crackle = k.loop(n.crackle, "highpass", 600, 0.5, k.filter("bandpass", 1800, 0.6, k.rear))
  const sub = k.osc("sine", c.sub, k.mix)
  return {
    trim: 1,
    update(s, core, set) {
      const d = s.doppler
      const p = s.throttle
      const b = s.burner * ENGINE_TUNE.burner
      // The whine takes only a third of the Doppler shift (the roar carries the swoop).
      const wf = (c.whine[0] + (c.whine[1] - c.whine[0]) * core) * (1 + (d - 1) * 0.35)
      const wg = (0.012 + 0.016 * core) * c.whineGain * ENGINE_TUNE.whine
      for (let i = 0; i < whines.length; i++) {
        set(whines[i]!.osc.frequency, wf)
        set(whines[i]!.gain.gain, wg * (i ? 0.25 : 1))
      }
      const tr = ENGINE_TUNE.roar
      const split = roars.length > 1 ? 0.75 : 1
      for (const r of roars) {
        set(r.src.playbackRate, (0.85 + 0.25 * p) * d)
        set(r.filter.frequency, (c.roar[0] + c.roar[1] * p ** 1.2 + 500 * b) * d)
        set(r.gain.gain, (0.2 + 0.3 * p + 0.15 * b) * c.roarGain * tr * split)
      }
      set(body.src.playbackRate, (0.85 + 0.2 * p) * d)
      set(body.filter.frequency, (c.body[0] + c.body[1] * p) * d)
      set(body.gain.gain, (0.25 + 0.25 * p) * c.bodyGain * tr)
      set(deep.osc.frequency, c.sub * (1.1 + 0.3 * core) * d)
      set(deep.gain.gain, (0.02 + 0.05 * p) * c.bodyGain)
      set(burn.src.playbackRate, d)
      set(burn.filter.frequency, c.burnLp * d)
      set(burn.gain.gain, 0.5 * b * c.burnGain, 0.15)
      set(crackle.src.playbackRate, d)
      set(crackle.gain.gain, 0.09 * b * c.burnGain, 0.15)
      set(sub.osc.frequency, c.sub * d)
      set(sub.gain.gain, 0.22 * b * c.burnGain, 0.15)
    },
  }
}


/**
 * The Hornet, "Jet Wash": what a jet mostly is, mixing noise, and no tones at all. Two turbulence components after
 * Tam's similarity spectra: the large-scale one (aft, peaked: a band-pass hump at the Strouhal frequency f = 0.2·Vj/D, Vj the exhaust
 * velocity, D ≈ 0.7 m the F414 nozzle) and the fine-scale one (broader, flatter, ahead and to the side: the air that
 * carries). Vj rises from ~250 m/s at idle to ~560 at military and ~900 in burner, so the roar's peak climbs from ~70 to
 * ~260 Hz; the level follows Vj gently (Lighthill's V^8 squeezed to a playable range). The burner adds a deep rumble.
 */
function jetwash(k: Kit): EngineModel {
  const n = k.noise
  // Large-scale: pink → high-pass at fp/2 → two low-passes at ~1.3·fp and ~2.6·fp (12 dB/oct below, ~18 above).
  const lstLp2 = k.filter("lowpass", 400, 0.5, k.rear)
  const lstLp = k.filter("lowpass", 200, 0.9, lstLp2)
  const lst = k.twin ? k.engines(n.pink, "highpass", 50, 0.7, lstLp) : [k.loop(n.pink, "highpass", 50, 0.7, lstLp)]
  // Fine-scale: pink → high-pass at ~2·fp → a gentle low-pass that opens to ~2 kHz: present, never bright.
  const fstLp = k.filter("lowpass", 1200, 0.5, k.front)
  const fst = k.loop(n.pink, "highpass", 300, 0.5, fstLp)
  const fstRear = k.gain(0.5, k.rear)
  fstLp.connect(fstRear)
  const rumble = k.loop(n.brown, "lowpass", 90, 0.6, k.mix)
  return {
    trim: 1.29,
    update(s, core, set) {
      const d = s.doppler
      const b = s.burner * ENGINE_TUNE.burner
      // Exhaust velocity (m/s): the core's spool sets it, the burner adds the hot jet.
      const vj = 250 + 310 * core ** 1.3 + 340 * b
      const fp = (0.2 * vj) / 0.7
      const level = (vj / 560) ** 1.1
      const tr = ENGINE_TUNE.roar
      const split = lst.length > 1 ? 0.75 : 1
      for (const r of lst) {
        set(r.src.playbackRate, d)
        set(r.filter.frequency, fp * 0.5 * d)
        set(r.gain.gain, 0.95 * level * split * tr)
      }
      set(lstLp.frequency, fp * 1.3 * d)
      set(lstLp2.frequency, fp * 2.6 * d)
      set(fst.src.playbackRate, d)
      set(fst.filter.frequency, fp * 2.2 * d)
      set(fstLp.frequency, Math.min(2200, fp * 8) * d)
      set(fst.gain.gain, 0.16 * level * ENGINE_TUNE.whine)
      set(rumble.src.playbackRate, d)
      set(rumble.gain.gain, (0.05 + 0.5 * b) * tr, 0.15)
    },
  }
}

/** Each jet type's engine. */
export const ENGINE_BUILD: Readonly<Record<VehicleKind, (k: Kit) => EngineModel>> = { hornet: jetwash, f35: classic }
