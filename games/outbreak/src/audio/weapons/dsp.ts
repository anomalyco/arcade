import { mulberry32 } from "@arcade/kit/sim/rng"
import { Biquad, edges, filter, gunshotFar, Mode, normalize, smoothNoise, strike, TAU, white, type BiquadKind } from "../soundscape/dsp"

/**
 * Procedural weapon sounds (AR-102): every shot, swing, hit, reload part and impact synthesized from layers into mono
 * PCM, deterministically from a seed, so each round-robin variant is its own take and nothing is anyone's recording.
 * A firearm's report is built from its layers (mechanical action, the crack, the body's punch and the low thump);
 * its environment tail (room, alley slapback, street, open ground) and its far version are separate sounds, picked
 * and crossfaded at play time by where the shot is and how far away the listener is (`weapons.ts`).
 */

/** Weapons carry crack, brass and blade detail up to 16 kHz, so they bake at 32 kHz (two thirds of 48k's memory). */
export const WEAPON_SAMPLE_RATE = 32000

const buffer = (sr: number, seconds: number) => new Float32Array(Math.max(1, Math.round(sr * seconds)))
const at = (sr: number, seconds: number) => Math.round(sr * seconds)
const lerp = (a: number, b: number, u: number) => a + (b - a) * u

type Burst = {
  amp: number
  /** Exponential decay time constant (s). */
  decay: number
  attack?: number
  length?: number
  kind?: BiquadKind
  hz?: number
  q?: number
  /** Filter glides exponentially to this frequency over the burst. */
  to?: number
  /** Second filter stage, same kind and frequency (steeper). */
  steep?: boolean
}

/** A filtered noise burst with a linear attack and an exponential decay, added into `out` at `start` (samples). */
export function burst(out: Float32Array, sr: number, start: number, o: Burst, rand: () => number): void {
  const len = Math.min(out.length - start, at(sr, o.length ?? o.decay * 7))
  const hz = o.hz ?? 1000
  const q = o.q ?? 0.707
  const f = o.kind ? new Biquad(sr, o.kind, hz, q) : null
  const f2 = o.kind && o.steep ? new Biquad(sr, o.kind, hz, q) : null
  const att = Math.max(1, at(sr, o.attack ?? 0.0004))
  for (let k = 0; k < len; k++) {
    if (f && o.to !== undefined && (k & 15) === 0) {
      const g = hz * Math.pow(o.to / hz, k / len)
      f.set(g, q)
      f2?.set(g, q)
    }
    const env = Math.min(1, k / att) * Math.exp(-k / (o.decay * sr))
    let x = white(rand)
    if (f) x = f.tick(x)
    if (f2) x = f2.tick(x)
    out[start + k]! += x * env * o.amp
  }
}

/** A sine whose pitch falls from `f0` to `f1`: the low thump of a blast, the thud of a body. */
export function thump(out: Float32Array, sr: number, start: number, amp: number, f0: number, f1: number, decay: number, attack = 0.0015): void {
  const len = Math.min(out.length - start, at(sr, decay * 7))
  let ph = 0
  for (let k = 0; k < len; k++) {
    const t = k / sr
    const f = f1 + (f0 - f1) * Math.exp(-t / (decay * 0.45))
    ph += (TAU * f) / sr
    out[start + k]! += Math.sin(ph) * Math.min(1, t / attack) * Math.exp(-t / decay) * amp
  }
}

/** The muzzle's N-wave: a near-instant overpressure swinging to underpressure (the crack's leading edge). */
function nwave(out: Float32Array, sr: number, start: number, amp: number, ms: number): void {
  const n = Math.max(2, at(sr, ms / 1000))
  for (let k = 0; k < n && start + k < out.length; k++) out[start + k]! += amp * (1 - (2 * k) / n)
}

/** Sparse random clicks (crackle, grit, embers) over `seconds`, `rate` per second, through a band. */
function crackle(out: Float32Array, sr: number, start: number, seconds: number, rate: number, amp: number, hz: number, rand: () => number, fade = true): void {
  const bp = new Biquad(sr, "bandpass", hz, 1.1)
  const n = Math.min(out.length - start, at(sr, seconds))
  const p = rate / sr
  let hit = 0
  for (let k = 0; k < n; k++) {
    if (rand() < p) hit = (0.3 + rand() * 0.7) * (fade ? 1 - k / n : 1)
    const x = hit * white(rand)
    hit *= 0.82
    out[start + k]! += bp.tick(x) * amp
  }
}

/** Soft clipping that keeps a report dense without clipping: tanh, normalised to unity at full scale. */
function saturate(buf: Float32Array, drive: number): Float32Array {
  const k = Math.tanh(drive)
  let peak = 0
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]!))
  if (peak <= 0) return buf
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh((buf[i]! / peak) * drive) / k
  return buf
}

/** Discrete echoes of `src` (`[delay s, gain, lowpass Hz]`) added into `out`. */
function taps(out: Float32Array, src: Float32Array, sr: number, list: readonly (readonly [number, number, number])[]): void {
  for (const [delay, gain, hz] of list) {
    const d = at(sr, delay)
    const lp = new Biquad(sr, "lowpass", hz, 0.6)
    for (let i = 0; i < src.length && i + d < out.length; i++) out[i + d]! += lp.tick(src[i]!) * gain
  }
}

/** A diffuse decaying tail (`rt60` seconds to -60 dB) of band-limited noise, faded in over `attack`. */
function diffuse(out: Float32Array, sr: number, start: number, amp: number, rt60: number, lpHz: number, hpHz: number, rand: () => number, attack = 0.006, roll = 0): void {
  const lp = new Biquad(sr, "lowpass", lpHz, 0.6)
  const lp2 = new Biquad(sr, "lowpass", lpHz, 0.6)
  const hp = new Biquad(sr, "highpass", hpHz, 0.6)
  const n = out.length - start
  const seed = Math.floor(rand() * 1000)
  for (let k = 0; k < n; k++) {
    const t = k / sr
    // Rolling: the decay breathes like thunder (open ground, far reports).
    const r = roll > 0 ? 1 - roll + roll * 2 * smoothNoise(t * 6, seed) : 1
    const env = Math.min(1, t / attack) * Math.pow(10, (-3 * t) / rt60) * r
    // Air takes the top off as the tail goes on.
    if ((k & 63) === 0) lp.set(lpHz * Math.pow(0.35, t / rt60), 0.6)
    out[start + k]! += hp.tick(lp2.tick(lp.tick(white(rand)))) * env * amp
  }
}

/** A whoosh: band noise whose centre and level rise and fall over `seconds` (peak at `peakAt` of the way). */
function whoosh(out: Float32Array, sr: number, start: number, seconds: number, o: { amp: number; lo: number; hi: number; q: number; peakAt?: number; tone?: number; toneQ?: number; toneAmp?: number; flutter?: number }, rand: () => number): void {
  const n = Math.min(out.length - start, at(sr, seconds))
  const bp = new Biquad(sr, "bandpass", o.lo, o.q)
  const tone = o.tone ? new Biquad(sr, "bandpass", o.tone, o.toneQ ?? 10) : null
  const pk = o.peakAt ?? 0.45
  for (let k = 0; k < n; k++) {
    const u = k / n
    // Fast rise to the peak (the head of the weapon at full speed), slower fall.
    const bell = u < pk ? Math.sin((u / pk) * Math.PI * 0.5) ** 2 : Math.cos(((u - pk) / (1 - pk)) * Math.PI * 0.5) ** 1.6
    if ((k & 15) === 0) {
      bp.set(lerp(o.lo, o.hi, bell), o.q)
      tone?.set(o.tone! * (0.8 + 0.35 * bell), o.toneQ ?? 10)
    }
    const fl = o.flutter ? 0.65 + 0.35 * Math.sin(TAU * o.flutter * (k / sr)) : 1
    const x = white(rand)
    let y = bp.tick(x) * o.amp
    if (tone) y += tone.tick(x) * (o.toneAmp ?? 0.6) * o.amp
    out[start + k]! += y * bell * fl
  }
}

