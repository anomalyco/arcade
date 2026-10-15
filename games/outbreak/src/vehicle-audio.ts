import { sfxEntry, type CueRecipe, type VoiceHandle } from "@arcade/kit/audio"
import { TYRE_SURFACE } from "@arcade/kit/vehicle/emissions"
import { NitroGate } from "@arcade/kit/vehicle/audio/nitro"
import { DriverVoice } from "@arcade/kit/vehicle/audio/synth"
import type { VehicleView as KitVehicleView } from "@arcade/kit/vehicle/types"
import { forwardSpeed, lateralSpeed, speedOf, type OutbreakVehicle } from "../shared/vehicles"
import type { OutbreakAudio } from "./audio"

export const VEHICLE_CUES: readonly CueRecipe[] = [
  {
    id: "vehicle.door.open",
    label: "Car door opens",
    category: "foley",
    masterGain: 0.72,
    wet: 0.12,
    cooldownSeconds: 0.08,
    maxVoices: 3,
    pitchVariation: 0.04,
    gainVariation: 0.08,
    layers: [
      {
        kind: "synth",
        waveform: "modal-bar",
        frequency: 980,
        cutoffHz: 3200,
        envelope: { attack: 0.002, decay: 0.06, peak: 0.48 },
      },
      {
        kind: "synth",
        waveform: "sine",
        frequency: 145,
        glideToHz: 68,
        glideSeconds: 0.12,
        envelope: { offset: 0.03, attack: 0.004, decay: 0.14, peak: 0.55 },
      },
    ],
  },
  {
    id: "vehicle.door.close",
    label: "Car door closes",
    category: "foley",
    masterGain: 0.78,
    wet: 0.14,
    cooldownSeconds: 0.08,
    maxVoices: 3,
    pitchVariation: 0.04,
    gainVariation: 0.08,
    layers: [
      {
        kind: "synth",
        waveform: "sine",
        frequency: 128,
        glideToHz: 42,
        glideSeconds: 0.14,
        envelope: { attack: 0.002, decay: 0.18, peak: 0.75 },
      },
      {
        kind: "synth",
        waveform: "modal-bar",
        frequency: 760,
        cutoffHz: 2600,
        envelope: { offset: 0.015, attack: 0.001, decay: 0.07, peak: 0.38 },
      },
    ],
  },
  {
    id: "vehicle.starter",
    label: "Starter motor & ignition",
    category: "engine",
    masterGain: 0.74,
    wet: 0.1,
    cooldownSeconds: 0.25,
    maxVoices: 2,
    pitchVariation: 0.03,
    layers: [
      {
        kind: "synth",
        waveform: "harmonic-swarm",
        frequency: 110,
        glideToHz: 185,
        glideSeconds: 0.24,
        cutoffHz: 1400,
        envelope: { attack: 0.01, hold: 0.08, decay: 0.22, peak: 0.52 },
      },
      {
        kind: "synth",
        waveform: "sine",
        frequency: 72,
        glideToHz: 135,
        glideSeconds: 0.28,
        envelope: { offset: 0.12, attack: 0.015, decay: 0.26, peak: 0.62 },
      },
    ],
  },
  {
    id: "vehicle.sputter",
    label: "Dead battery / dry crank click",
    category: "foley",
    masterGain: 0.68,
    wet: 0.08,
    cooldownSeconds: 0.25,
    maxVoices: 2,
    pitchVariation: 0.05,
    layers: [
      {
        kind: "synth",
        waveform: "modal-bar",
        frequency: 1320,
        cutoffHz: 3600,
        envelope: { attack: 0.001, decay: 0.045, peak: 0.55 },
      },
      {
        kind: "synth",
        waveform: "modal-bar",
        frequency: 1180,
        cutoffHz: 3100,
        envelope: { offset: 0.09, attack: 0.001, decay: 0.05, peak: 0.48 },
      },
    ],
  },
  {
    id: "vehicle.horn",
    label: "Car horn",
    category: "engine",
    masterGain: 0.76,
    wet: 0.22,
    cooldownSeconds: 0.18,
    maxVoices: 2,
    steal: "replace",
    layers: [
      {
        kind: "synth",
        waveform: "harmonic-swarm",
        frequency: 415,
        detuneCents: 6,
        cutoffHz: 2400,
        envelope: { attack: 0.008, hold: 0.16, decay: 0.12, peak: 0.46 },
      },
      {
        kind: "synth",
        waveform: "harmonic-swarm",
        frequency: 512,
        detuneCents: 6,
        cutoffHz: 2600,
        envelope: { attack: 0.008, hold: 0.16, decay: 0.12, peak: 0.42 },
      },
    ],
  },
  {
    id: "vehicle.crash",
    label: "Vehicle crash impact",
    category: "impact",
    masterGain: 0.85,
    wet: 0.2,
    cooldownSeconds: 0.12,
    maxVoices: 4,
    pitchVariation: 0.08,
    gainVariation: 0.1,
    layers: [
      {
        kind: "synth",
        waveform: "sine",
        frequency: 118,
        glideToHz: 32,
        glideSeconds: 0.2,
        envelope: { attack: 0.002, decay: 0.28, peak: 0.8 },
      },
      {
        kind: "synth",
        waveform: "modal-bar",
        frequency: 890,
        cutoffHz: 3800,
        envelope: { offset: 0.01, attack: 0.002, decay: 0.24, peak: 0.52 },
      },
      {
        kind: "synth",
        waveform: "noise",
        frequency: 1600,
        filterType: "bandpass",
        cutoffHz: 1600,
        q: 1.8,
        envelope: { offset: 0.005, attack: 0.003, decay: 0.22, peak: 0.48 },
      },
    ],
  },
  {
    id: "vehicle.bang",
    label: "Zombie bangs on car body",
    category: "impact",
    masterGain: 0.78,
    wet: 0.16,
    cooldownSeconds: 0.15,
    maxVoices: 3,
    pitchVariation: 0.07,
    gainVariation: 0.12,
    layers: [
      {
        kind: "synth",
        waveform: "sine",
        frequency: 105,
        glideToHz: 38,
        glideSeconds: 0.14,
        envelope: { attack: 0.002, decay: 0.18, peak: 0.72 },
      },
      {
        kind: "synth",
        waveform: "modal-bar",
        frequency: 620,
        cutoffHz: 2200,
        envelope: { offset: 0.008, attack: 0.002, decay: 0.12, peak: 0.36 },
      },
    ],
  },
]

