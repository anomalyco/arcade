import { DEG, J2000, equatorialToWorld, magnitudeLux, precess, temperatureRgb } from "./astronomy"

export type CatalogueStar = {
  id: number; ra: number; dec: number; magnitude: number; temperature: number
  /** Projected proper motion in arcsec/year (RA already includes cos declination). */
  pmRa: number; pmDec: number
}
export function decodeCatalogue(buffer: ArrayBuffer): CatalogueStar[] {
  if (buffer.byteLength % 28 !== 0) throw new Error("Invalid sky catalogue stride")
  const data = new DataView(buffer), rows: CatalogueStar[] = []
  for (let offset = 0; offset < data.byteLength; offset += 28) {
    const values = Array.from({ length: 7 }, (_, j) => data.getFloat32(offset + j * 4, true))
    if (!values.every(Number.isFinite)) throw new Error("Invalid sky catalogue value")
    const [id, ra, dec, magnitude, temperature, pmRa, pmDec] = values as [number, number, number, number, number, number, number]
    rows.push({ id, ra, dec, magnitude, temperature, pmRa, pmDec })
  }
  return rows
}

/** Packed GPU instance: world direction + magnitude, RGB illuminance + stable id. */
export function packCatalogue(stars: readonly CatalogueStar[], jd: number, latitude: number, lst: number): Float32Array {
  const data = new Float32Array(stars.length * 8), years = (jd - J2000) / 365.25
  const colours = new Map<number, readonly [number, number, number]>()
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i]!, sec = DEG / 3600
    const [ra, dec] = precess(s.ra + s.pmRa * years * sec / Math.max(0.001, Math.cos(s.dec)), s.dec + s.pmDec * years * sec, jd)
    const dir = equatorialToWorld(ra, dec, latitude, lst)
    let colour = colours.get(s.temperature)
    if (!colour) { colour = temperatureRgb(s.temperature); colours.set(s.temperature, colour) }
    const e = magnitudeLux(s.magnitude)
    data.set([...dir, s.magnitude, colour[0] * e, colour[1] * e, colour[2] * e, s.id], i * 8)
  }
  return data
}
