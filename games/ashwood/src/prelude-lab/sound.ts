import type { SoundKind } from "./typer"

// Quiet synthesised key sounds (no assets): a typewriter strike (a short band-passed noise tick over a soft low thump,
// a carriage-return zip and a tiny bell at line ends) or a teletype print hammer (a brighter, drier tick, a clunk at
// line ends). Only the panel being listened to plays; the context starts on the first click or key.

let ctx: AudioContext | null = null
let noise: AudioBuffer | null = null

export function unlockSound() {
  if (!ctx) {
    ctx = new AudioContext()
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
    const d = noise.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  }
  if (ctx.state === "suspended") void ctx.resume()
}

function burst(t: number, len: number, type: BiquadFilterType, f: number, q: number, gain: number, decay: number) {
  const src = ctx!.createBufferSource()
  src.buffer = noise
  const bp = ctx!.createBiquadFilter()
  bp.type = type
  bp.frequency.value = f
  bp.Q.value = q
  const g = ctx!.createGain()
  g.gain.setValueAtTime(gain, t)
  g.gain.setTargetAtTime(0, t + 0.001, decay)
  src.connect(bp).connect(g).connect(ctx!.destination)
  src.start(t, Math.random() * 0.8)
  src.stop(t + len)
}

function tone(t: number, f0: number, f1: number, gain: number, decay: number, type: OscillatorType = "sine") {
  const o = ctx!.createOscillator()
  o.type = type
  o.frequency.setValueAtTime(f0, t)
  o.frequency.exponentialRampToValueAtTime(f1, t + decay * 3)
  const g = ctx!.createGain()
  g.gain.setValueAtTime(gain, t)
  g.gain.setTargetAtTime(0, t + 0.002, decay)
  o.connect(g).connect(ctx!.destination)
  o.start(t)
  o.stop(t + decay * 8)
}

export function keyClick(kind: SoundKind, ch: string, lineEnd: boolean, volume: number) {
  if (!ctx || ctx.state !== "running" || kind === "off") return
  const t = ctx.currentTime + 0.005
  const v = 0.35 * volume * (ch === " " ? 0.45 : 1)
  if (kind === "typewriter") {
    burst(t, 0.05, "bandpass", 1900 + Math.random() * 1400, 1.4, v, 0.006)
    tone(t, 140, 90, v * 0.5, 0.012)
    if (lineEnd) {
      // Carriage return: a falling zip, then the bell.
      const z = ctx.createBufferSource()
      z.buffer = noise
      const bp = ctx.createBiquadFilter()
      bp.type = "bandpass"
      bp.Q.value = 3
      bp.frequency.setValueAtTime(2600, t + 0.08)
      bp.frequency.exponentialRampToValueAtTime(700, t + 0.34)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0, t + 0.08)
      g.gain.linearRampToValueAtTime(v * 0.22, t + 0.12)
      g.gain.setTargetAtTime(0, t + 0.3, 0.03)
      z.connect(bp).connect(g).connect(ctx.destination)
      z.start(t + 0.08, Math.random() * 0.5)
      z.stop(t + 0.5)
      tone(t + 0.02, 2480, 2470, v * 0.12, 0.18)
    }
  } else {
    burst(t, 0.03, "highpass", 3200, 0.7, v * 0.8, 0.004)
    burst(t, 0.04, "bandpass", 1200, 2, v * 0.4, 0.008)
    if (lineEnd) tone(t + 0.05, 95, 60, v * 0.6, 0.03, "triangle")
  }
}
