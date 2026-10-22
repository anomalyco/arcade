import { SFX_BY_ID } from "@arcade/kit/audio/library"
import type { ThunderEvent } from "./storm"
import { SHELTER, sheltered } from "./shelter"

/**
 * The storm's sound: positional rain beds (asphalt hiss, car roof, booth roof, gutters, the lobby's muffled rain on
 * glass), wind gusts in step with the trees, edge drips and puddle plops, and thunder delayed by distance / 343 m/s
 * with building echoes and a glass rattle for close strikes. Samples come from the shared library (ElevenLabs sound
 * generation, Anomaly's commercial licence; `packages/kit/audio/library.ts`), fetched the first time weather is on.
 * Everything runs into one weather bus with a limiter, inside the walking sound's master (volume, mute, focus).
 */
export const STORM_SOUNDS = [
  "weather.thunder.close", "weather.thunder.mid", "weather.thunder.far", "weather.thunder.sky",
  "weather.rain.asphalt", "weather.rain.car", "weather.rain.hut", "weather.rain.glass", "weather.gutter",
  "weather.wind.moan", "weather.wind.gust", "weather.fence.rattle", "weather.glass.rattle", "weather.drip",
] as const
export type StormSound = (typeof STORM_SOUNDS)[number]

type Sample = { buffer: AudioBuffer; gain: number; loop?: readonly [number, number] }
export type StormBank = Map<StormSound, Sample[]>

export async function loadStormBank(ctx: BaseAudioContext, base = `${import.meta.env.BASE_URL}audio-assets/sfx/`): Promise<StormBank> {
  const bank: StormBank = new Map()
  await Promise.all(STORM_SOUNDS.map(async id => {
    const entry = SFX_BY_ID.get(id)
    if (!entry) throw Error(`Storm sound ${id} is not in the library`)
    const list = await Promise.all(entry.files.map(async f => {
      const r = await fetch(base + f.file)
      if (!r.ok) throw Error(`${f.file}: ${r.status}`)
      const buffer = await ctx.decodeAudioData(await r.arrayBuffer())
      return { buffer, gain: f.gain * entry.gain, ...(f.loopEnd ? { loop: [f.loopStart ?? 0, f.loopEnd] as const } : {}) }
    }))
    bank.set(id, list)
  }))
  return bank
}

export type StormAudioFrame = {
  /** Weather is on (not Today). Turning it off cuts thunder still on its way. */
  on: boolean
  /** Weather fade 0..1 (Today = 0) and rain intensity 0..1. */
  amount: number
  rain: number
  /** 1 only in Storm: the wind moans round the building. */
  storm: number
  wind: number
  gust: number
  /** Wind heading (rad, 0 = +x). */
  heading: number
  /** Storm clock (s) the thunder arrivals are on. */
  clock: number
  thunder: readonly ThunderEvent[]
  rainVolume: number
  thunderVolume: number
  windVolume: number
}

export type StormListener = { x: number; z: number; yaw: number; inside: boolean; time: number }

/** Places with their own sound. */
export const STORM_PLACES = {
  car: [-8.2, 137.8] as const,
  booth: [9, 127.5] as const,
  boothRoof: SHELTER.booth,
  canopy: SHELTER.canopy,
  downpipes: [[-6.8, 22.3], [6.8, 22.3], [10.95, 129.15]] as const,
  fence: { z: 122, x0: -80, x1: 82 },
  facadeZ: 22,
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
function hash(n: number) { let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); return ((h ^ (h >>> 16)) >>> 0) / 4294967296 }

type Bed = { id: StormSound; gain: GainNode; pan: StereoPannerNode; source: AudioBufferSourceNode; base: number }