/** A wet squelch: band noise gliding down with a fast flutter, under every hit on flesh. */
function squelch(out: Float32Array, sr: number, start: number, amp: number, seconds: number, rand: () => number, hz = 1500): void {
  const n = Math.min(out.length - start, at(sr, seconds))
  const bp = new Biquad(sr, "bandpass", hz, 2.2)
  for (let k = 0; k < n; k++) {
    const u = k / n
    if ((k & 15) === 0) bp.set(hz * (1 - 0.55 * u) * (0.85 + 0.3 * rand()), 2.2)
    const am = 0.5 + 0.5 * Math.sin(TAU * (70 + 40 * rand()) * (k / sr))
    out[start + k]! += bp.tick(white(rand)) * am * (1 - u) ** 2 * amp
  }
}

const finish = (out: Float32Array, sr: number, rmsDb: number, hp = 30, tailFade = 0.02) => {
  filter(out, new Biquad(sr, "highpass", hp, 0.7))
  return normalize(edges(out, sr, 0.0004, tailFade), sr, rmsDb)
}

// ---------------------------------------------------------------------------------------------------------------
// Firearms
// ---------------------------------------------------------------------------------------------------------------

/**
 * The 9 mm pistol near the shooter, in four layers: the action (hammer fall, then the slide cycling back and slamming
 * home), the crack (N-wave and a hiss of supersonic gas), the body's punch (a band of noise round 600 Hz and its
 * bright edge) and the low thump (a 100 → 45 Hz drop). Dry: the room or the street adds its own tail.
 */
export function pistolReport(sr: number, seed: number): Float32Array {
  const rand = mulberry32(seed * 7 + 1)
  const out = buffer(sr, 0.42)
  const j = (a: number) => 1 + (rand() * 2 - 1) * a
  // Mechanical: the striker a hair before the blast, the slide back (a scrape) and home (a heavy clack).
  strike(out, sr, 0, [[3900 * j(0.05), 0.006, 1], [6100 * j(0.05), 0.004, 0.5]], 0.18, rand, 0.3)
  const s = at(sr, 0.0025)
  burst(out, sr, s + at(sr, 0.018), { amp: 0.05, decay: 0.012, kind: "bandpass", hz: 3200, q: 1.2 }, rand)
  strike(out, sr, s + at(sr, 0.034 + rand() * 0.006), [[2300 * j(0.06), 0.02, 1], [4700 * j(0.05), 0.012, 0.6], [1250, 0.03, 0.4]], 0.32, rand, 0.6)
  // Crack.
  nwave(out, sr, s, 0.9, 0.45 + rand() * 0.2)
  burst(out, sr, s, { amp: 0.85, decay: 0.0022, kind: "highpass", hz: 2400 }, rand)
  // Body punch.
  burst(out, sr, s, { amp: 1.6, decay: 0.019 * j(0.15), attack: 0.0008, kind: "bandpass", hz: 620 * j(0.12), q: 0.75, to: 380 }, rand)
  burst(out, sr, s, { amp: 0.6, decay: 0.008, kind: "bandpass", hz: 1900 * j(0.1), q: 0.9 }, rand)
  // Low thump.
  thump(out, sr, s, 0.75, 105 * j(0.08), 46, 0.075 * j(0.15))
  saturate(out, 2.2)
  return finish(out, sr, -11, 32, 0.05)
}

/** The flare gun: a hollow signal-pistol pop through a wide brass tube, the cartridge hissing out and the flare fizzing away. */
export function flareReport(sr: number, seed: number): Float32Array {
  const rand = mulberry32(seed * 11 + 3)
  const out = buffer(sr, 1.1)
  strike(out, sr, 0, [[2700, 0.012, 1], [4300, 0.008, 0.5]], 0.22, rand, 0.5)
  const s = at(sr, 0.004)
  nwave(out, sr, s, 0.35, 0.9)
  // The tube: a low-mid "thoonk".
  strike(out, sr, s, [[168 + rand() * 14, 0.13, 1], [410 + rand() * 20, 0.07, 0.55], [905, 0.03, 0.25]], 2.4, rand, 3)
  burst(out, sr, s, { amp: 0.9, decay: 0.03, kind: "lowpass", hz: 1400 }, rand)
  thump(out, sr, s, 0.5, 80, 42, 0.09)
  // The flare leaving: a fizzing hiss that rises and fades.
  const f = s + at(sr, 0.05)
  whoosh(out, sr, f, 0.95, { amp: 0.32, lo: 1800, hi: 5200, q: 0.8, peakAt: 0.18 }, rand)
  crackle(out, sr, f, 0.9, 260, 0.35, 3800, rand)
  saturate(out, 1.6)
  return finish(out, sr, -14, 40, 0.15)
}

/** A flare pistol reloaded after each shot: the barrel broken open, the spent shell kicked out and tocking on the floor, a fresh one slid home, the action snapped shut. */
export function flareReload(sr: number, seed: number): Float32Array {
  const rand = mulberry32(seed * 13 + 5)
  const out = buffer(sr, 1.4)
  strike(out, sr, 0, [[1900, 0.02, 1], [3400, 0.012, 0.5]], 0.35, rand, 0.6)
  strike(out, sr, at(sr, 0.05), [[620, 0.05, 1], [1400, 0.03, 0.5]], 0.5, rand, 1.5)
  burst(out, sr, at(sr, 0.2), { amp: 0.12, decay: 0.03, kind: "bandpass", hz: 2400, q: 1 }, rand)
  // Spent shell: hollow plastic-and-brass tocks as it bounces.
  for (const [t, a] of [[0.46, 0.3], [0.58, 0.16], [0.65, 0.08]] as const) strike(out, sr, at(sr, t + rand() * 0.02), [[1250 + rand() * 120, 0.03, 1], [2900, 0.015, 0.4]], a, rand, 0.8)
  // Fresh shell sliding in.
  burst(out, sr, at(sr, 0.8), { amp: 0.16, decay: 0.05, attack: 0.03, kind: "bandpass", hz: 2800, q: 1.2, to: 1800 }, rand)
  strike(out, sr, at(sr, 0.92), [[880, 0.03, 1], [2100, 0.015, 0.5]], 0.35, rand, 0.8)
  // Snapped shut.
  strike(out, sr, at(sr, 1.12), [[1700, 0.03, 1], [3100, 0.02, 0.6], [540, 0.05, 0.6]], 0.7, rand, 1)
  return finish(out, sr, -20, 80)
}

