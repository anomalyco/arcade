// One-shot and sustained weapon/impact/UI sounds, all synthesized from the shared bank.
// Design rules (after "TV static"/"weird" feedback): no white-noise hiss or high-passed crackle,
// noise is pink/brown behind lowpasses, tones are sines/triangles, every envelope has a ≥ 3 ms
// attack (see Shot.env), and one-shots get a per-shot pitch offset (Shot.vary) so repeats differ.
import type { Vec3, WeaponId } from "../sim/types"
import { type Core, Held, rand } from "./core"

type At = Vec3 | null

const sweep = (p: AudioParam, from: number, to: number, start: number, dur: number) => {
  p.setValueAtTime(from, start)
  p.exponentialRampToValueAtTime(to, start + dur)
}

// ---------------------------------------------------------------- guns

const GUN_LOOP = {
  // hold = how long one fire event keeps the loop alive (≈ 2.5 × the event interval).
  // Own guns: brighter lowpass (lets the 1–3 kHz crack through) and a higher level so they sit
  // with the own engine. Remote: the old darker, quieter settings.
  cannon20: { hold: 0.16, release: 0.09, level: 0.65, levelOwn: 1.3, lp: 1600, lpOwn: 4000, ref: 45 },
  gau8: { hold: 0.12, release: 0.18, level: 0.975, levelOwn: 1.5, lp: 1100, lpOwn: 3500, ref: 70 },
} as const

/**
 * Rotary cannons are a sustain loop, not one-shots: each `fire` event extends the loop, so 30
 * events/s cost three AudioParam calls instead of 30 new graphs. The loops are jittered low
 * thumps (a rip, not a pitched buzz) behind a lowpass.
 */
export function rotaryGun(core: Core, vehicleId: string, weapon: "cannon20" | "gau8", at: At, own: boolean): Held | null {
  const key = `gun:${vehicleId}:${weapon}`
  const cfg = GUN_LOOP[weapon]
  let h = core.helds.get(key)
  if (!h || h.dead) {
    if (!own && !at) return null
    const ctx = core.ctx
    h = new Held(core, { at: own ? null : at, dest: core.sfxBus, ref: cfg.ref, attack: 0.012, release: cfg.release, level: own ? cfg.levelOwn : cfg.level, vehicleId })
    const src = ctx.createBufferSource()
    src.buffer = weapon === "gau8" ? core.bank.gau8 : core.bank.vulcan
    src.loop = true
    src.playbackRate.value = rand(0.96, 1.04)
    const lp = ctx.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.value = own ? cfg.lpOwn : cfg.lp
    lp.Q.value = 0.5
    src.connect(lp)
    lp.connect(h.env)
    h.sources.push(src)
    h.nodes.push(lp)
    if (weapon === "gau8") {
      // A little room so the BRRRT hangs in the air.
      const send = ctx.createGain()
      send.gain.value = 0.3
      h.env.connect(send)
      send.connect(core.reverbIn)
      h.nodes.push(send)
    }
    const held = h
    held.onRelease = (t) => gunTail(core, weapon, own ? null : held.at, t)
    // Start the loop at a random point so consecutive bursts don't begin identically.
    src.start(core.now, Math.random() * (src.buffer?.duration ?? 0))
    core.helds.set(key, h)
    gunStart(core, weapon, own ? null : at)
  }
  if (at && !own) h.moveTo(at)
  h.hold(cfg.hold)
  return h
}

function gunStart(core: Core, weapon: "cannon20" | "gau8", at: At): void {
  const s = core.shot("gunstart", at, { ref: 50, limit: 4 })
  if (!s) return
  const t = s.t
  const big = weapon === "gau8"
  const o = s.osc("sine", big ? 110 : 180, t, t + 0.18)
  sweep(o.frequency, big ? 110 : 180, big ? 42 : 70, t, 0.14)
  o.connect(s.env(t, 0.004, big ? 0.5 : 0.25, 0.13))
}

