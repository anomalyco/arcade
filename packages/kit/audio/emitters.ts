import type { AudioRuntime } from "./runtime"
import {
  character,
  clamp,
  EngineSynthVoice,
  Gearbox,
  getNoiseBuffer,
  holdParam,
  smoothParam,
  SpellSynthVoice,
  tyreSlip,
  TyreSynthVoice,
} from "./synth"
import type { MaterialTag, SourcePose, SurfaceTag, VoiceHandle } from "./types"

/**
 * Guarantees at most one start per held activation press.
 * Resource/fuel exhaustion or lifecycle interruption (`cancel()`) latches off until a fresh release + press.
 */
export class ActivationGate {
  active = false
  ignited = false
  released = false
  activations = 0
  private armed = true
  private hold = 0
  private upTime = 0

  update(held: boolean, resource = 1, dt = 1 / 60, available = true, remote = false): boolean {
    const was = this.active
    this.ignited = false
    this.upTime = held ? 0 : this.upTime + Math.max(0, dt)
    if (!held && (!remote || this.upTime >= 0.1)) this.armed = true
    if (!available || resource <= 0.005) {
      this.active = false
      this.hold = 0
      if (held) this.armed = false
    } else if (held) {
      if (this.armed) {
        this.active = true
        this.ignited = true
        this.armed = false
        this.activations++
      }
      this.hold = 0.1
    } else if (this.active) {
      this.hold -= Math.max(0, dt)
      if (this.hold <= 1e-6) this.active = false
    }
    this.released = was && !this.active
    return this.active
  }

  /** Interruption (blur, pause, reset, dispose) requires a fresh release before re-arming. */
  cancel(): void {
    this.active = false
    this.ignited = false
    this.released = false
    this.armed = false
    this.hold = 0
    this.upTime = 0
  }
}

export { ActivationGate as NitroGate }

type PressureTail = {
  air: AudioBufferSourceNode
  turbine: OscillatorNode
  gain: GainNode
  tone: GainNode
  low: BiquadFilterNode
  started: number
  end: number
}

/**
 * Bounded pressure envelope + speed-linked turbine for vehicle nitro boost.
 * Retains at most two release tails; interruption silences within 25 ms.
 */
export class NitroPressureVoice {
  private voice: PressureTail | null = null
  private tails: PressureTail[] = []
  ignitions = 0

  constructor(private runtime: AudioRuntime) {}

  get active(): boolean {
    return this.voice !== null
  }

  get voices(): number {
    const now = this.runtime.now
    return Number(this.active) + this.tails.filter(v => v.end > now).length
  }

  update(gate: ActivationGate, speed: number, level = 1): void {
    if (!this.runtime.ctx || this.runtime.muted) {
      if (this.voice) this.stop(true)
      return
    }
    if (gate.ignited) this.start(speed, level)
    if (!gate.active) {
      if (this.voice) this.stop(false)
      return
    }
    if (!this.voice) return
    const t = this.runtime.now
    const k = clamp(speed / 50)
    smoothParam(this.voice.turbine.frequency, 420 + 620 * k, t, 0.18)
    smoothParam(this.voice.tone.gain, (0.008 + 0.012 * k) * level, t, 0.12)
    if (t > this.voice.started + 0.3) {
      smoothParam(this.voice.low.frequency, 1500 + 900 * k, t, 0.15)
    }
  }

