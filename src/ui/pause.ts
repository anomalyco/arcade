// Pause menu: same typographic menu as the lobby (Resume / Change aircraft / Invite / Settings / Controls / Leave).
import type { Quality } from "../sim/types"
import { MenuNav, controlsTable, hintsHtml, settingsScreen, type MenuScreen } from "./lobby"

export interface PauseMenu {
  show(heli?: boolean): void
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
  root.innerHTML = `<h2 class="wm">Paused</h2><nav class="screen"></nav><footer class="foot"><div class="hints"></div></footer>`
  parent.appendChild(root)
  const hints = root.querySelector<HTMLElement>(".hints")!
  const nav = new MenuNav(root.querySelector<HTMLElement>(".screen")!, actions.click)
  nav.onHints = h => { hints.innerHTML = hintsHtml(h) }
  nav.onEscape = () => actions.resume()
  const rootScreen = (): MenuScreen => ({
    size: "big",
    hints: [["↑↓", "select"], ["enter", "confirm"], ["esc", "resume"]],
    items: [
      { label: "Resume", run: () => actions.resume() },
      { label: "Change aircraft", run: () => actions.changeVehicle(), meta: "pick another aircraft or seat" },
      { label: "Invite friends", run: () => actions.invite(), meta: "copies the room link" },
      { label: "Settings", run: () => nav.push(settingsScreen(nav, actions.quality, "04 — <b>settings</b>")), meta: "graphics · sound · steering" },
      { label: "Controls", run: () => nav.push({ crumb: "05 — <b>controls</b>", html: controlsTable(), hints: [["esc", "back"]] }) },
      { label: "Leave match", small: true, run: () => actions.leave(), meta: "back to the main menu" },
    ],
  })
  // Registered before the game's own keydown listener, so Esc inside a sub-screen goes back instead of resuming.
  const onKey = (e: KeyboardEvent) => {
    if (root.hidden) return
    if (nav.handleKey(e)) { e.preventDefault(); e.stopImmediatePropagation() }
  }
  window.addEventListener("keydown", onKey)
  root.addEventListener("click", e => { if (e.target === root) actions.resume() })
  return {
    show() { nav.reset(rootScreen()); root.hidden = false },
    hide() { root.hidden = true },
    visible: () => !root.hidden,
    dispose() { window.removeEventListener("keydown", onKey); root.remove() },
  }
}
