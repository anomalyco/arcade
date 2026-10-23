import { DEG, MOON_RADIUS, airMass, equatorialToWorld, extinction, julianDate, moonPhaseGain, precess, siderealTime, temperatureRgb, type SkyVector } from "./astronomy"
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

/** cd/m² per lux of moonlight in Krisciunas & Schaefer's scattering function (10^5.36 nL at their full-moon I*). */
export const MOON_SKY_GAIN = 0.0848
/** The moonlit sky fades out below this sine of altitude (~5°): that band is distant hills, trees and haze. */
export const MOON_SKY_HORIZON = 0.09

/**
 * Moonlit sky luminance (cd/m²), Krisciunas & Schaefer 1991 (PASP 103, 1033): Rayleigh (1.06 + cos²ρ) plus aerosol
 * 10^(0.79 − ρ/40°) per lux reaching the ground, times the share of light the view path scatters, 1 − 10^(−0.4·k·X).
 * `lux` is the moon's illuminance after extinction, `rho` the angle from the moon, `altitude` the view's (radians).
 * The lowest ~5° fade out (`MOON_SKY_HORIZON`). The shader's dome evaluates the same expression.
 */
export function moonSkyLuminance(lux: number, rho: number, altitude: number, extinctionMag: number): number {
  if (lux <= 0) return 0
  const c = Math.cos(rho)
  const h = Math.max(0, Math.min(1, Math.sin(altitude) / MOON_SKY_HORIZON)), horizon = h * h * (3 - 2 * h)
  return lux * MOON_SKY_GAIN * (1.06 + c * c + 10 ** (0.79 - rho / DEG / 40)) * (1 - 10 ** (-0.4 * extinctionMag * airMass(Math.max(altitude, 0)))) * horizon
}

const moonSkyCache = new Map<string, number>()
/** Horizontal illuminance (lux) from the whole moonlit dome (`moonSkyLuminance` × `skyMoonScatter`), numerically integrated. */
export function moonSkyIlluminance(s: SkySettings): number {
  const moon = moonLight(s)
  const lux = moon.illuminanceLux * s.skyMoonScatter
  if (lux <= 0) return 0
  const key = `${moon.direction.join()}:${s.skyExtinction}`
  let unit = moonSkyCache.get(key)
  if (unit === undefined) {
    unit = 0
    const rows = 32, cols = 64
    for (let i = 0; i < rows; i++) {
      const alt = ((i + 0.5) / rows) * Math.PI / 2, dAlt = Math.PI / 2 / rows
      for (let j = 0; j < cols; j++) {
        const az = ((j + 0.5) / cols) * 2 * Math.PI
        const d = [Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt)]
        const rho = Math.acos(Math.max(-1, Math.min(1, d[0]! * moon.direction[0] + d[1]! * moon.direction[1] + d[2]! * moon.direction[2])))
        unit += moonSkyLuminance(1, rho, alt, s.skyExtinction) * Math.sin(alt) * Math.cos(alt) * dAlt * (2 * Math.PI / cols)
      }
    }
    if (moonSkyCache.size > 64) moonSkyCache.clear()
    moonSkyCache.set(key, unit)
  }
  return unit * lux
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