type VoiceSlot = {
  id: number
  driver: DriverVoice
  gain: GainNode
  pan: StereoPannerNode
  lp: BiquadFilterNode
  gate: NitroGate
  view: KitVehicleView
}

type VehicleSnapMemory = {
  occupiedCount: number
  engineOn: boolean
  horn: boolean
  bangCount: number
  lastCrashAt: number
  lastSputterAt: number
}

/** One car's tyres this frame, from the same per-wheel slip that lays its marks and smoke. */
export type TyreAudio = { slip: number; slipSpeed: number; surface: number }

/**
 * Screech loudness 0–1 and playback rate from slip: rubber on a dry road squeals, a wet road hisses lower,
 * dirt only scrubs (no squeal). `slipSpeed` lets a burnout scream at a standstill.
 */
export function tyreScreech(t: TyreAudio): { level: number; rate: number } {
  const move = Math.min(1, t.slipSpeed / 6)
  const k = Math.max(0, Math.min(1, (t.slip - 0.12) / 0.55)) * move
  const surface = t.surface === TYRE_SURFACE.road ? 1 : t.surface === TYRE_SURFACE.wet ? 0.45 : 0
  return { level: k * surface, rate: (t.surface === TYRE_SURFACE.wet ? 0.82 : 0.94) + 0.12 * k }
}

const rollOff = (d: number) => 1 / (1 + d * d * 0.012)
const panOf = (dx: number) => Math.max(-0.85, Math.min(0.85, dx / 12))

