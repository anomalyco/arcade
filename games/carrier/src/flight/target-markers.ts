import { DECK_Y } from "../../shared/carrier-spec"
import { teamCss } from "../../shared/crew"
import { RADAR, type RadarScene, hostile, sinking } from "./radar"

type Projector = {
  project(x: number, y: number, z: number, w: number, h: number): { x: number; y: number } | null
  eye: ArrayLike<number>
  forward: ArrayLike<number>
  up: ArrayLike<number>
}

const CSS = `
#tmk { position: fixed; inset: 0; pointer-events: none; font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace; font-weight: 300;
  text-transform: uppercase; text-shadow: 0 0 2px rgba(6, 16, 30, 0.95), 0 1px 6px rgba(6, 16, 30, 0.7); }
#tmk[hidden], #tmk [hidden] { display: none !important; }
#tmk .m { position: absolute; left: 0; top: 0; will-change: transform; }
#tmk .m i { position: absolute; display: block; filter: drop-shadow(0 0 1px rgba(6, 16, 30, 0.95)) drop-shadow(0 0 2px rgba(6, 16, 30, 0.6)); }
#tmk .m span { position: absolute; left: 0; transform: translateX(-50%); font-size: 10px; letter-spacing: 0.2em; white-space: nowrap; font-variant-numeric: tabular-nums; opacity: 0.9; }
#tmk .ship i { left: -11px; top: -8px; width: 22px; height: 16px; }
#tmk .ship i::before, #tmk .ship i::after { content: ""; position: absolute; top: 0; bottom: 0; width: 5px; border: 2px solid currentColor; }
#tmk .ship i::before { left: 0; border-right: 0; }
#tmk .ship i::after { right: 0; border-left: 0; }
#tmk .ship span { top: 11px; }
#tmk .jet i { left: -6px; top: -6px; width: 12px; height: 12px; box-sizing: border-box; border: 2px solid currentColor; transform: rotate(45deg); }
#tmk .jet span { top: 11px; }
#tmk .boat i { left: -4px; top: -4px; width: 8px; height: 8px; box-sizing: border-box; border: 2px solid currentColor; transform: rotate(45deg); }
#tmk .boat span { top: 8px; }
#tmk .edge i { left: -8px; top: -8px; width: 16px; height: 16px; }
#tmk .edge i::before { content: ""; position: absolute; left: 2px; top: 4px; width: 8px; height: 8px; border: solid currentColor; border-width: 2px 2px 0 0; transform: rotate(45deg); }
#tmk .edge span { top: 0; font-size: 10px; }
body.mn-open #tmk { display: none; }
`

type Mark = { el: HTMLElement; icon: HTMLElement; label: HTMLElement; kind: string; text: string; color: string }

const km = (m: number) => (m < 10_000 ? (m / 1000).toFixed(1) : Math.round(m / 1000).toString())

/**
 * Target markers on screen while flying, no instruction text: corner brackets on enemy carriers in view, small
 * diamonds on enemy jets (within `RADAR.markerJets` km) and boats (within 4 km), each in its carrier's colour with its
 * distance; and when the nearest enemy carrier is out of view, a chevron at the screen edge pointing to it (like the
 * home marker for ours).
 */
export class TargetMarkers {
  readonly root: HTMLElement
  private pool: Mark[] = []
  private used = 0

  constructor(parent: HTMLElement = document.body) {
    if (!document.getElementById("tmk-css")) {
      const style = document.createElement("style")
      style.id = "tmk-css"
      style.textContent = CSS
      document.head.append(style)
    }
    const root = document.createElement("div")
    root.id = "tmk"
    parent.append(root)
    this.root = root
  }

  private mark(kind: string, x: number, y: number, color: string, text: string, angle = 0): void {
    let m = this.pool[this.used]
    if (!m) {
      const el = document.createElement("div")
      const icon = document.createElement("i")
      const label = document.createElement("span")
      el.append(icon, label)
      this.root.append(el)
      m = { el, icon, label, kind: "", text: "", color: "" }
      this.pool.push(m)
    }
    this.used++
    m.el.hidden = false
    if (m.kind !== kind) {
      m.kind = kind
      m.el.className = `m ${kind}`
      m.icon.style.transform = ""
      m.label.style.transform = ""
    }
    if (m.color !== color) m.el.style.color = m.color = color
    if (m.text !== text) m.label.textContent = m.text = text
    m.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
    if (kind === "edge") {
      m.icon.style.transform = `rotate(${angle.toFixed(3)}rad)`
      m.label.style.transform = `translate(calc(-50% + ${(-Math.cos(angle) * 24).toFixed(0)}px), ${(-Math.sin(angle) * 18 - 6).toFixed(0)}px)`
    }
  }

