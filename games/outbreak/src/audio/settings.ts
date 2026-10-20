import { DEFAULT_VOLUME_SETTINGS, volumeControls, type MixCategory } from "@arcade/kit/audio"
import type { LabControl } from "@arcade/kit/lab-panel"
import type { ScapeLayer } from "./soundscape/catalog"
import type { FootSurface } from "./space"
import type { WeaponGroup, WeaponKey } from "./weapons/catalog"

/**
 * Outbreak's sound settings. The player's volumes (Master, Effects, Ambience, Zombie voices; `@arcade/kit/audio`
 * volume, saved per game) sit on top of the mix tuned in the Lab's Sound group. Levels are percentages.
 * `audioMode: 0` ("Today") switches to the pre-pass mix and 3-surface footsteps for instant A/B comparison.
 * Outbreak has no music, so it shows no Music slider.
 */
export const DEFAULT_AUDIO_SETTINGS = {
  audioMuted: 0,
  ...DEFAULT_VOLUME_SETTINGS,
  /** 1 = Sound pass (balanced mix & 11-surface materials); 0 = Today (pre-pass baseline). */
  audioMode: 1,
  audioWeapons: 100,
  audioZombies: 100,
  audioImpacts: 95,
  audioMovement: 85,
  audioAmbience: 65,
  audioUi: 80,
  /** Player self-footstep loudness scale (%). */
  audioSelfStep: 100,
  /** Per-surface footstep loudness trims (%). */
  audioStepConcrete: 100,
  audioStepGrass: 100,
  audioStepWood: 100,
  audioStepTile: 100,
  audioStepCarpet: 100,
  audioStepGravel: 100,
  audioStepDirt: 100,
  audioStepPuddle: 100,
  audioStepMetal: 100,
  audioStepGlass: 100,
  audioStepBlood: 100,
  /** How much walls and closed doors muffle sound, 0..1. */
  audioOcclusion: 1,
  /** Distance rolloff exponent for spatial sounds. */
  audioFalloff: 1.55,
  /** Reverb send level, 0..1. */
  audioReverb: 0.45,
  /** Simultaneous one-shot voices before the lowest-priority voice is stolen. */
  audioVoiceCap: 32,
  /** The soundscape (AR-86): 1 on, 0 Today (no clocks, taps, sirens or anything else from `soundscape/`). */
  audioScape: 1,
  /** Soundscape master level (%), on top of the Ambience bus. */
  audioScapeLevel: 100,
  audioScapeInterior: 100,
  audioScapeExterior: 100,
  audioScapeDistant: 100,
  /** Soundscape loops at once (clocks, hums, rain on things, sirens), nearest and loudest first. */
  audioScapeVoices: 6,
  audioScapeClocks: 1,
  audioScapeTaps: 1,
  audioScapeFridge: 1,
  audioScapeCreaks: 1,
  audioScapeWind: 1,
  audioScapeOddities: 1,
  audioScapeSirens: 1,
  audioScapeGunfire: 1,
  audioScapeCarAlarm: 1,
  audioScapeChimes: 1,
  audioScapeRain: 1,
  audioScapeGutters: 1,
  audioScapeInsects: 1,
  audioScapeOwl: 1,
  audioScapeElectrics: 1,
  audioScapeHooks: 1,
  /** Weapon sounds (AR-102): 1 layered per weapon, 0 Today (one shared pistol shot, three melee hits, borrowed fire sounds). */
  audioWeaponSet: 1,
  /** Distance (m) where a report hands over from its near layers to its far version. */
  audioWpnNear: 18,
  /** Levels (%) per part of the weapon sounds. */
  audioWpnReport: 100,
  audioWpnTail: 100,
  audioWpnFar: 100,
  audioWpnHandling: 100,
  audioWpnBrass: 100,
  audioWpnMelee: 100,
  audioWpnImpacts: 100,
  audioWpnFire: 100,
  /** Round-robin pitch and level jitter (% of each sound's own). */
  audioWpnVariation: 100,
  /** Bullet impacts by surface (wood, plaster, brick, car, glass, earth, flesh). */
  audioWpnSurfaces: 1,
  audioWpnPistol: 1,
  audioWpnFlareGun: 1,
  audioWpnFlamethrower: 1,
  audioWpnMolotov: 1,
  audioWpnDynamite: 1,
  audioWpnFirecrackers: 1,
  audioWpnBearTrap: 1,
  audioWpnThrowables: 1,
  audioWpnKnife: 1,
  audioWpnHammer: 1,
  audioWpnPipe: 1,
  audioWpnCrowbar: 1,
  audioWpnMachete: 1,
  audioWpnBat: 1,
  audioWpnSpikedBoard: 1,
  audioWpnAxe: 1,
  audioWpnFireAxe: 1,
}

