import { ROAD_HALF } from "../../shared/config"
import type { City } from "../../shared/sim/city"
import type { CarView, WorldView } from "../../shared/sim/world"
import type { Camera } from "../game/camera"

const SIZE = 216
/** Pixels per meter on the minimap. */
const SCALE = 0.62
/** Resolution of the pre-rendered static city layer, in pixels per meter. */
const BAKE = 2

const ROBBER = "#ff8a1f"
const COP = "#3d7bff"
const GO = "#36f07a"
const THREAT = "#ff3b3b"

/**
 * Circular minimap. The static city is baked once into an offscreen canvas in world space, then drawn each
 * frame through a transform that centers it on the focus car and turns it so map-up matches the camera's forward.
 */
export class Minimap {
  readonly el: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private bake: HTMLCanvasElement
  private dpr = 1
  private minX: number
  private minZ: number

  constructor(
    parent: HTMLElement,
    private city: City,
  ) {
    this.el = document.createElement("canvas")
    this.el.className = "map-canvas"
    parent.appendChild(this.el)
    this.ctx = this.el.getContext("2d")!
    this.minX = -ROAD_HALF - 40
    this.minZ = -ROAD_HALF - 40
    this.bake = this.bakeCity()
    this.resize()
  }

  private resize() {
    const dpr = Math.min(2, devicePixelRatio || 1)
    if (dpr === this.dpr && this.el.width) return
    this.dpr = dpr
    this.el.width = SIZE * dpr
    this.el.height = SIZE * dpr
  }

  private bakeCity() {
    const c = this.city
    const w = c.max + 80 - this.minX
    const d = c.waterZ + 80 - this.minZ
    const cv = document.createElement("canvas")
    cv.width = Math.ceil(w * BAKE)
    cv.height = Math.ceil(d * BAKE)
    const g = cv.getContext("2d")!
    g.scale(BAKE, BAKE)
    g.translate(-this.minX, -this.minZ)
    // Water to the south.
    g.fillStyle = "#0b1a2a"
    g.fillRect(this.minX, c.waterZ, w, 80)
    // Ground.
    g.fillStyle = "#151a22"
    g.fillRect(-ROAD_HALF, -ROAD_HALF, c.max + ROAD_HALF, c.waterZ + ROAD_HALF)
    for (const p of c.parks) {
      g.fillStyle = "#14261c"
      g.fillRect(p.x0, p.z0, p.x1 - p.x0, p.z1 - p.z0)
    }
    // Roads from the node graph.
    g.strokeStyle = "#3a4250"
    g.lineWidth = ROAD_HALF * 2
    g.lineCap = "square"
    g.beginPath()
    c.adj.forEach((links, i) => {
      const a = c.nodes[i]!
      for (const j of links) {
        if (j < i) continue
        const b = c.nodes[j]!
        g.moveTo(a.x, a.z)
        g.lineTo(b.x, b.z)
      }
    })
    g.stroke()
    g.strokeStyle = "rgba(255,255,255,0.06)"
    g.lineWidth = 0.6
    g.stroke()
    for (const b of c.boxes) {
      if (b.kind === "wall") continue
      const special = b.label !== null
      g.fillStyle = special ? "#2c3240" : "#1f2530"
      g.fillRect(b.x0, b.z0, b.x1 - b.x0, b.z1 - b.z0)
      if (special) {
        g.strokeStyle = b.label === "PRECINCT" ? "rgba(61,123,255,0.7)" : "rgba(255,138,31,0.55)"
        g.lineWidth = 1.2
        g.strokeRect(b.x0, b.z0, b.x1 - b.x0, b.z1 - b.z0)
      }
    }
    return cv
  }

