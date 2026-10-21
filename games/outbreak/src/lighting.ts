import type { BakedMap, FloorMap } from "@arcade/kit/gpu/level"
import { FOLIAGE_GUST_FLOATS } from "@arcade/kit/gpu/foliage"
import { VERT_BYTES } from "@arcade/kit/gpu/mesh"
import type { LabControl } from "@arcade/kit/lab-panel"
import type { LookPresetId } from "@arcade/kit/look"
import { inBuildingFootprint, SIZE, type Building, type Lamp, type Town } from "../shared/map"
import { unseenUniformsStruct, type UnseenFrameEvaluation, type UnseenSettings } from "./unseen"
import { INTERIOR_UNIFORM_FLOATS, interiorUniformFieldsWgsl } from "./interiors/wgsl"
import { DEFAULT_HERO_LOOK, type HeroLookSettings } from "./look/hero"
import { DEFAULT_LIT_WINDOWS, windowLampBuilding, windowsLit } from "./look/lit-windows"
import { DEFAULT_LOOK_TRIMS, trimLighting, type OutbreakLookTrims } from "./look/world"
import { addLampPool, tableLampPool, type BakeLamp, type TableLamp } from "./lightbake"
import { REFLECTION_LIGHT_FLOATS, REFLECTION_LIGHTS } from "./reflections/lights"
import { vegetationBuild } from "./vegetation/settings"
import { VEG_TREE_UNIFORM_FLOATS, vegetationTreeFieldsWgsl, vegetationTreeWgsl } from "./vegetation/trees"
import { packReflectionUniforms, REFLECTION_UNIFORM_FLOATS } from "./reflections/settings"
import { DEFAULT_LIGHT_CURVES, LIGHT_CURVES, LIGHT_RAMP_FLOATS, lightRampFieldsWgsl, lightRampWgsl, packLightRamps } from "./light-ramps"
import { packStreetLampUniforms, STREET_LAMP_UNIFORM_FLOATS, type OutbreakStreetLampSettings } from "./street-lamps/settings"
import { packWindowRoomUniforms, WINDOW_ROOM_UNIFORM_FLOATS, type OutbreakWindowRoomSettings } from "./window-rooms/settings"

/** Cobra-head streetlamp posts: south-east curb over the street, and the east sidewalk beside the house. */
export const STREET_LAMP_POSTS = [
  { x: 38.25, z: 47.85, yaw: -Math.PI * 0.92 },
  { x: 37.95, z: 25.15, yaw: 0.32 },
] as const

/** World-space centre of a post's sodium lens (model lens at x = 1.44, y = 6.10 above the 0.08 m curb). */
export function streetLampHead(post: (typeof STREET_LAMP_POSTS)[number]): [number, number, number] {
  return [post.x + Math.cos(post.yaw) * 1.44, 6.18, post.z + Math.sin(post.yaw) * 1.44]
}

/** Plan arm (pole → head) of the post whose lens is nearest `head` (the frame's nearest street head). */
export function streetPostArm(head: readonly number[] | undefined): [number, number] {
  let best: (typeof STREET_LAMP_POSTS)[number] = STREET_LAMP_POSTS[0]
  let bestD = Infinity
  for (const post of STREET_LAMP_POSTS) {
    const h = streetLampHead(post)
    // The window origin moves the posts by whole blocks; compare within the block.
    const dx = ((((head?.[0] ?? 0) - h[0]) % SIZE) + SIZE * 1.5) % SIZE - SIZE * 0.5
    const dz = ((((head?.[2] ?? 0) - h[2]) % SIZE) + SIZE * 1.5) % SIZE - SIZE * 0.5
    const d = dx * dx + dz * dz
    if (d < bestD) {
      bestD = d
      best = post
    }
  }
  return [Math.cos(best.yaw), Math.sin(best.yaw)]
}

export type OutbreakLightingSettings = {
  exposure: number
  skyFill: number
  moonFill: number
  lighting: number
  practicalWarmth: number
  porchPower: number
  windowPower: number
  roomPower: number
  streetPower: number
  lightFalloff: number
  flashlightHaze: number
  wetSpecular: number
  rimStrength: number
  vignetteDarkness: number
  streetAirHaze: number
  actorLampShadow: number
  /** Practical lamps' pool edge over plan distance / radius, as curve text (see `light-ramps.ts`). */
  lampFalloffCurve: string
}

export const DEFAULT_OUTBREAK_LIGHTING: OutbreakLightingSettings = {
  exposure: 1.04,
  skyFill: 0.90,
  moonFill: 0.98,
  lighting: 1.0,
  practicalWarmth: 0.88,
  porchPower: 0.86,
  windowPower: 0.96,
  roomPower: 0.80,
  streetPower: 0.78,
  lightFalloff: 1.12,
  flashlightHaze: 0.22,
  wetSpecular: 0.56,
  rimStrength: 0.76,
  vignetteDarkness: 0.34,
  streetAirHaze: 1,
  actorLampShadow: 1,
  lampFalloffCurve: DEFAULT_LIGHT_CURVES.lampFalloffCurve,
}

/** Preset lighting profiles so switching `@arcade/kit/look` presets in the Lab dials in the base lighting primitives too. */
export const OUTBREAK_LOOK_LIGHTING_PRESETS: Readonly<Record<LookPresetId, Partial<OutbreakLightingSettings>>> = {
  current: { ...DEFAULT_OUTBREAK_LIGHTING },
  sodium_70s: { ...DEFAULT_OUTBREAK_LIGHTING },
  noir: {
    exposure: 1.08,
    skyFill: 0.46,
    moonFill: 0.90,
    practicalWarmth: 0.4,
    porchPower: 0.36,
    windowPower: 0.38,
    roomPower: 0.56,
    streetPower: 0.12,
    lightFalloff: 1.38,
    flashlightHaze: 1.38,
    wetSpecular: 0.85,
    rimStrength: 1.45,
    vignetteDarkness: 0.58,
  },
  cinematic_dusk: {
    exposure: 0.96,
    skyFill: 0.68,
    moonFill: 0.95,
    practicalWarmth: 0.52,
    porchPower: 0.54,
    windowPower: 0.64,
    roomPower: 0.68,
    streetPower: 0.45,
    lightFalloff: 1.20,
    flashlightHaze: 0.65,
    wetSpecular: 0.62,
    rimStrength: 0.75,
    vignetteDarkness: 0.55,
  },
  painterly: {
    exposure: 1.12,
    skyFill: 1.15,
    moonFill: 1.15,
    practicalWarmth: 0.65,
    porchPower: 0.72,
    windowPower: 0.82,
    roomPower: 0.85,
    streetPower: 0.65,
    lightFalloff: 0.92,
    flashlightHaze: 0.35,
    wetSpecular: 0.25,
    rimStrength: 0.60,
    vignetteDarkness: 0.25,
  },
  cozy_golden_hour: {
    exposure: 1.10,
    skyFill: 1.08,
    moonFill: 1.25,
    practicalWarmth: 0.88,
    porchPower: 0.68,
    windowPower: 0.78,
    roomPower: 0.82,
    streetPower: 0.55,
    lightFalloff: 0.95,
    flashlightHaze: 0.40,
    wetSpecular: 0.35,
    rimStrength: 0.80,
    vignetteDarkness: 0.32,
  },
  party_pop: { ...DEFAULT_OUTBREAK_LIGHTING },
  night_ring: {
    ...DEFAULT_OUTBREAK_LIGHTING,
    exposure: 1.02,
    skyFill: 0.52,
    moonFill: 0.85,
    rimStrength: 1.25,
    vignetteDarkness: 0.58,
  },
  noir_silhouette: { ...DEFAULT_OUTBREAK_LIGHTING },
}

export const outbreakLightingControls: LabControl[] = [
  { key: "exposure", label: "Exposure", group: "Look", min: 0.5, max: 2, step: 0.02, unit: "×" },
  { key: "skyFill", label: "Sky fill", group: "Look", min: 0, max: 1.5, step: 0.02, unit: "×" },
  { key: "moonFill", label: "Moonlight fill", group: "Look", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "lighting", label: "Practical lights", group: "Look", min: 0, max: 1.5, step: 0.05, unit: "×" },
  { key: "practicalWarmth", label: "Practical warmth", group: "Lighting", min: 0, max: 1, step: 0.02, unit: "" },
  { key: "porchPower", label: "Porch light power", group: "Lighting", min: 0, max: 1.5, step: 0.02, unit: "×" },
  { key: "windowPower", label: "Window spill power", group: "Lighting", min: 0, max: 1.5, step: 0.02, unit: "×" },
  { key: "roomPower", label: "Interior lamp power", group: "Lighting", min: 0, max: 1.5, step: 0.02, unit: "×" },
  { key: "streetPower", label: "Streetlamp power", group: "Lighting", min: 0, max: 1.5, step: 0.02, unit: "×" },
  { key: "lightFalloff", label: "Light pool tightness", group: "Lighting", min: 0.5, max: 2.5, step: 0.05, unit: "×" },
  { key: "lampFalloffCurve", label: LIGHT_CURVES.lampFalloffCurve.label, group: "Lighting", type: "curve", unit: "" },
  { key: "flashlightHaze", label: "Flashlight cone haze", group: "Lighting", min: 0, max: 2.0, step: 0.05, unit: "×" },
  { key: "wetSpecular", label: "Wet specular sheen", group: "Lighting", min: 0, max: 1.5, step: 0.05, unit: "×" },
  { key: "rimStrength", label: "Moonlight rim", group: "Lighting", min: 0, max: 2.0, step: 0.05, unit: "×" },
  { key: "vignetteDarkness", label: "Peripheral darkness", group: "Lighting", min: 0, max: 1.2, step: 0.05, unit: "×" },
  { key: "streetAirHaze", label: "Streetlamp air haze", group: "Atmosphere", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "actorLampShadow", label: "Actor lamp shadow & boot AO", group: "Atmosphere", min: 0, max: 1, step: 0.05, unit: "" },
]

/**
 * The survivor's flashlight as a physical spotlight: inverse-square falloff softened near the lens and windowed to the
 * beam range, a hot core inside a soft cone with a wide dim spill and faint reflector rings, tilted down so the pool
 * lands ahead of the survivor and stretches at grazing angles, plus air scatter and one warm bounce. `beamColorKnee` is
 * the received irradiance where the selective-colour mask reaches 63%, so saturation rises smoothly through the falloff.
 */
export type FlashlightBeamSettings = {
  beamInner: number
  beamCore: number
  beamCoreWidth: number
  beamSpill: number
  beamSpillWidth: number
  beamCookie: number
  beamPoolDistance: number
  beamNearSoftening: number
  beamAirScatter: number
  beamBounce: number
  beamColorKnee: number
  practicalColor: number
  beamVisibility: number
  beamDust: number
  beamGlare: number
  beamQuality: number
  /** How the beam fades out toward its range (x = distance / range), as curve text (see `light-ramps.ts`). */
  beamFalloffCurve: string
}

/** Volumetric beam quality tiers: resolution divisor and march samples (0 = no pass, closed-form air glow instead). */
export const BEAM_QUALITY_TIERS = [
  { label: "Off", downscale: 0, samples: 0 },
  { label: "Low", downscale: 4, samples: 6 },
  { label: "Medium", downscale: 2, samples: 8 },
  { label: "High", downscale: 2, samples: 14 },
] as const

/**
 * The Darkwood beam (docs/outbreak-art-direction.md): a wide, evenly lit wedge with a crisp edge (inner cone 80% of
 * the outer, faint core and rings, almost no spill), aimed low so it lands about a metre from the survivor and runs to
 * its range, lighting the ground's texture and colour rather than glowing in the air (thin volumetric, soft glare).
 */
export const DEFAULT_FLASHLIGHT_BEAM: FlashlightBeamSettings = {
  beamInner: 0.8,
  beamCore: 0.2,
  beamCoreWidth: 0.34,
  beamSpill: 0.02,
  beamSpillWidth: 1.5,
  beamCookie: 0.1,
  beamPoolDistance: 2.4,
  beamNearSoftening: 6,
  beamAirScatter: 0.35,
  beamBounce: 0.35,
  beamColorKnee: 0.16,
  practicalColor: 0.55,
  beamVisibility: 0.35,
  beamDust: 0.5,
  beamGlare: 0.6,
  beamQuality: 2,
  beamFalloffCurve: DEFAULT_LIGHT_CURVES.beamFalloffCurve,
}

/** The Dying Light (v7) beam: a tight hot core tilted to a pool 5.5 m out, dense volumetric air and strong glare. */
export const V7_FLASHLIGHT_BEAM: FlashlightBeamSettings = {
  ...DEFAULT_FLASHLIGHT_BEAM,
  beamInner: 0.35,
  beamCore: 0.6,
  beamSpill: 0.05,
  beamCookie: 0.45,
  beamPoolDistance: 5.5,
  beamNearSoftening: 2.0,
  beamVisibility: 1.7,
  beamGlare: 1.2,
}

