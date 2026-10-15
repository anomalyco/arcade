import { LIGHT_FLOATS } from "@arcade/kit/gpu/limits"
import type { LabControl } from "@arcade/kit/lab-panel"
import {
  WEATHER_PRESETS,
  WEATHER_PRESET_IDS,
  WeatherSimulation,
  createWeatherSettings,
  isClearWeather,
  randomizeWeatherSettings,
  resolveWeatherPresetId,
  weatherSettings,
  type WeatherEave,
  type WeatherExcludeRect,
  type WeatherFrameState,
  type WeatherLight,
  type WeatherPrepareInput,
  type WeatherPresetId,
  type WeatherSettings,
} from "@arcade/kit/weather"
import type { Town } from "../../shared/map"
import { registerOutbreakClientFeature } from "../feature-registry"

export type OutbreakWeatherSettings = {
  weather: number
  weatherEnabled: boolean
  weatherPreset: WeatherPresetId
  weatherIntensity: number
  weatherDensity: number
  weatherDropSize: number
  weatherDropLength: number
  weatherDropSpeed: number
  weatherLitOnly: number
  weatherSplashRate: number
  weatherWetness: number
  weatherPuddleCoverage: number
  weatherWindSpeed: number
  weatherWindDir: number
  weatherWindGust: number
  weatherMist: number
  weatherLightningRate: number
  weatherSnowMode: boolean
  weatherTuningSeed: number
}

const clearBase = createWeatherSettings("clear")

export const DEFAULT_OUTBREAK_WEATHER: OutbreakWeatherSettings = {
  weather: 0,
  weatherEnabled: false,
  weatherPreset: "clear",
  weatherIntensity: clearBase.intensity,
  weatherDensity: clearBase.density,
  weatherDropSize: clearBase.dropSize,
  weatherDropLength: clearBase.dropLength,
  weatherDropSpeed: clearBase.dropSpeed,
  weatherLitOnly: clearBase.litOnly,
  weatherSplashRate: clearBase.splashRate,
  weatherWetness: clearBase.wetness,
  weatherPuddleCoverage: clearBase.puddleCoverage,
  weatherWindSpeed: clearBase.windSpeed,
  weatherWindDir: clearBase.windDir,
  weatherWindGust: clearBase.windGust,
  weatherMist: clearBase.mist,
  weatherLightningRate: clearBase.lightningRate,
  weatherSnowMode: clearBase.snowMode,
  weatherTuningSeed: 73,
}

export function toSharedWeatherSettings(s: Readonly<OutbreakWeatherSettings>): WeatherSettings {
  if (!s.weatherEnabled && s.weatherPreset === "clear") {
    return createWeatherSettings("clear")
  }
  return weatherSettings({
    preset: s.weatherPreset,
    intensity: s.weatherEnabled ? s.weatherIntensity : 0,
    density: s.weatherDensity,
    dropSize: s.weatherDropSize,
    dropLength: s.weatherDropLength,
    dropSpeed: s.weatherDropSpeed,
    litOnly: s.weatherLitOnly,
    splashRate: s.weatherSplashRate,
    wetness: s.weatherEnabled ? s.weatherWetness : 0,
    puddleCoverage: s.weatherEnabled ? s.weatherPuddleCoverage : 0,
    windSpeed: s.weatherWindSpeed,
    windDir: s.weatherWindDir,
    windGust: s.weatherWindGust,
    mist: s.weatherEnabled ? s.weatherMist : 0,
    lightningRate: s.weatherEnabled ? s.weatherLightningRate : 0,
    snowMode: s.weatherSnowMode,
  })
}

export function applyOutbreakWeatherPreset(
  target: OutbreakWeatherSettings & { weather?: number },
  preset: WeatherPresetId | string,
): WeatherSettings {
  const pid = resolveWeatherPresetId(preset) ?? "clear"
  const src = WEATHER_PRESETS[pid].settings
  target.weatherPreset = pid
  target.weatherEnabled = pid !== "clear"
  target.weatherIntensity = src.intensity
  target.weatherDensity = src.density
  target.weatherDropSize = src.dropSize
  target.weatherDropLength = src.dropLength
  target.weatherDropSpeed = src.dropSpeed
  target.weatherLitOnly = src.litOnly
  target.weatherSplashRate = src.splashRate
  target.weatherWetness = src.wetness
  target.weatherPuddleCoverage = src.puddleCoverage
  target.weatherWindSpeed = src.windSpeed
  target.weatherWindDir = src.windDir
  target.weatherWindGust = src.windGust
  target.weatherMist = src.mist
  target.weatherLightningRate = src.lightningRate
  target.weatherSnowMode = src.snowMode
  if (typeof target.weather === "number") {
    target.weather = pid === "clear" ? 0 : Math.min(1, src.intensity * 0.65 + src.mist * 0.2)
  }
  return toSharedWeatherSettings(target)
}

