import { DriverVoice } from "@arcade/kit/vehicle/audio/synth"
import { NitroGate } from "@arcade/kit/vehicle/audio/nitro"
import type { VehicleView } from "@arcade/kit/vehicle/types"
import type { VehicleKind } from "../../shared/sim/vehicle"
import type { Sound } from "./sound"

export type EngineSource = { id: number; kind: VehicleKind; dx: number; dy: number; speed: number; thr: number; slip: number; horn: boolean; mine: boolean; handbrake?: boolean }
const FILES = ["horn", "door", "start", "crash-thump-1", "crash-thump-2", "crash-crunch-1", "crash-crunch-3", "crash-heavy-1", "crash-heavy-3"] as const
type Sfx = typeof FILES[number]
type Voice = { id: number; driver: DriverVoice; gain: GainNode; pan: StereoPannerNode; lp: BiquadFilterNode; gate: NitroGate; view: VehicleView }
const roll = (d: number) => 1 / (1 + d * d * 0.012)
const panOf = (dx: number) => Math.max(-0.8, Math.min(0.8, dx / 12))
const pitch = (kind: VehicleKind) => kind === "scooter" ? 1.3 : kind === "van" ? 0.84 : 1

/** Four bounded procedural engine/gearbox/tyre voices, with Blackout's spatial mix.
 * Door, horn, starter and crash recordings retain their existing sources. */
export class VehicleSound {
  enabled = true
  private ctx: AudioContext | null = null
  private master: AudioNode | null = null
  private bufs = new Map<Sfx, AudioBuffer>()
  private voices: Voice[] = []
  private horn: { src: AudioBufferSourceNode | null; gain: GainNode; pan: StereoPannerNode; lp: BiquadFilterNode } | null = null
  private honk = { id: -1, since: 0 }
  private starts = new Map<number, number>()
  private last = 0
  constructor(private sound: Sound) {}

