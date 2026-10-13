/** What the helm readout shows. */
export type HelmView = { order: number; power: number; knots: number; heading: number; rudder: number }

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]

/** Helm styles; #tl and #br positions and the shared type live in style.css. */
const CSS = `
#tr { position: absolute; top: 22px; right: 28px; font-size: 13px; letter-spacing: 0.32em; margin-right: -0.32em; opacity: 0.85; }
#br[hidden] { display: none; }
#br { display: grid; justify-items: end; gap: 9px; }
#br .helm-row { display: flex; align-items: center; gap: 16px; }
#br .sep { width: 1px; height: 26px; background: currentColor; opacity: 0.7; }
#br .speed, #br .course { font-size: 21px; font-variant-numeric: tabular-nums; }
#br .small { font-size: 11px; letter-spacing: 0.28em; gap: 12px; opacity: 0.9; }
#br .thr { font-variant-numeric: tabular-nums; min-width: 8.5em; }
#br .thr-bar { position: relative; width: 4px; height: 26px; border: 1px solid rgba(244, 247, 251, 0.75); box-shadow: 0 1px 8px rgba(10, 30, 60, 0.35); }
#br .thr-bar .fill { position: absolute; left: 0; right: 0; bottom: 0; background: var(--ink); }
#br .thr-bar .mark { position: absolute; left: -4px; right: -4px; height: 1px; background: #ffd34a; }
#br.astern .thr { color: #ff9a6a; }
#br.astern .thr-bar .fill { background: #ff9a6a; top: 0; bottom: auto; }
#br.astern .thr-bar .mark { top: calc(var(--m, 0%)); bottom: auto !important; }
#br .rudder { position: relative; width: 56px; height: 9px; border-bottom: 1px solid rgba(244, 247, 251, 0.6); }
#br .rudder::before { content: ""; position: absolute; left: 50%; bottom: -4px; width: 1px; height: 4px; background: rgba(244, 247, 251, 0.6); }
#bl[hidden] { display: none; }
#bl { position: absolute; left: 12px; bottom: 19px; display: grid; gap: 6px; }
#bl .role { justify-self: start; font-size: 13px; letter-spacing: 0.32em; padding: 5px calc(10px - 0.32em) 5px 10px; background: rgba(6, 16, 30, 0.62);
  box-shadow: 0 0 0 1px rgba(244, 247, 251, 0.08) inset; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.7), 0 0 10px rgba(0, 0, 0, 0.35); }
#bl .role b { font-weight: 300; color: var(--team, var(--ink)); }
#bl .role i { font-style: normal; opacity: 0.6; }
#bl .role em { font-style: normal; color: #ffd34a; margin-right: 0.5em; }
#bl .role kbd { font: inherit; opacity: 0.7; margin-left: 1.4em; }
#bl .role kbd b { color: var(--ink); border: 1px solid currentColor; padding: 0 0.35em; margin-right: 0.7em; letter-spacing: 0; }
#bl .flash { padding-left: 10px; font-size: 10px; letter-spacing: 0.28em; color: #ffd34a; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.7), 0 0 10px rgba(0, 0, 0, 0.4); }
#br .rudder i { position: absolute; bottom: 0; width: 2px; height: 9px; margin-left: -1px; background: #ffd34a; }
`

/**
 * Minimal HUD: the name top left, how many are at sea (or OFFLINE) top right, and once a ship is driven, the helm
 * bottom right: speed and heading, a slim throttle bar (order outline, engine output fill) with its percentage, and a
 * rudder tick.
 */
export class Hud {
  private status: HTMLElement
  private helm: HTMLElement
  private speed: HTMLElement
  private course: HTMLElement
  private thr: HTMLElement
  private fill: HTMLElement
  private mark: HTMLElement
  private rudder: HTMLElement
  private last = ""
  private lastHelm = ""
  private lastSeat = ""
  private seatEl: HTMLElement