export function randomizeOutbreakWeather(
  target: OutbreakWeatherSettings & { weather?: number },
  explicitSeed?: number,
): WeatherSettings {
  const seed = Math.max(1, Math.min(9999, Math.round(explicitSeed ?? (target.weatherTuningSeed || 73))))
  const base = toSharedWeatherSettings({
    ...target,
    weatherEnabled: true,
    weatherPreset: target.weatherPreset === "clear" ? "rain" : target.weatherPreset,
  })
  const next = randomizeWeatherSettings(base, seed, "all")
  target.weatherEnabled = true
  if (target.weatherPreset === "clear") target.weatherPreset = "rain"
  target.weatherIntensity = next.intensity
  target.weatherDensity = next.density
  target.weatherDropSize = next.dropSize
  target.weatherDropLength = next.dropLength
  target.weatherDropSpeed = next.dropSpeed
  target.weatherLitOnly = next.litOnly
  target.weatherSplashRate = next.splashRate
  target.weatherWetness = next.wetness
  target.weatherPuddleCoverage = next.puddleCoverage
  target.weatherWindSpeed = next.windSpeed
  target.weatherWindDir = next.windDir
  target.weatherWindGust = next.windGust
  target.weatherMist = next.mist
  target.weatherLightningRate = next.lightningRate
  target.weatherTuningSeed = (seed % 9999) + 1
  if (typeof target.weather === "number") {
    target.weather = Math.min(1, next.intensity * 0.65 + next.mist * 0.2)
  }
  return toSharedWeatherSettings(target)
}

export const outbreakWeatherControls: LabControl[] = [
  { key: "weatherEnabled", label: "Enable weather", group: "Weather", type: "toggle" },
  {
    key: "weatherPreset",
    label: "Weather preset",
    group: "Weather",
    options: WEATHER_PRESET_IDS.map((id) => ({ label: WEATHER_PRESETS[id].label, value: id })),
  },
  { key: "weatherIntensity", label: "Weather intensity", group: "Weather", min: 0, max: 1, step: 0.02, unit: "" },
  { key: "weatherDensity", label: "Drop density", group: "Weather", min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "weatherDropSize", label: "Drop size", group: "Weather", min: 0.2, max: 2.5, step: 0.05, unit: "×" },
  { key: "weatherDropLength", label: "Streak length", group: "Weather", min: 0.2, max: 3, step: 0.05, unit: "×" },
  { key: "weatherDropSpeed", label: "Fall speed", group: "Weather", min: 1, max: 20, step: 0.2, unit: "m/s" },
  { key: "weatherLitOnly", label: "Lit-only visibility", group: "Weather", min: 0, max: 1, step: 0.02, unit: "" },
  { key: "weatherSnowMode", label: "Snow mode", group: "Weather", type: "toggle" },
  { key: "weatherSplashRate", label: "Splash & drip rate", group: "Weather", min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "weatherWetness", label: "Surface wetness", group: "Weather", min: 0, max: 1, step: 0.02, unit: "" },
  { key: "weatherPuddleCoverage", label: "Puddle coverage", group: "Weather", min: 0, max: 1.5, step: 0.02, unit: "×" },
  { key: "weatherWindSpeed", label: "Wind speed", group: "Weather", min: 0, max: 24, step: 0.5, unit: "m/s" },
  { key: "weatherWindDir", label: "Wind direction", group: "Weather", min: -180, max: 180, step: 5, unit: "°" },
  { key: "weatherWindGust", label: "Wind gustiness", group: "Weather", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "weatherMist", label: "Mist & fog banks", group: "Weather", min: 0, max: 1.5, step: 0.02, unit: "×" },
  { key: "weatherLightningRate", label: "Lightning rate", group: "Weather", min: 0, max: 1, step: 0.02, unit: "" },
  { key: "weatherTuningSeed", label: "Weather tuning seed", group: "Weather", min: 1, max: 9999, step: 1, unit: "" },
]

export class OutbreakWeatherController {
  readonly sim = new WeatherSimulation(7)
  private cachedTownSeed = -1
  private excludeRects: WeatherExcludeRect[] = []
  private eaves: WeatherEave[] = []
  private readonly activeLights: WeatherLight[] = []

  reset(seed = 7): void {
    this.sim.reset(seed)
  }

