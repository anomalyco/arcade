import { cameraShakeDefaults } from "@arcade/kit/client/camera"
import { KEY_LABEL_OPTIONS, keyLabelMode, setKeyLabelMode } from "@arcade/kit/client/controls"
import { SHAKE } from "../render/camera"
import type { DebugTab } from "./debug-menu"

/**
 * CONTROLS: the shared "Key labels" choice (prompts name QWERTY keys unless the player picks their own layout) and the
 * shared camera shake settings every rig reads (`SHAKE`, src/render/camera.ts).
 */
export const controlsTab: DebugTab = {
  id: "controls",
  label: "Controls",
  mount(el) {
    el.innerHTML = `<h2>KEY LABELS</h2><div class="row">${KEY_LABEL_OPTIONS.map((o) => `<button data-mode="${o.value}">${o.label}</button>`).join("")}</div>
      <h2>CAMERA</h2>
      <div class="slider"><span>Camera shake</span><input type="range" data-shake min="0" max="2" step="0.05"><span class="v" data-shake-v></span></div>
      <div class="row"><button data-motion="0">Full motion</button><button data-motion="1">Reduce motion</button><button data-act="reset">Reset</button></div>`
    const scale = el.querySelector<HTMLInputElement>("[data-shake]")!
    const scaleV = el.querySelector<HTMLElement>("[data-shake-v]")!
    const sync = () => {
      for (const b of el.querySelectorAll<HTMLButtonElement>("[data-mode]")) b.classList.toggle("on", b.dataset.mode === keyLabelMode())
      for (const b of el.querySelectorAll<HTMLButtonElement>("[data-motion]")) b.classList.toggle("on", Number(b.dataset.motion) === SHAKE.reduceMotion)
      scale.value = String(SHAKE.shakeScale)
      scaleV.textContent = `${SHAKE.shakeScale.toFixed(2)}×`
    }
    for (const b of el.querySelectorAll<HTMLButtonElement>("[data-mode]"))
      b.onclick = () => {
        setKeyLabelMode(b.dataset.mode === "layout" ? "layout" : "qwerty")
        sync()
      }
    for (const b of el.querySelectorAll<HTMLButtonElement>("[data-motion]"))
      b.onclick = () => {
        SHAKE.reduceMotion = Number(b.dataset.motion)
        sync()
      }
    scale.oninput = () => {
      SHAKE.shakeScale = Number(scale.value)
      sync()
    }
    el.querySelector<HTMLButtonElement>("[data-act=reset]")!.onclick = () => {
      const d = cameraShakeDefaults()
      SHAKE.shakeScale = d.shakeScale
      SHAKE.reduceMotion = d.reduceMotion
      sync()
    }
    sync()
  },
}
