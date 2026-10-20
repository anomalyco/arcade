// Offline listening reel and loudness check for the soundscape (AR-86). Never plays audio: it renders a walk through
// Elm (seed 7) at three in the morning on night 1 and out along the street in the last of a drizzle into a WAV, with
// the soundscape's real seeded output, the game's beds and footsteps, the runtime's spatial model, wall occlusion and
// reverb, then measures loudness per stem.
//
//   bun scripts/soundscape-reel.ts [--out <dir>] [--seconds 92] [--t0 <sim seconds>] [--night 1] [--hour 2.94] [--rain 0.42]
//
// Writes reel.wav (+ reel.m4a when ffmpeg is present), stems (scape / beds / steps) and loudness.json.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { $ } from "bun"
import { AudioRuntime, busVolume, sfxEntry, type SourcePose } from "@arcade/kit/audio"
import { integratedLufs, momentaryMaxLufs } from "../../../packages/kit/audio/sfx-analysis"
import { fftRadix2 } from "../../../packages/kit/audio/offline"
import { decode } from "../../../scripts/sfx/decode"
import { CoopSim } from "../shared/coop-sim"
import { dayCycle } from "../shared/day-cycle"
import { AUDIO_BUS_LEVELS, DEFAULT_AUDIO_SETTINGS } from "../src/audio/settings"
import { footstepEvent, indoors, SoundOcclusion } from "../src/audio/space"
import { scapeSound, SCAPE_LAYER_GROUP, SCAPE_LAYERS, SCAPE_SAMPLE_RATE } from "../src/audio/soundscape/catalog"
import { ScapeDirector, nightOf, type ScapeInput } from "../src/audio/soundscape/director"
import { scapeLevels } from "../src/audio/soundscape/soundscape"
import type { ScapeLevels } from "../src/audio/soundscape/director"

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1]! : fallback
}
const OUT = arg("out", join(process.env.TMPDIR ?? "/tmp", "opencode", "soundscape-reel"))
const SECONDS = Number(arg("seconds", "92"))
const NIGHT = Number(arg("night", "1"))
const SR = 48000
const BLOCK = 400
const N = SECONDS * SR
const settings = { ...DEFAULT_AUDIO_SETTINGS }

type Stem = "scape" | "beds" | "steps"
type Voice = {
  stem: Stem
  buf: Float32Array
  srcRate: number
  pos: number
  rate: number
  loop: boolean
  gain: number
  gainTarget: number
  pan: number
  panTarget: number
  cutoff: number
  wet: number
  bus: number
  start: number
  lp1: number
  lp2: number
  key?: string
  stamp: number
  alive: boolean
}

// --- World ---------------------------------------------------------------------------------------------------------
const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
sim.addSurvivor("reel", 0)
sim.syncWorldChunks()
const town = sim.town
// Doors open so the walk can pass (closed doors would also count as walls for occlusion).
for (const d of town.doors) if (d.id.startsWith("elm")) d.open = true
const occlusion = new SoundOcclusion()
occlusion.sync(town, 1)
const rt = new AudioRuntime({ visibilityQuery: occlusion.query })

// The walk (plan metres; y is world z): Elm's bedroom, the hall, the living room phone, the kitchen, out of the front
// door, east along the yard and north up the avenue past the abandoned sedan to the crossroads.
const PATH: [t: number, x: number, y: number][] = [
  [0, 25.2, 57.2],
  [7, 25.6, 57.6],
  [10, 26.7, 59.0],
  [12, 26.7, 60.6],
  [15.5, 23.8, 60.8],
  [26, 23.6, 61.0],
  [31, 30.5, 62.4],
  [34, 33.6, 61.9],
  [39, 33.6, 61.9],
  [43, 27.6, 64.6],
  [45, 26.7, 66.4],
  [49, 27.6, 67.6],
  [58, 40.5, 67.8],
  [66, 44.2, 61.0],
  [72, 44.2, 57.0],
  [80, 44.0, 47.0],
  [92, 43.6, 43.4],
]
function at(t: number): { x: number; y: number; speed: number } {
  for (let i = 1; i < PATH.length; i++) {
    const [t1, x1, y1] = PATH[i]!
    const [t0, x0, y0] = PATH[i - 1]!
    if (t <= t1) {
      const u = (t - t0) / Math.max(1e-6, t1 - t0)
      const dist = Math.hypot(x1 - x0, y1 - y0)
      return { x: x0 + (x1 - x0) * u, y: y0 + (y1 - y0) * u, speed: dist / Math.max(1e-6, t1 - t0) }
    }
  }
  const [, x, y] = PATH[PATH.length - 1]!
  return { x, y, speed: 0 }
}

