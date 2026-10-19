import type { Hunter } from "./brain"
import { GRID, NX, NZ, CELL, type NavGraph, STOREYS, storeyOf } from "./nav"

// The hunter's debug overlay (Lab → Hunter → "Hunter debug overlay"): a top-down map of the creature's storey with the
// nav grid (walkable cells, door openings, rooms, the stair), the creature, its vision cone (range by the light on the
// player), its route and the doors on it, what it heard (rings: the noise's radius at its source, filled where it was
// heard, a cross at the position it heard), its memory of the player, and its state. `trace()` renders the same map
// larger with both trails (creature coloured by state, player in white) for reports.

const MODE_COLOUR: Record<string, string> = {
  roam: "#7fa7ff",
  investigate: "#ffd040",
  hunt: "#ff3030",
  search: "#ff8a20",
  ambush: "#c070ff",
  caught: "#ffffff",
  dormant: "#666",
}

export type PlayerTrail = { t: number; x: number; z: number; s: number }[]

export class HunterDebug {
  readonly canvas: HTMLCanvasElement
  private bases: (HTMLCanvasElement | null)[] = []
  private at = 0
  private shown = false

  constructor(
    private hunter: Hunter,
    private nav: NavGraph,
    private playerTrail: PlayerTrail,
    private ppm = 6,
  ) {
    const c = (this.canvas = document.createElement("canvas"))
    c.width = Math.round((GRID.X1 - GRID.X0) * ppm)
    c.height = Math.round((GRID.Z1 - GRID.Z0) * ppm) + 34
    c.style.cssText = "position:fixed;right:8px;top:8px;z-index:50;pointer-events:none;border:1px solid #444;background:rgba(0,0,0,0.72);display:none;image-rendering:pixelated"
    document.body.appendChild(c)
  }

  private base(s: number, ppm: number) {
    const cv = document.createElement("canvas")
    cv.width = Math.round((GRID.X1 - GRID.X0) * ppm)
    cv.height = Math.round((GRID.Z1 - GRID.Z0) * ppm)
    const g = cv.getContext("2d")!
    const grid = this.nav.grids[s]!
    const img = g.createImageData(NX, NZ)
    for (let k = 0; k < NZ; k++)
      for (let i = 0; i < NX; i++) {
        const c = k * NX + i
        const o = c * 4
        if (!grid.walk[c]) continue
        const main = grid.comp[c] === grid.main
        const door = grid.door[c]! >= 0
        const cl = grid.clear[c]!
        img.data[o] = door ? 200 : main ? 46 + cl * 6 : 70
        img.data[o + 1] = door ? 150 : main ? 56 + cl * 6 : 30
        img.data[o + 2] = door ? 40 : main ? 52 + cl * 6 : 30
        img.data[o + 3] = 255
      }
    const tmp = document.createElement("canvas")
    tmp.width = NX
    tmp.height = NZ
    tmp.getContext("2d")!.putImageData(img, 0, 0)
    g.imageSmoothingEnabled = false
    g.drawImage(tmp, 0, 0, cv.width, cv.height)
    g.strokeStyle = "rgba(160,200,160,0.35)"
    g.lineWidth = 1
    g.font = `${Math.max(8, ppm * 1.4)}px monospace`
    g.fillStyle = "rgba(190,220,190,0.55)"
    for (const r of this.nav.rooms) {
      if (r.s !== s) continue
      g.strokeRect((r.rect.x0 - GRID.X0) * ppm, (r.rect.z0 - GRID.Z0) * ppm, (r.rect.x1 - r.rect.x0) * ppm, (r.rect.z1 - r.rect.z0) * ppm)
      if (ppm >= 6) g.fillText(r.id, (r.rect.x0 - GRID.X0) * ppm + 2, (r.rect.z0 - GRID.Z0) * ppm + ppm * 1.6)
    }
    // Door openings (closed pose) and the stair links.
    g.strokeStyle = "#e0b040"
    g.lineWidth = Math.max(1, ppm * 0.25)
    for (const d of this.nav.doors) {
      if (d.s !== s) continue
      g.beginPath()
      g.moveTo((d.ax - GRID.X0) * ppm, (d.az - GRID.Z0) * ppm)
      g.lineTo((d.bx - GRID.X0) * ppm, (d.bz - GRID.Z0) * ppm)
      g.stroke()
    }
    g.strokeStyle = "#60e0e0"
    for (const fl of this.nav.stairs) {
      if (fl[0]!.s !== s && fl[fl.length - 1]!.s !== s) continue
      g.beginPath()
      fl.forEach((p, i) => (i ? g.lineTo : g.moveTo).call(g, (p.x - GRID.X0) * ppm, (p.z - GRID.Z0) * ppm))
      g.stroke()
    }
    return cv
  }