export const flashlightBeamControls: LabControl[] = [
  { key: "beamInner", label: "Inner cone (share of outer)", group: "Flashlight", min: 0, max: 0.95, step: 0.01, unit: "" },
  { key: "beamCore", label: "Hot core strength", group: "Flashlight", min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "beamCoreWidth", label: "Hot core width (share of outer)", group: "Flashlight", min: 0.05, max: 1, step: 0.01, unit: "" },
  { key: "beamSpill", label: "Spill level", group: "Flashlight", min: 0, max: 0.5, step: 0.005, unit: "×" },
  { key: "beamSpillWidth", label: "Spill width (× outer cone)", group: "Flashlight", min: 1, max: 3.5, step: 0.05, unit: "×" },
  { key: "beamCookie", label: "Reflector rings", group: "Flashlight", min: 0, max: 1.5, step: 0.05, unit: "" },
  { key: "beamPoolDistance", label: "Pool centre distance (tilt)", group: "Flashlight", min: 2, max: 30, step: 0.25, unit: "m" },
  { key: "beamNearSoftening", label: "Near-lens softening", group: "Flashlight", min: 0.5, max: 6, step: 0.1, unit: "m" },
  { key: "beamFalloffCurve", label: LIGHT_CURVES.beamFalloffCurve.label, group: "Flashlight", type: "curve", unit: "" },
  { key: "beamAirScatter", label: "Air scatter", group: "Flashlight", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "beamBounce", label: "Bounce light", group: "Flashlight", min: 0, max: 1.5, step: 0.05, unit: "×" },
  { key: "beamColorKnee", label: "Colour knee (irradiance)", group: "Flashlight", min: 0.02, max: 1, step: 0.01, unit: "" },
  { key: "practicalColor", label: "Practical lights restore colour", group: "Flashlight", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "beamVisibility", label: "Volumetric beam (air density)", group: "Flashlight", min: 0, max: 4, step: 0.05, unit: "×" },
  { key: "beamDust", label: "Dust in the beam", group: "Flashlight", min: 0, max: 1, step: 0.05, unit: "" },
  { key: "beamGlare", label: "Lens glare", group: "Flashlight", min: 0, max: 2, step: 0.05, unit: "×" },
  {
    key: "beamQuality",
    label: "Volumetric quality",
    group: "Flashlight",
    options: BEAM_QUALITY_TIERS.map((t, value) => ({ label: t.downscale ? `${t.label} (1/${t.downscale} res, ${t.samples} samples)` : t.label, value })),
  },
]

/**
 * 44 lighting floats, then the shared foliage wind config (12) and foliage actors (20) at
 * `OUTBREAK_FOLIAGE_UNIFORM_OFFSET`, the streaming window (36) at `OUTBREAK_WINDOW_UNIFORM_OFFSET`, then the Noir flashlight and
 * visibility-field block (28) at `OUTBREAK_NOIR_UNIFORM_OFFSET`.
 */
export const OUTBREAK_FOLIAGE_UNIFORM_OFFSET = 44
export const OUTBREAK_WINDOW_UNIFORM_OFFSET = 76
export const OUTBREAK_NOIR_UNIFORM_OFFSET = 112
/** Volumetric beam block: inverse view-projection (16) then two vec4f. */
export const OUTBREAK_BEAM_UNIFORM_OFFSET = 140
/** Rugs and themed interiors (see `interiors/wgsl.ts`) start after the beam block. */
export const OUTBREAK_INTERIOR_UNIFORM_OFFSET = 164
export const OUTBREAK_UNSEEN_UNIFORM_OFFSET = OUTBREAK_INTERIOR_UNIFORM_OFFSET + INTERIOR_UNIFORM_FLOATS
/** Reshaped falloff curves (see `light-ramps.ts`): flags, then a 16-sample table each. */
export const OUTBREAK_RAMP_UNIFORM_OFFSET = OUTBREAK_UNSEEN_UNIFORM_OFFSET + 8
/** The simple survivor's surface (see `look/hero.ts`): rim strength, rim exponent, flatten, colour kept. */
export const OUTBREAK_HERO_UNIFORM_OFFSET = OUTBREAK_RAMP_UNIFORM_OFFSET + LIGHT_RAMP_FLOATS
/** The light-colour rule (see `look/world.ts`): on, vision lift, bounce weight; then the baked room light scale. */
export const OUTBREAK_COLOUR_UNIFORM_OFFSET = OUTBREAK_HERO_UNIFORM_OFFSET + 4
/** Dust motes in the light (see `air/dust.ts`): amount, brightness, size, motes under lamps. */
export const OUTBREAK_DUST_UNIFORM_OFFSET = OUTBREAK_COLOUR_UNIFORM_OFFSET + 4
/** Soft Bean's surface (see `look/hero.ts`): light wrap, sheen, sheen exponent, own colour in the dark. */
export const OUTBREAK_BEAN_UNIFORM_OFFSET = OUTBREAK_DUST_UNIFORM_OFFSET + 4
/** Shroud & out-of-light controls (see `look/world.ts`): shroudDarkness, outOfLightDesat, outOfSightDarkening, worldSaturation. */
export const OUTBREAK_SHROUD_UNIFORM_OFFSET = OUTBREAK_BEAN_UNIFORM_OFFSET + 4
/** Beam and actor look (see `look/world.ts`): beamWarmth, beamTightness, zombieRimSpec, nightGrain. */
export const OUTBREAK_BEAM_LOOK_UNIFORM_OFFSET = OUTBREAK_SHROUD_UNIFORM_OFFSET + 4
/** Sight shroud (see `look/world.ts`): coneSharpness, dayShroud, dayMuted, shroudLampKeep. */
export const OUTBREAK_SIGHT_UNIFORM_OFFSET = OUTBREAK_BEAM_LOOK_UNIFORM_OFFSET + 4
/** Darkwood surfaces (see `look/world.ts`): sightGlow, groundDetail, lampRolloff, reserved. */
export const OUTBREAK_ART_UNIFORM_OFFSET = OUTBREAK_SIGHT_UNIFORM_OFFSET + 4
/** Night sight (see `look/night-sight.ts`): this frame's weight, readable radius, fade distance, reserved. */
export const OUTBREAK_NIGHT_UNIFORM_OFFSET = OUTBREAK_ART_UNIFORM_OFFSET + 4
/** The town-wide wind field for vegetation (`FoliageGust`, see `vegetation/settings.ts`). */
export const OUTBREAK_VEG_GUST_UNIFORM_OFFSET = OUTBREAK_NIGHT_UNIFORM_OFFSET + 4
/** Reflections (see `reflections/settings.ts`): `refl` (wet strength, puddles, Lab wetness, ripple) then `mirror`. */
/** Tree look shading and burning trees (see `vegetation/trees.ts`): `vegTrees` then `vegBurn`. */
export const OUTBREAK_VEG_TREES_UNIFORM_OFFSET = OUTBREAK_VEG_GUST_UNIFORM_OFFSET + FOLIAGE_GUST_FLOATS
export const OUTBREAK_REFLECT_UNIFORM_OFFSET = OUTBREAK_VEG_TREES_UNIFORM_OFFSET + VEG_TREE_UNIFORM_FLOATS
/** Wet reflections' lights this frame (see `reflections/lights.ts`): each light's mirror image, packed per frame. */
export const OUTBREAK_REFLECT_LIGHTS_UNIFORM_OFFSET = OUTBREAK_REFLECT_UNIFORM_OFFSET + REFLECTION_UNIFORM_FLOATS
export const OUTBREAK_REFLECT_LIGHTS_UNIFORM_END = OUTBREAK_REFLECT_LIGHTS_UNIFORM_OFFSET + REFLECTION_LIGHTS * REFLECTION_LIGHT_FLOATS
/** Lens street lamps (see `street-lamps/settings.ts`): `street0..2`. */
export const OUTBREAK_STREET_LAMP_UNIFORM_OFFSET = OUTBREAK_REFLECT_LIGHTS_UNIFORM_END
/** Rooms behind the windows (see `window-rooms/settings.ts`): `rooms`, `rooms2`. */
export const OUTBREAK_WINDOW_ROOM_UNIFORM_OFFSET = OUTBREAK_STREET_LAMP_UNIFORM_OFFSET + STREET_LAMP_UNIFORM_FLOATS
export const OUTBREAK_LIGHTING_UNIFORM_FLOATS = OUTBREAK_WINDOW_ROOM_UNIFORM_OFFSET + WINDOW_ROOM_UNIFORM_FLOATS

export type OutbreakLightingUniformSettings =
  | (OutbreakLightingSettings & Partial<FlashlightBeamSettings> & Partial<UnseenSettings> & {
      flashlightIntensity: number
      flashlightRange: number
      flashlightCone: number
      flashlightWarmth: number
      fogStyle?: number
      fogEdgeSoftness?: number
      fogMemoryDim?: number
      fogMemorySaturation?: number
      fogMemoryWarmth?: number
      fogPenumbra?: number
      fogPenumbraGrowth?: number
      fogRevealTime?: number
      fogFadeTime?: number
    })
  | {
      lighting: OutbreakLightingSettings
      flashlight: Partial<FlashlightBeamSettings> & {
        flashlightIntensity: number
        flashlightRange: number
        flashlightCone: number
        flashlightWarmth: number
      }
      fog?: {
        fogStyle?: number
        fogEdgeSoftness?: number
        fogMemoryDim?: number
          fogMemorySaturation?: number
        fogMemoryWarmth?: number
        fogPenumbra?: number
        fogPenumbraGrowth?: number
        fogRevealTime?: number
        fogFadeTime?: number
      }
      unseen?: Partial<UnseenSettings>
      look?: Partial<OutbreakLookTrims>
      survivor?: Partial<HeroLookSettings>
    }

export type OutbreakLightingFrameState = {
  settings: OutbreakLightingUniformSettings
  playerX: number
  playerY: number
  playerH: number
  playerAim: number
  flashlightOutput: number
  flashlightSlot: number
  /** Lens height above the world origin (ground plus hand height). */
  flashlightHeight?: number
  /** Where the beam's axis first meets a wall or the ground, for the bounce. */
  flashlightBounce?: readonly [number, number]
  /** World height of the bounce source. */
  flashlightBounceHeight?: number
  /** Distance along the aim to the first wall (or the beam range), where the air glow stops. */
  flashlightAirLimit?: number
  /** Seconds since the last frame; 0 snaps the visibility field (teleports, resets). */
  frameDt?: number
  /** Lens plan position (from the survivor rig), default a hand's reach along the aim. */
  flashlightOrigin?: readonly [number, number]
  /** Beam yaw and pitch (radians, negative pitch points down); default the aim and the pool-distance tilt. */
  flashlightYaw?: number
  flashlightPitch?: number
  /** Camera inverse view-projection, for the volumetric beam's view rays. */
  invViewProj?: ArrayLike<number>
  /** Extra air density from rain and mist (0..2). */
  weatherAir?: number
  /** Distance from the lens where the visible shaft has faded out (its screen rect ends there too). */
  beamReach?: number
  inInteriorView: boolean
  /** Lens centre of the streetlamp nearest the camera target. */
  streetHead: readonly [number, number, number]
  /** Up to two nearest living zombies (x, y); unused slots are far away. */
  zombies: readonly [number, number, number, number]
  weather?: {
    wetness: number
    puddleCoverage: number
    rippleIntensity: number
    snowAmount: number
    /** Wet gloss in light, 0..2 (AR-71; `OL.art.w`). */
    wetGloss?: number
    /** Lightning this frame 0..1 times how far it lifts the shroud: the shroud and out-of-light darkening ease off. */
    shroudLift?: number
  }
  windowOrigin?: readonly [number, number]
  isStreamWindow?: boolean
  windowBuildings?: readonly Building[]
  unseen?: Partial<UnseenFrameEvaluation>
  chunkFadeAlpha?: number
  /** Night sight's eased weight this frame (`look/night-sight.ts`); 0 or absent is off. */
  nightSightWeight?: number
  /** Lens street lamps (`street-lamps/`); absent is Today. */
  streetLamps?: OutbreakStreetLampSettings
  /** Rooms behind the windows (`window-rooms/`); absent is Today. */
  windowRooms?: OutbreakWindowRoomSettings
}

/**
 * Packs 40 floats (10 vec4f) into Renderer's custom uniform buffer (@group(0) @binding(13)):
 * u0: skyFill, moonFill, practicalWarmth, lightFalloff
 * u1: porchPower, windowPower, roomPower, streetPower
 * u2: flashlightHaze, wetSpecular, rimStrength, vignetteDarkness
 * u3: flashOriginX, flashOriginY, flashDirX, flashDirY
 * u4: flashTanHalf, flashRange, flashPower, flashSlot
 * u5: flashColorR, flashColorG, flashColorB, inInteriorView (1 or 0)
 * u6: playerX, playerY, playerH, exposure
 * u7: streetHeadX, streetHeadY, streetHeadZ, streetAirHaze
 * u8: actorLampShadow, fogStyleAndGrain, fogEdgeSoftness, fogMemoryDim
 * u9: zombie0X, zombie0Y, zombie1X, zombie1Y
 */