// 02:59:30 on night `NIGHT`; the clock runs a game hour every two real minutes. A drizzle eases off over the walk.
const START_HOUR = Number(arg("hour", String(3 - 30 / 3600 - 6 / 120)))
const hourAt = (t: number) => START_HOUR + t / 120
const absAt = (t: number) => 24 * (NIGHT - 1) + 24 + hourAt(t)
const RAIN = Number(arg("rain", "0.42"))
const rainAt = (t: number) => (t < 60 ? RAIN : Math.max(0, RAIN * (1 - (t - 60) / 18)))
const wetAt = (t: number) => Math.min(0.75, 0.55 + t / 400)

// --- Samples -------------------------------------------------------------------------------------------------------
const library = new Map<string, Float32Array[]>()
async function lib(id: string): Promise<Float32Array[]> {
  const have = library.get(id)
  if (have) return have
  const entry = sfxEntry(id)
  const out: Float32Array[] = []
  for (let v = 1; v <= entry.variants; v++) {
    const ch = await decode(join(import.meta.dir, "../../../packages/kit/audio/sfx", `${id}.${v}.ogg`), 1)
    out.push(ch[0]!)
  }
  library.set(id, out)
  return out
}
const baked = new Map<string, Float32Array>()
const bake = (id: string) => {
  let b = baked.get(id)
  if (!b) baked.set(id, (b = scapeSound(id)!.bake(SCAPE_SAMPLE_RATE)))
  return b
}

// --- Mixer ---------------------------------------------------------------------------------------------------------
const busGain = (bus: keyof typeof AUDIO_BUS_LEVELS) => ((settings[AUDIO_BUS_LEVELS[bus]] as number) / 100) * busVolume(settings, bus)
const AMBIENCE = busGain("ambience")
const FOLEY = busGain("foley")
const MASTER = settings.volumeMaster / 100

