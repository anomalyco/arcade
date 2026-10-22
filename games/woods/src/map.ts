import type { MapKnowledge, WoodsState } from "../shared/sim"
import { terrainHeight, type WoodsWorld } from "../shared/world"

/**
 * The paper survey map and compass you raise into view (hold G). The printed layer is a rough topographic sheet of the
 * area: contours, the lake, the camp, the old path and the ridge mast. The pencil layer is what this player's map knows:
 * their own path, paths copied from friends, tapes and markers found. It never shows where you are.
 */

const SIZE = 760
const MARGIN = 34

export class PaperMap {
  readonly root: HTMLDivElement
  private paper: HTMLCanvasElement
  private pencil: HTMLCanvasElement
  private compass: HTMLCanvasElement
  private shade: HTMLDivElement
  private key = ""
  private needle = 0
  private needleV = 0
  private world: WoodsWorld | null = null

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div")
    this.root.className = "woods-map"
    this.root.innerHTML = `<style>
      .woods-map { position: fixed; left: 50%; bottom: 0; width: min(78vh, 80vw); aspect-ratio: 1; pointer-events: none; transform-origin: 50% 100%; visibility: hidden; z-index: 4; }
      .woods-map canvas.sheet { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 3px; box-shadow: 0 30px 60px rgba(0,0,0,.7); }
      .woods-map .shade { position: absolute; inset: 0; border-radius: 3px; }
      .woods-map canvas.compass { position: absolute; left: -38%; bottom: 6%; width: 34%; aspect-ratio: 1; border-radius: 50%; box-shadow: 0 16px 40px rgba(0,0,0,.75); }
    </style>`
    this.paper = Object.assign(document.createElement("canvas"), { width: SIZE, height: SIZE, className: "sheet" })
    this.pencil = Object.assign(document.createElement("canvas"), { width: SIZE, height: SIZE, className: "sheet" })
    this.pencil.style.boxShadow = "none"
    this.compass = Object.assign(document.createElement("canvas"), { width: 260, height: 260, className: "compass" })
    this.shade = document.createElement("div")
    this.shade.className = "shade"
    this.root.append(this.paper, this.pencil, this.shade, this.compass)
    parent.append(this.root)
  }

  private toMap(world: WoodsWorld, x: number, z: number): [number, number] {
    const h = world.params.half
    const s = (SIZE - MARGIN * 2) / (h * 2)
    return [MARGIN + (x + h) * s, MARGIN + (z + h) * s]
  }

  /** Prints the sheet for a world (once per world). */
  setWorld(world: WoodsWorld): void {
    this.world = world
    this.key = ""
    const g = this.paper.getContext("2d")!
    g.fillStyle = "#d9cfb2"
    g.fillRect(0, 0, SIZE, SIZE)
    // Paper grain and stains.
    for (let i = 0; i < 2600; i++) {
      const x = (i * 7919) % SIZE, y = (i * 104729) % SIZE
      g.fillStyle = `rgba(${90 + (i % 40)},${70 + (i % 30)},40,${0.02 + (i % 7) * 0.006})`
      g.fillRect(x, y, 2 + (i % 3), 2 + (i % 2))
    }
    // Contours: marching squares over the shared terrain function.
    const h = world.params.half, n = 150, step = (h * 2) / n
    const hs: number[] = []
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) hs.push(terrainHeight(world.terrain, -h + i * step, -h + j * step))
    const at = (i: number, j: number) => hs[j * (n + 1) + i]!
    for (let level = -2; level <= 32; level += 1.5) {
      const major = Math.abs(level % 7.5) < 0.01
      g.strokeStyle = major ? "rgba(120,72,30,0.55)" : "rgba(130,85,40,0.28)"
      g.lineWidth = major ? 1.3 : 0.8
      g.beginPath()
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const c = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]
        const pts: [number, number][] = []
        const edge = (a: number, b: number, ax: number, az: number, bx: number, bz: number) => {
          if ((c[a]! < level) === (c[b]! < level)) return
          const t = (level - c[a]!) / (c[b]! - c[a]!)
          pts.push([ax + (bx - ax) * t, az + (bz - az) * t])
        }
        const x0 = -h + i * step, z0 = -h + j * step, x1 = x0 + step, z1 = z0 + step
        edge(0, 1, x0, z0, x1, z0); edge(1, 2, x1, z0, x1, z1); edge(2, 3, x1, z1, x0, z1); edge(3, 0, x0, z1, x0, z0)
        for (let k = 0; k + 1 < pts.length; k += 2) {
          const [ax, ay] = this.toMap(world, pts[k]![0], pts[k]![1]), [bx, by] = this.toMap(world, pts[k + 1]![0], pts[k + 1]![1])
          g.moveTo(ax, ay); g.lineTo(bx, by)
        }
      }
      g.stroke()
    }
    // Lake.
    const L = world.lake
    const [lx, ly] = this.toMap(world, L.x, L.z)
    const s = (SIZE - MARGIN * 2) / (h * 2)
    g.fillStyle = "rgba(90,120,135,0.35)"
    g.strokeStyle = "rgba(40,70,90,0.7)"
    g.lineWidth = 1.4
    g.beginPath(); g.ellipse(lx, ly, L.rx * s, L.rz * s, 0, 0, Math.PI * 2); g.fill(); g.stroke()
    for (let k = -3; k <= 3; k++) {
      g.beginPath(); g.moveTo(lx - L.rx * s * 0.6, ly + k * 7); g.lineTo(lx + L.rx * s * 0.6, ly + k * 7)
      g.strokeStyle = "rgba(40,70,90,0.18)"; g.stroke()
    }
    // Camp buildings.
    g.fillStyle = "rgba(30,25,20,0.85)"
    for (const b of world.buildings) {
      if (b.kind === "mast" || b.kind === "canoe" || b.kind === "table") continue
      const [ax, ay] = this.toMap(world, b.rect[0], b.rect[1]), [bx, by] = this.toMap(world, b.rect[2], b.rect[3])
      g.fillRect(ax, ay, Math.max(2, bx - ax), Math.max(2, by - ay))
    }
    // Old path, dashed.
    g.setLineDash([5, 4]); g.strokeStyle = "rgba(60,40,25,0.7)"; g.lineWidth = 1.3
    g.beginPath()
    world.trail.points.forEach(([x, z], i) => { const [px, py] = this.toMap(world, x, z); if (i) g.lineTo(px, py); else g.moveTo(px, py) })
    g.stroke(); g.setLineDash([])
    // Ridge mast.
    const [mx, my] = this.toMap(world, world.ridgeLight.x, world.ridgeLight.z)
    g.strokeStyle = "rgba(30,25,20,0.9)"; g.lineWidth = 1.5
    g.beginPath(); g.moveTo(mx - 5, my + 6); g.lineTo(mx, my - 8); g.lineTo(mx + 5, my + 6); g.moveTo(mx - 3, my); g.lineTo(mx + 3, my); g.stroke()
    // Lettering.
    g.fillStyle = "rgba(40,30,20,0.85)"
    g.font = "italic 13px Georgia, serif"
    g.fillText("radio mast", mx + 9, my + 4)
    const [cx, cy] = this.toMap(world, world.camp.x, world.camp.z)
    g.fillText("Camp Tamarack", cx + 30, cy - 4)
    g.fillText("Lake", lx - 14, ly + 4)
    g.font = "bold 15px Georgia, serif"
    g.fillText("TAMARACK STATE FOREST  ·  SHEET 4", MARGIN, 24)
    g.font = "11px Georgia, serif"
    g.fillText("Contour interval 1.5 m  ·  survey monuments not shown", MARGIN, SIZE - 12)
    // North arrow and scale bar.
    const ax = SIZE - 52, ay = 70
    g.beginPath(); g.moveTo(ax, ay - 26); g.lineTo(ax + 8, ay + 4); g.lineTo(ax, ay - 2); g.lineTo(ax - 8, ay + 4); g.closePath(); g.fill()
    g.font = "bold 14px Georgia, serif"; g.fillText("N", ax - 5, ay - 32)
    const [s0] = this.toMap(world, -h + 10, 0), [s1] = this.toMap(world, -h + 110, 0)
    g.fillRect(s0, SIZE - 30, s1 - s0, 3)
    g.font = "11px Georgia, serif"; g.fillText("100 m", s1 + 6, SIZE - 26)
    // Folds.
    g.strokeStyle = "rgba(0,0,0,0.07)"; g.lineWidth = 2
    for (const f of [1 / 3, 2 / 3]) { g.beginPath(); g.moveTo(SIZE * f, 0); g.lineTo(SIZE * f, SIZE); g.stroke() }
    g.beginPath(); g.moveTo(0, SIZE / 2); g.lineTo(SIZE, SIZE / 2); g.stroke()
  }

  private drawPencil(world: WoodsWorld, m: MapKnowledge, state: WoodsState) {
    const g = this.pencil.getContext("2d")!
    g.clearRect(0, 0, SIZE, SIZE)
    const path = (trail: number[]) => {
      g.beginPath()
      for (let i = 0; i < trail.length; i += 2) {
        const [x, y] = this.toMap(world, trail[i]!, trail[i + 1]!)
        if (i) g.lineTo(x, y); else g.moveTo(x, y)
      }
      g.stroke()
    }
    g.lineJoin = g.lineCap = "round"
    g.strokeStyle = "rgba(60,60,70,0.45)"; g.lineWidth = 1.2; g.setLineDash([3, 4])
    for (const h of m.heard) path(h.trail)
    g.setLineDash([])
    g.strokeStyle = "rgba(45,45,52,0.8)"; g.lineWidth = 1.7
    path(m.trail)
    g.strokeStyle = "rgba(225,95,20,0.95)"; g.lineWidth = 2
    for (const id of m.tapes) {
      const t = state.tapes.find((k) => k.id === id)
      if (!t) continue
      const [x, y] = this.toMap(world, t.x, t.z)
      g.beginPath(); g.moveTo(x - 3, y - 3); g.lineTo(x + 3, y + 3); g.moveTo(x + 3, y - 3); g.lineTo(x - 3, y + 3); g.stroke()
    }
    g.strokeStyle = "rgba(40,40,48,0.9)"; g.fillStyle = "rgba(40,40,48,0.9)"; g.lineWidth = 1.6
    g.font = "bold 13px 'Comic Sans MS', 'Marker Felt', cursive"
    for (const id of m.markers) {
      const k = world.markers.find((x) => x.id === id)
      if (!k) continue
      const [x, y] = this.toMap(world, k.x, k.z)
      g.beginPath(); g.moveTo(x, y - 7); g.lineTo(x + 6, y + 4); g.lineTo(x - 6, y + 4); g.closePath(); g.stroke()
      g.beginPath(); g.arc(x, y, 11, 0, Math.PI * 2); g.stroke()
      g.fillText(`#${id}`, x + 13, y + 4)
    }
  }

  private drawCompass(heading: number) {
    const g = this.compass.getContext("2d")!
    const c = 130
    g.clearRect(0, 0, 260, 260)
    const brass = g.createRadialGradient(c - 30, c - 30, 20, c, c, 130)
    brass.addColorStop(0, "#9c7a3c"); brass.addColorStop(1, "#4a3516")
    g.fillStyle = brass; g.beginPath(); g.arc(c, c, 128, 0, Math.PI * 2); g.fill()
    g.fillStyle = "#e3dcc6"; g.beginPath(); g.arc(c, c, 104, 0, Math.PI * 2); g.fill()
    g.strokeStyle = "#2c241a"; g.fillStyle = "#2c241a"
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2, r0 = i % 9 === 0 ? 84 : 94
      g.lineWidth = i % 9 === 0 ? 2 : 1
      g.beginPath(); g.moveTo(c + Math.sin(a) * r0, c - Math.cos(a) * r0); g.lineTo(c + Math.sin(a) * 102, c - Math.cos(a) * 102); g.stroke()
    }
    // Lubber line: where you face.
    g.fillStyle = "#a22"; g.fillRect(c - 1.5, c - 104, 3, 16)
    // The needle points to true north (−z): rotated by your yaw.
    g.save(); g.translate(c, c); g.rotate(heading)
    g.fillStyle = "#b3261e"; g.beginPath(); g.moveTo(0, -80); g.lineTo(9, 0); g.lineTo(-9, 0); g.closePath(); g.fill()
    g.fillStyle = "#e8e4d8"; g.beginPath(); g.moveTo(0, 80); g.lineTo(9, 0); g.lineTo(-9, 0); g.closePath(); g.fill()
    g.strokeStyle = "#2c241a"; g.lineWidth = 1; g.stroke()
    g.restore()
    g.fillStyle = "#3a2e1e"; g.beginPath(); g.arc(c, c, 7, 0, Math.PI * 2); g.fill()
    const glass = g.createLinearGradient(0, 0, 260, 260)
    glass.addColorStop(0, "rgba(255,255,255,0.18)"); glass.addColorStop(0.5, "rgba(255,255,255,0)")
    g.fillStyle = glass; g.beginPath(); g.arc(c, c, 104, 0, Math.PI * 2); g.fill()
  }

  /**
   * Places the map for this frame. `raise` 0..1, `yaw` the view yaw (0 north), `light` how lit the sheet is (0..1),
   * `sway` small hand motion from walking.
   */
  frame(state: WoodsState, me: number, raise: number, yaw: number, light: number, sway: number, dt: number): void {
    const world = this.world
    const p = state.players.find((x) => x.id === me)
    if (!world || !p) return
    this.root.style.visibility = raise > 0.001 ? "visible" : "hidden"
    // Needle: a damped spring towards north relative to your heading.
    const target = yaw
    let d = target - this.needle
    d = Math.atan2(Math.sin(d), Math.cos(d))
    this.needleV += (d * 60 - this.needleV * 9) * Math.min(dt, 0.05)
    this.needle += this.needleV * Math.min(dt, 0.05)
    if (raise <= 0.001) return
    const m = p.map
    const key = `${m.trail.length}:${m.heard.reduce((a, h) => a + h.trail.length, 0)}:${m.tapes.length}:${m.markers.length}:${state.tapes.length}`
    if (key !== this.key) { this.key = key; this.drawPencil(world, m, state) }
    this.drawCompass(this.needle)
    const e = 1 - (1 - raise) ** 3
    this.root.style.transform = `translate(-50%, ${(1 - e) * 105 - 4 + sway * 4}%) perspective(1100px) rotateX(${16 + (1 - e) * 35}deg) rotateZ(${sway * 1.2 - 2}deg)`
    const lit = Math.max(0, Math.min(1, light))
    this.shade.style.background = `radial-gradient(ellipse at 56% 46%, rgba(4,6,10,${0.9 - lit * 0.88}) 10%, rgba(4,6,10,${0.94 - lit * 0.55}) 80%)`
    this.compass.style.filter = `brightness(${0.12 + lit * 0.9})`
  }
}