export function packOutbreakLightingUniforms(
  state: OutbreakLightingFrameState,
  flashColor: readonly [number, number, number],
  out: Float32Array<ArrayBuffer> = new Float32Array(OUTBREAK_LIGHTING_UNIFORM_FLOATS),
): Float32Array<ArrayBuffer> {
  const raw = state.settings
  const isNested = "flashlight" in raw
  const l = isNested ? { ...raw.lighting, ...trimLighting(raw.lighting, raw.look) } : raw
  const fl = isNested ? raw.flashlight : raw
  const fg = isNested ? raw.fog : raw
  const un = isNested ? raw.unseen : raw
  const dirX = Math.cos(state.playerAim)
  const dirY = Math.sin(state.playerAim)
  const handX = state.flashlightOrigin?.[0] ?? state.playerX + dirX * 0.24
  const handY = state.flashlightOrigin?.[1] ?? state.playerY + dirY * 0.24
  const beamDirX = state.flashlightYaw === undefined ? dirX : Math.cos(state.flashlightYaw)
  const beamDirY = state.flashlightYaw === undefined ? dirY : Math.sin(state.flashlightYaw)
  const halfRad = (Math.max(10, Math.min(120, fl.flashlightCone)) * Math.PI) / 360
  const beamPoolDistance = fl.beamPoolDistance ?? DEFAULT_FLASHLIGHT_BEAM.beamPoolDistance
  const beamInner = fl.beamInner ?? DEFAULT_FLASHLIGHT_BEAM.beamInner
  const beamCore = fl.beamCore ?? DEFAULT_FLASHLIGHT_BEAM.beamCore
  const beamCoreWidth = fl.beamCoreWidth ?? DEFAULT_FLASHLIGHT_BEAM.beamCoreWidth
  const beamSpill = fl.beamSpill ?? DEFAULT_FLASHLIGHT_BEAM.beamSpill
  const beamSpillWidth = fl.beamSpillWidth ?? DEFAULT_FLASHLIGHT_BEAM.beamSpillWidth
  const beamCookie = fl.beamCookie ?? DEFAULT_FLASHLIGHT_BEAM.beamCookie
  const beamNearSoftening = fl.beamNearSoftening ?? DEFAULT_FLASHLIGHT_BEAM.beamNearSoftening
  const beamColorKnee = fl.beamColorKnee ?? DEFAULT_FLASHLIGHT_BEAM.beamColorKnee
  const beamBounce = fl.beamBounce ?? DEFAULT_FLASHLIGHT_BEAM.beamBounce
  const beamAirScatter = fl.beamAirScatter ?? DEFAULT_FLASHLIGHT_BEAM.beamAirScatter
  const practicalColor = fl.practicalColor ?? DEFAULT_FLASHLIGHT_BEAM.practicalColor
  const beamVisibility = fl.beamVisibility ?? DEFAULT_FLASHLIGHT_BEAM.beamVisibility
  const beamDust = fl.beamDust ?? DEFAULT_FLASHLIGHT_BEAM.beamDust
  const beamGlare = fl.beamGlare ?? DEFAULT_FLASHLIGHT_BEAM.beamGlare
  const beamQuality = fl.beamQuality ?? DEFAULT_FLASHLIGHT_BEAM.beamQuality
  const lensH = state.flashlightHeight ?? state.playerH + 1.34
  const tilt = Math.atan2(Math.max(0.3, lensH - state.playerH), Math.max(0.5, beamPoolDistance))

  // u0
  out[0] = l.skyFill
  out[1] = l.moonFill
  out[2] = l.practicalWarmth
  out[3] = l.lightFalloff
  // u1
  out[4] = l.porchPower
  out[5] = l.windowPower
  out[6] = l.roomPower
  out[7] = l.streetPower
  // u2
  out[8] = l.flashlightHaze
  out[9] = l.wetSpecular
  out[10] = l.rimStrength
  out[11] = l.vignetteDarkness
  // u3
  out[12] = handX
  out[13] = handY
  out[14] = beamDirX
  out[15] = beamDirY
  // u4
  out[16] = Math.tan(halfRad)
  out[17] = fl.flashlightRange
  out[18] = state.flashlightOutput * fl.flashlightIntensity
  out[19] = state.flashlightSlot
  // u5
  out[20] = flashColor[0]
  out[21] = flashColor[1]
  out[22] = flashColor[2]
  out[23] = state.inInteriorView ? 1 : 0
  // u6
  out[24] = state.playerX
  out[25] = state.playerY
  out[26] = state.playerH
  out[27] = l.exposure
  // u7
  out[28] = state.streetHead[0]
  out[29] = state.streetHead[1]
  out[30] = state.streetHead[2]
  out[31] = l.streetAirHaze
  // u8: actorLampShadow, weatherWetness, weatherPuddles, weatherSnow
  out[32] = l.actorLampShadow
  out[33] = state.weather?.wetness ?? 0
  out[34] = state.weather?.puddleCoverage ?? 0
  out[35] = state.weather?.snowAmount ?? 0
  // u9
  out[36] = state.zombies[0]
  out[37] = state.zombies[1]
  out[38] = state.zombies[2]
  out[39] = state.zombies[3]
  // u10: fogStyle (× 4), fogEdgeSoftness, fogMemoryDim, fogMemorySaturation
  out[40] = (fg?.fogStyle ?? 1) * 4
  out[41] = fg?.fogEdgeSoftness ?? 0.78
  out[42] = fg?.fogMemoryDim ?? 0.42
  out[43] = fg?.fogMemorySaturation ?? 0.2
  const N = OUTBREAK_NOIR_UNIFORM_OFFSET
  // u11: lens height, cos(outer half-angle), inner share, core strength
  out[N + 0] = lensH
  out[N + 1] = Math.cos(halfRad)
  out[N + 2] = beamInner
  out[N + 3] = beamCore
  // u12: core width share, spill level, spill width share, reflector rings
  out[N + 4] = beamCoreWidth
  out[N + 5] = beamSpill
  out[N + 6] = beamSpillWidth
  out[N + 7] = beamCookie
  // u13: axis y, axis plan scale, near-lens softening, colour knee
  const beamPitch = state.flashlightPitch ?? -tilt
  out[N + 8] = Math.sin(beamPitch)
  out[N + 9] = Math.cos(beamPitch)
  out[N + 10] = beamNearSoftening
  out[N + 11] = beamColorKnee
  // u14: bounce point, bounce power, air scatter
  out[N + 12] = state.flashlightBounce ? state.flashlightBounce[0] : handX + beamDirX * beamPoolDistance
  out[N + 13] = state.flashlightBounce ? state.flashlightBounce[1] : handY + beamDirY * beamPoolDistance
  out[N + 14] = state.flashlightOutput * fl.flashlightIntensity * beamBounce
  const tier = BEAM_QUALITY_TIERS[Math.round(beamQuality)] ?? BEAM_QUALITY_TIERS[2]
  // The closed-form air glow stands in for the volumetric pass when it is off.
  out[N + 15] = tier.downscale ? 0 : beamAirScatter
  // u15: penumbra base, penumbra growth per metre, reveal and fade blend factors for this frame
  const dt = state.frameDt ?? 1 / 60
  out[N + 16] = fg?.fogPenumbra ?? 0.22
  out[N + 17] = fg?.fogPenumbraGrowth ?? 0.05
  out[N + 18] = dt <= 0 ? 1 : 1 - Math.exp(-dt / Math.max(0.005, fg?.fogRevealTime ?? 0.07))
  out[N + 19] = dt <= 0 ? 1 : 1 - Math.exp(-dt / Math.max(0.005, fg?.fogFadeTime ?? 0.25))
  // u16: memory warmth, practical-light colour weight, cos of the spill cutoff, air glow limit
  out[N + 20] = fg?.fogMemoryWarmth ?? 0.6
  out[N + 21] = practicalColor
  out[N + 22] = Math.cos(Math.min(Math.PI * 0.95, halfRad * beamSpillWidth * 1.7))
  // An open view has no wall along the axis (`raycast` gives Infinity): an infinite limit makes the glow's fade NaN.
  out[N + 23] = Math.min(state.flashlightAirLimit ?? Infinity, fl.flashlightRange)
  // u17: bounce height (a ground pool sits low, a wall hotspot at chest height)
  out[N + 24] = state.flashlightBounceHeight ?? state.playerH + 0.3
  out[N + 25] = 1 / Math.max(1e-3, halfRad)
  out[N + 26] = state.chunkFadeAlpha ?? 0
  out[N + 27] = windowBuildingBits(state.windowBuildings ?? [], litWindowShareOf(state.settings))
  // Volumetric beam: inverse view-projection, then density, dust, glare, samples; air boost, indoors, ground, reserved
  const B = OUTBREAK_BEAM_UNIFORM_OFFSET
  if (state.invViewProj) for (let i = 0; i < 16; i++) out[B + i] = state.invViewProj[i]!
  out[B + 16] = beamVisibility * (tier.downscale ? 1 : 0)
  out[B + 17] = beamDust
  out[B + 18] = beamGlare
  out[B + 19] = tier.samples
  out[B + 20] = state.weatherAir ?? 0
  out[B + 21] = state.inInteriorView ? 1 : 0
  out[B + 22] = state.playerH
  out[B + 23] = state.beamReach ?? 13
  // Unseen block (offset 164..171): mode, effectiveStrength, edgeSoftness, updateRate, nightFactor, flashCosHalf, flashActive, hideZombies
  const uMode = state.unseen?.mode ?? un?.unseenMode ?? 0
  const uStrength = state.unseen?.effectiveStrength ?? (uMode > 0 ? (un?.unseenStrength ?? 1.0) : 0)
  const uSoft = state.unseen?.edgeSoftness ?? un?.unseenEdgeSoftness ?? 0.85
  const uRate = state.unseen?.updateRate ?? un?.unseenUpdateRate ?? 10
  const uNight = state.unseen?.nightFactor ?? 1.0
  const uHide = state.unseen?.hideZombies ?? un?.hideUnseenZombies ?? true
  const flashActive = state.flashlightOutput > 0.01 && fl.flashlightIntensity > 0.01 ? 1 : 0
  unseenUniformsStruct.pack(
    {
      mode: uMode,
      strength: uStrength,
      edgeSoftness: uSoft,
      updateRate: uRate,
      nightFactor: uNight,
      flashCosHalf: Math.cos(halfRad),
      flashActive,
      hideZombies: uHide ? 1 : 0,
    },
    out,
    OUTBREAK_UNSEEN_UNIFORM_OFFSET,
  )
  packLightRamps(
    {
      beamFalloffCurve: (fl as Partial<FlashlightBeamSettings>).beamFalloffCurve,
      lampFalloffCurve: (l as Partial<OutbreakLightingSettings>).lampFalloffCurve,
      unseenDepthCurve: (un as Partial<UnseenSettings> | undefined)?.unseenDepthCurve,
    },
    out,
    OUTBREAK_RAMP_UNIFORM_OFFSET,
  )
  const hero = (isNested ? raw.survivor : undefined) ?? DEFAULT_HERO_LOOK
  out[OUTBREAK_HERO_UNIFORM_OFFSET] = hero.heroRim ?? DEFAULT_HERO_LOOK.heroRim
  out[OUTBREAK_HERO_UNIFORM_OFFSET + 1] = hero.heroRimTight ?? DEFAULT_HERO_LOOK.heroRimTight
  out[OUTBREAK_HERO_UNIFORM_OFFSET + 2] = hero.heroFlat ?? DEFAULT_HERO_LOOK.heroFlat
  out[OUTBREAK_HERO_UNIFORM_OFFSET + 3] = hero.heroSaturation ?? DEFAULT_HERO_LOOK.heroSaturation
  out[OUTBREAK_BEAN_UNIFORM_OFFSET] = hero.beanWrap ?? DEFAULT_HERO_LOOK.beanWrap
  out[OUTBREAK_BEAN_UNIFORM_OFFSET + 1] = hero.beanSheen ?? DEFAULT_HERO_LOOK.beanSheen
  out[OUTBREAK_BEAN_UNIFORM_OFFSET + 2] = hero.beanSheenTight ?? DEFAULT_HERO_LOOK.beanSheenTight
  out[OUTBREAK_BEAN_UNIFORM_OFFSET + 3] = hero.beanOwnColour ?? DEFAULT_HERO_LOOK.beanOwnColour
  const look = (isNested ? raw.look : undefined) ?? DEFAULT_LOOK_TRIMS
  out[OUTBREAK_COLOUR_UNIFORM_OFFSET] = look.lightColour ?? DEFAULT_LOOK_TRIMS.lightColour
  out[OUTBREAK_COLOUR_UNIFORM_OFFSET + 1] = look.visionLift ?? DEFAULT_LOOK_TRIMS.visionLift
  out[OUTBREAK_COLOUR_UNIFORM_OFFSET + 2] = look.bounceColour ?? DEFAULT_LOOK_TRIMS.bounceColour
  out[OUTBREAK_COLOUR_UNIFORM_OFFSET + 3] = look.bakedLight ?? DEFAULT_LOOK_TRIMS.bakedLight
  out[OUTBREAK_DUST_UNIFORM_OFFSET] = look.dustAmount ?? DEFAULT_LOOK_TRIMS.dustAmount
  out[OUTBREAK_DUST_UNIFORM_OFFSET + 1] = look.dustBrightness ?? DEFAULT_LOOK_TRIMS.dustBrightness
  out[OUTBREAK_DUST_UNIFORM_OFFSET + 2] = look.dustSize ?? DEFAULT_LOOK_TRIMS.dustSize
  out[OUTBREAK_DUST_UNIFORM_OFFSET + 3] = look.dustLamps ?? DEFAULT_LOOK_TRIMS.dustLamps
  // A lightning flash lights the whole town for a moment: the shroud and the out-of-light darkening ease off (AR-71).
  const keep = 1 - Math.max(0, Math.min(1, state.weather?.shroudLift ?? 0))
  out[OUTBREAK_SHROUD_UNIFORM_OFFSET] = (look.shroudDarkness ?? DEFAULT_LOOK_TRIMS.shroudDarkness) * keep
  out[OUTBREAK_SHROUD_UNIFORM_OFFSET + 1] = look.outOfLightDesat ?? DEFAULT_LOOK_TRIMS.outOfLightDesat
  out[OUTBREAK_SHROUD_UNIFORM_OFFSET + 2] = (look.outOfSightDarkening ?? DEFAULT_LOOK_TRIMS.outOfSightDarkening) * keep
  out[OUTBREAK_SHROUD_UNIFORM_OFFSET + 3] = look.worldSaturation ?? DEFAULT_LOOK_TRIMS.worldSaturation
  out[OUTBREAK_BEAM_LOOK_UNIFORM_OFFSET] = look.beamWarmth ?? DEFAULT_LOOK_TRIMS.beamWarmth
  out[OUTBREAK_BEAM_LOOK_UNIFORM_OFFSET + 1] = look.beamTightness ?? DEFAULT_LOOK_TRIMS.beamTightness
  out[OUTBREAK_BEAM_LOOK_UNIFORM_OFFSET + 2] = look.zombieRimSpec ?? DEFAULT_LOOK_TRIMS.zombieRimSpec
  out[OUTBREAK_BEAM_LOOK_UNIFORM_OFFSET + 3] = look.nightGrain ?? DEFAULT_LOOK_TRIMS.nightGrain
  out[OUTBREAK_SIGHT_UNIFORM_OFFSET] = look.coneSharpness ?? DEFAULT_LOOK_TRIMS.coneSharpness
  out[OUTBREAK_SIGHT_UNIFORM_OFFSET + 1] = look.dayShroud ?? DEFAULT_LOOK_TRIMS.dayShroud
  out[OUTBREAK_SIGHT_UNIFORM_OFFSET + 2] = look.dayMuted ?? DEFAULT_LOOK_TRIMS.dayMuted
  out[OUTBREAK_SIGHT_UNIFORM_OFFSET + 3] = look.shroudLampKeep ?? DEFAULT_LOOK_TRIMS.shroudLampKeep
  out[OUTBREAK_ART_UNIFORM_OFFSET] = look.sightGlow ?? DEFAULT_LOOK_TRIMS.sightGlow
  out[OUTBREAK_ART_UNIFORM_OFFSET + 1] = look.groundDetail ?? DEFAULT_LOOK_TRIMS.groundDetail
  out[OUTBREAK_ART_UNIFORM_OFFSET + 2] = look.lampRolloff ?? DEFAULT_LOOK_TRIMS.lampRolloff
  out[OUTBREAK_ART_UNIFORM_OFFSET + 3] = state.weather?.wetGloss ?? 1
  out[OUTBREAK_NIGHT_UNIFORM_OFFSET] = state.nightSightWeight ?? 0
  out[OUTBREAK_NIGHT_UNIFORM_OFFSET + 1] = Math.max(0.5, look.nightSightRadius ?? DEFAULT_LOOK_TRIMS.nightSightRadius)
  out[OUTBREAK_NIGHT_UNIFORM_OFFSET + 2] = Math.max(0.5, look.nightSightFalloff ?? DEFAULT_LOOK_TRIMS.nightSightFalloff)
  out[OUTBREAK_NIGHT_UNIFORM_OFFSET + 3] = 0
  packReflectionUniforms(look, state.weather?.rippleIntensity ?? 0, out, OUTBREAK_REFLECT_UNIFORM_OFFSET)
  packStreetLampUniforms(state.streetLamps, streetPostArm(state.streetHead), out, OUTBREAK_STREET_LAMP_UNIFORM_OFFSET)
  packWindowRoomUniforms(state.windowRooms, out, OUTBREAK_WINDOW_ROOM_UNIFORM_OFFSET)
  // win (offset 76..79): windowOriginX, windowOriginZ, isStreamWindow, buildingCount
  const winOx = state.windowOrigin?.[0] ?? 0
  const winOz = state.windowOrigin?.[1] ?? 0
  const blds = state.windowBuildings ?? []
  const bldCount = Math.min(8, blds.length)
  out[OUTBREAK_WINDOW_UNIFORM_OFFSET] = winOx
  out[OUTBREAK_WINDOW_UNIFORM_OFFSET + 1] = winOz
  out[OUTBREAK_WINDOW_UNIFORM_OFFSET + 2] = state.isStreamWindow ? 1 : 0
  out[OUTBREAK_WINDOW_UNIFORM_OFFSET + 3] = bldCount
  for (let i = 0; i < 8; i++) {
    const base = OUTBREAK_WINDOW_UNIFORM_OFFSET + 4 + i * 4
    const b = blds[i]
    if (b) {
      out[base] = b.rect[0]
      out[base + 1] = b.rect[1]
      out[base + 2] = b.rect[2]
      out[base + 3] = b.rect[3]
    } else {
      out[base] = -99999
      out[base + 1] = -99999
      out[base + 2] = -99998
      out[base + 3] = -99998
    }
  }
  return out
}

