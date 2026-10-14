/**
 * Cross-game physical keyboard control standard (`KeyboardEvent.code`) and layout-aware prompt labels.
 *
 * All gameplay actions bind to physical key positions (`e.code`) so the left-hand WASD + E/R/F/C/V/G/Shift/Space
 * cluster sits in the same physical place on QWERTY, Dvorak, Colemak, and AZERTY without cross-layout collisions.
 * On-screen HUD prompts resolve through `navigator.keyboard.getLayoutMap()` where available (and live unshifted key
 * events), falling back to the physical code label.
 */

export type StandardAction =
  | "moveUp"
  | "moveDown"
  | "moveLeft"
  | "moveRight"
  | "sprint"
  | "crouch"
  | "interact"
  | "cycleAction"
  | "reload"
  | "jump"
  | "handbrake"
  | "melee"
  | "equip"
  | "seat"
  | "horn"
  | "scoreboard"
  | "teams"
  | "chat"
  | "mute"
  | "pause"
  | "lab"

export type ActionBindings = Readonly<Record<StandardAction, readonly string[]>>

export const STANDARD_BINDINGS: ActionBindings = {
  moveUp: ["KeyW", "ArrowUp"],
  moveDown: ["KeyS", "ArrowDown"],
  moveLeft: ["KeyA", "ArrowLeft"],
  moveRight: ["KeyD", "ArrowRight"],
  sprint: ["ShiftLeft", "ShiftRight"],
  crouch: ["ControlLeft", "KeyC"],
  interact: ["KeyE", "KeyF"],
  cycleAction: ["KeyQ"],
  reload: ["KeyR"],
  jump: ["Space"],
  handbrake: ["Space"],
  melee: ["KeyV"],
  equip: ["KeyG"],
  seat: ["KeyC"],
  horn: ["KeyH"],
  scoreboard: ["Tab"],
  teams: ["KeyT"],
  chat: ["Enter", "NumpadEnter", "KeyT"],
  mute: ["KeyM"],
  pause: ["Escape"],
  lab: ["Backquote"],
}

type KeyboardLayoutMapLike = {
  get(code: string): string | undefined
  entries?(): IterableIterator<[string, string]>
  forEach?(callback: (value: string, key: string) => void): void
}

type NavigatorWithKeyboard = Navigator & {
  keyboard?: {
    getLayoutMap?: () => Promise<KeyboardLayoutMapLike>
    addEventListener?: (type: string, listener: () => void) => void
  }
}

const CODE_FALLBACK_LABELS: Readonly<Record<string, string>> = {
  ShiftLeft: "SHIFT",
  ShiftRight: "SHIFT",
  ControlLeft: "CTRL",
  ControlRight: "CTRL",
  AltLeft: "ALT",
  AltRight: "ALT",
  MetaLeft: "CMD",
  MetaRight: "CMD",
  Space: "SPACE",
  Tab: "TAB",
  Escape: "ESC",
  Enter: "ENTER",
  NumpadEnter: "ENTER",
  Backquote: "~",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
}

const resolvedLabels = new Map<string, string>()
const listeners = new Set<() => void>()
let layoutMapInitialized = false

function notifyListeners(): void {
  for (const fn of listeners) fn()
}

function normalizeGlyph(raw: string | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  return trimmed.length === 1 ? trimmed.toUpperCase() : trimmed.toUpperCase()
}

/** Fallback label derived purely from a physical `KeyboardEvent.code`. */
export function fallbackCodeLabel(code: string): string {
  if (code in CODE_FALLBACK_LABELS) return CODE_FALLBACK_LABELS[code]!
  if (code.startsWith("Key") && code.length === 4) return code.slice(3).toUpperCase()
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5)
  if (code.startsWith("Numpad") && code.length === 7) return code.slice(6)
  return code.toUpperCase()
}

