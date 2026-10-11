import type { Quality } from "../sim/types"
import { settings, updateSettings } from "./settings"

export interface PauseMenu {
  show(): void
  hide(): void
  visible(): boolean
  dispose(): void
}

export function createPauseMenu(parent: HTMLElement, actions: {
  resume(): void
  changeVehicle(): void
  invite(): void
  leave(): void
  quality(q: Quality): void
  click(): void
}): PauseMenu {
  const root = document.createElement("div")
  root.className = "pause"
  root.hidden = true
  root.innerHTML = `
    <div class="panel">
      <h2>Paused <span class="sub">the sky keeps turning</span></h2>
      <button class="btn primary" data-a="resume">Resume <span class="k">CLICK</span></button>
      <button class="btn" data-a="vehicle">Change aircraft / seat</button>
      <button class="btn" data-a="invite">Copy invite link</button>
      <div class="opts">
        <label>Graphics <span class="seg q"><button data-q="low">Low</button><button data-q="balanced">Balanced</button><button data-q="high">High</button></span></label>
        <label>Controls <span class="seg st"><button data-s="direct">Direct</button><button data-s="aim">Mouse-aim</button></span></label>
        <label>Mouse <input type="range" class="sens" min="0.2" max="3" step="0.05" /></label>
        <label class="check"><input type="checkbox" class="inv" /> Invert mouse Y</label>
        <label class="check"><input type="checkbox" class="mute" /> Mute</label>
      </div>
      <details><summary>Controls</summary><div class="keys-mini">
        <span><kbd>Mouse</kbd> pitch / turn</span><span><kbd>↑</kbd> nose down <kbd>↓</kbd> up</span><span><kbd>W</kbd><kbd>S</kbd> throttle</span><span><kbd>Wheel</kbd> fine throttle</span>
        <span><kbd>Q</kbd><kbd>E</kbd> roll</span><span><kbd>A</kbd><kbd>D</kbd> rudder / strafe</span><span><kbd>LMB</kbd>/<kbd>Space</kbd> guns</span><span><kbd>RMB</kbd>/<kbd>V</kbd> missiles</span>
        <span><kbd>Shift</kbd> boost</span><span><kbd>X</kbd> brake/hover</span><span><kbd>F</kbd> flares</span><span><kbd>R</kbd> ability</span>
        <span><kbd>1</kbd><kbd>2</kbd> seat</span><span>hold <kbd>C</kbd> free look</span><span><kbd>T</kbd> cockpit</span><span><kbd>Tab</kbd> scores</span>
      </div></details>
      <button class="btn danger" data-a="leave">Leave match</button>
    </div>`
  parent.appendChild(root)
  const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T
  const seg = q<HTMLElement>(".seg.q")
  const sens = q<HTMLInputElement>(".sens")
  const st = q<HTMLElement>(".seg.st")
  const inv = q<HTMLInputElement>(".inv")
  const mute = q<HTMLInputElement>(".mute")
  const paint = () => {
    seg.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.q === settings.quality)))
    sens.value = String(settings.sensitivity)
    st.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.s === settings.controlStyle)))
    inv.checked = settings.invertY
    mute.checked = settings.muted
  }
  root.addEventListener("click", e => {
    const t = e.target as HTMLElement
    if (t.closest("button")) actions.click()
    const sb = t.closest<HTMLElement>("[data-s]")
    if (sb) { updateSettings({ controlStyle: sb.dataset.s as "direct" | "aim" }); paint(); return }
    const qb = t.closest<HTMLElement>("[data-q]")
    if (qb) { updateSettings({ quality: qb.dataset.q as Quality }); actions.quality(qb.dataset.q as Quality); paint(); return }
    switch (t.closest<HTMLElement>("[data-a]")?.dataset.a) {
      case "resume": actions.resume(); break
      case "vehicle": actions.changeVehicle(); break
      case "invite": actions.invite(); break
      case "leave": actions.leave(); break
    }
    if (t === root) actions.resume()
  })
  sens.addEventListener("input", () => updateSettings({ sensitivity: Number(sens.value) }))
  inv.addEventListener("change", () => updateSettings({ invertY: inv.checked }))
  mute.addEventListener("change", () => updateSettings({ muted: mute.checked }))
  return {
    show() { paint(); root.hidden = false },
    hide() { root.hidden = true },
    visible: () => !root.hidden,
    dispose() { root.remove() },
  }
}
