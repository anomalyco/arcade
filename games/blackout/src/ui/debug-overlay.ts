import { keyLabelSetting } from "@arcade/kit/client/controls"
import { LabPanel, type LabControl } from "@arcade/kit/lab-panel"
import { PerfSampler, type FramePerfSample } from "@arcade/kit/gpu-perf"
import { applyFeelPreset, createFeelSettings, feelControls } from "@arcade/kit/feel"
import { animationControls, animationLab } from "../game/anim-settings"
import { motionSettings } from "../render/motion"
import { bloodSplatterSettings } from "../game/splatter"
import { LIGHT_DEFAULTS, type LightSettings } from "@arcade/kit/vehicle/lights"
import { lightControls } from "@arcade/kit/vehicle/lab"
import { SPELL_CONTROLS, spellDefaults, type SpellConfig } from "../../shared/sim/spell-config"

export const blackoutFeelSettings = createFeelSettings("blackout")

export const JUICE_LABELS = {
  volumes: "Volume Smoke",
  wizards: "Wizards",
  monitors: "Monitor Lights", chairs: "Chair Shadows", ao: "Multi-Bounce AO",
  paper: "Fluttering Paper", glass: "Glass Shards",
  sparks: "Monitor Sparks", casings: "Shell Casings", trauma: "Shake & Kill Punch",
  vehicleSprings: "Chassis springs", vehicleWheels: "Vehicle wheels", vehicleLamps: "Vehicle lamps",
  vehicleSkids: "Tyre skids", tyreSmoke: "Tyre smoke", vehicleSparks: "Contact sparks",
  backfire: "Exhaust pops", vehicleImpact: "Vehicle impact", vehicleAudio: "Vehicle audio",
} as const
export const LOOK_LABELS = {
  lookGrade: "Teal & Warm Grade", lookPractical: "Warm Practicals", lookWalls: "Warm Wall Faces",
  lookAO: "Corner & Contact AO", lookCaps: "Blue Cap Rims", lookFloors: "Floor Weave & Tile",
  lookCity: "City Depth", lookGloss: "Tile Reflections", lookShadows: "Long Furniture Shadows",
  lookShadowFilter: "Smooth Polar Shadows", lookMotion: "Motion Blur",
} as const
export type BlackoutEffectsSettings = Record<keyof typeof JUICE_LABELS, boolean> & {
  monitorIntensity: number
  aoStrength: number
}
export type BlackoutLookFlags = Record<keyof typeof LOOK_LABELS, boolean>
export type BlackoutSpellSettings = SpellConfig & { wizardPitch: number }

export type BlackoutSubsystems = {
  effects: BlackoutEffectsSettings
  look: BlackoutLookFlags
  vehicleLights: LightSettings
  spells: BlackoutSpellSettings
}

export type Juice = BlackoutEffectsSettings &
  BlackoutLookFlags &
  LightSettings &
  BlackoutSpellSettings

const SUBSYSTEMS_BY_JUICE = new WeakMap<Juice, BlackoutSubsystems>()

export function blackoutSubsystems(flat: Juice): BlackoutSubsystems {
  const existing = SUBSYSTEMS_BY_JUICE.get(flat)
  if (existing) return existing
  const effectsKeys = [...Object.keys(JUICE_LABELS), "monitorIntensity", "aoStrength"] as (keyof BlackoutEffectsSettings)[]
  const lookKeys = Object.keys(LOOK_LABELS) as (keyof BlackoutLookFlags)[]
  const lightKeys = Object.keys(LIGHT_DEFAULTS) as (keyof LightSettings)[]
  const spellKeys = [...Object.keys(spellDefaults()), "wizardPitch"] as (keyof BlackoutSpellSettings)[]

  const makeView = <K extends keyof Juice>(keys: readonly K[]) => {
    const view = {} as Pick<Juice, K>
    for (const k of keys) {
      Object.defineProperty(view, k, {
        enumerable: true,
        configurable: true,
        get: () => flat[k],
        set: (v) => {
          flat[k] = v
        },
      })
    }
    return view
  }

  const subsystems: BlackoutSubsystems = {
    effects: makeView(effectsKeys),
    look: makeView(lookKeys),
    vehicleLights: makeView(lightKeys),
    spells: makeView(spellKeys),
  }
  SUBSYSTEMS_BY_JUICE.set(flat, subsystems)
  return subsystems
}

export const juiceSettings = (enabled = true): Juice => {
  const flat: Juice = {
    volumes: enabled, monitors: enabled, chairs: enabled, ao: enabled, monitorIntensity: 1, aoStrength: 1, paper: enabled, glass: enabled, sparks: enabled, casings: enabled, trauma: enabled,
    lookGrade: enabled, lookPractical: enabled, lookWalls: enabled, lookAO: enabled, lookCaps: enabled, lookFloors: enabled, lookCity: enabled, lookGloss: enabled, lookShadows: false,
    lookShadowFilter: enabled, lookMotion: false,
    vehicleSprings: enabled, vehicleWheels: enabled, vehicleLamps: enabled, vehicleSkids: enabled, tyreSmoke: enabled,
    vehicleSparks: enabled, backfire: enabled, vehicleImpact: enabled, vehicleAudio: enabled, ...LIGHT_DEFAULTS, style: 4,
    ...spellDefaults(), wizardPitch: 0.9, wizards: false,
  }
  blackoutSubsystems(flat)
  return flat
}

