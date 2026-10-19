import type { LabControl } from "@arcade/kit/lab-panel"

/** Crafting HUD styles (Lab › Crafting › Style). Today stays the default until Kit picks one. */
export const CRAFT_STYLE_TODAY = 0
/** Hold Q opens a recipe panel: names, have/need counts, what is missing and where it turns up, and how to learn the rest. */
export const CRAFT_STYLE_PANEL = 1
/** Today's wordless strip, plus short tips at the moments that teach: first material, the bench, a recipe learned, a recipe ready. */
export const CRAFT_STYLE_TIPS = 2
/** The recipe panel and the tips. */
export const CRAFT_STYLE_BOTH = 3

export const CRAFT_STYLES = [
  { label: "Today", value: CRAFT_STYLE_TODAY },
  { label: "Recipe panel", value: CRAFT_STYLE_PANEL },
  { label: "Teaching tips", value: CRAFT_STYLE_TIPS },
  { label: "Panel and tips", value: CRAFT_STYLE_BOTH },
] as const

export const DEFAULT_CRAFTING_SETTINGS = {
  craftStyle: CRAFT_STYLE_TODAY as number,
  /** Times each kind of tip is shown in this browser before it stops. */
  craftTipUses: 3,
  /** Seconds a tip stays up. */
  craftTipTime: 5,
}

export type CraftingSettings = typeof DEFAULT_CRAFTING_SETTINGS

export const showsPanel = (s: CraftingSettings) => s.craftStyle === CRAFT_STYLE_PANEL || s.craftStyle === CRAFT_STYLE_BOTH
export const showsTips = (s: CraftingSettings) => s.craftStyle === CRAFT_STYLE_TIPS || s.craftStyle === CRAFT_STYLE_BOTH

export const craftingControls: LabControl[] = [
  { key: "craftStyle", label: "Style", group: "Crafting", options: CRAFT_STYLES.map((s) => ({ ...s })) },
  { key: "craftTipUses", label: "Times each tip shows", group: "Crafting", min: 1, max: 10, step: 1, unit: "" },
  { key: "craftTipTime", label: "Tip time", group: "Crafting", min: 2, max: 12, step: 0.5, unit: "s" },
]
