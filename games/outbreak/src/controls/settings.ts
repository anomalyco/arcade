import type { LabControl } from "@arcade/kit/lab-panel"

/**
 * Crouch on physical `KeyZ`, beside left Shift under the same little finger (default). Playtest Oct 21: "I always
 * accidentally end up hitting Ctrl W in these games, I'm trying to crouch and move forward" (1:19:28, after "I just
 * closed my game", 1:18:32); Ctrl+W closes the tab before the page sees it.
 */
export const CROUCH_Z = 0
/** Today: hold Ctrl (left or right). */
export const CROUCH_CTRL = 1

/** The map on `KeyM`, the genre's key (default; `KeyN` still opens it). Playtest Oct 21: "the map doesn't pop up if I press it. It mutes" (1:43:52). */
export const MAP_ON_M = 0
/** Today: the map on `KeyN` and `KeyM` mutes. */
export const MAP_ON_N = 1

export const DEFAULT_CONTROL_SETTINGS = {
  crouchKey: CROUCH_Z,
  mapKey: MAP_ON_M,
  /** During a night (a co-op room, or a solo run past its first half minute) the browser asks before the tab closes. */
  askBeforeClose: true,
}

export type ControlSettings = typeof DEFAULT_CONTROL_SETTINGS

/** Physical codes that crouch while held. */
export function crouchCodes(s: Pick<ControlSettings, "crouchKey">): readonly string[] {
  return s.crouchKey === CROUCH_CTRL ? ["ControlLeft", "ControlRight"] : ["KeyZ"]
}

/** Physical codes that open and close the map; the first is the one prompts show. */
export function mapCodes(s: Pick<ControlSettings, "mapKey">): readonly string[] {
  return s.mapKey === MAP_ON_N ? ["KeyN"] : ["KeyM", "KeyN"]
}

/** Whether `KeyM` mutes (Today's binding); otherwise mute is on the speaker button (top right). */
export function muteOnM(s: Pick<ControlSettings, "mapKey">): boolean {
  return s.mapKey === MAP_ON_N
}

export const controlKeyControls: LabControl[] = [
  {
    key: "crouchKey",
    label: "Crouch key",
    group: "Controls",
    options: [
      { label: "Hold Z", value: CROUCH_Z },
      { label: "Today (hold Ctrl)", value: CROUCH_CTRL },
    ],
  },
  {
    key: "mapKey",
    label: "Map key",
    group: "Controls",
    options: [
      { label: "M (mute on the speaker button)", value: MAP_ON_M },
      { label: "Today (N; M mutes)", value: MAP_ON_N },
    ],
  },
  { key: "askBeforeClose", label: "Ask before closing the tab mid-night", group: "Controls" },
]
