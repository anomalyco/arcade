import type { DistrictKind } from "../../shared/world"
import type { PoiKind } from "./memory"

export type MapPalette = {
  name: string
  paper: string
  /** Grain drawn over the paper, as rgba. */
  grain: string
  grid: string
  gridMajor: string
  ground: Readonly<Record<DistrictKind, string>>
  sidewalk: string
  road: string
  roadEdge: string
  roadCentre: string
  tree: string
  treeEdge: string
  vehicle: string
  fence: string
  ink: string
  house: string
  poi: Readonly<Record<PoiKind, string>>
  hatch: string
  label: string
  labelSoft: string
  halo: string
  badge: string
  badgeInk: string
  horde: string
  you: string
  /** CSS for the sheet's DOM chrome. */
  chrome: { sheet: string; text: string; soft: string; edge: string }
}

export const SURVEY: MapPalette = {
  name: "Survey paper",
  paper: "#d6cbb0",
  grain: "rgba(92, 70, 40, 0.07)",
  grid: "rgba(110, 92, 62, 0.16)",
  gridMajor: "rgba(110, 92, 62, 0.32)",
  ground: {
    suburb: "#ece4cb",
    commercial: "#efe1c8",
    civic: "#e7e1d0",
    industrial: "#e2ddd0",
    woodland: "#dfe2c4",
  },
  sidewalk: "#d9d0b9",
  road: "#f8f3e5",
  roadEdge: "#5a4c38",
  roadCentre: "rgba(150, 82, 40, 0.75)",
  tree: "rgba(112, 134, 84, 0.55)",
  treeEdge: "rgba(64, 84, 46, 0.6)",
  vehicle: "#4c4339",
  fence: "#7a6a52",
  ink: "#2a231b",
  house: "#9b8d76",
  poi: {
    hardware: "#94704c",
    pharmacy: "#4f8279",
    grocery: "#8f7a3e",
    diner: "#a0674a",
    gas_station: "#a2533a",
    police: "#4c5c7c",
    clinic: "#3f7a84",
    church: "#73648a",
    warehouse: "#7a7468",
    cabin: "#6c5a40",
    safehouse: "#b8862e",
  },
  hatch: "rgba(42, 35, 27, 0.22)",
  label: "#2a231b",
  labelSoft: "#6a5b45",
  halo: "rgba(236, 228, 203, 0.92)",
  badge: "#f4eedd",
  badgeInk: "#2a231b",
  horde: "#9c2f22",
  you: "#1d1a16",
  chrome: { sheet: "#d6cbb0", text: "#2a231b", soft: "#6a5b45", edge: "#8a785a" },
}

export const NOIR: MapPalette = {
  name: "Noir survey",
  paper: "#0e1418",
  grain: "rgba(180, 200, 210, 0.035)",
  grid: "rgba(120, 150, 165, 0.09)",
  gridMajor: "rgba(120, 150, 165, 0.2)",
  ground: {
    suburb: "#18232a",
    commercial: "#1d2329",
    civic: "#1a2229",
    industrial: "#1b1f24",
    woodland: "#16231f",
  },
  sidewalk: "#24313a",
  road: "#2f3d47",
  roadEdge: "#9fb4bd",
  roadCentre: "rgba(224, 186, 104, 0.6)",
  tree: "rgba(70, 104, 88, 0.5)",
  treeEdge: "rgba(120, 160, 140, 0.45)",
  vehicle: "#7b8a92",
  fence: "#6c7f88",
  ink: "#c9d6d8",
  house: "#3c4c55",
  poi: {
    hardware: "#6b5640",
    pharmacy: "#2f6560",
    grocery: "#5f5532",
    diner: "#6c4636",
    gas_station: "#73392c",
    police: "#34466a",
    clinic: "#2a5d66",
    church: "#504566",
    warehouse: "#4a4e52",
    cabin: "#4c3f2e",
    safehouse: "#a77a2a",
  },
  hatch: "rgba(200, 220, 225, 0.12)",
  label: "#dfe6e4",
  labelSoft: "#8fa4aa",
  halo: "rgba(14, 20, 24, 0.9)",
  badge: "#121b20",
  badgeInk: "#e6e0c8",
  horde: "#e0573f",
  you: "#f1ead2",
  chrome: { sheet: "#0e1418", text: "#dfe6e4", soft: "#8fa4aa", edge: "#3c4c55" },
}

export const PALETTES = [SURVEY, NOIR] as const

export const LABEL_FONT = `"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif`
export const MONO_FONT = `ui-monospace, "SF Mono", Menlo, monospace`
