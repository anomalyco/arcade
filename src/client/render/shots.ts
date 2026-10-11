import type { LiveProjectile } from "../contracts"
import type { Crate, PowerupId } from "../../sim/protocol"
import { WEAPONS } from "../../sim/weapons"
import { glowSprite, mixHex, rgba } from "./util"

// trajectory polylines are drawn in world space (camera transform already applied)

function pathOf(g: CanvasRenderingContext2D, pts: number[], from = 0, to = pts.length / 2): void {
  g.beginPath()
  g.moveTo(pts[from * 2]!, pts[from * 2 + 1]!)
  for (let i = from + 1; i < to; i++) g.lineTo(pts[i * 2]!, pts[i * 2 + 1]!)
}

// solid fading trail with alpha ramp; split into chunks because canvas strokes cannot vary alpha
export function drawTrail(g: CanvasRenderingContext2D, pts: number[], color: string, width: number, alpha: number): void {
  const n = pts.length / 2
  if (n < 2) return
  const chunks = Math.min(10, n - 1)
  g.strokeStyle = color
  g.lineWidth = width
  g.lineCap = "round"
  g.lineJoin = "round"
  for (let c = 0; c < chunks; c++) {
    const a = Math.floor((c / chunks) * (n - 1))
    const b = Math.floor(((c + 1) / chunks) * (n - 1))
    if (b <= a) continue
    const t = (c + 1) / chunks
    g.globalAlpha = alpha * t * t
    pathOf(g, pts, a, b + 1)
    g.stroke()
  }
  g.globalAlpha = 1
}

export function drawProjectile(g: CanvasRenderingContext2D, p: LiveProjectile, team: string, now: number, bloom: boolean): void {
  const pts = p.trail.length >= 2 ? [...p.trail, p.x, p.y] : [p.x - p.vx * 0.05, p.y - p.vy * 0.05, p.x, p.y]
  const kind = p.kind === "bomblet" ? "cluster" : p.kind
  const wc = WEAPONS[kind]?.color ?? "#ffffff"
  const prevOp = g.globalCompositeOperation
  g.globalCompositeOperation = "lighter"
  drawTrail(g, pts, team, bloom ? 5 : p.kind === "bomblet" ? 1 : 1.9, bloom ? 0.9 : 0.95)
  if (!bloom) drawTrail(g, pts.slice(-24), mixHex(team, "#ffffff", 0.7), 0.7, 0.8)
  const head = mixHex(wc, "#ffffff", 0.35)
  const sp = Math.hypot(p.vx, p.vy) || 1
  const dx = p.vx / sp
  const dy = p.vy / sp
  const big = p.kind === "bomblet" ? 0.6 : 1
  const gs = (bloom ? 10 : 7) * big
  g.drawImage(glowSprite(mixHex(team, wc, 0.5)), p.x - gs, p.y - gs, gs * 2, gs * 2)
  switch (p.kind) {
    case "gravity": {
      const r = 3 + Math.sin(now * 0.02) * 0.4
      g.drawImage(glowSprite("#c06bff", 1), p.x - r * 2.4, p.y - r * 2.4, r * 4.8, r * 4.8)
      g.strokeStyle = rgba("#e2c2ff", 0.9)
      g.lineWidth = bloom ? 1.6 : 0.5
      g.beginPath()
      g.ellipse(p.x, p.y, r * 2, r * 0.7, now * 0.004, 0, Math.PI * 2)
      g.stroke()
      break
    }
    case "drill": {
      g.fillStyle = head
      g.beginPath()
      g.moveTo(p.x + dx * 4, p.y + dy * 4)
      g.lineTo(p.x - dy * 1.6 - dx * 1.5, p.y + dx * 1.6 - dy * 1.5)
      g.lineTo(p.x + dy * 1.6 - dx * 1.5, p.y - dx * 1.6 - dy * 1.5)
      g.fill()
      break
    }
    case "napalm": {
      for (let i = 0; i < 3; i++) {
        const f = 2.5 + Math.sin(now * 0.05 + i * 2) * 0.8
        const ox = -dx * (2 + i * 2.2)
        const oy = -dy * (2 + i * 2.2)
        g.drawImage(glowSprite(i === 0 ? "#ffd04a" : "#ff5a1e", 1), p.x + ox - f, p.y + oy - f, f * 2, f * 2)
      }
      break
    }
    case "builder": {
      g.strokeStyle = head
      g.lineWidth = bloom ? 1.6 : 0.6
      g.strokeRect(p.x - 2, p.y - 2, 4, 4)
      break
    }
    case "teleport": {
      const s = 2.4 + Math.sin(now * 0.03) * 0.6
      g.strokeStyle = "#ffffff"
      g.lineWidth = bloom ? 1.5 : 0.6
      g.beginPath()
      g.moveTo(p.x, p.y - s)
      g.lineTo(p.x + s, p.y)
      g.lineTo(p.x, p.y + s)
      g.lineTo(p.x - s, p.y)
      g.closePath()
      g.stroke()
      break
    }
    case "buster":
    case "shell":
    case "airstrike": {
      g.strokeStyle = head
      g.lineWidth = bloom ? 3 : 1.5
      g.beginPath()
      g.moveTo(p.x - dx * 2.5, p.y - dy * 2.5)
      g.lineTo(p.x + dx * 1.2, p.y + dy * 1.2)
      g.stroke()
      break
    }
    default:
      break
  }
  const c = (bloom ? 2.2 : 1.4) * big
  g.fillStyle = "#ffffff"
  g.beginPath()
  g.arc(p.x, p.y, c, 0, Math.PI * 2)
  g.fill()
  g.globalCompositeOperation = prevOp
}

