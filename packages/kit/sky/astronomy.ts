/** Astronomical angles in radians; world axes east +X, up +Y, north -Z. */
export type SkyVector = readonly [number, number, number]
export const DEG = Math.PI / 180
export const J2000 = 2451545
export const MAG_ZERO_LUX = 2.54e-6
export const MOON_RADIUS = 0.259 * DEG
const wrap = (r: number) => ((r % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)

export function julianDate(utcMs: number): number { return utcMs / 86400000 + 2440587.5 }

/** Meeus GMST, east-positive geographic longitude. UT1≈UTC (sub-arcminute game use). */
export function siderealTime(jd: number, longitudeDeg: number): number {
  const t = (jd - J2000) / 36525
  return wrap((280.46061837 + 360.98564736629 * (jd - J2000) + 0.000387933 * t * t - t * t * t / 38710000 + longitudeDeg) * DEG)
}

/** Precess J2000 equatorial coordinates to mean equator/equinox of date (IAU 1976). */
export function precess(ra: number, dec: number, jd: number): [number, number] {
  const t = (jd - J2000) / 36525, sec = DEG / 3600
  const zeta = (2306.2181 * t + 0.30188 * t * t + 0.017998 * t ** 3) * sec
  const z = (2306.2181 * t + 1.09468 * t * t + 0.018203 * t ** 3) * sec
  const theta = (2004.3109 * t - 0.42665 * t * t - 0.041833 * t ** 3) * sec
  const a = Math.cos(dec) * Math.sin(ra + zeta)
  const b = Math.cos(theta) * Math.cos(dec) * Math.cos(ra + zeta) - Math.sin(theta) * Math.sin(dec)
  const c = Math.sin(theta) * Math.cos(dec) * Math.cos(ra + zeta) + Math.cos(theta) * Math.sin(dec)
  return [wrap(Math.atan2(a, b) + z), Math.asin(Math.max(-1, Math.min(1, c)))]
}

export function equatorialToWorld(ra: number, dec: number, latitudeDeg: number, lst: number): SkyVector {
  const h = lst - ra, lat = latitudeDeg * DEG, cd = Math.cos(dec), sd = Math.sin(dec)
  return [-cd * Math.sin(h), Math.sin(lat) * sd + Math.cos(lat) * cd * Math.cos(h), -(Math.cos(lat) * sd - Math.sin(lat) * cd * Math.cos(h))]
}

/** Finite Kasten–Young 1989 air mass. Below the astronomical horizon has zero transmission. */
export function airMass(altitude: number): number {
  const a = Math.max(0, Math.min(90, altitude / DEG))
  return 1 / (Math.sin(a * DEG) + 0.50572 * (a + 6.07995) ** -1.6364)
}
export function extinction(altitude: number, magnitudesPerAirmass: number): number {
  return altitude <= 0 ? 0 : 10 ** (-0.4 * magnitudesPerAirmass * airMass(altitude))
}
export function magnitudeLux(magnitude: number): number { return MAG_ZERO_LUX * 10 ** (-0.4 * magnitude) }

/** Krisciunas/Schaefer phase-magnitude fit; phase angle 0=full, π=new. */
export function moonPhaseGain(phaseAngle: number): number {
  const degrees = Math.abs(phaseAngle) / DEG
  return 10 ** (-0.4 * (0.026 * degrees + 4e-9 * degrees ** 4))
}

/** Spectral class → representative effective temperature, not a stellar-atmosphere fit. */
export function spectralTemperature(spectral: string): number {
  const match = spectral.match(/([OBAFGKM])([0-9](?:\.[0-9])?)/)
  if (!match) return 5778
  const classes = "OBAFGKM", temperatures = [40000, 30000, 10000, 7500, 6000, 5200, 3700, 2400]
  const i = classes.indexOf(match[1]!), f = Number(match[2]) / 10
  return temperatures[i]! * (1 - f) + temperatures[i + 1]! * f
}

/** Planck spectrum integrated against Wyman's analytic CIE 1931 fits; linear Rec.709, Y=1. */
export function temperatureRgb(kelvin: number): SkyVector {
  let x = 0, y = 0, z = 0
  const gaussian = (w: number, centre: number, left: number, right: number) => {
    const t = (w - centre) * (w < centre ? left : right)
    return Math.exp(-0.5 * t * t)
  }
  for (let w = 380; w <= 780; w += 5) {
    const p = 1 / ((w / 560) ** 5 * Math.expm1(1.438776877e7 / (w * kelvin)))
    x += p * (1.056 * gaussian(w, 599.8, 0.0264, 0.0323) + 0.362 * gaussian(w, 442, 0.0624, 0.0374) - 0.065 * gaussian(w, 501.1, 0.049, 0.0382))
    y += p * (0.821 * gaussian(w, 568.8, 0.0213, 0.0247) + 0.286 * gaussian(w, 530.9, 0.0613, 0.0322))
    z += p * (1.217 * gaussian(w, 437, 0.0845, 0.0278) + 0.681 * gaussian(w, 459, 0.0385, 0.0725))
  }
  const rgb = [Math.max(0, 3.2406 * x - 1.5372 * y - 0.4986 * z), Math.max(0, -0.9689 * x + 1.8758 * y + 0.0415 * z), Math.max(0, 0.0557 * x - 0.204 * y + 1.057 * z)]
  const l = rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722
  return [rgb[0]! / l, rgb[1]! / l, rgb[2]! / l]
}

/** Pixel-integrated cubic B-spline PSF. Integer translates partition unity exactly. */
export function starCdf(x: number): number {
  const positive = (v: number) => Math.max(v, 0) ** 4
  if (x <= -2) return 0
  if (x >= 2) return 1
  return (positive(x + 2) - 4 * positive(x + 1) + 6 * positive(x) - 4 * positive(x - 1)) / 24
}
export function starPixelEnergy(offset: number, width = 1): number {
  return Math.max(0, starCdf((offset + 0.5) / width) - starCdf((offset - 0.5) / width))
}
