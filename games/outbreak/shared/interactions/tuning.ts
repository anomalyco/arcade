/**
 * World interactions' rules (AR-96), one Lab group (Backquote › Interactions): every toggle on by default, each
 * interaction's "off" is Today.
 */
export type InteractionsTuning = {
  // ── Throwables (`throwables.ts`) ──
  /** 1 on; 0 is Today: the old fixed-range bottle and none of the new things in the world. */
  throwables: number
  /** Seconds of holding the button to reach a full throw. */
  throwWindup: number
  /** Share of full range a tap throws. */
  throwTap: number
  /** Scales every throw's range. */
  throwRange: number
  /** Scales every throw's damage. */
  throwDamage: number
  /** Scales how far every landing carries to the dead. */
  throwNoise: number
  /** Chance a house has a throwable lying about (in the yard, on the porch or on a floor). */
  throwYard: number
  // ── Drag and brace (`furniture.ts`, `drag.ts`) ──
  /** 1 on; 0 is Today: no loose furniture, nothing to drag or brace with. */
  furniture: number
  /** Scales the walking speed each piece leaves its dragger (a dresser 0.55 at 1). */
  dragSpeed: number
  /** Scales how many blows a braced piece takes. */
  braceStrength: number
  /** 1: tap E at a downed teammate drags them (hold still revives); 0 is Today. */
  haul: number
  /** Share of walking speed while hauling a teammate. */
  haulSpeed: number
  /** Share of walking speed while carrying a car battery (1 = no penalty, Today). */
  heavyCarry: number
  // ── Boarding (`boards.ts`) ──
  /** 1: one B keeps nailing boards until the opening is full; 0 is Today: one board per press. */
  boardChain: number
  /** 1: hold E at a boarded door or window to pry a board off and keep the plank; 0 is Today: boards stay. */
  pryBoards: number
}

export const DEFAULT_INTERACTIONS_TUNING: InteractionsTuning = {
  throwables: 1,
  throwWindup: 0.75,
  throwTap: 0.3,
  throwRange: 1,
  throwDamage: 1,
  throwNoise: 1,
  throwYard: 0.7,
  furniture: 1,
  dragSpeed: 1,
  braceStrength: 1,
  haul: 1,
  haulSpeed: 0.55,
  heavyCarry: 0.85,
  boardChain: 1,
  pryBoards: 1,
}

const TODAY_ON = [
  { label: "Today (off)", value: 0 },
  { label: "On", value: 1 },
] as const
const T = "Interactions · Throwables"
const D = "Interactions · Drag & brace"
const B = "Interactions · Boarding"

export const interactionsControls = [
  { key: "interactions.throwables", field: "throwables", label: "Throwables", group: T, options: TODAY_ON },
  { key: "interactions.throwWindup", field: "throwWindup", label: "Full wind-up", group: T, min: 0.2, max: 2, step: 0.05, unit: "s" },
  { key: "interactions.throwTap", field: "throwTap", label: "Tap throw", group: T, min: 0.1, max: 1, step: 0.05, unit: "× range" },
  { key: "interactions.throwRange", field: "throwRange", label: "Range", group: T, min: 0.3, max: 2, step: 0.05, unit: "×" },
  { key: "interactions.throwDamage", field: "throwDamage", label: "Damage", group: T, min: 0, max: 4, step: 0.1, unit: "×" },
  { key: "interactions.throwNoise", field: "throwNoise", label: "Landing noise", group: T, min: 0, max: 3, step: 0.1, unit: "×" },
  { key: "interactions.throwYard", field: "throwYard", label: "Houses with one lying about", group: T, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "interactions.furniture", field: "furniture", label: "Loose furniture", group: D, options: TODAY_ON },
  { key: "interactions.dragSpeed", field: "dragSpeed", label: "Dragging speed", group: D, min: 0.3, max: 1.5, step: 0.05, unit: "×" },
  { key: "interactions.braceStrength", field: "braceStrength", label: "Brace strength", group: D, min: 0.2, max: 4, step: 0.1, unit: "×" },
  { key: "interactions.haul", field: "haul", label: "Drag a downed teammate", group: D, options: TODAY_ON },
  { key: "interactions.haulSpeed", field: "haulSpeed", label: "Hauling speed", group: D, min: 0.2, max: 1, step: 0.05, unit: "× walk" },
  { key: "interactions.heavyCarry", field: "heavyCarry", label: "Carrying a car battery", group: D, min: 0.3, max: 1, step: 0.05, unit: "× walk" },
  { key: "interactions.boardChain", field: "boardChain", label: "One B boards it up", group: B, options: TODAY_ON },
  { key: "interactions.pryBoards", field: "pryBoards", label: "Hold E pries a board off", group: B, options: TODAY_ON },
] as const

export function interactionsTuning(features: Readonly<Record<string, Record<string, unknown>>> | undefined): InteractionsTuning {
  return { ...DEFAULT_INTERACTIONS_TUNING, ...(features?.interactions as Partial<InteractionsTuning> | undefined) }
}
