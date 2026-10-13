import { KNOT, PLANE } from "../../shared/plane"

/** What the flight readout shows each frame. */
export type FlightHudView = {
  knots: number
  /** Height above the sea (m). */
  altitude: number
  heading: number
  throttle: number
  boost: number
  boosting: boolean
  stall: number
  /** Seconds left before the jet is lost outside the area, or null inside it. */
  edgeLeft: number | null
  /** Screen positions (CSS px) of the boresight and the flight-path marker, or null off screen. */
  nose: { x: number; y: number } | null
  path: { x: number; y: number } | null
  cockpit: boolean
  /** The landing autopilot has the jet. */
  landing?: boolean
  /** Your carrier: a tiny tick under it at (x, y) when in view (`on`), else a small edge chevron pointing along `angle`
   *  (screen radians, 0 = right, y down); distance in km. Null hides it. */
  home?: { x: number; y: number; size: number; on: boolean; angle: number; km: number } | null
}

const CSS = `
#fl { position: fixed; inset: 0; pointer-events: none; color: var(--ink); font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace;
  font-weight: 300; text-transform: uppercase; text-shadow: 0 1px 8px rgba(10, 30, 60, 0.45); }
#fl[hidden], #fl [hidden] { display: none !important; }
#fl .read { position: absolute; right: 28px; bottom: 26px; display: grid; justify-items: end; gap: 9px; letter-spacing: 0.32em; margin-right: -0.32em; zoom: var(--hud, 1); }
#fl .row { display: flex; align-items: center; gap: 16px; }
#fl .big { font-size: 21px; font-variant-numeric: tabular-nums; }
#fl .sep { width: 1px; height: 26px; background: currentColor; opacity: 0.7; }
#fl .small { font-size: 11px; letter-spacing: 0.28em; gap: 12px; opacity: 0.9; }
#fl .bar { position: relative; width: 4px; height: 26px; border: 1px solid rgba(244, 247, 251, 0.75); box-shadow: 0 1px 8px rgba(10, 30, 60, 0.35); }
#fl .bar i { position: absolute; left: 0; right: 0; bottom: 0; background: var(--ink); }
#fl .bar b { position: absolute; left: -4px; right: -4px; height: 1px; background: rgba(244, 247, 251, 0.55); }
#fl .boost { position: relative; width: 64px; height: 4px; border: 1px solid rgba(244, 247, 251, 0.75); }
#fl .boost i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--ink); }
#fl .boost.lit i { background: #ffb547; box-shadow: 0 0 8px #ff9a2a; }
#fl .mark { position: absolute; left: 0; top: 0; will-change: transform; }
#fl .nose { width: 22px; height: 22px; margin: -11px 0 0 -11px; }
#fl .nose::before, #fl .nose::after { content: ""; position: absolute; background: rgba(244, 247, 251, 0.85); box-shadow: 0 0 6px rgba(10, 30, 60, 0.4); }
#fl .nose::before { left: 10px; top: 0; width: 2px; height: 7px; }
#fl .nose::after { left: 0; top: 10px; width: 7px; height: 2px; box-shadow: 15px 0 0 rgba(244, 247, 251, 0.85); }
#fl .fpm { width: 14px; height: 14px; margin: -7px 0 0 -7px; border: 1.5px solid #9dffb8; border-radius: 50%; box-shadow: 0 0 6px rgba(10, 60, 30, 0.4); }
#fl .fpm::before, #fl .fpm::after { content: ""; position: absolute; top: 5px; width: 9px; height: 1.5px; background: #9dffb8; }
#fl .fpm::before { right: 13px; }
#fl .fpm::after { left: 13px; }
#fl .warn { position: absolute; left: 50%; top: 62%; transform: translateX(-50%); font-size: 13px; letter-spacing: 0.5em; margin-right: -0.5em; color: #ffc861; zoom: var(--hud, 1); }
#fl .home { position: absolute; left: 0; top: 0; color: var(--home, var(--ink)); will-change: transform; }
#fl .home .tick { position: absolute; left: -0.75px; top: 7px; width: 1.5px; height: 6px; background: currentColor; opacity: 0.85; filter: drop-shadow(0 0 2px rgba(10, 30, 60, 0.5)); }
#fl .home .chev { position: absolute; left: -6px; top: -6px; width: 12px; height: 12px; }
#fl .home .chev::before { content: ""; position: absolute; left: 2px; top: 3px; width: 6px; height: 6px; border: solid currentColor; border-width: 1.5px 1.5px 0 0; transform: rotate(45deg); filter: drop-shadow(0 0 2px rgba(10, 30, 60, 0.5)); }
#fl .home .km { position: absolute; left: 0; top: 0; transform: translate(-50%, 0); font-size: 9px; letter-spacing: 0.22em; white-space: nowrap; opacity: 0.8; font-variant-numeric: tabular-nums; }
#fl .warn.cue { color: var(--ink); opacity: 0.9; }
#fl .warn.pulse { animation: fl-pulse 0.7s ease-in-out infinite alternate; }
@keyframes fl-pulse { from { opacity: 0.35 } to { opacity: 1 } }
#fl .center { position: absolute; left: 50%; top: 40%; transform: translate(-50%, -50%); text-align: center; display: grid; gap: 10px; zoom: var(--hud, 1); }
#fl .center .title { font-size: 26px; letter-spacing: 0.6em; margin-right: -0.6em; }
#fl .center .sub { font-size: 11px; letter-spacing: 0.4em; margin-right: -0.4em; opacity: 0.85; }
body.mn-open #fl { display: none; }
`

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]

