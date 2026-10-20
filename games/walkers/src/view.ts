// Canvas 2D side view: the room, the terrain, and the runners (ghosts faint, the best solid, the pre-trained gold).

import type { Body } from "../shared/physics"
import { ROOM, TASKS, type TaskId } from "../shared/tasks"
import type { Runner, Show } from "./show"

const INK = {
  sky: "#0e1218",
  wall: "#141a23",
  grid: "rgba(150,170,200,0.07)",
  gridMajor: "rgba(150,170,200,0.16)",
  floor: "#232b37",
  floorEdge: "#8d9bb0",
  label: "rgba(200,212,230,0.55)",
  start: "rgba(140,200,255,0.5)",
  goal: "#f2f5f8",
}

const ROLE = {
  best: { near: "#ff7a59", far: "#b4513a", joint: "#ffe2d6", alpha: 1 },
  saved: { near: "#ff7a59", far: "#b4513a", joint: "#ffe2d6", alpha: 1 },
  pretrained: { near: "#f5c451", far: "#a8832e", joint: "#fff2c8", alpha: 0.7 },
  ghost: { near: "#8fc1ff", far: "#5f88bd", joint: "#8fc1ff", alpha: 0.17 },
}

export class View {
  readonly ctx: CanvasRenderingContext2D
  camX = 4
  private w = 0
  private h = 0
  private dpr = 1

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!
  }

  resize(): void {
    this.dpr = Math.min(2, devicePixelRatio || 1)
    this.w = innerWidth
    this.h = innerHeight
    this.canvas.width = Math.round(this.w * this.dpr)
    this.canvas.height = Math.round(this.h * this.dpr)
  }

  /** Pixels per metre: about 4.2 m of height, at most 11 m across. */
  get scale(): number {
    return Math.min(this.h / 4.2, this.w / 11)
  }

  follow(x: number, dt: number): void {
    const target = Math.max(ROOM.left + 2, Math.min(ROOM.right - 2, x + 1.2))
    this.camX += (target - this.camX) * Math.min(1, dt * 3)
  }

  draw(task: TaskId, show: Show | null): void {
    const { ctx, w, h, dpr } = this
    const s = this.scale
    const groundY = h * 0.74
    const ox = w / 2 - this.camX * s
    const X = (x: number) => ox + x * s
    const Y = (y: number) => groundY - y * s
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = INK.sky
    ctx.fillRect(0, 0, w, h)

    // Back wall with a metre grid.
    const x0 = Math.floor(this.camX - w / s / 2) - 1
    const x1 = Math.ceil(this.camX + w / s / 2) + 1
    ctx.fillStyle = INK.wall
    ctx.fillRect(X(ROOM.left), Y(ROOM.height), (ROOM.right - ROOM.left) * s, ROOM.height * s)
    ctx.lineWidth = 1
    for (let x = Math.max(x0, ROOM.left); x <= Math.min(x1, ROOM.right); x++) {
      ctx.strokeStyle = x % 5 === 0 ? INK.gridMajor : INK.grid
      ctx.beginPath()
      ctx.moveTo(X(x) + 0.5, Y(ROOM.height))
      ctx.lineTo(X(x) + 0.5, Y(0))
      ctx.stroke()
    }
    for (let y = 0.5; y < ROOM.height; y += 0.5) {
      ctx.strokeStyle = INK.grid
      ctx.beginPath()
      ctx.moveTo(X(ROOM.left), Y(y) + 0.5)
      ctx.lineTo(X(ROOM.right), Y(y) + 0.5)
      ctx.stroke()
    }

    // Start and goal lines.
    const goal = TASKS[task].goal
    ctx.strokeStyle = INK.start
    ctx.setLineDash([6, 6])
    ctx.beginPath()
    ctx.moveTo(X(0), Y(ROOM.height))
    ctx.lineTo(X(0), Y(0))
    ctx.stroke()
    ctx.setLineDash([])
    const sq = Math.max(6, s * 0.12)
    for (let row = 0; row * sq < ROOM.height * s; row++) {
      for (let col = 0; col < 2; col++) {
        ctx.fillStyle = (row + col) % 2 ? "rgba(240,244,248,0.85)" : "rgba(20,24,30,0.85)"
        ctx.fillRect(X(goal) + col * sq - sq, Y(0) - (row + 1) * sq, sq, sq)
      }
    }
    ctx.font = `600 ${Math.round(Math.max(11, s * 0.16))}px ui-monospace, Menlo, monospace`
    ctx.fillStyle = INK.label
    ctx.textAlign = "center"
    ctx.fillText("START", X(0), Y(ROOM.height) - 8)
    ctx.fillStyle = INK.goal
    ctx.fillText("GOAL", X(goal), Y(ROOM.height) - 8)

    // Terrain.
    const pts = TASKS[task].points
    ctx.beginPath()
    ctx.moveTo(X(pts[0]![0]), h + 10)
    for (const [x, y] of pts) ctx.lineTo(X(x), Y(y))
    ctx.lineTo(X(pts[pts.length - 1]![0]), h + 10)
    ctx.closePath()
    ctx.fillStyle = INK.floor
    ctx.fill()
    ctx.beginPath()
    for (let i = 0; i < pts.length; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(pts[i]![0]), Y(pts[i]![1]))
    ctx.strokeStyle = INK.floorEdge
    ctx.lineWidth = 2
    ctx.stroke()

    // Distance marks on the floor.
    ctx.fillStyle = INK.label
    ctx.font = `${Math.round(Math.max(10, s * 0.11))}px ui-monospace, Menlo, monospace`
    for (let x = Math.max(0, x0); x <= Math.min(goal, x1); x++) {
      if (x % 2) continue
      ctx.fillText(`${x} m`, X(x), Y(0) + Math.max(16, s * 0.2))
    }

    if (!show) return
    for (const r of show.runners) this.drawRunner(r, X, Y, s)
    const lead = show.lead
    if (lead) this.drawLabel(lead, X, Y, s)
    for (const r of show.runners) if (r.role === "pretrained") this.drawLabel(r, X, Y, s)
  }

  private drawRunner(r: Runner, X: (x: number) => number, Y: (y: number) => number, s: number): void {
    const { ctx } = this
    const def = r.ep.creature
    const bodies = r.ep.world.bodies
    const look = ROLE[r.role]
    const faded = r.ep.done && r.ep.fell
    ctx.globalAlpha = look.alpha * (faded ? (r.role === "ghost" ? 0.45 : 0.6) : 1)
    ctx.lineCap = "round"
    const order = def.bodies.map((b, i) => [b.far ? 0 : 1, i] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1])
    const solid = r.role !== "ghost"
    for (const [, i] of order) {
      const b = bodies[i]!
      const far = def.bodies[i]!.far
      if (solid) this.capsule(b, X, Y, s, "rgba(8,10,14,0.9)", 2.5)
      this.capsule(b, X, Y, s, far ? look.far : look.near, 0)
    }
    if (solid) {
      ctx.fillStyle = look.joint
      for (const j of r.ep.world.joints) {
        const A = bodies[j.a]!
        const jx = A.x + A.c * j.lax - A.s * j.lay
        const jy = A.y + A.s * j.lax + A.c * j.lay
        ctx.beginPath()
        ctx.arc(X(jx), Y(jy), Math.max(1.5, s * 0.022), 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.globalAlpha = 1
  }

  private capsule(b: Body, X: (x: number) => number, Y: (y: number) => number, s: number, color: string, outline: number): void {
    const { ctx } = this
    const ex = b.c * b.hl, ey = b.s * b.hl
    ctx.strokeStyle = color
    ctx.lineWidth = 2 * b.r * s + outline * 2
    ctx.beginPath()
    ctx.moveTo(X(b.x - ex), Y(b.y - ey))
    ctx.lineTo(X(b.x + ex), Y(b.y + ey))
    ctx.stroke()
  }

  private drawLabel(r: Runner, X: (x: number) => number, Y: (y: number) => number, s: number): void {
    const { ctx } = this
    let top = -Infinity
    for (const b of r.ep.world.bodies) top = Math.max(top, b.y + Math.abs(b.s * b.hl) + b.r)
    const t = r.ep.torso
    const text = `${r.label} · ${Math.max(0, r.ep.distance).toFixed(1)} m${r.ep.finished ? ` · ${r.ep.time.toFixed(1)} s ✓` : r.ep.fell ? " · fell" : ""}`
    ctx.font = `600 ${Math.round(Math.max(11, s * 0.13))}px ui-monospace, Menlo, monospace`
    ctx.textAlign = "center"
    ctx.fillStyle = r.role === "pretrained" ? "rgba(245,196,81,0.85)" : "rgba(255,226,214,0.95)"
    ctx.fillText(text, X(t.x), Y(top) - 12)
  }
}