function gunTail(core: Core, weapon: "cannon20" | "gau8", at: At, when: number): void {
  const s = core.shot("guntail", at, { ref: 60, limit: 4 })
  if (!s) return
  const t = Math.max(s.t, when)
  const big = weapon === "gau8"
  // Spin-down: a soft low rumble that rolls away (plus room for the GAU-8).
  const n = s.noise(core.bank.brown, t, t + (big ? 1.2 : 0.5), 0.8)
  const lp = s.filter("lowpass", big ? 360 : 500, 0.6)
  sweep(lp.frequency, big ? 360 : 500, 90, t, big ? 0.9 : 0.4)
  const e = s.env(t, 0.01, big ? 0.45 : 0.18, big ? 0.9 : 0.35)
  n.connect(lp).connect(e)
  if (big) s.send(0.5, e)
}

export function chaingun(core: Core, at: At, own: boolean): void {
  const s = core.shot("chaingun", own ? null : at, { ref: 40, limit: 6 })
  if (!s) return
  const t = s.t + rand(0, 0.008)
  const k = own ? 1.5 : 1.2
  // Body: pitch-dropping thump + low-mid punch (100–600 Hz).
  const o = s.osc("sine", 150, t, t + 0.16)
  sweep(o.frequency, rand(140, 160), 50, t, 0.11)
  o.connect(s.env(t, 0.003, 0.7 * k, 0.12))
  const m = s.noise(core.bank.pink, t, t + 0.12)
  const mbp = s.filter("bandpass", rand(320, 420), 0.8)
  m.connect(mbp).connect(s.env(t, 0.003, 0.6 * k, 0.07))
  const b = s.noise(core.bank.brown, t, t + 0.18)
  const blp = s.filter("lowpass", 500)
  b.connect(blp).connect(s.env(t, 0.004, 0.4 * k, 0.13))
  if (own) {
    // Crack: a short 1.5–2.5 kHz band transient so our own gun cuts through the engine.
    const c = s.noise(core.bank.pink, t, t + 0.06)
    const cbp = s.filter("bandpass", rand(1600, 2300), 1)
    c.connect(cbp).connect(s.env(t, 0.003, 1.6, 0.035))
  } else {
    const n = s.noise(core.bank.pink, t, t + 0.12)
    const lp = s.filter("lowpass", rand(900, 1200), 0.6)
    n.connect(lp).connect(s.env(t, 0.003, 0.35 * k, 0.07))
  }
}

export function rocket(core: Core, at: At, own: boolean): void {
  const s = core.shot("rocket", own ? null : at, { ref: 45, limit: 6 })
  if (!s) return
  const t = s.t + rand(0, 0.01)
  // Soft ignition thump, then a breathy low whoosh that sweeps down as the rocket leaves.
  const o = s.osc("sine", 110, t, t + 0.15)
  sweep(o.frequency, 110, 50, t, 0.12)
  o.connect(s.env(t, 0.004, 0.35, 0.1))
  const w = s.noise(core.bank.pink, t, t + 0.9)
  const bp = s.filter("bandpass", 1100, 0.7)
  sweep(bp.frequency, rand(1000, 1300), 300, t, 0.75)
  const lp = s.filter("lowpass", 1800, 0.5)
  w.connect(bp).connect(lp).connect(s.env(t, 0.03, 0.45, 0.65))
}

const MISSILE_SIZE: Partial<Record<WeaponId, number>> = { aim9: 1, tvmissile: 1.1, hellfire: 1, maverick: 1.2, aim47: 1.5 }

