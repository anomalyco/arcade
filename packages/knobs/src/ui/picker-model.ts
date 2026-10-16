// The option picker's logic apart from the DOM: which option a key picks, where the selection
// goes when the options change, and which options a change opens and closes.

/** The option a digit names: 1–9 pick the first nine, as they read; past the last, none. */
export function digitPick(ids: readonly string[], key: string): string | undefined {
  if (!/^[1-9]$/.test(key)) return undefined
  return ids[Number(key) - 1]
}

/** ↑/↓ (and Home/End) from `current`, stopping at the ends. */
export function stepPick(
  ids: readonly string[],
  current: string | null,
  key: "ArrowUp" | "ArrowDown" | "Home" | "End",
): string | undefined {
  if (!ids.length) return undefined
  if (key === "Home") return ids[0]
  if (key === "End") return ids[ids.length - 1]
  const i = current === null ? -1 : ids.indexOf(current)
  if (i < 0) return key === "ArrowDown" ? ids[0] : ids[ids.length - 1]
  return ids[Math.max(0, Math.min(ids.length - 1, i + (key === "ArrowDown" ? 1 : -1)))]
}

/** The selection after the options change: kept while its option stays, else the first. */
export function keepPick(ids: readonly string[], selected: string | null): string | null {
  if (selected !== null && ids.includes(selected)) return selected
  return ids[0] ?? null
}

/** The digit an option shows: its place, 1–9; none past the ninth. */
export const pickDigit = (index: number): string => (index < 9 ? String(index + 1) : "")

/**
 * Whether a key event goes to the picker's digits: a bare 1–9 that nothing focused claimed (a
 * panel row picking its own options, a text field) and that isn't typed into a field.
 */
export function claimsDigit(event: {
  readonly key: string
  readonly defaultPrevented: boolean
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly repeat: boolean
  readonly typing: boolean
}): boolean {
  return (
    /^[1-9]$/.test(event.key) &&
    !event.defaultPrevented &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    !event.repeat &&
    !event.typing
  )
}
