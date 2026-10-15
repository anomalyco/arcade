import { KEY_LABEL_OPTIONS, keyLabelMode, setKeyLabelMode } from "@arcade/kit/client/controls"
import type { DebugTab } from "./debug-menu"

/** CONTROLS: the shared "Key labels" choice. Prompts name QWERTY keys unless the player picks their own layout. */
export const controlsTab: DebugTab = {
  id: "controls",
  label: "Controls",
  mount(el) {
    el.innerHTML = `<h2>KEY LABELS</h2><div class="row">${KEY_LABEL_OPTIONS.map((o) => `<button data-mode="${o.value}">${o.label}</button>`).join("")}</div>`
    const sync = () => {
      for (const b of el.querySelectorAll<HTMLButtonElement>("[data-mode]")) b.classList.toggle("on", b.dataset.mode === keyLabelMode())
    }
    for (const b of el.querySelectorAll<HTMLButtonElement>("[data-mode]"))
      b.onclick = () => {
        setKeyLabelMode(b.dataset.mode === "layout" ? "layout" : "qwerty")
        sync()
      }
    sync()
  },
}
