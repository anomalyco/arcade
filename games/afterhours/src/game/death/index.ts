import { installHudType } from "../../world/doors/hud"

// The death screen: the red flood the kill ends on deepens to a dark, dried-blood red, and two quiet options come up
// in the game's typewriter face. No title card, no "YOU DIED": the picture says it. The caller pauses the world and
// releases the pointer lock; this is pure DOM.
//
//   const death = createDeathScreen()
//   death.flood()                                 // the kill: the screen floods red over ~0.3 s
//   death.show({ restart, startOver })            // then the options (clickable, keyboard: ↑ ↓ Enter, R, S)
//   death.hide()

export type DeathChoices = { restart: () => void; startOver: () => void; canRestart: boolean }

const TYPE = '"Afterhours Type", "Static Type", "American Typewriter", "Courier New", monospace'

export function createDeathScreen() {
  installHudType()
  const root = document.createElement("div")
  root.className = "death"
  Object.assign(root.style, { position: "fixed", inset: "0", zIndex: "30", pointerEvents: "none", display: "none" } satisfies Partial<CSSStyleDeclaration>)
  // Layer 1: the flood (bright arterial red, multiplied over the frame so the picture stays in it).
  const flood = document.createElement("div")
  Object.assign(flood.style, {
    position: "absolute",
    inset: "0",
    background: "radial-gradient(ellipse at 50% 45%, rgba(190, 8, 4, 0.9) 0%, rgba(120, 0, 0, 0.97) 70%, rgb(40, 0, 0) 100%)",
    mixBlendMode: "multiply",
    opacity: "0",
    transition: "opacity 0.3s cubic-bezier(0.2, 0.7, 0.3, 1)",
  } satisfies Partial<CSSStyleDeclaration>)
  // Layer 2: the slow fade to a dark, dried red.
  const dark = document.createElement("div")
  Object.assign(dark.style, {
    position: "absolute",
    inset: "0",
    background: "radial-gradient(ellipse at 50% 50%, rgb(46, 4, 3) 0%, rgb(20, 1, 1) 75%, rgb(8, 0, 0) 100%)",
    opacity: "0",
    transition: "opacity 2.4s ease",
  } satisfies Partial<CSSStyleDeclaration>)
  // Layer 3: the options.
  const menu = document.createElement("div")
  Object.assign(menu.style, {
    position: "absolute",
    left: "50%",
    top: "58%",
    transform: "translate(-50%, 0)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "14px",
    opacity: "0",
    transition: "opacity 1.4s ease",
  } satisfies Partial<CSSStyleDeclaration>)
  root.append(flood, dark, menu)
  document.body.appendChild(root)

  const buttons: HTMLButtonElement[] = []
  let focus = 0
  const paint = () =>
    buttons.forEach((b, i) => {
      const on = i === focus && !b.disabled
      b.style.color = on ? "rgba(236, 196, 170, 0.92)" : "rgba(214, 170, 150, 0.5)"
      b.style.textShadow = on ? "0 0 12px rgba(200, 40, 20, 0.6)" : "none"
      b.textContent = (on ? "▸ " : "  ") + b.dataset.label
    })
  const option = (label: string, act: () => void) => {
    const b = document.createElement("button")
    b.type = "button"
    b.dataset.label = label
    Object.assign(b.style, {
      background: "none",
      border: "0",
      padding: "6px 4px",
      cursor: "pointer",
      font: `13px/1.2 ${TYPE}`,
      letterSpacing: "0.34em",
      textTransform: "uppercase",
      whiteSpace: "pre",
      outline: "none",
      transition: "color 0.25s ease, text-shadow 0.25s ease",
    } satisfies Partial<CSSStyleDeclaration>)
    b.addEventListener("pointerenter", () => {
      focus = buttons.indexOf(b)
      paint()
    })
    b.addEventListener("click", (e) => {
      e.stopPropagation()
      if (!b.disabled) act()
    })
    buttons.push(b)
    menu.appendChild(b)
    return b
  }
  let choices: DeathChoices | null = null
  const restartB = option("Restart from checkpoint", () => choices?.restart())
  option("Start over", () => choices?.startOver())

  let keys: ((e: KeyboardEvent) => void) | null = null
  let timers: number[] = []
  const clearTimers = () => {
    for (const t of timers) clearTimeout(t)
    timers = []
  }

  return {
    get shown() {
      return root.style.display !== "none" && choices !== null
    },
    /** The kill: the frame floods red over ~0.3 s. */
    flood() {
      clearTimers()
      root.style.display = "block"
      root.style.pointerEvents = "none"
      menu.style.opacity = "0"
      dark.style.opacity = "0"
      void flood.offsetWidth
      flood.style.opacity = "1"
    },
    /** Deepens to dark red and brings the options up (clickable). */
    show(c: DeathChoices) {
      choices = c
      root.style.display = "block"
      flood.style.opacity = "1"
      restartB.disabled = !c.canRestart
      restartB.style.opacity = c.canRestart ? "1" : "0.3"
      focus = c.canRestart ? 0 : 1
      paint()
      timers.push(window.setTimeout(() => (dark.style.opacity = "0.88"), 300))
      timers.push(
        window.setTimeout(() => {
          menu.style.opacity = "1"
          root.style.pointerEvents = "auto"
        }, 1300),
      )
      keys = (e: KeyboardEvent) => {
        if (root.style.pointerEvents !== "auto") return
        if (e.code === "ArrowDown" || e.code === "KeyS" || e.code === "ArrowUp" || e.code === "KeyW") {
          focus = (focus + 1) % 2
          if (buttons[focus]!.disabled) focus = (focus + 1) % 2
          paint()
        } else if (e.code === "Enter" || e.code === "Space") buttons[focus]!.click()
        else return
        e.preventDefault()
        e.stopImmediatePropagation()
      }
      addEventListener("keydown", keys, { capture: true })
    },
    hide() {
      clearTimers()
      choices = null
      if (keys) removeEventListener("keydown", keys, { capture: true })
      keys = null
      root.style.pointerEvents = "none"
      menu.style.opacity = "0"
      dark.style.transition = "opacity 0.5s ease"
      flood.style.transition = "opacity 0.5s ease"
      dark.style.opacity = "0"
      flood.style.opacity = "0"
      timers.push(
        window.setTimeout(() => {
          root.style.display = "none"
          dark.style.transition = "opacity 2.4s ease"
          flood.style.transition = "opacity 0.3s cubic-bezier(0.2, 0.7, 0.3, 1)"
        }, 520),
      )
    },
  }
}
