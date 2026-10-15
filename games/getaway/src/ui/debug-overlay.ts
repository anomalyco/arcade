import { keyLabelSetting } from "@arcade/kit/client/controls"
import { LabPanel, type LabControl } from "@arcade/kit/lab-panel"
import { PerfSampler, type FramePerfSample } from "@arcade/kit/gpu-perf"
import { chassisSettings } from "../game/chassis"
import { vehicleEffects } from "../game/vehicle-emissions"
import type { Scene } from "../game/scene"
import type { GameAudio } from "../audio/game-audio"
import type { LightSettings, LightStyle } from "../render/car-lights"
import { motionBlur } from "../render/motion"
import { lightControls } from "@arcade/kit/vehicle/lab"

/** Presentation only; these values never enter shared vehicle physics. */
export const juice = { ...chassisSettings(true), clutter: true, explosions: true, physicsDebug: false }
export type GetawayJuice = typeof juice

const juiceControls: LabControl[] = [
  { key: "clutter", label: "Street clutter", group: "Props" },
  { key: "explosions", label: "Explosions", group: "Props" },
  { key: "physicsDebug", label: "Physics debug", group: "Props" },
  ...([
    ["suspension", "Suspension springs"],
    ["wheelContact", "Per-wheel contact"],
    ["visibleWheels", "Steer & spin wheels"],
    ["vehicleFeel", "Vehicle-specific feel"],
  ] as const).map(([key, label]) => ({ key, label, group: "Chassis" })),
]

const emissionsControls: LabControl[] = [
  { key: "emissions", label: "Vehicle emissions", group: "Emissions" },
  { key: "coldExhaust", label: "Cold exhaust", group: "Emissions" },
]

export type GetawayPresetV2 = {
  version: 2
  subsystems: Partial<{
    juice: Partial<GetawayJuice>
    lights: Partial<LightSettings>
    emissions: Partial<{ emissions: boolean; coldExhaust: boolean }>
    motion: Partial<typeof motionBlur>
    audio: Partial<{ proceduralAudio: boolean }>
  }>
}

export function migrateGetawayPreset(raw: unknown): { ok: true; preset: GetawayPresetV2; migratedFrom: 1 | 2 } | { ok: false; error: string } {
  const parsed = typeof raw === "string" ? (() => { try { return JSON.parse(raw) } catch { return null } })() : raw
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Getaway preset must be a JSON object." }
  }
  const obj = parsed as Record<string, unknown>
  if ("version" in obj && obj.version !== 1 && obj.version !== 2) {
    return { ok: false, error: `Unsupported Getaway preset version: ${String(obj.version)}.` }
  }
  if (obj.version === 2 && obj.subsystems && typeof obj.subsystems === "object" && !Array.isArray(obj.subsystems)) {
    return { ok: true, preset: { version: 2, subsystems: obj.subsystems as GetawayPresetV2["subsystems"] }, migratedFrom: 2 }
  }
  const src = obj.version === 1 && obj.settings && typeof obj.settings === "object" ? (obj.settings as Record<string, unknown>) : obj
  const subsystems: GetawayPresetV2["subsystems"] = {}
  const lightKeys = new Set<string>(lightControls.map(c => c.key))
  for (const [k, v] of Object.entries(src)) {
    if (k in juice && typeof v === "boolean") {
      ;(subsystems.juice ??= {})[k as keyof GetawayJuice] = v
    } else if (lightKeys.has(k) && typeof v === "number" && Number.isFinite(v)) {
      ;(subsystems.lights ??= {})[k as keyof LightSettings] = v as never
    } else if ((k === "emissions" || k === "coldExhaust") && typeof v === "boolean") {
      ;(subsystems.emissions ??= {})[k] = v
    } else if (k in motionBlur && (typeof v === "number" || typeof v === "boolean")) {
      ;(subsystems.motion ??= {})[k as keyof typeof motionBlur] = v as never
    } else if (k === "proceduralAudio" && typeof v === "boolean") {
      ;(subsystems.audio ??= {}).proceduralAudio = v
    }
  }
  return { ok: true, preset: { version: 2, subsystems }, migratedFrom: 1 }
}

export type PerfSample = FramePerfSample
export class DebugOverlay extends LabPanel {
  private readonly sampler = new PerfSampler(120)
  get sample(): PerfSample { return this.sampler.sample }
  constructor(q: URLSearchParams, release: () => void, scene: Scene, sound?: GameAudio) {
    super(juice, [], q, release)
    const lightBag = scene.lightSettings as unknown as Record<string, boolean | number | string>
    this.addControls(
      lightBag,
      lightControls.map(control => ({
        ...control,
        ...("min" in control ? { enabled: (s: Readonly<Record<string, boolean | number | string>>) => s.style === 4 } : {}),
        ...(control.key === "style" ? { change: (v: boolean | number | string) => scene.setLightStyle(v as LightStyle) } : {}),
      })),
    )
    const emissionsBag: Record<string, boolean | number | string> = {}
    Object.defineProperties(emissionsBag, {
      emissions: { enumerable: true, configurable: true, get: () => scene.emissions.visible, set: (v) => { scene.emissions.visible = Boolean(v) } },
      coldExhaust: { enumerable: true, configurable: true, get: () => vehicleEffects.coldExhaust, set: (v) => { vehicleEffects.coldExhaust = Boolean(v) } },
    })
    this.addControls(emissionsBag, emissionsControls, { emissions: scene.emissions.visible, coldExhaust: vehicleEffects.coldExhaust })
    this.addControls(juice, juiceControls, { ...juice })
    if (sound) {
      const audioBag: Record<string, boolean | number | string> = {}
      Object.defineProperty(audioBag, "proceduralAudio", {
        enumerable: true,
        configurable: true,
        get: () => sound.procedural,
        set: (v) => { sound.reset(); sound.procedural = Boolean(v) },
      })
      this.addControls(audioBag, [{ key: "proceduralAudio", label: "Procedural audio", group: "Audio" }], { proceduralAudio: sound.procedural })
    }
    this.addControls(motionBlur, [
      {key:"enabled",label:"Motion blur",group:"Motion"},
      {key:"strength",label:"Strength",group:"Motion",min:0,max:2,step:.05},
      {key:"shutter",label:"Shutter",group:"Motion",min:0,max:1,step:.05},
    ])
    const keyLabels = keyLabelSetting()
    this.addControls(keyLabels.settings, [keyLabels.control], keyLabels.defaults)
  }
  reset() { this.sampler.reset() }
  update(now: number, frameMs: number, stats: Pick<PerfSample, "gpuMs" | "gpuKind" | "draws" | "verts" | "chunks" | "lights">) {
    return this.sampler.update(now, frameMs, stats, this.header) !== null
  }
}
