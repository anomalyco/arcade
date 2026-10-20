// Canvas 2D side view: the room, its terrain and props, and the runners (ghosts faint, the best solid, the pre-trained
// gold). The heist vault is dark: red beams with a soft glow and haze where they cross, camera cones, a pressure plate,
// the gem under a spotlight, and a red strobe when the alarm goes off.

import type { Beam } from "../shared/hazards"
import type { Level } from "../shared/level"
import type { Body } from "../shared/physics"
import type { Runner, Show } from "./show"

const INK = {
  sky: "#0e1218",
  wall: "#141a23",
  grid: "rgba(150,170,200,0.07)",
  gridMajor: "rgba(150,170,200,0.16)",
  floor: "#232b37",
  floorEdge: "#8d9bb0",
  block: "#1b222d",
  label: "rgba(200,212,230,0.55)",
  start: "rgba(140,200,255,0.5)",
  goal: "#f2f5f8",
}

const DARK = {
  sky: "#05060a",
  wall: "#0a0c12",
  grid: "rgba(120,140,170,0.035)",
  gridMajor: "rgba(120,140,170,0.07)",
  floor: "#10131a",
  floorEdge: "#3b4556",
  block: "#0d1017",
  label: "rgba(170,182,200,0.4)",
  start: "rgba(140,200,255,0.25)",
  goal: "#7dffb0",
}

const ROLE = {
  best: { near: "#ff7a59", far: "#b4513a", joint: "#ffe2d6", alpha: 1 },
  saved: { near: "#ff7a59", far: "#b4513a", joint: "#ffe2d6", alpha: 1 },
  pretrained: { near: "#f5c451", far: "#a8832e", joint: "#fff2c8", alpha: 0.75 },
  ghost: { near: "#8fc1ff", far: "#5f88bd", joint: "#8fc1ff", alpha: 0.17 },
}

type XY = (v: number) => number

export class View {
  readonly ctx: CanvasRenderingContext2D
  camX = 4
  /** Text over the lead runner (e.g. "near miss"), set by the page. */
  banner = ""
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

  follow(x: number, dt: number, level: Level): void {
    const target = Math.max(level.left + 2, Math.min(level.right - 2, x + 1.2))
    this.camX += (target - this.camX) * Math.min(1, dt * 3)
  }

