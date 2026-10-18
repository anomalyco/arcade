import { cameraShakeControls } from "@arcade/kit/client/camera"
import type { DiscoveryHost } from "./discovery/stage"
import { motionBlurControls } from "@arcade/kit/gpu/motion-blur"
import { cameraLeadControls, feelControls } from "./feel-tuning"
import type { LabControl, LabPanel } from "@arcade/kit/lab-panel"
import { LOOK_PRESETS, LOOK_PRESET_IDS, applyLookPreset, resolveLookPresetId, type LookSettings } from "@arcade/kit/look"
import {
  qualityControls,
  resolveQualityMode,
  saveQualityMode,
  type AdaptiveQualityController,
} from "@arcade/kit/quality"
import { aiControls } from "../shared/ai"
import { wrapHour } from "../shared/day-cycle"
import { flashlightControls } from "../shared/flashlight"
import { LocalSession } from "../shared/session"
import { staminaControls } from "../shared/stamina"
import { supportHeight } from "../shared/terrain"
import { audioControls } from "./audio"
import type { BotsLabController } from "./bots-lab"
import type { OutbreakCombatFX } from "./combat-fx"
import { applyOutbreakDayNight, DAY_NIGHT_CURVE_KEYS, DAY_NIGHT_CURVES } from "./day-night"
import type { OutbreakFeelTracker } from "./feel-events"
import { fogOfWarControls } from "./fog-of-war"
import { groundControls, randomizeGroundSettings } from "./ground"
import { DEFAULT_HUD_SETTINGS, hudControls, type OutbreakHud } from "./hud"
import type { OutbreakMap } from "./map/map"
import { flashlightBeamControls, OUTBREAK_LOOK_LIGHTING_PRESETS, outbreakLightingControls } from "./lighting"
import type { NetSession } from "./net-session"
import { type ProgressionLabHost } from "./progression/lab"
import { resolveOutbreakSettingTarget, type OutbreakSettings, type OutbreakSubsystemKey } from "./settings"
import { survivorAimControls } from "./survivor"
import { syncUnseenSettingChange, unseenControls } from "./unseen"
import type { VehicleLabHost } from "./vehicle-lab"
import type { OutbreakWeatherController } from "./weather/controller"
import { zombieControls } from "./zombie-profile"

/** The feature Lab hooks (the client feature registry, passed in by `main.ts`). */
export interface OutbreakLabFeatures {
  collectLabControls(host: OutbreakLabControlHost): LabControl[]
  notifySettingChanged(
    host: OutbreakLabControlHost,
    rawKey: string,
    routed: { subsystem: OutbreakSubsystemKey; field: string } | null,
    value?: number | boolean | string,
  ): boolean
}

export interface OutbreakLabControlHost {
  readonly features: OutbreakLabFeatures
  readonly session: () => LocalSession | NetSession
  readonly settings: OutbreakSettings
  readonly lookSettings: LookSettings
  readonly lab: () => LabPanel
  readonly feelTracker: OutbreakFeelTracker
  readonly combatFx: OutbreakCombatFX
  readonly weatherController: OutbreakWeatherController
  readonly progressionHost: ProgressionLabHost
  readonly discoveryHost: DiscoveryHost
  readonly vehicleHost: VehicleLabHost
  readonly botsLab: BotsLabController
  readonly hud: OutbreakHud
  readonly map: OutbreakMap
  readonly qualityController: AdaptiveQualityController
  readonly updateProfile: () => void
  readonly regenerate: () => void
  readonly reset: (nextSeed?: number) => void
  readonly syncTextures: () => void
  readonly setLastDayNightHour: (hour: number) => void
}

