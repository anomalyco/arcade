import { magnitudeLux } from "./astronomy"

/** Display-referred night vision: concentrate a finite catalogue's existing flux into
 * readable small points. The all-sky photopic illuminance budget is unchanged.
 * This is a perceptual redistribution, not a new catalogue or a brighter physical star. */
export function starVisibilityWeights(magnitudes: readonly number[]): Float32Array {
  const floor = magnitudeLux(7)
  const physical = magnitudes.map(magnitudeLux)
  const visible = physical.map(flux => Math.max(floor, floor * (flux / floor) ** .65))
  const total = physical.reduce((a, b) => a + b, 0)
  const mapped = visible.reduce((a, b) => a + b, 0)
  return Float32Array.from(physical, (flux, i) => mapped > 0 ? visible[i]! / flux * total / mapped : 1)
}

/** Host supplies the eye's adaptation state; sky owns no competing history. Three
 * and a third stops maps ~0.2 mcd/m² sky into the woods' low-light display toe.
 * It is observer sensitivity, not an increase in scene illumination or moon lux. */
export function skySensitivity(adaptation: number): number {
  return 10 ** Math.max(0, Math.min(1, adaptation))
}