// your aim preview: glowing dashed arc with perpendicular tick marks
export function drawPreview(g: CanvasRenderingContext2D, pts: number[], color: string, now: number, bloom: boolean): void {
  const n = pts.length / 2
  if (n < 2) return
  g.save()
  g.globalCompositeOperation = "lighter"
  g.lineCap = "round"
  g.strokeStyle = color
  g.lineWidth = bloom ? 3 : 1.1
  g.setLineDash([5, 3.2])
  g.lineDashOffset = -now * 0.012
  const chunks = 8
  for (let c = 0; c < chunks; c++) {
    const a = Math.floor((c / chunks) * (n - 1))
    const b = Math.floor(((c + 1) / chunks) * (n - 1))
    if (b <= a) continue
    g.globalAlpha = (bloom ? 0.75 : 0.95) * (1 - (c / chunks) * 0.75)
    pathOf(g, pts, a, b + 1)
    g.stroke()
  }
  g.setLineDash([])
  if (!bloom) {
    // tick marks every ~18 world px
    let acc = 0
    g.lineWidth = 0.6
    for (let i = 1; i < n; i++) {
      const x0 = pts[i * 2 - 2]!
      const y0 = pts[i * 2 - 1]!
      const x1 = pts[i * 2]!
      const y1 = pts[i * 2 + 1]!
      const L = Math.hypot(x1 - x0, y1 - y0)
      acc += L
      if (acc >= 18 && L > 0) {
        acc = 0
        const nx = -(y1 - y0) / L
        const ny = (x1 - x0) / L
        g.globalAlpha = 0.85 * (1 - (i / n) * 0.7)
        g.beginPath()
        g.moveTo(x1 - nx * 1.8, y1 - ny * 1.8)
        g.lineTo(x1 + nx * 1.8, y1 + ny * 1.8)
        g.stroke()
      }
    }
  }
  const ex = pts[pts.length - 2]!
  const ey = pts[pts.length - 1]!
  g.globalAlpha = 0.6
  g.drawImage(glowSprite(color), ex - 6, ey - 6, 12, 12)
  g.globalAlpha = 1
  g.restore()
}

export function drawGhost(g: CanvasRenderingContext2D, pts: number[], color: string, locked: boolean, bloom: boolean): void {
  const n = pts.length / 2
  if (n < 2) return
  g.save()
  g.globalCompositeOperation = "lighter"
  g.strokeStyle = color
  g.lineWidth = bloom ? 2 : 0.8
  g.setLineDash([4, 4])
  const chunks = 6
  for (let c = 0; c < chunks; c++) {
    const a = Math.floor((c / chunks) * (n - 1))
    const b = Math.floor(((c + 1) / chunks) * (n - 1))
    if (b <= a) continue
    g.globalAlpha = (locked ? 0.55 : 0.38) * (1 - c / chunks) * (bloom ? 0.6 : 1)
    pathOf(g, pts, a, b + 1)
    g.stroke()
  }
  g.restore()
}