  draw(view: WorldView, cam: Camera, focus: CarView | null, myId: string, robberVisible: boolean) {
    this.resize()
    const g = this.ctx
    const dpr = this.dpr
    const half = SIZE / 2
    const { fwd, right } = cam.axes()
    const mx = focus?.x ?? view.site.x
    const mz = focus?.z ?? view.site.z
    const s = SCALE
    // World (x, z) -> map: x' = dot(p - me, right), y' = -dot(p - me, fwd).
    const toMap = (x: number, z: number): [number, number] => {
      const dx = x - mx
      const dz = z - mz
      return [half + s * (dx * right[0] + dz * right[1]), half - s * (dx * fwd[0] + dz * fwd[1])]
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, SIZE, SIZE)
    g.save()
    g.beginPath()
    g.arc(half, half, half - 1, 0, Math.PI * 2)
    g.clip()
    g.fillStyle = "#0a0d13"
    g.fillRect(0, 0, SIZE, SIZE)

    g.save()
    g.setTransform(dpr * s * right[0], -dpr * s * fwd[0], dpr * s * right[1], -dpr * s * fwd[1], dpr * (half - s * (mx * right[0] + mz * right[1])), dpr * (half + s * (mx * fwd[0] + mz * fwd[1])))
    g.globalAlpha = 0.95
    g.drawImage(this.bake, this.minX, this.minZ, this.bake.width / BAKE, this.bake.height / BAKE)
    g.restore()

    const isRobber = myId === view.robberId
    const t = performance.now() / 1000

    // Extraction zone. Cops know where the exits are too; only the robber sees which one is live.
    if (isRobber || view.phase === "end") {
      const [ex, ey] = this.clampToRing(toMap(view.exit.x, view.exit.z), half, 10)
      g.fillStyle = "rgba(54,240,122,0.16)"
      g.beginPath()
      g.arc(ex, ey, Math.max(6, 14 * s), 0, Math.PI * 2)
      g.fill()
      g.strokeStyle = GO
      g.lineWidth = 2
      g.stroke()
      g.fillStyle = GO
      g.beginPath()
      g.arc(ex, ey, 3, 0, Math.PI * 2)
      g.fill()
    }

    // Job site.
    {
      const [sx, sy] = toMap(view.site.x, view.site.z)
      g.strokeStyle = "rgba(255,138,31,0.8)"
      g.lineWidth = 1.5
      g.strokeRect(sx - 4, sy - 4, 8, 8)
    }

    // Helicopter and its spotlight.
    if (view.heli.active) {
      const [lx, ly] = toMap(view.heli.sx, view.heli.sz)
      g.fillStyle = view.heli.lock > 0 ? "rgba(255,59,59,0.28)" : "rgba(220,235,255,0.18)"
      g.beginPath()
      g.arc(lx, ly, 10 * s + 3, 0, Math.PI * 2)
      g.fill()
      const [hx, hy] = this.clampToRing(toMap(view.heli.x, view.heli.z), half, 10)
      g.strokeStyle = "#cfe0ff"
      g.lineWidth = 1.5
      g.beginPath()
      g.arc(hx, hy, 4.5, 0, Math.PI * 2)
      g.stroke()
      const r = t * 14
      g.beginPath()
      g.moveTo(hx + Math.cos(r) * 8, hy + Math.sin(r) * 8)
      g.lineTo(hx - Math.cos(r) * 8, hy - Math.sin(r) * 8)
      g.stroke()
    }

    // Last-seen ping (cop side).
    if (!isRobber && !robberVisible && view.lastSeen && view.phase === "chase") {
      const [px, py] = this.clampToRing(toMap(view.lastSeen.x, view.lastSeen.z), half, 10)
      const k = (t * 0.8) % 1
      g.strokeStyle = `rgba(255,59,59,${1 - k})`
      g.lineWidth = 2
      g.beginPath()
      g.arc(px, py, 4 + k * 16, 0, Math.PI * 2)
      g.stroke()
      g.fillStyle = THREAT
      g.beginPath()
      g.arc(px, py, 3.5, 0, Math.PI * 2)
      g.fill()
    }

    // Deployed gadgets.
    for (const p of view.props ?? []) {
      const [px, py] = toMap(p.x, p.z)
      if (Math.hypot(px - half, py - half) > half) continue
      const fade = Math.min(1, p.life / 1.5)
      g.globalAlpha = fade
      if (p.kind === "oil" || p.kind === "smoke") {
        g.fillStyle = p.kind === "oil" ? "rgba(255,138,31,0.45)" : "rgba(200,210,225,0.35)"
        g.beginPath()
        g.arc(px, py, Math.max(3, p.r * s), 0, Math.PI * 2)
        g.fill()
      } else {
        // Strips and barriers span across the road they sit on.
        const ax = Math.cos(p.h)
        const az = -Math.sin(p.h)
        const ux = (ax * right[0] + az * right[1]) * p.r * s
        const uy = -(ax * fwd[0] + az * fwd[1]) * p.r * s
        g.strokeStyle = p.kind === "spike" ? THREAT : "#ffb648"
        g.lineWidth = p.kind === "spike" ? 2.5 : 4
        g.beginPath()
        g.moveTo(px - ux, py - uy)
        g.lineTo(px + ux, py + uy)
        g.stroke()
      }
      g.globalAlpha = 1
    }

    // Cars.
    const ang = (h: number) => {
      // Heading vector in map space, as a canvas rotation.
      const hx = Math.sin(h)
      const hz = Math.cos(h)
      const ux = hx * right[0] + hz * right[1]
      const uy = -(hx * fwd[0] + hz * fwd[1])
      return Math.atan2(uy, ux)
    }
    for (const c of view.cars) {
      if (c.ghost) continue
      if (c.ownerId === myId) continue
      const robber = c.ownerId === view.robberId
      if (robber && !isRobber && !robberVisible) continue
      const [x, y] = this.clampToRing(toMap(c.x, c.z), half, 7)
      g.fillStyle = robber ? ROBBER : COP
      g.strokeStyle = "rgba(0,0,0,0.6)"
      g.lineWidth = 1.5
      g.beginPath()
      g.arc(x, y, robber ? 5 : 4, 0, Math.PI * 2)
      g.fill()
      g.stroke()
    }
    if (focus) {
      const [x, y] = toMap(focus.x, focus.z)
      const a = ang(focus.h)
      g.save()
      g.translate(x, y)
      g.rotate(a)
      g.fillStyle = "#ffffff"
      g.strokeStyle = "rgba(0,0,0,0.7)"
      g.lineWidth = 1.5
      g.beginPath()
      g.moveTo(9, 0)
      g.lineTo(-6, 5.5)
      g.lineTo(-3, 0)
      g.lineTo(-6, -5.5)
      g.closePath()
      g.fill()
      g.stroke()
      g.restore()
    }
    g.restore()

    // Rim and north marker. North is -z.
    g.strokeStyle = isRobber ? "rgba(255,138,31,0.55)" : "rgba(61,123,255,0.6)"
    g.lineWidth = 2
    g.beginPath()
    g.arc(half, half, half - 2, 0, Math.PI * 2)
    g.stroke()
    const nx = -right[1]
    const ny = fwd[1]
    const nl = Math.hypot(nx, ny) || 1
    const nr = half - 13
    const npx = half + (nx / nl) * nr
    const npy = half + (ny / nl) * nr
    g.fillStyle = "rgba(8,10,16,0.9)"
    g.beginPath()
    g.arc(npx, npy, 9, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = "#eef1f6"
    g.font = "700 12px 'Barlow Condensed', sans-serif"
    g.textAlign = "center"
    g.textBaseline = "middle"
    g.fillText("N", npx, npy + 0.5)
  }

  private clampToRing(p: [number, number], half: number, pad: number): [number, number] {
    const dx = p[0] - half
    const dy = p[1] - half
    const d = Math.hypot(dx, dy)
    const max = half - pad
    if (d <= max) return p
    return [half + (dx / d) * max, half + (dy / d) * max]
  }
}