/**
 * Outbreak vehicle audio adapter:
 * - Wires `@arcade/kit/vehicle/audio/synth` (`DriverVoice`: procedural cylinder harmonics, `Gearbox` shifts, tyre squeal & scrub)
 *   into `OutbreakAudio.runtime`
 * - Diffs vehicle state transitions for doors, starter, sputter, horn, crash, and zombie banging cues
 */
export class OutbreakVehicleAudio {
  private ctx: BaseAudioContext | null = null
  private voices: VoiceSlot[] = []
  private memory = new Map<number, VehicleSnapMemory>()
  private hornCooldown = new Map<number, number>()
  private started = false
  private readonly screeches = new Map<number, { voice: VoiceHandle | null; level: number; chirpAt: number }>()
  readonly counts = {
    /** Local car's screech level this frame (0–1), its peak, frames above 0.05 and chirps, computed muted too. */
    screech: 0,
    screechPeak: 0,
    screechFrames: 0,
    chirps: 0,
    activeEngines: 0,
    rpm: 0,
    gear: 0,
    doors: 0,
    starts: 0,
    sputters: 0,
    horns: 0,
    crashes: 0,
    bangs: 0,
  }

  constructor(private readonly audio: OutbreakAudio) {
    this.audio.runtime.registerCues(VEHICLE_CUES)
    this.audio.runtime.onInterrupt(() => this.silence())
  }

  private ensureGraph(): boolean {
    const rt = this.audio.runtime
    if (!rt.ctx || !rt.buses) return false
    if (this.ctx === rt.ctx && this.voices.length > 0) return true
    const ctx = rt.ctx
    this.ctx = ctx
    this.voices = []
    for (let i = 0; i < 4; i++) {
      const gain = ctx.createGain()
      gain.gain.value = 0
      const pan = ctx.createStereoPanner()
      const lp = ctx.createBiquadFilter()
      lp.type = "lowpass"
      lp.frequency.value = 16000
      gain.connect(lp).connect(pan).connect(rt.buses.engine)
      const driver = new DriverVoice({
        ctx,
        sfx: gain,
        verb: rt.verb,
        get now() {
          return rt.now
        },
      })
      this.voices.push({
        id: -1,
        driver,
        gain,
        pan,
        lp,
        gate: new NitroGate(),
        view: {
          id: -1,
          vehicle: "sedan",
          x: 0,
          z: 0,
          h: 0,
          vx: 0,
          vz: 0,
          speed: 0,
          drift: 0,
          impact: 0,
          stun: 0,
          boost: 0,
        },
      })
    }
    return true
  }

  private playCue(id: string, x: number, y: number, gain = 1, maxDistance = 36): void {
    if (!this.audio.live) return
    this.audio.runtime.playCue(id, {
      gain,
      position: { x, z: y, refDistance: 2.5, maxDistance, rolloff: 1.35 },
    })
  }