/** Queries `navigator.keyboard.getLayoutMap()` when available and caches printable labels by physical `code`. */
export async function refreshKeyLayout(): Promise<void> {
  if (typeof navigator === "undefined") return
  const kb = (navigator as NavigatorWithKeyboard).keyboard
  if (!kb?.getLayoutMap) return
  try {
    const map = await kb.getLayoutMap()
    if (!map || typeof map.get !== "function") return
    let changed = false
    const apply = (code: string, value: string | undefined) => {
      const glyph = normalizeGlyph(value)
      if (glyph && resolvedLabels.get(code) !== glyph) {
        resolvedLabels.set(code, glyph)
        changed = true
      }
    }
    if (typeof map.forEach === "function") {
      map.forEach((value, key) => apply(key, value))
    } else {
      for (const code of [
        "KeyQ", "KeyW", "KeyE", "KeyR", "KeyT", "KeyY", "KeyU", "KeyI", "KeyO", "KeyP",
        "KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK", "KeyL",
        "KeyZ", "KeyX", "KeyC", "KeyV", "KeyB", "KeyN", "KeyM",
        "Comma", "Period", "Slash", "Semicolon", "Quote", "BracketLeft", "BracketRight",
      ]) {
        apply(code, map.get(code))
      }
    }
    if (changed) notifyListeners()
  } catch {
    // Fallback labels remain active when permission or secure-context restrictions block getLayoutMap().
  }
}

function ensureLayoutMapInitialized(): void {
  if (layoutMapInitialized || typeof navigator === "undefined") return
  layoutMapInitialized = true
  void refreshKeyLayout()
  const kb = (navigator as NavigatorWithKeyboard).keyboard
  kb?.addEventListener?.("layoutchange", () => {
    void refreshKeyLayout()
  })
}

/**
 * Observes a live `keydown` event to learn the user's layout glyph when `navigator.keyboard.getLayoutMap()`
 * is unsupported or has not resolved yet.
 */
export function observeKeyLayout(e: {
  code: string
  key: string
  shiftKey?: boolean
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
}): void {
  if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return
  if (!e.code.startsWith("Key") && !["Comma", "Period", "Slash", "Semicolon", "Quote"].includes(e.code)) return
  if (e.key.length !== 1) return
  const glyph = normalizeGlyph(e.key)
  if (glyph && resolvedLabels.get(e.code) !== glyph) {
    resolvedLabels.set(e.code, glyph)
    notifyListeners()
  }
}

/** Override or clear the layout map for deterministic unit and browser tests. */
export function setKeyLayoutMapForTest(
  entries: ReadonlyMap<string, string> | Readonly<Record<string, string>> | null,
): void {
  resolvedLabels.clear()
  if (entries) {
    const iter = entries instanceof Map ? entries.entries() : Object.entries(entries)
    for (const [code, value] of iter) {
      const glyph = normalizeGlyph(value)
      if (glyph) resolvedLabels.set(code, glyph)
    }
  }
  notifyListeners()
}

/** Subscribe to layout label changes (e.g. when `navigator.keyboard.getLayoutMap()` resolves). */
export function onKeyLayoutChange(listener: () => void): () => void {
  ensureLayoutMapInitialized()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Returns the display label for a physical `KeyboardEvent.code` in the user's current keyboard layout,
 * falling back to the standard physical code letter (`KeyE` -> `"E"`, or `"."` on Dvorak).
 */
export function keyLabel(code: string): string {
  ensureLayoutMapInitialized()
  return resolvedLabels.get(code) ?? fallbackCodeLabel(code)
}

/** Returns the 4-key movement cluster label for the user's layout (`"WASD"` on QWERTY, `",AOE"` on Dvorak). */
export function moveClusterLabel(): string {
  return `${keyLabel("KeyW")}${keyLabel("KeyA")}${keyLabel("KeyS")}${keyLabel("KeyD")}`
}

/** Checks whether a physical `KeyboardEvent.code` matches a standard action. */
export function matchesAction(
  code: string,
  action: StandardAction,
  bindings: ActionBindings = STANDARD_BINDINGS,
): boolean {
  return bindings[action].includes(code)
}