  constructor(root: HTMLElement) {
    if (!document.getElementById("hud-css")) {
      const style = document.createElement("style")
      style.id = "hud-css"
      style.textContent = CSS
      document.head.append(style)
    }
    root.innerHTML = `<div id="tl" class="brand">CARRIER</div><div id="tr"></div>
<div id="br" hidden><div class="helm-row"><span class="speed"></span><span class="sep"></span><span class="course"></span></div>
<div class="helm-row small"><span class="thr-bar"><i class="fill"></i><i class="mark"></i></span><span class="thr"></span><span class="rudder"><i></i></span></div></div>
<div id="bl"><div class="flash"></div><div class="role"></div></div>`
    this.status = root.querySelector<HTMLElement>("#tr")!
    this.helm = root.querySelector<HTMLElement>("#br")!
    this.speed = this.helm.querySelector<HTMLElement>(".speed")!
    this.course = this.helm.querySelector<HTMLElement>(".course")!
    this.thr = this.helm.querySelector<HTMLElement>(".thr")!
    this.fill = this.helm.querySelector<HTMLElement>(".fill")!
    this.mark = this.helm.querySelector<HTMLElement>(".mark")!
    this.rudder = this.helm.querySelector<HTMLElement>(".rudder i")!
    this.seatEl = root.querySelector<HTMLElement>("#bl")!
  }

  /**
   * Bottom left, one quiet line: ★ if I captain my ship, my role, the ship in my team's colour and a state ("ON DECK");
   * above it a short-lived refusal.
   */
  seat(v: { role: string; ship: string; state?: string; captain?: boolean; color: string; flash: string } | null): void {
    const key = v ? `${v.role}|${v.ship}|${v.state}|${v.captain}|${v.color}|${v.flash}` : ""
    if (key === this.lastSeat) return
    this.lastSeat = key
    this.seatEl.hidden = !v
    if (!v) return
    this.seatEl.style.setProperty("--team", v.color)
    const role = this.seatEl.querySelector(".role")!
    role.innerHTML = `${v.captain ? "<em>★</em>" : ""}${v.role} · <b></b>${v.state ? "<i></i>" : ""}`
    role.querySelector("b")!.textContent = v.ship
    if (v.state) role.querySelector("i")!.textContent = ` · ${v.state}`
    role.insertAdjacentHTML("beforeend", "<kbd><b>E</b>SHIP OPS</kbd>")
    this.seatEl.querySelector(".flash")!.textContent = v.flash
  }

  update(net: { readonly state: "connecting" | "online" | "offline"; readonly players: number }): void {
    const text = net.state === "online" ? `${net.players} AT SEA` : net.state === "offline" ? "OFFLINE" : ""
    if (text === this.last) return
    this.last = text
    this.status.textContent = text
  }

  /** The player's ship, every frame (null hides the helm). */
  ship(v: HelmView | null): void {
    if (!v) {
      this.helm.hidden = true
      return
    }
    this.helm.hidden = false
    const deg = Math.round((((v.heading * 180) / Math.PI) % 360) + 360) % 360
    const pct = Math.round(v.order * 100)
    const key = `${Math.round(v.knots)}|${deg}|${pct}|${Math.round(v.power * 100)}|${Math.round(v.rudder * 40)}`
    if (key === this.lastHelm) return
    this.lastHelm = key
    this.speed.textContent = `${Math.round(v.knots)} KN`
    this.course.textContent = `${COMPASS[Math.round(deg / 45) % 8]} ${String(deg).padStart(3, "0")}`
    this.thr.textContent = pct < 0 ? `AST ${-pct}%` : `THR ${pct}%`
    this.fill.style.height = `${(Math.abs(v.power) * 100).toFixed(1)}%`
    this.mark.style.bottom = `${Math.max(0, pct)}%`
    this.mark.style.setProperty("--m", `${Math.max(0, -pct)}%`)
    this.helm.classList.toggle("astern", pct < 0 || v.power < -0.005)
    this.rudder.style.left = `${(50 + v.rudder * 50).toFixed(1)}%`
  }
}
