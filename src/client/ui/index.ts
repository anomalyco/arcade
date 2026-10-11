import type { Screen, UI, UIActions, UIState } from "../contracts"
import { cls } from "./dom"
import { createHud } from "./hud"
import { createLobby } from "./lobby"
import { createResults } from "./results"
import { createShop } from "./shop"
import { createTitle } from "./title"

interface View {
  el: HTMLElement
  update(state: UIState): void
}

export function createUI(root: HTMLElement, actions: UIActions): UI {
  root.classList.add("ui-root")
  // keep buttons from holding focus, so Space (lock in) never re-clicks the last button
  root.addEventListener("mousedown", (e) => {
    if (e.target instanceof Element && e.target.closest("button")) e.preventDefault()
  })
  const factories: Record<Screen, () => View> = {
    title: () => createTitle(actions),
    lobby: () => createLobby(actions),
    game: () => createHud(actions),
    shop: () => createShop(actions),
    results: () => createResults(actions),
  }
  // Layouts are authored for a 1600x1000 viewport; scale uniformly to fit others.
  const fit = () => {
    const k = Math.max(0.55, Math.min(1.35, window.innerWidth / 1600, window.innerHeight / 1000))
    root.style.setProperty("--k", k.toFixed(4))
    root.style.setProperty("--sw", `${(window.innerWidth / k).toFixed(1)}px`)
    root.style.setProperty("--sh", `${(window.innerHeight / k).toFixed(1)}px`)
  }
  fit()
  window.addEventListener("resize", fit)
  const views = new Map<Screen, View>()
  let active: Screen | null = null

  function get(screen: Screen): View {
    let v = views.get(screen)
    if (!v) {
      v = factories[screen]()
      v.el.dataset.screen = screen
      root.append(v.el)
      views.set(screen, v)
    }
    return v
  }

  return {
    update(state) {
      const screen = state.screen
      const v = get(screen)
      if (active !== screen) {
        for (const [k, other] of views) cls(other.el, "active", k === screen)
        active = screen
        root.dataset.screen = screen
      }
      v.update(state)
    },
  }
}
