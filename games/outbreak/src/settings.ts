import { cameraShakeDefaults, type CameraShakeSettings } from "@arcade/kit/client/camera"
import { motionBlurDefaults, type MotionBlurSettings } from "@arcade/kit/gpu/motion-blur"
import type { LabControl, LabPanel, LabSettings, LabValue } from "@arcade/kit/lab-panel"
import type { LookPresetId } from "@arcade/kit/look"
import { migrateKnobsVariantJson } from "@arcade/kit/lab-tuning"
import { aiControls, DEFAULT_AI_CONFIG, type AIConfig } from "../shared/ai"
import { DEFAULT_MELEE_TUNING, type MeleeTuning } from "../shared/combat"
import { DEFAULT_FLASHLIGHT_TUNING, type FlashlightTuning } from "../shared/flashlight"
import { DEFAULT_PROGRESSION_TUNING, type ProgressionTuning } from "../shared/progression"
import { DEFAULT_STAMINA_TUNING, type StaminaTuning } from "../shared/stamina"
import { DEFAULT_VEHICLE_TUNING, type VehicleTuning } from "../shared/vehicles"
import type { WorldMode } from "../shared/world"
import { DEFAULT_AUDIO_SETTINGS, type AudioSettings } from "./audio"
import { DEFAULT_FOG_OF_WAR, type FogOfWarSettings } from "./fog-of-war"
import { DEFAULT_GROUND_SETTINGS, type GroundSettings } from "./ground"
import { DEFAULT_HUD_SETTINGS, type HudSettings } from "./hud"
import {
  DEFAULT_FLASHLIGHT_BEAM,
  DEFAULT_OUTBREAK_LIGHTING,
  OUTBREAK_LOOK_LIGHTING_PRESETS,
  type FlashlightBeamSettings,
  type OutbreakLightingSettings,
} from "./lighting"
import { survivorAimTuning, type SurvivorAimTuning } from "./survivor"
import { DEFAULT_OUTBREAK_WEATHER, type OutbreakWeatherSettings } from "./weather"
import { zombieTuning, type ZombieTuning } from "./zombie-profile"

export type OutbreakFlashlightSettings = FlashlightTuning & FlashlightBeamSettings
export type OutbreakZombieSettings = ZombieTuning & { humanProfile: number }

export type OutbreakWorldSettings = {
  worldMode: number
  houseSeed: number
  terrain: number
  foliageDensity: number
  houseDecay: number
  weathering: number
}

export type OutbreakVisionSettings = {
  cone: number
  awareness: number
  range: number
  shroud: number
}

export type OutbreakMaterialSettings = {
  textures: number
  rugStyle: number
  wallStyle: number
  floorStyle: number
  texScale: number
  texContrast: number
  texRoughness: number
}

export type OutbreakDayCycleSettings = {
  hour: number
  timeScale: number
  dayNightLook: number
  lookPreset: LookPresetId
}

export type OutbreakViewSettings = CameraShakeSettings & {
  zoom: number
  diagnostic: number
}

export type OutbreakCombatSettings = MeleeTuning & {
  infiniteAmmo: number
  bloodStyle: number
}

export const DEFAULT_OUTBREAK_FLASHLIGHT: OutbreakFlashlightSettings = {
  ...DEFAULT_FLASHLIGHT_TUNING,
  ...DEFAULT_FLASHLIGHT_BEAM,
}

export const DEFAULT_OUTBREAK_ZOMBIES: OutbreakZombieSettings = {
  humanProfile: 0,
  ...zombieTuning,
}

export const DEFAULT_OUTBREAK_WORLD: OutbreakWorldSettings = {
  worldMode: 1,
  houseSeed: 7,
  terrain: 0.22,
  foliageDensity: 1,
  houseDecay: 0,
  weathering: 1,
}

export const DEFAULT_OUTBREAK_VISION: OutbreakVisionSettings = {
  cone: 110,
  awareness: 2.5,
  range: 27,
  shroud: 0.32,
}

export const DEFAULT_OUTBREAK_MATERIALS: OutbreakMaterialSettings = {
  textures: 1,
  rugStyle: 0,
  wallStyle: 0,
  floorStyle: 0,
  texScale: 1.0,
  texContrast: 1.0,
  texRoughness: 0.0,
}