export type AudioSettings = typeof DEFAULT_AUDIO_SETTINGS

/** Which settings level drives each runtime bus. */
export const AUDIO_BUS_LEVELS: Record<MixCategory, keyof AudioSettings> = {
  weapon: "audioWeapons",
  foley: "audioMovement",
  voice: "audioZombies",
  impact: "audioImpacts",
  ambience: "audioAmbience",
  ui: "audioUi",
  engine: "audioMovement",
  tyre: "audioMovement",
  spell: "audioWeapons",
}

/** Which settings key scales footsteps on each surface (`FootSurface`). */
export const SURFACE_STEP_SETTING_KEYS: Record<FootSurface, keyof AudioSettings> = {
  concrete: "audioStepConcrete",
  grass: "audioStepGrass",
  wood: "audioStepWood",
  tile: "audioStepTile",
  carpet: "audioStepCarpet",
  gravel: "audioStepGravel",
  dirt: "audioStepDirt",
  puddle: "audioStepPuddle",
  metal: "audioStepMetal",
  glass: "audioStepGlass",
  blood: "audioStepBlood",
}

/** Which toggle turns each soundscape layer on (Backquote › Sound › Ambience). */
export const SCAPE_LAYER_KEYS: Record<ScapeLayer, keyof AudioSettings> = {
  clocks: "audioScapeClocks",
  taps: "audioScapeTaps",
  fridge: "audioScapeFridge",
  creaks: "audioScapeCreaks",
  wind: "audioScapeWind",
  oddities: "audioScapeOddities",
  sirens: "audioScapeSirens",
  gunfire: "audioScapeGunfire",
  carAlarm: "audioScapeCarAlarm",
  chimes: "audioScapeChimes",
  rain: "audioScapeRain",
  gutters: "audioScapeGutters",
  insects: "audioScapeInsects",
  owl: "audioScapeOwl",
  electrics: "audioScapeElectrics",
  hooks: "audioScapeHooks",
}

/** Which toggle turns each weapon's layered sounds on (Backquote › Sound › Weapons). */
export const WEAPON_TOGGLE_KEYS: Record<WeaponKey, keyof AudioSettings> = {
  pistol: "audioWpnPistol",
  "flare-gun": "audioWpnFlareGun",
  flamethrower: "audioWpnFlamethrower",
  molotov: "audioWpnMolotov",
  dynamite: "audioWpnDynamite",
  firecrackers: "audioWpnFirecrackers",
  "bear-trap": "audioWpnBearTrap",
  throwables: "audioWpnThrowables",
  knife: "audioWpnKnife",
  hammer: "audioWpnHammer",
  pipe: "audioWpnPipe",
  crowbar: "audioWpnCrowbar",
  machete: "audioWpnMachete",
  bat: "audioWpnBat",
  "spiked-board": "audioWpnSpikedBoard",
  axe: "audioWpnAxe",
  "fire-axe": "audioWpnFireAxe",
}

