import type { LabControl } from "@arcade/kit/lab-panel"

/**
 * Your own small sounds, synthesized (deterministic PCM, like the shared footsteps): dry leaves under a step, the map's
 * paper as it comes up or goes down, flagging tape pulled off the roll and torn, your heartbeat, a camcorder's zoom
 * motor and an infrared filter's click. They go through the effects channel with the footsteps, a little under them.
 */
export type FoleyKind = "leaves" | "paper.up" | "paper.down" | "tape.pull" | "tape.tear" | "heart" | "zoom" | "ir.click"

export const FOLEY = {
  /** Every foley sound (×). */
  level: 1,
  leaves: 1,
  paper: 1,
  tape: 1,
  heart: 1,
  camera: 1,
}
export type FoleySettings = typeof FOLEY

export const FOLEY_CONTROLS: LabControl[] = [
  { key: "foleyLevel", field: "level", label: "Foley (your own small sounds)", group: "Sound", subsection: "Foley", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "foleyLeaves", field: "leaves", label: "Dry leaves underfoot", group: "Sound", subsection: "Foley", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "foleyPaper", field: "paper", label: "Map paper", group: "Sound", subsection: "Foley", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "foleyTape", field: "tape", label: "Tape off the roll", group: "Sound", subsection: "Foley", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "foleyHeart", field: "heart", label: "Your heartbeat", group: "Sound", subsection: "Foley", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "foleyCamera", field: "camera", label: "Camera (zoom motor, IR click)", group: "Sound", subsection: "Foley", min: 0, max: 2, step: 0.05, unit: "×" },
]

const DURATION: Record<FoleyKind, number> = { leaves: 0.42, "paper.up": 0.55, "paper.down": 0.45, "tape.pull": 0.6, "tape.tear": 0.12, heart: 0.42, zoom: 0.9, "ir.click": 0.05 }
const RATE = 24000
/** Level trims so `play(kind, 1)` sits about at a walking footstep's contact (~ −50 dBFS RMS before the mix). */
const TRIM: Record<FoleyKind, number> = { leaves: 0.5, "paper.up": 0.15, "paper.down": 0.15, "tape.pull": 0.12, "tape.tear": 0.08, heart: 0.1, zoom: 0.1, "ir.click": 0.08 }

/** One take of a foley sound as mono PCM at 24 kHz (peaks around 0.1–0.2, the footsteps' contact level). */
export function synthFoleySound(kind: FoleyKind, seed: number, rate = RATE): Float32Array<ArrayBuffer> {
  const n = Math.ceil(DURATION[kind] * rate), a = new Float32Array(n)
  let rng = (seed + 1) * 2654435761 >>> 0 || 1
  const random = () => { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; return (rng >>> 0) / 4294967296 * 2 - 1 }
  let lp = 0, lp2 = 0, hp = 0, crackle = 0, phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / rate, u = t / DURATION[kind], x = random()
    lp += (x - lp) * 0.35; lp2 += (x - lp2) * 0.06; hp = x - lp
    const end = Math.min(1, (DURATION[kind] - t) * 60)
    switch (kind) {
      case "leaves": {
        // Brittle litter: a dense spray of tiny cracks right after the heel lands, thinning as the sole rolls off.
        const density = 0.05 * Math.exp(-t * 9) + 0.004
        if (random() * 0.5 + 0.5 < density) crackle += (0.5 + 0.5 * Math.abs(random())) * (1 - u)
        crackle *= 0.86
        a[i] = (hp * crackle * 0.5 + lp2 * 0.06 * Math.exp(-t * 18)) * end
        break
      }
      case "paper.up":
      case "paper.down": {
        // Folded survey paper: crinkles in bursts (the sheet flexing), brighter going up, a soft flap at the end.
        const bursts = Math.max(0, Math.sin(t * (kind === "paper.up" ? 37 : 29) + seed) * 0.5 + 0.5 * Math.sin(t * 61 + seed * 3)) ** 3
        const env = Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 1.5
        const flap = kind === "paper.down" ? Math.exp(-(((u - 0.8) / 0.05) ** 2)) * lp2 * 0.5 : 0
        a[i] = (hp * (0.08 + 0.22 * bursts) * env + flap) * end * 0.6
        break
      }
      case "tape.pull": {
        // Plastic flagging tape peeling off the roll: the adhesive lets go in a fast rasp that rises as it's pulled.
        const rate2 = 140 + 260 * u
        phase += rate2 / rate
        const tooth = phase % 1 < 0.18 ? 1 : 0.15
        const env = Math.sin(Math.PI * Math.min(1, u * 1.05)) ** 0.8
        a[i] = (hp * tooth * 0.18 + lp * 0.03) * env * end
        break
      }
      case "tape.tear":
        a[i] = (hp * 0.35 * Math.exp(-t * 55) + lp2 * 0.15 * Math.exp(-t * 30)) * end
        break
      case "heart": {
        // Lub-dub, felt more than heard: two low thumps, the second softer.
        const thump = (at: number, hz: number, g: number) => t < at ? 0 : g * Math.sin(2 * Math.PI * hz * (t - at)) * Math.exp(-(t - at) * 28) * Math.min(1, (t - at) * 400)
        a[i] = (thump(0, 52, 0.22) + thump(0.21, 46, 0.14) + lp2 * 0.01 * Math.exp(-t * 20)) * end
        break
      }
      case "zoom": {
        // A small DC motor through plastic gears: a whine with a gear buzz, spinning up and down.
        const spin = Math.min(1, u * 8) * Math.min(1, (1 - u) * 8)
        phase += (520 + 40 * Math.sin(t * 7)) / rate
        const whine = Math.sin(2 * Math.PI * phase) * 0.5 + Math.sin(4 * Math.PI * phase) * 0.25
        const buzz = (phase * 9) % 1 < 0.5 ? 1 : -1
        a[i] = (whine * 0.035 + buzz * 0.012 + hp * 0.01) * spin
        break
      }
      case "ir.click":
        a[i] = (Math.sin(2 * Math.PI * 2400 * t) * 0.1 + hp * 0.1) * Math.exp(-t * 220) * end
        break
    }
  }
  return a
}