  private start(speed: number, level: number): void {
    this.stop(true)
    const ctx = this.runtime.ctx
    if (!ctx) return
    const t = this.runtime.now
    this.tails = this.tails.filter(v => v.end > t)
    while (this.tails.length > 1) {
      this.finish(this.tails.shift()!, t, 0.015)
    }

    const air = ctx.createBufferSource()
    air.buffer = getNoiseBuffer(ctx)
    air.loop = true
    const high = ctx.createBiquadFilter()
    high.type = "highpass"
    high.frequency.value = 180
    const low = ctx.createBiquadFilter()
    low.type = "lowpass"
    low.Q.value = 0.55
    low.frequency.setValueAtTime(650, t)
    low.frequency.exponentialRampToValueAtTime(2400, t + 0.1)
    low.frequency.exponentialRampToValueAtTime(1600 + clamp(speed / 50) * 800, t + 0.3)

    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(0.2 * level, t + 0.028)
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, 0.085 * level), t + 0.18)
    gain.gain.linearRampToValueAtTime(0.13 * level, t + 0.5)

    const turbine = ctx.createOscillator()
    turbine.type = "sine"
    turbine.frequency.setValueAtTime(380 + clamp(speed / 50) * 620, t)
    const tone = ctx.createGain()
    tone.gain.setValueAtTime(0, t)
    const out = ctx.createGain()
    out.gain.value = 1

    air.connect(high).connect(low).connect(gain).connect(out).connect(this.runtime.buses.engine)
    turbine.connect(tone).connect(out)
    air.start(t)
    turbine.start(t)
    air.onended = () => {
      for (const n of [air, high, low, gain, turbine, tone, out]) {
        try {
          n.disconnect()
        } catch {}
      }
    }
    this.voice = { air, turbine, gain, tone, low, started: t, end: Infinity }
    this.ignitions++
  }

  private finish(v: PressureTail, t: number, duration: number): void {
    if (v.end <= t + duration + 0.01) return
    for (const p of [v.gain.gain, v.tone.gain]) {
      holdParam(p, t, 0)
      p.linearRampToValueAtTime(0, t + duration)
    }
    try {
      v.air.stop(t + duration + 0.01)
      v.turbine.stop(t + duration + 0.01)
    } catch {}
    v.end = t + duration + 0.01
  }

  stop(interrupted = true): void {
    const t = this.runtime.now
    if (interrupted) {
      for (const v of this.tails) this.finish(v, t, 0.025)
    }
    const v = this.voice
    if (!v) return
    if (!interrupted) {
      holdParam(v.low.frequency, t, 1800)
      v.low.frequency.exponentialRampToValueAtTime(2800, t + 0.04)
    }
    this.finish(v, t, interrupted ? 0.025 : 0.2)
    this.tails.push(v)
    this.voice = null
  }
}

export type VehicleEmitterOptions = {
  id?: string
  vehicleClass?: string
  cheap?: boolean
}

export type VehicleEmitterState = {
  speed: number
  /** Optional explicit RPM override (e.g. from Audio Lab manual slider); otherwise driven by `Gearbox`. */
  rpm?: number
  throttle?: number
  load?: number
  /** Direct 0..1 tyre slip override or derived from `lateralSlip` / `launchSlip`. */
  slip?: number
  lateralSlip?: number
  launchSlip?: number
  distance?: number
  position?: SourcePose
  surface?: SurfaceTag
  boost?: boolean
  fuel?: number
  handbrake?: boolean
  airborne?: boolean
  engineOff?: boolean
  vehicleClass?: string
  paused?: boolean
}

/**
 * World-driven vehicle emitter managing continuous engine harmonics, automatic gearbox shifts,
 * tyre scrub/squeal, gated nitro boost, and velocity-layered collision impacts.
 */
export class VehicleAudioEmitter {
  readonly id: string
  vehicleClass: string
  gearbox: Gearbox
  readonly boostGate = new ActivationGate()
  nitro!: NitroPressureVoice
  onShift?: (gear: number, rpm: number) => void

  private engineVoice: EngineSynthVoice | null = null
  private tyreVoice: TyreSynthVoice | null = null
  private boundCtx: BaseAudioContext | null = null
  private cheap: boolean
  private smoothedLoad = 0
  private lastThrottle = 0
  private lastSpeed = 0
  private launchTimer = 0
  private impactCooldown = 0
  private impactArmed = true
  private impactLowTime = 0
  private lastImpactForce = 0
  private active = false
  private disposed = false
  private shiftEnds: number[] = []

  constructor(
    private runtime: AudioRuntime,
    options: VehicleEmitterOptions = {},
  ) {
    this.id = options.id ?? "vehicle"
    this.vehicleClass = options.vehicleClass ?? "muscle"
    this.cheap = options.cheap ?? false
    this.gearbox = new Gearbox(character(this.vehicleClass))
    this.nitro = new NitroPressureVoice(runtime)
  }

  get isActive(): boolean {
    return this.active
  }

  get nitroState() {
    return {
      ignitions: this.nitro.ignitions,
      active: this.nitro.active,
      voices: this.nitro.voices,
    }
  }

