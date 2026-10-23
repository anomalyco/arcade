import { FEEDBACK } from "./settings"

/** A reward moment the HUD calls out. */
export type CalloutKind = "splash" | "double" | "triple" | "multi" | "ship-hit" | "sunk" | "deck-jet" | "close-call"

const TEXT: Record<CalloutKind, string> = {
  splash: "SPLASH ONE",
  double: "DOUBLE KILL",
  triple: "TRIPLE KILL",
  multi: "MULTI KILL",
  "ship-hit": "SHIP HIT",
  sunk: "CARRIER SUNK",
  "deck-jet": "DECK JET DESTROYED",
  "close-call": "CLOSE CALL",
}

/** Which moments outrank which while one is still showing (a SHIP HIT never covers a DOUBLE KILL). */
const RANK: Record<CalloutKind, number> = { "close-call": 0, "ship-hit": 1, splash: 2, "deck-jet": 2, double: 3, triple: 4, multi: 5, sunk: 5 }

const CSS = `
#fb { position: fixed; inset: 0; pointer-events: none; color: var(--ink, #f4f7fb); font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace;
  font-weight: 300; text-transform: uppercase; }
#fb [hidden] { display: none !important; }
#fb canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
#fb .dmg, #fb .dir, #fb .pulse { position: absolute; inset: 0; opacity: 0; will-change: opacity; }
#fb .dmg { background: radial-gradient(ellipse 80% 75% at 50% 50%, transparent 46%, rgba(170, 14, 6, 0.42) 74%, rgba(120, 0, 0, 0.92) 100%); }
#fb .dir { background: radial-gradient(circle at var(--dx, 50%) var(--dy, 50%), rgba(255, 36, 16, 0.7) 0%, rgba(200, 20, 8, 0.32) 22%, transparent 46%); }
#fb .pulse { box-shadow: inset 0 0 240px 80px rgba(255, 150, 70, 0.5); }
#fb .call { position: absolute; left: 50%; top: 29%; display: flex; align-items: center; gap: 14px; transform: translate(-50%, -50%); opacity: 0;
  font-size: 19px; font-weight: 400; letter-spacing: 0.5em; white-space: nowrap; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8), 0 0 14px rgba(0, 10, 30, 0.55); zoom: var(--hud, 1); }
#fb .call::before, #fb .call::after { content: ""; width: 54px; height: 1px; background: currentColor; opacity: 0.8; }
#fb .call span { margin-right: -0.5em; }
#fb .call b { font-weight: 300; font-size: 11px; letter-spacing: 0.3em; opacity: 0.8; margin-left: 4px; }
#fb .call.kill { color: #ff7a55; }
#fb .call.close { color: #ffc861; }
#fb .streak { position: absolute; right: 28px; bottom: 134px; font-size: 10px; letter-spacing: 0.32em; margin-right: -0.32em; opacity: 0.85;
  text-shadow: 0 1px 6px rgba(10, 30, 60, 0.5); zoom: var(--hud, 1); }
#fb .streak i { font-style: normal; color: #ff6a45; }
body.mn-open #fb { display: none; }
`

const POP: Keyframe[] = [
  { opacity: 0, transform: "translate(-50%, -50%) scale(1.35)", letterSpacing: "0.9em", easing: "cubic-bezier(0.2, 0.9, 0.3, 1)" },
  { opacity: 1, transform: "translate(-50%, -50%) scale(1)", letterSpacing: "0.5em", offset: 0.14 },
  { opacity: 1, transform: "translate(-50%, -50%) scale(1)", letterSpacing: "0.5em", offset: 0.8 },
  { opacity: 0, transform: "translate(-50%, -50%) scale(0.98)", letterSpacing: "0.56em" },
]

/**
 * The feedback overlay's DOM: the centred callout (thin lines either side, Plex Mono like the rest of the HUD, no
 * instruction text), the kill streak counter above the weapons row, the red damage edge (its own radial ring and a
 * wedge toward the attacker, distinct from the g-force vignette) and the warm kill pulse. The canopy canvas sits
 * underneath (src/feedback/canopy.ts).
 */
export class FeedbackOverlay {
  readonly root: HTMLElement
  private call: HTMLElement
  private streakEl: HTMLElement
  private dmg: HTMLElement
  private dir: HTMLElement
  private pulse: HTMLElement
  private showing: CalloutKind | null = null
  private left = 0
  private lastStreak = -1
  private lastDmg = ""
  private lastDir = ""
  private lastPulse = ""

  constructor(parent: HTMLElement = document.body) {
    if (!document.getElementById("fb-css")) {
      const style = document.createElement("style")
      style.id = "fb-css"
      style.textContent = CSS
      document.head.append(style)
    }
    const root = document.createElement("div")
    root.id = "fb"
    root.innerHTML = `<div class="dmg"></div><div class="dir"></div><div class="pulse"></div><div class="call"></div><div class="streak" hidden></div>`
    parent.append(root)
    this.root = root
    const q = (s: string) => root.querySelector<HTMLElement>(s)!
    this.dmg = q(".dmg")
    this.dir = q(".dir")
    this.pulse = q(".pulse")
    this.call = q(".call")
    this.streakEl = q(".streak")
  }

  /** Shows a callout unless a bigger one is still up. False when it was dropped (so the caller plays no sting). */
  callout(kind: CalloutKind, streak: number): boolean {
    if (this.showing && this.left > 0 && RANK[this.showing] > RANK[kind]) return false
    this.showing = kind
    this.left = FEEDBACK.calloutTime
    this.call.className = `call${kind === "close-call" ? " close" : kind === "ship-hit" ? "" : " kill"}`
    const sub = streak >= 3 && kind !== "close-call" && kind !== "ship-hit" ? `<b>×${streak}</b>` : ""
    this.call.innerHTML = `<span>${TEXT[kind]}</span>${sub}`
    this.call.getAnimations().forEach((a) => a.cancel())
    this.call.animate(POP, { duration: FEEDBACK.calloutTime * 1000, fill: "forwards" })
    return true
  }

  /**
   * Per frame. `edge` 0..1 the damage ring, `dir` 0..1 the wedge at (`dx`, `dy`) in % of the screen, `pulse` 0..1
   * the kill pulse, `streak` shown from 2 kills (0 hides it, as does `visible` false).
   */
  update(dt: number, edge: number, dir: number, dx: number, dy: number, pulse: number, streak: number, visible: boolean): void {
    this.left -= dt
    const s = visible && streak >= 2 ? streak : 0
    if (s !== this.lastStreak) {
      this.lastStreak = s
      this.streakEl.hidden = s === 0
      this.streakEl.innerHTML = `STREAK <i>${s}</i>`
    }
    const e = edge.toFixed(3)
    if (e !== this.lastDmg) this.dmg.style.opacity = this.lastDmg = e
    const d = dir.toFixed(3)
    if (d !== this.lastDir) this.dir.style.opacity = this.lastDir = d
    if (dir > 0) {
      this.dir.style.setProperty("--dx", `${dx.toFixed(1)}%`)
      this.dir.style.setProperty("--dy", `${dy.toFixed(1)}%`)
    }
    const p = pulse.toFixed(3)
    if (p !== this.lastPulse) this.pulse.style.opacity = this.lastPulse = p
  }
}