export type ResolvedLamp = {
  lx: number
  lh: number
  ly: number
  r: number
  rEff: number
  color: [number, number, number]
  power: number
  fixtureBrightness: number
  cone: [number, number, number, number]
  softness: number
  castShadows: boolean
}

/**
 * Resolves 2100K high-pressure sodium streetlamps and warm 2500K-2700K tungsten porch/window/room practicals.
 */
export function resolveLampLight(
  lamp: Lamp,
  buildings: readonly Building[],
  dayLamps: number,
  s: OutbreakLightingSettings,
  inInteriorView: boolean,
  out?: ResolvedLamp,
  litWindowShare = DEFAULT_LIT_WINDOWS,
): ResolvedLamp {
  const master = dayLamps * s.lighting
  const w = Math.max(0, Math.min(1, s.practicalWarmth))
  const tight = Math.max(0.5, s.lightFalloff)
  const invTight = 1 / Math.sqrt(tight)
  const dst: ResolvedLamp = out ?? {
    lx: 0,
    lh: 0,
    ly: 0,
    r: 0,
    rEff: 0,
    color: [0, 0, 0],
    power: 0,
    fixtureBrightness: 0,
    cone: [0, 0, 0, 0],
    softness: 0,
    castShadows: false,
  }

  if (lamp.kind === "street") {
    let lx = lamp.x + 0.55
    let ly = lamp.y
    let lh = lamp.h
    let r = lamp.radius * 0.92 * invTight
    let pMult = 1.0
    if (lamp.x === 52 && lamp.y === 39) {
      lx = 40.6
      ly = 42.4
      lh = 3.65
      r = 6.8 * invTight
      pMult = 1.65
    } else if (lamp.x === 50 && lamp.y === 8) {
      lx = 39.2
      ly = 24.6
      lh = 3.65
      r = 6.8 * invTight
      pMult = 1.75
    }
    const power = master * lamp.power * s.streetPower * pMult
    dst.lx = lx
    dst.lh = lh
    dst.ly = ly
    dst.r = r
    dst.rEff = r * 0.88
    dst.color[0] = 1.0
    dst.color[1] = 0.46 - 0.05 * w
    dst.color[2] = 0.10 - 0.03 * w
    dst.power = power
    dst.fixtureBrightness = master * s.streetPower * 0.95
    dst.cone[0] = 0
    dst.cone[1] = 0
    dst.cone[2] = 0
    dst.cone[3] = 0
    dst.softness = 0.22
    dst.castShadows = false
    return dst
  }

  if (lamp.kind === "porch") {
    const interiorDim = inInteriorView ? 0.44 : 1.0
    const power = master * lamp.power * s.porchPower * interiorDim
    const r = lamp.radius * (inInteriorView ? 0.50 : 0.66) * invTight
    dst.lx = lamp.x
    dst.lh = 2.24
    dst.ly = lamp.y - 0.14
    dst.r = r
    dst.rEff = r * 0.85
    dst.color[0] = 1.0
    dst.color[1] = 0.56 - 0.04 * w
    dst.color[2] = 0.16 - 0.04 * w
    dst.power = power
    dst.fixtureBrightness = master * s.porchPower * (inInteriorView ? 0.62 : 1.16)
    dst.cone[0] = 0
    dst.cone[1] = 0
    dst.cone[2] = 0
    dst.cone[3] = -1
    dst.softness = 0.18
    dst.castShadows = !inInteriorView
    return dst
  }

  if (lamp.kind === "window") {
    const interiorDim = inInteriorView ? 0.46 : 1.0
    // Most houses are dark: only the ones with a lamp left on (look/lit-windows.ts) spill window light.
    const bld = windowLampBuilding(lamp, buildings)
    const on = bld ? (windowsLit(bld, litWindowShare) ? 1 : 0) : 1
    const power = master * lamp.power * s.windowPower * interiorDim * on
    const r = lamp.radius * 0.80 * invTight
    dst.lx = lamp.x
    dst.lh = 1.42
    dst.ly = lamp.y + 0.06
    dst.r = r
    dst.rEff = r * 0.85
    dst.color[0] = 1.0
    dst.color[1] = 0.54 - 0.04 * w
    dst.color[2] = 0.15 - 0.04 * w
    dst.power = power
    dst.fixtureBrightness = master * s.windowPower * (inInteriorView ? 0.68 : 1.32) * on
    dst.cone[0] = 0
    dst.cone[1] = 1
    dst.cone[2] = -0.65
    dst.cone[3] = 1
    dst.softness = 0.20
    dst.castShadows = false
    return dst
  }

  // Room practicals: selective choreography per room role inside each house
  let b: Building | undefined
  for (let i = 0; i < buildings.length; i++) {
    const bld = buildings[i]!
    if (lamp.x >= bld.rect[0] && lamp.x <= bld.rect[2] && lamp.y >= bld.rect[1] && lamp.y <= bld.rect[3]) {
      b = bld
      break
    }
  }
  let lx = lamp.x
  let ly = lamp.y
  let lh = lamp.h
  let rScale = 0.76
  let pScale = 0.62
  let fixtureScale = 0.65
  let castShadows = false
  let cG = 0.50 - 0.05 * w
  let cB = 0.13 - 0.04 * w

  if (b && b.kind === "house") {
    const relX = lamp.x - b.rect[0]
    const relY = lamp.y - b.rect[1]
    if (relX < 4.0 && relY < 3.0) {
      // #1 NW bedroom nightstand lamp: warm primary focal pool next to bed
      lx = b.rect[0] + 2.75
      ly = b.rect[1] + 1.25
      lh = 1.28
      rScale = 0.96
      pScale = 1.15
      fixtureScale = 1.25
      castShadows = true
      cG = 0.54 - 0.05 * w
      cB = 0.14 - 0.04 * w
    } else if (relX > 4.0 && relY < 4.5) {
      // #4 NE bedroom dresser / rug fill
      lx = b.rect[0] + 6.85
      ly = b.rect[1] + 2.15
      lh = 1.55
      rScale = 0.68
      pScale = 0.42
      fixtureScale = 0.25
      cG = 0.48 - 0.04 * w
      cB = 0.12 - 0.03 * w
    } else if (relX < 4.5 && relY >= 4.5) {
      // #2 SW living room: warm pool over Oriental rug & coffee table
      lx = b.rect[0] + 2.75
      ly = b.rect[3] - 2.35
      lh = 1.42
      rScale = 0.72
      pScale = 0.52
      fixtureScale = 0.25
      cG = 0.48 - 0.04 * w
      cB = 0.12 - 0.03 * w
    } else {
      // #3 SE kitchen/dining: warm pool over kitchen sink counter & dining table
      lx = b.rect[2] - 3.35
      ly = b.rect[3] - 3.15
      lh = 1.68
      rScale = 0.86
      pScale = 0.88
      fixtureScale = 0.52
      cG = 0.52 - 0.05 * w
      cB = 0.14 - 0.04 * w
    }
  }

  const r = lamp.radius * rScale * invTight
  // Secondary room accent pools are baked into bounceTex + analytical room bounce; only the shadow-casting primary lamp runs in lightSum
  const power = master * lamp.power * s.roomPower * (castShadows || !inInteriorView ? pScale : 0)
  dst.lx = lx
  dst.lh = lh
  dst.ly = ly
  dst.r = r
  dst.rEff = r * 0.85
  dst.color[0] = 1.0
  dst.color[1] = cG
  dst.color[2] = cB
  dst.power = power
  dst.fixtureBrightness = master * s.roomPower * fixtureScale
  dst.cone[0] = 0
  dst.cone[1] = 0
  dst.cone[2] = 0
  dst.cone[3] = -1
  dst.softness = 0.16
  dst.castShadows = castShadows
  return dst
}

/**
 * A room accent lamp's pool for the bake (`lightbake.ts`), or undefined for lamps that are live lights indoors (the
 * shadow-casting primary lamp) and for porch, window and street lamps.
 */
export function bakedRoomLamp(lamp: Lamp, buildings: readonly Building[]): BakeLamp | undefined {
  if (lamp.kind !== "room") return undefined
  const res = resolveLampLight(lamp, buildings, 1, DEFAULT_OUTBREAK_LIGHTING, false)
  if (res.castShadows || res.power <= 0.001) return undefined
  return { x: res.lx, z: res.ly, h: Math.max(0.6, res.lh), r: res.r * 1.1, color: res.color, power: res.power }
}