function render(stems: ReadonlySet<Stem>, t0: number, beds: Record<string, Float32Array>, only?: "interior" | "exterior" | "distant"): { L: Float32Array; R: Float32Array; counts: Record<string, number>; events: string[] } {
  const L = new Float32Array(N)
  const R = new Float32Array(N)
  const sendL = new Float32Array(N)
  const sendR = new Float32Array(N)
  const space = new Float32Array(Math.ceil(N / BLOCK))
  const voices: Voice[] = []
  const held = new Map<string, Voice>()
  const director = new ScapeDirector()
  const levels = scapeLevels(settings, {} as ScapeLevels)
  if (only) for (const layer of SCAPE_LAYERS) if (SCAPE_LAYER_GROUP[layer] !== only) levels[layer] = 0
  const events: string[] = []
  let indoor = indoors(town, PATH[0]![1], PATH[0]![2]) ? 1 : 0
  let stepClock = 0
  let stepSide = 0
  let stamp = 0
  const bedLevel: Record<string, number> = {}
  const startVoice = (v: Omit<Voice, "pos" | "lp1" | "lp2" | "stamp" | "alive">): Voice => {
    const voice: Voice = { ...v, pos: 0, lp1: 0, lp2: 0, stamp, alive: true }
    voices.push(voice)
    return voice
  }
  const input: ScapeInput = { town, time: 0, dt: BLOCK / SR, hour: 0, absHour: 0, listener: { x: 0, y: 0 }, survivors: [], rain: 0, wetness: 0, storm: 0, glass: [], indoor: 0 }
  for (let b = 0; b * BLOCK < N; b++) {
    const t = (b * BLOCK) / SR
    const dt = BLOCK / SR
    stamp++
    const me = at(t)
    rt.setListener({ x: me.x, z: me.y, vx: 0, vz: 0, rightX: 1, rightZ: 0, earHeight: 1.7, panScale: 12 })
    indoor += ((indoors(town, me.x, me.y) ? 1 : 0) - indoor) * Math.min(1, dt * 4)
    space[b] = indoor
    const hour = hourAt(t)
    // Beds, as OutbreakAudio.ambience and WeatherAudio.update do it.
    if (stems.has("beds")) {
      const day = dayCycle(hour)
      const muffle = 1 - indoor * 0.68
      const rain = rainAt(t)
      const sm = (a: number, c: number, v: number) => {
        const u = Math.max(0, Math.min(1, (v - a) / (c - a)))
        return u * u * (3 - 2 * u)
      }
      const wanted: Record<string, [number, number]> = {
        "ambience.night.suburb": [(1 - day.sun) * muffle, 14000 * Math.pow(750 / 14000, indoor)],
        "ambience.day.suburb": [day.sun * muffle, 14000 * Math.pow(750 / 14000, indoor)],
        "ambience.threat": [Math.min(1, day.threat * 0.4 + indoor * 0.14) * (0.55 + 0.45 * muffle), 2600 * Math.pow(420 / 2600, indoor)],
        "ambience.rain.light": [sm(0.02, 0.35, rain) * (1 - 0.55 * sm(0.55, 1, rain)) * (1 - indoor * 0.78), 14000 * Math.pow(800 / 14000, indoor)],
        "ambience.rain.roof": [sm(0.05, 0.6, rain) * indoor, 3200],
      }
      for (const [id, [g, cut]] of Object.entries(wanted)) {
        bedLevel[id] = (bedLevel[id] ?? g) + (g - (bedLevel[id] ?? g)) * Math.min(1, dt * (id.includes("rain") ? 1.2 : 1.5))
        let v = held.get(`bed:${id}`)
        if (!v) {
          v = startVoice({ stem: "beds", buf: beds[id]!, srcRate: SR, rate: 1, loop: true, gain: 0, gainTarget: 0, pan: 0, panTarget: 0, cutoff: cut, wet: 0, bus: AMBIENCE, start: b * BLOCK })
          v.pos = (id.length * 7919) % beds[id]!.length
          held.set(`bed:${id}`, v)
        }
        v.gainTarget = bedLevel[id]! * sfxEntry(id).gain
        v.cutoff = cut
        v.stamp = stamp
      }
    }
    // Footsteps on the real surfaces.
    if (stems.has("steps") && me.speed > 0.3) {
      stepClock += dt * (me.speed / 0.78)
      if (stepClock >= 1) {
        stepClock -= 1
        stepSide ^= 1
        const step = footstepEvent(town, me.x + (stepSide ? 0.12 : -0.12), me.y, me.speed * 2.1, { local: true })
        if (step) {
          const vars = library.get(step.event.id)
          if (vars) {
            const buf = vars[(b * 7 + stepSide) % vars.length]!
            const mix = rt.spatialize({ x: me.x, z: me.y, refDistance: sfxEntry(step.event.id).range.ref * 0.78, maxDistance: sfxEntry(step.event.id).range.max, rolloff: 1.55 })
            startVoice({ stem: "steps", buf, srcRate: SR, rate: step.event.rate ?? 1, loop: false, gain: (step.event.gain ?? 1) * sfxEntry(step.event.id).gain * mix.gain, gainTarget: -1, pan: mix.pan, panTarget: mix.pan, cutoff: Math.min(step.event.cutoffHz ?? 18000, mix.cutoffHz), wet: Math.min(0.85, (sfxEntry(step.event.id).wet ?? 0.1) + mix.wet * 0.65), bus: FOLEY, start: b * BLOCK })
          }
        }
      }
    }
    // The soundscape.
    input.time = t0 + t
    input.dt = dt
    input.hour = hour
    input.absHour = absAt(t)
    input.listener = me
    input.survivors = [me]
    input.rain = rainAt(t)
    input.wetness = wetAt(t)
    input.indoor = indoor
    director.step(input, levels)
    if (stems.has("scape")) {
      for (let i = 0; i < director.shotCount; i++) {
        const s = director.shots[i]!
        const def = scapeSound(s.id)!
        const pose: SourcePose = { x: s.x, z: s.y, refDistance: def.range.ref, maxDistance: def.range.max, rolloff: 1.55 }
        const mix = s.far ? { gain: 1, pan: s.pan, cutoffHz: s.cutoffHz, wet: 0.08 } : rt.spatialize(pose)
        const gain = def.gain * s.gain * mix.gain
        if (gain < 0.0005) continue
        events.push(`${t.toFixed(1)}s ${s.id}${s.far ? " (far)" : ` @${Math.hypot(s.x - me.x, s.y - me.y).toFixed(1)}m`} gain ${gain.toFixed(3)}`)
        startVoice({ stem: "scape", buf: bake(s.id), srcRate: SCAPE_SAMPLE_RATE, rate: s.rate, loop: false, gain, gainTarget: -1, pan: mix.pan, panTarget: mix.pan, cutoff: Math.min(s.cutoffHz, mix.cutoffHz), wet: Math.min(0.85, (def.wet ?? 0.15) + mix.wet * 0.65), bus: AMBIENCE, start: b * BLOCK + Math.round(s.delay * SR) })
      }
      // Loops: the best few by score, as Soundscape.holds keeps them.
      const order = director.holds.slice(0, director.holdCount).sort((a, c) => c.score - a.score).slice(0, settings.audioScapeVoices)
      for (const h of order) {
        const def = scapeSound(h.id)!
        const mix = h.far ? { gain: 1, pan: h.pan, cutoffHz: h.cutoffHz, wet: 0.08 } : rt.spatialize({ x: h.x, z: h.y, refDistance: def.range.ref, maxDistance: def.range.max, rolloff: 1.55 })
        let v = held.get(h.key)
        if (!v) {
          v = startVoice({ stem: "scape", buf: bake(h.id), srcRate: SCAPE_SAMPLE_RATE, rate: h.rate, loop: true, gain: 0, gainTarget: 0, pan: mix.pan, panTarget: mix.pan, cutoff: mix.cutoffHz, wet: Math.min(0.85, (def.wet ?? 0.15) + mix.wet * 0.65), bus: AMBIENCE, start: b * BLOCK, key: h.key })
          held.set(h.key, v)
          events.push(`${t.toFixed(1)}s loop ${h.id} (${h.key})`)
        }
        v.gainTarget = def.gain * h.gain * mix.gain
        v.panTarget = mix.pan
        v.cutoff = Math.min(h.cutoffHz, mix.cutoffHz)
        v.rate = h.rate
        v.stamp = stamp
      }
    }
    for (const [key, v] of held) {
      if (v.stamp !== stamp) {
        v.gainTarget = 0
        if (v.gain < 0.0004) {
          v.alive = false
          held.delete(key)
        }
      }
    }
    // Render this block.
    const s0 = b * BLOCK
    const s1 = Math.min(N, s0 + BLOCK)
    for (const v of voices) {
      if (!v.alive) continue
      // 24 kHz bakes are linearly resampled here, so keep their images above 11 kHz out (Web Audio resamples cleanly).
      const a = 1 - Math.exp((-2 * Math.PI * Math.min(v.cutoff, v.srcRate < SR ? 11000 : 20000)) / SR)
      const step = (v.rate * v.srcRate) / SR
      for (let i = Math.max(s0, v.start); i < s1; i++) {
        if (v.gainTarget >= 0) v.gain += (v.gainTarget - v.gain) * 0.0008
        v.pan += (v.panTarget - v.pan) * 0.001
        const p = v.pos
        const k = Math.floor(p)
        if (k + 1 >= v.buf.length) {
          if (!v.loop) {
            v.alive = false
            break
          }
          v.pos -= v.buf.length - 1
          continue
        }
        const x = v.buf[k]! + (v.buf[k + 1]! - v.buf[k]!) * (p - k)
        v.pos += step
        v.lp1 += (x - v.lp1) * a
        v.lp2 += (v.lp1 - v.lp2) * a
        const y = v.lp2 * v.gain
        const gl = Math.cos(((v.pan + 1) * Math.PI) / 4)
        const gr = Math.sin(((v.pan + 1) * Math.PI) / 4)
        L[i]! += y * gl * v.bus
        R[i]! += y * gr * v.bus
        sendL[i]! += y * gl * v.wet
        sendR[i]! += y * gr * v.wet
      }
    }
    for (let i = voices.length - 1; i >= 0; i--) if (!voices[i]!.alive) voices.splice(i, 1)
  }
  // Street and room reverb (the runtime's impulses, Web Audio's convolver normalisation), crossfaded by `space`.
  const street = impulse(1.65, 1234567, true)
  const room = impulse(0.55, 7654321, false)
  const [sl, sr] = [convolve(sendL, street[0]!), convolve(sendR, street[1]!)]
  const [rl, rr] = [convolve(sendL, room[0]!), convolve(sendR, room[1]!)]
  for (let i = 0; i < N; i++) {
    const sp = space[Math.floor(i / BLOCK)]!
    const ws = settings.audioReverb * Math.cos((sp * Math.PI) / 2)
    const wr = settings.audioReverb * Math.sin((sp * Math.PI) / 2)
    L[i] = (L[i]! + sl[i]! * ws + rl[i]! * wr) * MASTER * 0.66
    R[i] = (R[i]! + sr[i]! * ws + rr[i]! * wr) * MASTER * 0.66
  }
  return { L, R, counts: { ...director.counts }, events }
}

