import type { City } from "../../shared/sim/city"
import type { WorldView } from "../../shared/sim/world"
import type { Camera } from "../game/camera"

const SIZE = 196
/** Meters from the center of the map to its rim. */
const RANGE = 150
const PX = 2
const MARGIN = 40

/**
 * Round minimap, turned so "up" is the camera's forward and centered on your car. Cops always see each other.
 * The driver shows up live whenever any cop has them on screen; otherwise cops get the last-seen ping.
 * Anything important beyond the rim gets an arrow on the edge pointing the way.
 */
export class Minimap {
  readonly el: HTMLDivElement
  private canvas: HTMLCanvasElement
  private g: CanvasRenderingContext2D
  private base: HTMLCanvasElement
  private ox: number
  private oz: number
  private t = 0

  constructor(
    parent: HTMLElement,
    private city: City,
  ) {
    this.el = document.createElement("div")
    this.el.className = "h-map"
    this.canvas = document.createElement("canvas")
    const dpr = Math.min(2, devicePixelRatio || 1)
    this.canvas.width = this.canvas.height = SIZE * dpr
    this.canvas.style.width = this.canvas.style.height = `${SIZE}px`
    this.el.appendChild(this.canvas)
    parent.appendChild(this.el)
    this.g = this.canvas.getContext("2d")!
    this.g.scale(dpr, dpr)
    this.ox = -MARGIN
    this.oz = -MARGIN
    this.base = this.paintBase()
  }

  /** The static city, drawn once at PX pixels per meter. */
  private paintBase() {
    const c = this.city
    const w = (c.max + MARGIN * 2) * PX
    const hgt = (c.waterZ + 60 + MARGIN) * PX
    const cv = document.createElement("canvas")
    cv.width = w
    cv.height = hgt
    const g = cv.getContext("2d")!
    const X = (x: number) => (x - this.ox) * PX
    const Z = (z: number) => (z - this.oz) * PX
    g.fillStyle = "#151a26"
    g.fillRect(0, 0, w, hgt)
    g.fillStyle = "#0b1a2a"
    g.fillRect(0, Z(c.waterZ), w, hgt)
    // Roads: everything that isn't a block reads as street.
    g.fillStyle = "#3a4256"
    g.fillRect(X(-8), Z(-8), (c.max + 8) * PX, (c.waterZ + 8) * PX)
    for (const p of c.parks) {
      g.fillStyle = "#1d3324"
      g.fillRect(X(p.x0), Z(p.z0), (p.x1 - p.x0) * PX, (p.z1 - p.z0) * PX)
    }
    for (const b of c.boxes) {
      if (b.kind === "wall") continue
      g.fillStyle = b.kind === "special" ? "#2a3142" : "#1b2030"
      g.fillRect(X(b.x0), Z(b.z0), (b.x1 - b.x0) * PX, (b.z1 - b.z0) * PX)
    }
    return cv
  }

