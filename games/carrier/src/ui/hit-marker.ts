import { hitSound } from "../audio/hit-audio"

const CSS = `
.hitmark { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; will-change: transform; }
.hitmark[hidden] { display: none; }
.hitmark > div { position: absolute; left: 0; top: 0; opacity: 0; zoom: var(--hud, 1); --len: 11px; --w: 2.5px; --gap: 7px; --c: #fff; --glow: rgba(255, 255, 255, 0.75); }
.hitmark > div.kill { --len: 15px; --w: 3px; --gap: 9px; --c: #ff4b2b; --glow: rgba(255, 60, 30, 0.9); }
.hitmark i { position: absolute; left: 0; top: 0; width: var(--len); height: var(--w); margin-top: calc(var(--w) / -2); border-radius: 1px;
  background: var(--c); box-shadow: 0 0 0 1px rgba(10, 20, 30, 0.35), 0 0 7px var(--glow); transform-origin: 0 50%;
  transform: rotate(var(--a)) translateX(var(--gap)); }
.hitmark i:nth-child(1) { --a: 45deg; }
.hitmark i:nth-child(2) { --a: 135deg; }
.hitmark i:nth-child(3) { --a: 225deg; }
.hitmark i:nth-child(4) { --a: 315deg; }
`

const ease = "cubic-bezier(0.2, 0.9, 0.3, 1)"
/** A hit pops in large and snaps to size, holds, fades; a kill pops bigger, red, and holds longer. */
const HIT: Keyframe[] = [
  { transform: "scale(1.7)", opacity: 1, easing: ease },
  { transform: "scale(1)", opacity: 1, offset: 0.28 },
  { transform: "scale(1)", opacity: 1, offset: 0.6 },
  { transform: "scale(0.94)", opacity: 0 },
]
const KILL: Keyframe[] = [
  { transform: "scale(2.4) rotate(-8deg)", opacity: 1, easing: ease },
  { transform: "scale(1.05) rotate(0deg)", opacity: 1, offset: 0.18 },
  { transform: "scale(1)", opacity: 1, offset: 0.72 },
  { transform: "scale(1.1)", opacity: 0 },
]
const HIT_MS = 260
const KILL_MS = 720
/** At most one hit confirmation this often (ms): the gun lands many rounds a frame. */
const HIT_GAP = 70

/**
 * The hit confirmation, one for every way of shooting (jet, gun seats, boat): an X of four ticks that pops onto the aim
 * point with its sound (src/audio/hit-audio.ts), red and bigger for a kill. Presentation only.
 */
export class HitMarker {
  private el: HTMLElement
  private mark: HTMLElement
  private last = -1e9
  private killUntil = 0

  /** `centred`: fixed at the screen centre (else `place` moves it). */
  constructor(parent: HTMLElement, centred = false) {
    if (!document.getElementById("hitmark-css")) {
      const style = document.createElement("style")
      style.id = "hitmark-css"
      style.textContent = CSS
      document.head.append(style)
    }
    this.el = document.createElement("div")
    this.el.className = "hitmark"
    if (centred) this.el.style.left = this.el.style.top = "50%"
    this.el.innerHTML = "<div><i></i><i></i><i></i><i></i></div>"
    this.mark = this.el.firstElementChild as HTMLElement
    parent.append(this.el)
  }

  /** The aim point on screen (CSS px). */
  place(x: number, y: number): void {
    this.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
  }

  set hidden(h: boolean) {
    this.el.hidden = h
  }

  /** `sound` false: the marker pops silently (a callout's sting is the moment's one sound). */
  hit(kill = false, sound = true): void {
    const now = performance.now()
    if (!kill && (now - this.last < HIT_GAP || now < this.killUntil)) return
    this.last = now
    if (kill) this.killUntil = now + KILL_MS * 0.6
    if (sound) hitSound(kill)
    this.mark.classList.toggle("kill", kill)
    this.mark.getAnimations().forEach((a) => a.cancel())
    this.mark.animate(kill ? KILL : HIT, { duration: kill ? KILL_MS : HIT_MS, fill: "forwards" })
  }
}
