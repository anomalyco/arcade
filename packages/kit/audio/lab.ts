import { LabPanel, type LabControl } from "../lab-panel"
import { SpellAudioEmitter, VehicleAudioEmitter } from "./emitters"
import {
  analyzeAudioBuffer,
  encodeWavPcm16,
  renderOcclusionReverbAb,
  renderWorldSignalReplayOffline,
  type AbComparisonResult,
  type AudioAnalysisStats,
  type ReplayScenarioResult,
} from "./offline"
import { AudioRuntime, createBoxOcclusionQuery } from "./runtime"
import { clamp } from "./synth"
import { getOfflineAudioContextConstructor } from "./test-context"
import type { AudioLabSection, MaterialTag, MixCategory, SurfaceTag } from "./types"

export type AudioLabSettings = {
  source: string
  replay: string
  playing: boolean
  speed: number
  rpm: number
  throttle: number
  slip: number
  impactForce: number
  spellCharge: number
  surface: SurfaceTag
  material: MaterialTag
  boost: boolean
  fuel: number
  seed: number
  pitchVar: number
  gainVar: number
  attackMs: number
  decayMs: number
  rate: number
  distance: number
  pan: number
  reverbWet: number
  occluded: boolean
  muted: boolean
  voiceBudget: number
}

export type AudioLabContextLike = {
  sync?: () => void
  input?: {
    enabled?: boolean
    release?: () => void
  }
}

export type AudioLabController = {
  readonly section: AudioLabSection
  readonly runtime: AudioRuntime
  readonly vehicleEmitter: VehicleAudioEmitter
  readonly spellEmitter: SpellAudioEmitter
  readonly settings: AudioLabSettings
  lastStats: AudioAnalysisStats | null
  lastWav: Uint8Array | null
  lastAb: AbComparisonResult | null
  lastReplay: ReplayScenarioResult | null
  triggerCurrent(): Promise<AudioAnalysisStats | null>
  renderAbComparison(): Promise<AbComparisonResult>
  renderReplay(mode?: "chase" | "slalom" | "spell_cycle"): Promise<ReplayScenarioResult>
  stopAll(): void
  drawVisualizer(canvas: HTMLCanvasElement): void
  dispose(): void
}

const SOURCE_OPTIONS = [
  { value: "impact_crash_layered", label: "Layered Crash" },
  { value: "impact_metal_clink", label: "Metal Clink" },
  { value: "spell_arcane_cast", label: "Arcane Cast" },
  { value: "tyre_slide_bark", label: "Tyre Bark" },
  { value: "ui_confirm", label: "UI Confirm" },
  { value: "emitter_vehicle", label: "Vehicle Emitter" },
  { value: "emitter_spell", label: "Spell Emitter" },
] as const

const REPLAY_OPTIONS = [
  { value: "manual", label: "Manual" },
  { value: "chase", label: "Chase Replay" },
  { value: "slalom", label: "Slalom Replay" },
  { value: "spell_cycle", label: "Spell Cycle" },
  { value: "occlusion_ab", label: "Occlusion A/B" },
] as const

const SURFACE_OPTIONS = [
  { value: "road", label: "Road" },
  { value: "kerb", label: "Kerb" },
  { value: "grass", label: "Grass" },
] as const

const MATERIAL_OPTIONS = [
  { value: "metal", label: "Metal" },
  { value: "concrete", label: "Concrete" },
  { value: "wood", label: "Wood" },
  { value: "glass", label: "Glass" },
  { value: "rubber", label: "Rubber" },
  { value: "arcane", label: "Arcane" },
] as const

const WALL_BOX = [{ x0: 4, x1: 12, z0: -30, z1: 30, h: 10 }] as const

