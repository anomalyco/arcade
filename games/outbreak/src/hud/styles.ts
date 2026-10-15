/**
 * HUD styles: whole directions for the character HUD, each a set of structural choices. The Lab's "HUD style" picks
 * one; Callout placement and Stamina & status can override its placements ("Style default" keeps the style's).
 */
import {
  CALLOUTS_ABOVE,
  CALLOUTS_BESIDE,
  CALLOUTS_STYLE,
  VITALS_BARS,
  VITALS_BESIDE,
  VITALS_EDGE,
  VITALS_FEET,
  VITALS_GROUND,
  VITALS_ICONS,
  VITALS_STYLE,
  type Side,
} from "./placement"

export const STYLE_TODAY = 0
export const STYLE_BELOW = 1
export const STYLE_HADES = 2
export const STYLE_ZOMBOID = 3
export const STYLE_DIEGETIC = 4

/** `box` labels have a dark plate; `halo` is outlined text only, like Project Zomboid's halo notes. */
export type CalloutLook = "box" | "halo"
/** `full` keeps the time summary and hotbar; `quiet` hides the summary and dims the hotbar; `none` shows the hotbar only briefly after a change. */
export type Chrome = "full" | "quiet" | "none"

export type StyleSpec = {
  label: string
  callouts: Side
  look: CalloutLook
  /** Actions in progress draw as a bar over the head instead of a ringed label. */
  actionBar: boolean
  vitals: number
  chrome: Chrome
  /** Hide informational callouts (flashlight, slot, door) and keep progress, results, warnings and damage. */
  quiet: boolean
  /** Swap sides when the survivor aims into the HUD. Today predates it; Zomboid keeps its bar over the head. */
  avoid: boolean
}

export const STYLES: Record<number, StyleSpec> = {
  [STYLE_TODAY]: { label: "Today", callouts: "up", look: "box", actionBar: false, vitals: VITALS_EDGE, chrome: "full", quiet: false, avoid: false },
  [STYLE_BELOW]: { label: "Below Feet", callouts: "down", look: "box", actionBar: false, vitals: VITALS_BESIDE, chrome: "full", quiet: false, avoid: true },
  [STYLE_HADES]: { label: "Hades Style", callouts: "down", look: "box", actionBar: false, vitals: VITALS_BARS, chrome: "quiet", quiet: false, avoid: true },
  [STYLE_ZOMBOID]: { label: "Zomboid Style", callouts: "up", look: "halo", actionBar: true, vitals: VITALS_ICONS, chrome: "full", quiet: false, avoid: false },
  [STYLE_DIEGETIC]: { label: "Diegetic", callouts: "down", look: "halo", actionBar: false, vitals: VITALS_GROUND, chrome: "none", quiet: true, avoid: true },
}

export type ResolvedStyle = StyleSpec & { id: number }

const PLACEMENT_SIDE: Record<number, Side> = { [CALLOUTS_ABOVE]: "up", [CALLOUTS_BESIDE]: "left" }

export function resolveStyle(s: { hudStyle: number; calloutPlacement: number; vitalsPlacement: number; avoidAim: boolean }): ResolvedStyle {
  const spec = STYLES[s.hudStyle] ?? STYLES[STYLE_BELOW]!
  const callouts = s.calloutPlacement === CALLOUTS_STYLE ? spec.callouts : (PLACEMENT_SIDE[s.calloutPlacement] ?? "down")
  const vitals = s.vitalsPlacement === VITALS_STYLE ? spec.vitals : s.vitalsPlacement
  return { ...spec, id: s.hudStyle in STYLES ? s.hudStyle : STYLE_BELOW, callouts, vitals, avoid: spec.avoid && s.avoidAim }
}

/** Whether a vitals mode draws on the character (as opposed to the screen edge or the status icons). */
export const onCharacter = (vitals: number) =>
  vitals === VITALS_BESIDE || vitals === VITALS_FEET || vitals === VITALS_BARS || vitals === VITALS_GROUND
