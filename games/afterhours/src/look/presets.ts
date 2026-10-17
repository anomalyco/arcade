import type { LabSettings } from "@arcade/kit/lab-panel"
import { countyRoadZ } from "../world/layout"

// Look presets bundle existing Lab knobs (owned by atmosphere, lighting, post, materials, forest, facility); a preset
// only lists the keys it changes and is applied on top of the game's defaults. Camera presets match the approved
// concept frames (games/afterhours/concept).

export type LookPreset = { id: string; label: string; note: string; settings: LabSettings }

export const LOOK_PRESETS: LookPreset[] = [
  {
    id: "default",
    label: "Game default",
    note: "Every knob at the game's own default.",
    settings: {},
  },
  {
    id: "concept",
    label: "Concept match",
    note: "Tuned against r5-01/r5-03 (exteriors): dark teal bank, lamps cut to tight pools and halos, cooler grade, heavier grain. Darkens interiors too (light.lamps is global).",
    settings: {
      "fog.density": 0.02,
      "fog.height": 34,
      "fog.hue": 178,
      "fog.saturation": 0.7,
      "fog.brightness": 0.03,
      "sky.dark": 0.4,
      "sky.glow": 0.2,
      "env.intensity": 0.8,
      "scatter.strength": 0.1,
      "scatter.halo": 0.025,
      "scatter.forward": 0.75,
      "scatter.reflection": 1.6,
      "light.lamps": 0.55,
      "glow.strength": 1.4,
      "post.exposure": -2.2,
      "post.bloom": 0.3,
      "post.bloomRadius": 0.6,
      "post.ssrStreak": 1.8,
      "post.ssrStrength": 1.3,
      "grade.lift": 0.02,
      "grade.teal": 0.65,
      "grade.warmth": 0.15,
      "grade.contrast": 1.15,
      "grade.saturation": 0.9,
      "grade.grain": 0.04,
      "grade.vignette": 0.5,
      "materials.wetness": 1,
      "materials.puddles": 0.45,
    },
  },
  {
    id: "cinematic",
    label: "Cinematic",
    note: "Crushed blacks, strong split-tone, wide bloom, heavy vignette.",
    settings: {
      "post.exposure": -2.4,
      "post.bloom": 0.45,
      "post.bloomRadius": 0.9,
      "grade.lift": 0.01,
      "grade.teal": 0.7,
      "grade.warmth": 0.6,
      "grade.contrast": 1.25,
      "grade.saturation": 1.05,
      "grade.shoulder": 1.2,
      "grade.vignette": 0.65,
      "grade.grain": 0.035,
      "grade.aberration": 1.4,
      "scatter.strength": 0.45,
    },
  },
  {
    id: "overcast",
    label: "Overcast realism",
    note: "Brighter, flatter fog skylight; low contrast; neutral-ish teal; subtle lamps.",
    settings: {
      "fog.density": 0.014,
      "fog.brightness": 0.06,
      "fog.saturation": 0.45,
      "sky.dark": 0.6,
      "sky.glow": 0.5,
      "env.intensity": 1.5,
      "env.ground": 0.2,
      "scatter.strength": 0.22,
      "post.exposure": -1.7,
      "post.bloom": 0.15,
      "grade.teal": 0.25,
      "grade.warmth": 0.2,
      "grade.contrast": 0.98,
      "grade.saturation": 0.8,
      "grade.lift": 0.03,
    },
  },
  {
    id: "heavyfog",
    label: "Heavy fog",
    note: "Visibility ~60 m; big halos; distant lamps reduced to glows.",
    settings: {
      "fog.density": 0.04,
      "fog.height": 60,
      "fog.brightness": 0.045,
      "scatter.strength": 0.7,
      "scatter.halo": 0.1,
      "scatter.forward": 0.55,
      "post.exposure": -2.1,
      "post.bloom": 0.35,
      "post.bloomRadius": 0.9,
      "grade.contrast": 1.02,
    },
  },
  {
    id: "drizzle",
    label: "Drizzle-wet",
    note: "Soaked ground, wide puddles, long reflection streaks, reflected lamp glow.",
    settings: {
      "materials.wetness": 1,
      "materials.puddles": 0.65,
      "materials.puddleScale": 1.6,
      "post.ssrStrength": 1.6,
      "post.ssrWet": 0.75,
      "post.ssrRough": 0.8,
      "post.ssrStreak": 2.4,
      "post.ssrDistance": 60,
      "scatter.reflection": 2.2,
      "fog.density": 0.02,
    },
  },
  {
    id: "clear",
    label: "Clear night",
    note: "Thin haze, dark sky, lamps carry far, little scattering.",
    settings: {
      "fog.density": 0.004,
      "fog.height": 20,
      "fog.brightness": 0.02,
      "sky.dark": 0.2,
      "sky.glow": 0.15,
      "env.intensity": 0.6,
      "scatter.strength": 0.12,
      "scatter.halo": 0.02,
      "materials.wetness": 0.35,
      "materials.puddles": 0.12,
      "post.exposure": -2.0,
      "grade.lift": 0.008,
    },
  },
  {
    id: "photo",
    label: "Photographic (neutral)",
    note: "No split-tone, neutral lift, minimal vignette and CA, fine grain: what the scene really renders.",
    settings: {
      "grade.lift": 0.004,
      "grade.teal": 0,
      "grade.warmth": 0,
      "grade.contrast": 1,
      "grade.saturation": 1,
      "grade.shoulder": 1.6,
      "grade.vignette": 0.15,
      "grade.aberration": 0.2,
      "grade.grain": 0.012,
      "post.bloom": 0.12,
    },
  },
  {
    id: "max",
    label: "Max quality",
    note: "Supersampled 3D, 8 scatter samples, full-res SSR/AO, more shadowed lamps, far trees.",
    settings: {
      "post.renderScale": 1.5,
      "post.autoRes": false,
      "scatter.samples": 8,
      "scatter.lights": 24,
      "post.ssrQuality": 1,
      "post.ssrQualityOutdoor": 0.8,
      "post.ssrScale": 1,
      "post.ssrScaleOutdoor": 0.75,
      "post.aoScale": 1,
      "post.aoScaleOutdoor": 0.75,
      "post.aoSamples": 16,
      "light.shadows": 4,
      "forest.lod0": 90,
      "forest.lod1": 260,
      "forest.far": 600,
      "forest.shadows": 2,
    },
  },
  {
    id: "fast",
    label: "Fast",
    note: "Low 3D resolution, 2 scatter samples, coarse SSR/AO, one shadowed lamp.",
    settings: {
      "post.renderScale": 0.6,
      "scatter.samples": 2,
      "scatter.lights": 8,
      "post.ssrQuality": 0.3,
      "post.ssrQualityOutdoor": 0.2,
      "post.ssrScale": 0.35,
      "post.ssrScaleOutdoor": 0.25,
      "post.aoScale": 0.35,
      "post.aoScaleOutdoor": 0.25,
      "post.aoSamples": 4,
      "light.shadows": 1,
      "forest.shadows": 0,
    },
  },
]