/** Bomb release: a soft bay clunk, then the falling whistle (descending, fading as it drops away). */
export function bombWhistle(core: Core, at: At, own: boolean): void {
  const s = core.shot("bomb", own ? null : at, { ref: 80, limit: 3 })
  if (!s) return
  const t = s.t
  const k = s.osc("sine", 70, t, t + 0.25)
  k.connect(s.env(t, 0.004, 0.35, 0.2))
  const dur = 3.2
  const w = s.osc("sine", 1500, t + 0.15, t + 0.15 + dur)
  w.frequency.setValueAtTime(1500, t + 0.15)
  w.frequency.exponentialRampToValueAtTime(420, t + 0.15 + dur)
  w.connect(s.env(t + 0.15, 0.4, own ? 0.08 : 0.12, dur))
  const n = s.noise(core.bank.pink, t + 0.15, t + 0.15 + dur)
  const bp = s.filter("bandpass", 1400, 3)
  bp.frequency.setValueAtTime(1400, t + 0.15)
  bp.frequency.exponentialRampToValueAtTime(380, t + 0.15 + dur)
  n.connect(bp).connect(s.env(t + 0.15, 0.4, 0.05, dur))
}

export function missile(core: Core, weapon: WeaponId, at: At, own: boolean): void {
  const size = MISSILE_SIZE[weapon] ?? 1
  const s = core.shot("missile", own ? null : at, { ref: 60 * size, limit: 4, loudness: size })
  if (!s) return
  const t = s.t
  const dur = 1.6 * size
  // 1) Ignite: a low thump.
  const o = s.osc("sine", 85, t, t + 0.35)
  sweep(o.frequency, 85, 36, t, 0.28)
  o.connect(s.env(t, 0.005, 0.6, 0.28))
  // 2) Motor roar: pink noise behind a band that rises on ignition then closes as it recedes,
  //    and a lowpass so it's a deep "fwoom" rather than a hiss.
  const r = s.noise(core.bank.pink, t, t + dur + 0.2)
  const bp = s.filter("bandpass", 300, 0.7)
  bp.frequency.setValueAtTime(300, t)
  bp.frequency.exponentialRampToValueAtTime(1100, t + 0.2)
  bp.frequency.exponentialRampToValueAtTime(320, t + dur)
  const lp = s.filter("lowpass", 1600, 0.5)
  const re = s.env(t, 0.06, 0.7 * size, dur)
  r.connect(bp).connect(lp).connect(re)
  const b = s.noise(core.bank.brown, t, t + dur * 0.6)
  const blp = s.filter("lowpass", 300)
  b.connect(blp).connect(s.env(t, 0.03, 0.4 * size, dur * 0.5))
  s.send(0.3, re)
}

// ---------------------------------------------------------------- impacts

export function hitRemote(core: Core, at: At, heavy: boolean): void {
  const s = core.shot("hit", at, { ref: 40, limit: 6, loudness: heavy ? 1.5 : 1, vary: 0.08 })
  if (!s) return
  const t = s.t
  // Dull metallic "tunk": short lowpassed knock + a muted, low plate ring.
  const n = s.noise(core.bank.pink, t, t + 0.08)
  const bp = s.filter("bandpass", rand(700, 950), 0.9)
  n.connect(bp).connect(s.env(t, 0.003, heavy ? 1.1 : 0.9, 0.05))
  const ring = s.gain(1)
  ring.connect(s.out)
  for (const [f, g, d] of [[620, 0.12, 0.14], [930, 0.07, 0.11], [1370, 0.04, 0.08]] as const) {
    const o = s.osc("sine", f, t, t + d + 0.02)
    o.connect(s.env(t, 0.003, g, d, false)).connect(ring)
  }
  if (heavy) {
    const b = s.noise(core.bank.brown, t, t + 0.3)
    const lp = s.filter("lowpass", 400)
    b.connect(lp).connect(s.env(t, 0.004, 0.55, 0.22))
  }
}

