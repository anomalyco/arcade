import type { LabControl } from "@arcade/kit/lab-panel"

/**
 * Lab › Inventory › Style (AR-94). D-46 picked the Attaché Case: Tab opens the case, everything you carry outside your
 * hands lies in it at its shape. Today is the old dock and its Tab sheet over the same case (the rules are the room's,
 * so teammates can each use their own).
 */
export const INVENTORY_STYLES = ["case", "today"] as const
export type InventoryStyle = (typeof INVENTORY_STYLES)[number]

export const DEFAULT_INVENTORY_SETTINGS = {
  /** What Tab opens: the Attaché Case, or Today's dock sheet. */
  inventoryStyle: "case" as InventoryStyle,
  /** Cell size in CSS pixels (smaller on a small screen, so the case and the crate always fit). */
  invCell: 56,
}

export type InventorySettings = typeof DEFAULT_INVENTORY_SETTINGS

export function inventoryControls(): LabControl[] {
  const group = "Inventory"
  return [
    {
      key: "inventoryStyle",
      label: "Style",
      group,
      options: [
        { label: "Attaché Case (shaped grid)", value: "case" },
        { label: "Today (dock + Tab sheet)", value: "today" },
      ],
    },
    { key: "invCell", label: "Cell size", group, min: 36, max: 80, step: 2, unit: "px" },
  ]
}