  strikeNow(seed?: number) {
    return this.sim.strikeNow(seed)
  }

  private ensureTownGeometry(town: Town): void {
    if (this.cachedTownSeed === town.seed) return
    this.cachedTownSeed = town.seed
    this.excludeRects = town.buildings.map((b) => b.rect)
    const eaves: WeatherEave[] = []
    for (const b of town.buildings) {
      const [x0, z0, x1, z1] = b.rect
      // South & north eaves along primary street-facing houses first
      eaves.push([x0 - 0.35, z1 + 0.35, x1 + 0.35, z1 + 0.35, 2.78])
      eaves.push([x0 - 0.35, z0 - 0.35, x1 + 0.35, z0 - 0.35, 2.78])
    }
    this.eaves = eaves.slice(0, 8)
  }

  stepAndPrepare(input: {
    dt: number
    town: Town
    settings: Readonly<OutbreakWeatherSettings>
    viewProj: Float32Array
    eye: readonly [number, number, number] | Float32Array
    playerX: number
    playerY: number
    playerGroundY: number
    canvasWidth: number
    canvasHeight: number
    zoom: number
    lights: Float32Array
    lightCount: number
    ambientLum: number
  }): { state: WeatherFrameState; prepareInput: WeatherPrepareInput | null } {
    this.ensureTownGeometry(input.town)
    const shared = toSharedWeatherSettings(input.settings)
    const st = this.sim.step(input.dt, shared, input.eye, [input.playerX, input.playerY])

    if (isClearWeather(shared) && st.flash <= 0.001) {
      return { state: st, prepareInput: null }
    }

    // Extract active scene lights (skipping slot 0 reserved for sight LOS)
    this.activeLights.length = 0
    for (let i = 1; i < input.lightCount && this.activeLights.length < 12; i++) {
      const base = i * LIGHT_FLOATS
      const power = input.lights[base + 7]!
      if (power <= 0.01) continue
      const lx = input.lights[base]!
      const ly = input.lights[base + 1]!
      const lz = input.lights[base + 2]!
      const lr = input.lights[base + 3]!
      const r = input.lights[base + 4]!
      const g = input.lights[base + 5]!
      const b = input.lights[base + 6]!
      const coneDirX = input.lights[base + 8]!
      const coneDirZ = input.lights[base + 9]!
      const cosHalf = input.lights[base + 10]!
      const hasCone = input.lights[base + 11]! > 0.5
      this.activeLights.push({
        x: lx,
        y: ly,
        z: lz,
        radius: lr,
        r,
        g,
        b,
        power: hasCone ? power * 1.45 : power * 1.25,
        dx: coneDirX,
        dz: coneDirZ,
        cosHalf,
        isCone: hasCone,
      })
    }

    // Also include the warm sodium streetlamp pool at (36.8, 47.6) on the hero street so rain over the south-east curb is richly lit
    if (this.activeLights.length < 12) {
      this.activeLights.push({
        x: 36.8,
        y: 5.8,
        z: 47.6,
        radius: 11.5,
        r: 1.05,
        g: 0.48,
        b: 0.12,
        power: 2.8,
      })
    }

    const prepareInput: WeatherPrepareInput = {
      settings: shared,
      state: st,
      viewProj: input.viewProj,
      eye: input.eye,
      focusXZ: [input.playerX, input.playerY],
      viewportWidth: input.canvasWidth,
      viewportHeight: input.canvasHeight,
      fovYRad: 0.52,
      groundY: input.playerGroundY,
      ambientLum: input.ambientLum,
      lights: this.activeLights,
      excludeRects: this.excludeRects,
      eaves: this.eaves,
      cameraDist: input.zoom,
    }
    return { state: st, prepareInput }
  }
}