/** Which level scales each part of the weapon sounds. */
export const WEAPON_GROUP_KEYS: Record<WeaponGroup, keyof AudioSettings> = {
  report: "audioWpnReport",
  tail: "audioWpnTail",
  far: "audioWpnFar",
  handling: "audioWpnHandling",
  brass: "audioWpnBrass",
  melee: "audioWpnMelee",
  impacts: "audioWpnImpacts",
  fire: "audioWpnFire",
}

const WEAPON_LABELS: Record<WeaponKey, string> = {
  pistol: "Pistol",
  "flare-gun": "Flare gun",
  flamethrower: "Flamethrower",
  molotov: "Molotov",
  dynamite: "Dynamite",
  firecrackers: "Firecrackers",
  "bear-trap": "Bear trap",
  throwables: "Thrown things (bricks, cans…)",
  knife: "Knife",
  hammer: "Hammer",
  pipe: "Lead pipe",
  crowbar: "Crowbar",
  machete: "Machete",
  bat: "Baseball bat",
  "spiked-board": "Spiked board",
  axe: "Wood axe",
  "fire-axe": "Fire axe",
}

const WEAPON_GROUP_LABELS: Record<WeaponGroup, string> = {
  report: "Reports (action, crack, punch, thump)",
  tail: "Room / street / slapback tails",
  far: "Far-off versions",
  handling: "Draw, reload, dry-fire",
  brass: "Brass on the floor",
  melee: "Melee swings & hits",
  impacts: "Bullet impacts",
  fire: "Fire, explosives & throws",
}

const weaponLevel = (key: keyof AudioSettings, label: string): LabControl => ({ key, label, group: "Sound", subsection: "Weapons", min: 0, max: 200, step: 5, unit: "%" })

const SCAPE_LAYER_LABELS: Record<ScapeLayer, string> = {
  clocks: "Clocks (ticking, striking the hour)",
  taps: "Dripping taps",
  fridge: "Fridges (die with the power)",
  creaks: "Creaks, settling, pipes",
  wind: "Wind in windows, curtains, doors",
  oddities: "Music box, phones, smoke alarms",
  sirens: "Distant sirens (fade over nights)",
  gunfire: "Far-off gunfire (fades over nights)",
  carAlarm: "Car alarm streets away",
  chimes: "Wind chimes",
  rain: "Rain on cars, puddles, leaves",
  gutters: "Gutters dripping after rain",
  insects: "Insects by day, birds at dawn",
  owl: "Owl (later nights)",
  electrics: "Lamps, neon, police radios, alarm bells",
  hooks: "Other features (life, zombies, secrets)",
}

const scapeLevel = (key: keyof AudioSettings, label: string): LabControl => ({ key, label, group: "Sound", subsection: "Ambience", min: 0, max: 200, step: 5, unit: "%" })

/** The volume channels Outbreak has: zombie groans and moans are its voices. */
export const OUTBREAK_VOLUME_CHANNELS = ["master", "effects", "ambience", "voice"] as const

const busLevel = (key: keyof AudioSettings, label: string): LabControl => ({
  key,
  label,
  group: "Sound",
  subsection: "Mix buses",
  min: 0,
  max: 100,
  step: 5,
  unit: "%",
})

const surfaceLevel = (key: keyof AudioSettings, label: string): LabControl => ({
  key,
  label,
  group: "Sound",
  subsection: "Footsteps by surface",
  min: 0,
  max: 200,
  step: 5,
  unit: "%",
})