  update(
    dt: number,
    time: number,
    vehicles: readonly OutbreakVehicle[],
    listener: { x: number; y: number },
    localVehicleId: number | null | undefined,
    tyres?: (id: number) => TyreAudio | undefined,
  ): void {
    if (tyres) this.tyres(vehicles, listener, localVehicleId, tyres, time)
    const seen = new Set<number>()
    for (const v of vehicles) {
      seen.add(v.id)
      const occupiedCount = v.seats.filter(Boolean).length
      const prev = this.memory.get(v.id)
      this.memory.set(v.id, {
        occupiedCount,
        engineOn: v.engineOn,
        horn: v.horn,
        bangCount: v.bangCount,
        lastCrashAt: v.lastCrashAt,
        lastSputterAt: v.lastSputterAt,
      })
      if (!this.started || !prev) continue

      if (occupiedCount > prev.occupiedCount) {
        this.counts.doors++
        this.playCue("vehicle.door.open", v.x, v.y, 0.85, 18)
      } else if (occupiedCount < prev.occupiedCount) {
        this.counts.doors++
        this.playCue("vehicle.door.close", v.x, v.y, 0.9, 18)
      }
      if (v.engineOn && !prev.engineOn) {
        this.counts.starts++
        this.playCue("vehicle.starter", v.x, v.y, 0.9, 24)
      }
      if (v.lastSputterAt > prev.lastSputterAt + 1e-3) {
        this.counts.sputters++
        this.playCue("vehicle.sputter", v.x, v.y, 0.85, 16)
      }
      if (v.lastCrashAt > prev.lastCrashAt + 1e-3) {
        this.counts.crashes++
        const k = Math.max(0.35, Math.min(1.4, v.lastCrashImpact / 12))
        this.playCue("vehicle.crash", v.x, v.y, k, 50)
      }
      if (v.bangCount > prev.bangCount) {
        this.counts.bangs++
        this.playCue("vehicle.bang", v.x, v.y, 0.9, 28)
      }
      if (v.horn && (!prev.horn || time - (this.hornCooldown.get(v.id) ?? -Infinity) >= 0.24)) {
        this.hornCooldown.set(v.id, time)
        this.counts.horns++
        this.playCue("vehicle.horn", v.x, v.y, 0.95, 55)
      }
    }
    for (const id of [...this.memory.keys()]) {
      if (!seen.has(id)) this.memory.delete(id)
    }
    this.started = true

    // Update continuous drivetrain synth (`DriverVoice`)
    const running = vehicles
      .filter((v) => v.engineOn && !v.wreck && (v.id === localVehicleId || Math.hypot(v.x - listener.x, v.y - listener.y) < 48))
      .sort((a, b) =>
        a.id === localVehicleId
          ? -1
          : b.id === localVehicleId
            ? 1
            : Math.hypot(a.x - listener.x, a.y - listener.y) - Math.hypot(b.x - listener.x, b.y - listener.y),
      )
      .slice(0, 4)

    this.counts.activeEngines = running.length
    if (running.length === 0) {
      this.counts.rpm = 0
      this.counts.gear = 0
    }

    if (!this.audio.live || !this.ensureGraph() || !this.ctx) {
      if (this.voices.length > 0) this.silence()
      // Still compute deterministic RPM/gear telemetry for the primary running vehicle even when muted
      const primary = running[0]
      if (primary) {
        const spd = speedOf(primary)
        this.counts.gear = Math.min(4, Math.floor(spd / 3.8))
        this.counts.rpm = Math.round(740 + spd * 240 + Math.abs(primary.drive.throttle) * 1100)
      }
      return
    }

    const t = this.audio.runtime.now
    for (const slot of this.voices) {
      if (slot.id >= 0 && !running.some((r) => r.id === slot.id)) {
        slot.driver.silence()
        slot.gain.gain.setTargetAtTime(0, t, 0.08)
        slot.id = -1
      }
    }

    for (const v of running) {
      const slot = this.voices.find((s) => s.id === v.id) ?? this.voices.find((s) => s.id < 0)
      if (!slot) continue
      slot.id = v.id
      const vf = forwardSpeed(v)
      const spd = speedOf(v)
      const slip = Math.abs(lateralSpeed(v))
      const braking = v.drive.throttle < 0 && vf > 0.5
      Object.assign(slot.view, {
        id: v.id,
        vehicle: v.kind,
        x: v.x,
        z: v.y,
        speed: spd,
        // With tyre data the sampled screech carries the squeal; the synth keeps engine, gears and launch chirps.
        drift: tyres ? 0 : slip,
        engineOff: false,
      })
      slot.driver.update(
        slot.view,
        {
          throttle: braking ? 0 : Math.abs(v.drive.throttle),
          brake: braking ? 1 : 0,
          steer: v.drive.steer,
          handbrake: tyres ? false : v.drive.handbrake,
          boost: false,
        },
        Math.min(0.1, Math.max(0.001, dt)),
        "road",
        slot.gate,
      )
      const isMine = v.id === localVehicleId
      const dx = v.x - listener.x
      const dy = v.y - listener.y
      const dist = isMine ? 0 : Math.hypot(dx, dy)
      slot.gain.gain.setTargetAtTime(isMine ? 0.95 : 0.85 * rollOff(dist), t, 0.06)
      slot.pan.pan.setTargetAtTime(isMine ? 0 : panOf(dx), t, 0.05)
      slot.lp.frequency.setTargetAtTime(Math.max(300, 16000 / (1 + dist * 0.12)), t, 0.06)
      if (isMine || v === running[0]) {
        this.counts.rpm = Math.round(slot.driver.gearbox.rpm)
        this.counts.gear = slot.driver.gearbox.gear + 1
      }
    }
  }