// angle / power ring around your unit (moment-3 style fan)
export function drawAimRing(g: CanvasRenderingContext2D, x: number, y: number, angle: number, power: number, color: string, bloom: boolean): void {
  const r0 = 18
  const r1 = 34
  const span = 0.5
  const a0 = -angle - span
  const a1 = -angle + span
  g.save()
  g.globalCompositeOperation = "lighter"
  g.translate(x, y)
  if (!bloom) {
    const grd = g.createRadialGradient(0, 0, r0, 0, 0, r1)
    grd.addColorStop(0, rgba(color, 0.02))
    grd.addColorStop(1, rgba(color, 0.22))
    g.fillStyle = grd
    g.beginPath()
    g.arc(0, 0, r1, a0, a1)
    g.arc(0, 0, r0, a1, a0, true)
    g.closePath()
    g.fill()
  }
  g.strokeStyle = color
  g.lineWidth = bloom ? 2 : 0.7
  g.globalAlpha = 0.9
  g.beginPath()
  g.arc(0, 0, r1, a0, a1)
  g.stroke()
  g.globalAlpha = 0.5
  g.lineWidth = bloom ? 1.4 : 0.4
  g.beginPath()
  g.arc(0, 0, r0, a0, a1)
  g.moveTo(Math.cos(a0) * r0, Math.sin(a0) * r0)
  g.lineTo(Math.cos(a0) * r1, Math.sin(a0) * r1)
  g.moveTo(Math.cos(a1) * r0, Math.sin(a1) * r0)
  g.lineTo(Math.cos(a1) * r1, Math.sin(a1) * r1)
  g.stroke()
  // power gauge: thick arc segment on an outer track
  const pr = r1 + 3
  const pa0 = -angle + span
  const pa1 = pa0 - span * 2 * Math.max(0.02, power / 100)
  g.globalAlpha = 0.25
  g.lineWidth = bloom ? 3 : 1.6
  g.beginPath()
  g.arc(0, 0, pr, -angle - span, -angle + span)
  g.stroke()
  g.globalAlpha = 1
  g.beginPath()
  g.arc(0, 0, pr, pa1, pa0)
  g.stroke()
  if (!bloom) {
    // tick marks on the protractor every 10 degrees
    g.globalAlpha = 0.55
    g.lineWidth = 0.35
    g.beginPath()
    for (let a = Math.ceil((angle - span) / 0.1745) * 0.1745; a <= angle + span; a += 0.1745) {
      const c = Math.cos(-a)
      const s = Math.sin(-a)
      g.moveTo(c * (r1 - 2), s * (r1 - 2))
      g.lineTo(c * r1, s * r1)
    }
    g.stroke()
  }
  g.restore()
}

export const POWERUP_COLORS: Record<PowerupId, string> = {
  credits: "#ffd84a",
  weapon: "#ff8a1f",
  shield: "#5ac8ff",
  boost: "#ff3df0",
  repair: "#a6ff3d",
  preview: "#e8f0ff",
  fuel: "#4affc1",
}

const POWERUP_GLYPH: Record<PowerupId, string> = {
  credits: "$",
  weapon: "W",
  shield: "S",
  boost: "B",
  repair: "+",
  preview: "P",
  fuel: "F",
}

export function drawCrate(g: CanvasRenderingContext2D, c: Crate, now: number, bloom: boolean): void {
  const col = POWERUP_COLORS[c.kind] ?? "#ffffff"
  const sway = c.landed ? 0 : Math.sin(now * 0.003 + c.id) * 0.18
  g.save()
  g.translate(c.x, c.y)
  g.rotate(sway)
  if (!c.landed) {
    // parachute canopy
    g.save()
    g.translate(0, -7)
    if (!bloom) {
      g.fillStyle = rgba("#0d141e", 0.95)
      g.beginPath()
      g.moveTo(-10, -14)
      g.quadraticCurveTo(0, -26, 10, -14)
      g.quadraticCurveTo(5, -16, 0, -14)
      g.quadraticCurveTo(-5, -16, -10, -14)
      g.fill()
    }
    g.strokeStyle = col
    g.lineWidth = bloom ? 1.4 : 0.55
    g.beginPath()
    g.moveTo(-10, -14)
    g.quadraticCurveTo(0, -26, 10, -14)
    g.moveTo(-10, -14)
    g.lineTo(-3, 0)
    g.moveTo(10, -14)
    g.lineTo(3, 0)
    g.moveTo(0, -14)
    g.lineTo(0, 0)
    g.stroke()
    g.restore()
  }
  if (!bloom) {
    g.fillStyle = "#121821"
    g.fillRect(-4, -7, 8, 7)
  }
  g.strokeStyle = col
  g.lineWidth = bloom ? 1.6 : 0.6
  g.strokeRect(-4, -7, 8, 7)
  if (!bloom) {
    g.fillStyle = col
    g.font = `800 5px "Rajdhani","Arial Narrow",sans-serif`
    g.textAlign = "center"
    g.textBaseline = "middle"
    g.fillText(POWERUP_GLYPH[c.kind] ?? "?", 0, -3.4)
  } else {
    g.globalCompositeOperation = "lighter"
    g.globalAlpha = 0.5 + 0.3 * Math.sin(now * 0.006 + c.id)
    g.drawImage(glowSprite(col), -8, -12, 16, 16)
  }
  g.restore()
}