export const outbreakWeatherSurfaceWgsl = /* wgsl */ `
fn applyOutbreakWeatherSurface(
  world: vec3f,
  n: vec3f,
  surfCol: vec3f,
  baseColor: vec3f,
  inRoom: bool,
  mat: i32,
  isInView: bool
) -> vec3f {
  let wet = OL.u7.x;
  let snow = OL.u7.w;
  if ((wet <= 0.001 && snow <= 0.001) || inRoom) {
    return surfCol;
  }
  var col = surfCol;

  // 1. Snow / frost cover on outdoor upward-facing roofs, turf, sidewalks, and foliage
  if (snow > 0.005 && n.y > 0.42) {
    let sn = surfaceNoise(world.xz * 0.48 + vec2f(2.9, 6.4));
    let roadMask = select(1.0, 0.58, world.z > 40.0 && world.z < 48.0);
    let snowMask = clamp((n.y - 0.38) * 1.85 * snow * (0.55 + 0.65 * sn) * roadMask, 0.0, 0.88);
    let frostTint = vec3f(0.16, 0.20, 0.28) * (0.45 + 0.55 * F.ambient.w) + surfCol * 1.45;
    col = mix(col, frostTint, snowMask);
  }

  // 2. Wet asphalt, concrete sidewalk, and puddle sheen under streetlamps, porch/window practicals & flashlight cone
  if (wet > 0.005 && world.y < 0.48 && n.y > 0.72) {
    let puddleCov = OL.u7.y;
    let rippleStr = OL.u7.z;
    let onRoad = world.z > 39.8 && world.z < 48.2;
    let pWave = 0.5 + 0.28 * sin(world.x * 0.62 + world.z * 0.48 + 1.3) + 0.22 * cos(world.x * 1.15 - world.z * 0.92 + 2.7);
    let pThresh = clamp(0.62 - puddleCov * 0.26, 0.20, 0.74);
    let puddle = smoothstep(pThresh - 0.12, pThresh + 0.12, pWave + select(0.0, 0.14, onRoad)) * clamp(puddleCov, 0.0, 1.35);
    let damp = clamp(wet * 0.75 + puddle * 0.55, 0.0, 1.0);

    // Rain-slicked asphalt darkening + cool nocturnal slate shift
    col *= mix(vec3f(1.0), vec3f(0.48, 0.52, 0.60), damp * select(0.55, 0.86, onRoad));

    // Fast concentric raindrop ripple ring in puddles
    var ripRing = 0.0;
    if (puddle > 0.08 && rippleStr > 0.01) {
      let rq = world.xz * 2.8;
      let rh = fract(sin(dot(floor(rq), vec2f(12.9898, 78.233))) * 43758.5453);
      let rPhase = fract(F.cam.w * 1.75 + rh);
      let rDist = length(fract(rq) - 0.5);
      let ringBand = max(0.0, 1.0 - abs(rDist - (0.06 + rPhase * 0.36)) * 22.0);
      ripRing = ringBand * ringBand * (1.0 - rPhase) * puddle * rippleStr * (1.0 - smoothstep(0.04, 0.18, surfaceFootprint));
      col += vec3f(0.032, 0.042, 0.062) * ripRing * wet;
    }

    let sheenGain = (0.30 + 1.15 * puddle * puddle) * wet * max(0.45, OL.u2.y);

    // 2a. Wet-asphalt & puddle reflection under the 2100K sodium streetlamp
    let sScale = OL.u1.w;
    if (sScale > 0.001) {
      let lampPos = select(vec2f(37.4, 46.2), vec2f(39.1, 25.0), isInView);
      let q = (world.xz - lampPos) * vec2f(0.55, 0.42);
      let r2 = dot(q, q);
      if (r2 < 5.0) {
        let sodiumCol = vec3f(1.0, 0.44, 0.08);
        let pool = (1.0 / (1.0 + r2 * 1.45)) * (1.0 - r2 * 0.2) * sheenGain * sScale * 0.52;
        col += (sodiumCol * (0.55 + ripRing * 1.35) + surfCol * sodiumCol * 2.2) * pool;
      }
    }

    // 2b. Localized puddle glints below warm 2500K house windows (x = 24.5, 34.25) & porch (x = 27.7)
    let pScale = OL.u1.x;
    let wScale = OL.u1.y;
    let onHardPavement = onRoad || (world.z > 38.05 && world.z < 39.25) || (abs(world.x - 27.7) < 1.15 && world.z > 35.8 && world.z < 39.8);
    if (onHardPavement && (pScale > 0.001 || wScale > 0.001) && world.z > 36.0 && world.z < 43.5 && world.x > 22.0 && world.x < 36.8) {
      let wx = world.x + (pWave - 0.5) * 0.55;
      let dL = max(0.0, 1.0 - abs(wx - 24.5) * 1.35);
      let dP = max(0.0, 1.0 - abs(wx - 27.7) * 1.25);
      let dR = max(0.0, 1.0 - abs(wx - 34.25) * 1.35);
      let zReach = smoothstep(36.2, 38.2, world.z) * (1.0 - smoothstep(39.4, 43.2, world.z));
      let puddleOnly = select(0.25 + 0.75 * puddle, puddle * puddle * 0.95, onRoad);
      let glint = (dL * dL * wScale + dR * dR * wScale + dP * dP * pScale * 1.1) * zReach * puddleOnly;
      col += vec3f(1.0, 0.52, 0.12) * (glint * sheenGain * 0.30 * (0.65 + ripRing * 1.25));
    }

    // 2c. Wet asphalt & puddle specular reflection inside the survivor's directional flashlight cone
    if (OL.u4.z > 0.001 && OL.u4.w > 0.5) {
      let fOrig = OL.u3.xy;
      let fDir = OL.u3.zw;
      let fSide = vec2f(-fDir.y, fDir.x);
      let rel = world.xz - fOrig;
      let along = dot(rel, fDir);
      let across = abs(dot(rel, fSide));
      let fRange = max(2.8, OL.u4.y);
      let coneR = 0.14 + max(0.0, along) * max(0.12, OL.u4.x);
      if (along > 0.15 && along < fRange && across < coneR) {
        let radial = 1.0 - across / coneR;
        let axial = smoothstep(0.1, 0.6, along) * (1.0 - along / fRange);
        let wetFlash = radial * radial * axial * sheenGain * OL.u4.z * (0.32 + 0.48 * puddle + ripRing * 0.75);
        col += OL.u5.xyz * wetFlash;
      }
    }
  }
  return col;
}
`