/** We got hit: centered, heavy, unmistakable — a body thud, not a crackle. */
export function hitLocal(core: Core, damage: number): void {
  if (!core.allow("hitlocal", 0.05)) return
  const s = core.shot("hitlocal", null, { limit: 4, vary: 0.08 })
  if (!s) return
  const t = s.t
  const k = Math.min(1.3, 0.75 + damage / 120)
  const o = s.osc("sine", 95, t, t + 0.35)
  sweep(o.frequency, 100, 36, t, 0.22)
  o.connect(s.env(t, 0.003, 0.85 * k, 0.28))
  const b = s.noise(core.bank.brown, t, t + 0.25)
  const lp = s.filter("lowpass", 550)
  b.connect(lp).connect(s.env(t, 0.003, 0.6 * k, 0.17))
  const n = s.noise(core.bank.pink, t, t + 0.08)
  const bp = s.filter("bandpass", 1100, 0.8)
  n.connect(bp).connect(s.env(t, 0.003, 0.25 * k, 0.05))
  const ring = s.gain(1)
  ring.connect(s.out)
  for (const [f, g, d] of [[420, 0.06, 0.3], [690, 0.04, 0.24]] as const) {
    const r = s.osc("sine", f, t, t + d + 0.02)
    r.connect(s.env(t, 0.003, g, d, false)).connect(ring)
  }
  core.duck(0.5, 0.12)
}

/** Shooter feedback: a soft, short "tok" when our rounds connect. */
export function hitMarker(core: Core): void {
  if (!core.allow("hitmarker", 0.06)) return
  const s = core.shot("hitmarker", null, { limit: 3, bus: core.uiBus, vary: 0.04 })
  if (!s) return
  const t = s.t
  s.osc("sine", 1700, t, t + 0.06).connect(s.env(t, 0.003, 0.12, 0.035))
  s.osc("sine", 850, t, t + 0.06).connect(s.env(t, 0.003, 0.06, 0.04))
}

/** `size`: ~1 = aircraft destroyed; values > 5 are treated as splash radius in meters. */
export function explosion(core: Core, at: At, size: number): void {
  const sc = Math.max(0.3, Math.min(3, size > 5 ? size / 12 : size))
  const s = core.shot("explosion", at, { ref: 90 * sc, rolloff: 0.8, limit: 6, maxDelay: 1.2, loudness: 1.5 * sc })
  if (!s) return
  const t = s.t
  const len = Math.pow(sc, 0.35)
  // Attack: a lowpassed pink "crack" (no hiss).
  const c = s.noise(core.bank.pink, t, t + 0.15)
  const clp = s.filter("lowpass", 1800, 0.5)
  c.connect(clp).connect(s.env(t, 0.003, 0.55 * Math.sqrt(sc), 0.1))
  // Body: brown noise through a lowpass that slams shut.
  const b = s.noise(core.bank.brown, t, t + 1.8 * len)
  const blp = s.filter("lowpass", 1500, 0.6)
  sweep(blp.frequency, 1500, 140, t, 1.1 * len)
  const be = s.env(t, 0.005, 1, 1.4 * len)
  b.connect(blp).connect(be)
  // Sub thump.
  const o = s.osc("sine", 70, t, t + 1.1)
  sweep(o.frequency, 72, 26, t, 0.7)
  o.connect(s.env(t, 0.005, 0.85 * Math.min(1.2, sc), 0.9))
  // Long rolling tail.
  const r = s.noise(core.bank.brown, t, t + 3.5 * len)
  const rlp = s.filter("lowpass", 120)
  r.connect(rlp).connect(s.env(t + 0.03, 0.12, 0.5, 3 * len))
  s.send(0.5, be)
  if (s.distance < 250 * sc) core.duck(0.45, 0.25)
}

export function flares(core: Core, at: At, own: boolean): void {
  const s = core.shot("flares", own ? null : at, { ref: 35, limit: 3 })
  if (!s) return
  const t0 = s.t
  const count = 3 + Math.floor(rand(0, 2))
  for (let i = 0; i < count; i++) {
    // Soft "pumf" ejections with uneven spacing.
    const t = t0 + i * rand(0.09, 0.14)
    const n = s.noise(core.bank.pink, t, t + 0.1)
    const bp = s.filter("bandpass", rand(500, 750), 0.9)
    n.connect(bp).connect(s.env(t, 0.004, 0.4, 0.06))
    const o = s.osc("sine", rand(180, 220), t, t + 0.1)
    sweep(o.frequency, 200, 95, t, 0.07)
    o.connect(s.env(t, 0.004, 0.28, 0.07))
  }
  // Burning flares: a quiet low "fwoosh" trailing away.
  const f = s.noise(core.bank.brown, t0, t0 + 1.1)
  const lp = s.filter("lowpass", 700)
  f.connect(lp).connect(s.env(t0 + 0.05, 0.1, 0.18, 0.8))
}