/** Performance-only keys: the Lab's quality toggle overrides them and A/B snapshots ignore them when comparing look. */
export const QUALITY: Record<"fast" | "balanced" | "max", LabSettings> = {
  fast: LOOK_PRESETS.find((p) => p.id === "fast")!.settings,
  balanced: {},
  max: LOOK_PRESETS.find((p) => p.id === "max")!.settings,
}

export type CameraPreset = {
  id: string
  label: string
  /** Concept image file name in games/afterhours/concept, if this camera matches one. */
  concept?: string
  /** Eye position: x, height above the walkable ground there, z (metres). */
  eye: readonly [number, number, number]
  /** Yaw 0 looks north (-Z); positive turns left (towards -X). */
  yaw: number
  pitch: number
  /** Vertical field of view (degrees). */
  fov: number
}

// Tuned with `bun scripts/look-shots.ts --try cams.json` against each concept. Where the world's layout differs from the
// painting (r3-01's wagon outside the fence, the town street the county road stands in for) the camera matches the
// composition: subject placement, horizon height and lens.
export const CAMERA_PRESETS: CameraPreset[] = [
  { id: "r3-01", label: "Gate, booth & dish (r3-01)", concept: "r3-01-lab-exterior.png", eye: [-4, 1.6, 150], yaw: -0.1, pitch: 0.14, fov: 48 },
  { id: "r5-01", label: "Lot, wagon & block (r5-01)", concept: "r5-01-corridor-junction.png", eye: [-12, 1.6, 104], yaw: 0.2, pitch: 0.1, fov: 50 },
  { id: "r5-03", label: "Access road to gate (r5-03)", concept: "r5-03-lab-fence-road.png", eye: [-1, 1.7, 178], yaw: 0, pitch: 0.05, fov: 40 },
  { id: "r3-02", label: "Corridor (r3-02)", concept: "r3-02-lab-corridor-pov.png", eye: [-10, 1.6, 0.3], yaw: Math.PI / 2, pitch: -0.04, fov: 50 },
  { id: "r5-05", label: "Corridor lab door (r5-05)", concept: "r5-05-corridor-lab-room.png", eye: [-18, 1.6, 0.9], yaw: 1.0, pitch: -0.03, fov: 60 },
  { id: "r5-02", label: "Lobby to entrance (r5-02)", concept: "r5-02-lab-lobby.png", eye: [2, 1.6, 10], yaw: Math.PI, pitch: -0.02, fov: 60 },
  { id: "r5-06", label: "Loading dock (r5-06)", concept: "r5-06-lab-loading-dock.png", eye: [-20, 1.7, -29], yaw: 1.75, pitch: 0.05, fov: 55 },
  { id: "r3-05", label: "County road east (r3-05)", concept: "r3-05-small-town-main-street.png", eye: [-30, 1.7, countyRoadZ(-30) + 1.2], yaw: -Math.PI / 2, pitch: 0.02, fov: 50 },
  { id: "r5-04", label: "County road west (r5-04)", concept: "r5-04-main-street-reverse.png", eye: [20, 1.7, countyRoadZ(20) + 1.2], yaw: Math.PI / 2, pitch: 0.02, fov: 50 },
]
