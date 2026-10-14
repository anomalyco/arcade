import { HitMarker } from "../ui/hit-marker"
import { CenterCard, HomeMarker, homeAndCenterCss, type HomeMarkerView } from "../ui/hud-common"

/** What the boat readout shows each frame. */
export type BoatHudView = {
  knots: number
  /** Throttle order −astern..1 and engine output. */
  throttle: number
  /** Boost charge 0..1 and whether it burns. */
  boost: number
  boosting: boolean
  /** Gun heat 0..1 and overheated. */
  heat: number
  overheated: boolean
  /** Health 0..1. */
  hp: number
  /** The crosshair's world point is inside the turret's arcs; the barrel's own screen point (CSS px), or null. */
  arc: boolean
  barrel: { x: number; y: number } | null
  /** Your carrier (as the flight HUD's): a tick under it when in view, else an edge chevron along `angle`. */
  home: HomeMarkerView | null
}

const CSS = `
#bt { position: fixed; inset: 0; pointer-events: none; color: var(--ink); font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace;
  font-weight: 300; text-transform: uppercase; text-shadow: 0 1px 8px rgba(10, 30, 60, 0.45); }
#bt[hidden], #bt [hidden] { display: none !important; }
#bt .read { position: absolute; right: 28px; bottom: 26px; display: grid; justify-items: end; gap: 9px; letter-spacing: 0.32em; margin-right: -0.32em; zoom: var(--hud, 1); }
#bt .row { display: flex; align-items: center; gap: 14px; }
#bt .big { font-size: 21px; font-variant-numeric: tabular-nums; }
#bt .small { font-size: 11px; letter-spacing: 0.28em; gap: 12px; opacity: 0.9; }
#bt .bar { position: relative; width: 4px; height: 26px; border: 1px solid rgba(244, 247, 251, 0.75); box-shadow: 0 1px 8px rgba(10, 30, 60, 0.35); }
#bt .bar i { position: absolute; left: 0; right: 0; background: var(--ink); }
#bt .bar b { position: absolute; left: -4px; right: -4px; height: 1px; top: 70%; background: rgba(244, 247, 251, 0.55); }
#bt .meter { position: relative; width: 64px; height: 4px; border: 1px solid rgba(244, 247, 251, 0.75); }
#bt .meter i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--ink); }
#bt .boost.lit i { background: #ffb547; box-shadow: 0 0 8px #ff9a2a; }
#bt .heat.hot i { background: #ff6a3d; box-shadow: 0 0 8px #ff4a2a; }
#bt .hp { width: 118px; }
#bt .hp.low i { background: #ff6a3d; }
#bt .lbl { font-size: 9px; letter-spacing: 0.3em; opacity: 0.75; }
#bt .cross { position: absolute; left: 50%; top: 50%; width: 26px; height: 26px; margin: -13px 0 0 -13px; }
#bt .cross::before, #bt .cross::after { content: ""; position: absolute; background: rgba(244, 247, 251, 0.85); box-shadow: 0 0 6px rgba(10, 30, 60, 0.45); }
#bt .cross::before { left: 12px; top: 0; width: 2px; height: 26px; clip-path: polygon(0 0, 100% 0, 100% 35%, 0 35%, 0 65%, 100% 65%, 100% 100%, 0 100%); }
#bt .cross::after { left: 0; top: 12px; width: 26px; height: 2px; clip-path: polygon(0 0, 35% 0, 35% 100%, 0 100%, 0 0, 65% 0, 100% 0, 100% 100%, 65% 100%); }
#bt .cross.out { opacity: 0.35; }
#bt .pip { position: absolute; left: 0; top: 0; width: 10px; height: 10px; margin: -5px 0 0 -5px; border: 1.5px solid #9dffb8; border-radius: 50%; box-shadow: 0 0 6px rgba(10, 60, 30, 0.4); will-change: transform; }
#bt .cue { position: absolute; left: 50%; top: 62%; transform: translateX(-50%); font-size: 13px; letter-spacing: 0.5em; margin-right: -0.5em; zoom: var(--hud, 1); opacity: 0.9; }
${homeAndCenterCss("#bt")}
body.mn-open #bt { display: none; }
`

/**
 * The boat HUD, flight-style and minimal: speed with the health bar bottom right, throttle, boost and gun heat under
 * it, a crosshair at the screen centre (where the camera aims the gun) with a pip where the barrel actually points,
 * the home marker to your carrier, a cue line and the loss card. No instructions.
 */