/**
 * Radar pulse: a clean sonar ping with a soft octave below and a sub swell, hanging in the reverb.
 */
export function radarPulse(core: Core, at: At, own: boolean): void {
  const s = core.shot("pulse", own ? null : at, { ref: 400, rolloff: 0.7, limit: 2, hrtf: false, loudness: 2, vary: 0 })
  if (!s) return
  const t = s.t
  const bus = s.gain(1)
  bus.connect(s.out)
  for (const [f, g, d] of [[880, 0.2, 1.4], [440, 0.12, 1.6]] as const) {
    const o = s.osc("sine", f, t, t + d + 0.1)
    o.connect(s.env(t, 0.01, g, d, false)).connect(bus)
  }
  const sub = s.osc("sine", 45, t, t + 2.4)
  sweep(sub.frequency, 45, 32, t, 2)
  sub.connect(s.env(t, 0.4, 0.35, 1.8, false)).connect(bus)
  s.send(0.9, bus)
}

/** Killer confirmation: a restrained rising bell pair. */
export function killSting(core: Core): void {
  const s = core.shot("kill", null, { limit: 2, bus: core.uiBus })
  if (!s) return
  const t = s.t
  for (const [f, dt] of [[659.25, 0], [987.77, 0.09]] as const) {
    s.osc("sine", f, t + dt, t + dt + 0.8).connect(s.env(t + dt, 0.005, 0.2, 0.7))
  }
  s.osc("sine", 110, t, t + 0.6).connect(s.env(t, 0.01, 0.18, 0.5))
  s.send(0.5)
}

/** We died: a soft sinking low drone. */
export function deathSting(core: Core): void {
  const s = core.shot("death", null, { limit: 1, bus: core.uiBus })
  if (!s) return
  const t = s.t
  const lp = s.filter("lowpass", 600)
  lp.connect(s.out)
  const thud = s.osc("sine", 60, t, t + 0.8)
  sweep(thud.frequency, 60, 30, t, 0.6)
  thud.connect(s.env(t, 0.006, 0.45, 0.7))
  for (const f of [220, 233.08]) {
    const o = s.osc("triangle", f, t, t + 2.4)
    sweep(o.frequency, f, f / 2, t + 0.2, 2)
    o.connect(s.env(t, 0.08, 0.22, 2.1, false)).connect(lp)
  }
  s.send(0.7, lp)
}

export function matchEnd(core: Core): void {
  const s = core.shot("matchend", null, { limit: 1, bus: core.uiBus })
  if (!s) return
  const t = s.t
  const lp = s.filter("lowpass", 1200)
  lp.connect(s.out)
  for (const f of [110, 164.81, 220, 261.63, 329.63]) {
    const o = s.osc("triangle", f, t, t + 3.5)
    o.detune.value = rand(-5, 5)
    o.connect(s.env(t, 0.4, 0.07, 3, false)).connect(lp)
  }
  s.send(0.8, lp)
}

// ---------------------------------------------------------------- UI

