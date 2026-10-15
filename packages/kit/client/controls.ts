/**
 * Cross-game physical keyboard control standard (`KeyboardEvent.code`) and prompt labels.
 *
 * All gameplay actions bind to physical key positions (`e.code`) so the left-hand WASD + E/R/F/C/V/G/Shift/Space
 * cluster sits in the same physical place on QWERTY, Dvorak, Colemak, and AZERTY without cross-layout collisions.
 * On-screen prompts name the QWERTY key at that position on every layout (`KeyE` -> "E"), as most PC games do.
 * Players can opt into their own layout's characters ("Key labels: My keyboard layout"), which resolves through
 * `navigator.keyboard.getLayoutMap()` and live unshifted key events.
 */

export type StandardAction =
  | "moveUp"
  | "moveDown"
  | "moveLeft"
  | "moveRight"
  | "sprint"
  | "crouch"
  | "interact"
  | "secondaryInteract"
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
  secondaryInteract: ["KeyF"],
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

const QWERTY_LABELS: Readonly<Record<string, string>> = {
  ShiftLeft: "Shift",
  ShiftRight: "Shift",
  ControlLeft: "Ctrl",
  ControlRight: "Ctrl",
  AltLeft: "Alt",
  AltRight: "Alt",
  MetaLeft: "Cmd",
  MetaRight: "Cmd",
  Space: "Space",
  Tab: "Tab",
  Escape: "Esc",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Backspace: "Backspace",
  CapsLock: "Caps",
  Backquote: "`",
  Backslash: "\\",
  Mouse0: "LMB",
  Mouse1: "MMB",
  Mouse2: "RMB",
  Wheel: "Wheel",
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

/** `"qwerty"` names the QWERTY key at each physical position; `"layout"` shows the player's own layout characters. */
export type KeyLabelMode = "qwerty" | "layout"
export const KEY_LABEL_STORAGE_KEY = "arcade.keyLabels"
export const KEY_LABEL_OPTIONS: readonly { value: KeyLabelMode; label: string }[] = [
  { value: "qwerty", label: "QWERTY" },
  { value: "layout", label: "My keyboard layout" },
]

const resolvedLabels = new Map<string, string>()
const listeners = new Set<() => void>()
let layoutMapInitialized = false
let hasAuthoritativeLayoutMap = false
let labelMode: KeyLabelMode | null = null

function storedKeyLabelMode(): KeyLabelMode {
  try {
    return globalThis.localStorage?.getItem(KEY_LABEL_STORAGE_KEY) === "layout" ? "layout" : "qwerty"
  } catch {
    return "qwerty"
  }
}

/** The active prompt label mode. Defaults to QWERTY; the opt-in is stored per browser for every arcade game. */
export function keyLabelMode(): KeyLabelMode {
  labelMode ??= storedKeyLabelMode()
  return labelMode
}

/** Switches prompt labels between QWERTY names and the player's layout. Bindings never change. */
export function setKeyLabelMode(mode: KeyLabelMode, persist = true): void {
  const next: KeyLabelMode = mode === "layout" ? "layout" : "qwerty"
  if (persist) {
    try {
      globalThis.localStorage?.setItem(KEY_LABEL_STORAGE_KEY, next)
    } catch {
      // Private browsing or blocked storage keeps the choice for this page only.
    }
  }
  if (keyLabelMode() === next) return
  labelMode = next
  if (next === "layout") ensureLayoutMapInitialized()
  notifyListeners()
}

/**
 * Lab/settings binding for the shared "Key labels" choice:
 *   const k = keyLabelSetting(); panel.addControls(k.settings, [k.control], k.defaults)
 */
export function keyLabelSetting(group = "Controls"): {
  settings: { keyLabels: KeyLabelMode }
  defaults: { keyLabels: KeyLabelMode }
  control: {
    key: "keyLabels"
    label: string
    group: string
    type: "select"
    options: readonly { value: KeyLabelMode; label: string }[]
    change: (value: boolean | number | string) => void
  }
} {
  return {
    settings: { keyLabels: keyLabelMode() },
    defaults: { keyLabels: "qwerty" },
    control: {
      key: "keyLabels",
      label: "Key labels",
      group,
      type: "select",
      options: KEY_LABEL_OPTIONS,
      change: (value) => setKeyLabelMode(value === "layout" ? "layout" : "qwerty"),
    },
  }
}

function notifyListeners(): void {
  for (const fn of listeners) fn()
}

function normalizeGlyph(raw: string | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  return trimmed.length === 1 ? trimmed.toUpperCase() : trimmed.toUpperCase()
}

/** The QWERTY name of a physical `KeyboardEvent.code` (`KeyE` -> "E", `Backquote` -> "`", `ShiftLeft` -> "Shift"). */
export function qwertyKeyLabel(code: string): string {
  if (code in QWERTY_LABELS) return QWERTY_LABELS[code]!
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
    hasAuthoritativeLayoutMap = resolvedLabels.size > 0
    if (changed && keyLabelMode() === "layout") notifyListeners()
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
  if (hasAuthoritativeLayoutMap) return
  if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return
  if (!e.code.startsWith("Key") && !["Comma", "Period", "Slash", "Semicolon", "Quote"].includes(e.code)) return
  if (e.key.length !== 1) return
  const glyph = normalizeGlyph(e.key)
  if (glyph && resolvedLabels.get(e.code) !== glyph) {
    resolvedLabels.set(e.code, glyph)
    if (keyLabelMode() === "layout") notifyListeners()
  }
}

/** Override or clear the layout map (and optionally the label mode) for deterministic unit and browser tests. */
export function setKeyLayoutMapForTest(
  entries: ReadonlyMap<string, string> | Readonly<Record<string, string>> | null,
  mode?: KeyLabelMode,
): void {
  if (mode) labelMode = mode
  resolvedLabels.clear()
  hasAuthoritativeLayoutMap = false
  if (entries) {
    const iter = entries instanceof Map ? entries.entries() : Object.entries(entries)
    for (const [code, value] of iter) {
      const glyph = normalizeGlyph(value)
      if (glyph) resolvedLabels.set(code, glyph)
    }
    hasAuthoritativeLayoutMap = resolvedLabels.size > 0
  }
  notifyListeners()
}

/** Subscribe to prompt label changes: the label mode switching, or the layout map resolving in layout mode. */
export function onKeyLayoutChange(listener: () => void): () => void {
  if (keyLabelMode() === "layout") ensureLayoutMapInitialized()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Returns the prompt label for a physical `KeyboardEvent.code`: its QWERTY name (`KeyE` -> "E" on every layout), or
 * the player's own layout character when they opted into "My keyboard layout" (`KeyE` -> "." on Dvorak).
 */
export function keyLabel(code: string): string {
  if (keyLabelMode() === "qwerty") return qwertyKeyLabel(code)
  ensureLayoutMapInitialized()
  return resolvedLabels.get(code) ?? qwertyKeyLabel(code)
}

/** Returns the 4-key movement cluster label (`"WASD"`; `",AOE"` on Dvorak only in layout mode). */
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

/** True when `target` is an interactive form field or contentEditable element that owns keyboard input. */
export function isEditableEventTarget(target: EventTarget | null | undefined): boolean {
  if (!target || typeof target !== "object") return false
  if (typeof HTMLInputElement !== "undefined" && target instanceof HTMLInputElement) return true
  if (typeof HTMLTextAreaElement !== "undefined" && target instanceof HTMLTextAreaElement) return true
  if (typeof HTMLSelectElement !== "undefined" && target instanceof HTMLSelectElement) return true
  const el = target as { tagName?: unknown; isContentEditable?: unknown }
  const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : ""
  return el.isContentEditable === true || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
}

export const isNavigationKey = (code: string): boolean =>
  code === "Space" || code === "ArrowUp" || code === "ArrowDown" || code === "ArrowLeft" || code === "ArrowRight"

export const isMetaKey = (code: string): boolean => code === "MetaLeft" || code === "MetaRight"

/** Requests Pointer Lock with `unadjustedMovement: true` where supported, falling back to plain Pointer Lock. */
export function requestCanvasPointerLock(canvas: HTMLElement): void {
  const c = canvas as HTMLElement & { requestPointerLock(o?: { unadjustedMovement?: boolean }): Promise<void> | void }
  const plain = () => { try { void Promise.resolve(c.requestPointerLock()).catch(() => {}) } catch {} }
  try {
    const p = c.requestPointerLock({ unadjustedMovement: true })
    if (p) void p.catch(plain)
  } catch { plain() }
}

/** Tracks held physical `KeyboardEvent.code` keys and per-frame key-down edges on `window`. */
export class KeyStateTracker {
  readonly keys = new Set<string>()
  readonly downs = new Set<string>()

  constructor(options?: { onRelease?: () => void; shouldPreventDefault?: (code: string) => boolean }) {
    const prevent = options?.shouldPreventDefault ?? isNavigationKey
    window.addEventListener("keydown", (e: KeyboardEvent) => {
      if (isEditableEventTarget(e.target)) return
      if (prevent(e.code)) e.preventDefault()
      observeKeyLayout(e)
      if (!this.keys.has(e.code)) { this.keys.add(e.code); this.downs.add(e.code) }
    })
    window.addEventListener("keyup", (e: KeyboardEvent) => {
      this.keys.delete(e.code)
      if (isMetaKey(e.code)) { this.release(); options?.onRelease?.() }
    })
    window.addEventListener("blur", () => { this.release(); options?.onRelease?.() })
  }

  held(code: string): boolean { return this.keys.has(code) }
  any(...codes: string[]): boolean { return codes.some((c) => this.keys.has(c)) }
  pressed(...codes: string[]): boolean { return codes.some((c) => this.downs.has(c)) }
  clearDowns(): void { this.downs.clear() }
  release(): void { this.keys.clear(); this.downs.clear() }
}