/**
 * Concrete Baking Recommendation #1:
 * Bakes indirect light into a 192x192 RGBA8 `bounceTex` (0.5m/texel) using an 8-neighbour corner-safe Dijkstra
 * flood-fill over `town.lamps` (`room`, `porch`, `window`, `street`), blocked by solid walls.
 * Stores `sqrt(rgb)` in `.rgb` for dark precision and wall-free coverage in `.a`. `tableLamps` are the client-side
 * furniture library's lamps, baked as pools only (`tableLampPool`).
 */
export function bakeOutbreakBounce(town: Town, tableLamps: readonly TableLamp[] = []): FloorMap {
  const w = 192
  const h = 192
  const cx = SIZE / w
  const cy = SIZE / h
  const solid = new Uint8Array(w * h)
  for (const b of town.barriers) {
    if (b.kind !== "wall") continue
    const r = b.rect
    const a0 = Math.max(0, Math.floor(r[0] / cx))
    const a1 = Math.min(w - 1, Math.ceil(r[2] / cx) - 1)
    const b0 = Math.max(0, Math.floor(r[1] / cy))
    const b1 = Math.min(h - 1, Math.ceil(r[3] / cy) - 1)
    for (let y = b0; y <= b1; y++) for (let x = a0; x <= a1; x++) solid[y * w + x] = 1
  }
  const acc = new Float32Array(w * h * 3)
  const dist = new Float32Array(w * h).fill(Infinity)
  const touched: number[] = []
  const N8 = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, -1, Math.SQRT2],
  ] as const

  const heap: number[] = []
  const push = (i: number, d: number) => {
    heap.push(d, i)
    let k = heap.length / 2 - 1
    while (k > 0) {
      const p = (k - 1) >> 1
      if (heap[p * 2]! <= heap[k * 2]!) break
      ;[heap[p * 2], heap[k * 2]] = [heap[k * 2]!, heap[p * 2]!]
      ;[heap[p * 2 + 1], heap[k * 2 + 1]] = [heap[k * 2 + 1]!, heap[p * 2 + 1]!]
      k = p
    }
  }
  const pop = (): [number, number] => {
    const d = heap[0]!
    const i = heap[1]!
    const ld = heap.pop()!
    const li = heap.pop()!
    if (heap.length) {
      heap[0] = li
      heap[1] = ld
      let k = 0
      const n = heap.length / 2
      for (;;) {
        const a = k * 2 + 1
        const b = a + 1
        let m = k
        if (a < n && heap[a * 2]! < heap[m * 2]!) m = a
        if (b < n && heap[b * 2]! < heap[m * 2]!) m = b
        if (m === k) break
        ;[heap[m * 2], heap[k * 2]] = [heap[k * 2]!, heap[m * 2]!]
        ;[heap[m * 2 + 1], heap[k * 2 + 1]] = [heap[k * 2 + 1]!, heap[m * 2 + 1]!]
        k = m
      }
    }
    return [d, i]
  }

  for (const lamp of town.lamps) {
    const res = resolveLampLight(lamp, town.buildings, 1, DEFAULT_OUTBREAK_LIGHTING, false)
    const reach = Math.min(10.5, res.r * 1.35)
    let sx = Math.min(w - 1, Math.max(0, Math.floor(res.lx / cx)))
    let sy = Math.min(h - 1, Math.max(0, Math.floor(res.ly / cy)))
    if (solid[sy * w + sx]) {
      // Nudge window/wall-mounted fixtures to nearest open cell
      for (const [dx, dy] of [
        [0, 1],
        [0, -1],
        [1, 0],
        [-1, 0],
      ] as const) {
        const nx = Math.min(w - 1, Math.max(0, sx + dx))
        const ny = Math.min(h - 1, Math.max(0, sy + dy))
        if (!solid[ny * w + nx]) {
          sx = nx
          sy = ny
          break
        }
      }
    }
    const startIdx = sy * w + sx
    dist[startIdx] = 0
    touched.push(startIdx)
    push(startIdx, 0)
    while (heap.length) {
      const [d, i] = pop()
      if (d > dist[i]!) continue
      const x = i % w
      const y = (i / w) | 0
      for (const [dx, dy, c] of N8) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const j = ny * w + nx
        if (solid[j]) continue
        if (dx && dy && (solid[y * w + nx] || solid[ny * w + x])) continue
        const nd = d + c * cx
        if (nd >= reach || nd >= dist[j]!) continue
        if (dist[j] === Infinity) touched.push(j)
        dist[j] = nd
        push(j, nd)
      }
    }
    const strength = lamp.kind === "room" ? 0.55 : lamp.kind === "porch" ? 0.45 : lamp.kind === "window" ? 0.40 : 0.48
    const k = res.power * strength
    for (const i of touched) {
      const t = 1 - dist[i]! / reach
      const f = t * t * k
      acc[i * 3] += res.color[0] * f
      acc[i * 3 + 1] += res.color[1] * f
      acc[i * 3 + 2] += res.color[2] * f
      dist[i] = Infinity
    }
    touched.length = 0
  }
  for (const lamp of town.lamps) {
    const pool = bakedRoomLamp(lamp, town.buildings)
    if (pool) addLampPool(acc, solid, w, 0, 0, cx, pool)
  }
  for (const l of tableLamps) addLampPool(acc, solid, w, 0, 0, cx, tableLampPool(l))

  const data = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) {
      data[i * 4 + c] = Math.round(Math.sqrt(Math.min(1, acc[i * 3 + c]! * 0.5)) * 255)
    }
    data[i * 4 + 3] = solid[i] ? 0 : 255
  }
  return { data, w, h, linear: acc }
}

/**
 * A long tree shadow along the moon/dusk direction (the same (0.79, 0.61) the round crown shadows lean): an ellipse
 * 1.6x the crown radius long, offset 1.5 m downwind of the trunk, streaked by limbs across it.
 */
function stampLongTreeShadow(moon: Float32Array, mw: number, mh: number, scale: number, x: number, z: number, rCrown: number): void {
  const dx0 = 0.79
  const dz0 = 0.61
  const cx = x + dx0 * 1.5
  const cz = z + dz0 * 1.5
  const ra = rCrown * 1.6
  const rb = rCrown * 0.95
  const ext = ra + 0.5
  const x0 = Math.max(0, Math.floor((cx - ext) / scale))
  const x1 = Math.min(mw - 1, Math.ceil((cx + ext) / scale))
  const z0 = Math.max(0, Math.floor((cz - ext) / scale))
  const z1 = Math.min(mh - 1, Math.ceil((cz + ext) / scale))
  for (let iz = z0; iz <= z1; iz++) {
    const dz = (iz + 0.5) * scale - cz
    for (let ix = x0; ix <= x1; ix++) {
      const idx = iz * mw + ix
      if (moon[idx]! <= 0.1) continue
      const dx = (ix + 0.5) * scale - cx
      const along = dx * dx0 + dz * dz0
      const across = -dx * dz0 + dz * dx0
      const u2 = (along / ra) ** 2 + (across / rb) ** 2
      if (u2 >= 1) continue
      const limbs = 0.62 + 0.38 * Math.abs(Math.sin(across * 3.4 + along * 0.9 + x * 1.7))
      moon[idx] = Math.min(moon[idx]!, 1 - (1 - u2) * 0.55 * limbs)
    }
  }
}

/**
 * Concrete Baking Recommendation #2:
 * Bakes a 768x768 (12.5cm/texel, 576 KiB) soft directional moon & tree-canopy shadow mask (`moonTex` at `@binding(8)`),
 * with 2x2 sub-texel window mullion coverage inside houses and soft exterior building/tree-crown shadows.
 */
export function bakeOutbreakMoonMask(town: Town): BakedMap {
  const mw = 768
  const mh = 768
  const scale = SIZE / mw
  const moon = new Float32Array(mw * mh).fill(1.0)
  const trees = town.props.filter((p) => p.kind === "tree")
  const windows = town.barriers.filter((b) => b.kind === "window")

  // Base indoor/outdoor assignment
  for (let bIdx = 0; bIdx < town.buildings.length; bIdx++) {
    const b = town.buildings[bIdx]!
    const [bx0, bz0, bx1, bz1] = b.rect
    const x0 = Math.max(0, Math.floor((bx0 - 1.5) / scale))
    const x1 = Math.min(mw - 1, Math.ceil((bx1 + 4.5) / scale))
    const z0 = Math.max(0, Math.floor((bz0 - 1.5) / scale))
    const z1 = Math.min(mh - 1, Math.ceil((bz1 + 3.5) / scale))
    for (let z = z0; z <= z1; z++) {
      const pz = (z + 0.5) * scale
      for (let x = x0; x <= x1; x++) {
        const px = (x + 0.5) * scale
        if (inBuildingFootprint(b, px, pz)) {
          moon[z * mw + x] = 0.055
        } else {
          // Soft exterior directional shadow cast by building walls & 4.35m pitched roof along dusk/moon direction (-0.32, +0.24)
          const sPx = px - 1.15
          const sPz = pz - 0.85
          if (inBuildingFootprint(b, sPx, sPz)) {
            moon[z * mw + x] = Math.min(moon[z * mw + x]!, 0.62)
          }
        }
      }
    }
  }

  // Soft spherical/dappled tree-crown canopy attenuation on exterior ground. Deadwood and Darkwood trees (tree looks 1
  // and 3) throw longer, darker, branch-streaked moon shadows instead.
  const longShadows = vegetationBuild.lively && (vegetationBuild.treeLook === 1 || vegetationBuild.treeLook === 3)
  for (const t of trees) {
    if (longShadows) {
      stampLongTreeShadow(moon, mw, mh, scale, t.x, t.y, 2.15 + t.variant * 0.75)
      continue
    }
    const rCrown = 2.15 + t.variant * 0.75
    const cx = t.x + 0.45
    const cz = t.y + 0.35
    const x0 = Math.max(0, Math.floor((cx - rCrown - 0.5) / scale))
    const x1 = Math.min(mw - 1, Math.ceil((cx + rCrown + 0.5) / scale))
    const z0 = Math.max(0, Math.floor((cz - rCrown - 0.5) / scale))
    const z1 = Math.min(mh - 1, Math.ceil((cz + rCrown + 0.5) / scale))
    const invR2 = 1 / (rCrown * rCrown)
    for (let z = z0; z <= z1; z++) {
      const dz = (z + 0.5) * scale - cz
      for (let x = x0; x <= x1; x++) {
        const idx = z * mw + x
        if (moon[idx]! <= 0.1) continue
        const dx = (x + 0.5) * scale - cx
        const u2 = (dx * dx + dz * dz) * invR2
        if (u2 < 1.0) {
          const dapple = 0.82 + 0.18 * Math.sin(dx * 4.2 + dz * 3.7)
          const atten = 1 - (1 - u2) * 0.38 * dapple
          moon[idx] = Math.min(moon[idx]!, atten)
        }
      }
    }
  }

  // 2x2 sub-texel window mullion & sash coverage inside houses (matching Blackout's window-light bake)
  for (const w of windows) {
    const [wx0, wz0, wx1, wz1] = w.rect
    const x0 = Math.max(0, Math.floor((wx0 - 2.8) / scale))
    const x1 = Math.min(mw - 1, Math.ceil((wx1 + 0.6) / scale))
    const z0 = Math.max(0, Math.floor((wz0 - 2.8) / scale))
    const z1 = Math.min(mh - 1, Math.ceil((wz1 + 0.6) / scale))
    const horiz = wx1 - wx0 > 1
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const idx = z * mw + x
        if (moon[idx]! > 0.25) continue
        let cov = 0
        for (const sy of [0.25, 0.75]) {
          const pz = (z + sy) * scale
          for (const sx of [0.25, 0.75]) {
            const px = (x + sx) * scale
            if (horiz) {
              const dz = wz0 - pz
              if (dz > -0.1 && dz < 2.6) {
                const xShift = px + dz * 0.18
                const half = (wx1 - wx0) * 0.46
                const mid = (wx0 + wx1) * 0.5
                const dx = Math.max(0, Math.abs(xShift - mid) - half)
                if (dx < 0.45) {
                  const along = Math.max(0, 1 - Math.max(0, dz) / 2.5)
                  const across = Math.max(0, 1 - dx / 0.42)
                  const mullion = Math.abs(xShift - mid) < 0.045 ? 0.55 : 1.0
                  cov += along * along * across * mullion
                }
              }
            } else {
              const dx = wx0 - px
              if (dx > -0.1 && dx < 2.6) {
                const zShift = pz - dx * 0.15
                const half = (wz1 - wz0) * 0.46
                const mid = (wz0 + wz1) * 0.5
                const dz = Math.max(0, Math.abs(zShift - mid) - half)
                if (dz < 0.45) {
                  const along = Math.max(0, 1 - Math.max(0, dx) / 2.5)
                  const across = Math.max(0, 1 - dz / 0.42)
                  const mullion = Math.abs(zShift - mid) < 0.045 ? 0.55 : 1.0
                  cov += along * along * across * mullion
                }
              }
            }
          }
        }
        if (cov > 0) {
          moon[idx] = Math.max(moon[idx]!, 0.055 + 0.84 * (cov * 0.25))
        }
      }
    }
  }

  const data = new Uint8Array(mw * mh)
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.round(Math.max(0, Math.min(1, moon[i]!)) * 255)
  }
  return { data, w: mw, h: mh }
}