export function buildOutbreakLabControls(host: OutbreakLabControlHost): LabControl[] {
  const { settings, feelTracker, combatFx, botsLab } = host
  const raw: LabControl[] = [
    ...aiControls,
    ...botsLab.controls(
      () => {
        const s = host.session()
        return s instanceof LocalSession ? s : null
      },
      (s) => host.reset(s),
    ),
    ...audioControls,
    {
      key: "spawnZombieHere",
      label: "Spawn zombie ahead",
      group: "AI",
      type: "action",
      run: () => {
        const session = host.session()
        const p = session.view.player
        session.ai.spawnZombie(
          session.view.town,
          p.x + Math.cos(p.aim) * 4.5,
          p.y + Math.sin(p.aim) * 4.5,
          "wander",
        )
        settings.ai.zombieCount = session.view.zombies.filter((z) => z.state !== "dead").length
      },
    },
    {
      key: "makeNoiseHere",
      label: "Emit test noise",
      group: "AI",
      type: "action",
      run: () => {
        const session = host.session()
        const p = session.view.player
        session.ai.emitNoise(p.x, p.y, 18, "glass", session.view.time, "player", 1.3)
      },
    },
    {
      key: "alertNearbyZombies",
      label: "Alert all to player",
      group: "AI",
      type: "action",
      run: () => {
        const session = host.session()
        const p = session.view.player
        session.ai.setZombieState("chase", p.x, p.y)
      },
    },
    {
      key: "calmAllZombies",
      label: "Reset all to wander",
      group: "AI",
      type: "action",
      run: () => {
        host.session().ai.setZombieState("wander")
      },
    },
    ...flashlightControls,
    ...flashlightBeamControls,
    ...staminaControls,
    ...groundControls,
    {
      key: "randomizeGroundTuning",
      label: "Randomize ground & clutter",
      group: "Ground & Clutter",
      type: "action",
      run: () => {
        Object.assign(settings.ground, randomizeGroundSettings(settings.ground, settings.ground.groundTuningSeed))
        host.lab().refresh()
      },
    },
    {
      key: "textures",
      label: "Material mode",
      group: "Materials",
      options: [
        { label: "Textured + procedural", value: 1 },
        { label: "Procedural fallback", value: 0 },
        { label: "A/B split", value: 2 },
      ],
    },
    {
      key: "rugStyle",
      label: "Rug style",
      group: "Materials",
      options: [
        { label: "Oriental & Persian", value: 0 },
        { label: "Swapped Medallion", value: 1 },
        { label: "Procedural geometric", value: 2 },
      ],
    },
    {
      key: "wallStyle",
      label: "Wall finish",
      group: "Materials",
      options: [
        { label: "Damask & plaster", value: 0 },
        { label: "Fine linen plaster", value: 1 },
        { label: "Procedural plaster", value: 2 },
      ],
    },
    {
      key: "floorStyle",
      label: "Floorboards",
      group: "Materials",
      options: [
        { label: "Wide honey oak", value: 0 },
        { label: "Narrow strip oak", value: 1 },
        { label: "Procedural planks", value: 2 },
      ],
    },
    { key: "texScale", label: "Texture scale", group: "Materials", min: 0.5, max: 2, step: 0.05, unit: "×" },
    { key: "texContrast", label: "Texture contrast", group: "Materials", min: 0, max: 2, step: 0.05, unit: "×" },
    { key: "texRoughness", label: "Roughness trim", group: "Materials", min: -0.3, max: 0.3, step: 0.02, unit: "" },
    {
      key: "humanProfile",
      label: "Pose",
      group: "Zombie",
      options: [
        { label: "Survivor", value: 0 },
        { label: "Zombie", value: 1 },
        { label: "Crouch-run", value: 2 },
      ],
    },
    ...zombieControls,
    ...survivorAimControls,
    ...hudControls,
    ...host.features.collectLabControls(host),
    {
      key: "bloodStyle",
      label: "Blood splatter",
      group: "Combat",
      options: [
        { label: "Wet ballistic + Noir", value: 1 },
        { label: "Legacy flat", value: 2 },
        { label: "Off", value: 0 },
      ],
    },
    ...cameraShakeControls,
    ...cameraLeadControls,
    ...feelControls,
    ...motionBlurControls,
    {
      key: "triggerFeelShot",
      label: "Trigger shot impulse",
      group: "Camera",
      type: "action",
      run: () => {
        const p = host.session().view.player
        feelTracker.triggerShot(p.aim, 1)
      },
    },
    {
      key: "triggerFeelShove",
      label: "Trigger shove impulse",
      group: "Camera",
      type: "action",
      run: () => {
        const p = host.session().view.player
        feelTracker.triggerShove(p.aim, 1)
      },
    },
    {
      key: "triggerFeelHitTaken",
      label: "Trigger hit-taken impulse",
      group: "Camera",
      type: "action",
      run: () => {
        const session = host.session()
        const p = session.view.player
        feelTracker.triggerHitTaken(-Math.cos(p.aim), -Math.sin(p.aim), 25)
        combatFx.emitSurvivorHit(
          p.x,
          p.y,
          -Math.cos(p.aim),
          -Math.sin(p.aim),
          supportHeight(session.view.town, p.x, p.y),
          25,
          Math.floor(session.view.time * 1000) + 1,
        )
      },
    },
    {
      key: "triggerFeelExplosion",
      label: "Trigger blast impulse",
      group: "Camera",
      type: "action",
      run: () => {
        const p = host.session().view.player
        feelTracker.triggerBlast(
          p.x + Math.cos(p.aim) * 4.5,
          p.y + Math.sin(p.aim) * 4.5,
          p.x,
          p.y,
          24,
          1,
        )
      },
    },
    {
      key: "diagnostic",
      label: "Contribution",
      group: "Diagnostics",
      options: [
        "Beauty",
        "Albedo",
        "Direct",
        "Ambient + sky",
        "Specular",
        "Bloom",
        "Before memory",
        "Colour mask",
        "Visibility field",
      ].map((label, value) => ({ label, value })),
    },
    { key: "hour", label: "Time", group: "Day cycle", min: 0, max: 24, step: 0.05 },
    { key: "timeScale", label: "Time scale", group: "Day cycle", min: 0, max: 600, step: 10 },
    {
      key: "dayNightLook",
      label: "Look & threat by hour",
      group: "Day cycle",
      options: [
        { label: "Dynamic (Day → Dusk → Noir)", value: 1 },
        { label: "Fixed preset", value: 0 },
      ],
    },
    ...DAY_NIGHT_CURVE_KEYS.map((key): LabControl => ({
      key,
      label: DAY_NIGHT_CURVES[key].label,
      group: "Day cycle",
      subsection: "Curves (day → dusk → night)",
      type: "curve",
      range: DAY_NIGHT_CURVES[key].range,
      unit: DAY_NIGHT_CURVES[key].unit,
      enabled: (s) => s.dayNightLook === 1,
    })),
    {
      key: "infiniteAmmo",
      label: "Infinite ammo",
      group: "Combat",
      options: [
        { label: "Off", value: 0 },
        { label: "On", value: 1 },
      ],
    },
    { key: "cone", label: "Vision cone", group: "Vision", min: 60, max: 180, step: 1 },
    { key: "awareness", label: "Close awareness", group: "Vision", min: 0, max: 5, step: 0.1 },
    { key: "range", label: "Sight range", group: "Vision", min: 8, max: 40, step: 1 },
    { key: "shroud", label: "Explored shroud", group: "Vision", min: 0.02, max: 0.4, step: 0.01 },
    ...fogOfWarControls,
    ...unseenControls,
    {
      key: "lookPreset",
      label: "Style preset",
      group: "Look",
      options: LOOK_PRESET_IDS.map((id) => ({ label: LOOK_PRESETS[id].label, value: id })),
    },
    ...outbreakLightingControls,
    ...qualityControls,
    { key: "zoom", label: "Camera distance", group: "View", min: 24, max: 65, step: 1 },
    {
      key: "worldMode",
      label: "World mode",
      group: "Generation",
      options: [
        { label: "Streaming infinite", value: 1 },
        { label: "Procedural districts", value: 2 },
        { label: "Classic 96m block", value: 0 },
      ],
    },
    { key: "houseSeed", label: "House seed", group: "Generation", min: 1, max: 32, step: 1 },
    { key: "terrain", label: "Terrain relief", group: "Generation", min: 0, max: 0.4, step: 0.02 },
    { key: "foliageDensity", label: "Foliage density", group: "Generation", min: 0.5, max: 1.5, step: 0.05 },
    {
      key: "houseDecay",
      label: "House decay",
      group: "Generation",
      options: [
        { label: "Auto (by seed)", value: 0 },
        { label: "Tidy", value: 1 },
        { label: "Abandoned", value: 2 },
        { label: "Ransacked", value: 3 },
        { label: "Barricaded", value: 4 },
      ],
    },
    { key: "weathering", label: "Weathering amount", group: "Generation", min: 0, max: 2, step: 0.05, unit: "×" },
  ]
  const seen = new Set<string>()
  const out: LabControl[] = []
  for (const c of raw) {
    if (seen.has(c.key)) continue
    seen.add(c.key)
    out.push(c)
  }
  return out
}