function impulse(seconds: number, seed0: number, streetIr: boolean): Float32Array[] {
  const n = Math.floor(SR * seconds)
  let seed = seed0
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff - 0.5
  }
  const out: Float32Array[] = []
  for (let c = 0; c < 2; c++) {
    const d = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const t = i / SR
      d[i] = streetIr ? rnd() * Math.exp(-t * 3.6) * (t < 0.012 ? t / 0.012 : 1) : rnd() * Math.exp(-t * (6.9 / seconds)) * (t < 0.003 ? t / 0.003 : 1)
    }
    const taps = streetIr
      ? [[0.043 + c * 0.007, 0.5], [0.091 - c * 0.005, 0.32], [0.137 + c * 0.011, 0.2]]
      : [[0.007 + c * 0.002, 0.7], [0.013 - c * 0.001, 0.5], [0.021 + c * 0.003, 0.35], [0.029, 0.25]]
    for (const [tap, g] of taps) {
      const k = Math.floor(tap! * SR)
      const len = streetIr ? 160 : 48
      for (let i = 0; i < len && k + i < n; i++) d[k + i]! += rnd() * g! * (1 - i / len)
    }
    let lp = 0
    for (let i = 0; i < n; i++) {
      lp += (d[i]! - lp) * (streetIr ? 0.5 * Math.exp((-i / n) * 2.5) : 0.85 - 0.6 * (i / n))
      d[i] = lp
    }
    out.push(d)
  }
  let power = 0
  for (const d of out) for (const v of d) power += v * v
  const scale = (1 / Math.sqrt(power / (2 * n))) * 0.00125 * (44100 / SR)
  for (const d of out) for (let i = 0; i < n; i++) d[i]! *= scale
  return out
}

