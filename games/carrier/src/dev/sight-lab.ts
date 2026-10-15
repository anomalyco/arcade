import { LabPanel } from "@arcade/kit/lab-panel"
import { SIGHT_CAM, SIGHT_CAM_CONTROLS, SIGHT_CAM_DEFAULTS } from "../flight/camera"
import { SIGHT_STYLE, SIGHT_STYLE_CONTROLS, SIGHT_STYLE_DEFAULTS } from "../weapons/bombsight"
import type { DebugTab } from "./debug-menu"

/** Stylesheets the shared panel (and knobs, which draws it) put in the document head; the debug menu is a shadow root. */
const PANEL_STYLES = "style[data-knobs-style], style[data-knobs-preset], style[data-lab-knobs], style[data-lab-panel-css]"

/**
 * SIGHT tab: the bombsight's typed settings (view: src/flight/camera.ts SIGHT_CAM; symbols: src/weapons/bombsight.ts
 * SIGHT_STYLE) on the shared Lab panel, with their approved defaults and Reset. Every value is read live each frame.
 * The panel exists only while the tab is shown; its Backquote closes the whole debug menu.
 */
export class SightLab {
  private panel: LabPanel | null = null

  constructor(private opts: { close: () => void; release: () => void }) {}

  readonly tab: DebugTab = {
    id: "sight",
    label: "Sight",
    mount: (el) => {
      el.replaceChildren()
      const panel = new LabPanel({}, [], new URLSearchParams(), this.opts.release, {
        layout: "inspector",
        capture: "focus",
        open: true,
        presets: false,
        groupActions: false,
        pill: false,
        variants: "carrier-bombsight",
        onToggle: (visible) => {
          if (!visible) this.opts.close()
        },
      })
      panel.addControls(SIGHT_CAM, SIGHT_CAM_CONTROLS, SIGHT_CAM_DEFAULTS)
      panel.addControls(SIGHT_STYLE, SIGHT_STYLE_CONTROLS, SIGHT_STYLE_DEFAULTS)
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