export const DEFAULT_OUTBREAK_DAY_CYCLE: OutbreakDayCycleSettings = {
  hour: DEFAULT_AI_CONFIG.startHour,
  timeScale: 120,
  dayNightLook: 1,
  lookPreset: "noir",
}

export const DEFAULT_OUTBREAK_VIEW: OutbreakViewSettings = {
  zoom: 46,
  diagnostic: 0,
  ...cameraShakeDefaults(),
}

export const DEFAULT_OUTBREAK_COMBAT: OutbreakCombatSettings = {
  infiniteAmmo: 0,
  bloodStyle: 1,
  ...DEFAULT_MELEE_TUNING,
}

export const DEFAULT_OUTBREAK_MOTION: MotionBlurSettings = {
  ...motionBlurDefaults(),
  strength: 0,
}

export type OutbreakSubsystemMap = {
  lighting: OutbreakLightingSettings
  fog: FogOfWarSettings
  ai: AIConfig
  stamina: StaminaTuning
  flashlight: OutbreakFlashlightSettings
  ground: GroundSettings
  weather: OutbreakWeatherSettings
  zombies: OutbreakZombieSettings
  survivor: SurvivorAimTuning
  hud: HudSettings
  audio: AudioSettings
  progression: ProgressionTuning
  world: OutbreakWorldSettings
  vision: OutbreakVisionSettings
  materials: OutbreakMaterialSettings
  dayCycle: OutbreakDayCycleSettings
  view: OutbreakViewSettings
  combat: OutbreakCombatSettings
  motion: MotionBlurSettings
  vehicle: VehicleTuning
}

export type OutbreakSubsystemKey = keyof OutbreakSubsystemMap

/**
 * Outbreak settings namespaced by subsystem.
 * Non-enumerable forwarding accessors keep flat property reads/writes working during transitions while `Object.keys(settings)`
 * stays strictly the subsystem namespaces (`lighting`, `fog`, `ai`, `stamina`, `flashlight`, `ground`, `weather`, `zombies`, ...).
 */
export type OutbreakSettings = OutbreakSubsystemMap &
  OutbreakLightingSettings &
  FogOfWarSettings &
  Omit<AIConfig, "walkSpeed"> &
  StaminaTuning &
  OutbreakFlashlightSettings &
  GroundSettings &
  OutbreakWeatherSettings &
  OutbreakZombieSettings &
  SurvivorAimTuning &
  HudSettings &
  AudioSettings &
  ProgressionTuning &
  OutbreakWorldSettings &
  OutbreakVisionSettings &
  OutbreakMaterialSettings &
  OutbreakDayCycleSettings &
  OutbreakViewSettings &
  OutbreakCombatSettings &
  MotionBlurSettings &
  VehicleTuning

export const OUTBREAK_SUBSYSTEM_KEYS: readonly OutbreakSubsystemKey[] = [
  "lighting",
  "fog",
  "ai",
  "stamina",
  "flashlight",
  "ground",
  "weather",
  "zombies",
  "survivor",
  "hud",
  "audio",
  "progression",
  "world",
  "vision",
  "materials",
  "dayCycle",
  "view",
  "combat",
  "motion",
  "vehicle",
] as const

export function createOutbreakSubsystemDefaults(): OutbreakSubsystemMap {
  return {
    lighting: {
      ...DEFAULT_OUTBREAK_LIGHTING,
      ...OUTBREAK_LOOK_LIGHTING_PRESETS.noir,
    },
    fog: { ...DEFAULT_FOG_OF_WAR },
    ai: { ...DEFAULT_AI_CONFIG },
    stamina: { ...DEFAULT_STAMINA_TUNING },
    flashlight: { ...DEFAULT_OUTBREAK_FLASHLIGHT },
    ground: { ...DEFAULT_GROUND_SETTINGS },
    weather: { ...DEFAULT_OUTBREAK_WEATHER },
    zombies: { ...DEFAULT_OUTBREAK_ZOMBIES },
    survivor: { ...survivorAimTuning },
    hud: { ...DEFAULT_HUD_SETTINGS },
    audio: { ...DEFAULT_AUDIO_SETTINGS },
    progression: { ...DEFAULT_PROGRESSION_TUNING },
    world: { ...DEFAULT_OUTBREAK_WORLD },
    vision: { ...DEFAULT_OUTBREAK_VISION },
    materials: { ...DEFAULT_OUTBREAK_MATERIALS },
    dayCycle: { ...DEFAULT_OUTBREAK_DAY_CYCLE },
    view: { ...DEFAULT_OUTBREAK_VIEW },
    combat: { ...DEFAULT_OUTBREAK_COMBAT },
    motion: { ...DEFAULT_OUTBREAK_MOTION },
    vehicle: { ...DEFAULT_VEHICLE_TUNING },
  }
}

