import type { LabControl } from "@arcade/kit/lab-panel"
import {
  CALLOUTS_ABOVE,
  CALLOUTS_BELOW,
  CALLOUTS_BESIDE,
  CALLOUTS_STYLE,
  VITALS_BARS,
  VITALS_BESIDE,
  VITALS_EDGE,
  VITALS_FEET,
  VITALS_GROUND,
  VITALS_ICONS,
  VITALS_STYLE,
} from "./placement"
import { STYLE_BELOW, STYLES } from "./styles"

export const HUD_MODE_CALLOUTS = 0
export const HUD_MODE_LOG = 1

export const TEAMMATE_IMPORTANT = 0
export const TEAMMATE_ALL = 1
export const TEAMMATE_OFF = 2

export const RING_RING = 0
export const RING_WHEEL = 1
export const RING_ARC = 2

export const DEFAULT_HUD_SETTINGS = {
  /** 0 = callouts on the survivor, 1 = the old bottom-left status log. */
  hudMode: HUD_MODE_CALLOUTS,
  /** The HUD direction: Today, Below Feet, Hades Style, Zomboid Style or Diegetic (see styles.ts). */
  hudStyle: STYLE_BELOW,
  /** Which side of the survivor callouts prefer (-1 = the style's); they swap sides when the survivor aims into them. */
  calloutPlacement: CALLOUTS_STYLE,
  /** Callout font size in CSS pixels. */
  calloutSize: 12,
  /** Screen gap between the survivor's body and the nearest callout, in CSS pixels. */
  calloutOffset: 6,
  /** Multiplies how long result, warning and info callouts stay up. */
  calloutDuration: 1,
  /** Most callouts stacked on one actor at once. */
  calloutMax: 3,
  /** Callouts and rings move to the opposite side when the survivor aims into them, keeping the beam clear. */
  avoidAim: true,
  /** How stamina, reload, health and battery are drawn (-1 = the style's). */
  vitalsPlacement: VITALS_STYLE,
  /** Ring shape: 0 ring, 1 wheel (filled, like Breath of the Wild), 2 open arc. */
  ringStyle: RING_RING,
  /** Show health on the character after a hit and while low. */
  healthOnCharacter: true,
  /** Ring diameter in CSS pixels. */
  vitalSize: 20,
  /** Screen gap between the survivor's body and the nearest ring, in CSS pixels. */
  vitalOffset: 6,
  /** Stamina fraction below which the ring turns amber. */
  staminaLow: 0.3,
  /** Health at or below which the health ring stays up and turns red. */
  healthLow: 35,
  /** Which other survivors' callouts to show in co-op. */
  teammateCallouts: TEAMMATE_IMPORTANT,
  /** Size of other survivors' callouts and rings relative to yours. */
  teammateScale: 0.8,
}

export type HudSettings = typeof DEFAULT_HUD_SETTINGS

export const hudControls: LabControl[] = [
  {
    key: "hudMode",
    label: "Action feedback",
    group: "HUD",
    options: [
      { label: "On the survivor", value: HUD_MODE_CALLOUTS },
      { label: "Bottom-left log", value: HUD_MODE_LOG },
    ],
  },
  {
    key: "hudStyle",
    label: "HUD style",
    group: "HUD",
    options: Object.entries(STYLES).map(([value, s]) => ({ label: s.label, value: Number(value) })),
  },
  {
    key: "calloutPlacement",
    label: "Callout placement",
    group: "HUD",
    options: [
      { label: "Style default", value: CALLOUTS_STYLE },
      { label: "Below survivor", value: CALLOUTS_BELOW },
      { label: "Above survivor", value: CALLOUTS_ABOVE },
      { label: "Beside survivor", value: CALLOUTS_BESIDE },
    ],
  },
  { key: "calloutSize", label: "Callout size", group: "HUD", min: 9, max: 20, step: 0.5, unit: "px" },
  { key: "calloutOffset", label: "Callout gap", group: "HUD", min: 0, max: 60, step: 1, unit: "px" },
  { key: "calloutDuration", label: "Callout duration", group: "HUD", min: 0.5, max: 3, step: 0.1, unit: "×" },
  { key: "calloutMax", label: "Max stacked", group: "HUD", min: 1, max: 4, step: 1, unit: "" },
  { key: "avoidAim", label: "Keep clear of aim", group: "HUD" },
  {
    key: "vitalsPlacement",
    label: "Stamina & status",
    group: "HUD",
    options: [
      { label: "Style default", value: VITALS_STYLE },
      { label: "Rings beside survivor", value: VITALS_BESIDE },
      { label: "Rings under feet", value: VITALS_FEET },
      { label: "Bars under feet", value: VITALS_BARS },
      { label: "Ring on the ground", value: VITALS_GROUND },
      { label: "Status icons at edge", value: VITALS_ICONS },
      { label: "Bars at screen edge", value: VITALS_EDGE },
    ],
  },
  {
    key: "ringStyle",
    label: "Ring shape",
    group: "HUD",
    options: [
      { label: "Ring", value: RING_RING },
      { label: "Wheel", value: RING_WHEEL },
      { label: "Arc", value: RING_ARC },
    ],
  },
  { key: "healthOnCharacter", label: "Health on character", group: "HUD" },
  { key: "vitalSize", label: "Ring size", group: "HUD", min: 12, max: 36, step: 1, unit: "px" },
  { key: "vitalOffset", label: "Ring gap", group: "HUD", min: 0, max: 40, step: 1, unit: "px" },
  { key: "staminaLow", label: "Stamina low at", group: "HUD", min: 0.1, max: 0.6, step: 0.05, unit: "" },
  { key: "healthLow", label: "Health low at", group: "HUD", min: 10, max: 60, step: 5, unit: "HP" },
  {
    key: "teammateCallouts",
    label: "Teammate callouts",
    group: "HUD",
    options: [
      { label: "Important only", value: TEAMMATE_IMPORTANT },
      { label: "All", value: TEAMMATE_ALL },
      { label: "Off", value: TEAMMATE_OFF },
    ],
  },
  { key: "teammateScale", label: "Teammate HUD size", group: "HUD", min: 0.5, max: 1, step: 0.05, unit: "×" },
]
