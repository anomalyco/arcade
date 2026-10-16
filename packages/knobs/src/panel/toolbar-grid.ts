/**
 * How many equal columns a toolbar's buttons take in `avail` px: as many as fit at the widest
 * button's width, then balanced so the rows hold counts as even as they can (four buttons wrap as
 * two and two, never three and one; five as three and two).
 */
export function toolbarColumns(count: number, widest: number, avail: number, gap: number): number {
  if (count <= 1) return 1
  let cols = count
  while (cols > 1 && cols * widest + (cols - 1) * gap > avail + 0.5) cols--
  return Math.ceil(count / Math.ceil(count / cols))
}