export function createAudioLabController(context?: AudioLabContextLike): AudioLabController {
  const settings: AudioLabSettings = {
    source: "impact_crash_layered",
    replay: "manual",
    playing: true,
    speed: 24,
    rpm: 0,
    throttle: 0.75,
    slip: 0.35,
    impactForce: 0.8,
    spellCharge: 0.75,
    surface: "road",
    material: "metal",
    boost: false,
    fuel: 1,
    seed: 7,
    pitchVar: 0.08,
    gainVar: 0.12,
    attackMs: 4,
    decayMs: 420,
    rate: 1,
    distance: 14,
    pan: 0,
    reverbWet: 0.35,
    occluded: false,
    muted: false,
    voiceBudget: 24,
  }

  const boxQuery = createBoxOcclusionQuery(WALL_BOX)
  const runtime = new AudioRuntime({
    seed: settings.seed,
    maxVoices: settings.voiceBudget,
    reverbWet: settings.reverbWet,
    visibilityQuery: (lx, lz, sx, sz) => (settings.occluded ? boxQuery(lx, lz, sx, sz) || 1 : 0),
    autoBindDom: false,
  })
  runtime.setListener({ x: 0, z: 0, rightX: 1, rightZ: 0, earHeight: 16 })

  const vehicleEmitter = new VehicleAudioEmitter(runtime, { id: "lab-vehicle", vehicleClass: "muscle" })
  const spellEmitter = new SpellAudioEmitter(runtime, { id: "lab-spell" })

  let replayTime = 0
  let hudCanvas: HTMLCanvasElement | null = null
  let lastStats: AudioAnalysisStats | null = null
  let lastWav: Uint8Array | null = null
  let lastAb: AbComparisonResult | null = null
  let lastReplay: ReplayScenarioResult | null = null

  const applyRuntimeSettings = () => {
    runtime.maxVoices = settings.voiceBudget
    runtime.setMuted(settings.muted)
    runtime.setReverbWet(settings.reverbWet)
  }

  const currentSourcePose = () => ({
    x: Math.max(0.1, settings.distance) * (settings.pan >= 0 ? 1 : -1),
    z: Math.max(2, settings.distance),
    vx: settings.speed * 0.35,
    vz: 0,
  })

  const renderPreviewOffline = async (): Promise<AudioAnalysisStats | null> => {
    const OfflineCtx = getOfflineAudioContextConstructor()
    if (settings.replay === "occlusion_ab") {
      const ab = await renderOcclusionReverbAb(settings.seed, OfflineCtx, runtime.sampleBank)
      lastAb = ab
      lastStats = settings.occluded ? ab.reverbOccluded.stats : ab.dryOpen.stats
      lastWav = settings.occluded ? ab.reverbOccluded.wav : ab.dryOpen.wav
      return lastStats
    }
    if (settings.replay === "chase" || settings.replay === "slalom" || settings.replay === "spell_cycle") {
      const rep = await renderWorldSignalReplayOffline(settings.replay, settings.seed, OfflineCtx, runtime.sampleBank)
      lastReplay = rep
      lastStats = rep.stats
      lastWav = rep.wav
      return lastStats
    }

    const dur = 1.6
    const sr = 48000
    const offCtx = new OfflineCtx(2, Math.ceil(dur * sr), sr)
    const offRuntime = new AudioRuntime({
      context: offCtx,
      seed: settings.seed,
      maxVoices: settings.voiceBudget,
      reverbWet: settings.reverbWet,
      visibilityQuery: () => (settings.occluded ? 1 : 0),
    })
    runtime.sampleBank.cloneDecodedTo(offRuntime.sampleBank)
    offRuntime.setListener({ x: 0, z: 0, rightX: 1, rightZ: 0, earHeight: 16 })
    const pose = currentSourcePose()

    if (settings.source === "emitter_vehicle") {
      const v = new VehicleAudioEmitter(offRuntime, { id: "preview-v", vehicleClass: "muscle" })
      for (let i = 0; i < Math.floor(1.2 * 60); i++) {
        offRuntime.scheduleTime = i / 60
        v.update(
          {
            speed: settings.speed,
            rpm: settings.rpm > 0 ? settings.rpm : undefined,
            throttle: settings.throttle,
            slip: settings.slip,
            surface: settings.surface,
            boost: settings.boost,
            fuel: settings.fuel,
            position: pose,
          },
          1 / 60,
        )
      }
      offRuntime.scheduleTime = 1.2
      v.stop(true)
    } else if (settings.source === "emitter_spell") {
      const s = new SpellAudioEmitter(offRuntime, { id: "preview-s" })
      for (let i = 0; i < Math.floor(1.0 * 60); i++) {
        offRuntime.scheduleTime = i / 60
        s.update(
          {
            active: i < 45,
            charge: settings.spellCharge,
            mana: settings.fuel,
            position: pose,
            autoCastOnRelease: true,
          },
          1 / 60,
        )
      }
      offRuntime.scheduleTime = 1.25
      s.stop(true)
    } else {
      offRuntime.scheduleTime = 0.05
      offRuntime.playCue(settings.source, {
        intensity: settings.impactForce,
        force: Math.max(0.25, settings.impactForce),
        rate: settings.rate,
        pan: settings.pan,
        wet: settings.reverbWet,
        material: settings.material,
        position: pose,
        attackSeconds: settings.attackMs / 1000,
        decaySeconds: settings.decayMs / 1000,
        pitchVariation: settings.pitchVar,
        gainVariation: settings.gainVar,
      })
    }

    const buf = await offCtx.startRendering()
    lastStats = analyzeAudioBuffer(buf, { fps: 60, tailWindow: [0.85, 1.45] })
    lastWav = encodeWavPcm16(buf)
    return lastStats
  }

  const triggerCurrent = async (): Promise<AudioAnalysisStats | null> => {
    applyRuntimeSettings()
    runtime.setSeed(settings.seed)
    const pose = currentSourcePose()
    if (runtime.ctx && runtime.ctx.state === "running" && !settings.muted) {
      if (settings.source !== "emitter_vehicle" && settings.source !== "emitter_spell") {
        runtime.playCue(settings.source, {
          intensity: settings.impactForce,
          force: Math.max(0.25, settings.impactForce),
          rate: settings.rate,
          pan: settings.pan,
          wet: settings.reverbWet,
          material: settings.material,
          position: pose,
          attackSeconds: settings.attackMs / 1000,
          decaySeconds: settings.decayMs / 1000,
          pitchVariation: settings.pitchVar,
          gainVariation: settings.gainVar,
        })
      }
    }
    const stats = await renderPreviewOffline()
    if (hudCanvas) drawVisualizer(hudCanvas)
    context?.sync?.()
    return stats
  }

  const renderAbComparison = async (): Promise<AbComparisonResult> => {
    const ab = await renderOcclusionReverbAb(settings.seed, getOfflineAudioContextConstructor(), runtime.sampleBank)
    lastAb = ab
    lastStats = settings.occluded ? ab.reverbOccluded.stats : ab.dryOpen.stats
    lastWav = settings.occluded ? ab.reverbOccluded.wav : ab.dryOpen.wav
    if (hudCanvas) drawVisualizer(hudCanvas)
    context?.sync?.()
    return ab
  }

  const renderReplay = async (
    mode: "chase" | "slalom" | "spell_cycle" = "chase",
  ): Promise<ReplayScenarioResult> => {
    const rep = await renderWorldSignalReplayOffline(mode, settings.seed, getOfflineAudioContextConstructor(), runtime.sampleBank)
    lastReplay = rep
    lastStats = rep.stats
    lastWav = rep.wav
    if (hudCanvas) drawVisualizer(hudCanvas)
    context?.sync?.()
    return rep
  }

  const stopAll = () => {
    settings.playing = false
    vehicleEmitter.stop(true)
    spellEmitter.stop(true)
    runtime.stopAllVoices(0.015)
    if (hudCanvas) drawVisualizer(hudCanvas)
    context?.sync?.()
  }

  const controls: readonly LabControl[] = [
    // Group: Playback
    {
      key: "source",
      label: "Source",
      group: "Playback",
      type: "select",
      options: SOURCE_OPTIONS,
      change: () => void triggerCurrent(),
    },
    {
      key: "replay",
      label: "Replay",
      group: "Playback",
      type: "select",
      options: REPLAY_OPTIONS,
      change: () => {
        replayTime = 0
        void triggerCurrent()
      },
    },
    {
      key: "playing",
      label: "Play",
      group: "Playback",
      change: value => {
        if (!value) stopAll()
      },
    },
    {
      key: "audition",
      label: "Audition",
      group: "Playback",
      type: "action",
      run: async button => {
        const ok = await runtime.unlock()
        button.textContent = ok ? "Audition Active" : "Audition Blocked"
        if (ok) await triggerCurrent()
      },
    },
    {
      key: "retrigger",
      label: "Retrigger",
      group: "Playback",
      type: "action",
      run: async () => {
        settings.playing = true
        await triggerCurrent()
      },
    },
    {
      key: "stop",
      label: "Stop",
      group: "Playback",
      type: "action",
      run: () => stopAll(),
    },
    {
      key: "renderAb",
      label: "Render A/B",
      group: "Playback",
      type: "action",
      run: async button => {
        await renderAbComparison()
        button.textContent = "A/B Ready"
      },
    },

    // Group: World
    {
      key: "speed",
      label: "Speed m/s",
      group: "World",
      type: "range",
      min: 0,
      max: 55,
      step: 0.5,
      change: () => void renderPreviewOffline(),
    },
    {
      key: "rpm",
      label: "RPM",
      group: "World",
      type: "range",
      min: 0,
      max: 9000,
      step: 100,
      change: () => void renderPreviewOffline(),
    },
    {
      key: "throttle",
      label: "Throttle",
      group: "World",
      type: "range",
      min: 0,
      max: 1,
      step: 0.05,
      change: () => void renderPreviewOffline(),
    },
    {
      key: "slip",
      label: "Tyre slip",
      group: "World",
      type: "range",
      min: 0,
      max: 1,
      step: 0.02,
      change: () => void renderPreviewOffline(),
    },
    {
      key: "impactForce",
      label: "Impact force",
      group: "World",
      type: "range",
      min: 0,
      max: 1,
      step: 0.05,
      change: () => void renderPreviewOffline(),
    },
    {
      key: "spellCharge",
      label: "Spell charge",
      group: "World",
      type: "range",
      min: 0,
      max: 1,
      step: 0.05,
      change: () => void renderPreviewOffline(),
    },
    {
      key: "surface",
      label: "Surface",
      group: "World",
      type: "select",
      options: SURFACE_OPTIONS,
      change: () => void renderPreviewOffline(),
    },
    {
      key: "material",
      label: "Material",
      group: "World",
      type: "select",
      options: MATERIAL_OPTIONS,
      change: () => void renderPreviewOffline(),
    },
    {
      key: "boost",
      label: "Boost",
      group: "World",
      change: () => void renderPreviewOffline(),
    },
    {
      key: "fuel",
      label: "Fuel / Mana",
      group: "World",
      type: "range",
      min: 0,
      max: 1,
      step: 0.05,
      change: () => void renderPreviewOffline(),
    },

    // Group: Variation
    {
      key: "seed",
      label: "Seed",
      group: "Variation",
      type: "range",
      min: 1,
      max: 999,
      step: 1,
      change: value => {
        runtime.setSeed(Number(value))
        void renderPreviewOffline()
      },
    },
    {
      key: "pitchVar",
      label: "Pitch var",
      group: "Variation",
      type: "range",
      min: 0,
      max: 0.25,
      step: 0.01,
      change: () => void renderPreviewOffline(),
    },
    {
      key: "gainVar",
      label: "Gain var",
      group: "Variation",
      type: "range",
      min: 0,
      max: 0.35,
      step: 0.01,
      change: () => void renderPreviewOffline(),
    },
    {
      key: "attackMs",
      label: "Attack ms",
      group: "Variation",
      type: "range",
      min: 1,
      max: 200,
      step: 1,
      change: () => void renderPreviewOffline(),
    },
    {
      key: "decayMs",
      label: "Decay ms",
      group: "Variation",
      type: "range",
      min: 20,
      max: 1500,
      step: 10,
      change: () => void renderPreviewOffline(),
    },
    {
      key: "rate",
      label: "Playback rate",
      group: "Variation",
      type: "range",
      min: 0.5,
      max: 2,
      step: 0.02,
      change: () => void renderPreviewOffline(),
    },

    // Group: Mix
    {
      key: "distance",
      label: "Distance m",
      group: "Mix",
      type: "range",
      min: 0,
      max: 140,
      step: 1,
      change: () => void renderPreviewOffline(),
    },
    {
      key: "pan",
      label: "Pan",
      group: "Mix",
      type: "range",
      min: -1,
      max: 1,
      step: 0.05,
      change: () => void renderPreviewOffline(),
    },
    {
      key: "reverbWet",
      label: "Reverb wet",
      group: "Mix",
      type: "range",
      min: 0,
      max: 0.85,
      step: 0.02,
      change: value => {
        runtime.setReverbWet(Number(value))
        void renderPreviewOffline()
      },
    },
    {
      key: "occluded",
      label: "Occluded",
      group: "Mix",
      change: () => void renderPreviewOffline(),
    },
    {
      key: "muted",
      label: "Mute",
      group: "Mix",
      change: value => runtime.setMuted(Boolean(value)),
    },
    {
      key: "voiceBudget",
      label: "Voice budget",
      group: "Mix",
      type: "range",
      min: 4,
      max: 32,
      step: 1,
      change: value => {
        runtime.maxVoices = Number(value)
      },
    },
  ]

  const update = (dt: number) => {
    applyRuntimeSettings()
    if (!settings.playing) {
      vehicleEmitter.stop(true)
      spellEmitter.stop(true)
      if (hudCanvas) drawVisualizer(hudCanvas)
      return
    }

    replayTime += dt
    const pose = currentSourcePose()

    if (runtime.ctx && runtime.ctx.state === "running" && !settings.muted) {
      if (settings.source === "emitter_vehicle" || settings.replay === "chase" || settings.replay === "slalom") {
        const cyc = replayTime % 6
        const spd = settings.replay === "manual" ? settings.speed : 10 + 28 * Math.abs(Math.sin(cyc * 0.7))
        const slp = settings.replay === "manual" ? settings.slip : 0.65 * Math.max(0, Math.sin(cyc * 2.4))
        vehicleEmitter.update(
          {
            speed: spd,
            rpm: settings.rpm > 0 ? settings.rpm : undefined,
            throttle: settings.throttle,
            slip: slp,
            surface: settings.surface,
            boost: settings.boost,
            fuel: settings.fuel,
            position: pose,
          },
          dt,
        )
        spellEmitter.stop(false)
      } else if (settings.source === "emitter_spell" || settings.replay === "spell_cycle") {
        spellEmitter.update(
          {
            active: settings.playing,
            charge: settings.spellCharge,
            mana: settings.fuel,
            position: pose,
          },
          dt,
        )
        vehicleEmitter.stop(false)
      } else {
        vehicleEmitter.stop(false)
        spellEmitter.stop(false)
      }
    }
    if (hudCanvas) drawVisualizer(hudCanvas)
  }

  const telemetry = () => {
    const t = runtime.telemetry()
    const peakStr = lastStats ? `${lastStats.peakDb.toFixed(1)} dBFS` : "—"
    const lufsStr = lastStats ? `${lastStats.approxLufs.toFixed(1)} LUFS` : "—"
    const centStr = lastStats ? `${Math.round(lastStats.spectralCentroidHz)} Hz` : "—"
    return `Voices ${t.activeVoices}/${t.maxVoices} · Peak ${peakStr} · ${lufsStr} · Centroid ${centStr}`
  }

  const drawVisualizer = (canvas: HTMLCanvasElement) => {
    const ctx2d = canvas.getContext("2d")
    if (!ctx2d) return
    const w = canvas.width
    const h = canvas.height
    ctx2d.fillStyle = "#0b1014"
    ctx2d.fillRect(0, 0, w, h)

    const pad = 20
    const panelReserve = Math.min(310, Math.floor(w * 0.28))
    const usableW = Math.max(420, w - panelReserve)
    const leftW = Math.floor((usableW - pad * 3) * 0.56)
    const rightW = usableW - pad * 3 - leftW
    const rightX = pad * 2 + leftW

    // 1. Waveform + Envelope panel (top-left)
    const waveH = Math.floor((h - pad * 3) * 0.44)
    drawPanelBox(ctx2d, pad, pad, leftW, waveH, `WAVEFORM & ENVELOPE · ${settings.source} (${settings.replay})`)
    if (lastStats) {
      const bins = lastStats.waveformBins
      const innerX = pad + 12
      const innerY = pad + 28
      const innerW = leftW - 24
      const innerH = waveH - 40
      const midY = innerY + innerH * 0.5

      ctx2d.strokeStyle = "#ffffff18"
      ctx2d.beginPath()
      ctx2d.moveTo(innerX, midY)
      ctx2d.lineTo(innerX + innerW, midY)
      ctx2d.stroke()

      // Peak min/max bars
      ctx2d.fillStyle = "#4fa3b855"
      for (let i = 0; i < bins.bins; i++) {
        const x = innerX + (i / bins.bins) * innerW
        const bw = Math.max(1.5, innerW / bins.bins - 1)
        const yMin = midY - bins.max[i]! * (innerH * 0.46)
        const yMax = midY - bins.min[i]! * (innerH * 0.46)
        ctx2d.fillRect(x, yMin, bw, Math.max(1, yMax - yMin))
      }

      // RMS envelope curve
      ctx2d.strokeStyle = "#a4dce7"
      ctx2d.lineWidth = 2
      ctx2d.beginPath()
      for (let i = 0; i < bins.bins; i++) {
        const x = innerX + ((i + 0.5) / bins.bins) * innerW
        const y = midY - bins.rms[i]! * (innerH * 0.46)
        if (i === 0) ctx2d.moveTo(x, y)
        else ctx2d.lineTo(x, y)
      }
      ctx2d.stroke()
    }

    // 2. Log-Frequency Spectrogram panel (bottom-left)
    const specY = pad * 2 + waveH
    const specH = h - specY - pad
    drawPanelBox(ctx2d, pad, specY, leftW, specH, "LOG-FREQUENCY SPECTROGRAM (60 Hz – 16 kHz)")
    if (lastStats) {
      const spec = lastStats.spectrogram
      const innerX = pad + 12
      const innerY = specY + 28
      const innerW = leftW - 24
      const innerH = specH - 40
      const cw = innerW / spec.timeBins
      const ch = innerH / spec.freqBins

      for (let tb = 0; tb < spec.timeBins; tb++) {
        for (let fb = 0; fb < spec.freqBins; fb++) {
          const val = spec.intensity[tb * spec.freqBins + fb]!
          if (val <= 0.02) continue
          const r = Math.round(clamp(val * 255 * 1.15, 20, 255))
          const g = Math.round(clamp(Math.pow(val, 0.75) * 235, 30, 245))
          const b = Math.round(clamp((0.4 + val * 0.6) * 255, 70, 255))
          ctx2d.fillStyle = `rgb(${r},${g},${b})`
          const x = innerX + tb * cw
          const y = innerY + (spec.freqBins - 1 - fb) * ch
          ctx2d.fillRect(x, y, Math.ceil(cw), Math.ceil(ch))
        }
      }
    }

    // 3. Active Voice, Bus Readout & A/B Comparison panel (right column)
    const rightH = h - pad * 2
    drawPanelBox(ctx2d, rightX, pad, rightW, rightH, "BUS READOUT & OFFLINE PROOF")
    const tel = runtime.telemetry()
    ctx2d.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace"
    ctx2d.fillStyle = "#d5e0e6"
    const rx = rightX + 14
    let ry = pad + 40

    const lines = [
      `State       ${tel.state} ${tel.muted ? "(MUTED)" : ""}`,
      `Voices      ${tel.activeVoices} / ${tel.maxVoices} (stolen ${tel.stolenVoices}, dropped ${tel.droppedVoices})`,
      `Seed        ${settings.seed} · Rate ${settings.rate.toFixed(2)}x`,
      `Space       ${settings.distance}m · Pan ${settings.pan.toFixed(2)} · Wet ${settings.reverbWet.toFixed(2)}`,
      `Occlusion   ${settings.occluded ? "OCCLUDED (950 Hz LP + Reverb)" : "OPEN LINE OF SIGHT"}`,
      `Drivetrain  Gear ${vehicleEmitter.gearbox.gear + 1} · ${Math.round(settings.rpm > 0 ? settings.rpm : vehicleEmitter.gearbox.rpm)} RPM`,
      `Nitro Gate  Ignitions ${vehicleEmitter.nitroState.ignitions} · Voices ${vehicleEmitter.nitroState.voices}`,
    ]
    if (lastStats) {
      lines.push(
        `Peak / RMS  ${lastStats.peakDb.toFixed(2)} dBFS / ${lastStats.approxLufs.toFixed(2)} LUFS`,
        `Clipped     ${lastStats.clippedSamples} samples`,
        `Centroid    ${Math.round(lastStats.spectralCentroidHz)} Hz · HighBand ${(lastStats.highBandRatio * 100).toFixed(1)}%`,
        `Reverb Tail ${(lastStats.tailRms * 1000).toFixed(2)} mRMS`,
      )
    }
    if (lastAb) {
      lines.push(
        `A/B Occl Δ  -${Math.round(lastAb.delta.centroidDropHz)} Hz centroid`,
        `A/B Verb Δ  ${lastAb.delta.reverbTailGainRatio.toFixed(2)}x tail energy`,
      )
    }

    for (const line of lines) {
      ctx2d.fillText(line, rx, ry)
      ry += 20
    }

    // Category bus activity bars
    ry += 10
    ctx2d.fillStyle = "#8fa3b0"
    ctx2d.fillText("CATEGORY BUSES", rx, ry)
    ry += 14
    const cats: MixCategory[] = ["engine", "tyre", "impact", "ambience", "spell", "ui"]
    for (const cat of cats) {
      const count = tel.categoryVoices[cat]
      const activeEmitter =
        (cat === "engine" || cat === "tyre") && settings.playing && settings.source === "emitter_vehicle"
          ? 1
          : cat === "spell" && settings.playing && settings.source === "emitter_spell"
            ? 1
            : 0
      const fill = clamp((count + activeEmitter) / 4, 0, 1)
      ctx2d.fillStyle = "#9ab0bd"
      ctx2d.fillText(cat.padEnd(9, " "), rx, ry + 10)
      const barX = rx + 78
      const barW = Math.max(40, rightW - 110)
      ctx2d.fillStyle = "#1b252c"
      ctx2d.fillRect(barX, ry, barW, 12)
      ctx2d.fillStyle = fill > 0 ? "#72d0e0" : "#2e3d47"
      ctx2d.fillRect(barX, ry, Math.max(4, barW * (fill || 0.06)), 12)
      ry += 20
    }
  }

  const section: AudioLabSection = {
    id: "audio",
    label: "Audio",
    settings: settings as unknown as Record<string, boolean | number | string>,
    controls,
    enter() {
      replayTime = 0
      void renderPreviewOffline().then(() => {
        if (hudCanvas) drawVisualizer(hudCanvas)
      })
    },
    leave() {
      stopAll()
    },
    update,
    telemetry,
  }

  return {
    section,
    runtime,
    vehicleEmitter,
    spellEmitter,
    settings,
    get lastStats() {
      return lastStats
    },
    get lastWav() {
      return lastWav
    },
    get lastAb() {
      return lastAb
    },
    get lastReplay() {
      return lastReplay
    },
    triggerCurrent,
    renderAbComparison,
    renderReplay,
    stopAll,
    drawVisualizer(canvas: HTMLCanvasElement) {
      hudCanvas = canvas
      drawVisualizer(canvas)
    },
    dispose() {
      vehicleEmitter.dispose()
      spellEmitter.dispose()
      runtime.dispose()
    },
  }
}