/** A pistol dry-fired: the trigger's slack, then the striker snapping on nothing. */
export function pistolDry(sr: number, seed: number): Float32Array {
  const rand = mulberry32(seed * 17 + 2)
  const out = buffer(sr, 0.12)
  strike(out, sr, 0, [[2400 + rand() * 200, 0.006, 1], [4100, 0.004, 0.4]], 0.15, rand, 0.4)
  strike(out, sr, at(sr, 0.028 + rand() * 0.008), [[4700 + rand() * 300, 0.012, 1], [7300, 0.007, 0.6], [2900, 0.016, 0.4]], 0.6, rand, 0.25)
  return finish(out, sr, -18, 200, 0.03)
}

/** The pistol drawn: leather of the holster, the hand closing on the grip, a press-check click. */
export function pistolDraw(sr: number, seed: number): Float32Array {
  const rand = mulberry32(seed * 19 + 4)
  const out = buffer(sr, 0.5)
  burst(out, sr, 0, { amp: 0.18, decay: 0.06, attack: 0.05, length: 0.18, kind: "bandpass", hz: 1600, q: 0.9, to: 2600 }, rand)
  burst(out, sr, at(sr, 0.16), { amp: 0.3, decay: 0.012, kind: "bandpass", hz: 900, q: 1 }, rand)
  strike(out, sr, at(sr, 0.3 + rand() * 0.04), [[3300, 0.01, 1], [5600, 0.006, 0.5]], 0.25, rand, 0.4)
  return finish(out, sr, -22, 120)
}

/** Reload parts, timed by `reload.ts` to the reload pose: the release button, the magazine out, in, and the slide released. */
export function pistolReloadPart(sr: number, seed: number, part: "release" | "out" | "in" | "slide"): Float32Array {
  const rand = mulberry32(seed * 23 + part.length)
  const out = buffer(sr, part === "out" ? 0.35 : 0.3)
  // Each part's loudest transient sits at the same lead as the library's (`RELOAD_EVENTS.lead`), so timing is kept.
  if (part === "release") {
    strike(out, sr, at(sr, 0.03), [[3600 + rand() * 300, 0.008, 1], [6200, 0.005, 0.5]], 0.5, rand, 0.3)
  } else if (part === "out") {
    burst(out, sr, at(sr, 0.02), { amp: 0.25, decay: 0.05, attack: 0.04, length: 0.12, kind: "bandpass", hz: 2600, q: 1.4, to: 1700 }, rand)
    strike(out, sr, at(sr, 0.12), [[1500 + rand() * 120, 0.03, 1], [3300, 0.02, 0.5], [760, 0.04, 0.3]], 0.45, rand, 0.8)
  } else if (part === "in") {
    burst(out, sr, at(sr, 0.08), { amp: 0.3, decay: 0.04, attack: 0.05, length: 0.1, kind: "bandpass", hz: 2200, q: 1.3, to: 3000 }, rand)
    strike(out, sr, at(sr, 0.18), [[1250 + rand() * 100, 0.035, 1], [2800, 0.02, 0.7], [520, 0.05, 0.5]], 0.85, rand, 1)
    strike(out, sr, at(sr, 0.195), [[3900, 0.01, 1]], 0.2, rand, 0.3)
  } else {
    strike(out, sr, 0, [[2100, 0.015, 1], [4200, 0.008, 0.5]], 0.25, rand, 0.4)
    strike(out, sr, at(sr, 0.05), [[1800 + rand() * 150, 0.04, 1], [3700, 0.025, 0.7], [880, 0.05, 0.6]], 1, rand, 1.1)
  }
  return finish(out, sr, part === "in" || part === "slide" ? -16 : -20, 150)
}

/** Floors brass and dropped magazines land on, grouped by how they answer. */
export const BRASS_FLOORS = ["hard", "wood", "soft", "metal", "wet", "gravel"] as const
export type BrassFloor = (typeof BRASS_FLOORS)[number]

/** A 9 mm case landing: bright ringing tinks on concrete and tile, duller tocks on boards, one muffled tick on carpet or grass, pings on metal, a plip in a puddle, a rattle on gravel. */
export function brass(sr: number, seed: number, floor: BrassFloor): Float32Array {
  const rand = mulberry32(seed * 29 + floor.length * 3)
  const out = buffer(sr, 0.7)
  const ring = (h: number): [number, number, number][] => [[h, 0.09, 1], [h * 2.76, 0.05, 0.6], [h * 5.4, 0.03, 0.3]]
  const base = 3900 + rand() * 600
  const bounces = floor === "soft" ? 1 : floor === "wet" ? 2 : floor === "gravel" ? 4 : 3
  let t = 0
  let a = 1
  for (let b = 0; b < bounces; b++) {
    const s = at(sr, t)
    if (floor === "hard") strike(out, sr, s, ring(base * (1 + b * 0.02)), 0.5 * a, rand, 0.2)
    else if (floor === "metal") strike(out, sr, s, [[base * 0.7, 0.14, 1], [base * 1.9, 0.08, 0.7], [1100, 0.1, 0.4]], 0.5 * a, rand, 0.25)
    else if (floor === "wood") strike(out, sr, s, [[base * 0.9, 0.025, 0.6], [880 + rand() * 90, 0.03, 1], [1900, 0.02, 0.5]], 0.45 * a, rand, 0.4)
    else if (floor === "soft") burst(out, sr, s, { amp: 0.3, decay: 0.006, kind: "bandpass", hz: 1300, q: 1 }, rand)
    else if (floor === "wet") {
      strike(out, sr, s, ring(base), 0.18 * a, rand, 0.2)
      burst(out, sr, s, { amp: 0.25 * a, decay: 0.01, kind: "bandpass", hz: 1800, q: 2, to: 2600 }, rand)
    } else {
      strike(out, sr, s, ring(base * 0.8), 0.25 * a, rand, 0.2)
      crackle(out, sr, s, 0.05, 900, 0.4 * a, 3000, rand)
    }
    t += 0.06 + rand() * 0.05 + (0.11 - b * 0.03) * (floor === "gravel" ? 0.4 : 1)
    a *= 0.42 + rand() * 0.1
  }
  // Rolling to rest on hard floors: a fine rattle.
  if (floor === "hard" || floor === "metal") crackle(out, sr, at(sr, t), 0.18, 300, 0.05, 5200, rand)
  return finish(out, sr, -24, 300, 0.05)
}

/** An emptied magazine dropping on the floor. */
export function magDrop(sr: number, seed: number, floor: BrassFloor): Float32Array {
  const rand = mulberry32(seed * 31 + floor.length)
  const out = buffer(sr, 0.5)
  if (floor === "soft" || floor === "wet") {
    burst(out, sr, 0, { amp: 0.6, decay: 0.012, kind: "lowpass", hz: 900 }, rand)
    if (floor === "wet") burst(out, sr, 0, { amp: 0.3, decay: 0.03, kind: "bandpass", hz: 1400, q: 1.5, to: 2400 }, rand)
  } else {
    const wood = floor === "wood"
    strike(out, sr, 0, wood ? [[420, 0.04, 1], [980, 0.03, 0.7], [2100, 0.02, 0.5]] : [[1400, 0.06, 1], [2900, 0.04, 0.7], [4600, 0.03, 0.4]], 0.7, rand, 0.8)
    strike(out, sr, at(sr, 0.09 + rand() * 0.03), wood ? [[460, 0.03, 1], [1100, 0.02, 0.5]] : [[1500, 0.04, 1], [3100, 0.03, 0.5]], 0.25, rand, 0.6)
    if (floor === "gravel") crackle(out, sr, 0, 0.12, 700, 0.5, 2600, rand)
  }
  return finish(out, sr, -22, 100)
}

