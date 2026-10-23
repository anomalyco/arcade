import { hitSound } from "../audio/hit-audio"
import { mixer } from "../audio/mixer"
import { sfx } from "../audio/sfx-bank"
import type { CalloutKind } from "./callouts"
import { FEEDBACK } from "./settings"

/**
 * The damage and reward sounds, all on the dry UI bus and synthesized except the recorded kill confirm they reuse:
 * - the master caution: one soft, low chime (a sine fifth with a slow decay, no attack click), never a screech;
 * - one sting per callout (one clear sound per moment): the kill confirm for SPLASH ONE, the confirm pitched up with a
 *   short rising arpeggio for multi-kills, a low struck gong for ship hits, the confirm pitched down on the gong for a
 *   sinking or a deck jet;
 * - the CLOSE CALL whoosh: band-passed noise sweeping up and back down, panned across from the side it passed.
 */
type Tone = { type: OscillatorType; f0: number; f1?: number; glide?: number; peak: number; decay: number; at?: number; attack?: number }

function voices(tones: readonly Tone[], gain = 1): void {
  const m = mixer()
  const ctx = m.ctx
  if (!ctx) return
  const now = ctx.currentTime + 0.003
  for (const t of tones) {
    const at = now + (t.at ?? 0)
    const o = ctx.createOscillator()
    o.type = t.type
    o.frequency.setValueAtTime(t.f0, at)
    if (t.f1) o.frequency.exponentialRampToValueAtTime(t.f1, at + (t.glide ?? t.decay))
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, at)
    g.gain.linearRampToValueAtTime(t.peak * gain, at + (t.attack ?? 0.004))
    g.gain.exponentialRampToValueAtTime(0.0001, at + t.decay)
    o.connect(g).connect(m.bus.ui)
    o.start(at)
    o.stop(at + t.decay + 0.05)
  }
}

/** The master caution: a soft two-partial chime, like an airliner's, not a klaxon. */
export function cautionChime(): void {
  const k = FEEDBACK.cautionGain
  if (k <= 0) return
  voices(
    [
      { type: "sine", f0: 587, peak: 0.075, decay: 0.9, attack: 0.012 },
      { type: "sine", f0: 880, peak: 0.045, decay: 0.7, attack: 0.012 },
      { type: "sine", f0: 1174, peak: 0.012, decay: 0.35, attack: 0.012 },
    ],
    k,
  )
}

const gong = (at = 0): Tone[] => [
  { type: "sine", f0: 118, f1: 92, glide: 0.5, peak: 0.42, decay: 0.75, at },
  { type: "triangle", f0: 354, f1: 330, glide: 0.4, peak: 0.08, decay: 0.45, at },
  { type: "sine", f0: 707, peak: 0.035, decay: 0.3, at },
]

/** The one sting of a callout. */
export function sting(kind: CalloutKind, side = 0): void {
  const k = FEEDBACK.stingGain
  if (k <= 0) return
  const m = mixer()
  if (!m.ctx) return
  const confirm = (rate: number, gain = 0.8) => !!sfx(m).play("ui-kill", { bus: "ui", reverb: 0, gain: gain * k, rate })
  const arp = (notes: number) => {
    const base = 880
    const steps = [1, 1.26, 1.5, 2]
    voices(
      Array.from({ length: notes }, (_, i): Tone => ({ type: "triangle", f0: base * steps[i]!, peak: 0.07, decay: 0.22, at: 0.06 + i * 0.065 })),
      k,
    )
  }
  switch (kind) {
    case "splash":
      if (!confirm(1)) hitSound(true)
      return
    case "double":
    case "triple":
    case "multi": {
      const n = kind === "double" ? 2 : kind === "triple" ? 3 : 4
      if (!confirm(1 + (n - 1) * 0.07)) hitSound(true)
      arp(n)
      return
    }
    case "ship-hit":
      voices(gong(), k)
      return
    case "sunk":
    case "deck-jet":
      confirm(kind === "sunk" ? 0.8 : 0.9, 0.7)
      voices(gong(0.02), k * 0.8)
      return
    case "close-call":
      whoosh(side)
      return
  }
}

/** A whoosh past the canopy, panned from `side` (-1 left .. 1 right) across to the other side. */
export function whoosh(side: number): void {
  const k = FEEDBACK.stingGain
  const m = mixer()
  const ctx = m.ctx
  if (!ctx || k <= 0) return
  const now = ctx.currentTime + 0.003
  const len = 0.75
  const src = ctx.createBufferSource()
  src.buffer = m.noise.pink
  src.loop = true
  const bp = ctx.createBiquadFilter()
  bp.type = "bandpass"
  bp.Q.value = 1.4
  bp.frequency.setValueAtTime(380, now)
  bp.frequency.exponentialRampToValueAtTime(2600, now + len * 0.45)
  bp.frequency.exponentialRampToValueAtTime(520, now + len)
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, now)
  g.gain.exponentialRampToValueAtTime(0.5 * k, now + len * 0.42)
  g.gain.exponentialRampToValueAtTime(0.0001, now + len)
  const pan = ctx.createStereoPanner()
  const s = Math.max(-1, Math.min(1, side)) * 0.8
  pan.pan.setValueAtTime(s, now)
  pan.pan.linearRampToValueAtTime(-s, now + len)
  src.connect(bp).connect(g).connect(pan).connect(m.bus.ui)
  src.start(now, Math.random() * 2)
  src.stop(now + len + 0.05)
}