type KeyTarget = { subsystem: OutbreakSubsystemKey; field: string; sample: unknown }

const DEFAULTS_TEMPLATE = createOutbreakSubsystemDefaults()

const KEY_ROUTING: Readonly<Record<string, KeyTarget>> = (() => {
  const map: Record<string, KeyTarget> = {}
  for (const sub of OUTBREAK_SUBSYSTEM_KEYS) {
    const bag = DEFAULTS_TEMPLATE[sub] as Record<string, unknown>
    for (const [field, sample] of Object.entries(bag)) {
      map[`${sub}.${field}`] = { subsystem: sub, field, sample }
      // `walkSpeed` without prefix belongs to `stamina.walkSpeed`; `ai.walkSpeed` (and legacy `aiWalkSpeed`) routes to `ai.walkSpeed`.
      if (sub === "ai" && field === "walkSpeed") continue
      map[field] = { subsystem: sub, field, sample }
    }
  }
  map.aiWalkSpeed = { subsystem: "ai", field: "walkSpeed", sample: DEFAULTS_TEMPLATE.ai.walkSpeed }
  for (const field of ["startHour", "safeRadius", "initialDensity", "rampTime", "noiseSensitivity", "maxActiveNearPlayer"] as const) {
    map[`pacing.${field}`] = { subsystem: "ai", field, sample: DEFAULTS_TEMPLATE.ai[field] }
  }
  return map
})()

export function resolveOutbreakSettingTarget(rawKey: string): KeyTarget | null {
  return KEY_ROUTING[rawKey] ?? null
}

function attachCompatibilityForwarders(target: OutbreakSubsystemMap): OutbreakSettings {
  for (const sub of OUTBREAK_SUBSYSTEM_KEYS) {
    const bag = target[sub] as Record<string, unknown>
    for (const field of Object.keys(bag)) {
      if (sub === "ai" && field === "walkSpeed") continue
      if (field in target) continue
      Object.defineProperty(target, field, {
        enumerable: false,
        configurable: true,
        get: () => bag[field],
        set: (v) => {
          bag[field] = v
        },
      })
    }
  }
  return target as OutbreakSettings
}

export function resolveWorldMode(v: number): WorldMode {
  return v === 0 ? "classic" : v === 2 ? "procedural" : "streaming"
}

export function createOutbreakSettings(params?: URLSearchParams): OutbreakSettings {
  const subsystems = createOutbreakSubsystemDefaults()
  const settings = attachCompatibilityForwarders(subsystems)
  if (params) {
    migrateOutbreakUrlParams(params, settings)
  }
  return settings
}

export function getOutbreakSetting(settings: OutbreakSubsystemMap, key: string): LabValue | undefined {
  const target = resolveOutbreakSettingTarget(key)
  if (!target) return undefined
  const bag = settings[target.subsystem] as Record<string, LabValue>
  return bag[target.field]
}

export function setOutbreakSetting(settings: OutbreakSubsystemMap, key: string, value: LabValue): boolean {
  const target = resolveOutbreakSettingTarget(key)
  if (!target) return false
  const bag = settings[target.subsystem] as Record<string, LabValue>
  bag[target.field] = value
  return true
}

/**
 * Binds `LabControl[]` to their owning subsystem namespaces on `OutbreakSettings` so `LabPanel` and `@arcade/knobs`
 * read and write `settings.lighting`, `settings.ai`, `settings.stamina`, `settings.flashlight`, `settings.ground`, etc. directly.
 */
export function bindOutbreakLabControls(
  lab: LabPanel,
  settings: OutbreakSubsystemMap,
  controls: readonly LabControl[],
): void {
  const defaults = createOutbreakSubsystemDefaults()
  for (const control of controls) {
    if (control.type === "action") {
      lab.addControls({}, [control])
      continue
    }
    const target = resolveOutbreakSettingTarget(control.key)
    if (target) {
      const subSettings = settings[target.subsystem] as unknown as LabSettings
      const subDefaults = defaults[target.subsystem] as unknown as LabSettings
      lab.addControls(subSettings, [control], subDefaults)
    } else {
      lab.addControls(settings as unknown as LabSettings, [control])
    }
  }
}

