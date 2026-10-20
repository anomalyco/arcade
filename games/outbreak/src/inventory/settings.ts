import type { LabControl } from "@arcade/kit/lab-panel"

/** Lab › Inventory › Style (AR-94). Today is the dock and its Tab pack; the others replace what Tab opens. */
export const INVENTORY_STYLES = ["today", "ground", "case", "sheet"] as const
export type InventoryStyle = (typeof INVENTORY_STYLES)[number]

export const DEFAULT_INVENTORY_SETTINGS = {
  /** What Tab opens: Today's pack chip, the Ground Pack, the Attaché Case or the Survivor Sheet. */
  inventoryStyle: "today" as InventoryStyle,
  /** Ground Pack: you kneel while the bag is open, and walking picks it up again. */
  invKneel: true,
  /** Ground Pack: how far the camera leans in while the bag is open (0 stays put). */
  invPushIn: 0.75,
  /** Ground Pack: the bag's own lamp, so the mat reads in the dark (0 off). */
  invLamp: 0.8,
  /** Ground Pack: how much of the screen's width the mat spans once the camera has leaned in. */
  invMatScreen: 0.55,
  /** Attaché Case and Survivor Sheet: cell size in CSS pixels. */
  invCell: 40,
  /** Every style: what you pick up flies into the slot it lands in. */
  invPickupTrail: true,
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
        { label: "Today (dock + Tab pack)", value: "today" },
        { label: "A · Ground Pack (kneel, bag on the floor)", value: "ground" },
        { label: "B · Attaché Case (shaped grid)", value: "case" },
        { label: "C · Survivor Sheet (you | nearby)", value: "sheet" },
      ],
    },
    { key: "invKneel", label: "Ground Pack: kneel while open", group },
    { key: "invPushIn", label: "Ground Pack: camera leans in", group, min: 0, max: 0.85, step: 0.05, unit: "×" },
    { key: "invLamp", label: "Ground Pack: bag lamp", group, min: 0, max: 2, step: 0.05, unit: "×" },
    { key: "invMatScreen", label: "Ground Pack: mat width on screen", group, min: 0.3, max: 0.8, step: 0.05, unit: "×" },
    { key: "invCell", label: "Case and Sheet: cell size", group, min: 28, max: 56, step: 2, unit: "px" },
    { key: "invPickupTrail", label: "Pickups fly to their slot", group },
  ]
}