export class BoatHud {
  readonly root: HTMLElement
  private read: HTMLElement
  private speed: HTMLElement
  private thrFill: HTMLElement
  private boost: HTMLElement
  private boostFill: HTMLElement
  private heat: HTMLElement
  private heatFill: HTMLElement
  private hp: HTMLElement
  private hpFill: HTMLElement
  private cross: HTMLElement
  private pip: HTMLElement
  private cueEl: HTMLElement
  private homeMarker: HomeMarker
  private centerCard: CenterCard
  private last = ""
  private marker: HitMarker

  constructor(parent: HTMLElement = document.body) {
    if (!document.getElementById("bt-css")) {
      const style = document.createElement("style")
      style.id = "bt-css"
      style.textContent = CSS
      document.head.append(style)
    }
    const root = document.createElement("div")
    root.id = "bt"
    root.hidden = true
    root.innerHTML = `<div class="cross"></div><div class="pip"></div><div class="cue"></div>
<div class="home" hidden><div class="tick"></div><div class="chev"></div><div class="km"></div></div>
<div class="read"><div class="row"><span class="big spd"></span></div>
<div class="row small"><span class="lbl">HULL</span><span class="meter hp"><i></i></span></div>
<div class="row small"><span class="bar thr"><i></i><b></b></span><span class="lbl">BST</span><span class="meter boost"><i></i></span><span class="lbl">GUN</span><span class="meter heat"><i></i></span></div></div>
<div class="center" hidden><div class="title"></div><div class="sub"></div></div>`
    parent.append(root)
    this.root = root
    const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!
    this.read = q(".read")
    this.speed = q(".spd")
    this.thrFill = q(".thr i")
    this.boost = q(".boost")
    this.boostFill = q(".boost i")
    this.heat = q(".heat")
    this.heatFill = q(".heat i")
    this.hp = q(".hp")
    this.hpFill = q(".hp i")
    this.cross = q(".cross")
    this.marker = new HitMarker(root, true)
    this.pip = q(".pip")
    this.cueEl = q(".cue")
    this.homeMarker = new HomeMarker(root)
    this.centerCard = new CenterCard(root)
  }

  set visible(v: boolean) {
    this.root.hidden = !v
  }

  /** Your team's colour (CSS), for the carrier marker. */
  set homeColor(c: string) {
    this.homeMarker.color = c
  }

  /** Our rounds struck something (a kill shows red). */
  hit(kill = false): void {
    this.marker.hit(kill)
  }

  /** Full-screen card (boat lost), or null to hide it. */
  message(title: string | null, sub = ""): void {
    this.centerCard.show(title, sub)
  }

  /** The readout and markers, or null to hide them (on the crane, sunk), and a quiet cue line (LAUNCHING, …). */
  update(v: BoatHudView | null, cue = ""): void {
    this.read.hidden = !v
    this.cross.hidden = !v
    this.pip.hidden = !v?.barrel
    this.homeMarker.update(v?.home ?? null)
    if (this.cueEl.textContent !== cue) this.cueEl.textContent = cue
    if (!v) return
    this.cross.classList.toggle("out", !v.arc)
    if (v.barrel) this.pip.style.transform = `translate(${v.barrel.x.toFixed(1)}px, ${v.barrel.y.toFixed(1)}px)`
    const key = `${Math.round(v.knots)}|${Math.round(v.throttle * 50)}|${Math.round(v.boost * 64)}|${v.boosting}|${Math.round(v.heat * 64)}|${v.overheated}|${Math.round(v.hp * 118)}`
    if (key === this.last) return
    this.last = key
    this.speed.textContent = `${Math.round(v.knots)} KN`
    const zero = 30
    const th = Math.max(-1, Math.min(1, v.throttle))
    this.thrFill.style.bottom = `${th >= 0 ? zero : zero + th * zero}%`
    this.thrFill.style.height = `${th >= 0 ? th * (100 - zero) : -th * zero}%`
    this.boostFill.style.width = `${(v.boost * 100).toFixed(1)}%`
    this.boost.classList.toggle("lit", v.boosting)
    this.heatFill.style.width = `${(v.heat * 100).toFixed(1)}%`
    this.heat.classList.toggle("hot", v.overheated)
    this.hpFill.style.width = `${(Math.max(0, v.hp) * 100).toFixed(1)}%`
    this.hp.classList.toggle("low", v.hp < 0.5)
  }
}