/** Overlap-add FFT convolution. */
function convolve(x: Float32Array, h: Float32Array): Float32Array {
  let size = 1
  while (size < h.length * 2) size <<= 1
  const block = size - h.length
  const hr = new Float32Array(size)
  const hi = new Float32Array(size)
  hr.set(h)
  fftRadix2(hr, hi)
  const y = new Float32Array(x.length + h.length)
  const re = new Float32Array(size)
  const im = new Float32Array(size)
  for (let s = 0; s < x.length; s += block) {
    re.fill(0)
    im.fill(0)
    re.set(x.subarray(s, Math.min(x.length, s + block)))
    fftRadix2(re, im)
    for (let k = 0; k < size; k++) {
      const a = re[k]! * hr[k]! - im[k]! * hi[k]!
      const c = re[k]! * hi[k]! + im[k]! * hr[k]!
      re[k] = a
      im[k] = -c
    }
    fftRadix2(re, im)
    for (let k = 0; k < size && s + k < y.length; k++) y[s + k]! += re[k]! / size
  }
  return y.subarray(0, x.length)
}

function wav(path: string, L: Float32Array, R: Float32Array): void {
  const n = L.length
  const buf = Buffer.alloc(44 + n * 4)
  buf.write("RIFF", 0)
  buf.writeUInt32LE(36 + n * 4, 4)
  buf.write("WAVEfmt ", 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(SR, 24)
  buf.writeUInt32LE(SR * 4, 28)
  buf.writeUInt16LE(4, 32)
  buf.writeUInt16LE(16, 34)
  buf.write("data", 36)
  buf.writeUInt32LE(n * 4, 40)
  for (let i = 0; i < n; i++) {
    // The runtime's -3 dBFS limiter, as a soft knee.
    const lim = (v: number) => (Math.abs(v) < 0.6 ? v : Math.sign(v) * (0.6 + 0.108 * Math.tanh((Math.abs(v) - 0.6) / 0.108)))
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, lim(L[i]!))) * 32767), 44 + i * 4)
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, lim(R[i]!))) * 32767), 46 + i * 4)
  }
  writeFileSync(path, buf)
}

