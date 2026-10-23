import { FEEL } from "./feel"

const CSS = `
#gload { position: fixed; inset: 0; pointer-events: none; }
#gload[hidden] { display: none; }
#gload i { position: absolute; inset: 0; opacity: 0; }
#gload .dark { background: radial-gradient(ellipse at 50% 50%, transparent var(--g0), rgba(0, 0, 0, 0.94) var(--g1), #000 calc(var(--g1) + 18%)); }
#gload .red { background: radial-gradient(ellipse at 50% 50%, rgba(150, 14, 10, 0.35) 20%, rgba(110, 6, 6, 0.85) 75%, rgb(60, 0, 0) 110%); mix-blend-mode: multiply; }
`

/**
 * The g-load on screen (src/flight/feel.ts levels): a black tunnel closes in from the edges around the centre as g
 * builds (a blackout, not a grey wash); red-out tints the view red from the edges. One fixed layer under the flight HUD, written
 * only when a level changes.
 */
export class GOverlay {
  private root: HTMLDivElement
  private dark: HTMLElement
  private red: HTMLElement
  private last = [-1, -1]

  constructor() {
    if (!document.getElementById("gload-css")) {
      const style = document.createElement("style")
      style.id = "gload-css"
      style.textContent = CSS
      document.head.append(style)
    }
    this.root = document.createElement("div")
    this.root.id = "gload"
    this.root.hidden = true
    this.root.innerHTML = `<i class="dark"></i><i class="red"></i>`
    this.dark = this.root.children[0] as HTMLElement
    this.red = this.root.children[1] as HTMLElement
    // Under the flight HUD (#fl) so the readouts stay legible through a grey-out.
    const hud = document.getElementById("fl")
    if (hud) hud.before(this.root)
    else document.body.append(this.root)
  }

  /** Grey-out and red-out levels 0..1. */
  update(grey: number, red: number): void {
    const g = Math.round(grey * 200) / 200
    const r = Math.round(red * 200) / 200
    if (g === this.last[0] && r === this.last[1]) return
    this.last[0] = g
    this.last[1] = r
    this.root.hidden = g <= 0 && r <= 0
    if (this.root.hidden) return
    // The clear centre shrinks from beyond the corners to a narrow tunnel as the blackout deepens.
    const g0 = 75 - 50 * g
    this.root.style.setProperty("--g0", `${g0}%`)
    this.root.style.setProperty("--g1", `${g0 + 22}%`)
    this.dark.style.opacity = `${Math.min(1, FEEL.vignette * g * 1.3)}`
    this.red.style.opacity = `${FEEL.vignette * r}`
  }
}