// ---------------------------------------------------------------------------------------------------------------
// Environment tails and far versions
// ---------------------------------------------------------------------------------------------------------------

/** Where a report rings: a room, between houses (slapback), along a street of houses, or open ground. */
export const WEAPON_SPACES = ["room", "alley", "street", "open"] as const
export type WeaponSpace = (typeof WEAPON_SPACES)[number]
/** How big the source is: a handgun's report or a stick of dynamite. */
export type TailSize = "small" | "big"

/**
 * The space answering a report, without the direct sound (the report carries that): in a room, dense early
 * reflections and a boomy short decay; between houses, a fast flutter of slapback off the walls either side; on a
 * street, the houses across the road answering a beat later; in the open, a low rolling decay and a far echo.
 */
export function tail(sr: number, seed: number, space: WeaponSpace, size: TailSize): Float32Array {
  const rand = mulberry32(seed * 37 + space.length * 101 + (size === "big" ? 7 : 0))
  const big = size === "big"
  const src = buffer(sr, big ? 0.12 : 0.04)
  burst(src, sr, 0, big ? { amp: 1, decay: 0.035, kind: "lowpass", hz: 600 } : { amp: 1, decay: 0.006, kind: "bandpass", hz: 1100, q: 0.6 }, rand)
  thump(src, sr, 0, big ? 0.8 : 0.35, big ? 60 : 110, big ? 30 : 50, big ? 0.06 : 0.025)
  const seconds = ({ room: 0.75, alley: 1.3, street: 1.9, open: 2.4 } as const)[space] * (big ? 1.5 : 1)
  const out = buffer(sr, seconds)
  const list: [number, number, number][] = []
  if (space === "room") {
    for (let k = 0; k < 12; k++) list.push([0.003 + rand() * 0.024, (0.7 - k * 0.035) * (0.6 + rand() * 0.4), 5200 - k * 220])
    taps(out, src, sr, list)
    diffuse(out, sr, 0, big ? 0.12 : 0.09, big ? 0.7 : 0.42, 3400, 70, rand, 0.004)
    // The room's boom: its lowest mode rung by the blast.
    const boom = new Mode(sr, 95 + rand() * 50, big ? 0.45 : 0.28, 1)
    const lp = new Biquad(sr, "lowpass", 300, 0.7)
    for (let i = 0; i < out.length; i++) out[i]! += boom.tick(lp.tick(i < src.length ? src[i]! : 0)) * 0.5
  } else if (space === "alley") {
    // Walls 2.5–5 m either side: the report flutters between them, losing top end each bounce.
    const w1 = (2.5 + rand() * 2.5) / 343
    const w2 = (2.5 + rand() * 2.5) / 343
    let d = 0
    for (let k = 1; k <= 16; k++) {
      d += k % 2 ? 2 * w1 : 2 * w2
      list.push([d, 0.82 * Math.pow(0.8, k), Math.max(1100, 6500 * Math.pow(0.86, k))])
    }
    list.push([0.07 + rand() * 0.03, 0.4, 2600])
    taps(out, src, sr, list)
    diffuse(out, sr, 0.01 * sr, 0.05, big ? 1.3 : 0.9, 2600, 90, rand, 0.02)
  } else if (space === "street") {
    // The houses across the road (12–20 m: 70–120 ms), the next ones along, and the block beyond.
    const a = 0.07 + rand() * 0.05
    list.push([a, 0.62, 3200], [a + 0.012, 0.25, 2400], [0.15 + rand() * 0.08, 0.38, 2200], [0.3 + rand() * 0.1, 0.18, 1500], [0.48 + rand() * 0.15, 0.08, 1100])
    taps(out, src, sr, list)
    diffuse(out, sr, at(sr, 0.03), 0.045, big ? 2 : 1.3, 1800, 80, rand, 0.06, 0.35)
  } else {
    // Open ground: the report rolls away low, and something far answers once.
    list.push([0.35 + rand() * 0.2, 0.2, 1100], [0.75 + rand() * 0.3, 0.1, 800])
    taps(out, src, sr, list)
    diffuse(out, sr, at(sr, 0.01), big ? 0.12 : 0.07, big ? 2.6 : 1.8, big ? 520 : 700, 45, rand, 0.05, 0.55)
  }
  return finish(out, sr, big ? -15 : -19, 40, 0.3)
}

/** A pistol shot heard from blocks away: the soundscape's far gunshot (a dull pop and the town answering). */
export function pistolFar(sr: number, seed: number): Float32Array {
  return gunshotFar(sr, 300 + seed * 17, "pistol")
}

/** The flare gun from far off: a soft low pop, no crack. */
export function flareFar(sr: number, seed: number): Float32Array {
  const out = gunshotFar(sr, 400 + seed * 17, "shotgun")
  filter(out, new Biquad(sr, "lowpass", 900, 0.7))
  return normalize(out, sr, -18)
}

/** Dynamite from across town: a deep boom and a long rumbling roll. */
export function blastFar(sr: number, seed: number): Float32Array {
  const rand = mulberry32(seed * 41 + 9)
  const out = buffer(sr, 3.2)
  burst(out, sr, 0, { amp: 1, decay: 0.05, kind: "lowpass", hz: 700, steep: true }, rand)
  thump(out, sr, 0, 0.9, 55, 28, 0.25, 0.008)
  diffuse(out, sr, at(sr, 0.02), 0.25, 2.8, 420, 30, rand, 0.08, 0.6)
  const src = new Float32Array(out.subarray(0, at(sr, 0.15)))
  taps(out, src, sr, [[0.4 + rand() * 0.2, 0.35, 600], [0.9 + rand() * 0.3, 0.2, 450], [1.5 + rand() * 0.3, 0.1, 380]])
  return finish(out, sr, -14, 25, 0.5)
}

// ---------------------------------------------------------------------------------------------------------------
// Explosives and fire
// ---------------------------------------------------------------------------------------------------------------

/** Dynamite close by: the crack, a huge body, the sub thump, and debris pattering down after. */
export function blast(sr: number, seed: number): Float32Array {
  const rand = mulberry32(seed * 43 + 11)
  const out = buffer(sr, 2.2)
  nwave(out, sr, 0, 1, 1.4)
  burst(out, sr, 0, { amp: 0.8, decay: 0.006, kind: "highpass", hz: 1800 }, rand)
  burst(out, sr, 0, { amp: 2.2, decay: 0.09, attack: 0.002, kind: "lowpass", hz: 1600, to: 300 }, rand)
  burst(out, sr, 0, { amp: 1.4, decay: 0.05, kind: "bandpass", hz: 240, q: 0.7 }, rand)
  thump(out, sr, 0, 1.6, 70, 26, 0.32, 0.004)
  // Debris: dirt, splinters and grit raining back down.
  crackle(out, sr, at(sr, 0.25), 1.6, 70, 0.6, 1800, rand)
  crackle(out, sr, at(sr, 0.35), 1.3, 40, 0.5, 700, rand)
  diffuse(out, sr, at(sr, 0.15), 0.06, 1.2, 2200, 300, rand, 0.2)
  saturate(out, 2.6)
  return finish(out, sr, -9, 25, 0.3)
}

