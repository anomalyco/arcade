import { DEFAULT_PROP_LOOK } from "@arcade/kit/props/mesh"

/** Lab settings for the generated furniture and props (`@arcade/kit/props`) in Outbreak's houses. */
export type OutbreakPropSettings = {
  /** Furnish the start block's houses with the prop library instead of box furniture (off restores the boxes). */
  propsOn: boolean
  /** Wall, corner and tabletop clutter: 0 none, 1 default, 2 crowded (scaled down on lower quality tiers). */
  propClutter: number
  /** Reroll the clutter (anchors stay where the gameplay furniture is). */
  propSeed: number
  /** Camera height (zoom, m) above which props draw their far LOD. */
  propLodZoom: number
  propBrightness: number
  propAO: number
  propSaturation: number
}

export const DEFAULT_PROP_SETTINGS: OutbreakPropSettings = {
  propsOn: true,
  propClutter: 1,
  propSeed: 0,
  propLodZoom: 34,
  propBrightness: DEFAULT_PROP_LOOK.brightness,
  propAO: DEFAULT_PROP_LOOK.ao,
  propSaturation: 1,
}

/** Zoom band (± m around `propLodZoom`) inside which props keep their current LOD, so small zoom changes never flip it. */
export const PROP_LOD_HYSTERESIS = 2.5