/** A start on the shared clock whose seeded distance has a siren and gunfire during the street half of the walk. */
function findStart(): number {
  const forced = process.argv.indexOf("--t0")
  if (forced >= 0) return Number(process.argv[forced + 1])
  const levels = scapeLevels(settings, {} as ScapeLevels)
  for (let t0 = 3000; t0 < 9000; t0 += 7) {
    const d = new ScapeDirector()
    let siren = 0
    let gun = 0
    let early = 0
    for (let t = 0; t < SECONDS; t += 0.25) {
      const me = at(t)
      d.step({ town, time: t0 + t, dt: 0.25, hour: hourAt(t), absHour: absAt(t), listener: me, survivors: [me], rain: rainAt(t), wetness: wetAt(t), storm: 0, glass: [], indoor: 0 }, levels)
      for (let i = 0; i < d.holdCount; i++) if (d.holds[i]!.id === "scape.siren" && t > 46) siren++
      for (let i = 0; i < d.shotCount; i++) {
        const id = d.shots[i]!.id
        if (id.startsWith("scape.gunshot") && t > 50) gun++
        if (id.startsWith("scape.gunshot") && t < 30) early++
      }
    }
    if ((siren > 40 && gun > 0 && early > 0) || NIGHT > 3) return t0
  }
  return 4000
}

mkdirSync(OUT, { recursive: true })
for (const id of ["foot.wood.walk", "foot.concrete.walk", "foot.grass.walk", "foot.gravel.walk", "foot.tile.walk", "foot.puddle.walk"]) await lib(id).catch(() => [])
const beds: Record<string, Float32Array> = {}
for (const id of ["ambience.night.suburb", "ambience.day.suburb", "ambience.threat", "ambience.rain.light", "ambience.rain.roof"]) beds[id] = (await lib(id))[0]!
const t0 = findStart()
console.log(`t0 ${t0}, night ${nightOf(absAt(0))}, ${SECONDS}s`)
const report: Record<string, unknown> = { t0, night: nightOf(absAt(0)), seconds: SECONDS }
for (const [name, stems, only] of [
  ["reel", new Set<Stem>(["scape", "beds", "steps"]), undefined],
  ["scape", new Set<Stem>(["scape"]), undefined],
  ["beds", new Set<Stem>(["beds"]), undefined],
  ["steps", new Set<Stem>(["steps"]), undefined],
  ["interior", new Set<Stem>(["scape"]), "interior"],
  ["exterior", new Set<Stem>(["scape"]), "exterior"],
  ["distant", new Set<Stem>(["scape"]), "distant"],
] as const) {
  const r0 = performance.now()
  const out = render(stems, t0, beds, only)
  wav(join(OUT, `${name}.wav`), out.L, out.R)
  const lufs = integratedLufs([out.L, out.R])
  const mom = momentaryMaxLufs([out.L, out.R])
  let peak = 0
  for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(out.L[i]!), Math.abs(out.R[i]!))
  report[name] = { integratedLufs: Number(lufs.toFixed(1)), momentaryMaxLufs: Number(mom.toFixed(1)), peakDb: Number((20 * Math.log10(peak)).toFixed(1)) }
  console.log(`${name.padEnd(6)} I ${lufs.toFixed(1)} LUFS  M max ${mom.toFixed(1)}  peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS  (${((performance.now() - r0) / 1000).toFixed(1)}s)`)
  if (name === "reel") {
    report.counts = out.counts
    report.events = out.events
    writeFileSync(join(OUT, "events.txt"), out.events.join("\n"))
  }
}
writeFileSync(join(OUT, "loudness.json"), JSON.stringify(report, null, 2))
try {
  await $`ffmpeg -v error -y -i ${join(OUT, "reel.wav")} -c:a aac -b:a 192k ${join(OUT, "reel.m4a")}`
} catch {
  /* WAV only. */
}
console.log(`wrote ${OUT}`)