/** A firecracker: a tight paper crack with a little body, and a whiff of fizz. */
export function crackerPop(sr: number, seed: number): Float32Array {
  const rand = mulberry32(seed * 47 + 13)
  const out = buffer(sr, 0.28)
  nwave(out, sr, 0, 0.8, 0.3 + rand() * 0.2)
  burst(out, sr, 0, { amp: 0.9, decay: 0.003, kind: "highpass", hz: 3000 }, rand)
  burst(out, sr, 0, { amp: 0.9, decay: 0.012, kind: "bandpass", hz: 1300 + rand() * 600, q: 0.9 }, rand)
  thump(out, sr, 0, 0.25, 180, 90, 0.02)
  crackle(out, sr, at(sr, 0.01), 0.2, 200, 0.12, 5000, rand)
  saturate(out, 1.8)
  return finish(out, sr, -12, 150, 0.05)
}

/** A lit fuse: a sputtering hiss with spits of sparks (a loop). */
export function fuseLoop(sr: number, seed: number): Float32Array {
  const rand = mulberry32(seed * 53 + 17)
  const seconds = 1.6
  const xf = at(sr, 0.15)
  const out = new Float32Array(at(sr, seconds) + xf)
  const bp = new Biquad(sr, "bandpass", 4200, 0.8)
  for (let i = 0; i < out.length; i++) {
    const t = i / sr
    const sput = 0.55 + 0.45 * smoothNoise(t * 22, seed + 3)
    out[i] = bp.tick(white(rand)) * sput * 0.5
  }
  crackle(out, sr, 0, seconds + 0.15, 90, 0.9, 3200, rand, false)
  return loopifyNorm(out, sr, xf, -22)
}

function loopifyNorm(src: Float32Array, sr: number, xf: number, rms: number): Float32Array {
  const n = src.length - xf
  const out = new Float32Array(n)
  out.set(src.subarray(0, n))
  for (let i = 0; i < xf; i++) {
    const u = i / xf
    out[i] = src[i]! * Math.sin(u * Math.PI * 0.5) + src[n + i]! * Math.cos(u * Math.PI * 0.5)
  }
  return normalize(out, sr, rms)
}

/** The flamethrower lighting: the pilot's click, gas hissing on, and the whoomp as it catches. */
export function flamerIgnite(sr: number, seed: number): Float32Array {
  const rand = mulberry32(seed * 59 + 19)
  const out = buffer(sr, 0.9)
  strike(out, sr, 0, [[3100, 0.008, 1], [5300, 0.005, 0.5]], 0.3, rand, 0.3)
  burst(out, sr, at(sr, 0.02), { amp: 0.3, decay: 0.08, attack: 0.05, length: 0.15, kind: "bandpass", hz: 3500, q: 0.9 }, rand)
  const w = at(sr, 0.11)
  burst(out, sr, w, { amp: 1.6, decay: 0.16, attack: 0.03, kind: "lowpass", hz: 380, to: 900 }, rand)
  thump(out, sr, w, 0.6, 70, 35, 0.12, 0.02)
  crackle(out, sr, w, 0.6, 140, 0.4, 2500, rand)
  saturate(out, 1.5)
  return finish(out, sr, -14, 35, 0.15)
}

/** The flamethrower's stream: a roaring turbulent burn over the jet's hiss, crackling (a loop). */
export function flamerLoop(sr: number, seed: number): Float32Array {
  const rand = mulberry32(seed * 61 + 23)
  const seconds = 2.4
  const xf = at(sr, 0.25)
  const out = new Float32Array(at(sr, seconds) + xf)
  const roar = new Biquad(sr, "lowpass", 420, 0.8)
  const roar2 = new Biquad(sr, "lowpass", 420, 0.8)
  const jet = new Biquad(sr, "bandpass", 2600, 0.7)
  for (let i = 0; i < out.length; i++) {
    const t = i / sr
    const turb = 0.6 + 0.4 * smoothNoise(t * 9, seed) + 0.15 * smoothNoise(t * 31, seed + 1)
    out[i] = roar2.tick(roar.tick(white(rand))) * 4.2 * turb + jet.tick(white(rand)) * 0.22
  }
  crackle(out, sr, 0, seconds + 0.25, 110, 0.7, 2100, rand, false)
  return loopifyNorm(out, sr, xf, -17)
}

/** The flamethrower shutting off: the valve clicks and the last of the flame puffs out. */
export function flamerStop(sr: number, seed: number): Float32Array {
  const rand = mulberry32(seed * 67 + 29)
  const out = buffer(sr, 0.6)
  strike(out, sr, 0, [[2600, 0.01, 1], [4500, 0.006, 0.5]], 0.3, rand, 0.4)
  burst(out, sr, 0, { amp: 0.9, decay: 0.12, kind: "lowpass", hz: 700, to: 250 }, rand)
  crackle(out, sr, 0, 0.45, 60, 0.3, 2000, rand)
  return finish(out, sr, -20, 40, 0.1)
}

/** A molotov breaking: the bottle smashing, then the fuel catching in a whump. */
export function molotovSmash(sr: number, seed: number): Float32Array {
  const rand = mulberry32(seed * 71 + 31)
  const out = buffer(sr, 1.3)
  glassShards(out, sr, 0, 0.9, rand)
  const w = at(sr, 0.06 + rand() * 0.02)
  burst(out, sr, w, { amp: 2, decay: 0.2, attack: 0.025, kind: "lowpass", hz: 300, to: 1100 }, rand)
  thump(out, sr, w, 0.7, 65, 32, 0.14, 0.02)
  crackle(out, sr, w, 1, 160, 0.5, 2400, rand)
  saturate(out, 1.6)
  return finish(out, sr, -12, 35, 0.2)
}

/** Something burning on the ground: a crackling, popping fire (a loop). */
export function fireLoop(sr: number, seed: number): Float32Array {
  const rand = mulberry32(seed * 73 + 37)
  const seconds = 3
  const xf = at(sr, 0.3)
  const out = new Float32Array(at(sr, seconds) + xf)
  const lp = new Biquad(sr, "lowpass", 600, 0.7)
  for (let i = 0; i < out.length; i++) {
    const t = i / sr
    out[i] = lp.tick(white(rand)) * (0.6 + 0.4 * smoothNoise(t * 3, seed + 5)) * 1.6
  }
  crackle(out, sr, 0, seconds + 0.3, 50, 1.4, 1900, rand, false)
  crackle(out, sr, 0, seconds + 0.3, 12, 1.8, 900, rand, false)
  return loopifyNorm(out, sr, xf, -21)
}

/** A match-head fuse lit: the scratch and the flare of it. */
export function fuseStrike(sr: number, seed: number): Float32Array {
  const rand = mulberry32(seed * 79 + 41)
  const out = buffer(sr, 0.5)
  burst(out, sr, 0, { amp: 0.6, decay: 0.05, attack: 0.02, length: 0.12, kind: "bandpass", hz: 3000, q: 0.7, to: 5000 }, rand)
  burst(out, sr, at(sr, 0.1), { amp: 0.7, decay: 0.08, attack: 0.01, kind: "lowpass", hz: 1800 }, rand)
  crackle(out, sr, at(sr, 0.1), 0.35, 200, 0.5, 3600, rand)
  return finish(out, sr, -18, 200, 0.08)
}

