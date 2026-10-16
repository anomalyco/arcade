import { bindVolumeControls } from "@arcade/kit/audio/volume"
import type { GameQuality } from "@arcade/kit/client/quality"
import { LabPanel } from "@arcade/kit/lab-panel"
import { mixer } from "../audio/mixer"
import type { CarrierQuality } from "../quality"
import type { DebugTab } from "./debug-menu"

/** Stylesheets the shared panel (and knobs, which draws it) put in the document head; the debug menu is a shadow root. */
const PANEL_STYLES = "style[data-knobs-style], style[data-knobs-preset], style[data-lab-knobs], style[data-lab-panel-css]"

/** VIEW tab: the quality tier and player volume (Auto adapts resolution and bloom to the GPU; choices are saved for the game). */
export class ViewLab {
  private panel: LabPanel | null = null

  constructor(private opts: { quality: GameQuality<CarrierQuality>; close: () => void; release: () => void }) {}

  readonly tab: DebugTab = {
    id: "view",
    label: "View",
    mount: (el) => {
      el.replaceChildren()
      const panel = new LabPanel({}, [], new URLSearchParams(), this.opts.release, {
        layout: "inspector",
        capture: "focus",
        open: true,
        presets: false,
        groupActions: false,
        pill: false,
        variants: false,
        onToggle: (visible) => {
          if (!visible) this.opts.close()
        },
      })
      this.opts.quality.addTo(panel)
      const mix = mixer()
      bindVolumeControls(panel, {
        volumes: mix.volumes,
        channels: ["master", "effects", "ambience"],
        getMuted: () => mix.muted,
        setMuted: (m) => mix.setMuted(m),
        onChange: () => mix.setVolumes(),
      })
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