/**
 * Concrete Baking Recommendation #3 & Blog Game Tip #4:
 * Packs 3D per-vertex contact AO & bevel boost (`aOpenTone`) into spare byte 19 (`v.color.a`) of `VERT_BYTES = 24`.
 * `128` (0.502) = 1.0x neutral; `< 128` darkens furniture/wall bottoms & eave soffits; `> 128` boosts top chamfers/bevels.
 */
export function stampOutbreakVertexTone(buf: ArrayBuffer): ArrayBuffer {
  const f32 = new Float32Array(buf)
  const i8 = new Int8Array(buf)
  const u8 = new Uint8Array(buf)
  const n = buf.byteLength / VERT_BYTES
  for (let k = 0; k < n; k++) {
    const o = k * VERT_BYTES
    const y = f32[o / 4 + 1]!
    const ny = i8[o + 13]! / 127
    let tone = 1.0
    if (y > 0.04 && y < 0.24 && Math.abs(ny) < 0.45) {
      // Base of walls, furniture legs, counters, and porch posts: contact darkening
      tone = 0.72 + (y - 0.04) * 1.4
    } else if (ny > 0.35 && ny < 0.88 && y > 0.35 && y < 2.45) {
      // Sloped bevels & chamfers on furniture (beds, sofas, tables, counters, car): rim boost
      tone = 1.16
    } else if (ny > 0.88 && y > 0.38 && y < 1.95) {
      // Upper horizontal surfaces of props & sills
      tone = 1.06
    } else if (ny < -0.5 && y > 2.2) {
      // Under-eave soffits
      tone = 0.68
    }
    u8[o + 19] = Math.max(1, Math.min(254, Math.round(tone * 128)))
  }
  return buf
}

/**
 * Per streamed-window building slot (0..7): bit i when it has the L-plan bungalow footprint (roof cut and interior
 * by wing), bit 8 + i when it is an authored origin house (tiled kitchen), bit 16 + i when a lamp is still on behind
 * its windows (`look/lit-windows.ts`, `litShare` of buildings). Exact in a float up to 2^24.
 */
export function windowBuildingBits(buildings: readonly { id: string; kind: string }[], litShare = 0): number {
  let bits = 0
  for (let i = 0; i < Math.min(8, buildings.length); i++) {
    const b = buildings[i]!
    if (!b.id) continue
    if (b.kind === "house") bits |= 1 << i
    if (b.id === "ash" || b.id === "elm") bits |= 1 << (8 + i)
    if (windowsLit(b, litShare)) bits |= 1 << (16 + i)
  }
  return bits
}

/** The lit-window share from either uniform settings shape (`litWindows` in the look trims). */
function litWindowShareOf(raw: OutbreakLightingUniformSettings): number {
  const look = "look" in raw ? raw.look : undefined
  return look?.litWindows ?? DEFAULT_LOOK_TRIMS.litWindows
}

/** Custom uniform block at binding 13, shared by the scene shader and the visibility-field compute pass. */
export const outbreakLightingStructWgsl = /* wgsl */ `
${unseenUniformsStruct.wgsl}
struct OutbreakLightingUniforms {
  u0: vec4f, // skyFill, moonFill, practicalWarmth, lightFalloff
  u1: vec4f, // porchPower, windowPower, roomPower, streetPower
  u2: vec4f, // flashlightHaze, wetSpecular, rimStrength, vignetteDarkness
  u3: vec4f, // flashOriginX, flashOriginY, flashDirX, flashDirY
  u4: vec4f, // flashTanHalf, flashRange, flashPower, flashSlot
  u5: vec4f, // flashColorR, flashColorG, flashColorB, inInteriorView
  u6: vec4f, // playerX, playerY, playerH, exposure
  u7: vec4f, // streetHeadX, streetHeadY, streetHeadZ, streetAirHaze
  u8: vec4f, // actorLampShadow, weatherWetness, weatherPuddles (standing water 0..1), weatherSnow
  u9: vec4f, // zombie0X, zombie0Y, zombie1X, zombie1Y
  u10: vec4f, // fogStyle × 4, fogEdgeSoftness, fogMemoryDim, fogMemorySaturation
  veg: FoliageWindConfig,
  vegActors: FoliageActors,
  win: vec4f, // windowOriginX, windowOriginZ, isStreamWindow, buildingCount
  bldRects: array<vec4f, 8>,
  u11: vec4f, // flashLensHeight, flashCosOuter, flashInnerShare, flashCore
  u12: vec4f, // flashCoreShare, flashSpill, flashSpillShare, flashCookie
  u13: vec4f, // flashAxisY, flashAxisPlan, flashNearSoftening, flashColorKnee
  u14: vec4f, // bounceX, bounceY, bouncePower, airScatter
  u15: vec4f, // fogPenumbra, fogPenumbraGrowth, fieldRevealBlend, fieldFadeBlend
  u16: vec4f, // fogMemoryWarmth, practicalColor, flashCosSpillCut, flashAirLimit
  u17: vec4f, // bounceHeight, 1 / outer half-angle, chunkFadeAlpha, windowBuildingBits
  invViewProj: mat4x4f,
  u18: vec4f, // beamDensity, beamDust, beamGlare, beamSamples
  u19: vec4f, // weatherAir, indoors, groundY, beamReach${interiorUniformFieldsWgsl}
  unseen: UnseenUniforms,${lightRampFieldsWgsl}
  hero: vec4f, // simple survivor: rim strength, rim exponent, flatten, colour kept
  colour: vec4f, // light-colour rule: on, vision lift, bounce weight; baked room light scale
  dust: vec4f, // dust motes: amount, brightness, size, under lamps
  bean: vec4f, // Soft Bean: light wrap, sheen, sheen exponent, own colour in the dark
  shroud: vec4f, // shroud & unlit: shroudDarkness, outOfLightDesat, outOfSightDarkening, worldSaturation
  beamLook: vec4f, // beamWarmth, beamTightness, zombieRimSpec, nightGrain
  sight: vec4f, // coneSharpness, dayShroud, dayMuted, shroudLampKeep
  art: vec4f, // sightGlow, groundDetail, lampRolloff, wetGloss (AR-71)
  night: vec4f, // night sight: weight this frame, readable radius, fade distance, reserved
  vegGust: FoliageGust,${vegetationTreeFieldsWgsl}
  refl: vec4f, // reflections: wet strength (0 off), pothole puddles on, Lab wetness, rain ripple
  mirror: vec4f, // mirrors: detail (0 baked, 1 live lights, 2 people), age, on, reserved
  reflLights: array<vec4f, ${(REFLECTION_LIGHTS * REFLECTION_LIGHT_FLOATS) / 4}>, // wet reflections: per light, image x, z, plan distance from the eye, size (0 ends); colour
  street0: vec4f, // lens street lamps: pool reach along, street side, house side (MH), cos cutoff
  street1: vec4f, // lens street lamps: on, side glow, air under the lens, reserved
  street2: vec4f, // nearest street head: arm x, arm z, lens half-length, half-width
  rooms: vec4f, // rooms behind the windows: on, depth, brightness, lit share
  rooms2: vec4f, // rooms behind the windows: curtains, wall wash, reserved ×2
}
@group(0) @binding(13) var<uniform> OL: OutbreakLightingUniforms;
${lightRampWgsl}
`