export const audioControls: LabControl[] = [
  { key: "audioMuted", label: "Mute (M)", group: "Volume", type: "toggle" },
  ...volumeControls(OUTBREAK_VOLUME_CHANNELS, "Volume", { voice: "Zombie voices" }),
  {
    key: "audioMode",
    label: "Sound profile",
    group: "Sound",
    options: [
      { label: "Today", value: 0 },
      { label: "Sound pass (balanced & materials)", value: 1 },
    ],
  },
  busLevel("audioWeapons", "Weapons & combat"),
  busLevel("audioZombies", "Zombies (vocals)"),
  busLevel("audioImpacts", "Impacts & breaches"),
  busLevel("audioMovement", "Foley & footsteps"),
  busLevel("audioAmbience", "Ambience"),
  busLevel("audioUi", "Interface"),
  surfaceLevel("audioSelfStep", "Player self-steps"),
  surfaceLevel("audioStepConcrete", "Concrete & asphalt"),
  surfaceLevel("audioStepGrass", "Grass"),
  surfaceLevel("audioStepWood", "Wood & porches"),
  surfaceLevel("audioStepTile", "Tile & linoleum"),
  surfaceLevel("audioStepCarpet", "Carpet & rugs"),
  surfaceLevel("audioStepGravel", "Gravel driveways"),
  surfaceLevel("audioStepDirt", "Dirt & tree beds"),
  surfaceLevel("audioStepPuddle", "Puddles"),
  surfaceLevel("audioStepMetal", "Metal & grates"),
  surfaceLevel("audioStepGlass", "Broken glass"),
  surfaceLevel("audioStepBlood", "Blood pools"),
  { key: "audioOcclusion", label: "Wall occlusion", group: "Sound", subsection: "Spatial & engine", min: 0, max: 1, step: 0.05, unit: "" },
  { key: "audioFalloff", label: "Distance falloff", group: "Sound", subsection: "Spatial & engine", min: 0.8, max: 2.5, step: 0.05, unit: "×" },
  { key: "audioReverb", label: "Reverb", group: "Sound", subsection: "Spatial & engine", min: 0, max: 1, step: 0.05, unit: "" },
  { key: "audioVoiceCap", label: "Voice cap", group: "Sound", subsection: "Spatial & engine", min: 8, max: 48, step: 1, unit: "voices" },
  {
    key: "audioScape",
    label: "Soundscape",
    group: "Sound",
    subsection: "Ambience",
    options: [
      { label: "Today (beds only)", value: 0 },
      { label: "Soundscape (clocks, taps, sirens…)", value: 1 },
    ],
  },
  scapeLevel("audioScapeLevel", "Soundscape level"),
  scapeLevel("audioScapeInterior", "Interiors"),
  scapeLevel("audioScapeExterior", "Exteriors"),
  scapeLevel("audioScapeDistant", "Distance"),
  { key: "audioScapeVoices", label: "Soundscape loops", group: "Sound", subsection: "Ambience", min: 0, max: 12, step: 1, unit: "voices" },
  ...(Object.keys(SCAPE_LAYER_KEYS) as ScapeLayer[]).map(
    (layer): LabControl => ({ key: SCAPE_LAYER_KEYS[layer], label: SCAPE_LAYER_LABELS[layer], group: "Sound", subsection: "Ambience", type: "toggle" }),
  ),
  {
    key: "audioWeaponSet",
    label: "Weapon sounds",
    group: "Sound",
    subsection: "Weapons",
    options: [
      { label: "Today (shared pistol, 3 melee hits)", value: 0 },
      { label: "Layered per weapon", value: 1 },
    ],
  },
  { key: "audioWpnNear", label: "Near → far handover", group: "Sound", subsection: "Weapons", min: 6, max: 40, step: 1, unit: "m" },
  ...(Object.keys(WEAPON_GROUP_KEYS) as WeaponGroup[]).map((g) => weaponLevel(WEAPON_GROUP_KEYS[g], WEAPON_GROUP_LABELS[g])),
  weaponLevel("audioWpnVariation", "Variation (pitch & level jitter)"),
  { key: "audioWpnSurfaces", label: "Bullet impacts by surface", group: "Sound", subsection: "Weapons", type: "toggle" },
  ...(Object.keys(WEAPON_TOGGLE_KEYS) as WeaponKey[]).map(
    (w): LabControl => ({ key: WEAPON_TOGGLE_KEYS[w], label: WEAPON_LABELS[w], group: "Sound", subsection: "Weapons", type: "toggle" }),
  ),
]