/** A bear trap set: the jaws pushed open against the spring in ratchet clicks, then the pan latching. */
export function trapSet(sr: number, seed: number): Float32Array {
  const rand = mulberry32(seed * 83 + 43)
  const out = buffer(sr, 0.8)
  for (let k = 0; k < 4; k++) strike(out, sr, at(sr, 0.08 + k * 0.11 + rand() * 0.02), [[2200 + k * 90, 0.02, 1], [3900, 0.012, 0.5], [900, 0.03, 0.3]], 0.35 + k * 0.05, rand, 0.4)
  strike(out, sr, at(sr, 0.58), [[1500, 0.05, 1], [3100, 0.03, 0.6], [640, 0.06, 0.5]], 0.6, rand, 0.8)
  return finish(out, sr, -18, 150)
}

/** A bear trap snapping shut: steel jaws slammed together, the spring twanging, the chain jumping. */
export function trapSnap(sr: number, seed: number): Float32Array {
  const rand = mulberry32(seed * 89 + 47)
  const out = buffer(sr, 0.9)
  nwave(out, sr, 0, 0.5, 0.4)
  strike(out, sr, 0, [[930, 0.22, 1], [2140, 0.15, 0.8], [3870, 0.09, 0.5], [5600, 0.05, 0.3]], 1.4, rand, 0.6)
  // The spring: a low twang with a little vibrato.
  let ph = 0
  for (let i = 0; i < at(sr, 0.5); i++) {
    const t = i / sr
    ph += (TAU * (142 + 6 * Math.sin(TAU * 11 * t))) / sr
    out[i]! += Math.sin(ph) * Math.exp(-t / 0.12) * 0.25 * Math.min(1, t / 0.004)
  }
  crackle(out, sr, at(sr, 0.04), 0.3, 160, 0.4, 3400, rand)
  saturate(out, 1.4)
  return finish(out, sr, -13, 60, 0.1)
}

