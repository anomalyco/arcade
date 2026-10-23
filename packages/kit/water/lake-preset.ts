import type { ForestLookSettings } from "../forest/settings"

/** Clear moonlit night for the lake station; normal Woods defaults remain authoritative. */
export const MOONLIT_LAKE = {
  lakeLook: "moonlit", moonHeading: 90, moonElevation: 20, moon: 0.3,
  skyMode: "physical", skyClock: "host", skyMoon: "full", skyMoonAzimuth: 180, skyMoonAltitude: 20,
  sky: 2, fogDensity: 0.0002, depthMist: false, mistDensity: 0.025, mistHeight: 0.7,
  autoExposure: false, exposure: 3, lakeScatter: 0.12,
} as const satisfies Partial<ForestLookSettings>
