import type { LabControl } from "@arcade/kit/lab-panel"
import { DEFAULT_FIRE_TUNING, fireControls, type FireTuning } from "../../shared/fire/fire"

/** How fire looks (presentation only; the rules are `FireTuning`). */
export type FireLook = {
  /**
   * Which fire is drawn: 0 Today (#264's analytic flame sprites and mesh scorch), 1 the kit explosion's fire (blackbody
   * billows that crust into soot, sparks, lit smoke and noise scorch from `@arcade/kit/fx`, with the kit blast).
   */
  fireStyle: number
  /** Light the flames throw, as a multiple of the default. */
  fireLight: number
  /** How far a burning thing's light reaches, in metres. */
  fireLightRadius: number
  /** Most fire lights at once (nearest first; flares count separately). */
  fireMaxLights: number
  /** How many flame particles the stream and fires draw, as a multiple of the default. */
  flameDensity: number
  /** Brightness of the flames themselves. */
  flameBrightness: number
  /** Kit fire: how hot the billows burn (× blackbody temperature; higher goes yellow-white, lower deep orange). */
  flameHeat: number
  /** Kit fire: how much the billows roll and tear (× turbulence). */
  flameTurbulence: number
  /** Kit fire: × the size of each billow. */
  flameSize: number
  /** Smoke over fires and the stream (0 for none). */
  fireSmoke: number
  /** Embers drifting up from fires (0 for none). */
  fireEmbers: number
  /** How dark scorch marks and charred bodies go (0 none .. 1 black). */
  fireChar: number
  /** The white flash of a blast. */
  blastFlash: number
  /** Camera shake from a blast. */
  blastShake: number
  /** Kit fire: × the dynamite fireball's size (on top of the blast radius). */
  blastSize: number
  /**
   * Shape of fire's light: 0 Today (points), 1 capsules (a jet, a burning figure or tree lights the street along its
   * length, through the lamp grid like any lamp).
   */
  fireLightShape: number
  /** How much fire light and flame brightness flicker (0 steady). */
  fireFlicker: number
  /** Kit fire: the warm glow in the air round flames, as a multiple of the default (0 none). */
  fireGlow: number
  /** Kit fire: the white-hot inner tongues under the billows (0 billows only, as on the first pass). */
  flameCore: number
  /** Kit fire: flames, embers and smoke in a burning tree's crown, as a multiple of the default (0 none). */
  treeFlames: number
  /** Hedges, shrubs and grass under fire and scorch char and go bare (0 off). */
  foliageChar: number
}

export const DEFAULT_FIRE_LOOK: FireLook = {
  fireStyle: 1,
  fireLight: 1,
  fireLightRadius: 7,
  fireMaxLights: 8,
  flameDensity: 1,
  flameBrightness: 1,
  flameHeat: 1,
  flameTurbulence: 1,
  flameSize: 1,
  fireSmoke: 1,
  fireEmbers: 1,
  fireChar: 0.85,
  blastFlash: 1,
  blastShake: 1,
  blastSize: 1,
  fireLightShape: 1,
  fireFlicker: 1,
  fireGlow: 1,
  flameCore: 1,
  treeFlames: 1,
  foliageChar: 1,
}

/** The Lab's Fire & explosives settings: the rules and the look in one group. */
export type OutbreakFireSettings = FireTuning & FireLook

export const DEFAULT_FIRE_SETTINGS: OutbreakFireSettings = { ...DEFAULT_FIRE_TUNING, ...DEFAULT_FIRE_LOOK }

const G = "Fire & explosives look"

export const fireLookControls: readonly LabControl[] = [
  {
    key: "fireStyle",
    label: "Fire style",
    group: G,
    type: "select",
    options: [
      { value: 0, label: "Today (flame sprites)" },
      { value: 1, label: "Kit explosion fire" },
    ],
  },
  { key: "fireLight", label: "Fire light", group: G, min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "fireLightRadius", label: "Fire light reach", group: G, min: 1, max: 16, step: 0.25, unit: "m" },
  { key: "fireMaxLights", label: "Most fire lights", group: G, min: 0, max: 16, step: 1, unit: "" },
  { key: "flameDensity", label: "Flame particles", group: G, min: 0.2, max: 2, step: 0.05, unit: "×" },
  { key: "flameBrightness", label: "Flame brightness", group: G, min: 0.2, max: 3, step: 0.05, unit: "×" },
  { key: "flameHeat", label: "Flame heat (kit)", group: G, min: 0.4, max: 1.6, step: 0.05, unit: "×" },
  { key: "flameTurbulence", label: "Flame turbulence (kit)", group: G, min: 0.2, max: 2, step: 0.05, unit: "×" },
  { key: "flameSize", label: "Flame billow size (kit)", group: G, min: 0.4, max: 2, step: 0.05, unit: "×" },
  { key: "fireSmoke", label: "Smoke", group: G, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "fireEmbers", label: "Embers", group: G, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "fireChar", label: "Scorch and char", group: G, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "blastFlash", label: "Blast flash", group: G, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "blastShake", label: "Blast shake", group: G, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "blastSize", label: "Blast fireball size (kit)", group: G, min: 0.4, max: 2, step: 0.05, unit: "×" },
  {
    key: "fireLightShape",
    label: "Fire light shape",
    group: G,
    type: "select",
    options: [
      { value: 0, label: "Today (points)" },
      { value: 1, label: "Capsules (light along the flame)" },
    ],
  },
  { key: "fireFlicker", label: "Flicker", group: G, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "fireGlow", label: "Warm glow in the air (kit)", group: G, min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "flameCore", label: "Hot inner tongues (kit)", group: G, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "treeFlames", label: "Burning tree flames (kit)", group: G, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "foliageChar", label: "Hedges char under fire", group: G, min: 0, max: 1, step: 0.05, unit: "" },
]

export const allFireControls: readonly LabControl[] = [...(fireControls as readonly LabControl[]), ...fireLookControls]