/** Glass breaking (a molotov's bottle, a pane in a melee miss): the crack and shards scattering. */
function glassShards(out: Float32Array, sr: number, start: number, amp: number, rand: () => number): void {
  nwave(out, sr, start, amp * 0.4, 0.3)
  burst(out, sr, start, { amp: amp * 0.9, decay: 0.03, kind: "highpass", hz: 2500 }, rand)
  const n = 14 + Math.floor(rand() * 8)
  for (let k = 0; k < n; k++) {
    const t = 0.01 + Math.pow(rand(), 1.6) * 0.5
    const h = 2600 + rand() * 4200
    strike(out, sr, start + at(sr, t), [[h, 0.03 + rand() * 0.05, 1], [h * 1.63, 0.02, 0.5]], amp * (0.15 + rand() * 0.2) * (1 - t), rand, 0.2)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Melee
// ---------------------------------------------------------------------------------------------------------------

/** How a melee weapon moves the air: length of the swing, the band it sweeps, and what it adds (a blade's whistle, a pipe's hollow note, a spiked board's flutter). */
export type SwingShape = { seconds: number; lo: number; hi: number; q: number; amp: number; tone?: number; toneQ?: number; toneAmp?: number; flutter?: number; low?: number }

/** A melee swing through the air: cloth snapping as it starts, then the whoosh of the weapon at speed. */
export function swing(sr: number, seed: number, shape: SwingShape): Float32Array {
  const rand = mulberry32(seed * 97 + Math.round(shape.seconds * 1000))
  const out = buffer(sr, shape.seconds + 0.08)
  burst(out, sr, 0, { amp: 0.2, decay: 0.02, attack: 0.01, kind: "bandpass", hz: 2600, q: 0.8 }, rand)
  const j = 0.9 + rand() * 0.2
  whoosh(out, sr, at(sr, 0.015), shape.seconds * j, { amp: shape.amp, lo: shape.lo * j, hi: shape.hi * j, q: shape.q, peakAt: 0.42 + rand() * 0.1, ...(shape.tone ? { tone: shape.tone * j, toneQ: shape.toneQ ?? 10, toneAmp: shape.toneAmp ?? 0.6 } : {}), ...(shape.flutter ? { flutter: shape.flutter } : {}) }, rand)
  // Heavy weapons push air you feel more than hear.
  if (shape.low) whoosh(out, sr, at(sr, 0.02), shape.seconds * j, { amp: shape.low, lo: 120, hi: 320, q: 0.7, peakAt: 0.5 }, rand)
  return finish(out, sr, -18, 90, 0.04)
}

/** What a melee hit layer is: flesh under every hit, then the weapon's own voice and, on hard hits, bone. */
export type MeleeHitLayer = "flesh-light" | "flesh-heavy" | "bone" | "blade" | "chop" | "metal" | "wood" | "spike"

/**
 * One layer of a melee hit on a body: the wet thud of flesh (light or heavy), the crack of bone (heads, kills, heavy
 * swings), and the weapon itself: a blade's slice, an axe's chop, a metal tool's short clank (the long bell is the
 * library's `melee.hit.metal`, kept for heavy and head hits), a bat's hardwood knock, a spiked board's knock and rip.
 */
export function meleeHit(sr: number, seed: number, layer: MeleeHitLayer): Float32Array {
  const rand = mulberry32(seed * 101 + layer.length * 13)
  const out = buffer(sr, 0.45)
  const j = (a: number) => 1 + (rand() * 2 - 1) * a
  if (layer === "flesh-light" || layer === "flesh-heavy") {
    const heavy = layer === "flesh-heavy"
    thump(out, sr, 0, heavy ? 1.1 : 0.8, (heavy ? 120 : 150) * j(0.1), heavy ? 55 : 70, heavy ? 0.07 : 0.05, 0.002)
    burst(out, sr, 0, { amp: heavy ? 1.1 : 0.8, decay: heavy ? 0.03 : 0.02, attack: 0.001, kind: "lowpass", hz: 700 * j(0.15) }, rand)
    burst(out, sr, 0, { amp: 0.4, decay: 0.006, kind: "bandpass", hz: 2400, q: 0.8 }, rand)
    squelch(out, sr, at(sr, 0.008), heavy ? 0.45 : 0.3, heavy ? 0.12 : 0.08, rand)
    return finish(out, sr, -14, 40, 0.04)
  }
  if (layer === "bone") {
    nwave(out, sr, 0, 0.35, 0.25)
    for (let k = 0; k < 5; k++) burst(out, sr, at(sr, k * 0.004 + rand() * 0.003), { amp: 0.7 * (1 - k * 0.15), decay: 0.0025, kind: "bandpass", hz: 2600 + rand() * 2400, q: 1.2 }, rand)
    strike(out, sr, 0, [[380 * j(0.1), 0.03, 1], [960 * j(0.1), 0.018, 0.6]], 0.6, rand, 1)
    return finish(out, sr, -15, 120, 0.03)
  }
  if (layer === "blade" || layer === "chop") {
    const chop = layer === "chop"
    burst(out, sr, 0, { amp: 0.9, decay: 0.025, attack: 0.002, length: 0.06, kind: "highpass", hz: 5500 * j(0.1), to: 1600 }, rand)
    strike(out, sr, 0, [[3200 * j(0.06), 0.07, 1], [5100 * j(0.05), 0.04, 0.5]], 0.12, rand, 0.3)
    squelch(out, sr, at(sr, 0.01), 0.55, 0.1, rand, 1900)
    if (chop) {
      strike(out, sr, at(sr, 0.006), [[190 * j(0.08), 0.05, 1], [430, 0.03, 0.5]], 1.2, rand, 2)
      thump(out, sr, at(sr, 0.006), 0.6, 110, 60, 0.05)
    }
    return finish(out, sr, -15, 60, 0.04)
  }
  if (layer === "metal") {
    // A short, damped clank: the bar is buried in a body, so it cannot ring.
    strike(out, sr, 0, [[640 * j(0.06), 0.08, 1], [1690 * j(0.05), 0.05, 0.7], [2950 * j(0.05), 0.03, 0.45]], 0.9, rand, 0.6)
    return finish(out, sr, -16, 120, 0.05)
  }
  // Hardwood: a dry knock with a crack in it; a spiked board adds the nails tearing out.
  strike(out, sr, 0, [[245 * j(0.08), 0.04, 1], [720 * j(0.08), 0.025, 0.7], [1320 * j(0.06), 0.015, 0.4]], 1.1, rand, 1.4)
  burst(out, sr, 0, { amp: 0.5, decay: 0.004, kind: "bandpass", hz: 3100, q: 1 }, rand)
  if (layer === "spike") {
    burst(out, sr, at(sr, 0.05), { amp: 0.3, decay: 0.04, attack: 0.02, length: 0.1, kind: "bandpass", hz: 2400, q: 1.6, to: 1500 }, rand)
    squelch(out, sr, at(sr, 0.04), 0.35, 0.1, rand, 1300)
  }
  return finish(out, sr, -15, 80, 0.04)
}

/** The weapon's own voice when it hits something hard (a wall, a door, a car): a blade's ting and scrape, a metal tool's clang, a bat's knock. */
export function toolHit(sr: number, seed: number, material: "blade" | "metal" | "wood"): Float32Array {
  const rand = mulberry32(seed * 103 + material.length * 7)
  const out = buffer(sr, 0.6)
  if (material === "blade") {
    strike(out, sr, 0, [[2900 + rand() * 300, 0.18, 1], [4700, 0.1, 0.6], [6900, 0.06, 0.3]], 0.5, rand, 0.3)
    burst(out, sr, at(sr, 0.01), { amp: 0.25, decay: 0.05, attack: 0.01, length: 0.1, kind: "bandpass", hz: 5200, q: 1.2, to: 3000 }, rand)
  } else if (material === "metal") {
    strike(out, sr, 0, [[520 + rand() * 60, 0.3, 1], [1390, 0.2, 0.7], [2480, 0.12, 0.5], [3900, 0.07, 0.3]], 0.8, rand, 0.5)
  } else {
    strike(out, sr, 0, [[310 + rand() * 40, 0.05, 1], [850, 0.03, 0.6], [1600, 0.02, 0.3]], 1, rand, 1.2)
  }
  return finish(out, sr, -17, 120, 0.06)
}

/** Surfaces a swing or a round can strike. */
export const STRIKE_SURFACES = ["wood", "plaster", "concrete", "car", "glass", "dirt", "flesh"] as const
export type StrikeSurface = (typeof STRIKE_SURFACES)[number]

/**
 * A blunt blow on a surface (a melee swing that missed into a wall): a door's hollow thunk and rattle, plaster's
 * thud and crumble, concrete's smack and grit, a car's dented bong, glass cracking, earth thumped.
 */
export function bash(sr: number, seed: number, surface: Exclude<StrikeSurface, "flesh">): Float32Array {
  const rand = mulberry32(seed * 107 + surface.length * 19)
  const out = buffer(sr, 1)
  if (surface === "wood") {
    strike(out, sr, 0, [[112 + rand() * 15, 0.12, 1], [235, 0.08, 0.7], [520, 0.05, 0.5], [1100, 0.025, 0.3]], 1.6, rand, 2)
    crackle(out, sr, at(sr, 0.02), 0.2, 120, 0.25, 1600, rand)
  } else if (surface === "plaster") {
    thump(out, sr, 0, 0.8, 140, 70, 0.04)
    burst(out, sr, 0, { amp: 1, decay: 0.02, kind: "lowpass", hz: 1100 }, rand)
    crackle(out, sr, at(sr, 0.03), 0.5, 160, 0.35, 2800, rand)
  } else if (surface === "concrete") {
    burst(out, sr, 0, { amp: 1.2, decay: 0.008, kind: "bandpass", hz: 1500, q: 0.7 }, rand)
    thump(out, sr, 0, 0.5, 160, 90, 0.025)
    crackle(out, sr, at(sr, 0.01), 0.3, 220, 0.3, 3400, rand)
  } else if (surface === "car") {
    strike(out, sr, 0, [[178 + rand() * 20, 0.35, 1], [412, 0.25, 0.7], [760, 0.15, 0.5], [1330, 0.08, 0.4]], 1.3, rand, 1.5)
    crackle(out, sr, at(sr, 0.01), 0.2, 100, 0.2, 2600, rand)
  } else if (surface === "glass") {
    glassShards(out, sr, 0, 0.9, rand)
  } else {
    thump(out, sr, 0, 0.9, 110, 55, 0.05)
    burst(out, sr, 0, { amp: 0.8, decay: 0.03, kind: "lowpass", hz: 600 }, rand)
    crackle(out, sr, at(sr, 0.02), 0.2, 200, 0.2, 1400, rand)
  }
  return finish(out, sr, -14, 40, 0.1)
}

/**
 * A round striking a surface: a splintering crack in wood, a puff and crumble in plaster, a sharp chip off brick (a
 * ricochet whining off one variant in three), a bright ping and bong off a car, a pane cracking and tinkling, a thup
 * of earth, and the wet slap of flesh.
 */
export function bulletImpact(sr: number, seed: number, surface: StrikeSurface): Float32Array {
  const rand = mulberry32(seed * 109 + surface.length * 23)
  const out = buffer(sr, surface === "glass" ? 0.9 : 0.7)
  if (surface === "wood") {
    nwave(out, sr, 0, 0.4, 0.2)
    strike(out, sr, 0, [[260 + rand() * 40, 0.04, 1], [690, 0.025, 0.6], [1500, 0.012, 0.4]], 1, rand, 0.8)
    crackle(out, sr, 0, 0.12, 900, 0.6, 3000, rand)
  } else if (surface === "plaster") {
    burst(out, sr, 0, { amp: 1.1, decay: 0.012, kind: "bandpass", hz: 900, q: 0.6 }, rand)
    thump(out, sr, 0, 0.5, 180, 90, 0.02)
    crackle(out, sr, at(sr, 0.02), 0.45, 220, 0.3, 3300, rand)
  } else if (surface === "concrete") {
    nwave(out, sr, 0, 0.5, 0.15)
    burst(out, sr, 0, { amp: 1.1, decay: 0.005, kind: "highpass", hz: 1800 }, rand)
    crackle(out, sr, at(sr, 0.005), 0.25, 400, 0.4, 4200, rand)
    if (seed % 3 === 1) {
      // Ricochet: a falling whine as the round tumbles off.
      let ph = 0
      const f0 = 3600 + rand() * 1500
      for (let i = 0; i < at(sr, 0.35); i++) {
        const t = i / sr
        ph += (TAU * f0 * (1 - 0.45 * (t / 0.35))) / sr
        out[i + at(sr, 0.01)]! += Math.sin(ph) * Math.sin(Math.PI * (t / 0.35)) * 0.18
      }
    }
  } else if (surface === "car") {
    nwave(out, sr, 0, 0.4, 0.15)
    strike(out, sr, 0, [[1180 + rand() * 120, 0.22, 1], [2330, 0.15, 0.7], [3720, 0.09, 0.5], [420, 0.18, 0.5]], 0.9, rand, 0.3)
  } else if (surface === "glass") {
    glassShards(out, sr, 0, 0.8, rand)
  } else if (surface === "dirt") {
    thump(out, sr, 0, 0.6, 130, 70, 0.025)
    burst(out, sr, 0, { amp: 0.7, decay: 0.015, kind: "lowpass", hz: 900 }, rand)
    crackle(out, sr, at(sr, 0.01), 0.2, 300, 0.25, 1600, rand)
  } else {
    thump(out, sr, 0, 0.7, 160, 80, 0.03, 0.001)
    burst(out, sr, 0, { amp: 0.8, decay: 0.006, kind: "bandpass", hz: 1600, q: 0.8 }, rand)
    squelch(out, sr, at(sr, 0.004), 0.5, 0.09, rand, 1700)
  }
  return finish(out, sr, -15, 60, 0.06)
}

// ---------------------------------------------------------------------------------------------------------------
// Handling and throwables
// ---------------------------------------------------------------------------------------------------------------

export type DrawKind = "blade" | "blunt" | "heavy" | "flamer" | "flaregun" | "throwable" | "explosive"

/** Taking a weapon in hand: a blade's steel slide, a tool's grip and knock, a heavy weapon hefted two-handed, the flamethrower's tank sloshing. */
export function draw(sr: number, seed: number, kind: DrawKind): Float32Array {
  const rand = mulberry32(seed * 113 + kind.length * 29)
  const out = buffer(sr, 0.6)
  burst(out, sr, 0, { amp: 0.15, decay: 0.05, attack: 0.04, length: 0.14, kind: "bandpass", hz: 1800, q: 0.8 }, rand)
  if (kind === "blade") {
    burst(out, sr, at(sr, 0.06), { amp: 0.35, decay: 0.09, attack: 0.06, length: 0.2, kind: "bandpass", hz: 3600, q: 2, to: 6200 }, rand)
    strike(out, sr, at(sr, 0.25), [[2700 + rand() * 300, 0.2, 1], [4400, 0.12, 0.5]], 0.15, rand, 0.3)
  } else if (kind === "blunt") {
    burst(out, sr, at(sr, 0.1), { amp: 0.4, decay: 0.012, kind: "bandpass", hz: 800, q: 1 }, rand)
    strike(out, sr, at(sr, 0.13), [[1100 + rand() * 100, 0.06, 1], [2600, 0.04, 0.5]], 0.15, rand, 0.4)
  } else if (kind === "heavy") {
    burst(out, sr, 0, { amp: 0.3, decay: 0.12, attack: 0.08, length: 0.3, kind: "bandpass", hz: 900, q: 0.7 }, rand)
    burst(out, sr, at(sr, 0.22), { amp: 0.5, decay: 0.015, kind: "bandpass", hz: 650, q: 1 }, rand)
    thump(out, sr, at(sr, 0.22), 0.25, 140, 80, 0.03)
  } else if (kind === "flamer") {
    // Fuel sloshing in the tank, the hose knocking, the valve cracked.
    for (let k = 0; k < 4; k++) burst(out, sr, at(sr, 0.04 + k * 0.07 + rand() * 0.02), { amp: 0.3, decay: 0.03, kind: "bandpass", hz: 500 + rand() * 300, q: 2.5, to: 900 }, rand)
    strike(out, sr, at(sr, 0.4), [[2300, 0.02, 1], [4000, 0.012, 0.5]], 0.35, rand, 0.4)
  } else if (kind === "flaregun") {
    strike(out, sr, at(sr, 0.15), [[1200 + rand() * 100, 0.03, 1], [2700, 0.02, 0.5]], 0.4, rand, 0.8)
  } else if (kind === "explosive") {
    burst(out, sr, at(sr, 0.05), { amp: 0.3, decay: 0.05, attack: 0.03, kind: "bandpass", hz: 2200, q: 0.9 }, rand)
  } else {
    burst(out, sr, at(sr, 0.12), { amp: 0.25, decay: 0.02, kind: "bandpass", hz: 1100, q: 1 }, rand)
  }
  return finish(out, sr, -22, 120)
}

export type ThrownItem = "baseball" | "brick" | "rock" | "tin-can" | "bottle"

/** A throw leaving the hand: a short whoosh, deeper for a brick. */
export function throwWhoosh(sr: number, seed: number, heavy: boolean): Float32Array {
  return swing(sr, seed + (heavy ? 50 : 0), heavy ? { seconds: 0.26, lo: 300, hi: 900, q: 0.8, amp: 1 } : { seconds: 0.2, lo: 500, hi: 1600, q: 0.9, amp: 0.9 })
}

/** A thrown thing landing: a baseball's leather thud and hop, a brick's crunching clunk, a rock's clack, a tin can clattering and rolling, a bottle's thick knock. */
export function land(sr: number, seed: number, item: ThrownItem): Float32Array {
  const rand = mulberry32(seed * 127 + item.length * 31)
  const out = buffer(sr, 0.9)
  if (item === "baseball") {
    thump(out, sr, 0, 0.8, 190, 110, 0.03)
    burst(out, sr, 0, { amp: 0.6, decay: 0.01, kind: "lowpass", hz: 1400 }, rand)
    thump(out, sr, at(sr, 0.22 + rand() * 0.05), 0.3, 190, 110, 0.025)
  } else if (item === "brick") {
    strike(out, sr, 0, [[420 + rand() * 50, 0.04, 1], [1100, 0.025, 0.5]], 1, rand, 2)
    thump(out, sr, 0, 0.6, 120, 60, 0.05)
    crackle(out, sr, at(sr, 0.01), 0.25, 250, 0.4, 2200, rand)
  } else if (item === "rock") {
    strike(out, sr, 0, [[1350 + rand() * 200, 0.03, 1], [3100, 0.02, 0.6]], 0.8, rand, 0.6)
    for (let k = 0; k < 3; k++) strike(out, sr, at(sr, 0.12 + k * 0.07 + rand() * 0.03), [[1500 + rand() * 300, 0.02, 1]], 0.2 * (1 - k * 0.3), rand, 0.4)
  } else if (item === "tin-can") {
    let t = 0
    for (let k = 0; k < 5; k++) {
      strike(out, sr, at(sr, t), [[1650 + rand() * 300, 0.06, 1], [3300 + rand() * 400, 0.04, 0.7], [5200, 0.03, 0.4]], 0.6 * Math.pow(0.6, k), rand, 0.4)
      t += 0.08 + rand() * 0.07
    }
    crackle(out, sr, at(sr, t), 0.3, 180, 0.12, 2800, rand)
  } else {
    strike(out, sr, 0, [[820 + rand() * 80, 0.06, 1], [2100, 0.04, 0.6], [3900, 0.03, 0.3]], 0.8, rand, 0.8)
  }
  return finish(out, sr, -16, 80, 0.08)
}

/** A thrown thing bonking off a head: a hollow, slightly comic knock. */
export function bonk(sr: number, seed: number): Float32Array {
  const rand = mulberry32(seed * 131 + 3)
  const out = buffer(sr, 0.4)
  strike(out, sr, 0, [[250 + rand() * 30, 0.09, 1], [610 + rand() * 40, 0.05, 0.6], [1350, 0.02, 0.3]], 1.4, rand, 1)
  thump(out, sr, 0, 0.5, 140, 80, 0.04)
  return finish(out, sr, -14, 60, 0.05)
}
