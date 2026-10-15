import { LabPanel } from "@arcade/kit/lab-panel"
import { RADAR, RADAR_CONTROLS, RADAR_DEFAULTS } from "../flight/radar"
import type { DebugTab } from "./debug-menu"

/** Stylesheets the shared panel (and knobs, which draws it) put in the document head; the debug menu is a shadow root. */
const PANEL_STYLES = "style[data-knobs-style], style[data-knobs-preset], style[data-lab-knobs], style[data-lab-panel-css]"

/**
 * RADAR tab: the pilot's radar, full map and target markers (src/flight/radar.ts RADAR) on the shared Lab panel, with
 * their approved defaults and Reset. Every value is read live each frame.
 */
export class RadarLab {
  private panel: LabPanel | null = null

  constructor(private opts: { close: () => void; release: () => void }) {}

  readonly tab: DebugTab = {
    id: "radar",
    label: "Radar",
    mount: (el) => {
      el.replaceChildren()
      const panel = new LabPanel({}, [], new URLSearchParams(), this.opts.release, {
        layout: "inspector",
        capture: "focus",
        open: true,
        presets: false,
        groupActions: false,
        pill: false,
        variants: "carrier-radar",
        onToggle: (visible) => {
          if (!visible) this.opts.close()
        },
      })
      panel.addControls(RADAR, RADAR_CONTROLS, RADAR_DEFAULTS)
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
