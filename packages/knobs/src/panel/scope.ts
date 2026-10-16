// Where keyboard commands land. Focus sits at one of three levels: a row, its card (a group's, or
// a run of ungrouped rows), or the panel itself. R (Random) and ⇧R (Reset) act on the level
// focused, Esc climbs one level a press, and digits pick the focused row's options.

/** How deep focus sits in the panel. */
export type FocusLevel = "row" | "card" | "panel" | "none"

/** Where Esc takes focus from `level`: up one, past a card when the row isn't in one. */
export function escapeTo(level: FocusLevel, inCard = true): FocusLevel {
  if (level === "row") return inCard ? "card" : "panel"
  if (level === "card") return "panel"
  return "none"
}

/** What R and ⇧R act on: a selection always wins, then the level focused. */
export type CommandScope = "selection" | "row" | "group" | "all"

export function commandScope(level: FocusLevel, selection = false): CommandScope {
  if (selection) return "selection"
  if (level === "row") return "row"
  if (level === "card") return "group"
  return "all"
}

/** How a command reads from where it would land: "Random this", "Reset group", "Random all". */
export function scopeLabel(verb: string, scope: CommandScope): string {
  const what =
    scope === "selection"
      ? "selected"
      : scope === "row"
        ? "this"
        : scope === "group"
          ? "group"
          : "all"
  return `${verb} ${what}`
}

/**
 * The option a digit picks among `count` (0-based), or undefined when it names none: 1–9 pick
 * the first nine, as they read.
 */
export function digitOption(key: string, count: number): number | undefined {
  if (!/^[1-9]$/.test(key)) return undefined
  const i = Number(key) - 1
  return i < count ? i : undefined
}

/**
 * The digit hints for a row's options: one per option that shows (up to nine), or, while they
 * don't (a menu, a folded editor), one standing for them all ("1–5").
 */
export function digitHints(count: number, showing: boolean): string[] {
  const n = Math.min(9, count)
  if (n <= 0) return []
  if (showing) return Array.from({ length: n }, (_, i) => String(i + 1))
  return [n === 1 ? "1" : `1–${n}`]
}