/**
 * Flight HUD in the Blackout/Carrier style: speed, altitude and heading bottom right with a throttle bar and the boost
 * meter, a boresight cross and a flight-path marker that track the jet on screen, a quiet amber STALL / PULL UP / area
 * warning and the crash card.
 */
export class FlightHud {
  readonly root: HTMLElement
  private speed: HTMLElement
  private alt: HTMLElement
  private hdg: HTMLElement
  private thr: HTMLElement
  private thrFill: HTMLElement
  private boost: HTMLElement
  private boostFill: HTMLElement
  private read: HTMLElement
  private nose: HTMLElement
  private fpm: HTMLElement
  private warn: HTMLElement
  private card: HTMLElement
  private cardTitle: HTMLElement
  private cardSub: HTMLElement
  private last = ""
  private homeEl!: HTMLElement
  private homeTick!: HTMLElement
  private homeChev!: HTMLElement
  private homeKm!: HTMLElement
  private lastKm = ""

  constructor(parent: HTMLElement = document.body) {
    if (!document.getElementById("fl-css")) {
      const style = document.createElement("style")
      style.id = "fl-css"
      style.textContent = CSS
      document.head.append(style)
    }
    const root = document.createElement("div")
    root.id = "fl"
    root.innerHTML = `<div class="mark nose"></div><div class="mark fpm"></div><div class="warn"></div>
<div class="home" hidden><div class="tick"></div><div class="chev"></div><div class="km"></div></div>
<div class="read"><div class="row"><span class="big spd"></span><span class="sep"></span><span class="big alt"></span></div>
<div class="row small"><span class="bar"><i></i><b></b></span><span class="thr"></span><span class="boost"><i></i></span><span class="hdg"></span></div></div>
<div class="center" hidden><div class="title"></div><div class="sub"></div></div>`
    parent.append(root)
    this.root = root
    const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!
    this.read = q(".read")
    this.speed = q(".spd")
    this.alt = q(".alt")
    this.hdg = q(".hdg")
    this.thr = q(".thr")
    this.thrFill = q(".bar i")
    q<HTMLElement>(".bar b").style.bottom = `${(PLANE.cruise * 100).toFixed(1)}%`
    this.boost = q(".boost")
    this.boostFill = q(".boost i")
    this.nose = q(".nose")
    this.fpm = q(".fpm")
    this.warn = q(".warn")
    this.card = q(".center")
    this.cardTitle = q(".center .title")
    this.cardSub = q(".center .sub")
    this.homeEl = q(".home")
    this.homeTick = q(".home .tick")
    this.homeChev = q(".home .chev")
    this.homeKm = q(".home .km")
  }

