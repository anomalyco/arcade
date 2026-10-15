import type { PanelCommand, PanelKeys } from "../core/store.js"

/** How a panel reads keys that aren't commands (see `PanelKeys`): resolved once per panel. */
export interface KeyPrefs {
  /** j/k and h/l as aliases for the arrows. */
  readonly vim: boolean
  /** Digits, `.`, `-` and Enter on a slider open its inline number editor. */
  readonly edit: boolean
  /** What ⇧ multiplies a step by. */
  readonly bigStep: number
  /** ↑/↓ wrap from the last row to the first. */
  readonly wrap: boolean
}
export const DEFAULT_PREFS: KeyPrefs = { vim: true, edit: true, bigStep: 10, wrap: true }
const byRoot = new WeakMap<Element, KeyPrefs>()
export const setKeyPrefs = (root: Element, prefs: KeyPrefs) => byRoot.set(root, prefs)
/** The preferences of the panel `node` sits in. */
export function keyPrefs(node: EventTarget | null): KeyPrefs {
  const root = (node as Element | null)?.closest?.(".knobs-panel")
  return (root && byRoot.get(root)) || DEFAULT_PREFS
}
/** -1, 1 or 0 for ←/→ (and h/l unless the panel turned the letter aliases off). */
export function arrowOf(event: KeyboardEvent): -1 | 0 | 1 {
  const vim = keyPrefs(event.target).vim
  if (event.key === "ArrowLeft" || (vim && event.key === "h")) return -1
  if (event.key === "ArrowRight" || (vim && event.key === "l")) return 1
  return 0
}
/** ⇧'s multiplier for this event (1 without ⇧). */
export const bigOf = (event: KeyboardEvent) => (event.shiftKey ? keyPrefs(event.target).bigStep : 1)

/** Each command's default keys. */
const DEFAULT_KEYS: Readonly<Record<PanelCommand, readonly string[]>> = {
  random: ["r"],
  mutate: ["r"],
  reset: ["Backspace", "Delete"],
  resetAll: ["R"],
  compare: ["\\"],
  hint: ["s"],
  undo: ["u", "z"],
  redo: ["U", "Z"],
  copy: ["C"],
  save: ["S"],
  lock: ["L"],
  presets: ["[", "]"],
  group: ["g"],
  first: ["f"],
  help: ["?"],
  menu: ["ContextMenu"],
  leave: ["Escape"],
}
/** ⌥ commands and Tab-like keys that a remap may share with a plain command. */
const ALT_COMMANDS = new Set<PanelCommand>(["mutate"])

/**
 * The keys each command answers to. An explicit binding wins: a default that collides with one
 * is dropped (`{ hint: "f" }` takes `f` from "first row"). `presets` takes two characters, back
 * then forward (`"[]"`).
 */
export function resolveKeys(
  given: PanelKeys | undefined,
  page = false,
): Record<PanelCommand, string[]> {
  const out = {} as Record<PanelCommand, string[]>
  const explicit = new Set<string>()
  for (const [command, value] of Object.entries(given ?? {}) as [PanelCommand, unknown][])
    if (command in DEFAULT_KEYS && typeof value === "string" && !ALT_COMMANDS.has(command))
      for (const k of command === "presets" ? [...value] : [value]) explicit.add(k)
  for (const command of Object.keys(DEFAULT_KEYS) as PanelCommand[]) {
    const value = given?.[command]
    if (value === false) out[command] = []
    else if (typeof value === "string")
      out[command] = command === "presets" ? [...value].slice(0, 2) : [value]
    else
      out[command] = DEFAULT_KEYS[command].filter(
        (k) => ALT_COMMANDS.has(command) || !explicit.has(k),
      )
  }
  if (page) out.leave = []
  return out
}
/** How a key reads in the shortcuts popover. */
export function keyLabel(key: string, alt = false): string {
  const named: Record<string, string> = {
    Backspace: "⌫",
    Delete: "⌦",
    Escape: "Esc",
    ContextMenu: "Menu",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    " ": "Space",
  }
  if (alt) return `⌥${key.toUpperCase()}`
  if (named[key]) return named[key]
  return /^[A-Z]$/.test(key) ? `⇧${key}` : key
}