export const OUTBREAK_PRESET_VERSION = 2 as const

export type OutbreakPresetSubsystems = Partial<{
  [K in OutbreakSubsystemKey]: Partial<OutbreakSubsystemMap[K]>
}>

export type OutbreakPresetV2 = {
  version: typeof OUTBREAK_PRESET_VERSION
  subsystems: OutbreakPresetSubsystems
}

export function exportOutbreakPreset(settings: OutbreakSubsystemMap): OutbreakPresetV2 {
  const subsystems: OutbreakPresetSubsystems = {}
  for (const sub of OUTBREAK_SUBSYSTEM_KEYS) {
    ;(subsystems as Record<string, unknown>)[sub] = { ...settings[sub] }
  }
  return {
    version: OUTBREAK_PRESET_VERSION,
    subsystems,
  }
}

function validateAndCoerceValue(sample: unknown, value: unknown): { ok: true; value: LabValue } | { ok: false; error: string } {
  if (typeof sample === "number") {
    if (typeof value === "number" && Number.isFinite(value)) return { ok: true, value }
    if (typeof value === "boolean") return { ok: true, value: value ? 1 : 0 }
    return { ok: false, error: `Expected finite number, got ${String(value)}.` }
  }
  if (typeof sample === "boolean") {
    if (typeof value === "boolean") return { ok: true, value }
    if (value === 0 || value === 1) return { ok: true, value: Boolean(value) }
    return { ok: false, error: `Expected boolean, got ${String(value)}.` }
  }
  if (typeof sample === "string") {
    if (typeof value === "string" && value.length > 0) return { ok: true, value }
    return { ok: false, error: `Expected non-empty string, got ${String(value)}.` }
  }
  return { ok: false, error: "Unsupported setting type." }
}

/**
 * Validates and migrates an Outbreak preset from:
 * - Version 2 namespaced schema (`{ version: 2, subsystems: { lighting: {...}, ai: {...}, ... } }`)
 * - Version 1 flat schema (`{ version: 1, settings: { exposure: 1.1, aiWalkSpeed: 1.2, walkSpeed: 3.6, ... } }`)
 * - Unversioned flat or dotted dictionary (such as a Knobs Copy payload)
 */