export function uiBlip(core: Core, name: "click" | "hover" | "confirm" | "error" | "chat"): void {
  if (!core.allow(`ui:${name}`, name === "hover" ? 0.04 : 0.03)) return
  const s = core.shot("ui", null, { limit: 6, bus: core.uiBus })
  if (!s) return
  const t = s.t
  switch (name) {
    case "click":
      // Soft wooden "tok".
      s.osc("sine", 900, t, t + 0.05).connect(s.env(t, 0.003, 0.1, 0.03))
      s.osc("sine", 1800, t, t + 0.04).connect(s.env(t, 0.003, 0.04, 0.015))
      break
    case "hover":
      s.osc("sine", 1300, t, t + 0.04).connect(s.env(t, 0.004, 0.026, 0.02))
      break
    case "confirm":
      s.osc("sine", 660, t, t + 0.22).connect(s.env(t, 0.005, 0.11, 0.15))
      s.osc("sine", 990, t + 0.07, t + 0.3).connect(s.env(t + 0.07, 0.005, 0.1, 0.18))
      break
    case "error":
      // Two soft descending low tones.
      s.osc("triangle", 300, t, t + 0.16).connect(s.env(t, 0.006, 0.13, 0.11))
      s.osc("triangle", 225, t + 0.13, t + 0.3).connect(s.env(t + 0.13, 0.006, 0.13, 0.14))
      break
    case "chat":
      s.osc("sine", 1320, t, t + 0.09).connect(s.env(t, 0.004, 0.07, 0.06))
      s.osc("sine", 1760, t + 0.05, t + 0.15).connect(s.env(t + 0.05, 0.004, 0.05, 0.07))
      break
  }
}

type ToneName = "lock-tone" | "locked" | "warning"

/**
 * Sustained cockpit tones. Each call keeps the tone alive for a short hold, so callers can
 * invoke every frame while the condition holds or once per event (plays a short burst).
 * Gating LFOs are smoothed (40 Hz lowpass) so beeps have soft edges instead of clicks.
 * - lock-tone: seeker acquiring — 900 Hz beeps at 6 Hz.
 * - locked: solid 1.2 kHz tone (+ soft octave below) — "shoot now".
 * - warning: missile-warning warble, alternating ~1.0/1.3 kHz, gated beep-beep.
 */
export function cockpitTone(core: Core, name: ToneName): void {
  const key = name === "warning" ? "tone:warning" : "tone:lock"
  let h = core.helds.get(key)
  if (h && !h.dead && h.tag !== name) {
    h.stopNow()
    core.helds.delete(key)
    h = undefined
  }
  if (!h || h.dead) {
    const ctx = core.ctx
    const held = new Held(core, { at: null, dest: core.uiBus, attack: 0.01, release: 0.04, level: name === "warning" ? 0.22 : 0.11 })
    h = held
    held.tag = name
    const out = ctx.createGain()
    out.connect(held.env)
    held.nodes.push(out)
    const carrier = ctx.createOscillator()
    carrier.type = "sine"
    carrier.connect(out)
    held.sources.push(carrier)
    const smoothSquare = (rate: number, depth: number, target: AudioParam) => {
      const lfo = ctx.createOscillator()
      lfo.type = "square"
      lfo.frequency.value = rate
      const smooth = ctx.createBiquadFilter()
      smooth.type = "lowpass"
      smooth.frequency.value = 40
      const g = ctx.createGain()
      g.gain.value = depth
      lfo.connect(smooth)
      smooth.connect(g)
      g.connect(target)
      held.sources.push(lfo)
      held.nodes.push(smooth, g)
    }
    // Square LFO (±0.5) on top of a 0.5 base → soft on/off gating.
    const gate = (rate: number) => {
      out.gain.value = 0.5
      smoothSquare(rate, 0.5, out.gain)
    }
    if (name === "lock-tone") {
      carrier.frequency.value = 900
      gate(6)
    } else if (name === "locked") {
      carrier.frequency.value = 1200
      const oct = ctx.createOscillator()
      oct.frequency.value = 600
      const og = ctx.createGain()
      og.gain.value = 0.35
      oct.connect(og)
      og.connect(out)
      held.sources.push(oct)
      held.nodes.push(og)
    } else {
      carrier.frequency.value = 1150
      smoothSquare(9, 150, carrier.frequency)
      gate(2.5)
    }
    held.start()
    core.helds.set(key, held)
  }
  h.hold(name === "warning" ? 0.6 : name === "lock-tone" ? 0.35 : 0.3)
}

// ---------------------------------------------------------------- fleet anti-air