  private baseFor(s: number) {
    return (this.bases[s] ??= this.base(s, this.ppm))
  }

  set visible(on: boolean) {
    if (on === this.shown) return
    this.shown = on
    this.canvas.style.display = on ? "block" : "none"
  }

  update(now: number) {
    if (!this.shown || now - this.at < 1 / 15) return
    this.at = now
    const h = this.hunter
    const s = h.mode === "dormant" ? storeyOf(h.player.state.pos.y) : h.s
    const g = this.canvas.getContext("2d")!
    g.clearRect(0, 0, this.canvas.width, this.canvas.height)
    g.drawImage(this.baseFor(s), 0, 34)
    g.save()
    g.translate(0, 34)
    this.drawLive(g, s, this.ppm, true)
    g.restore()
    // Header: state, storey dots, awareness.
    g.fillStyle = "#000"
    g.fillRect(0, 0, this.canvas.width, 34)
    g.font = "12px monospace"
    g.fillStyle = MODE_COLOUR[h.mode] ?? "#fff"
    const ps = storeyOf(h.player.state.pos.y)
    g.fillText(`HUNTER ${h.mode.toUpperCase()}  storey ${h.s}  aware ${h.awareness.toFixed(2)}  sight ${h.sightRange.toFixed(1)} m${h.seeing ? "  SEES YOU" : ""}${h.grace > 0 ? `  grace ${h.grace.toFixed(1)}` : ""}`, 6, 13)
    g.fillStyle = "#aaa"
    const route = h.route ? `${h.route.length.toFixed(0)} m, ${h.route.doors.length} doors` : "-"
    g.fillText(`route ${route}  heard ${h.heard.filter((e) => e.heard && h.time - e.t < 10).length}/10s  you: storey ${ps}`, 6, 28)
    for (let i = 0; i < STOREYS; i++) {
      const x = this.canvas.width - 14 - (STOREYS - 1 - i) * 14
      g.strokeStyle = "#666"
      g.strokeRect(x - 5, 4, 10, 10)
      if (i === h.s) {
        g.fillStyle = MODE_COLOUR[h.mode] ?? "#f00"
        g.fillRect(x - 4, 5, 8, 8)
      }
      if (i === ps) {
        g.fillStyle = "#fff"
        g.fillRect(x - 2, 18, 4, 4)
      }
    }
  }

  /** Creature, cone, route, noises, memory and the player on storey `s`. */
  private drawLive(g: CanvasRenderingContext2D, s: number, ppm: number, live: boolean) {
    const h = this.hunter
    const X = (x: number) => (x - GRID.X0) * ppm
    const Z = (z: number) => (z - GRID.Z0) * ppm
    // Heard noises (last 12 s).
    for (const e of h.heard) {
      const age = h.time - e.t
      if (age > 12 || e.s !== s) continue
      const a = 1 - age / 12
      g.strokeStyle = e.heard ? `rgba(255,170,40,${a})` : `rgba(150,150,150,${a * 0.6})`
      g.lineWidth = 1
      g.beginPath()
      g.arc(X(e.e.x), Z(e.e.z), Math.max(2, e.e.radius * ppm * 0.5), 0, Math.PI * 2)
      g.stroke()
      if (e.heard) {
        g.strokeStyle = `rgba(255,120,0,${a})`
        g.beginPath()
        g.moveTo(X(e.x) - 4, Z(e.z) - 4)
        g.lineTo(X(e.x) + 4, Z(e.z) + 4)
        g.moveTo(X(e.x) + 4, Z(e.z) - 4)
        g.lineTo(X(e.x) - 4, Z(e.z) + 4)
        g.stroke()
      }
    }
    if (h.mode === "dormant") return
    // Route and its doors.
    const r = h.route
    if (r && live) {
      g.strokeStyle = "rgba(80,230,255,0.9)"
      g.lineWidth = 1.5
      g.beginPath()
      let on = h.s === s
      if (on) g.moveTo(X(h.pos.x), Z(h.pos.z))
      for (let i = h.wp; i < r.pts.length; i++) {
        const p = r.pts[i]!
        if (p.s !== s) {
          on = false
          continue
        }
        if (on) g.lineTo(X(p.x), Z(p.z))
        else g.moveTo(X(p.x), Z(p.z))
        on = true
      }
      g.stroke()
      for (const e of r.doors) {
        const d = this.nav.doors[e.door]!
        if (d.s !== s) continue
        g.fillStyle = d.h.amount > 0.5 ? "#40ff80" : "#ff4040"
        g.fillRect(X(d.cx) - 3, Z(d.cz) - 3, 6, 6)
      }
    }
    // Memory of the player.
    const m = h.memory
    if (m && m.s === s) {
      g.strokeStyle = m.seen ? "#ff40ff" : "#c080c0"
      g.lineWidth = 2
      g.beginPath()
      g.moveTo(X(m.x) - 5, Z(m.z) - 5)
      g.lineTo(X(m.x) + 5, Z(m.z) + 5)
      g.moveTo(X(m.x) + 5, Z(m.z) - 5)
      g.lineTo(X(m.x) - 5, Z(m.z) + 5)
      g.stroke()
    }
    if (h.s === s && live) {
      // Vision cone. Screen x = world x, screen y = world z; heading 0 faces +z.
      const a0 = Math.PI / 2 - h.heading
      g.fillStyle = h.seeing ? "rgba(255,40,40,0.28)" : "rgba(255,255,160,0.12)"
      g.beginPath()
      g.moveTo(X(h.pos.x), Z(h.pos.z))
      g.arc(X(h.pos.x), Z(h.pos.z), h.sightRange * ppm, a0 - h.cone, a0 + h.cone)
      g.closePath()
      g.fill()
      g.fillStyle = MODE_COLOUR[h.mode] ?? "#f00"
      g.beginPath()
      g.arc(X(h.pos.x), Z(h.pos.z), Math.max(3, 0.5 * ppm), 0, Math.PI * 2)
      g.fill()
      g.strokeStyle = "#000"
      g.beginPath()
      g.moveTo(X(h.pos.x), Z(h.pos.z))
      g.lineTo(X(h.pos.x + Math.sin(h.heading) * 1.2), Z(h.pos.z + Math.cos(h.heading) * 1.2))
      g.stroke()
    }
    const p = h.player.state.pos
    if (storeyOf(p.y) === s && live) {
      g.fillStyle = "#fff"
      g.beginPath()
      g.arc(X(p.x), Z(p.z), Math.max(2.5, 0.35 * ppm), 0, Math.PI * 2)
      g.fill()
    }
  }