export function migrateOutbreakPreset(
  raw: unknown,
): { ok: true; preset: OutbreakPresetV2; migratedFrom: 1 | 2 } | { ok: false; error: string } {
  let parsed: unknown = raw
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { ok: false, error: "Invalid JSON syntax." }
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Outbreak preset must be a JSON object." }
  }

  const obj = parsed as Record<string, unknown>
  if ("version" in obj && obj.version !== 1 && obj.version !== 2) {
    return { ok: false, error: `Unsupported Outbreak preset version: ${String(obj.version)} (expected 1 or 2).` }
  }

  const out: OutbreakPresetSubsystems = {}
  const ensureSub = (sub: OutbreakSubsystemKey): Record<string, LabValue> => {
    let bag = out[sub] as Record<string, LabValue> | undefined
    if (!bag) {
      bag = {}
      ;(out as Record<string, unknown>)[sub] = bag
    }
    return bag
  }

  // Version 2 namespaced payload
  if (obj.version === 2) {
    const container =
      obj.subsystems && typeof obj.subsystems === "object" && !Array.isArray(obj.subsystems)
        ? (obj.subsystems as Record<string, unknown>)
        : obj.settings && typeof obj.settings === "object" && !Array.isArray(obj.settings)
          ? (obj.settings as Record<string, unknown>)
          : null
    if (!container) {
      return { ok: false, error: "Version 2 Outbreak preset requires a 'subsystems' object." }
    }
    for (const [subKey, subVal] of Object.entries(container)) {
      if (OUTBREAK_SUBSYSTEM_KEYS.includes(subKey as OutbreakSubsystemKey)) {
        if (!subVal || typeof subVal !== "object" || Array.isArray(subVal)) {
          return { ok: false, error: `Subsystem "${subKey}" must be an object.` }
        }
        const sub = subKey as OutbreakSubsystemKey
        const defaultsBag = DEFAULTS_TEMPLATE[sub] as Record<string, unknown>
        for (const [field, rawVal] of Object.entries(subVal as Record<string, unknown>)) {
          const resolvedField = sub === "ai" && field === "aiWalkSpeed" ? "walkSpeed" : field
          if (!(resolvedField in defaultsBag)) continue
          const checked = validateAndCoerceValue(defaultsBag[resolvedField], rawVal)
          if (!checked.ok) {
            return { ok: false, error: `Invalid value for ${sub}.${resolvedField}: ${checked.error}` }
          }
          ensureSub(sub)[resolvedField] = checked.value
        }
      } else {
        const target = resolveOutbreakSettingTarget(subKey)
        if (!target) continue
        const checked = validateAndCoerceValue(target.sample, subVal)
        if (!checked.ok) {
          return { ok: false, error: `Invalid value for ${subKey}: ${checked.error}` }
        }
        ensureSub(target.subsystem)[target.field] = checked.value
      }
    }
    return {
      ok: true,
      preset: { version: OUTBREAK_PRESET_VERSION, subsystems: out },
      migratedFrom: 2,
    }
  }

  // Version 1 flat payload or unversioned dictionary
  const flatSource =
    obj.version === 1
      ? obj.settings && typeof obj.settings === "object" && !Array.isArray(obj.settings)
        ? (obj.settings as Record<string, unknown>)
        : null
      : obj
  if (!flatSource) {
    return { ok: false, error: "Version 1 Outbreak preset requires a 'settings' object." }
  }

  for (const [rawKey, rawVal] of Object.entries(flatSource)) {
    if (rawKey === "version" || rawKey === "section") continue
    if (
      OUTBREAK_SUBSYSTEM_KEYS.includes(rawKey as OutbreakSubsystemKey) &&
      rawVal &&
      typeof rawVal === "object" &&
      !Array.isArray(rawVal)
    ) {
      const sub = rawKey as OutbreakSubsystemKey
      const defaultsBag = DEFAULTS_TEMPLATE[sub] as Record<string, unknown>
      for (const [field, val] of Object.entries(rawVal as Record<string, unknown>)) {
        const resolvedField = sub === "ai" && field === "aiWalkSpeed" ? "walkSpeed" : field
        if (!(resolvedField in defaultsBag)) continue
        const checked = validateAndCoerceValue(defaultsBag[resolvedField], val)
        if (!checked.ok) {
          return { ok: false, error: `Invalid value for ${sub}.${resolvedField}: ${checked.error}` }
        }
        ensureSub(sub)[resolvedField] = checked.value
      }
      continue
    }
    const target = resolveOutbreakSettingTarget(rawKey)
    if (!target) continue
    const checked = validateAndCoerceValue(target.sample, rawVal)
    if (!checked.ok) {
      return { ok: false, error: `Invalid value for ${rawKey}: ${checked.error}` }
    }
    ensureSub(target.subsystem)[target.field] = checked.value
  }

  return {
    ok: true,
    preset: { version: OUTBREAK_PRESET_VERSION, subsystems: out },
    migratedFrom: 1,
  }
}

export function applyOutbreakPreset(
  settings: OutbreakSubsystemMap,
  raw: unknown,
): { ok: true; preset: OutbreakPresetV2; migratedFrom: 1 | 2 } | { ok: false; error: string } {
  const migrated = migrateOutbreakPreset(raw)
  if (!migrated.ok) return migrated
  for (const sub of OUTBREAK_SUBSYSTEM_KEYS) {
    const patch = migrated.preset.subsystems[sub]
    if (patch) {
      Object.assign(settings[sub], patch)
    }
  }
  return migrated
}

/**
 * Migrates URL query parameters into subsystem-namespaced Outbreak settings overrides.
 * Supports session routing parameters (`?world=`, `?peaceful`, `?infiniteAmmo`) and both legacy flat (`?aiWalkSpeed=1.2`)
 * and subsystem-qualified (`?ai.walkSpeed=1.2`, `?lighting.exposure=1.1`) automation overrides.
 */