  private ensureVoices(): boolean {
    if (this.disposed || !this.runtime.ctx) return false
    if (this.boundCtx === this.runtime.ctx && this.engineVoice && this.tyreVoice) return true
    this.engineVoice?.dispose()
    this.tyreVoice?.dispose()
    const ctx = this.runtime.ctx
    this.boundCtx = ctx
    this.engineVoice = new EngineSynthVoice(ctx, this.runtime.buses.engine, this.runtime.verb, this.cheap)
    this.tyreVoice = new TyreSynthVoice(ctx, this.runtime.buses.tyre, this.runtime.verb)
    this.nitro = new NitroPressureVoice(this.runtime)
    return true
  }

  update(state: VehicleEmitterState, dt: number): void {
    if (this.disposed) return
    dt = clamp(dt, 1e-3, 0.1)
    this.impactCooldown = Math.max(0, this.impactCooldown - dt)

    if (state.paused || state.engineOff || this.runtime.muted) {
      if (this.active || this.boostGate.active || this.nitro.active) {
        this.stop(true)
      }
      return
    }
    if (!this.ensureVoices()) return

    if (state.vehicleClass && state.vehicleClass !== this.vehicleClass) {
      this.vehicleClass = state.vehicleClass
      this.gearbox = new Gearbox(character(this.vehicleClass))
    }

    const pose: SourcePose | undefined =
      state.position ??
      (state.distance !== undefined
        ? { x: this.runtime.listener.x + state.distance, z: this.runtime.listener.z }
        : undefined)
    const sp = this.runtime.spatialize(pose)
    if (sp.gain <= 0.005) {
      if (this.active) this.stop(false)
      return
    }

    this.active = true
    const t = this.runtime.now
    const fuel = state.fuel ?? 1
    const boosting = this.boostGate.update(!!state.boost, fuel, dt, !state.engineOff)
    this.nitro.update(this.boostGate, state.speed, sp.gain)

    const rawThrottle =
      state.throttle !== undefined
        ? Math.abs(state.throttle)
        : clamp((state.speed - this.lastSpeed) / Math.max(dt * 8, 0.01) + 0.25)

    if ((this.boostGate.ignited || (rawThrottle > 0.8 && this.lastThrottle < 0.2)) && state.speed < 24) {
      this.launchTimer = boosting ? 0.45 : 0.22
    }
    this.launchTimer = Math.max(0, this.launchTimer - dt)

    const targetLoad = state.load !== undefined ? clamp(state.load) : clamp(rawThrottle + (boosting ? 0.3 : 0))
    this.smoothedLoad += (targetLoad - this.smoothedLoad) * (1 - Math.exp(-dt * 10))

    this.gearbox.update(state.speed, rawThrottle, boosting, dt)
    const rpm = state.rpm !== undefined ? clamp(state.rpm, 500, 12000) : this.gearbox.rpm

    if (this.gearbox.shifted && state.rpm === undefined) {
      this.scheduleShiftBurst(sp.gain)
      this.onShift?.(this.gearbox.gear, rpm)
    }

    const engLevel = sp.gain * (0.21 + this.smoothedLoad * 0.18)
    this.engineVoice!.set(
      this.vehicleClass,
      rpm,
      this.smoothedLoad,
      engLevel,
      t,
      sp.pan,
      sp.doppler,
      sp.cutoffHz,
      sp.wet,
      this.gearbox.shift > 0,
    )

    const surface = state.surface ?? "road"
    const launchRatio = state.launchSlip ?? (this.launchTimer > 0 ? this.launchTimer / 0.45 : 0)
    const lateral = state.lateralSlip ?? (state.slip !== undefined ? state.slip * Math.max(8, state.speed * 0.55) : 0)
    const slipInfo = tyreSlip(state.speed, lateral, launchRatio, !!state.handbrake, !!state.airborne, surface)
    if (state.slip !== undefined) {
      const manualSlip = clamp(state.slip)
      slipInfo.slip = manualSlip
      slipInfo.squeal = Math.pow(clamp((manualSlip - 0.18) / 0.65), 1.3) * (state.airborne ? 0 : 1) * (surface === "grass" ? 0.08 : 1)
      slipInfo.scrub = (state.airborne ? 0 : 1) * clamp(manualSlip * 1.6) * (1 - slipInfo.squeal * 0.5)
      slipInfo.hz = 900 + 1350 * manualSlip + 200 * clamp(state.speed / 45)
    }

    this.tyreVoice!.set(slipInfo, surface, sp.gain, t, sp.pan, sp.cutoffHz, sp.wet)

    this.lastThrottle = rawThrottle
    this.lastSpeed = state.speed
  }