export type BlackoutPresetV2 = {
  version: 2
  subsystems: Partial<{
    effects: Partial<BlackoutEffectsSettings>
    look: Partial<BlackoutLookFlags>
    vehicleLights: Partial<LightSettings>
    spells: Partial<BlackoutSpellSettings>
    motion: Partial<typeof motionSettings>
    blood: Partial<typeof bloodSplatterSettings>
  }>
}

export function migrateBlackoutPreset(raw: unknown): { ok: true; preset: BlackoutPresetV2; migratedFrom: 1 | 2 } | { ok: false; error: string } {
  const parsed = typeof raw === "string" ? (() => { try { return JSON.parse(raw) } catch { return null } })() : raw
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Blackout preset must be a JSON object." }
  }
  const obj = parsed as Record<string, unknown>
  if ("version" in obj && obj.version !== 1 && obj.version !== 2) {
    return { ok: false, error: `Unsupported Blackout preset version: ${String(obj.version)}.` }
  }
  if (obj.version === 2 && obj.subsystems && typeof obj.subsystems === "object" && !Array.isArray(obj.subsystems)) {
    return { ok: true, preset: { version: 2, subsystems: obj.subsystems as BlackoutPresetV2["subsystems"] }, migratedFrom: 2 }
  }
  const src = obj.version === 1 && obj.settings && typeof obj.settings === "object" ? (obj.settings as Record<string, unknown>) : obj
  const template = blackoutSubsystems(juiceSettings(true))
  const subsystems: BlackoutPresetV2["subsystems"] = {}
  for (const [k, v] of Object.entries(src)) {
    if (k in template.effects && (typeof v === "boolean" || typeof v === "number")) {
      ;(subsystems.effects ??= {})[k as keyof BlackoutEffectsSettings] = v as never
    } else if (k in template.look && typeof v === "boolean") {
      ;(subsystems.look ??= {})[k as keyof BlackoutLookFlags] = v
    } else if (k in template.vehicleLights && typeof v === "number") {
      ;(subsystems.vehicleLights ??= {})[k as keyof LightSettings] = v as never
    } else if (k in template.spells && typeof v === "number") {
      ;(subsystems.spells ??= {})[k as keyof BlackoutSpellSettings] = v as never
    }
  }
  return { ok: true, preset: { version: 2, subsystems }, migratedFrom: 1 }
}
/** Bit layout shared with sceneShader; grade also uses bit zero in the composite. */
const LOOK_KEYS = Object.keys(LOOK_LABELS) as (keyof typeof LOOK_LABELS)[]
export function lookMask(settings: Juice): number {
  let bits = 0
  for (let i = 0; i < LOOK_KEYS.length; i++) if (settings[LOOK_KEYS[i]!]) bits |= 1 << i
  return bits
}
export type Perf = FramePerfSample
const controls: LabControl[] = [
  {key:"wizardPitch",label:"Camera angle",min:0.7,max:1.2,step:0.05,group:"Spells"},
  ...Object.entries(SPELL_CONTROLS).filter(([key])=>!key.endsWith("Threshold")).map(([key,c]) => ({ key, label: c.label, min: c.min, max: c.max, step: c.step, group: "Spells" })),
  ...Object.entries(JUICE_LABELS).map(([key, label]) => ({ key, label })),
  ...Object.entries(LOOK_LABELS).map(([key, label]) => ({ key, label, group: "Look" })),
]

export class DebugOverlay extends LabPanel {
  private readonly sampler = new PerfSampler(180)
  constructor(settings: Juice, params: URLSearchParams, release: () => void = () => {}, extra: LabControl[] = []) {
    super(animationLab(settings, params), [...controls, ...animationControls, ...extra], params, release)
    this.addControls(settings, lightControls.filter(c => c.key !== "style").map(c => ({ ...c, group: "Vehicle lights" })))
    this.addControls(bloodSplatterSettings,[{key:"style",label:"Style",group:"Blood",type:"select",options:[{value:0,label:"Current"},{value:1,label:"Surface splatter"}]}])
    this.addControls(motionSettings,[
      {key:"strength",label:"Strength",group:"Motion",min:0,max:2,step:.05},
      {key:"shutter",label:"Shutter",group:"Motion",min:0,max:1,step:.05},
    ])
    const keyLabels = keyLabelSetting()
    this.addControls(keyLabels.settings, [keyLabels.control], keyLabels.defaults)
    this.addControls(
      blackoutFeelSettings as unknown as Record<string, string | number | boolean>,
      feelControls.map(c =>
        c.key === "feelPreset"
          ? {
              ...c,
              folded: true,
              change: () => {
                applyFeelPreset(blackoutFeelSettings, blackoutFeelSettings.feelPreset)
                this.refresh()
              },
            }
          : { ...c, folded: true },
      ),
    )
  }
  sample(now: number, elapsed: number, gpu: Pick<Perf, "gpuMs" | "gpuKind" | "draws" | "verts">, chunks: number, lights: number): Perf | null {
    return this.sampler.update(now, elapsed, { ...gpu, chunks, lights }, this.header)
  }
}
