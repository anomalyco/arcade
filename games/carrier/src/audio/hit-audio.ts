import { mixer } from "./mixer"
import { sfx } from "./sfx-bank"

/**
 * The hit confirmation (src/ui/hit-marker.ts plays it with the marker), dry on the UI bus. A hit: a crisp high-passed
 * click on a short falling wooden "tock" and a low thwack for weight, its pitch varied a little so a burst of hits never
 * repeats one sample. A kill: the recorded confirm (a deep thump and a clean ping), or until it loads the hit over a
 * heavy thump.
 */
export function hitSound(kill: boolean): void {
  const m = mixer()
  const ctx = m.ctx
  if (!ctx) return
  if (kill && sfx(m).play("ui-kill", { bus: "ui", reverb: 0, gain: 0.8 })) return
  const now = ctx.currentTime + 0.002
  const v = 2 ** ((Math.random() - 0.5) * 0.12)
  const voice = (src: AudioScheduledSourceNode, through: AudioNode, peak: number, decay: number) => {
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, now)
    g.gain.linearRampToValueAtTime(peak, now + 0.001)
    g.gain.exponentialRampToValueAtTime(0.0001, now + decay)
    src.connect(through)
    through.connect(g).connect(m.bus.ui)
    src.start(now)
    src.stop(now + decay + 0.02)
  }
  const tone = (type: OscillatorType, f0: number, f1: number, glide: number, peak: number, decay: number) => {
    const o = ctx.createOscillator()
    o.type = type
    o.frequency.setValueAtTime(f0, now)
    o.frequency.exponentialRampToValueAtTime(f1, now + glide)
    voice(o, ctx.createGain(), peak, decay)
  }
  const click = ctx.createBufferSource()
  click.buffer = m.noise.white
  const hp = ctx.createBiquadFilter()
  hp.type = "highpass"
  hp.frequency.value = 3200
  voice(click, hp, 0.24, 0.022)
  tone("triangle", 1500 * v, 1050 * v, 0.045, 0.12, 0.07)
  tone("sine", 260 * v, 140 * v, 0.06, 0.2, 0.08)
  if (kill) tone("sine", 140, 52, 0.3, 0.6, 0.4)
}
