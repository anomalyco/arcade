// One-shot and sustained weapon/impact/UI sounds, all synthesized from the shared bank.
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
  cannon20: { hold: 0.16, release: 0.07, level: 0.55, lp: 6500, lpOwn: 9000, ref: 45 },
  gau8: { hold: 0.12, release: 0.16, level: 0.8, lp: 2600, lpOwn: 4200, ref: 70 },
} as const

/**
 * Rotary cannons are a sustain loop, not one-shots: each `fire` event extends the loop, so 30
 * events/s cost three AudioParam calls instead of 30 new graphs, and the tone is a continuous
 * buzz-saw/BRRRT rather than a machine-gun stutter.
 */
export function rotaryGun(core: Core, vehicleId: string, weapon: "cannon20" | "gau8", at: At, own: boolean): Held | null {
  const key = `gun:${vehicleId}:${weapon}`
  const cfg = GUN_LOOP[weapon]
  let h = core.helds.get(key)
  if (!h || h.dead) {
    if (!own && !at) return null
    const ctx = core.ctx
    h = new Held(core, { at: own ? null : at, dest: core.sfxBus, ref: cfg.ref, attack: 0.006, release: cfg.release, level: cfg.level * (own ? 1 : 1.3), vehicleId })
    const src = ctx.createBufferSource()
    src.buffer = weapon === "gau8" ? core.bank.gau8 : core.bank.vulcan
    src.loop = true
    src.playbackRate.value = rand(0.98, 1.02)
    const lp = ctx.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.value = own ? cfg.lpOwn : cfg.lp
    src.connect(lp)
    lp.connect(h.env)
    h.sources.push(src)
    h.nodes.push(lp)
    if (weapon === "gau8") {
      // Sub layer: the chest-thump you feel under the growl.
      const sub = ctx.createOscillator()
      sub.type = "sine"
      sub.frequency.value = 65
      const sg = ctx.createGain()
      sg.gain.value = own ? 0.35 : 0.2
      sub.connect(sg)
      sg.connect(h.env)
      h.sources.push(sub)
      h.nodes.push(sg)
      // A little room so the BRRRT hangs in the canyon.
      const send = ctx.createGain()
      send.gain.value = 0.35
      h.env.connect(send)
      send.connect(core.reverbIn)
      h.nodes.push(send)
    }
    const held = h
    held.onRelease = (t) => gunTail(core, weapon, own ? null : held.at, t)
    h.start()
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
  const o = s.osc("sine", big ? 120 : 260, t, t + 0.15)
  sweep(o.frequency, big ? 120 : 260, big ? 45 : 90, t, 0.12)
  o.connect(s.env(t, 0.002, big ? 0.6 : 0.3, 0.12))
}

function gunTail(core: Core, weapon: "cannon20" | "gau8", at: At, when: number): void {
  const s = core.shot("guntail", at, { ref: 60, limit: 4, maxDelay: 0 })
  if (!s) return
  const t = Math.max(s.t, when)
  if (weapon === "gau8") {
    // Spin-down: the barrels coast and the echo rolls back off the terrain.
    const n = s.noise(core.bank.brown, t, t + 1.2, 0.8)
    const lp = s.filter("lowpass", 380, 0.8)
    sweep(lp.frequency, 380, 90, t, 0.9)
    const e = s.env(t, 0.01, 0.55, 0.9)
    n.connect(lp).connect(e)
    s.send(0.6, e)
    const o = s.osc("sawtooth", 65, t, t + 0.35)
    sweep(o.frequency, 65, 22, t, 0.3)
    const olp = s.filter("lowpass", 300)
    o.connect(olp).connect(s.env(t, 0.005, 0.12, 0.3))
  } else {
    const n = s.noise(core.bank.pink, t, t + 0.4)
    const bp = s.filter("bandpass", 1400, 1.2)
    sweep(bp.frequency, 1400, 500, t, 0.3)
    n.connect(bp).connect(s.env(t, 0.005, 0.18, 0.3))
  }
}

export function chaingun(core: Core, at: At, own: boolean): void {
  const s = core.shot("chaingun", own ? null : at, { ref: 40, limit: 6 })
  if (!s) return
  const t = s.t
  const k = own ? 1 : 1.2
  const o = s.osc("sine", 150, t, t + 0.14)
  sweep(o.frequency, rand(140, 160), 48, t, 0.1)
  o.connect(s.env(t, 0.002, 0.75 * k, 0.11))
  const n = s.noise(core.bank.white, t, t + 0.08)
  const bp = s.filter("bandpass", rand(1200, 1600), 0.8)
  n.connect(bp).connect(s.env(t, 0.001, 0.5 * k, 0.05))
  const b = s.noise(core.bank.brown, t, t + 0.15)
  const lp = s.filter("lowpass", 700)
  b.connect(lp).connect(s.env(t, 0.003, 0.45 * k, 0.12))
}

export function rocket(core: Core, at: At, own: boolean): void {
  const s = core.shot("rocket", own ? null : at, { ref: 45, limit: 6 })
  if (!s) return
  const t = s.t
  // Ignition pop then a whoosh whose band sweeps down as the rocket leaves us.
  const p = s.noise(core.bank.white, t, t + 0.08)
  const plp = s.filter("lowpass", 1100)
  p.connect(plp).connect(s.env(t, 0.001, 0.55, 0.06))
  const w = s.noise(core.bank.white, t, t + 0.9, rand(0.9, 1.1))
  const bp = s.filter("bandpass", 2600, 1.1)
  sweep(bp.frequency, rand(2400, 3000), 600, t, 0.75)
  w.connect(bp).connect(s.env(t, 0.015, 0.5, 0.7))
  const c = s.noise(core.bank.crackle, t, t + 0.5)
  const chp = s.filter("highpass", 1800)
  c.connect(chp).connect(s.env(t, 0.01, 0.25, 0.4))
}

const MISSILE_SIZE: Partial<Record<WeaponId, number>> = { aim9: 1, tvmissile: 1.1, hellfire: 1, maverick: 1.2, aim47: 1.5 }

export function missile(core: Core, weapon: WeaponId, at: At, own: boolean): void {
  const size = MISSILE_SIZE[weapon] ?? 1
  const s = core.shot("missile", own ? null : at, { ref: 60 * size, limit: 4, loudness: size })
  if (!s) return
  const t = s.t
  const dur = 1.6 * size
  // 1) Ignite: low thump + motor crackle burst.
  const o = s.osc("sine", 90, t, t + 0.3)
  sweep(o.frequency, 90, 38, t, 0.25)
  o.connect(s.env(t, 0.003, 0.7, 0.25))
  const c = s.noise(core.bank.crackle, t, t + 0.6)
  const chp = s.filter("highpass", 1200)
  c.connect(chp).connect(s.env(t, 0.005, 0.45, 0.5))
  // 2) Motor roar: pink noise whose band rises with ignition then closes as it recedes.
  const r = s.noise(core.bank.pink, t, t + dur + 0.2)
  const bp = s.filter("bandpass", 400, 0.9)
  bp.frequency.setValueAtTime(400, t)
  bp.frequency.exponentialRampToValueAtTime(2200, t + 0.18)
  bp.frequency.exponentialRampToValueAtTime(500, t + dur)
  const re = s.env(t, 0.06, 0.75 * size, dur)
  r.connect(bp).connect(re)
  // 3) Hiss on top: the "fwoosh".
  const h = s.noise(core.bank.white, t, t + 0.8)
  const hp = s.filter("highpass", 3000)
  h.connect(hp).connect(s.env(t, 0.02, 0.18, 0.6))
  s.send(0.35, re)
}

// ---------------------------------------------------------------- impacts

export function hitRemote(core: Core, at: At, heavy: boolean): void {
  const s = core.shot("hit", at, { ref: 40, limit: 6, loudness: heavy ? 1.5 : 1 })
  if (!s) return
  const t = s.t
  // Metallic crack: bright noise snap + inharmonic plate ring.
  const n = s.noise(core.bank.white, t, t + 0.06)
  const hp = s.filter("highpass", 1800)
  n.connect(hp).connect(s.env(t, 0.001, heavy ? 0.9 : 0.7, 0.045))
  const base = rand(0.88, 1.12)
  const ring = s.gain(1)
  ring.connect(s.out)
  for (const [f, g, d] of [[1870, 0.12, 0.18], [2730, 0.09, 0.14], [4110, 0.06, 0.1]] as const) {
    const o = s.osc("sine", f * base, t, t + d + 0.02)
    const e = s.env(t, 0.001, g, d, false)
    o.connect(e).connect(ring)
  }
  if (heavy) {
    const b = s.noise(core.bank.brown, t, t + 0.25)
    const lp = s.filter("lowpass", 500)
    b.connect(lp).connect(s.env(t, 0.003, 0.6, 0.2))
  }
}

/** We got hit: centered, heavy, unmistakable. */
export function hitLocal(core: Core, damage: number): void {
  if (!core.allow("hitlocal", 0.05)) return
  const s = core.shot("hitlocal", null, { limit: 4 })
  if (!s) return
  const t = s.t
  const k = Math.min(1.3, 0.75 + damage / 120)
  const o = s.osc("sine", 95, t, t + 0.35)
  sweep(o.frequency, 100, 36, t, 0.22)
  o.connect(s.env(t, 0.002, 0.9 * k, 0.28))
  const b = s.noise(core.bank.brown, t, t + 0.25)
  const lp = s.filter("lowpass", 650)
  b.connect(lp).connect(s.env(t, 0.002, 0.65 * k, 0.17))
  const n = s.noise(core.bank.white, t, t + 0.06)
  const bp = s.filter("bandpass", 2500, 1)
  n.connect(bp).connect(s.env(t, 0.001, 0.4 * k, 0.04))
  const ring = s.gain(1)
  ring.connect(s.out)
  for (const [f, g, d] of [[620, 0.08, 0.32], [1130, 0.06, 0.26], [1790, 0.04, 0.2]] as const) {
    const r = s.osc("triangle", f * rand(0.95, 1.05), t, t + d + 0.02)
    r.connect(s.env(t, 0.001, g, d, false)).connect(ring)
  }
  core.duck(0.5, 0.12)
}

/** Shooter feedback: a dry, quiet "tick" when our rounds connect. */
export function hitMarker(core: Core): void {
  if (!core.allow("hitmarker", 0.06)) return
  const s = core.shot("hitmarker", null, { limit: 3, bus: core.uiBus })
  if (!s) return
  const t = s.t
  const o = s.osc("square", 2400, t, t + 0.05)
  const bp = s.filter("bandpass", 2400, 3)
  o.connect(bp).connect(s.env(t, 0.001, 0.12, 0.035))
}

/** `size`: ~1 = aircraft destroyed; values > 5 are treated as splash radius in meters. */
export function explosion(core: Core, at: At, size: number): void {
  const sc = Math.max(0.3, Math.min(3, size > 5 ? size / 12 : size))
  const s = core.shot("explosion", at, { ref: 90 * sc, rolloff: 0.8, limit: 6, maxDelay: 1.2, loudness: 1.5 * sc })
  if (!s) return
  const t = s.t
  const far = s.distance > 1500
  const len = Math.pow(sc, 0.35)
  if (!far) {
    // Crack: the supersonic leading edge.
    const c = s.noise(core.bank.white, t, t + 0.08)
    const chp = s.filter("highpass", 900)
    c.connect(chp).connect(s.env(t, 0.001, 0.8 * Math.sqrt(sc), 0.06))
  }
  // Body: brown noise through a lowpass that slams shut.
  const b = s.noise(core.bank.brown, t, t + 1.8 * len, rand(0.85, 1.05))
  const blp = s.filter("lowpass", 2500, 0.9)
  sweep(blp.frequency, 2600, 160, t, 1.2 * len)
  const be = s.env(t, 0.004, 1, 1.4 * len)
  b.connect(blp).connect(be)
  // Sub thump.
  const o = s.osc("sine", 70, t, t + 1.1)
  sweep(o.frequency, 72, 26, t, 0.7)
  o.connect(s.env(t, 0.004, 0.9 * Math.min(1.2, sc), 0.9))
  // Long rolling tail.
  const r = s.noise(core.bank.brown, t, t + 3.5 * len)
  const rlp = s.filter("lowpass", 120)
  const re = s.env(t + 0.03, 0.12, 0.55, 3 * len)
  r.connect(rlp).connect(re)
  if (!far) {
    // Debris crackle.
    const d = s.noise(core.bank.crackle, t + 0.05, t + 1.2)
    const dhp = s.filter("highpass", 2000)
    d.connect(dhp).connect(s.env(t + 0.05, 0.05, 0.22, 0.9))
  }
  s.send(0.55, be)
  if (s.distance < 250 * sc) core.duck(0.45, 0.25)
}

export function flares(core: Core, at: At, own: boolean): void {
  const s = core.shot("flares", own ? null : at, { ref: 35, limit: 3 })
  if (!s) return
  const t0 = s.t
  for (let i = 0; i < 4; i++) {
    const t = t0 + i * 0.11 + rand(-0.015, 0.015)
    const n = s.noise(core.bank.white, t, t + 0.05)
    const bp = s.filter("bandpass", rand(950, 1300), 2)
    n.connect(bp).connect(s.env(t, 0.001, 0.55, 0.035))
    const o = s.osc("sine", 230, t, t + 0.08)
    sweep(o.frequency, 230, 110, t, 0.06)
    o.connect(s.env(t, 0.001, 0.32, 0.06))
  }
  // Magnesium fizz trailing away.
  const f = s.noise(core.bank.white, t0, t0 + 1.2)
  const hp = s.filter("highpass", 3500)
  f.connect(hp).connect(s.env(t0 + 0.05, 0.08, 0.08, 0.9))
}

/**
 * Radar pulse — the game's cosmic-horror signature. A sonar ping with a tritone shadow, a
 * dissonant cluster that slides into the abyss, a sub-bass swell you feel more than hear, and
 * a whispering formant breath. Most of it is sent into the reverb so it hangs in the sky.
 */
export function radarPulse(core: Core, at: At, own: boolean): void {
  const s = core.shot("pulse", own ? null : at, { ref: 400, rolloff: 0.7, limit: 2, hrtf: false, loudness: 2 })
  if (!s) return
  const t = s.t
  const bus = s.gain(1)
  bus.connect(s.out)
  // Ping + tritone below, with an uneasy vibrato.
  const lfo = s.osc("sine", 5.3, t, t + 1.8)
  const lfoAmt = s.gain(7)
  lfo.connect(lfoAmt)
  for (const [f, g] of [[1180, 0.32], [1180 / Math.SQRT2, 0.2]] as const) {
    const o = s.osc("sine", f, t, t + 1.8)
    lfoAmt.connect(o.frequency)
    o.connect(s.env(t, 0.004, g, 1.6, false)).connect(bus)
  }
  // Dissonant glissando: root, minor second, tritone — sliding ~4 octaves down.
  const glp = s.filter("lowpass", 2200, 0.6)
  glp.connect(bus)
  for (const ratio of [1, 1.059, 1.414]) {
    const o = s.osc("triangle", 880 * ratio, t, t + 3.8)
    sweep(o.frequency, 880 * ratio, 55 * ratio, t + 0.1, 3.4)
    o.detune.value = rand(-8, 8)
    o.connect(s.env(t + 0.05, 0.4, 0.09, 3.2, false)).connect(glp)
  }
  // Sub swell.
  const sub = s.osc("sine", 34, t, t + 3.4)
  sweep(sub.frequency, 34, 25, t, 3)
  sub.connect(s.env(t, 0.6, 0.55, 2.6, false)).connect(bus)
  // Whispering breath.
  const n = s.noise(core.bank.pink, t, t + 3.2, 0.7)
  const bp = s.filter("bandpass", 700, 4)
  sweep(bp.frequency, 700, 180, t, 2.8)
  n.connect(bp).connect(s.env(t + 0.2, 0.7, 0.2, 2.1, false)).connect(bus)
  s.send(1.2, bus)
}

/** Killer confirmation: a restrained rising bell pair with a dark undertone. */
export function killSting(core: Core): void {
  const s = core.shot("kill", null, { limit: 2, bus: core.uiBus })
  if (!s) return
  const t = s.t
  for (const [f, dt] of [[659.25, 0], [987.77, 0.09]] as const) {
    const a = s.osc("sine", f, t + dt, t + dt + 0.8)
    a.connect(s.env(t + dt, 0.004, 0.22, 0.7))
    const b = s.osc("triangle", f * 2.01, t + dt, t + dt + 0.4)
    b.connect(s.env(t + dt, 0.003, 0.05, 0.35))
  }
  const low = s.osc("sine", 110, t, t + 0.6)
  low.connect(s.env(t, 0.01, 0.2, 0.5))
  s.send(0.5)
}

/** We died: a sinking minor-second drone. */
export function deathSting(core: Core): void {
  const s = core.shot("death", null, { limit: 1, bus: core.uiBus })
  if (!s) return
  const t = s.t
  const lp = s.filter("lowpass", 900)
  lp.connect(s.out)
  const thud = s.osc("sine", 60, t, t + 0.8)
  sweep(thud.frequency, 60, 30, t, 0.6)
  thud.connect(s.env(t, 0.005, 0.5, 0.7))
  for (const f of [220, 233.08]) {
    const o = s.osc("sawtooth", f, t, t + 2.4)
    sweep(o.frequency, f, f / 2, t + 0.2, 2)
    o.connect(s.env(t, 0.05, 0.3, 2.2, false)).connect(lp)
  }
  s.send(0.8, lp)
}

export function matchEnd(core: Core): void {
  const s = core.shot("matchend", null, { limit: 1, bus: core.uiBus })
  if (!s) return
  const t = s.t
  const lp = s.filter("lowpass", 1800)
  lp.connect(s.out)
  for (const f of [110, 164.81, 220, 261.63, 311.13]) {
    const o = s.osc("triangle", f, t, t + 3.5)
    o.detune.value = rand(-6, 6)
    o.connect(s.env(t, 0.4, 0.07, 3, false)).connect(lp)
  }
  s.send(0.9, lp)
}

// ---------------------------------------------------------------- UI

export function uiBlip(core: Core, name: "click" | "hover" | "confirm" | "error" | "chat"): void {
  if (!core.allow(`ui:${name}`, name === "hover" ? 0.04 : 0.03)) return
  const s = core.shot("ui", null, { limit: 6, bus: core.uiBus })
  if (!s) return
  const t = s.t
  switch (name) {
    case "click": {
      s.osc("sine", 2100, t, t + 0.03).connect(s.env(t, 0.001, 0.22, 0.018))
      const n = s.noise(core.bank.white, t, t + 0.01)
      n.connect(s.filter("highpass", 4000)).connect(s.env(t, 0.0005, 0.08, 0.005))
      break
    }
    case "hover":
      s.osc("sine", 3200, t, t + 0.02).connect(s.env(t, 0.001, 0.05, 0.008))
      break
    case "confirm":
      s.osc("triangle", 660, t, t + 0.2).connect(s.env(t, 0.003, 0.2, 0.14))
      s.osc("triangle", 990, t + 0.07, t + 0.3).connect(s.env(t + 0.07, 0.003, 0.2, 0.18))
      break
    case "error": {
      const lp = s.filter("lowpass", 900)
      lp.connect(s.out)
      for (const dt of [0, 0.13]) {
        s.osc("square", 160, t + dt, t + dt + 0.12).connect(s.env(t + dt, 0.004, 0.14, 0.09, false)).connect(lp)
        s.osc("square", 171, t + dt, t + dt + 0.12).connect(s.env(t + dt, 0.004, 0.1, 0.09, false)).connect(lp)
      }
      break
    }
    case "chat":
      s.osc("sine", 1320, t, t + 0.08).connect(s.env(t, 0.002, 0.08, 0.06))
      s.osc("sine", 1760, t + 0.05, t + 0.14).connect(s.env(t + 0.05, 0.002, 0.06, 0.07))
      break
  }
}

type ToneName = "lock-tone" | "locked" | "warning"

/**
 * Sustained cockpit tones. Each call keeps the tone alive for a short hold, so callers can
 * invoke every frame while the condition holds or once per event (plays a short burst).
 * - lock-tone: seeker acquiring — 900 Hz beeps at 6 Hz.
 * - locked: solid 1.65 kHz tone (+ soft octave) — "shoot now".
 * - warning: missile-warning warble, alternating 1.4/1.0 kHz, gated beep-beep.
 */
export function cockpitTone(core: Core, name: ToneName): void {
  const lockKey = "tone:lock"
  const key = name === "warning" ? "tone:warning" : lockKey
  let h = core.helds.get(key)
  if (h && !h.dead && h.tag !== name) {
    h.stopNow()
    core.helds.delete(key)
    h = undefined
  }
  if (!h || h.dead) {
    const ctx = core.ctx
    h = new Held(core, { at: null, dest: core.uiBus, attack: 0.005, release: 0.03, level: name === "warning" ? 0.3 : 0.22 })
    h.tag = name
    const out = ctx.createGain()
    out.connect(h.env)
    h.nodes.push(out)
    const carrier = ctx.createOscillator()
    carrier.type = name === "warning" ? "triangle" : "sine"
    carrier.connect(out)
    h.sources.push(carrier)
    const gate = (rate: number) => {
      // Square LFO (±0.5) on top of a 0.5 base → on/off gating.
      out.gain.value = 0.5
      const lfo = ctx.createOscillator()
      lfo.type = "square"
      lfo.frequency.value = rate
      const depth = ctx.createGain()
      depth.gain.value = 0.5
      lfo.connect(depth)
      depth.connect(out.gain)
      h!.sources.push(lfo)
      h!.nodes.push(depth)
    }
    if (name === "lock-tone") {
      carrier.frequency.value = 900
      gate(6)
    } else if (name === "locked") {
      carrier.frequency.value = 1650
      const oct = ctx.createOscillator()
      oct.frequency.value = 825
      const og = ctx.createGain()
      og.gain.value = 0.3
      oct.connect(og)
      og.connect(out)
      h.sources.push(oct)
      h.nodes.push(og)
    } else {
      carrier.frequency.value = 1200
      const fm = ctx.createOscillator()
      fm.type = "square"
      fm.frequency.value = 9
      const fmDepth = ctx.createGain()
      fmDepth.gain.value = 200
      fm.connect(fmDepth)
      fmDepth.connect(carrier.frequency)
      h.sources.push(fm)
      h.nodes.push(fmDepth)
      gate(2.5)
    }
    h.start()
    core.helds.set(key, h)
  }
  h.hold(name === "warning" ? 0.6 : name === "lock-tone" ? 0.35 : 0.3)
}