export class StormAudio {
  private bus: GainNode
  private outdoor: GainNode
  private muffle: BiquadFilterNode
  private limiter: DynamicsCompressorNode
  private beds: Bed[] = []
  private pipes: Bed[] = []
  private scheduled = new Set<number>()
  private voices = new Set<AudioScheduledSourceNode>()
  private serial = 0
  private dripAt = 0
  private plopAt = 0
  private gustReady = 0
  private lastGust = 1
  private brown: AudioBuffer
  private echoes: { send: GainNode; delay: DelayNode; pan: StereoPannerNode; extra: number }[] = []
  private wasOn = false
  /** Thunder from a strike asked for in Today keeps the bus open this long (ctx time). */
  private looseUntil = 0

  constructor(private ctx: BaseAudioContext, destination: AudioNode, private bank: StormBank) {
    this.limiter = ctx.createDynamicsCompressor()
    this.limiter.threshold.value = -10; this.limiter.knee.value = 0; this.limiter.ratio.value = 20
    this.limiter.attack.value = 0.002; this.limiter.release.value = 0.25
    this.bus = ctx.createGain(); this.bus.gain.value = 0.9
    this.bus.connect(this.limiter); this.limiter.connect(destination)
    // Everything outdoors goes through one filter that closes when you step inside.
    this.muffle = ctx.createBiquadFilter(); this.muffle.type = "lowpass"; this.muffle.frequency.value = 18000; this.muffle.Q.value = 0.5
    this.outdoor = ctx.createGain(); this.outdoor.connect(this.muffle); this.muffle.connect(this.bus)
    for (const id of ["weather.rain.asphalt", "weather.rain.car", "weather.rain.hut", "weather.wind.moan"] as const) this.beds.push(this.bed(id, this.outdoor))
    this.beds.push(this.bed("weather.rain.glass", this.bus))
    for (let i = 0; i < STORM_PLACES.downpipes.length; i++) this.pipes.push(this.bed("weather.gutter", this.outdoor, i * 3.7))
    // Two persistent facade echoes (the path there and back, then a second bounce), duller and from the building's side.
    for (const [extra, level] of [[0, 0.26], [0.26, 0.13]] as const) {
      const send = ctx.createGain(), delay = ctx.createDelay(4), f = ctx.createBiquadFilter(), g = ctx.createGain(), pan = ctx.createStereoPanner()
      f.type = "lowpass"; f.frequency.value = 2400; g.gain.value = level; delay.delayTime.value = 0.5
      send.connect(delay); delay.connect(f); f.connect(g); g.connect(pan); pan.connect(this.outdoor)
      this.echoes.push({ send, delay, pan, extra })
    }
    // Brown noise for the synthesized thunder roll under the samples (Wings' rolling envelope).
    const n = ctx.sampleRate * 6, b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0)
    let last = 0, s = 0x2545f491
    for (let i = 0; i < n; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; last = (last + 0.02 * ((s >>> 0) / 4294967296 * 2 - 1)) / 1.02; d[i] = last * 3.5 }
    this.brown = b
  }

  private sample(id: StormSound, pick = 0) { const list = this.bank.get(id)!; return list[pick % list.length]! }

  private bed(id: StormSound, out: AudioNode, offset = 0): Bed {
    const s = this.sample(id), source = this.ctx.createBufferSource(), gain = this.ctx.createGain(), pan = this.ctx.createStereoPanner()
    source.buffer = s.buffer; source.loop = true
    if (s.loop) { source.loopStart = s.loop[0]; source.loopEnd = s.loop[1] }
    gain.gain.value = 0
    source.connect(gain); gain.connect(pan); pan.connect(out)
    source.start(0, ((s.loop?.[0] ?? 0) + offset) % s.buffer.duration)
    return { id, gain, pan, source, base: s.gain }
  }

  private place(l: StormListener, x: number, z: number, ref: number) {
    const dx = x - l.x, dz = z - l.z, d = Math.hypot(dx, dz)
    return { gain: 1 / (1 + (d / ref) ** 2), pan: clamp((dx * Math.cos(l.yaw) - dz * Math.sin(l.yaw)) / Math.max(d, 1), -0.85, 0.85), d }
  }

  private shot(id: StormSound, at: number, gain: number, pan: number, opts: { pick?: number; rate?: number; lowpass?: number; out?: AudioNode } = {}) {
    const s = this.sample(id, opts.pick ?? this.serial++), src = this.ctx.createBufferSource(), g = this.ctx.createGain(), p = this.ctx.createStereoPanner()
    src.buffer = s.buffer; src.playbackRate.value = opts.rate ?? 1
    g.gain.value = gain * s.gain; p.pan.value = clamp(pan, -1, 1)
    let head: AudioNode = src, f: BiquadFilterNode | null = null
    if (opts.lowpass) { f = this.ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = opts.lowpass; f.Q.value = 0.5; src.connect(f); head = f }
    head.connect(g); g.connect(p); p.connect(opts.out ?? this.outdoor)
    this.voices.add(src)
    // Disconnecting from an echo send leaves what is already in its delay line to drain (DelayNode tail time).
    src.onended = () => { this.voices.delete(src); src.disconnect(); f?.disconnect(); g.disconnect(); p.disconnect() }
    src.start(Math.max(this.ctx.currentTime, at))
    return { src, g, p }
  }

  /** `play` false (muted, focus or pointer lock lost, context suspended): beds follow, nothing new is scheduled. */
  update(f: StormAudioFrame, l: StormListener, now: number, play: boolean) {
    const tau = 0.25, inside = l.inside ? 1 : 0
    if (this.wasOn && !f.on) this.interrupt()
    this.wasOn = f.on
    this.bus.gain.setTargetAtTime(0.9 * Math.max(f.amount, now < this.looseUntil ? 1 : 0), now, 0.3)
    this.muffle.frequency.setTargetAtTime(l.inside ? 650 : 18000, now, 0.35)
    this.outdoor.gain.setTargetAtTime(l.inside ? 0.4 : 1, now, 0.35)
    const rain = f.rain * f.amount * f.rainVolume
    const set = (b: Bed, gain: number, pan: number) => { b.gain.gain.setTargetAtTime(gain * b.base, now, tau); b.pan.pan.setTargetAtTime(pan, now, 0.1) }
    // Open-lot hiss: under the booth roof or inside it drops away.
    // A quiet bed: the near surfaces (car, booth roof, gutters, drips) carry the detail over it.
    const underRoof = sheltered(l.x, l.z, SHELTER.booth), underCanopy = sheltered(l.x, l.z, SHELTER.canopy)
    set(this.beds[0]!, rain * 0.5 * (underRoof || underCanopy ? 0.55 : 1), 0)
    const car = this.place(l, STORM_PLACES.car[0], STORM_PLACES.car[1], 2.2)
    set(this.beds[1]!, rain * 1.1 * car.gain, car.pan)
    const booth = this.place(l, STORM_PLACES.booth[0], STORM_PLACES.booth[1], 2.6)
    set(this.beds[2]!, rain * 1.2 * Math.max(booth.gain, underRoof ? 1 : 0), underRoof ? 0 : booth.pan)
    const facade = Math.max(0, l.z - STORM_PLACES.facadeZ)
    set(this.beds[3]!, f.storm * f.amount * f.wind * f.windVolume * (0.35 + 0.35 * clamp(f.gust - 0.6, 0, 1.4)) * (0.45 + 0.55 / (1 + (facade / 45) ** 2)), -0.3 * Math.cos(f.heading + l.yaw))
    set(this.beds[4]!, rain * 0.6 * inside, 0)
    this.pipes.forEach((b, i) => { const p = STORM_PLACES.downpipes[i]!, q = this.place(l, p[0], p[1], 1.6); set(b, rain * 0.9 * q.gain, q.pan) })
    const gustRose = f.gust > 1.25 && this.lastGust <= 1.25
    this.lastGust = f.gust
    for (const t of f.thunder) {
      if (this.scheduled.has(t.id)) continue
      const delay = t.arrives - f.clock
      // Thunder that arrived while silent is gone; thunder still on its way waits until sound is back.
      if (delay < -0.5) { this.scheduled.add(t.id); continue }
      if (!play) continue
      this.scheduled.add(t.id)
      const at = now + Math.max(0, delay)
      if (!f.on) this.looseUntil = Math.max(this.looseUntil, at + 14)
      this.thunder(t, at, l, f.thunderVolume)
    }
    if (!play || f.amount < 0.01) return

    // Edge drips: off the booth roof and the canopy when you are near them; puddle plops anywhere outdoors.
    if (l.time >= this.dripAt && rain > 0.02) {
      const edge = nearestEdge(l)
      if (edge.d < 4) {
        const k = this.serial++
        const q = this.place(l, edge.x, edge.z, 1.2)
        this.shot("weather.drip", now + 0.02, rain * 0.9 * q.gain * (0.6 + 0.4 * hash(k)), q.pan, { pick: k, rate: 0.85 + 0.3 * hash(k * 7) })
      }
      this.dripAt = l.time + (0.18 + 0.5 * hash(this.serial * 13)) / Math.max(0.3, rain)
    }
    if (!l.inside && l.time >= this.plopAt && rain > 0.02) {
      const k = this.serial++
      this.shot("weather.drip", now + 0.01, rain * 0.16 * (0.4 + 0.6 * hash(k)), hash(k * 3) * 1.6 - 0.8, { pick: k, rate: 0.7 + 0.5 * hash(k * 5), lowpass: 5000 })
      this.plopAt = l.time + (0.25 + 0.6 * hash(k * 11)) / Math.max(0.3, rain)
    }
    // A gust rising through 1.25 rushes through the pines, and rattles the gate fence if it is close.
    const windLevel = f.wind * f.windVolume * f.amount
    if (windLevel > 0.05 && gustRose && l.time >= this.gustReady) {
      const k = this.serial++
      this.shot("weather.wind.gust", now, windLevel * clamp(f.gust - 0.6, 0.3, 1.4), -0.5 * Math.cos(f.heading + l.yaw), { pick: k, rate: 0.9 + 0.2 * hash(k) })
      const fz = STORM_PLACES.fence, fx = clamp(l.x, fz.x0, fz.x1), q = this.place(l, fx, fz.z, 6)
      if (q.d < 30) this.shot("weather.fence.rattle", now + 0.35 + 0.3 * hash(k * 3), windLevel * 0.9 * q.gain, q.pan, { pick: k + 1 })
      this.gustReady = l.time + 4
    }
  }

  private thunder(t: ThunderEvent, at: number, l: StormListener, volume: number) {
    const near = t.kind === "ground" && t.distance < 450, mid = t.kind === "ground" && !near && t.distance < 1800
    const id: StormSound = t.kind === "cloud" ? "weather.thunder.sky" : near ? "weather.thunder.close" : mid ? "weather.thunder.mid" : "weather.thunder.far"
    // Air absorbs the top end with distance: a crack up close, a dull roll far off.
    const lowpass = near ? 16000 : mid ? clamp(9000 - t.distance * 3.5, 2200, 9000) : t.kind === "cloud" ? 3200 : 900
    const level = volume * t.power * (near ? 1 : mid ? 0.85 : t.kind === "cloud" ? 0.8 : 0.6)
    // Bearing is clockwise from the view at yaw 0, and the view's own bearing is -yaw.
    const pan = 0.7 * Math.sin(t.bearing + l.yaw)
    const pick = Math.floor(hash(t.id * 977) * 16)
    // Thunder is outdoors: inside the lobby it comes through the same muffle as the rain.
    const main = this.shot(id, at, level, pan, { pick, lowpass, rate: 0.96 + 0.08 * hash(t.id) })
    // Rolling echoes off the facility's face, through the two persistent chains.
    if (!l.inside && t.kind === "ground" && t.distance < 2500) {
      const back = Math.max(8, l.z - STORM_PLACES.facadeZ) * 2 / 343
      for (const e of this.echoes) {
        e.delay.delayTime.setValueAtTime(Math.min(3.9, back + e.extra), Math.max(this.ctx.currentTime, at))
        e.pan.pan.setValueAtTime(clamp(Math.sin(l.yaw) * 0.6, -0.8, 0.8), Math.max(this.ctx.currentTime, at))
        main.g.connect(e.send)
      }
    }
    this.roll(t, at, level, pan)
    if (t.kind === "ground" && t.distance < 700) {
      // The pane you are behind rattles in the room with you; outdoors it is one more thing out there.
      const k = 1 - t.distance / 700
      this.shot("weather.glass.rattle", at + 0.06, volume * k * (l.inside ? 1.1 : 0.6), l.inside ? 0 : pan * 0.5, { pick: pick + 1, out: l.inside ? this.bus : this.outdoor })
    }
  }

  /** Wings' thunder model under the sample: lowpassed brown noise with a few random rolls, longer when far. */
  private roll(t: ThunderEvent, at: number, level: number, pan: number) {
    const d = t.distance, len = 3 + 3 * Math.min(1, d / 4000) + 2 * hash(t.id * 5)
    const curve = new Float32Array(96), attack = 0.08 + 0.4 * Math.min(1, d / 5000)
    const rolls = Array.from({ length: 3 + Math.floor(hash(t.id * 9) * 4) }, (_, i) => [hash(t.id * 31 + i) * 0.7 * len + 0.1 * len, 0.3 + 0.5 * hash(t.id * 37 + i), 0.4 + 0.6 * hash(t.id * 41 + i)] as const)
    for (let i = 0; i < curve.length; i++) {
      const x = i / (curve.length - 1) * len
      let v = Math.min(1, x / attack) ** 2 * Math.exp(-x / (len * 0.35))
      for (const [c, w, a] of rolls) v += a * 0.7 * Math.exp(-((x - c) ** 2) / (2 * w * w)) * Math.exp(-x / len)
      curve[i] = v * Math.min(1, (1 - i / (curve.length - 1)) / 0.15) * level * 0.22
    }
    const src = this.ctx.createBufferSource(), a = this.ctx.createBiquadFilter(), b = this.ctx.createBiquadFilter(), g = this.ctx.createGain(), p = this.ctx.createStereoPanner()
    src.buffer = this.brown; src.loop = true
    a.type = b.type = "lowpass"; a.frequency.value = b.frequency.value = clamp(300 - d / 40, 90, 300)
    g.gain.value = 0; g.gain.setValueCurveAtTime(curve, Math.max(this.ctx.currentTime, at), len)
    p.pan.value = pan
    src.connect(a); a.connect(b); b.connect(g); g.connect(p); p.connect(this.outdoor)
    this.voices.add(src)
    src.onended = () => { this.voices.delete(src); src.disconnect(); a.disconnect(); b.disconnect(); g.disconnect(); p.disconnect() }
    src.start(Math.max(this.ctx.currentTime, at), hash(t.id) * 4); src.stop(Math.max(this.ctx.currentTime, at) + len + 0.1)
  }

  interrupt() {
    for (const v of this.voices) { try { v.stop() } catch { /* already stopped */ } }
    this.voices.clear()
  }
}

function nearestEdge(l: StormListener) {
  let best = { d: Infinity, x: 0, z: 0 }
  const [x0, z0, x1, z1] = STORM_PLACES.boothRoof
  const [cx0, , cx1, cz1] = STORM_PLACES.canopy
  const segs = [[x0, z0, x1, z0], [x1, z0, x1, z1], [x1, z1, x0, z1], [x0, z1, x0, z0], [cx0, cz1, cx1, cz1]] as const
  for (const [ax, az, bx, bz] of segs) {
    const vx = bx - ax, vz = bz - az, t = clamp(((l.x - ax) * vx + (l.z - az) * vz) / (vx * vx + vz * vz), 0, 1)
    const x = ax + vx * t, z = az + vz * t, d = Math.hypot(l.x - x, l.z - z)
    if (d < best.d) best = { d, x, z }
  }
  return best
}