  draw(level: Level, show: Show | null): void {
    const { ctx, w, h, dpr } = this
    const ink = level.dark ? DARK : INK
    const s = this.scale
    const groundY = h * 0.74
    const ox = w / 2 - this.camX * s
    const X = (x: number) => ox + x * s
    const Y = (y: number) => groundY - y * s
    const now = performance.now() / 1000
    const lead = show?.lead
    const top = level.height
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = ink.sky
    ctx.fillRect(0, 0, w, h)

    // Back wall with a metre grid.
    const x0 = Math.floor(this.camX - w / s / 2) - 1
    const x1 = Math.ceil(this.camX + w / s / 2) + 1
    ctx.fillStyle = ink.wall
    ctx.fillRect(X(level.left), Y(top), (level.right - level.left) * s, top * s)
    ctx.lineWidth = 1
    for (let x = Math.max(x0, level.left); x <= Math.min(x1, level.right); x++) {
      ctx.strokeStyle = x % 5 === 0 ? ink.gridMajor : ink.grid
      ctx.beginPath()
      ctx.moveTo(X(x) + 0.5, Y(top))
      ctx.lineTo(X(x) + 0.5, Y(0))
      ctx.stroke()
    }
    for (let y = 0.5; y < top; y += 0.5) {
      ctx.strokeStyle = ink.grid
      ctx.beginPath()
      ctx.moveTo(X(level.left), Y(y) + 0.5)
      ctx.lineTo(X(level.right), Y(y) + 0.5)
      ctx.stroke()
    }

    const font = (k: number, weight = 600) => `${weight} ${Math.round(Math.max(10, s * k))}px ui-monospace, Menlo, monospace`
    const goal = level.goal
    ctx.strokeStyle = ink.start
    ctx.setLineDash([6, 6])
    ctx.beginPath()
    ctx.moveTo(X(0), Y(top))
    ctx.lineTo(X(0), Y(0))
    ctx.stroke()
    ctx.setLineDash([])
    ctx.textAlign = "center"
    if (level.gem) {
      this.exitDoor(level, X, Y, s, ink.goal, font)
      if (lead) this.pedestal(level, lead, X, Y, s, now)
    } else {
      const sq = Math.max(6, s * 0.12)
      for (let row = 0; row * sq < top * s; row++) {
        for (let col = 0; col < 2; col++) {
          ctx.fillStyle = (row + col) % 2 ? "rgba(240,244,248,0.85)" : "rgba(20,24,30,0.85)"
          ctx.fillRect(X(goal) + col * sq - sq, Y(0) - (row + 1) * sq, sq, sq)
        }
      }
      ctx.font = font(0.16)
      ctx.fillStyle = ink.label
      ctx.fillText("START", X(0), Y(top) - 8)
      ctx.fillStyle = ink.goal
      ctx.fillText("GOAL", X(goal), Y(top) - 8)
    }

    // Terrain and solid blocks.
    const pts = level.floor
    ctx.beginPath()
    ctx.moveTo(X(pts[0]![0]), h + 10)
    for (const [x, y] of pts) ctx.lineTo(X(x), Y(y))
    ctx.lineTo(X(pts[pts.length - 1]![0]), h + 10)
    ctx.closePath()
    ctx.fillStyle = ink.floor
    ctx.fill()
    ctx.beginPath()
    for (let i = 0; i < pts.length; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(pts[i]![0]), Y(pts[i]![1]))
    ctx.strokeStyle = ink.floorEdge
    ctx.lineWidth = 2
    ctx.stroke()
    for (const poly of level.blocks) {
      ctx.beginPath()
      poly.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))))
      ctx.closePath()
      ctx.fillStyle = ink.block
      ctx.fill()
      ctx.strokeStyle = ink.floorEdge
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
    if (level.plate && lead) {
      const on = lead.ep.platePressed
      const fy = Y(0)
      ctx.fillStyle = on ? "#3fe08a" : "#d9a13a"
      ctx.shadowColor = ctx.fillStyle
      ctx.shadowBlur = on ? 14 : 6
      ctx.fillRect(X(level.plate.x0), fy - Math.max(2, s * 0.02), (level.plate.x1 - level.plate.x0) * s, Math.max(2, s * 0.02))
      ctx.shadowBlur = 0
    }

    ctx.fillStyle = ink.label
    ctx.font = font(0.11, 400)
    for (let x = Math.max(0, x0); x <= Math.min(goal, x1); x++) {
      if (x % 2) continue
      ctx.fillText(`${x} m`, X(x), Y(0) + Math.max(16, s * 0.2))
    }

    if (lead) this.props(lead, X, Y, s, level.dark)
    if (show) {
      for (const r of show.runners) this.drawRunner(r, X, Y, s)
      for (const r of show.runners) if (r.role !== "ghost" && r.ep.carrying) this.gem(...r.ep.gemAt()!, X, Y, s, now, 0.7)
    }
    if (lead && (lead.ep.beams.length || lead.ep.cones.length)) this.hazards(lead, X, Y, s, now)
    if (level.dark) {
      const g = ctx.createRadialGradient(w / 2, h * 0.55, Math.min(w, h) * 0.25, w / 2, h * 0.55, Math.max(w, h) * 0.75)
      g.addColorStop(0, "rgba(0,0,0,0)")
      g.addColorStop(1, "rgba(0,0,0,0.55)")
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)
    }
    if (!show) return
    if (lead) this.drawLabel(lead, X, Y, s, this.banner)
    for (const r of show.runners) if (r.role === "pretrained" && r !== lead) this.drawLabel(r, X, Y, s, "")
    // Each alarm strobes for a second; caught keeps it going.
    if (lead && (lead.ep.outcome === "caught" || lead.ep.time - lead.ep.alarmAt < 1)) this.alarm(level, X, Y, s, now, lead.ep.outcome === "caught" ? "CAUGHT" : lead.ep.alarms > 1 ? `ALARM ×${lead.ep.alarms}` : "ALARM")
  }

  private exitDoor(level: Level, X: XY, Y: XY, s: number, color: string, font: (k: number) => string): void {
    const { ctx } = this
    const g = level.goal
    const dh = 1.3
    ctx.fillStyle = "rgba(60,255,150,0.06)"
    ctx.fillRect(X(g), Y(dh), 0.3 * s, dh * s)
    ctx.strokeStyle = "rgba(125,255,176,0.5)"
    ctx.lineWidth = 2
    ctx.strokeRect(X(g), Y(dh), 0.3 * s, dh * s)
    ctx.font = font(0.13)
    ctx.fillStyle = color
    ctx.shadowColor = color
    ctx.shadowBlur = 10
    ctx.fillText("EXIT", X(g + 0.15), Y(dh) - 8)
    ctx.shadowBlur = 0
    ctx.fillStyle = "rgba(140,200,255,0.5)"
    ctx.fillText("VENT", X(-1), Y(1.15) - 8)
  }

  /** The pedestal (behind the creature's plane), its spotlight and the gem, unless the lead has it. */
  private pedestal(level: Level, lead: Runner, X: XY, Y: XY, s: number, now: number): void {
    const { ctx } = this
    const gem = level.gem!
    const cone = ctx.createLinearGradient(0, Y(level.height), 0, Y(0))
    cone.addColorStop(0, "rgba(160,230,255,0.0)")
    cone.addColorStop(1, "rgba(160,230,255,0.10)")
    ctx.fillStyle = cone
    ctx.beginPath()
    ctx.moveTo(X(gem.x - 0.08), Y(level.height - 0.05))
    ctx.lineTo(X(gem.x + 0.08), Y(level.height - 0.05))
    ctx.lineTo(X(gem.x + 0.6), Y(0))
    ctx.lineTo(X(gem.x - 0.6), Y(0))
    ctx.fill()
    ctx.fillStyle = "#1e2530"
    ctx.fillRect(X(gem.x - 0.09), Y(gem.y - 0.08), 0.18 * s, (gem.y - 0.08) * s)
    ctx.fillStyle = "#2c3644"
    ctx.fillRect(X(gem.x - 0.13), Y(gem.y - 0.08), 0.26 * s, 0.035 * s)
    if (!lead.ep.carrying) this.gem(gem.x, gem.y, X, Y, s, now, 1)
  }

  private gem(x: number, y: number, X: XY, Y: XY, s: number, now: number, size: number): void {
    const { ctx } = this
    const r = 0.07 * s * size
    const cx = X(x), cy = Y(y)
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 4)
    halo.addColorStop(0, "rgba(120,240,255,0.45)")
    halo.addColorStop(1, "rgba(120,240,255,0)")
    ctx.fillStyle = halo
    ctx.fillRect(cx - r * 4, cy - r * 4, r * 8, r * 8)
    ctx.beginPath()
    ctx.moveTo(cx - r, cy - r * 0.35)
    ctx.lineTo(cx - r * 0.5, cy - r * 0.8)
    ctx.lineTo(cx + r * 0.5, cy - r * 0.8)
    ctx.lineTo(cx + r, cy - r * 0.35)
    ctx.lineTo(cx, cy + r)
    ctx.closePath()
    ctx.fillStyle = "#5ff0ff"
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(cx - r, cy - r * 0.35)
    ctx.lineTo(cx + r, cy - r * 0.35)
    ctx.moveTo(cx - r * 0.5, cy - r * 0.8)
    ctx.lineTo(cx, cy + r)
    ctx.lineTo(cx + r * 0.5, cy - r * 0.8)
    ctx.strokeStyle = "rgba(10,60,80,0.7)"
    ctx.lineWidth = 1
    ctx.stroke()
    // A glint that comes and goes.
    const k = Math.max(0, Math.sin(now * 2.3) * 1.4 - 0.4)
    if (k > 0) {
      const gx = cx + r * 0.35, gy = cy - r * 0.55, L = r * 1.3 * k
      ctx.strokeStyle = `rgba(255,255,255,${(0.9 * k).toFixed(2)})`
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(gx - L, gy)
      ctx.lineTo(gx + L, gy)
      ctx.moveTo(gx, gy - L)
      ctx.lineTo(gx, gy + L)
      ctx.stroke()
    }
  }

  private props(r: Runner, X: XY, Y: XY, s: number, dark: boolean): void {
    const { ctx } = this
    const bodies = r.ep.world.bodies
    for (let i = r.ep.n; i < bodies.length; i++) {
      const b = bodies[i]!
      ctx.beginPath()
      for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        const lx = u * b.hx, ly = v * b.hy
        ctx.lineTo(X(b.x + b.c * lx - b.s * ly), Y(b.y + b.s * lx + b.c * ly))
      }
      ctx.closePath()
      ctx.fillStyle = b.drive ? (dark ? "#2a3446" : "#4a5a74") : b.invM > 0 && b.hy > 0.06 ? "#8a6a42" : "#6f7d92"
      ctx.fill()
      ctx.strokeStyle = "rgba(8,10,14,0.9)"
      ctx.lineWidth = 2
      ctx.stroke()
      if (b.invM > 0 && b.hy > 0.06) {
        ctx.strokeStyle = "rgba(40,28,14,0.6)"
        ctx.lineWidth = 1.5
        ctx.beginPath()
        const d = [[-1, -1], [1, 1]] as const
        for (const [u, v] of d) ctx.lineTo(X(b.x + b.c * u * b.hx - b.s * v * b.hy), Y(b.y + b.s * u * b.hx + b.c * v * b.hy))
        ctx.stroke()
      }
    }
  }

  private hazards(r: Runner, X: XY, Y: XY, s: number, now: number): void {
    const { ctx } = this
    const ep = r.ep
    const tripped = ep.time - ep.alarmAt < 1 || ep.outcome === "caught" ? ep.alarmBy : null
    for (let i = 0; i < ep.cones.length; i++) {
      const c = ep.cones[i]!
      const caught = tripped === -1 - i
      const a = Math.atan2(c.dy, c.dx)
      const grad = ctx.createRadialGradient(X(c.x), Y(c.y), 0, X(c.x), Y(c.y), c.range * s)
      const col = caught ? "255,60,60" : "255,236,170"
      grad.addColorStop(0, `rgba(${col},0.28)`)
      grad.addColorStop(1, `rgba(${col},0)`)
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.moveTo(X(c.x), Y(c.y))
      ctx.arc(X(c.x), Y(c.y), c.range * s, -(a + c.half), -(a - c.half))
      ctx.closePath()
      ctx.fill()
      ctx.save()
      ctx.translate(X(c.x), Y(c.y))
      ctx.rotate(-a)
      ctx.fillStyle = "#3a4250"
      ctx.fillRect(-0.06 * s, -0.045 * s, 0.16 * s, 0.09 * s)
      ctx.fillStyle = caught || Math.sin(now * 6) > 0 ? "#ff3040" : "#5a1a20"
      ctx.beginPath()
      ctx.arc(-0.03 * s, -0.025 * s, Math.max(1.5, 0.012 * s), 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }

    const beams = ep.beams
    ctx.save()
    ctx.lineCap = "round"
    // Switched-off beams leave a faint dashed trace so you can see where they will be.
    for (const b of beams) {
      if (b.active) continue
      ctx.strokeStyle = b.kind === "grid" ? "rgba(255,60,70,0.12)" : "rgba(255,60,70,0.22)"
      ctx.lineWidth = 1
      ctx.setLineDash([3, 6])
      ctx.beginPath()
      ctx.moveTo(X(b.x1), Y(b.y1))
      ctx.lineTo(X(b.x2), Y(b.y2))
      ctx.stroke()
    }
    ctx.setLineDash([])
    ctx.globalCompositeOperation = "lighter"
    for (let i = 0; i < beams.length; i++) {
      const b = beams[i]!
      if (!b.active) continue
      const hit = tripped === i
      const flick = 0.92 + 0.08 * Math.sin(now * 40 + i * 1.7)
      for (const [width, alpha] of [[Math.max(10, s * 0.14), 0.07], [Math.max(4, s * 0.05), 0.2], [Math.max(1.5, s * 0.014), 1]] as const) {
        ctx.strokeStyle = hit ? `rgba(255,${alpha === 1 ? 255 : 120},${alpha === 1 ? 255 : 120},${alpha})` : alpha === 1 ? `rgba(255,190,190,${flick})` : `rgba(255,30,45,${alpha * flick})`
        ctx.lineWidth = width
        ctx.beginPath()
        ctx.moveTo(X(b.x1), Y(b.y1))
        ctx.lineTo(X(b.x2), Y(b.y2))
        ctx.stroke()
      }
      this.glow(X(b.x2), Y(b.y2), s * 0.12, 0.5)
      this.glow(X(b.x1), Y(b.y1), s * 0.06, 0.4)
    }
    // Haze where beams cross.
    for (let i = 0; i < beams.length; i++) {
      for (let j = i + 1; j < beams.length; j++) {
        const p = cross(beams[i]!, beams[j]!)
        if (p) this.glow(X(p[0]), Y(p[1]), s * 0.3, 0.35)
      }
    }
    ctx.restore()
    // Scanners ride up and down on two posts.
    ep.level.lasers.forEach((l) => {
      if (l.kind !== "sweep") return
      ctx.strokeStyle = "#262c36"
      ctx.lineWidth = Math.max(2, s * 0.03)
      ctx.beginPath()
      for (const x of [l.x1, l.x2]) {
        ctx.moveTo(X(x), Y(0))
        ctx.lineTo(X(x), Y(l.y + l.amp + 0.05))
      }
      ctx.stroke()
    })
    for (const b of beams) {
      ctx.fillStyle = "#262c36"
      for (const [x, y] of [[b.x1, b.y1], [b.x2, b.y2]]) ctx.fillRect(X(x!) - 0.03 * s, Y(y!) - 0.03 * s, 0.06 * s, 0.06 * s)
    }
  }

  private glow(x: number, y: number, r: number, a: number): void {
    const { ctx } = this
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, `rgba(255,70,80,${a})`)
    g.addColorStop(1, "rgba(255,40,50,0)")
    ctx.fillStyle = g
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r)
  }

  private alarm(level: Level, X: XY, Y: XY, s: number, now: number, text: string): void {
    const { ctx, w, h } = this
    const k = 0.5 + 0.5 * Math.sin(now * 14)
    ctx.fillStyle = `rgba(255,20,30,${(0.08 + 0.17 * k).toFixed(3)})`
    ctx.fillRect(0, 0, w, h)
    // A rotating siren on the ceiling above the camera's view.
    const sx = X(this.camX), sy = Y(level.height - 0.05)
    const a = now * 7
    ctx.save()
    ctx.globalCompositeOperation = "lighter"
    for (const off of [0, Math.PI]) {
      const dir = a + off
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, s * 4)
      g.addColorStop(0, "rgba(255,40,40,0.35)")
      g.addColorStop(1, "rgba(255,40,40,0)")
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.arc(sx, sy, s * 4, dir - 0.3, dir + 0.3)
      ctx.closePath()
      ctx.fill()
    }
    ctx.restore()
    ctx.fillStyle = "#ff3040"
    ctx.beginPath()
    ctx.arc(sx, sy + 0.04 * s, 0.06 * s, 0, Math.PI)
    ctx.fill()
    ctx.font = `800 ${Math.round(Math.max(18, s * 0.32))}px ui-monospace, Menlo, monospace`
    ctx.textAlign = "center"
    ctx.fillStyle = `rgba(255,${Math.round(60 + 120 * k)},${Math.round(60 + 120 * k)},0.95)`
    ctx.fillText(text, w / 2, h * 0.2)
  }

  private drawRunner(r: Runner, X: XY, Y: XY, s: number): void {
    const { ctx } = this
    const def = r.ep.creature
    const bodies = r.ep.world.bodies
    const look = ROLE[r.role]
    const faded = r.ep.done && (r.ep.fell || r.ep.outcome === "caught")
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
        if (j.a >= r.ep.n || j.b < 0) continue
        const A = bodies[j.a]!
        const jx = A.x + A.c * j.lax - A.s * j.lay
        const jy = A.y + A.s * j.lax + A.c * j.lay
        ctx.beginPath()
        ctx.arc(X(jx), Y(jy), Math.max(1.5, s * 0.018), 0, Math.PI * 2)
        ctx.fill()
      }
      // An eye, so you can tell which end is the head.
      if (def.id !== "biped") {
        const m = bodies[def.mouth]!
        ctx.fillStyle = "#10141a"
        ctx.beginPath()
        ctx.arc(X(m.x + m.c * m.hl * 0.6 - m.s * m.r * 0.35), Y(m.y + m.s * m.hl * 0.6 + m.c * m.r * 0.35), Math.max(1.5, s * 0.014), 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.globalAlpha = 1
  }

  private capsule(b: Body, X: XY, Y: XY, s: number, color: string, outline: number): void {
    const { ctx } = this
    const ex = b.c * b.hl, ey = b.s * b.hl
    ctx.strokeStyle = color
    ctx.lineWidth = 2 * b.r * s + outline * 2
    ctx.beginPath()
    ctx.moveTo(X(b.x - ex), Y(b.y - ey))
    ctx.lineTo(X(b.x + ex), Y(b.y + ey))
    ctx.stroke()
  }

  private drawLabel(r: Runner, X: XY, Y: XY, s: number, banner: string): void {
    const { ctx } = this
    let top = -Infinity
    for (let i = 0; i < r.ep.n; i++) {
      const b = r.ep.world.bodies[i]!
      top = Math.max(top, b.y + Math.abs(b.s * b.hl) + b.r)
    }
    const t = r.ep.torso
    const ep = r.ep
    const heist = !!ep.level.gem
    const state = (ep.finished ? ` · ${ep.time.toFixed(1)} s ✓` : ep.outcome === "caught" ? " · caught" : ep.fell ? " · fell" : "") + (heist && ep.alarms && ep.outcome !== "caught" ? ` · ${"!".repeat(ep.alarms)}` : "")
    const text = `${r.label}${heist ? (ep.carrying ? " · ◆" : "") : ` · ${Math.max(0, ep.distance).toFixed(1)} m`}${state}`
    ctx.font = `600 ${Math.round(Math.max(11, s * 0.13))}px ui-monospace, Menlo, monospace`
    ctx.textAlign = "center"
    ctx.fillStyle = r.role === "pretrained" ? "rgba(245,196,81,0.9)" : "rgba(255,226,214,0.95)"
    ctx.fillText(text, X(t.x), Y(top) - 12)
    if (banner) {
      ctx.font = `800 ${Math.round(Math.max(14, s * 0.2))}px ui-monospace, Menlo, monospace`
      ctx.fillStyle = "rgba(255,120,130,0.95)"
      ctx.fillText(banner, X(t.x), Y(top) - 12 - Math.max(18, s * 0.24))
    }
  }
}

/** Where two active beams cross, if they do. */
function cross(a: Beam, b: Beam): [number, number] | null {
  if (!a.active || !b.active) return null
  const rx = a.x2 - a.x1, ry = a.y2 - a.y1, sx = b.x2 - b.x1, sy = b.y2 - b.y1
  const den = rx * sy - ry * sx
  if (Math.abs(den) < 1e-9) return null
  const qx = b.x1 - a.x1, qy = b.y1 - a.y1
  const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [a.x1 + t * rx, a.y1 + t * ry] : null
}
