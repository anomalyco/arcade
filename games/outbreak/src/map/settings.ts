import type { LabControl } from "@arcade/kit/lab-panel"

export const MAP_STYLE_SURVEY = 0
export const MAP_STYLE_NOIR = 1

export const MINIMAP_OFF = 0
export const MINIMAP_COMPASS = 1
export const MINIMAP_CORNER = 2

export const DEFAULT_MAP_SETTINGS = {
  /** Sheet look: 0 survey paper, 1 noir night survey. */
  mapStyle: MAP_STYLE_SURVEY,
  /** Screen-HUD helper: 0 off (default, the Diegetic HUD stays clear), 1 ground compass ring, 2 corner minimap. */
  mapMinimap: MINIMAP_OFF,
  /** Zoom the full map opens at, in CSS pixels per metre. */
  mapOpenZoom: 3,
  /** How dark the game behind the sheet goes while the map is open. */
  mapBackdrop: 0.55,
  /** District names and POI labels on the sheet. */
  mapLabels: true,
  /** Seconds a zombie sighting stays on the map after it was last seen. */
  mapHordeMemory: 240,
  /** Radius of the compass ring on the ground around the survivor, in metres. */
  mapCompassRadius: 2.4,
  /** Opacity of the compass ring and its bearings. */
  mapCompassOpacity: 0.7,
  /** Known POIs farther than this are left off the compass ring, in metres. */
  mapCompassRange: 160,
  /** Corner minimap diameter in CSS pixels. */
  mapMinimapSize: 156,
  /** Corner minimap scale in CSS pixels per metre. */
  mapMinimapZoom: 1.6,
}

export type MapSettings = typeof DEFAULT_MAP_SETTINGS

export const mapControls: LabControl[] = [
  {
    key: "mapStyle",
    label: "Map look",
    group: "Map",
    options: [
      { label: "Survey paper", value: MAP_STYLE_SURVEY },
      { label: "Noir survey", value: MAP_STYLE_NOIR },
    ],
  },
  {
    key: "mapMinimap",
    label: "On-screen map",
    group: "Map",
    options: [
      { label: "Off", value: MINIMAP_OFF },
      { label: "Compass ring", value: MINIMAP_COMPASS },
      { label: "Corner minimap", value: MINIMAP_CORNER },
    ],
  },
  { key: "mapOpenZoom", label: "Opening zoom", group: "Map", min: 0.5, max: 8, step: 0.1, unit: "px/m" },
  { key: "mapBackdrop", label: "Backdrop dim", group: "Map", min: 0, max: 0.9, step: 0.05, unit: "" },
  { key: "mapLabels", label: "Labels", group: "Map" },
  { key: "mapHordeMemory", label: "Horde memory", group: "Map", min: 30, max: 900, step: 15, unit: "s" },
  { key: "mapCompassRadius", label: "Compass radius", group: "Map", min: 1.2, max: 4, step: 0.1, unit: "m" },
  { key: "mapCompassOpacity", label: "Compass opacity", group: "Map", min: 0.15, max: 1, step: 0.05, unit: "" },
  { key: "mapCompassRange", label: "Compass POI range", group: "Map", min: 40, max: 400, step: 10, unit: "m" },
  { key: "mapMinimapSize", label: "Minimap size", group: "Map", min: 110, max: 260, step: 2, unit: "px" },
  { key: "mapMinimapZoom", label: "Minimap scale", group: "Map", min: 0.5, max: 5, step: 0.1, unit: "px/m" },
]
