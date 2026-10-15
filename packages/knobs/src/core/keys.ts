/**
 * Key combinations as portable strings: modifiers in the order Ctrl, Alt, Shift, Meta, then the
 * key (`"Meta+Shift+K"`, `"Space"`, `"F"`, `"Alt+ArrowUp"`). `Mod` reads as Meta on Apple
 * platforms and Ctrl elsewhere. `""` is no combination.
 */
const MODS = ["Ctrl", "Alt", "Shift", "Meta"] as const
type Mod = (typeof MODS)[number]
const ALIASES: Record<string, Mod | "Mod"> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  "⌃": "Ctrl",
  alt: "Alt",
  option: "Alt",
  opt: "Alt",
  "⌥": "Alt",
  shift: "Shift",
  "⇧": "Shift",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  "⌘": "Meta",
  mod: "Mod",
}
const NAMED: Record<string, string> = {
  " ": "Space",
  space: "Space",
  spacebar: "Space",
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
}

export const isApple = () =>
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad|ipod/i.test(
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
      navigator.platform ??
      "",
  )

const keyName = (raw: string) => {
  if (!raw) return ""
  const named = NAMED[raw.toLowerCase()]
  if (named) return named
  if (raw.length === 1) return raw.toUpperCase()
  if (/^f\d{1,2}$/i.test(raw)) return raw.toUpperCase()
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}

/** The canonical spelling of a combination, or `""` when it names no key. */
export function normalizeCombo(combo: string): string {
  const trimmed = combo.trim()
  if (!trimmed) return ""
  // "+" alone (or at the end, "Shift++") is the plus key.
  const parts = trimmed === "+" ? ["+"] : trimmed.replace(/\+\+$/, "+plus").split("+")
  const mods = new Set<Mod>()
  let key = ""
  for (const part of parts) {
    const alias = ALIASES[part.trim().toLowerCase()] ?? ALIASES[part.trim()]
    if (alias === "Mod") mods.add(isApple() ? "Meta" : "Ctrl")
    else if (alias) mods.add(alias)
    else key = part === "plus" ? "+" : keyName(part.trim() || part)
  }
  if (!key) return ""
  return [...MODS.filter((m) => mods.has(m)), key].join("+")
}

/** The combination a keydown names, or `""` for a bare modifier. */
export function comboFromEvent(event: KeyboardEvent): string {
  if (["Shift", "Alt", "Meta", "Control", "CapsLock", "Fn", "OS"].includes(event.key)) return ""
  const code = event.code ?? ""
  // Letters and digits by position: ⌥ and ⇧ change the character on macOS.
  const key = /^Key[A-Z]$/.test(code)
    ? code.slice(3)
    : /^Digit\d$/.test(code)
      ? code.slice(5)
      : code === "Space"
        ? "Space"
        : keyName(event.key)
  return [
    event.ctrlKey ? "Ctrl" : "",
    event.altKey ? "Alt" : "",
    event.shiftKey ? "Shift" : "",
    event.metaKey ? "Meta" : "",
    key,
  ]
    .filter(Boolean)
    .join("+")
}

/** The modifiers held in an event, as a combination's prefix (for a live capture preview). */
export function heldMods(event: KeyboardEvent): string[] {
  return MODS.filter((m) =>
    m === "Ctrl"
      ? event.ctrlKey
      : m === "Alt"
        ? event.altKey
        : m === "Shift"
          ? event.shiftKey
          : event.metaKey,
  )
}

/** Whether a keydown presses `combo` (normalized or not). */
export function matchesCombo(combo: string, event: KeyboardEvent): boolean {
  const want = normalizeCombo(combo)
  return want !== "" && want === comboFromEvent(event)
}

const GLYPHS: Record<Mod, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" }
const WORDS: Record<Mod, string> = { Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: "Meta" }
const KEY_GLYPHS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Backspace: "⌫",
  Delete: "⌦",
  Enter: "↩",
  Escape: "Esc",
  Tab: "⇥",
  PageUp: "PgUp",
  PageDown: "PgDn",
}

/**
 * How a combination reads: Apple glyphs on Apple platforms (`⌃⌥⇧⌘K`), words elsewhere
 * (`Ctrl+Shift+K`). Returns the parts so a chip can space them.
 */
export function comboParts(combo: string, apple = isApple()): string[] {
  const norm = normalizeCombo(combo)
  if (!norm) return []
  const parts = norm === "+" ? ["+"] : norm.split("+")
  if (norm.endsWith("++")) parts.splice(-2, 2, "+")
  const key = parts.pop()!
  const mods = parts as Mod[]
  const shown = KEY_GLYPHS[key] ?? key
  return apple ? [...mods.map((m) => GLYPHS[m]), shown] : [...mods.map((m) => WORDS[m]), shown]
}
export function comboLabel(combo: string, apple = isApple()): string {
  return comboParts(combo, apple).join(apple ? "" : "+")
}
