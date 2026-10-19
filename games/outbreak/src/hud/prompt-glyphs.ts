/**
 * Which glyph stands for each world-prompt action (D-25, Bold Glyph), and which word, if any, still shows beside it.
 * Words stay only where the glyph alone would be ambiguous: a locked door you can't open (versus the Lock action),
 * the item a ground drop holds, riding as a passenger, and the workbench's recipe board. Every action keeps its full label for assistive tech.
 */
import { actionGlyphHtml, type ActionGlyph } from "@arcade/kit/client/action-glyphs"
import type { InteractAction } from "../../shared/interact"

export type PromptGlyph = {
  /** Null when no glyph fits; the prompt then shows the label as before. */
  glyph: ActionGlyph | null
  /** The word still shown beside the glyph ("" for none). */
  word: string
  /** The action's full label, for aria-label and the tooltip. */
  label: string
}

const VEHICLE: Readonly<Record<string, ActionGlyph>> = {
  Drive: "drive",
  Ride: "ride",
  "Fit battery": "battery",
  "No battery": "no-battery",
  Unlock: "key",
  "No keys": "no-keys",
  Refuel: "refuel",
  "Empty tank": "empty-tank",
}

/** Words kept beside the glyph, by label. */
const KEEP: Readonly<Record<string, string>> = { Locked: "Locked", Ride: "Ride", Recipes: "Recipes" }

function glyphFor(kind: string, action: InteractAction): ActionGlyph | null {
  const { id, label } = action
  switch (id) {
    case "toggle":
      if (kind === "radio") return label === "Switch off" ? "radio-off" : "radio-on"
      if (kind === "lamp") return label === "Switch off" ? "light-off" : "light-on"
      if (label === "Open") return kind === "window" ? "window-open" : "door-open"
      if (label === "Close") return kind === "window" ? "window-close" : "door-close"
      return null
    case "lock":
      return label === "Unlock" ? "unlock" : label === "Lock" ? "lock" : null
    case "unlock":
      return "key"
    case "pry":
      return "crowbar"
    case "locked":
      return "lock"
    case "peek":
      return label.startsWith("Stop") ? "peek-stop" : "peek"
    case "climb":
      return kind === "fence" || label === "Vault" ? "vault" : "climb"
    case "search":
      return "search"
    case "smash":
      return "smash"
    case "take":
      return label === "Take all" || label === "Pick up all" ? "take-all" : "take"
    case "install":
      return "install"
    case "board":
      return "tinker"
    case "read":
      return "read"
    case "store":
      return "store"
    case "deposit":
      return "deposit"
    case "hide":
      return label === "Leave" ? "leave" : "hide"
    case "disarm":
      return label === "Take" ? "take" : "disarm"
    case "arm":
      return "string"
    case "feed":
      return "feed"
    case "revive":
      return "revive"
    case "enter":
      return VEHICLE[label] ?? null
    default:
      return null
  }
}

/** The glyph and remaining word for `action` on a target of `kind` (door, window, fence, container, vehicle…). */
export function promptGlyph(kind: string, action: InteractAction): PromptGlyph {
  const glyph = glyphFor(kind, action)
  const label = action.label
  if (!glyph) return { glyph, word: label, label }
  // A drop names what it holds: "Pick up 9mm Ammo" shows the take glyph and "9mm Ammo".
  if (action.id === "take" && label.startsWith("Pick up ") && label !== "Pick up all") return { glyph, word: label.slice(8), label }
  return { glyph, word: KEEP[label] ?? "", label }
}

/** The glyph a downed zombie's finisher cue shows beside the mouse cap. */
export const FINISHER_GLYPH: ActionGlyph = "finish"

/** Glyph markup for a prompt row; the glyph carries the action's label. */
export function promptGlyphHtml(glyph: ActionGlyph, label: string, size: number): string {
  return actionGlyphHtml(glyph, { size, label, className: "prompt-glyph" })
}

const a = (id: InteractAction["id"], label: string, extra: Partial<InteractAction> = {}): InteractAction => ({ id, label, ...extra })

/**
 * Every action the world prompt can show, by target kind, as the game builds them (shared/interact.ts,
 * shared/progression, shared/discovery, shared/vehicles.ts). The Lab glyph sheet lists these, and the tests check
 * the game's source has no prompt label missing from here.
 */
export const PROMPT_ACTIONS: readonly { kind: string; action: InteractAction }[] = [
  { kind: "door", action: a("toggle", "Open") },
  { kind: "door", action: a("toggle", "Close") },
  { kind: "door", action: a("lock", "Lock", { hold: true }) },
  { kind: "door", action: a("lock", "Unlock") },
  { kind: "door", action: a("unlock", "Unlock with key") },
  { kind: "door", action: a("pry", "Pry open") },
  { kind: "door", action: a("pry", "Pry open", { hold: true }) },
  { kind: "door", action: a("locked", "Locked") },
  { kind: "door", action: a("peek", "Peek", { modifier: "shift" }) },
  { kind: "door", action: a("peek", "Stop peeking", { modifier: "shift" }) },
  { kind: "window", action: a("peek", "Peek") },
  { kind: "window", action: a("peek", "Stop peeking") },
  { kind: "window", action: a("toggle", "Open", { hold: true }) },
  { kind: "window", action: a("toggle", "Close", { hold: true }) },
  { kind: "window", action: a("climb", "Climb") },
  { kind: "fence", action: a("climb", "Vault") },
  { kind: "container", action: a("search", "Search") },
  { kind: "container", action: a("smash", "Smash", { modifier: "shift" }) },
  { kind: "container", action: a("take", "Take all") },
  { kind: "drop", action: a("take", "Pick up 9mm Ammo") },
  { kind: "drop", action: a("take", "Pick up all") },
  { kind: "bench", action: a("install", "Install") },
  { kind: "bench", action: a("board", "Recipes") },
  { kind: "page", action: a("read", "Read") },
  { kind: "closet", action: a("hide", "Hide") },
  { kind: "closet", action: a("hide", "Leave") },
  { kind: "tripwire", action: a("disarm", "Disarm") },
  { kind: "tripwire", action: a("disarm", "Take") },
  { kind: "tripwire", action: a("arm", "Re-string", { hold: true }) },
  { kind: "car", action: a("smash", "Smash") },
  { kind: "radio", action: a("toggle", "Switch on") },
  { kind: "radio", action: a("toggle", "Switch off") },
  { kind: "lamp", action: a("toggle", "Switch on") },
  { kind: "lamp", action: a("toggle", "Switch off") },
  { kind: "body", action: a("search", "Search") },
  { kind: "body", action: a("take", "Take all") },
  { kind: "dog", action: a("feed", "Feed") },
  { kind: "downed", action: a("revive", "Revive", { hold: true }) },
  { kind: "fallen", action: a("take", "Take all") },
  { kind: "stash", action: a("store", "Store held item") },
  { kind: "stash", action: a("deposit", "Deposit supplies", { hold: true }) },
  { kind: "vehicle", action: a("enter", "Drive") },
  { kind: "vehicle", action: a("enter", "Ride") },
  { kind: "vehicle", action: a("enter", "Fit battery") },
  { kind: "vehicle", action: a("enter", "No battery") },
  { kind: "vehicle", action: a("enter", "Unlock") },
  { kind: "vehicle", action: a("enter", "No keys") },
  { kind: "vehicle", action: a("enter", "Refuel") },
  { kind: "vehicle", action: a("enter", "Empty tank") },
]
