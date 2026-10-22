import type { LabControl } from "../lab-navigation"
export type MoonPhase = "none" | "crescent" | "half" | "full"
export type SkySettings = {
  skyMode: "today" | "physical"
  skyClock: "host" | "utc"
  skyVision: "photometric" | "adapted"
  skyLatitude: number
  skyLongitude: number
  skyYear: number
  /** One-based UTC day of year and hour. Frozen until the host advances its clock. */
  skyDay: number
  skyHour: number
  skyStars: number
  skyExtinction: number
  skyScintillation: number
  skyMilkyWay: number
  skyAirglow: number
  skyZodiacal: number
  skyHaze: number
  skyMoon: MoonPhase
  skyMoonAzimuth: number
  skyMoonAltitude: number
  skyMoonEarthshine: number
  /** Normal-incidence illuminance of a full moon before local atmospheric extinction. */
  skyMoonLux: number
}
export const SKY_DEFAULTS: Readonly<SkySettings> = {
  skyMode: "today", skyClock: "host", skyVision: "adapted", skyLatitude: 45, skyLongitude: -73,
  skyYear: 2026, skyDay: 295, skyHour: 6, skyStars: 1, skyExtinction: 0.15,
  skyScintillation: 0.035, skyMilkyWay: 1, skyAirglow: 1, skyZodiacal: 0.2,
  skyHaze: 0.15, skyMoon: "none", skyMoonAzimuth: 220, skyMoonAltitude: 34,
  skyMoonEarthshine: 0.0002, skyMoonLux: 0.25,
}
export function createSkySettings(values: Partial<SkySettings> = {}): SkySettings { return { ...SKY_DEFAULTS, ...values } }
export function skyUtc(s: SkySettings): number { return Date.UTC(s.skyYear, 0, 1) + ((s.skyDay - 1) * 24 + s.skyHour) * 3600000 }
/** All settings update live; source assets load only on first physical draw. */
export function skyControls(): LabControl[] {
  const range = (key: keyof SkySettings, label: string, min: number, max: number, step: number, unit: string): LabControl => ({ key, label, group: "Sky", type: "range", min, max, step, unit })
  return [
    { key: "skyMode", label: "Sky", group: "Sky", type: "select", options: [{ value: "today", label: "Today" }, { value: "physical", label: "Physical" }] },
    { key: "skyClock", label: "Clock", group: "Sky", type: "select", options: [{ value: "host", label: "Scene" }, { value: "utc", label: "UTC" }] },
    { key: "skyVision", label: "Vision", group: "Sky", type: "select", options: [{ value: "adapted", label: "Dark-adapted" }, { value: "photometric", label: "Photometric" }] },
    range("skyLatitude", "Latitude", -90, 90, 0.1, "°"),
    range("skyLongitude", "Longitude", -180, 180, 0.1, "°"),
    range("skyHour", "UTC hour", 0, 24, 0.05, "h"),
    range("skyDay", "Day of year", 1, 365, 1, "day"),
    range("skyYear", "Year", 2000, 2100, 1, ""),
    range("skyStars", "Starlight", 0, 3, 0.05, "×"),
    range("skyExtinction", "Extinction", 0.05, 0.6, 0.01, "mag/airmass"),
    range("skyScintillation", "Twinkling", 0, 0.15, 0.005, "×"),
    range("skyMilkyWay", "Milky Way", 0, 3, 0.05, "×"),
    range("skyAirglow", "Airglow", 0, 3, 0.05, "×"),
    range("skyZodiacal", "Zodiacal light", 0, 1, 0.05, "×"),
    range("skyHaze", "Moon haze", 0, 1, 0.01, "×"),
    { key: "skyMoon", label: "Moon", group: "Sky", type: "select", options: ["none", "crescent", "half", "full"].map(value => ({ value, label: value[0]!.toUpperCase() + value.slice(1) })) },
    range("skyMoonAzimuth", "Moon azimuth", 0, 360, 1, "°"),
    range("skyMoonAltitude", "Moon altitude", -10, 90, 1, "°"),
    range("skyMoonLux", "Full moon illuminance", 0.1, 0.35, 0.01, "lx"),
    range("skyMoonEarthshine", "Earthshine", 0, 0.001, 0.00005, "×"),
  ]
}
