/** Metres, seconds and optical extinction / metre. Radius/hold/fade apply on next spawn. */
export const smokeDefaults = {
  radius: 5.5, height: 3.2, softness: 1.4, billowScale: 1,
  growthTime: 1.9, rise: 0.34, wind: 0.25, turbulence: 0.65,
  extinction: 2.8, lighting: 1, hold: 4.1, fade: 3,
}
export type SmokeSettings = typeof smokeDefaults
export type SmokeKey = keyof SmokeSettings
export const smokeRanges: Record<SmokeKey, readonly [number, number, number, string, string]> = {
  radius: [2, 8, 0.1, "m · retrigger", "Shape"], height: [1, 4, 0.1, "m", "Shape"],
  softness: [0.6, 2.5, 0.1, "m", "Shape"], billowScale: [0.5, 2, 0.05, "×", "Shape"],
  growthTime: [0.6, 4, 0.1, "s · retrigger", "Motion"], rise: [0, 0.8, 0.05, "m/s", "Motion"],
  wind: [-0.8, 0.8, 0.05, "m/s", "Motion"], turbulence: [0, 1, 0.05, "×", "Motion"],
  extinction: [0.5, 5, 0.1, "/m", "Appearance"], lighting: [0, 1.5, 0.05, "×", "Appearance"],
  hold: [0, 10, 0.1, "s · retrigger", "Lifetime"], fade: [1, 6, 0.1, "s · retrigger", "Lifetime"],
}
export function smokeSettings(input: Partial<SmokeSettings> = {}): SmokeSettings {
  const out = { ...smokeDefaults }
  for (const key of Object.keys(out) as SmokeKey[]) {
    const value = input[key], [min, max] = smokeRanges[key]
    if (value !== undefined && Number.isFinite(value)) out[key] = Math.max(min, Math.min(max, value))
  }
  return out
}
