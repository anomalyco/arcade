import type { LabControl } from "@arcade/kit/lab-panel"

/**
 * Crafting HUD (D-38 Panel And Tips, D-39 Recipe Board): the recipe panel `C` and the workbench open, and one-line tips
 * at the moments that teach. Lab › Crafting.
 */
/** Opens and closes the recipe panel on foot (physical `KeyC`; in a vehicle it changes seat). */
export const CRAFT_KEY = "KeyC"

export const DEFAULT_CRAFTING_SETTINGS = {
  /** Teaching tips above the dock: a recipe filling in, enough to make one, the first workbench. */
  craftTips: true,
  /** Times each kind of tip is shown in this browser before it stops. */
  craftTipUses: 3,
  /** Seconds a tip stays up. */
  craftTipTime: 5,
}

export type CraftingSettings = typeof DEFAULT_CRAFTING_SETTINGS

export const craftingControls: LabControl[] = [
  { key: "craftTips", label: "Teaching tips", group: "Crafting" },
  { key: "craftTipUses", label: "Times each tip shows", group: "Crafting", min: 1, max: 10, step: 1, unit: "" },
  { key: "craftTipTime", label: "Tip time", group: "Crafting", min: 2, max: 12, step: 0.5, unit: "s" },
]
