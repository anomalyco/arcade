import type { LabControl } from "@arcade/kit/lab-panel"
import { OBJECTIVE_DEFAULTS, OBJECTIVE_RANGES, type ObjectiveRules } from "../../shared/objective"
import type { DevSection } from "../dev/dev-panel"
import { ZONE_LOOK, ZONE_LOOK_DEFAULTS } from "./zone-pass"
import { ZONE_RULES } from "./zones"

const range = (key: keyof ObjectiveRules, label: string, step: number, unit: string): LabControl => {
  const [min, max] = OBJECTIVE_RANGES[key]
  return { key, label, group: "Rules (APPLY restarts the round)", min, max, step, unit }
}

/** Rules: structural, they reach the game only through APPLY TO ROOM (the room restarts its round with them). */
const RULE_CONTROLS: LabControl[] = [
  range("radius", "Zone radius", 10, "m"),
  range("cycle", "Relocate every", 5, "s"),
  range("warning", "Next spot shown", 1, "s"),
  range("capture", "Capture time", 0.5, "s"),
  range("rate", "Points while holding", 0.5, "/s"),
  range("target", "Points to win", 10, ""),
  range("intermission", "Result shown", 1, "s"),
  range("twoZonesAt", "Two zones from (ships)", 1, ""),
]

/** Look: live uniforms, read every frame. */
const LOOK_CONTROLS: LabControl[] = [
  { key: "band", label: "Boundary width", group: "Look", min: 4, max: 60, step: 1, unit: "m" },
  { key: "ring", label: "Boundary glow", group: "Look", min: 0, max: 12, step: 0.1, unit: "×" },
  { key: "fill", label: "Water tint", group: "Look", min: 0, max: 0.4, step: 0.01, unit: "" },
  { key: "wallHeight", label: "Curtain height", group: "Look", min: 0, max: 800, step: 10, unit: "m" },
  { key: "wall", label: "Curtain glow", group: "Look", min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "spin", label: "Dash turn rate", group: "Look", min: 0, max: 30, step: 0.5, unit: "°/s" },
]

/**
 * ZONES: the objective's rules (shared/objective.ts) and the zones' look (src/objective/zone-pass.ts) on the dev panel's
 * Game tab, with their approved defaults and Reset. APPLY TO ROOM sends the rules to the room (dev rooms only) or
 * restarts the offline objective with them.
 */
export function zonesSection(apply: () => void): DevSection {
  const group = RULE_CONTROLS[0]!.group!
  return {
    id: "zones",
    tab: "Game",
    bind: (panel) => {
      panel.addControls(ZONE_RULES, [...RULE_CONTROLS, { key: "zones-apply", label: "Room", group, type: "buttons", items: [{ key: "zones-apply-now", label: "Apply to room", run: apply }] }], OBJECTIVE_DEFAULTS)
      panel.addControls(ZONE_LOOK, LOOK_CONTROLS, ZONE_LOOK_DEFAULTS)
    },
  }
}
