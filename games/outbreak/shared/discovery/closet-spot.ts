/**
 * Where a closet goes in a house's north bedroom: against the north wall in the gap between the bed and the dresser,
 * when there is room for one (1.3 m). `bed` and `dresser` are prop centres.
 */
export function closetSpot(wallY: number, bed: { x: number }, dresser: { x: number }): { x: number; y: number } | null {
  const bedRight = bed.x + 0.86
  const dresserLeft = dresser.x - 1.1
  if (dresserLeft - bedRight < 1.3) return null
  return { x: Number(((bedRight + dresserLeft) / 2).toFixed(2)), y: Number((wallY + 0.22 + 0.3).toFixed(2)) }
}