/**
 * Phalanx CIWS: a sustain loop per turret (events arrive ~10/s while it fires): 75 rounds/s of
 * jittered low thumps behind a lowpass — a distant rip, not a buzz-saw.
 */
export function ciws(core: Core, key: string, at: Vec3): void {
  let h = core.helds.get(key)
  if (!h || h.dead) {
    const ctx = core.ctx
    const held = new Held(core, { at, dest: core.sfxBus, ref: 70, attack: 0.02, release: 0.15, level: 0.42 })
    h = held
    const src = ctx.createBufferSource()
    src.buffer = core.bank.ciws
    src.loop = true
    src.playbackRate.value = rand(0.95, 1.05)
    const lp = ctx.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.value = 1400
    lp.Q.value = 0.5
    src.connect(lp)
    lp.connect(held.env)
    const send = ctx.createGain()
    send.gain.value = 0.3
    held.env.connect(send)
    send.connect(core.reverbIn)
    held.sources.push(src)
    held.nodes.push(lp, send)
    held.onRelease = (t) => {
      const s = core.shot("ciwstail", held.at, { ref: 70, limit: 3 })
      if (!s) return
      const tt = Math.max(s.t, t)
      const n = s.noise(core.bank.brown, tt, tt + 0.7)
      const tlp = s.filter("lowpass", 450, 0.6)
      sweep(tlp.frequency, 450, 120, tt, 0.5)
      const e = s.env(tt, 0.01, 0.25, 0.55)
      n.connect(tlp).connect(e)
      s.send(0.4, e)
    }
    src.start(core.now, Math.random() * core.bank.ciws.duration)
    core.helds.set(key, held)
  } else h.moveTo(at)
  h.hold(0.25)
}

/** Mk 45 5-inch deck gun: a deep cannon report that rolls across the water. */
export function navalGun(core: Core, at: Vec3): void {
  const s = core.shot("navalgun", at, { ref: 80, rolloff: 0.8, limit: 4, maxDelay: 1.5, loudness: 1.6 })
  if (!s) return
  const t = s.t
  const c = s.noise(core.bank.pink, t, t + 0.15)
  const clp = s.filter("lowpass", 1500, 0.5)
  c.connect(clp).connect(s.env(t, 0.003, 0.5, 0.08))
  const b = s.noise(core.bank.brown, t, t + 0.9)
  const lp = s.filter("lowpass", 1200, 0.6)
  sweep(lp.frequency, 1200, 130, t, 0.6)
  const be = s.env(t, 0.004, 0.8, 0.7)
  b.connect(lp).connect(be)
  const o = s.osc("sine", 58, t, t + 0.7)
  sweep(o.frequency, 58, 30, t, 0.5)
  o.connect(s.env(t, 0.004, 0.7, 0.55))
  s.send(0.6, be)
}

/** 5-inch flak burst: a short, dry "krump" with a dark puff (vs. the long boom of an explosion). */
export function flakBurst(core: Core, at: Vec3): void {
  const s = core.shot("flak", at, { ref: 50, rolloff: 0.9, limit: 6, maxDelay: 1.2, loudness: 1.3 })
  if (!s) return
  const t = s.t
  const c = s.noise(core.bank.pink, t, t + 0.1)
  const bp = s.filter("bandpass", rand(700, 900), 0.8)
  const clp = s.filter("lowpass", 1800, 0.5)
  c.connect(bp).connect(clp).connect(s.env(t, 0.003, 0.75, 0.06))
  const p = s.noise(core.bank.brown, t, t + 0.6)
  const lp = s.filter("lowpass", 450)
  const pe = s.env(t, 0.005, 0.5, 0.45)
  p.connect(lp).connect(pe)
  const o = s.osc("sine", 90, t, t + 0.22)
  sweep(o.frequency, 90, 40, t, 0.15)
  o.connect(s.env(t, 0.003, 0.4, 0.15))
  s.send(0.45, pe)
  if (s.distance < 120) core.duck(0.6, 0.15)
}