export function migrateOutbreakUrlParams(
  params: URLSearchParams,
  target?: OutbreakSubsystemMap,
): OutbreakPresetSubsystems {
  const out: OutbreakPresetSubsystems = {}
  const setField = (sub: OutbreakSubsystemKey, field: string, value: LabValue) => {
    let bag = out[sub] as Record<string, LabValue> | undefined
    if (!bag) {
      bag = {}
      ;(out as Record<string, unknown>)[sub] = bag
    }
    bag[field] = value
    if (target) {
      ;(target[sub] as Record<string, LabValue>)[field] = value
    }
  }

  if (params.has("world")) {
    const w = params.get("world")
    setField("world", "worldMode", w === "classic" ? 0 : w === "procedural" ? 2 : 1)
  }
  if (params.has("peaceful")) {
    setField("ai", "zombieCount", 0)
  }
  if (params.has("infiniteAmmo")) {
    const raw = params.get("infiniteAmmo")
    setField("combat", "infiniteAmmo", raw === "0" || raw === "false" ? 0 : 1)
  }

  const reserved = new Set(["world", "peaceful", "infiniteAmmo", "seed", "room", "r", "bench", "perf", "lab", "mux", "muxRun", "station", "name"])
  for (const [rawKey, rawVal] of params.entries()) {
    if (reserved.has(rawKey)) continue
    const routed = resolveOutbreakSettingTarget(rawKey)
    if (!routed) continue
    if (typeof routed.sample === "number") {
      const n = Number(rawVal)
      if (Number.isFinite(n)) {
        setField(routed.subsystem, routed.field, n)
        if (routed.field === "startHour" && !params.has("hour") && !params.has("dayCycle.hour")) {
          setField("dayCycle", "hour", n)
        }
      }
    } else if (typeof routed.sample === "boolean") {
      if (rawVal === "1" || rawVal === "true") setField(routed.subsystem, routed.field, true)
      else if (rawVal === "0" || rawVal === "false") setField(routed.subsystem, routed.field, false)
    } else if (typeof routed.sample === "string" && rawVal.trim()) {
      setField(routed.subsystem, routed.field, rawVal.trim())
    }
  }

  return out
}

export const OUTBREAK_PRESETS_STORAGE_V1 = "arcade.outbreak.presets.v1"
export const OUTBREAK_PRESETS_STORAGE_V2 = "arcade.outbreak.presets.v2"
export const OUTBREAK_KNOBS_VARIANTS_KEY = "knobs:lab%3Aarcade-outbreak:variants:v1"

/**
 * Migrates saved Outbreak presets (`arcade.outbreak.presets.v1` -> `v2`) and saved Knobs variants
 * (`knobs:lab%3Aarcade-outbreak:variants:v1`, rewriting legacy `aiWalkSpeed` to `ai.walkSpeed`) in `localStorage`.
 */
export function migrateOutbreakLocalStorage(
  storage?: Pick<Storage, "getItem" | "setItem"> | null,
): { migratedVariants: number; migratedPresets: number } {
  if (!storage) return { migratedVariants: 0, migratedPresets: 0 }
  let migratedVariants = 0
  let migratedPresets = 0

  try {
    const rawVariants = storage.getItem(OUTBREAK_KNOBS_VARIANTS_KEY)
    if (rawVariants) {
      const rows = aiControls.map((c) => ({ group: c.group, control: c as unknown as LabControl }))
      const nextVariants = migrateKnobsVariantJson(rawVariants, rows)
      if (nextVariants !== rawVariants) {
        storage.setItem(OUTBREAK_KNOBS_VARIANTS_KEY, nextVariants)
        migratedVariants++
      }
    }
  } catch {}

  try {
    const rawV1 = storage.getItem(OUTBREAK_PRESETS_STORAGE_V1)
    if (rawV1) {
      const parsedV1 = JSON.parse(rawV1) as Record<string, unknown>
      if (parsedV1 && typeof parsedV1 === "object" && !Array.isArray(parsedV1)) {
        const existingV2Raw = storage.getItem(OUTBREAK_PRESETS_STORAGE_V2)
        const existingV2: Record<string, OutbreakPresetV2> = existingV2Raw ? JSON.parse(existingV2Raw) : {}
        for (const [name, entry] of Object.entries(parsedV1)) {
          if (name in existingV2) continue
          const res = migrateOutbreakPreset(entry)
          if (res.ok) {
            existingV2[name] = res.preset
            migratedPresets++
          }
        }
        if (migratedPresets > 0) {
          storage.setItem(OUTBREAK_PRESETS_STORAGE_V2, JSON.stringify(existingV2))
        }
      }
    }
  } catch {}

  return { migratedVariants, migratedPresets }
}