  /** Per frame: the markers for `s` through the flight camera, or none (`cam` null: not flying). The edge arrow stays
   *  clear of `avoid`, the radar's corner (its right edge and top, CSS px). */
  update(s: RadarScene, cam: Projector | null, avoid: { right: number; top: number } | null = null): void {
    this.used = 0
    const jet = s.jet
    if (RADAR.markers && cam && jet && s.me) {
      const w = innerWidth
      const h = innerHeight
      const inView = (p: { x: number; y: number } | null) => !!p && p.x > 0 && p.x < w && p.y > 0 && p.y < h
      let near: { x: number; y: number; z: number; d: number; color: string } | null = null
      for (const ship of s.ships) {
        if (!hostile(s.me, ship.team) || sinking(s.hulls, ship.id)) continue
        const y = ship.heave + DECK_Y + 8
        const d = Math.hypot(ship.x - jet.x, y - jet.y, ship.z - jet.z)
        const color = teamCss(ship.team)
        const p = cam.project(ship.x, y, ship.z, w, h)
        if (inView(p)) this.mark("ship", p!.x, p!.y, color, `${km(d)} KM`)
        if (!near || d < near.d) near = { x: ship.x, y, z: ship.z, d, color }
      }
      if (near && RADAR.markerArrow) {
        const p = cam.project(near.x, near.y, near.z, w, h)
        const margin = 46
        if (!p || p.x < margin || p.x > w - margin || p.y < margin || p.y > h - margin) {
          // The direction in the camera's own frame, onto the screen border.
          const e = cam.eye
          const f = cam.forward
          const u = cam.up
          const dx = near.x - e[0]!
          const dy = near.y - e[1]!
          const dz = near.z - e[2]!
          const rx = f[1]! * u[2]! - f[2]! * u[1]!
          const ry = f[2]! * u[0]! - f[0]! * u[2]!
          const rz = f[0]! * u[1]! - f[1]! * u[0]!
          let sx = dx * rx + dy * ry + dz * rz
          let sy = -(dx * u[0]! + dy * u[1]! + dz * u[2]!)
          if (Math.hypot(sx, sy) < 1e-6) sy = 1
          const l = Math.hypot(sx, sy)
          sx /= l
          sy /= l
          const k = Math.min((w / 2 - margin) / Math.max(1e-6, Math.abs(sx)), (h / 2 - margin) / Math.max(1e-6, Math.abs(sy)))
          let x = w / 2 + sx * k
          let y = h / 2 + sy * k
          // Over the radar's corner: slide along the border to just above it or just right of it, whichever is nearer.
          if (avoid && x < avoid.right + margin && y > avoid.top - margin) {
            const up = avoid.top - margin - 10
            const right = avoid.right + margin + 10
            if (y - up < right - x) {
              x = margin
              y = up
            } else {
              x = right
              y = h - margin
            }
          }
          this.mark("edge", x, y, near.color, `${km(near.d)} KM`, Math.atan2(sy, sx))
        }
      }
      const jetRange = RADAR.markerJets * 1000
      for (const j of s.jets.values()) {
        if (!j.alive || !hostile(s.me, j.team, j.id)) continue
        const d = Math.hypot(j.x - jet.x, j.y - jet.y, j.z - jet.z)
        if (d > jetRange) continue
        const p = cam.project(j.x, j.y, j.z, w, h)
        if (inView(p)) this.mark("jet", p!.x, p!.y, teamCss(j.team), `${km(d)}`)
      }
      for (const b of s.boats) {
        if (!b.alive || !hostile(s.me, b.team, b.id)) continue
        const d = Math.hypot(b.x - jet.x, b.y - jet.y, b.z - jet.z)
        if (d > 4000) continue
        const p = cam.project(b.x, b.y + 3, b.z, w, h)
        if (inView(p)) this.mark("boat", p!.x, p!.y, teamCss(b.team), `${km(d)}`)
      }
    }
    for (let i = this.used; i < this.pool.length; i++) {
      const m = this.pool[i]!
      if (!m.el.hidden) m.el.hidden = true
    }
  }
}