  private setup(): boolean {
    const bus = this.sound.bus()
    if (!bus) return false
    if (this.ctx === bus.ctx) return true
    const { ctx, master } = bus
    this.ctx = ctx; this.master = master; this.voices = []
    for (let i = 0; i < 4; i++) {
      const gain = ctx.createGain(); gain.gain.value = 0
      const pan = ctx.createStereoPanner(), lp = ctx.createBiquadFilter(); lp.type = "lowpass"
      gain.connect(lp).connect(pan).connect(master)
      // Blackout owns the room response; no second reverb is added to the shared voice.
      const verb = ctx.createGain(); verb.gain.value = 0; verb.connect(master)
      const driver = new DriverVoice({ ctx, sfx: gain, verb, get now() { return ctx.currentTime } })
      this.voices.push({ id: -1, driver, gain, pan, lp, gate: new NitroGate(), view: {
        id: -1, vehicle: "jeep", x: 0, z: 0, h: 0, vx: 0, vz: 0, speed: 0, drift: 0, impact: 0, stun: 0, boost: 0,
      } })
    }
    const lp = ctx.createBiquadFilter(), gain = ctx.createGain(), pan = ctx.createStereoPanner()
    lp.type = "lowpass"; gain.gain.value = 0; lp.connect(gain).connect(pan).connect(master)
    this.horn = { src: null, gain, pan, lp }
    for (const name of FILES) void fetch(`${import.meta.env.BASE_URL}sfx/vehicles/${name}.mp3`)
      .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status))))
      .then(b => ctx.decodeAudioData(b)).then(buf => this.bufs.set(name, buf)).catch(() => {})
    return true
  }

  update(sources: readonly EngineSource[]): void {
    if (!this.setup() || !this.ctx) return
    const t = this.ctx.currentTime, dt = Math.min(0.1, Math.max(0.001, t - this.last)); this.last = t
    const dist = (s: EngineSource) => Math.hypot(s.dx, s.dy)
    const near = (this.enabled ? sources : []).filter(s => s.mine || dist(s) < 45)
      .sort((a, b) => a.mine ? -1 : b.mine ? 1 : dist(a) - dist(b)).slice(0, 4)
    const driving = near.some(s => s.mine)
    for (const v of this.voices) if (v.id >= 0 && !near.some(s => s.id === v.id)) {
      v.driver.silence(); v.gain.gain.setTargetAtTime(0, t, 0.08); v.id = -1
    }
    for (const s of near) {
      const v = this.voices.find(v => v.id === s.id) ?? this.voices.find(v => v.id < 0)
      if (!v) continue
      v.id = s.id
      Object.assign(v.view, { id: s.id, vehicle: s.kind, speed: Math.abs(s.speed), drift: s.slip, engineOff: false })
      const braking = s.thr < 0 && s.speed > 0.5
      v.driver.update(v.view, { throttle: braking ? 0 : Math.abs(s.thr), brake: Number(braking), steer: 0, handbrake: !!s.handbrake, boost: false }, dt, "road", v.gate)
      const d = s.mine ? 0 : dist(s), began = this.starts.get(s.id)
      const warm = began === undefined ? 1 : Math.max(0, Math.min(1, (t - began - 0.5) / 0.6))
      v.gain.gain.setTargetAtTime(this.sound.effects * warm * (s.mine ? 1 : 0.9 * roll(d) * (driving ? 0.6 : 1)), t, 0.08)
      v.pan.pan.setTargetAtTime(s.mine ? 0 : panOf(s.dx), t, 0.05)
      v.lp.frequency.setTargetAtTime(Math.max(250, 16000 / (1 + d * 0.12)), t, 0.06)
    }
    for (const [id, at] of this.starts) if (t - at > 2) this.starts.delete(id)
    this.honks(near, t)
  }

  pop(id: number): void { if (this.enabled) this.voices.find(v => v.id === id)?.driver.transients.burst("pop", 0.22) }
  quiet(): void { this.update([]) }

  private honks(near: readonly EngineSource[], t: number): void {
    const horn = this.horn, s = near.find(s => s.horn)
    if (!horn) return
    if (!s) { this.honk.id = -1; horn.gain.gain.setTargetAtTime(0, t, 0.04); return }
    if (this.honk.id !== s.id) this.honk = { id: s.id, since: t }
    if (!horn.src && this.bufs.has("horn")) {
      horn.src = this.ctx!.createBufferSource(); horn.src.buffer = this.bufs.get("horn")!; horn.src.loop = true
      horn.src.connect(horn.lp); horn.src.start()
    }
    const d = s.mine ? 0 : Math.hypot(s.dx, s.dy), held = t - this.honk.since
    const fade = held < 1.2 ? 1 : Math.max(0, 1 - (held - 1.2) / 0.4)
    horn.src?.playbackRate.setTargetAtTime(pitch(s.kind), t, 0.01)
    horn.lp.frequency.setTargetAtTime(Math.max(800, 6000 / (1 + d * 0.05)), t, 0.03)
    horn.gain.gain.setTargetAtTime(0.16 * this.sound.effects * fade / (1 + d * d * 0.006), t, 0.015)
    horn.pan.pan.setTargetAtTime(s.mine ? 0 : panOf(s.dx), t, 0.03)
  }

  private play(name: Sfx, dx: number, dy: number, gain: number, rate = 1, delay = 0): void {
    if (!this.setup() || !this.ctx || !this.master) return
    const buf = this.bufs.get(name)
    if (!buf) return
    const ctx = this.ctx, d = Math.hypot(dx, dy), s = ctx.createBufferSource()
    s.buffer = buf; s.playbackRate.value = rate
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = Math.min(18000, 20000 / (1 + d * 0.12))
    const g = ctx.createGain(); g.gain.value = (gain * this.sound.effects) / (1 + d * d * 0.01)
    const pan = ctx.createStereoPanner(); pan.pan.value = Math.max(-0.85, Math.min(0.85, dx / 12))
    s.connect(lp).connect(g).connect(pan).connect(this.master)
    s.start(ctx.currentTime + delay)
    s.onended = () => { s.disconnect(); lp.disconnect(); g.disconnect(); pan.disconnect() }
  }
  crash(dx: number, dy: number, speed: number): void {
    const k = Math.max(0, Math.min(1, speed / 14)), rate = () => 0.92 + Math.random() * 0.16
    this.play(Math.random() < 0.5 ? "crash-thump-1" : "crash-thump-2", dx, dy, 0.3 + 0.5 * k, rate())
    if (speed > 5) this.play(Math.random() < 0.5 ? "crash-crunch-1" : "crash-crunch-3", dx, dy, 0.2 + 0.5 * k, rate(), 0.01)
    if (speed > 10) this.play(Math.random() < 0.5 ? "crash-heavy-1" : "crash-heavy-3", dx, dy, 0.35 + 0.4 * k, rate(), 0.015)
  }
  door(dx: number, dy: number, kind: VehicleKind): void {
    this.play("door", dx, dy, kind === "scooter" ? 0.3 : 0.5, (kind === "scooter" ? 1.5 : kind === "van" ? 0.9 : 1) * (0.95 + Math.random() * 0.1))
  }
  start(id: number, dx: number, dy: number, kind: VehicleKind): void {
    if (!this.bufs.has("start") || !this.ctx) return
    this.starts.set(id, this.ctx.currentTime)
    this.play("start", dx, dy, 0.32 * (kind === "scooter" ? 0.8 : kind === "van" ? 1.05 : 1), kind === "scooter" ? 1.3 : kind === "van" ? 0.88 : 1, 0.1)
  }
}