export const outbreakWeatherFeature = registerOutbreakClientFeature({
  id: "weather",
  order: 80,
  settingsGroup: {
    subsystem: "weather",
    defaults: DEFAULT_OUTBREAK_WEATHER,
  },
  labControls: (host) => [
    { key: "weather", label: "Overcast", group: "Day cycle", min: 0, max: 1, step: 0.05 },
    ...outbreakWeatherControls,
    {
      key: "triggerWeatherLightning",
      label: "Trigger lightning strike",
      group: "Weather",
      type: "action",
      run: () => {
        host.weatherController.strikeNow()
      },
    },
    {
      key: "randomizeWeatherTuning",
      label: "Randomize weather",
      group: "Weather",
      type: "action",
      run: () => {
        randomizeOutbreakWeather(host.settings.weather, host.settings.weather.weatherTuningSeed)
        host.lab().refresh()
      },
    },
  ],
  onSettingChanged: (host, rawKey, routed, value) => {
    const key = routed?.field ?? rawKey
    if (key === "weatherPreset") {
      applyOutbreakWeatherPreset(host.settings.weather, String(value ?? host.settings.weather.weatherPreset))
      host.lab().refresh()
      return true
    }
    if (key === "weatherEnabled") {
      if (
        host.settings.weather.weatherEnabled &&
        host.settings.weather.weatherPreset === "clear" &&
        host.settings.weather.weatherIntensity <= 0.001
      ) {
        applyOutbreakWeatherPreset(host.settings.weather, "rain")
      } else if (!host.settings.weather.weatherEnabled) {
        host.settings.weather.weather = 0
      }
      host.lab().refresh()
      return true
    }
    return false
  },
  gameCommands: (host) => [
    {
      id: "weather.preset",
      label: "Set Outbreak Weather Preset",
      shortLabel: "Weather Preset",
      category: "Scene",
      undoable: false,
      args: {
        preset: {
          type: "string",
          required: true,
          description: "Weather preset ID (clear, drizzle, rain, storm, fog, snow)",
        },
      },
      enabled: () => true,
      run: async (_ctx, args) => {
        const applied = applyOutbreakWeatherPreset(host.settings.weather, String(args?.preset ?? "rain"))
        host.lab.refresh()
        host.draw(1 / 60)
        await host.device.queue.onSubmittedWorkDone()
        return {
          preset: host.settings.weather.weatherPreset,
          enabled: host.settings.weather.weatherEnabled,
          settings: applied,
        }
      },
    },
    {
      id: "weather.strike",
      label: "Trigger Outbreak Lightning Strike",
      shortLabel: "Lightning Strike",
      category: "Scene",
      undoable: false,
      enabled: () => true,
      run: async () => {
        const strike = host.weatherController.strikeNow()
        host.draw(1 / 60)
        await host.device.queue.onSubmittedWorkDone()
        return { triggered: true, strike }
      },
    },
  ],
  harnessMethods: (host) => ({
    setWeatherPreset(preset: string) {
      const applied = applyOutbreakWeatherPreset(host.settings.weather, preset)
      host.lab.refresh()
      return applied
    },
    strikeLightning(seed?: number) {
      return host.weatherController.strikeNow(seed)
    },
  }),
  harnessState: (host) => ({
    weather: {
      enabled: host.settings.weather.weatherEnabled,
      preset: host.settings.weather.weatherPreset,
      settings: toSharedWeatherSettings(host.settings.weather),
      state: { ...host.weatherController.sim.state },
    },
  }),
})
