/** Shared home-carrier marker and center message card for FlightHud and BoatHud. */
export type HomeMarkerView = { x: number; y: number; on: boolean; angle: number; km: number; size?: number }

export const homeAndCenterCss = (p: string): string => `
${p} .home { position: absolute; left: 0; top: 0; color: var(--home, var(--ink)); will-change: transform; }
${p} .home .tick { position: absolute; left: -0.75px; top: 7px; width: 1.5px; height: 6px; background: currentColor; opacity: 0.85; filter: drop-shadow(0 0 2px rgba(10, 30, 60, 0.5)); }
${p} .home .chev { position: absolute; left: -6px; top: -6px; width: 12px; height: 12px; }
${p} .home .chev::before { content: ""; position: absolute; left: 2px; top: 3px; width: 6px; height: 6px; border: solid currentColor; border-width: 1.5px 1.5px 0 0; transform: rotate(45deg); filter: drop-shadow(0 0 2px rgba(10, 30, 60, 0.5)); }
${p} .home .km { position: absolute; left: 0; top: 0; transform: translate(-50%, 0); font-size: 9px; letter-spacing: 0.22em; white-space: nowrap; opacity: 0.8; font-variant-numeric: tabular-nums; }
${p} .center { position: absolute; left: 50%; top: 40%; transform: translate(-50%, -50%); text-align: center; display: grid; gap: 10px; zoom: var(--hud, 1); }
${p} .center .title { font-size: 26px; letter-spacing: 0.6em; margin-right: -0.6em; }
${p} .center .sub { font-size: 11px; letter-spacing: 0.4em; margin-right: -0.4em; opacity: 0.85; }`

export class HomeMarker {
  private readonly el: HTMLElement
  private readonly tick: HTMLElement
  private readonly chev: HTMLElement
  private readonly km: HTMLElement
  private lastKm = ""

  constructor(root: HTMLElement) {
    this.el = root.querySelector<HTMLElement>(".home")!
    this.tick = root.querySelector<HTMLElement>(".home .tick")!
    this.chev = root.querySelector<HTMLElement>(".home .chev")!
    this.km = root.querySelector<HTMLElement>(".home .km")!
  }

  set color(c: string) { this.el.style.setProperty("--home", c) }

  update(h: HomeMarkerView | null): void {
    this.el.hidden = !h
    if (!h) return
    this.el.style.transform = `translate(${h.x.toFixed(1)}px, ${h.y.toFixed(1)}px)`
    this.tick.hidden = !h.on; this.chev.hidden = h.on
    if (h.on) this.km.style.transform = "translate(-50%, 15px)"
    else {
      this.chev.style.transform = `rotate(${h.angle.toFixed(3)}rad)`
      this.km.style.transform = `translate(calc(-50% + ${(-Math.cos(h.angle) * 22).toFixed(0)}px), ${(-Math.sin(h.angle) * 16 - 5).toFixed(0)}px)`
    }
    const km = h.km < 10 ? h.km.toFixed(1) : Math.round(h.km).toString()
    if (km !== this.lastKm) { this.lastKm = km; this.km.textContent = `${km} KM` }
  }
}

export class CenterCard {
  private readonly card: HTMLElement
  private readonly title: HTMLElement
  private readonly sub: HTMLElement
  constructor(root: HTMLElement) {
    this.card = root.querySelector<HTMLElement>(".center")!
    this.title = root.querySelector<HTMLElement>(".center .title")!
    this.sub = root.querySelector<HTMLElement>(".center .sub")!
  }
  show(title: string | null, sub = ""): void {
    this.card.hidden = !title
    if (title) { this.title.textContent = title; this.sub.textContent = sub }
  }
}