  /**
   * Updates collision re-arm state and triggers a layered impact cue when `force` crosses threshold.
   * Prevents rapid machine-gun retriggering on lingering wall contact.
   */
  stepImpact(force: number, dt: number, material: MaterialTag = "metal", position?: SourcePose): VoiceHandle | null {
    this.impactLowTime = force < Math.max(0.08, 0.35 * this.lastImpactForce) ? this.impactLowTime + dt : 0
    if (this.impactLowTime > 0.1) this.impactArmed = true
    if (force < 0.12 || this.impactCooldown > 0 || !(this.impactArmed || force > 1.6 * this.lastImpactForce)) {
      return null
    }
    return this.impact(force, material, position)
  }

  impact(force: number, material: MaterialTag = "metal", position?: SourcePose): VoiceHandle | null {
    if (this.disposed || force < 0.05 || this.impactCooldown > 0) return null
    this.impactCooldown = 0.22
    this.impactArmed = false
    this.lastImpactForce = force
    const norm = clamp(force, 0.05, 1)
    return this.runtime.playCue("impact_crash_layered", {
      intensity: norm,
      force: 0.6 + 0.8 * norm,
      material,
      position,
    })
  }

  private scheduleShiftBurst(level: number): void {
    const ctx = this.runtime.ctx
    if (!ctx) return
    const now = this.runtime.now
    this.shiftEnds = this.shiftEnds.filter(e => e > now)
    if (this.shiftEnds.length >= 6) return
    const duration = 0.12
    this.shiftEnds.push(now + duration)
    const src = ctx.createBufferSource()
    src.buffer = getNoiseBuffer(ctx)
    const filter = ctx.createBiquadFilter()
    filter.type = "lowpass"
    filter.frequency.setValueAtTime(480, now)
    filter.frequency.exponentialRampToValueAtTime(180, now + duration)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(level * 0.11, now + 0.006)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration - 0.01)
    gain.gain.linearRampToValueAtTime(0, now + duration)
    src.connect(filter).connect(gain).connect(this.runtime.buses.engine)
    src.start(now)
    src.stop(now + duration)
    src.onended = () => {
      src.disconnect()
      filter.disconnect()
      gain.disconnect()
    }
  }

  /** Idempotent stop: silences all continuous voices and cancels nitro latch. */
  stop(fast = true): void {
    const wasActive = this.active || this.boostGate.active || this.nitro.active
    this.active = false
    this.boostGate.cancel()
    this.nitro.stop(fast)
    if (wasActive) {
      const t = this.runtime.now
      this.engineVoice?.silence(t, fast)
      this.tyreVoice?.silence(t, fast)
    }
    this.lastThrottle = 0
    this.launchTimer = 0
  }

  reset(): void {
    this.stop(true)
    this.gearbox.reset()
    this.smoothedLoad = 0
    this.impactCooldown = 0
    this.impactArmed = true
    this.impactLowTime = 0
    this.lastImpactForce = 0
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stop(true)
    this.engineVoice?.dispose()
    this.tyreVoice?.dispose()
    this.engineVoice = null
    this.tyreVoice = null
  }
}

export type SpellEmitterState = {
  active: boolean
  /** 0..1 charge progress; if omitted, accumulates while `active` at `chargeRate`. */
  charge?: number
  mana?: number
  distance?: number
  position?: SourcePose
  autoCastOnRelease?: boolean
  paused?: boolean
}

/**
 * World-driven arcane/spell emitter with a one-start-per-activation mana gate,
 * continuous harmonic/air charge modulation, and release burst.
 */
export class SpellAudioEmitter {
  readonly id: string
  readonly gate = new ActivationGate()
  charge = 0
  casts = 0