  update(
    view: Pick<WorldView, "cars" | "robberId" | "phase" | "t"> & { heli?: WorldView["heli"]; props?: WorldView["props"]; tip?: WorldView["tip"]; shopCool?: number[] },
    cam: Camera,
    myId: string,
    dt: number,
  ) {
    this.t += dt
    const g = this.g
    const r = SIZE / 2
    const scale = r / RANGE
    const me = view.cars.find((c) => c.ownerId === myId && !c.ghost)
    const cx = me?.x ?? cam.fx
    const cz = me?.z ?? cam.fz
    const { fwd, right } = cam.axes()
    // World point -> map pixels (origin at the map center).
    const toMap = (x: number, z: number): [number, number] => {
      const dx = x - cx
      const dz = z - cz
      return [(dx * right[0] + dz * right[1]) * scale, -(dx * fwd[0] + dz * fwd[1]) * scale]
    }

    g.clearRect(0, 0, SIZE, SIZE)
    g.save()
    g.beginPath()
    g.arc(r, r, r - 1, 0, Math.PI * 2)
    g.clip()
    g.fillStyle = "#151a26"
    g.fillRect(0, 0, SIZE, SIZE)
    // City layer: world (x, z) maps to (dot(d, right), -dot(d, fwd)), a rotation (plus a mirror) of the base image.
    g.save()
    g.translate(r, r)
    g.transform(right[0] * scale, -fwd[0] * scale, right[1] * scale, -fwd[1] * scale, 0, 0)
    g.translate(-cx, -cz)
    g.drawImage(this.base, this.ox, this.oz, this.base.width / PX, this.base.height / PX)
    g.restore()

    const iAmCop = me?.role === "cop"
    const robber = view.cars.find((c) => c.ownerId === view.robberId)
    const arrows: { x: number; z: number; color: string }[] = []

    // Dispatch tip: a broad dashed circle the driver is somewhere inside. Fades over the minute until the next tip.
    const tip = view.tip
    if (tip && view.phase === "chase") {
      const [tx, ty] = toMap(tip.x, tip.z)
      const age = Math.max(0, view.t - tip.t)
      const fade = Math.max(0.35, 1 - age / 60)
      const fresh = age < 3 ? 0.5 + 0.5 * Math.sin(age * 12) : 0
      g.fillStyle = `rgba(255, 138, 31, ${(0.1 + 0.1 * fresh) * fade})`
      g.strokeStyle = `rgba(255, 138, 31, ${0.7 * fade})`
      g.lineWidth = 1.5
      g.setLineDash([5, 4])
      g.beginPath()
      g.arc(r + tx, r + ty, tip.r * scale, 0, Math.PI * 2)
      g.fill()
      g.stroke()
      g.setLineDash([])
      if (Math.hypot(tx, ty) - tip.r * scale > r - 6) arrows.push({ x: tip.x, z: tip.z, color: `rgba(255, 138, 31, ${0.6 * fade})` })
    }

    // Helicopter spotlight.
    if (view.heli?.active) {
      const [hx, hy] = toMap(view.heli.sx, view.heli.sz)
      g.fillStyle = "rgba(200, 220, 255, 0.18)"
      g.beginPath()
      g.arc(r + hx, r + hy, 12 * scale, 0, Math.PI * 2)
      g.fill()
    }

    // Spike strips: a short yellow bar across the road (drawn a little longer than life so it reads at this scale).
    g.strokeStyle = "#ffc93a"
    g.lineWidth = 2.5
    g.lineCap = "round"
    for (const p of view.props ?? []) {
      if (p.kind !== "spike") continue
      const half = Math.max(p.r, 9)
      const ax = Math.cos(p.h) * half
      const az = -Math.sin(p.h) * half
      const [x0, y0] = toMap(p.x - ax, p.z - az)
      const [x1, y1] = toMap(p.x + ax, p.z + az)
      if (Math.hypot(x0 + x1, y0 + y1) / 2 > r - 4) continue
      g.beginPath()
      g.moveTo(r + x0, r + y0)
      g.lineTo(r + x1, r + y1)
      g.stroke()
    }
    g.lineCap = "butt"

    // Repair shops: a wrench for everyone. A driver with flat tires sees them lit (dim while a shop is cooling down)
    // and gets an edge arrow to the nearest working one.
    const flats = me && me.ownerId === view.robberId && view.phase === "chase" ? (me.wheels ?? 0) : 0
    let nearest: { x: number; z: number } | null = null
    let nd = Infinity
    this.city.shops.forEach((s, i) => {
      const busy = (view.shopCool?.[i] ?? 0) > 0
      const [x, y] = toMap(s.x, s.z)
      if (flats && !busy) {
        const d = Math.hypot(s.x - cx, s.z - cz)
        if (d < nd) {
          nd = d
          nearest = s
        }
      }
      if (Math.hypot(x, y) > r - 6) return
      if (flats && !busy) {
        const pulse = (this.t * 1.2) % 1
        g.strokeStyle = `rgba(79, 240, 200, ${0.7 * (1 - pulse)})`
        g.lineWidth = 1.5
        g.beginPath()
        g.arc(r + x, r + y, 5 + pulse * 8, 0, Math.PI * 2)
        g.stroke()
      }
      wrench(g, r + x, r + y, flats ? (busy ? "rgba(79, 240, 200, 0.35)" : "#4ff0c8") : "rgba(200, 215, 235, 0.7)")
    })
    if (nearest) {
      const n: { x: number; z: number } = nearest
      const [x, y] = toMap(n.x, n.z)
      if (Math.hypot(x, y) > r - 6) arrows.push({ x: n.x, z: n.z, color: "#4ff0c8" })
    }

    for (const c of view.cars) {
      if (c === me || c.role !== "cop") continue
      const [x, y] = toMap(c.x, c.z)
      if (Math.hypot(x, y) > r - 4) continue
      dot(g, r + x, r + y, 3.6, "#3d7bff", "rgba(10, 20, 50, 0.9)")
    }

    // A dark driver you can only see with your own eyes stays off the radar.
    if (robber && robber !== me && view.phase !== "waiting" && (robber.ghost || robber.radar !== false)) {
      const [x, y] = toMap(robber.x, robber.z)
      const inside = Math.hypot(x, y) < r - 6
      if (!robber.ghost) {
        // Someone has eyes on the driver: live position for every cop.
        if (inside) {
          const pulse = (this.t * 1.6) % 1
          g.strokeStyle = `rgba(255, 138, 31, ${0.8 * (1 - pulse)})`
          g.lineWidth = 1.5
          g.beginPath()
          g.arc(r + x, r + y, 4 + pulse * 10, 0, Math.PI * 2)
          g.stroke()
          dot(g, r + x, r + y, 4.5, "#ff8a1f", "#1a0c02")
        } else arrows.push({ x: robber.x, z: robber.z, color: "#ff8a1f" })
      } else if (iAmCop) {
        // Out of sight: the last place anyone saw them.
        if (inside) {
          g.strokeStyle = "rgba(255, 138, 31, 0.55)"
          g.setLineDash([2, 3])
          g.lineWidth = 1.2
          g.beginPath()
          g.arc(r + x, r + y, 7, 0, Math.PI * 2)
          g.stroke()
          g.setLineDash([])
          g.fillStyle = "rgba(255, 138, 31, 0.55)"
          g.font = "600 9px 'Barlow Condensed', sans-serif"
          g.textAlign = "center"
          g.fillText("?", r + x, r + y + 3)
        } else arrows.push({ x: robber.x, z: robber.z, color: "rgba(255, 138, 31, 0.5)" })
      }
    }

    // You: a triangle pointing along your heading.
    if (me) {
      const a = Math.atan2(Math.sin(me.h) * right[0] + Math.cos(me.h) * right[1], Math.sin(me.h) * fwd[0] + Math.cos(me.h) * fwd[1])
      g.save()
      g.translate(r, r)
      g.rotate(a)
      g.beginPath()
      g.moveTo(0, -7)
      g.lineTo(5, 5)
      g.lineTo(0, 2.5)
      g.lineTo(-5, 5)
      g.closePath()
      g.fillStyle = "#fff"
      g.strokeStyle = me.role === "robber" && view.phase !== "waiting" ? "#ff8a1f" : "rgba(0,0,0,0.7)"
      g.lineWidth = 1.5
      g.fill()
      g.stroke()
      g.restore()
    }
    g.restore()

    // Rim and edge arrows.
    g.strokeStyle = "rgba(255, 255, 255, 0.22)"
    g.lineWidth = 1.5
    g.beginPath()
    g.arc(r, r, r - 1, 0, Math.PI * 2)
    g.stroke()
    for (const a of arrows) {
      const [x, y] = toMap(a.x, a.z)
      const ang = Math.atan2(y, x)
      g.save()
      g.translate(r + Math.cos(ang) * (r - 9), r + Math.sin(ang) * (r - 9))
      g.rotate(ang + Math.PI / 2)
      g.beginPath()
      g.moveTo(0, -8)
      g.lineTo(7, 4)
      g.lineTo(-7, 4)
      g.closePath()
      g.fillStyle = a.color
      g.strokeStyle = "rgba(0,0,0,0.6)"
      g.lineWidth = 1
      g.fill()
      g.stroke()
      g.restore()
    }
  }
}

/** A small wrench icon centered on (x, y): a handle with an open jaw at the top right. */
function wrench(g: CanvasRenderingContext2D, x: number, y: number, color: string) {
  g.save()
  g.translate(x, y)
  g.rotate(-Math.PI / 4)
  g.fillStyle = "rgba(5, 7, 11, 0.75)"
  g.beginPath()
  g.arc(0, 0, 6.5, 0, Math.PI * 2)
  g.fill()
  g.fillStyle = color
  g.fillRect(-1.1, -1, 2.2, 6)
  g.beginPath()
  g.arc(0, -2.6, 2.8, 0, Math.PI * 2)
  g.fill()
  g.fillStyle = "rgba(5, 7, 11, 1)"
  g.fillRect(-1, -6, 2, 3.2)
  g.restore()
}

function dot(g: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, stroke: string) {
  g.beginPath()
  g.arc(x, y, r, 0, Math.PI * 2)
  g.fillStyle = fill
  g.strokeStyle = stroke
  g.lineWidth = 1.5
  g.fill()
  g.stroke()
}

