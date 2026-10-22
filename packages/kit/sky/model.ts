import { DEG, MOON_RADIUS, equatorialToWorld, extinction, julianDate, moonPhaseGain, precess, siderealTime, temperatureRgb, type SkyVector } from "./astronomy"
import { skyUtc, type SkySettings } from "./settings"

export type MoonLight = { direction: SkyVector; colour: SkyVector; illuminanceLux: number; angularRadius: number; phaseAngle: number }
/** Local solar time, not a civil timezone. Preserve the UTC day rollover. */
export function skyClockSettings(s: SkySettings, localHour?: number): SkySettings {
  return s.skyClock === "host" && localHour !== undefined ? { ...s, skyHour: localHour - s.skyLongitude / 15 } : s
}

/** Lunar north is screen-up for a horizon-level observer. */
export function moonBasis([x, y, z]: SkyVector): { right: SkyVector; up: SkyVector } {
  const r = Math.hypot(x, z)
  const right: SkyVector = r > 1e-8 ? [-z / r, 0, x / r] : [1, 0, 0]
  return { right, up: [-right[2] * y, right[2] * x - right[0] * z, right[0] * y] }
}
export function moonLight(s: SkySettings): MoonLight {
  const alt = s.skyMoonAltitude * DEG, az = s.skyMoonAzimuth * DEG
  const phase = s.skyMoon === "crescent" ? 135 * DEG : s.skyMoon === "half" ? Math.PI / 2 : 0
  return {
    direction: [Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt)],
    colour: temperatureRgb(5000),
    illuminanceLux: s.skyMode === "today" || s.skyMoon === "none" ? 0 : s.skyMoonLux * moonPhaseGain(phase) * extinction(alt, s.skyExtinction),
    angularRadius: MOON_RADIUS, phaseAngle: phase,
  }
}

/** World-space axes of the J2000 equatorial frame; shared by the galactic layer and stars. */
export function equatorialBasis(s: SkySettings): readonly SkyVector[] {
  const jd = julianDate(skyUtc(s)), lst = siderealTime(jd, s.skyLongitude)
  return [[0, 0], [Math.PI / 2, 0], [0, Math.PI / 2]].map(([ra, dec]) => {
    const p = precess(ra!, dec!, jd)
    return equatorialToWorld(p[0], p[1], s.skyLatitude, lst)
  })
}

/** Low-order solar ephemeris for twilight and zodiacal orientation (not eclipse work). */
export function sunDirection(s: SkySettings): SkyVector {
  const jd = julianDate(skyUtc(s)), n = jd - 2451545
  const g = (357.529 + 0.98560028 * n) * DEG
  const lambda = (280.459 + 0.98564736 * n) * DEG + 1.915 * DEG * Math.sin(g) + 0.02 * DEG * Math.sin(2 * g)
  const eps = (23.439 - 0.00000036 * n) * DEG
  return equatorialToWorld(Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)), Math.asin(Math.sin(eps) * Math.sin(lambda)), s.skyLatitude, siderealTime(jd, s.skyLongitude))
}