export const outbreakLightingDeclarationsWgsl = /* wgsl */ `
${outbreakLightingStructWgsl}
${vegetationTreeWgsl}
var<private> outbreakFlashMask: f32;
var<private> outbreakFlashIrr: f32;
var<private> outbreakAlbedo: vec3f;
var<private> outbreakPracticalIrr: f32;
var<private> outbreakSeen: f32;
/** 1 where the scenery is known (exterior, or an explored room), set by the fog of war. */
var<private> outbreakKnown: f32;
/** Received lamp bounce (luminance), left by \`outbreakBounce\` for the colour mask. */
var<private> outbreakBounceIrr: f32;
/** Bounced light's luminance times its colour weight (AR-115, \`outbreakBounceAndGi\` in bounce-light/wgsl.ts; 0 when off). */
var<private> outbreakGiIrr: f32;
/** The colour mask from light alone, times the light rule, before the sight terms (for the fog's memory tone). */
var<private> outbreakLitMask: f32;
var<private> outbreakInRoom: bool;
/** Soft Bean's light wrap on this fragment, or −1 for everything else (set in fragmentStart, read by diffuseTerm). */
var<private> outbreakWrap: f32;


/**
 * Temperature-balanced twilight sky fill: smoothly transitions between cool steel-blue night (practicalWarmth -> 0)
 * and 1970s suburban warm olive-ochre-slate twilight (practicalWarmth -> 0.8) without crushing shadows.
 */
fn outbreakSkyAmbient(n: vec3f, rawSky: vec3f) -> vec3f {
  let skyLum = dot(rawSky, vec3f(0.299, 0.587, 0.114));
  let suburbanSky = vec3f(skyLum) * vec3f(1.18, 0.90, 0.62);
  let sun = clamp(F.monitorBounds.w, 0.0, 1.0);
  let duskGlow = smoothstep(0.42, 0.22, F.monitorBounds.y) * (1.0 - smoothstep(0.25, 0.75, sun));
  let duskSky = rawSky * vec3f(1.28, 0.96, 0.74) + vec3f(0.015, 0.009, 0.004);
  let nightSky = mix(rawSky * vec3f(0.68, 0.76, 0.92), duskSky, duskGlow);
  let daySky = mix(rawSky, suburbanSky, 0.24) * 1.02;
  let sky = mix(nightSky, daySky, sun);
  return mix(sky * 0.34, sky, n.y * 0.5 + 0.5);
}

/**
 * Blog Game Tip #1: Analytical Window & Porch Light Cookie with Distance-Widening Penumbra & Drifting Canopy Sway.
 */
fn evalCanopyCookie(world: vec3f, inRoom: bool) -> f32 {
  if (F.ambient.w <= 0.0005) { return 1.0; }
  let t = F.cam.w;
  let w1 = sin(world.x * 0.62 + world.z * 0.48 + t * 0.55);
  let w2 = cos(world.x * 1.35 - world.z * 1.12 - t * 0.82);
  let canopyWave = 0.88 + 0.12 * (w1 * 0.6 + w2 * 0.4);
  return select(canopyWave, 0.92 + 0.08 * w1, inRoom);
}

/**
 * Blog Game Tip #5: Analytical Clipped Rectangular Area Light & Stretched Specular Sheen for Windows.
 */
fn evalWindowAreaAttenuation(dv: vec2f, d3: f32, tight: f32) -> f32 {
  let halfW = 0.92;
  let reachY = 2.45;
  let penumbra = 0.18 + max(0.0, dv.y) * 0.28;
  let rx = 1.0 - smoothstep(halfW - 0.12, halfW + penumbra, abs(dv.x));
  let ry = smoothstep(-0.25, 0.18, dv.y) * (1.0 - smoothstep(0.55, reachY, dv.y));
  let mullionDip = 1.0 - 0.16 * exp(-pow(dv.x / 0.12, 2.0)) * (1.0 - smoothstep(0.1, 1.4, dv.y));
  let solidAngle = 2.35 / (1.0 + d3 * d3 * 0.56 * tight);
  return rx * ry * mullionDip * solidAngle;
}

/** Nearest building rect (any archetype) from OL.bldRects[0..7]. */
fn nearestBuildingRect(p: vec2f) -> vec4f {
  let nBld = i32(OL.win.w);
  var best = OL.bldRects[0];
  var bestD2 = 1e12;
  for (var i = 0; i < 8; i++) {
    if (i >= nBld) { break; }
    let b = OL.bldRects[i];
    let dx = clamp(p.x, b.x, b.z) - p.x;
    let dz = clamp(p.y, b.y, b.w) - p.y;
    let d2 = dx * dx + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = b;
    }
  }
  return best;
}

/** Nearest L-plan bungalow rect from OL.bldRects[0..7] (falls back to bldRects[0]). */
fn nearestHouseRect(p: vec2f) -> vec4f {
  let nBld = i32(OL.win.w);
  var best = OL.bldRects[0];
  var bestD2 = 1e12;
  for (var i = 0; i < 8; i++) {
    if (i >= nBld) { break; }
    if (((u32(OL.u17.w) >> u32(i)) & 1u) == 0u) { continue; }
    let b = OL.bldRects[i];
    let dx = clamp(p.x, b.x, b.z) - p.x;
    let dz = clamp(p.y, b.y, b.w) - p.y;
    let d2 = dx * dx + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = b;
    }
  }
  return best;
}

/**
 * Blog Game Tip #3: Analytical Rectangular Area-Light Floor Bounce (officeFloorBounce).
 * Clamps world.xz to lit floor/porch patch bounds at floor height to bounce warm floor light
 * onto vertical walls, kitchen cabinets, and survivor/zombie legs.
 */
fn evalAreaFloorBounce(world: vec3f, n: vec3f, b: vec4f) -> vec3f {
  if (world.y > 2.25) { return vec3f(0.0); }
  // Clamp to nearest lit patch relative to house b: NW bedroom, SE kitchen/dining, or front porch
  let litBox = select(
    select(vec4f(b.x + 4.2, b.x + 7.2, b.w - 0.1, b.w + 3.3), vec4f(b.z - 5.2, b.z - 0.8, b.w - 5.7, b.w - 1.3), world.x > b.x + 8.2),
    vec4f(b.x + 1.2, b.x + 4.8, b.y + 0.4, b.y + 3.4),
    world.z < b.y + 4.8
  );
  let nearest = vec3f(clamp(world.x, litBox.x, litBox.y), 0.13, clamp(world.z, litBox.z, litBox.w));
  let toFloor = nearest - world;
  let d2 = dot(toFloor, toFloor);
  if (d2 > 9.0) { return vec3f(0.0); }
  let facing = max(0.0, dot(n, normalize(toFloor + vec3f(0.0, -1e-4, 0.0))));
  let lowRoom = 1.0 - smoothstep(0.1, 2.1, world.y);
  let bounceFactor = lowRoom * (facing * 0.85 + 0.15) / (1.0 + d2 * 0.65);
  return vec3f(0.016, 0.0085, 0.0025) * bounceFactor * OL.u1.z;
}

/**
 * Blog Game Tip #9: Fast Triplanar Nyquist-Filtered Grain & Wear on MAT.timber (24) & MAT.lit (0) Props/Cars.
 */
fn evalTriplanarPropMod(world: vec3f, n: vec3f) -> f32 {
  let freq = 6.5;
  let fade = 1.0 - smoothstep(0.10, 0.32, surfaceFootprint * freq);
  let uv = vec2f(world.x + world.z * 0.85, world.y * 1.6 + world.z * 0.35);
  let fibre = (surfaceNoise(uv * freq) - 0.5) * fade;
  return 1.0 + fibre * 0.12;
}

fn fastExpNeg(x: f32) -> f32 {
  let c = max(0.0, x);
  return 1.0 / (1.0 + c * (1.0 + c * (0.48 + c * 0.16)));
}

/**
 * Albedo-multiplying indirect bounce & localized bulb halation for sodium streetlamps and tungsten practicals,
 * plus Blog Game Tip #5 elongated window floor/driveway reflection sheen (openGlassSheen).
 */
fn applySceneLightBounceAndHaze(world: vec3f, n: vec3f, surfCol: vec3f, inRoom: bool, mat: i32) -> vec3f {
  if (mat == 2 || mat == 3 || mat == 6 || mat == 12 || world.y >= 2.72) { return surfCol; }
  let w = clamp(OL.u0.z, 0.0, 1.0);
  let wSpill = max(w, 0.62);
  var col = surfCol;
  let b = nearestHouseRect(world.xz);
  // Darkwood (OL.sight.y): outdoor pools only where a lamp is actually on, so daylight carries no warm wash or
  // practical colour, and no sourceless pool follows the survivor.
  let darkwood = clamp(OL.sight.y, 0.0, 1.0);
  let lampsOn = mix(1.0, clamp(1.38 - F.monitorBounds.w * 1.38, 0.0, 1.0), darkwood);
  if (!inRoom) {
    let isInView = OL.u5.w > 0.5;
    let groundMask = smoothstep(2.6, 0.35, world.y) * select(1.0, 0.32, mat == 22);
    var wetPuddle = 0.0;
    if (OL.u8.y > 0.01 && world.y < 0.35 && n.y > 0.75) {
      // Wet ground and standing water (AR-71, weather/puddles.ts) brighten lamp pools a little; darkening is done there.
      wetPuddle = OL.u8.y * 0.35 + outbreakPuddleMask(world.xz, true) * 0.65;
    }
    if (OL.u8.w > 0.01 && n.y > 0.45) {
      col = mix(col, vec3f(0.16, 0.20, 0.28) * (0.45 + 0.55 * F.ambient.w) + surfCol * 1.4, OL.u8.w * 0.55 * n.y);
    }
    if (groundMask <= 0.001) { return col; }
    let texAlbedo = surfCol * 1.48 + outbreakAlbedo * 0.21;
    // 1. High-pressure sodium streetlamp (2100K) albedo-multiplying ground pool + wet asphalt sheen. It sits at a fixed
    // spot by every house rather than under a real lamp, so Darkwood leaves the ground to the real street lamps.
    let sScale = OL.u1.w * lampsOn * (1.0 - darkwood);
    if (sScale > 0.20) {
      let sPos = select(vec2f(b.z + 4.2, b.w + 6.9), vec2f(b.z + 2.0, b.y + 1.0), isInView);
      let dvS = (world.xz - sPos) * select(vec2f(0.85, 0.90), vec2f(1.10, 0.44), isInView);
      let dS2 = dot(dvS, dvS);
      if (dS2 < 95.0) {
        let sodiumCol = vec3f(1.0, 0.45, 0.09);
        let poolS = fastExpNeg(dS2 * select(0.05, 0.035714, isInView)) * groundMask;
        let sMult = select(1.12, 2.75, isInView) * sScale;
        col += texAlbedo * (1.0 + wetPuddle * OL.u2.y * 1.15) * sodiumCol * poolS * sMult;
        outbreakPracticalIrr += poolS * sMult * 0.55;
      }
    }

    // 2. Warm 2500K tungsten window & porch bounce + elongated rectangular window sheen (openGlassSheen)
    let pScale = OL.u1.x * lampsOn;
    let wScale = OL.u1.y * lampsOn;
    if ((pScale > 0.001 || wScale > 0.001) && world.z > b.w - 1.3 && world.z < b.w + 14.5 && world.x > b.x - 5.5 && world.x < b.z + 3.5) {
      let vWL = (world.xz - vec2f(b.x + 2.5, b.w + 0.5)) * vec2f(0.72, 0.64);
      let vWR = (world.xz - vec2f(b.z - 2.75, b.w + 0.5)) * vec2f(0.72, 0.64);
      let vP = (world.xz - vec2f(b.x + 5.7, b.w + 0.9)) * vec2f(0.68, 0.52);
      let streetFade = select(1.0, 1.0 - smoothstep(b.w + 2.5, b.w + 5.7, world.z), !isInView);
      let cutZoneScale = select(1.02, select(1.18, 0.96, world.z > b.w + 2.5), isInView) * 1.14 * streetFade;
      let tightSpill = 1.85;
      let spill = ((fastExpNeg(dot(vWL, vWL) * 0.0689655 * tightSpill) + fastExpNeg(dot(vWR, vWR) * 0.0689655 * tightSpill)) * wScale * 0.88 + fastExpNeg(dot(vP, vP) * 0.064516 * tightSpill) * pScale * 0.92) * cutZoneScale * groundMask;
      col += texAlbedo * vec3f(1.05, 0.54, 0.12) * spill * wSpill * (1.0 + wetPuddle * OL.u2.y * 0.95);
      outbreakPracticalIrr += spill * wSpill * 0.75;
    }

    // 3. Warm golden-amber porch/lantern road pool around the survivor on the street — scaled by w*w so Noir street stays dark outside the flashlight
    if (!isInView && world.y < 0.45 && world.z > b.w + 4.4 && w > 0.15 && darkwood < 0.5) {
      let dp = (world.xz - vec2f(OL.u6.x, OL.u6.y + 0.85)) * vec2f(0.60, 0.76);
      let dp2 = dot(dp, dp);
      if (dp2 < 26.0) {
        let pPool = fastExpNeg(dp2 * 0.14) * 1.12;
        col += texAlbedo * vec3f(1.24, 0.62, 0.14) * pPool * (w * w) * (1.0 + wetPuddle * 0.65);
        outbreakPracticalIrr += pPool * (w * w) * 1.25;
      }
    }
  } else {
    let floorB = evalAreaFloorBounce(world, n, b);
    col += floorB * surfCol * 7.2;
    outbreakPracticalIrr += dot(floorB, vec3f(14.0, 9.0, 3.0));
    // Interior indirect room bounce & wall-wash halos (branchless quadrant selection relative to house b)
    let roomScale = OL.u1.z;
    if (roomScale > 0.001) {
      let warmTungsten = vec3f(1.06, 0.52, 0.10);
      let roomAlbedo = surfCol * 1.28 + outbreakAlbedo * 0.16;
      let isNorth = world.z < b.y + 5.6;
      let isWestN = world.x < b.x + 5.2;
      let isEastS = !isNorth && world.x > b.x + 8.6;
      let isWestS = !isNorth && !isEastS && world.x < b.x + 5.0;
      let cPos = select(
        select(select(vec2f(b.x + 6.2, b.w - 2.9), vec2f(b.x + 3.0, b.w - 2.7), isWestS), vec2f(b.z - 3.6, b.y + 6.2), isEastS),
        select(vec2f(b.x + 7.0, b.y + 2.2), vec2f(b.x + 3.1, b.y + 1.4), isWestN),
        isNorth
      );
      let cScale = select(
        select(select(vec2f(0.66, 0.56), vec2f(0.62, 0.62), isWestS), vec2f(0.66, 0.76), isEastS),
        select(vec2f(0.70, 0.76), vec2f(0.66, 0.74), isWestN),
        isNorth
      );
      let baseInvDenom = select(
        select(select(1.0 / 4.5, 1.0 / 5.2, isWestS), 1.0 / 5.2, isEastS),
        1.0 / 4.8,
        isNorth
      );
      let invDenom = baseInvDenom * 1.15;
      let v0 = (world.xz - cPos) * cScale;
      var pool = fastExpNeg(dot(v0, v0) * invDenom);
      let isVertWall = abs(n.y) < 0.45;
      if (isNorth) {
        pool *= select(select(0.62, 1.25, isVertWall && world.z < b.y + 2.2), select(0.55, 1.35, isVertWall && world.z < b.y + 2.8), isWestN);
      } else if (isEastS) {
        let vDin = (world.xz - vec2f(b.z - 3.2, b.w - 2.7)) * vec2f(0.58, 0.62);
        pool = pool * select(0.75, 1.55, isVertWall && world.z < b.y + 6.4 && world.y > 0.85) + fastExpNeg(dot(vDin, vDin) * (1.0 / 4.2)) * 0.96;
      }
      let aScale = select(select(select(1.08, 1.36, isWestS), 1.72, isEastS), select(0.16, 1.24, isWestN), isNorth);
      let bias = select(
        select(select(vec3f(0.005, 0.0020, 0.0003), vec3f(0.014, 0.0056, 0.0009), isWestS), vec3f(0.022, 0.0088, 0.0014), isEastS),
        select(vec3f(0.0), vec3f(0.011, 0.0042, 0.0006), isWestN),
        isNorth
      ) * pool * 0.65;
      let baseTerm = select(roomAlbedo * aScale, surfCol * 1.25, isNorth && isWestN);
      col += (baseTerm + bias) * warmTungsten * (pool * roomScale);
      outbreakPracticalIrr += pool * roomScale * aScale * 0.48;
    }
  }
  return col;
}

/** Radiant intensity of the lens relative to the other lights, so beam intensity 1 reads as a strong torch. */
const FLASH_RADIANCE: f32 = 9.0;

/** Beam intensity at angle acos(cosT) off the axis: soft cone, hot core, reflector rings and a wide dim spill. */
fn flashProfile(cosT: f32) -> f32 {
  let omc = max(0.0, 1.0 - clamp(cosT, -1.0, 1.0));
  let t = sqrt(2.0 * omc) * (1.0 + 0.083333 * omc) * OL.u17.y;
  let tight = clamp(OL.beamLook.y, 0.0, 2.0);
  let tightShare = clamp(tight, 0.0, 1.0);
  let effInner = mix(OL.u11.z, min(OL.u11.z, 0.38), tightShare);
  let legacyCone = 1.0 - smoothstep(effInner, 1.0, t);
  let tightCone = (1.0 - smoothstep(0.22, 0.78, t)) * 0.30;
  let cone = mix(legacyCone, tightCone, tightShare);
  let effCoreW = mix(max(OL.u12.x, 0.05), min(max(OL.u12.x, 0.05), 0.30), tightShare) / max(1.0, tight);
  let dark = (t - effCoreW * 1.35) * 9.0;
  let bright = (t - mix(0.84, 0.56, tightShare)) * 12.5;
  let bBell = 1.0 / (1.0 + bright * bright * (1.0 + 0.35 * bright * bright));
  let dBell = 1.0 / (1.0 + dark * dark * (1.0 + 0.35 * dark * dark));
  let rings = 1.0 + OL.u12.w * mix(1.0, 0.35, tightShare) * (0.2 * bBell - 0.18 * dBell);
  let tc = t / max(effCoreW, 0.04);
  let ts = t / max(OL.u12.z, 1.0);
  let tc2 = tc * tc;
  let ts2 = ts * ts;
  let core = 1.0 / (1.0 + tc2 * (1.0 + 0.48 * tc2));
  let spillWindow = mix(1.0, 1.0 - smoothstep(0.60, 1.15, t), tightShare);
  let spill = (1.0 / (1.0 + ts2 * (1.0 + 0.48 * ts2))) * spillWindow;
  let effCoreAmp = mix(OL.u11.w, max(OL.u11.w, 2.15), tightShare) * mix(1.0, 1.18, clamp(tight - 1.0, 0.0, 1.0));
  let effSpillAmp = mix(OL.u12.y, min(OL.u12.y, 0.038), tightShare);
  return cone * rings + effCoreAmp * core + effSpillAmp * spill;
}

/** Attenuation of the local flashlight (cone.w 2) for lightSum; toLight points from the surface to the lens. */
fn flashAttenuation(toLight: vec3f, d3: f32, power: f32) -> f32 {
  let cosT3D = -dot(toLight, vec3f(OL.u3.z * OL.u13.y, OL.u13.x, OL.u3.w * OL.u13.y));
  if (cosT3D <= OL.u16.z) { return 0.0; }
  let tightShare = clamp(OL.beamLook.y, 0.0, 1.0);
  let planLen = inverseSqrt(max(dot(toLight.xz, toLight.xz), 1e-6));
  let cosPlan = -dot(toLight.xz * planLen, OL.u3.zw);
  // In v7, tighten lateral plan angle while keeping vertical pitch forgiving between hand and ground pool center
  let cosT = mix(cosT3D, mix(cosPlan, cosT3D, 0.24), tightShare * step(0.0, cosPlan));
  let nearReach = mix(1.0, smoothstep(0.35, 1.35, d3), tightShare);
  return power * FLASH_RADIANCE * flashProfile(cosT) * flashFalloff(d3 * d3) * nearReach;
}

/** Inverse-square falloff softened inside the near-lens radius and windowed smoothly to zero at the beam range. */
fn flashFalloff(d2: f32) -> f32 {
  let r = max(OL.u4.y, 1.0);
  let x2 = d2 / (r * r);
  let tight = clamp(OL.beamLook.y, 0.0, 2.0);
  let tightShare = clamp(tight, 0.0, 1.0);
  let soft = mix(max(OL.u13.z, 0.1), min(max(OL.u13.z, 0.1), 1.65), tightShare);
  if (OL.rampOn.x > 0.5) { return select(0.0, outbreakRamp(0u, sqrt(x2)), x2 < 1.0) / (1.0 + d2 / (soft * soft)); }
  let win = clamp(1.0 - x2 * x2, 0.0, 1.0);
  let tightWin = pow(clamp(1.0 - x2, 0.0, 1.0), 2.35);
  return mix(win * win, tightWin, tightShare) / (1.0 + d2 / (soft * soft));
}

/**
 * Flashlight light the lights loop doesn't give. Direct light comes from lightSum through flashAttenuation (cone.w 2),
 * which leaves the received irradiance in outbreakFlashIrr. Air scatter is the closed form of looking straight down
 * through the cone: the chord through the beam grows with distance while intensity falls with its square, so the glow
 * fades like 1 / distance from the lens, shaped by the plan cone and stopped at the first wall along the aim. The
 * bounce is one warm diffuse fill from where the axis lands (the caller multiplies by live sight, which keeps both out
 * of unseen rooms). Leaves the received flashlight irradiance in outbreakFlashMask.
 */
fn evalFlashlight(world: vec3f, n: vec3f) -> vec3f {
  var irr = outbreakFlashIrr;
  var add = vec3f(0.0);
  let air = OL.u14.w * OL.u2.x * OL.u4.z;
  let rel = world.xz - OL.u3.xy;
  let along = dot(rel, OL.u3.zw);
  if (air > 0.001 && along > 0.0 && along < OL.u16.w) {
    let c = along * inverseSqrt(max(dot(rel, rel), 1e-6));
    let cone = smoothstep(mix(OL.u11.y, 1.0, 0.1), mix(OL.u11.y, 1.0, 0.75), c);
    let core = smoothstep(mix(OL.u11.y, 1.0, 0.7), 1.0, c);
    let fade = smoothstep(0.05, 0.45, along) * (1.0 - smoothstep(OL.u16.w - 0.8, OL.u16.w, along)) * clamp(1.0 - along / OL.u4.y, 0.0, 1.0);
    add += vec3f(air * (cone + OL.u11.w * core * core) * fade / (1.0 + along * 1.4) * 0.5);
  }
  let bPow = OL.u14.z * FLASH_RADIANCE;
  let toB = vec3f(OL.u14.x, OL.u17.x, OL.u14.y) - world;
  let db2 = dot(toB, toB);
  if (bPow > 0.001 && db2 < 36.0 && world.y < 2.78) {
    // A diffuse source at the pool: surfaces facing it catch the fill, the ground around it barely does.
    let face = max(0.0, dot(n, toB * inverseSqrt(max(db2, 1e-4))));
    var eb = bPow * face * (1.0 - db2 / 36.0) / (1.0 + db2 * 0.3) * 0.5;
    // Only on the lens side of the first wall, closed door or closed window: one tap of the flashlight's polar row.
    if (OL.u4.w > 0.5) {
      let lr = world.xz - OL.u3.xy;
      let ray = u32(i32(round((atan2(lr.y, lr.x) / TAU + 1.0) * f32(RAYS) - 0.5))) % RAYS;
      let full = polar[(u32(round(OL.u4.w)) * RAYS + ray) * 2u].x;
      eb *= 1.0 - smoothstep(full + 0.06, full + 0.18, length(lr));
    }
    let bWarm = clamp(OL.beamLook.x, 0.0, 1.0);
    let bounceWarmCol = mix(vec3f(1.02, 0.95, 0.84), vec3f(1.16, 0.80, 0.42), bWarm);
    let bTightScale = mix(1.0, 0.48, clamp(OL.beamLook.y, 0.0, 1.0));
    add += outbreakAlbedo * bounceWarmCol * (eb * bTightScale * GAIN);
    irr += eb * bTightScale;
  }
  outbreakFlashMask = irr;
  let warmTint = mix(vec3f(1.0, 0.98, 0.94), vec3f(1.08, 0.92, 0.68), clamp(OL.beamLook.x, 0.0, 1.0));
  return add * OL.u5.rgb * warmTint;
}

/** How strongly the light-colour rule holds: the toggle, faded in with darkness (\`lightRuleWeight\` in look/world.ts). */
fn outbreakLightRule() -> f32 {
  let x = clamp((0.8 - F.monitorBounds.w) / 0.6, 0.0, 1.0);
  return OL.colour.x * x * x * (3.0 - 2.0 * x);
}

/** Baked lamp bounce at a plan point; also leaves its luminance for the colour mask. */
fn outbreakBounce(p: vec2f, scale: f32) -> vec3f {
  let b = bounceAt(p) * scale;
  outbreakBounceIrr = dot(b, vec3f(0.2126, 0.7152, 0.0722));
  return b;
}

/**
 * Selective-colour mask from received flashlight, practical light (every light in the lights loop: lamps, sconces,
 * windows, headlights, muzzle flash) and, under the light rule, baked lamp bounce and bounced light (\`outbreakGiIrr\`),
 * through a soft exponential knee.
 */
fn outbreakColorMask(flashIrr: f32) -> f32 {
  let e = flashIrr + outbreakPracticalIrr * OL.u16.y + (outbreakBounceIrr * OL.colour.z + outbreakGiIrr) * outbreakLightRule();
  return 1.0 - fastExpNeg(e / max(OL.u13.w, 0.01));
}

/**
 * Analytic sodium air cone under the streetlamp lens, integrated along the camera ray to the shaded surface (no extra
 * pass). The cone uses six midpoint samples on the ray segment clipped to the lamp's height slab, gated by the ray's
 * horizontal closest approach to the pole axis; the lens and its halo use the closed-form Gaussian line integral at
 * the ray's closest approach, faded where the surface occludes the far half.
 */
fn gaussLineAir(ro: vec3f, rd: vec3f, tMax: f32, c: vec3f, sigma: f32, slack: f32) -> f32 {
  let tc = dot(c - ro, rd);
  let d = length(ro + rd * tc - c);
  let shown = clamp(0.5 + (tMax - tc + slack) / (sigma * 1.8), 0.0, 1.0);
  return sigma * exp(-d * d / (sigma * sigma)) * shown;
}

fn evalLampAir(world: vec3f, inView: bool) -> vec3f {
  let nightLamps = clamp(1.0 - F.monitorBounds.w * 1.4, 0.0, 1.0);
  if (nightLamps <= 0.001) { return vec3f(0.0); }
  let dLampXZ = world.xz - OL.u7.xz;
  if (dot(dLampXZ, dLampXZ) > 48.0) { return vec3f(0.0); }
  let ro = F.cam.xyz;
  let seg = world - ro;
  let tMax = length(seg);
  let rd = seg / tMax;
  var out = vec3f(0.0);
  let haze = OL.u7.w * OL.u1.w * select(1.0, 0.6, inView);
  if (haze > 0.001) {
    let head = OL.u7.xyz;
    let k = 0.58;
    // Lens street lamps (street-lamps/): the air lit by the designed pool's beam, the glow along the lens, not a dot.
    let lensOn = OL.street1.x > 0.5;
    let arm = OL.street2.xy;
    let la = OL.street2.z;
    let lb = OL.street2.w;
    var air = 0.0;
    if (rd.y < -1e-4) {
      let t0 = max(0.0, (head.y - 0.04 - ro.y) / rd.y);
      let t1 = min(tMax, -ro.y / rd.y);
      if (t1 > t0) {
        let oxz = ro.xz - head.xz;
        let tAx = clamp(-dot(oxz, rd.xz) / max(dot(rd.xz, rd.xz), 1e-6), t0, t1);
        if (length(oxz + rd.xz * tAx) < k * head.y * select(1.2, 2.2, lensOn) + 0.5) {
          let dt = (t1 - t0) / 6.0;
          for (var i = 0; i < 6; i++) {
            let p = ro + rd * (t0 + (f32(i) + 0.5) * dt);
            let depth = head.y - p.y;
            let r2 = dot(p.xz - head.xz, p.xz - head.xz);
            if (lensOn) {
              let d2 = r2 + depth * depth;
              let dir = (p - head) * inverseSqrt(max(d2, 1e-4));
              air += streetProfile(dir, arm, OL.street0, OL.street1.y) * (depth * depth + lb * lb) / (d2 + lb * lb) / (1.0 + depth * 0.55);
            } else {
              let coneR = 0.2 + k * depth;
              air += exp(-2.0 * r2 / (coneR * coneR)) / (1.0 + depth * 0.55);
            }
          }
          air *= dt * select(1.0, OL.street1.z, lensOn);
        }
      }
    }
    var lens = gaussLineAir(ro, rd, tMax, head - vec3f(0.0, 0.05, 0.0), 0.22, 0.3);
    if (lensOn) {
      let ax = vec3f(arm.x, 0.0, arm.y) * la * 0.7;
      let sig = max(0.12, lb * 1.4);
      lens = (gaussLineAir(ro, rd, tMax, head - ax, sig, 0.3) + gaussLineAir(ro, rd, tMax, head, sig, 0.3) + gaussLineAir(ro, rd, tMax, head + ax, sig, 0.3)) * (0.22 / sig) / 3.0;
    }
    let halo = gaussLineAir(ro, rd, tMax, head - vec3f(0.0, 0.25, 0.0), 0.7, 0.0);
    out += vec3f(1.0, 0.42, 0.08) * (air * 0.03 + lens * 3.0 + halo * 0.03) * haze;
  }
  return out * nightLamps;
}

/**
 * Analytic soft capsule shadow cast by the survivor and the two nearest zombies away from the streetlamp lens on outdoor
 * ground, plus a tight boot-contact occlusion under each actor. Shadow length follows the lamp's height over the actor,
 * the penumbra widens toward the tip, and the darkening fades with distance from the lamp.
 */
fn actorShadowTerm(g: vec2f, feet: vec2f, lamp: vec3f, actorH: f32, directional: f32) -> f32 {
  let rel = g - feet;
  let contact = exp(-dot(rel, rel) / 0.035);
  let away = feet - lamp.xz;
  let dh = length(away);
  let sunAmt = clamp(F.monitorBounds.w, 0.0, 1.0);
  let lampDir = away / max(dh, 1e-3);
  let sunHoriz = -F.monitorBounds.xz;
  let sunDir = sunHoriz / max(length(sunHoriz), 1e-3);
  let dir = normalize(mix(lampDir, sunDir, sunAmt));
  let lampReach = clamp(actorH * dh / max(lamp.y - actorH, 0.5), 0.6, 2.6);
  let sunReach = clamp(actorH * length(sunHoriz) / max(F.monitorBounds.y, 0.22), 0.55, 2.85);
  let reach = mix(lampReach, sunReach, sunAmt);
  let t = clamp(dot(rel, dir) / reach, 0.0, 1.0);
  let dist = length(rel - dir * (t * reach));
  let radius = 0.17 + 0.22 * t;
  let casterStrength = mix(1.0 - smoothstep(8.0, 16.0, dh), 0.72, sunAmt) * directional;
  let shadow = (1.0 - smoothstep(radius * 0.55, radius * 1.25, dist)) * (1.0 - 0.55 * t) * step(-0.25, dot(rel, dir)) * casterStrength;
  return max(shadow * 0.72, contact * 0.48);
}

fn evalActorGroundShadow(world: vec3f, n: vec3f, inRoom: bool) -> f32 {
  let k = OL.u8.x;
  if (k <= 0.001 || n.y < 0.6 || world.y > OL.u6.z + 0.35) { return 1.0; }
  let g = world.xz;
  let p = OL.u6.xy;
  let z0 = OL.u9.xy;
  let z1 = OL.u9.zw;
  let near = min(dot(g - p, g - p), min(dot(g - z0, g - z0), dot(g - z1, g - z1)));
  if (near > 9.0) { return 1.0; }
  // Outdoors the sodium lens is the dominant caster; indoors only the boot contact remains.
  let lamp = OL.u7.xyz;
  let directional = select(1.0, 0.0, inRoom || OL.u5.w > 0.5);
  let occ = max(actorShadowTerm(g, p, lamp, 1.72, directional), max(actorShadowTerm(g, z0, lamp, 1.68, directional), actorShadowTerm(g, z1, lamp, 1.68, directional)));
  return 1.0 - occ * k;
}
`