  /** Sampled screech per nearby car (library `vehicle.tyre.screech`), plus a chirp when a slide breaks loose. */
  private tyres(
    vehicles: readonly OutbreakVehicle[],
    listener: { x: number; y: number },
    localVehicleId: number | null | undefined,
    tyres: (id: number) => TyreAudio | undefined,
    time: number,
  ): void {
    const live = this.audio.live
    const rt = this.audio.runtime
    const loop = sfxEntry("vehicle.tyre.screech")
    const seen = new Set<number>()
    this.counts.screech = 0
    for (const v of vehicles) {
      const t = tyres(v.id)
      if (!t) continue
      const near = v.id === localVehicleId || Math.hypot(v.x - listener.x, v.y - listener.y) < loop.range.max
      if (!near) continue
      seen.add(v.id)
      const { level, rate } = tyreScreech(t)
      let s = this.screeches.get(v.id)
      if (!s) this.screeches.set(v.id, (s = { voice: null, level: 0, chirpAt: -Infinity }))
      // A chirp as a hard slide breaks loose at speed, never more than once every 1.2 s.
      const chirp = level > 0.45 && s.level <= 0.45 && speedOf(v) > 6 && time - s.chirpAt > 1.2
      if (chirp) s.chirpAt = time
      s.level = level
      if (v.id === localVehicleId) {
        this.counts.screech = level
        this.counts.screechPeak = Math.max(this.counts.screechPeak, level)
        if (level > 0.05) this.counts.screechFrames++
        if (chirp) this.counts.chirps++
      }
      if (!live) continue
      if (chirp) this.playCue("vehicle.tyre.chirp", v.x, v.y, 0.8 + 0.4 * level, sfxEntry("vehicle.tyre.chirp").range.max)
      const pose = { x: v.x, z: v.y, refDistance: loop.range.ref, maxDistance: loop.range.max, rolloff: 1.35 }
      if (level > 0.03) {
        if (!s.voice?.active) s.voice = rt.playCue("vehicle.tyre.screech", { position: pose, gain: level, ownerKey: `screech:${v.id}` })
        const mix = rt.spatialize(pose)
        s.voice?.setParams({ gain: loop.gain * level * mix.gain, rate, pan: mix.pan, cutoffHz: mix.cutoffHz }, 0.05)
      } else if (s.voice?.active) {
        s.voice.setParams({ gain: 0 }, 0.08)
      }
    }
    for (const [id, s] of this.screeches) {
      if (seen.has(id) && live) continue
      s.voice?.stop(0.12)
      if (!seen.has(id)) this.screeches.delete(id)
      else s.voice = null
    }
  }

  pop(vehicleId: number): void {
    if (!this.audio.live) return
    const slot = this.voices.find((s) => s.id === vehicleId)
    slot?.driver.transients.burst("pop", 0.22)
  }

  silence(): void {
    for (const s of this.screeches.values()) {
      s.voice?.stop(0.04)
      s.voice = null
    }
    if (!this.ctx) return
    const t = this.audio.runtime.now
    for (const slot of this.voices) {
      if (slot.id >= 0) {
        slot.driver.silence()
        slot.gain.gain.setTargetAtTime(0, t, 0.04)
        slot.id = -1
      }
    }
  }
}
