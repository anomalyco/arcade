import { countdownText, type NightClockReading } from "./reading"
import "./night-clock.css"

/** Real seconds before dawn when the chip turns warm. */
const DAWN_NEAR_SECONDS = 60

/** The night clock chip (top left). DOM over the canvas; text and attributes are written only when they change. */
export class NightClock {
  private readonly root: HTMLDivElement
  private readonly label: HTMLSpanElement
  private readonly fill: HTMLElement
  private readonly time: HTMLSpanElement
  private text = ""
  /** Proof readout of what is on screen (null while hidden). */
  shown: { mode: "night" | "dusk"; text: string; left: number } | null = null

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement("div")
    this.root.className = "night-clock"
    this.root.setAttribute("role", "timer")
    this.root.hidden = true
    this.root.innerHTML = `<i class="nc-glyph" aria-hidden="true"></i><span class="nc-label"></span><b class="nc-bar" aria-hidden="true"><i></i></b><span class="nc-time"></span>`
    this.label = this.root.querySelector(".nc-label")!
    this.fill = this.root.querySelector(".nc-bar > i")!
    this.time = this.root.querySelector(".nc-time")!
    parent.append(this.root)
    // The pause menu stops frames, so the chip would sit frozen over it: it hides until the menu closes.
    addEventListener("outbreak-menu-open", this.onPause, { signal: this.abort.signal })
    addEventListener("outbreak-menu-close", this.onResume, { signal: this.abort.signal })
  }

  private paused = false
  private readonly abort = new AbortController()
  private readonly onPause = () => {
    this.paused = true
    this.draw(null, 0)
  }
  private readonly onResume = () => {
    this.paused = false
  }

  draw(reading: NightClockReading, night: number): void {
    if (!reading || this.paused) {
      this.shown = null
      if (!this.root.hidden) this.root.hidden = true
      return
    }
    const clock = countdownText(reading.seconds)
    const left = reading.mode === "night" ? reading.left : 1
    const label = reading.mode === "night" ? `Night ${night}` : "Dusk"
    const time = reading.mode === "night" ? `Dawn in ${clock}` : `Dark in ${clock}`
    const tone = reading.mode === "dusk" ? "dusk" : reading.seconds <= DAWN_NEAR_SECONDS ? "dawn" : "night"
    this.shown = { mode: reading.mode, text: `${label} · ${time}`, left }
    if (this.root.hidden) this.root.hidden = false
    const text = `${tone}|${label}|${time}`
    if (text !== this.text) {
      this.text = text
      this.root.dataset.tone = tone
      this.label.textContent = label
      this.time.textContent = time
      this.root.setAttribute("aria-label", `${label}, ${time}`)
    }
    this.fill.style.transform = `scaleX(${left.toFixed(3)})`
  }

  dispose(): void {
    this.abort.abort()
    this.root.remove()
  }
}