function drawPanelBox(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, title: string): void {
  ctx.fillStyle = "#11191f"
  ctx.fillRect(x, y, w, h)
  ctx.strokeStyle = "#ffffff22"
  ctx.lineWidth = 1
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
  ctx.fillStyle = "#94a7b3"
  ctx.font = "600 10px ui-monospace, SFMono-Regular, Menlo, monospace"
  ctx.fillText(title, x + 12, y + 18)
}

/**
 * Factory compatible with `fx-kit` / `@arcade/kit/lab` `SectionFactory`.
 */
export function createAudioLab(context?: AudioLabContextLike): AudioLabSection {
  return createAudioLabController(context).section
}

/**
 * Mounts the Audio Lab on a standalone page using the shared `LabPanel` (`packages/kit/lab-panel.ts`)
 * and a 2D waveform/spectrogram canvas. Never autoplays audio; exposes `window.audioLab` for proof automation.
 */
export async function mountAudioLab(root: HTMLElement = document.body): Promise<AudioLabController & { panel: LabPanel; canvas: HTMLCanvasElement }> {
  document.title = "Audio Lab"
  root.innerHTML = `<canvas tabindex="0" aria-label="Audio Lab visualizer" style="display:block;width:100vw;height:100dvh;background:#0b1014"></canvas>`
  const canvas = root.querySelector("canvas")!
  let panel: LabPanel | undefined
  const controller = createAudioLabController({
    sync: () => panel?.sync(),
  })
  panel = new LabPanel(
    controller.section.settings,
    [...controller.section.controls],
    new URLSearchParams(location.search),
    () => {},
    { open: true, presets: false, shortcut: true, capture: "focus" },
  )

  const resize = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.max(320, Math.floor(window.innerWidth * dpr))
    canvas.height = Math.max(240, Math.floor(window.innerHeight * dpr))
    controller.drawVisualizer(canvas)
  }
  window.addEventListener("resize", resize)
  resize()

  await controller.triggerCurrent()
  await controller.renderAbComparison()
  panel.header.textContent = controller.section.telemetry!()
  controller.drawVisualizer(canvas)

  const bench = new URLSearchParams(location.search).has("bench")
  let last = 0
  const tick = (now: number) => {
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60
    last = now
    if (!bench && !document.hidden) {
      controller.section.update?.(dt)
      panel!.header.textContent = controller.section.telemetry!()
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  const handle = Object.assign(controller, { panel, canvas })
  ;(window as unknown as { audioLab?: typeof handle }).audioLab = handle
  return handle
}