  /** A large top-down picture of storey `s` (or the creature's) with both trails since `since` (s, hunter clock). */
  trace(s = this.hunter.s, ppm = 10, since = 0) {
    const base = this.base(s, ppm)
    const cv = document.createElement("canvas")
    cv.width = base.width
    cv.height = base.height + 24
    const g = cv.getContext("2d")!
    g.fillStyle = "#000"
    g.fillRect(0, 0, cv.width, cv.height)
    g.drawImage(base, 0, 24)
    g.translate(0, 24)
    const X = (x: number) => (x - GRID.X0) * ppm
    const Z = (z: number) => (z - GRID.Z0) * ppm
    const h = this.hunter
    g.lineWidth = 2.5
    for (let i = 1; i < h.trail.length; i++) {
      const a = h.trail[i - 1]!
      const b = h.trail[i]!
      if (b.t < since || a.s !== s || b.s !== s || Math.hypot(b.x - a.x, b.z - a.z) > 3) continue
      g.strokeStyle = MODE_COLOUR[b.mode] ?? "#f00"
      g.beginPath()
      g.moveTo(X(a.x), Z(a.z))
      g.lineTo(X(b.x), Z(b.z))
      g.stroke()
    }
    g.strokeStyle = "rgba(255,255,255,0.9)"
    g.lineWidth = 1.5
    g.setLineDash([4, 3])
    const pt = this.playerTrail
    for (let i = 1; i < pt.length; i++) {
      const a = pt[i - 1]!
      const b = pt[i]!
      if (b.t < since || a.s !== s || b.s !== s || Math.hypot(b.x - a.x, b.z - a.z) > 3) continue
      g.beginPath()
      g.moveTo(X(a.x), Z(a.z))
      g.lineTo(X(b.x), Z(b.z))
      g.stroke()
    }
    g.setLineDash([])
    this.drawLive(g, s, ppm, true)
    g.translate(0, -24)
    g.fillStyle = "#ddd"
    g.font = "14px monospace"
    let x = 8
    g.fillText(`storey ${s}`, x, 16)
    x += 90
    for (const [m, c] of Object.entries(MODE_COLOUR)) {
      if (m === "dormant") continue
      g.fillStyle = c
      g.fillRect(x, 6, 18, 10)
      g.fillStyle = "#ddd"
      g.fillText(m, x + 22, 16)
      x += 30 + m.length * 9
    }
    g.fillStyle = "#fff"
    g.fillText("- - player", x, 16)
    void CELL
    return cv.toDataURL("image/png")
  }

  dispose() {
    this.canvas.remove()
  }
}
