import type { LabControl } from "@arcade/kit/lab-panel"

/**
 * What hangs in the air (presentation only): world smoke rising from the street, and the dust that drifts in the
 * flashlight beam. `worldSmoke` 0 and `beamDustStyle` 0 are Today.
 */
export type OutbreakAirSettings = {
  /** Steam and smoke rising from sewer grates, smouldering cars and chimneys (0 off, Today). */
  worldSmoke: number
  /** Share of manhole covers venting steam. */
  smokeManholes: number
  /** Share of storm drain grates venting steam. */
  smokeDrains: number
  /** Share of abandoned cars still smouldering (wrecks you made always do). */
  smokeCars: number
  /** Share of house chimneys with a thin smoke (someone holed up inside). */
  smokeChimneys: number
  /** Re-rolls which vents, cars and chimneys smoke. */
  smokeSeed: number
  /** × how thick each plume is. */
  smokeDensity: number
  /** × puffs per second from each source. */
  smokeRate: number
  /** × puff size. */
  smokeSize: number
  /** Seconds a puff lives (how high and far it drifts). */
  smokeLife: number
  /** Wind the smoke drifts on, in metres per second. */
  smokeWind: number
  /** Which way the wind blows, in degrees (0 is +x, east). */
  smokeWindAngle: number
  /** × how strongly the flashlight beam lights smoke. */
  smokeBeamCatch: number
  /** × how strongly lamps and fire light smoke. */
  smokeLampCatch: number
  /** × sky light on smoke (at night this is nearly nothing, so smoke is dark until a light finds it). */
  smokeAmbient: number
  /** How much thinner smoke is in full daylight (0 same as night, 1 gone). */
  smokeDayThin: number
  /** Most smoking sources at once, nearest the survivor first. */
  smokeMaxSources: number
  /** How far from the survivor a source still smokes, in metres. */
  smokeRange: number
  /** Dust in the flashlight beam: 0 Today (fine glinting motes, Look › Air), 1 soft drifting motes (these knobs). */
  beamDustStyle: number
  /** Soft motes: share of air cells holding a mote. */
  beamDustAmount: number
  /** Soft motes: radius in centimetres (drawn at least `beamDustMinPx` pixels, dimmer instead of smaller). */
  beamDustSize: number
  /** Soft motes: smallest drawn radius in pixels, so motes stay soft discs and never glitter. */
  beamDustMinPx: number
  /** Soft motes: × how brightly they catch the light. */
  beamDustBrightness: number
  /** Soft motes: × how fast they drift. */
  beamDustDrift: number
  /** Soft motes: fade near the lens, near the ground and toward the camera (0 none .. 1 full). */
  beamDustDepthFade: number
  /** Soft motes: under lamps and sconces too (1 on). */
  beamDustLamps: number
}

export const DEFAULT_AIR_SETTINGS: OutbreakAirSettings = {
  worldSmoke: 1,
  smokeManholes: 0.5,
  smokeDrains: 0.34,
  smokeCars: 0.2,
  smokeChimneys: 0.08,
  smokeSeed: 1,
  smokeDensity: 1,
  smokeRate: 1,
  smokeSize: 1,
  smokeLife: 4.2,
  smokeWind: 0.55,
  smokeWindAngle: 28,
  smokeBeamCatch: 1,
  smokeLampCatch: 1,
  smokeAmbient: 0.8,
  smokeDayThin: 0.55,
  smokeMaxSources: 14,
  smokeRange: 30,
  beamDustStyle: 1,
  beamDustAmount: 0.05,
  beamDustSize: 2.5,
  beamDustMinPx: 2.2,
  beamDustBrightness: 1,
  beamDustDrift: 0.45,
  beamDustDepthFade: 0.8,
  beamDustLamps: 1,
}

const SMOKE = "World smoke"
const DUST = "Beam dust"

export const airControls: readonly LabControl[] = [
  { key: "worldSmoke", label: "World smoke", group: SMOKE, type: "select", options: [{ value: 0, label: "Off (Today)" }, { value: 1, label: "Steam & smoke" }] },
  { key: "smokeManholes", label: "Manholes venting", group: SMOKE, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "smokeDrains", label: "Storm drains venting", group: SMOKE, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "smokeCars", label: "Cars smouldering", group: SMOKE, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "smokeChimneys", label: "Chimneys smoking", group: SMOKE, min: 0, max: 1, step: 0.02, unit: "" },
  { key: "smokeSeed", label: "Placement seed", group: SMOKE, min: 1, max: 99, step: 1, unit: "" },
  { key: "smokeDensity", label: "Thickness", group: SMOKE, min: 0, max: 2.5, step: 0.05, unit: "×" },
  { key: "smokeRate", label: "Puffs per second", group: SMOKE, min: 0.2, max: 3, step: 0.05, unit: "×" },
  { key: "smokeSize", label: "Puff size", group: SMOKE, min: 0.4, max: 2.5, step: 0.05, unit: "×" },
  { key: "smokeLife", label: "Puff life", group: SMOKE, min: 1, max: 10, step: 0.1, unit: "s" },
  { key: "smokeWind", label: "Wind", group: SMOKE, min: 0, max: 3, step: 0.05, unit: "m/s" },
  { key: "smokeWindAngle", label: "Wind direction", group: SMOKE, min: 0, max: 359, step: 1, unit: "°" },
  { key: "smokeBeamCatch", label: "Beam lights smoke", group: SMOKE, min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "smokeLampCatch", label: "Lamps & fire light smoke", group: SMOKE, min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "smokeAmbient", label: "Sky light on smoke", group: SMOKE, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "smokeDayThin", label: "Thinner by day", group: SMOKE, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "smokeMaxSources", label: "Most smoking sources", group: SMOKE, min: 0, max: 32, step: 1, unit: "" },
  { key: "smokeRange", label: "Smoke range", group: SMOKE, min: 8, max: 60, step: 1, unit: "m" },
  { key: "beamDustStyle", label: "Beam dust", group: DUST, type: "select", options: [{ value: 0, label: "Today (fine motes, Look › Air)" }, { value: 1, label: "Soft drifting motes" }] },
  { key: "beamDustAmount", label: "Motes", group: DUST, min: 0, max: 0.4, step: 0.005, unit: "" },
  { key: "beamDustSize", label: "Mote radius", group: DUST, min: 0.5, max: 8, step: 0.1, unit: "cm" },
  { key: "beamDustMinPx", label: "Smallest mote", group: DUST, min: 1, max: 6, step: 0.1, unit: "px" },
  { key: "beamDustBrightness", label: "Mote brightness", group: DUST, min: 0, max: 4, step: 0.05, unit: "×" },
  { key: "beamDustDrift", label: "Drift speed", group: DUST, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "beamDustDepthFade", label: "Depth fade", group: DUST, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "beamDustLamps", label: "Motes under lamps", group: DUST, min: 0, max: 1, step: 1, unit: "" },
]