export function handleOutbreakSettingChanged(
  host: OutbreakLabControlHost,
  rawKey: string,
  value?: number | boolean | string,
): void {
  const { settings, lookSettings, hud } = host
  const session = host.session()
  const lab = host.lab()
  const routed = resolveOutbreakSettingTarget(rawKey)
  const key = routed?.field ?? rawKey
  host.features.notifySettingChanged(host, rawKey, routed, value)
  if (syncUnseenSettingChange(settings.unseen, key)) {
    lab.refresh()
  }
  if (key === "humanProfile" || key.startsWith("zombie")) host.updateProfile()
  if (key in DEFAULT_HUD_SETTINGS) hud.applySettings()
  if (key === "zombieCount") {
    session.ai.config.zombieCount = settings.ai.zombieCount
    session.ai.syncPopulation(session.view.town, session.view.player.x, session.view.player.y)
  }
  if (key === "hour") {
    session.view.hour = wrapHour(settings.dayCycle.hour)
    if (settings.dayCycle.dayNightLook === 1 && settings.dayCycle.lookPreset === "noir") {
      host.setLastDayNightHour(session.view.hour)
      applyOutbreakDayNight(session.view.hour, lookSettings, settings)
      lab.refresh()
    }
  }
  if (key in DAY_NIGHT_CURVES && settings.dayCycle.dayNightLook === 1 && settings.dayCycle.lookPreset === "noir") {
    applyOutbreakDayNight(session.view.hour, lookSettings, settings)
    lab.refresh()
  }
  if (key === "dayNightLook") {
    if (settings.dayCycle.dayNightLook === 1 && settings.dayCycle.lookPreset === "noir") {
      host.setLastDayNightHour(session.view.hour)
      applyOutbreakDayNight(session.view.hour, lookSettings, settings)
    } else {
      const pid = resolveLookPresetId(settings.dayCycle.lookPreset) ?? "noir"
      applyLookPreset(lookSettings, pid)
      Object.assign(settings.lighting, OUTBREAK_LOOK_LIGHTING_PRESETS[pid])
    }
    lab.refresh()
  }
  if (
    key === "worldMode" ||
    key === "houseSeed" ||
    key === "terrain" ||
    key === "foliageDensity" ||
    key === "houseDecay" ||
    key === "clutterDensity" ||
    key === "weathering" ||
    key === "clutterSeed"
  ) {
    host.regenerate()
  }
  if (
    key === "textures" ||
    key === "rugStyle" ||
    key === "wallStyle" ||
    key === "floorStyle" ||
    key === "texScale" ||
    key === "texContrast" ||
    key === "texRoughness" ||
    key === "wearAmount" ||
    key === "curbDirt" ||
    key === "puddleWetness" ||
    key === "clutterDensity" ||
    key === "rubbleAmount" ||
    key === "motionStrength" ||
    key === "windGustiness" ||
    key === "clutterSeed"
  ) {
    host.syncTextures()
  }
  if (key === "quality") {
    const qMode = resolveQualityMode(value ?? settings.view.quality)
    settings.view.quality = qMode
    host.qualityController.setMode(qMode)
    if (!navigator.webdriver) {
      try {
        saveQualityMode(localStorage, qMode)
      } catch {}
    }
    lab.refresh()
  }
  if (key === "lookPreset") {
    const pid = resolveLookPresetId(value ?? settings.dayCycle.lookPreset) ?? "current"
    settings.dayCycle.lookPreset = pid
    applyLookPreset(lookSettings, pid)
    Object.assign(settings.lighting, OUTBREAK_LOOK_LIGHTING_PRESETS[pid])
    if (settings.dayCycle.dayNightLook === 1 && pid === "noir") {
      host.setLastDayNightHour(session.view.hour)
      applyOutbreakDayNight(session.view.hour, lookSettings, settings)
    }
    lab.refresh()
  }
}
