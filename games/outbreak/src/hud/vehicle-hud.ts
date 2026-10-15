/**
 * The seated HUD, in the diegetic direction: no status panel. Fuel and body damage read off a small dashboard gauge
 * (a fuel needle over E–F, and a thin body arc that empties and reddens with damage), speed is left to the motion and
 * the engine, and the controls are key caps that fade away once each has been used (remembered per browser). A
 * blocking state (no battery, no keys, empty tank) shows as one short word under the gauge.
 */
import { keyCapHtml, keyPromptHtml } from "@arcade/kit/client/key-cap"
import { moveClusterLabel } from "@arcade/kit/client/controls"
import { hudMotion, snapToPixels, type HudMotion } from "./motion"

const USED_KEY = "arcade.outbreak.vehicleKeys"
/** Presses before a hint fades out. */
const USES_TO_LEARN = 1

export type VehicleHudState = {
  driver: boolean
  fuel: number
  body: number
  headlights: boolean
  warning: string | null
}

type Hint = { code: string; verb: string; el: HTMLElement }

function loadUsed(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(USED_KEY) ?? "{}") as unknown
    return raw && typeof raw === "object" ? (raw as Record<string, number>) : {}
  } catch {
    return {}
  }
}

/** Needle angle (degrees from straight up) for a fuel fraction: E at −60°, F at +60°. */
const needle = (f: number) => -60 + 120 * Math.max(0, Math.min(1, f))