  private voice: SpellSynthVoice | null = null
  private loopHandle: VoiceHandle | null = null
  private boundCtx: BaseAudioContext | null = null
  private active = false
  private disposed = false

  constructor(
    private runtime: AudioRuntime,
    options: { id?: string } = {},
  ) {
    this.id = options.id ?? "spell"
  }

  get isActive(): boolean {
    return this.active
  }

  private ensureVoice(): boolean {
    if (this.disposed || !this.runtime.ctx) return false
    if (this.boundCtx === this.runtime.ctx && this.voice) return true
    this.voice?.dispose()
    this.boundCtx = this.runtime.ctx
    this.voice = new SpellSynthVoice(this.runtime.ctx, this.runtime.buses.spell, this.runtime.verb)
    return true
  }

  update(state: SpellEmitterState, dt: number): void {
    if (this.disposed) return
    dt = clamp(dt, 1e-3, 0.1)
    if (state.paused || this.runtime.muted) {
      if (this.active || this.gate.active) this.stop(true)
      return
    }
    if (!this.ensureVoice()) return

    const mana = state.mana ?? 1
    const isCharging = this.gate.update(state.active, mana, dt, true)

    const pose: SourcePose | undefined =
      state.position ??
      (state.distance !== undefined
        ? { x: this.runtime.listener.x + state.distance, z: this.runtime.listener.z }
        : undefined)
    const sp = this.runtime.spatialize(pose)

    if (this.gate.ignited) {
      this.charge = state.charge ?? 0.05
      this.loopHandle?.stop(0.02)
      this.loopHandle = this.runtime.playCue(
        {
          id: "spell_charge_stem",
          category: "spell",
          material: "arcane",
          masterGain: 0.35,
          loop: true,
          steal: "replace",
          layers: [
            {
              kind: "sample",
              samples: ["stem_arcane_charge_loop"],
              loop: true,
              gain: 0.65,
              rate: 1.0,
              envelope: { attack: 0.04, decay: 0.15, peak: 0.7 },
            },
          ],
        },
        {
          ownerKey: `${this.id}:charge-stem`,
          position: pose,
          wet: sp.wet + 0.15,
        },
      )
    }

    if (isCharging) {
      this.active = true
      this.charge = state.charge !== undefined ? clamp(state.charge) : clamp(this.charge + dt * 0.65)
      this.voice!.set(this.charge, sp.gain, this.runtime.now, sp.pan, sp.cutoffHz, sp.wet + 0.18)
      this.loopHandle?.setParams({
        gain: 0.35 * sp.gain * (0.4 + 0.6 * this.charge),
        rate: 0.92 + 0.38 * this.charge,
        pan: sp.pan,
        cutoffHz: Math.min(sp.cutoffHz, 1200 + 4800 * this.charge),
        wet: sp.wet + 0.18,
      })
    } else {
      if (this.gate.released && (state.autoCastOnRelease ?? true) && this.charge >= 0.25 && mana > 0.005) {
        this.cast(this.charge, pose)
      }
      if (this.active) {
        this.active = false
        this.voice?.silence(this.runtime.now, false)
        this.loopHandle?.stop(0.04)
        this.loopHandle = null
      }
      this.charge = Math.max(0, this.charge - dt * 2)
    }
  }

  cast(intensity = Math.max(0.5, this.charge), position?: SourcePose): VoiceHandle | null {
    if (this.disposed) return null
    this.casts++
    const norm = clamp(intensity, 0.2, 1)
    return this.runtime.playCue("spell_arcane_cast", {
      intensity: norm,
      force: 0.65 + 0.6 * norm,
      rate: 0.94 + 0.16 * norm,
      position,
    })
  }

  /** Idempotent stop: cancels charge gate without firing a release burst and silences all nodes. */
  stop(fast = true): void {
    const wasActive = this.active || this.gate.active || this.loopHandle !== null
    this.active = false
    this.gate.cancel()
    this.charge = 0
    if (wasActive) {
      this.voice?.silence(this.runtime.now, fast)
      this.loopHandle?.stop(fast ? 0.02 : 0.05)
      this.loopHandle = null
    }
  }

  reset(): void {
    this.stop(true)
    this.casts = 0
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stop(true)
    this.voice?.dispose()
    this.voice = null
  }
}
