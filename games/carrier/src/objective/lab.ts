import { LabPanel } from "@arcade/kit/lab-panel"
import type { LabControl } from "@arcade/kit/lab-navigation"
import { OBJECTIVE_DEFAULTS, OBJECTIVE_RANGES, type ObjectiveRules } from "../../shared/objective"
import type { DebugTab } from "../dev/debug-menu"
import { ZONE_LOOK, ZONE_LOOK_DEFAULTS } from "./zone-pass"
import { ZONE_RULES } from "./zones"

/** Stylesheets the shared panel (and knobs, which draws it) put in the document head; the debug menu is a shadow root. */
const PANEL_STYLES = "style[data-knobs-style], style[data-lab-knobs], style[data-knobs-preset], style[data-lab-panel-css]"

const range = (key: keyof ObjectiveRules, label: string, step: number, unit: string): LabControl => {
  const [min, max] = OBJECTIVE_RANGES[key]
  return { key, label, group: "Rules (APPLY restarts the round)", min, max, step, unit }
}

/** Rules: structural, they reach the game only through APPLY TO ROOM (the room restarts its round with them). */
const RULE_CONTROLS: LabControl[] = [
  range("radius", "Zone radius", 10, "m"),
  range("cycle", "Relocate every", 5, "s"),
  range("opening", "First zones last", 5, "s"),
  range("warning", "Next spot shown", 1, "s"),
  range("drift", "Drift speed", 0.5, "m/s"),
  range("turn", "Drift turn", 0.05, "°/s"),
  range("capture", "Capture time", 0.5, "s"),
  range("rate", "Points while holding", 0.5, "/s"),
  range("target", "Points to win", 10, ""),
  range("roundTime", "Round time limit", 30, "s"),
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
 * ZONES tab: the objective's rules (shared/objective.ts) and the zones' look (src/objective/zone-pass.ts) on the shared
 * Lab panel, with their approved defaults and Reset. APPLY TO ROOM sends the rules to the room (dev rooms only) or
 * restarts the offline objective with them.
 */
export class ZonesLab {
  private panel: LabPanel | null = null

  constructor(private opts: { close: () => void; release: () => void; apply: () => void }) {}

  readonly tab: DebugTab = {
    id: "zones",
    label: "Zones",
    mount: (el) => {
      el.replaceChildren()
      const panel = new LabPanel({}, [], new URLSearchParams(), this.opts.release, {
        layout: "inspector",
        capture: "focus",
        open: true,
        presets: false,
        groupActions: false,
        pill: false,
        variants: "carrier-zones",
        onToggle: (visible) => {
          if (!visible) this.opts.close()
        },
      })
      panel.addControls(ZONE_RULES, [...RULE_CONTROLS, { key: "apply", label: "APPLY TO ROOM", group: "Rules (APPLY restarts the round)", type: "action", run: () => this.opts.apply() }], OBJECTIVE_DEFAULTS)
      panel.addControls(ZONE_LOOK, LOOK_CONTROLS, ZONE_LOOK_DEFAULTS)
      for (const s of document.head.querySelectorAll(PANEL_STYLES)) el.append(s.cloneNode(true))
      el.append(panel.host)
      this.panel = panel
    },
    unmount: () => {
      this.panel?.dispose()
      this.panel = null
    },
  }
}