/** Schedules foley takes on a context (live or offline); takes are cached per kind and seed. */
export class Foley {
  private cache = new Map<string, AudioBuffer>()
  private serial = 0
  private heartAt = 0
  private motor: { source: AudioBufferSourceNode; gain: GainNode } | null = null

  constructor(private readonly ctx: BaseAudioContext, private readonly destination: AudioNode, readonly settings: FoleySettings) {}

  private buffer(kind: FoleyKind, seed: number): AudioBuffer {
    const key = `${kind}:${seed}`
    let b = this.cache.get(key)
    if (!b) {
      const pcm = synthFoleySound(kind, seed)
      b = this.ctx.createBuffer(1, pcm.length, RATE)
      b.copyToChannel(pcm, 0)
      this.cache.set(key, b)
    }
    return b
  }

  private level(kind: FoleyKind): number {
    const s = this.settings
    const own = kind === "leaves" ? s.leaves : kind.startsWith("paper") ? s.paper : kind.startsWith("tape") ? s.tape : kind === "heart" ? s.heart : s.camera
    return s.level * own * TRIM[kind]
  }

  play(kind: FoleyKind, gain = 1, pan = 0, at = this.ctx.currentTime): void {
    const g = gain * this.level(kind)
    if (g <= 0.0001) return
    const variants = kind === "leaves" ? 12 : 4
    const source = this.ctx.createBufferSource(), level = this.ctx.createGain(), panner = this.ctx.createStereoPanner()
    source.buffer = this.buffer(kind, ++this.serial % variants)
    source.playbackRate.value = 0.94 + ((this.serial * 37) % 13) / 100
    level.gain.value = g
    panner.pan.value = Math.max(-1, Math.min(1, pan))
    source.connect(level).connect(panner).connect(this.destination)
    source.onended = () => { source.disconnect(); level.disconnect(); panner.disconnect() }
    source.start(Math.max(this.ctx.currentTime, at))
  }

  /** Your heart this frame: `level` 0 is silent, 1 pounding; the rate climbs with it (64 → 132 bpm). */
  heart(level: number): void {
    const now = this.ctx.currentTime
    if (level < 0.05) { this.heartAt = Math.max(this.heartAt, now); return }
    const period = 60 / (64 + 68 * Math.min(1, level))
    if (this.heartAt < now - 0.5) this.heartAt = now + 0.05
    while (this.heartAt < now + 0.1) {
      this.play("heart", Math.min(1, level) ** 1.5, 0, this.heartAt)
      this.heartAt += period
    }
  }

  /** The zoom motor runs while `on` (one looping take, faded in and out). */
  zoom(on: boolean): void {
    const now = this.ctx.currentTime
    if (on && !this.motor) {
      const source = this.ctx.createBufferSource(), gain = this.ctx.createGain()
      source.buffer = this.buffer("zoom", 1)
      source.loop = true
      source.loopStart = 0.2; source.loopEnd = 0.7
      gain.gain.value = 0
      gain.gain.setTargetAtTime(this.level("zoom"), now, 0.03)
      source.connect(gain).connect(this.destination)
      source.start(now)
      this.motor = { source, gain }
    } else if (!on && this.motor) {
      const m = this.motor
      m.gain.gain.setTargetAtTime(0, now, 0.03)
      m.source.stop(now + 0.2)
      m.source.onended = () => { m.source.disconnect(); m.gain.disconnect() }
      this.motor = null
    }
  }

  stop(): void {
    this.zoom(false)
    this.heartAt = 0
  }
}