  /** Your team's colour (CSS), for the carrier marker. */
  set homeColor(c: string) {
    this.homeEl.style.setProperty("--home", c)
  }

  private home(h: FlightHudView["home"]): void {
    this.homeEl.hidden = !h
    if (!h) return
    this.homeEl.style.transform = `translate(${h.x.toFixed(1)}px, ${h.y.toFixed(1)}px)`
    this.homeTick.hidden = !h.on
    this.homeChev.hidden = h.on
    if (h.on) this.homeKm.style.transform = "translate(-50%, 15px)"
    else {
      this.homeChev.style.transform = `rotate(${h.angle.toFixed(3)}rad)`
      // The distance sits on the inside of the chevron.
      const ix = -Math.cos(h.angle) * 22
      const iy = -Math.sin(h.angle) * 16 - 5
      this.homeKm.style.transform = `translate(calc(-50% + ${ix.toFixed(0)}px), ${iy.toFixed(0)}px)`
    }
    const km = h.km < 10 ? h.km.toFixed(1) : Math.round(h.km).toString()
    if (km !== this.lastKm) {
      this.lastKm = km
      this.homeKm.textContent = `${km} KM`
    }
  }

  set visible(v: boolean) {
    this.root.hidden = !v
  }

  /** Full-screen card (crash, respawn), or null to hide it. */
  message(title: string | null, sub = ""): void {
    this.card.hidden = !title
    if (!title) return
    this.cardTitle.textContent = title
    this.cardSub.textContent = sub
  }

  /** The flight readout and markers, or null to hide them (on the deck, crashed). */
  update(v: FlightHudView | null): void {
    this.read.hidden = !v
    this.nose.hidden = !v?.nose
    this.fpm.hidden = !v?.path
    this.home(v?.home ?? null)
    if (!v) {
      this.warn.textContent = ""
      return
    }
    if (v.nose) this.nose.style.transform = `translate(${v.nose.x.toFixed(1)}px, ${v.nose.y.toFixed(1)}px)`
    if (v.path) this.fpm.style.transform = `translate(${v.path.x.toFixed(1)}px, ${v.path.y.toFixed(1)}px)`
    const deg = Math.round((((v.heading * 180) / Math.PI) % 360) + 360) % 360
    const key = `${Math.round(v.knots)}|${Math.round(v.altitude)}|${deg}|${Math.round(v.throttle * 100)}|${Math.round(v.boost * 64)}|${v.boosting}`
    if (key !== this.last) {
      this.last = key
      this.speed.textContent = `${Math.round(v.knots)} KN`
      this.alt.textContent = `${Math.max(0, Math.round(v.altitude))} M`
      this.hdg.textContent = `${COMPASS[Math.round(deg / 45) % 8]} ${String(deg).padStart(3, "0")}`
      this.thr.textContent = v.boosting ? "AB" : `${Math.round(v.throttle * 100)}%`
      this.thrFill.style.height = `${(v.throttle * 100).toFixed(1)}%`
      this.boostFill.style.width = `${(v.boost * 100).toFixed(1)}%`
      this.boost.classList.toggle("lit", v.boosting)
    }
    let warn = ""
    if (v.edgeLeft !== null) warn = `RETURN  ${Math.ceil(v.edgeLeft)}`
    else if (v.landing) warn = "LANDING"
    else if (v.stall > 0.35) warn = "STALL"
    if (this.warn.textContent !== warn) this.warn.textContent = warn
    this.warn.classList.toggle("cue", warn === "LANDING")
    this.warn.classList.toggle("pulse", warn === "STALL")
  }
}

export const knots = (mps: number) => mps / KNOT