export class VehicleHud {
  private readonly used = loadUsed()
  private readonly gauge: HTMLElement
  private readonly needleEl: SVGElement
  private readonly bodyArc: SVGPathElement
  private readonly warnEl: HTMLElement
  private readonly hintsEl: HTMLElement
  private hints: Hint[] = []
  private role = ""
  private shown = false
  private warning: string | null = null
  private fuelShown = -1
  private snapKey = ""
  private readonly onKey = (e: KeyboardEvent) => {
    if (!this.shown || e.repeat) return
    const code = e.code.startsWith("Shift") ? "ShiftLeft" : ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code) ? "Move" : e.code
    this.used[code] = (this.used[code] ?? 0) + 1
    try {
      localStorage.setItem(USED_KEY, JSON.stringify(this.used))
    } catch {}
    this.fadeLearned()
  }
  private readonly onPointer = (e: PointerEvent) => {
    if (!this.shown || e.button !== 0) return
    this.onKey({ code: "Mouse0", repeat: false } as KeyboardEvent)
  }

  constructor(
    readonly el: HTMLElement,
    private readonly motion: HudMotion = hudMotion,
  ) {
    el.replaceChildren()
    el.hidden = true
    el.innerHTML = `<div class="vh-gauge" role="img" aria-label="Fuel"><svg viewBox="0 0 64 40" aria-hidden="true">
      <path class="vh-track" d="M8 34 A26 26 0 0 1 56 34"/>
      <path class="vh-body" d="M8 34 A26 26 0 0 1 56 34" pathLength="1"/>
      <g class="vh-ticks"><line x1="32" y1="10" x2="32" y2="14"/><line x1="11.2" y1="22" x2="14.6" y2="24"/><line x1="52.8" y1="22" x2="49.4" y2="24"/></g>
      <text x="13" y="38">E</text><text x="51" y="38">F</text>
      <g class="vh-needle"><line x1="32" y1="34" x2="32" y2="13"/><circle cx="32" cy="34" r="2.6"/></g>
    </svg><span class="vh-warn" hidden></span></div><div class="vh-keys"></div>`
    this.gauge = el.querySelector(".vh-gauge")!
    this.needleEl = el.querySelector(".vh-needle")!
    this.bodyArc = el.querySelector(".vh-body")!
    this.warnEl = el.querySelector(".vh-warn")!
    this.hintsEl = el.querySelector(".vh-keys")!
    if (typeof window !== "undefined") {
      window.addEventListener("keydown", this.onKey, { passive: true })
      window.addEventListener("pointerdown", this.onPointer, { passive: true })
    }
  }

  /** Forgets which controls were learned (Lab, proofs). */
  resetLearned(): void {
    for (const k of Object.keys(this.used)) delete this.used[k]
    try {
      localStorage.removeItem(USED_KEY)
    } catch {}
    this.role = ""
  }

  update(s: VehicleHudState | null): void {
    if (!s) {
      if (this.shown) {
        this.shown = false
        void this.motion.exit(this.el, "snappy", { y: 6 }).then(() => {
          if (!this.shown) this.el.hidden = true
        })
      }
      return
    }
    const appearing = !this.shown
    if (appearing) {
      this.shown = true
      this.el.hidden = false
      for (const a of this.el.getAnimations()) a.cancel()
      this.motion.enter(this.el, "default", { y: 6 })
    }
    const role = s.driver ? "driver" : "passenger"
    if (role !== this.role) {
      this.role = role
      this.buildHints(s.driver)
    }
    const lights = this.hints.find((h) => h.code === "KeyF" && s.driver)
    if (lights) lights.el.querySelector(".akp-label")!.textContent = s.headlights ? "Lights off" : "Lights on"
    const f = Math.round(s.fuel * 200) / 200
    if (f !== this.fuelShown) {
      this.fuelShown = f
      this.needleEl.style.transform = `rotate(${needle(f)}deg)`
      this.gauge.dataset.low = String(f <= 0.15)
    }
    this.bodyArc.style.strokeDashoffset = String(1 - Math.max(0, Math.min(1, s.body)))
    this.gauge.dataset.damaged = String(s.body < 0.35)
    if (s.warning !== this.warning) {
      this.warning = s.warning
      if (s.warning) {
        this.warnEl.textContent = s.warning
        this.warnEl.hidden = false
        this.motion.enter(this.warnEl, "default", { y: -3 })
      } else if (!this.warnEl.hidden) {
        void this.motion.exit(this.warnEl).then(() => {
          if (!this.warning) this.warnEl.hidden = true
        })
      }
    }
    const snap = `${this.role}|${this.hintsEl.offsetWidth}|${innerWidth}|${innerHeight}|${this.el.parentElement?.offsetHeight}`
    if (snap !== this.snapKey) {
      if (snapToPixels(this.el)) this.snapKey = snap
    }
    if (appearing) {
      // First paint at rest: the needle starts where the tank is.
      this.needleEl.style.transition = "none"
      void this.el.offsetWidth
      this.needleEl.style.transition = ""
    }
  }

  private buildHints(driver: boolean): void {
    const list: [string, string][] = driver
      ? [["Move", "Drive"], ["Space", "Brake"], ["KeyH", "Horn"], ["KeyF", "Lights"], ["KeyC", "Seat"], ["KeyE", "Exit"]]
      : [["Mouse0", "Shoot"], ["KeyR", "Reload"], ["KeyC", "Seat"], ["KeyE", "Exit"]]
    this.hintsEl.replaceChildren()
    this.hints = list.map(([code, verb]) => {
      const el = document.createElement("span")
      el.className = "vh-hint"
      el.innerHTML = code === "Move" ? `<span class="akp">${keyCapHtml("KeyW", { label: moveClusterLabel() })}<span class="akp-label">${verb}</span></span>` : keyPromptHtml(code, verb)
      el.dataset.learned = String((this.used[code] ?? 0) >= USES_TO_LEARN)
      this.hintsEl.appendChild(el)
      return { code, verb, el }
    })
  }

  /** A learned hint fades and collapses; its neighbours slide into the gap. */
  private fadeLearned(): void {
    for (const h of this.hints) {
      const learned = (this.used[h.code] ?? 0) >= USES_TO_LEARN
      if (String(learned) === h.el.dataset.learned) continue
      h.el.dataset.learned = String(learned)
      if (!learned) continue
      const w = h.el.offsetWidth
      this.motion.animate(h.el, [{ opacity: 1, maxWidth: `${w}px`, paddingInline: "6px", filter: "blur(0px)" }, { opacity: 0, maxWidth: "0px", paddingInline: "0px", filter: "blur(3px)" }], "calm")
    }
  }
}
