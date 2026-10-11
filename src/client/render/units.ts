import type { Unit } from "../../sim/protocol"
import { mixHex, rgba } from "./util"

// The tank is drawn procedurally in a local frame: origin at the ground contact point, +x = facing direction, -y = up.
// Main pass: dark gunmetal body, thin team-color edge trim, small lights. Glow pass: only the trim edges and lights,
// so the bloom outlines the silhouette without washing the body out.

export const UNIT_SCALE = 1.3

type PathFn = (g: CanvasRenderingContext2D) => void

const TRACK: PathFn = (g) => g.roundRect(-11.5, -6, 23, 6, 3)
const DECK: PathFn = (g) => {
  g.moveTo(-12, -5.6)
  g.lineTo(12, -5.6)
  g.lineTo(10.6, -7.6)
  g.lineTo(-10.8, -7.6)
  g.closePath()
}
const TURRET: PathFn = (g) => {
  g.moveTo(-7.5, -7.6)
  g.lineTo(5.5, -7.6)
  g.lineTo(7.2, -9.2)
  g.lineTo(3.2, -12)
  g.lineTo(-4.2, -12.4)
  g.lineTo(-7.6, -10.2)
  g.closePath()
}
// turret top edge, the part that catches the light
const TURRET_TOP: PathFn = (g) => {
  g.moveTo(-7.6, -10.2)
  g.lineTo(-4.2, -12.4)
  g.lineTo(3.2, -12)
  g.lineTo(7.2, -9.2)
}
const BARREL: PathFn = (g) => {
  g.moveTo(1, -1.15)
  g.lineTo(13.6, -0.75)
  g.lineTo(13.6, 0.75)
  g.lineTo(1, 1.15)
  g.closePath()
}
const PIVOT_X = 3.6
const PIVOT_Y = -9.8
const WHEELS: Array<[number, number]> = [
  [-8.6, 2.1],
  [-4.4, 1.25],
  [-1.4, 1.25],
  [1.6, 1.25],
  [4.6, 1.25],
  [8.6, 2.1],
]

function body(g: CanvasRenderingContext2D, top: string, bottom: string): CanvasGradient {
  const grd = g.createLinearGradient(0, -13, 0, 0)
  grd.addColorStop(0, top)
  grd.addColorStop(1, bottom)
  return grd
}

function drawTank(g: CanvasRenderingContext2D, color: string, aim: number, glow: boolean, wreck: boolean): void {
  const edge = wreck ? "#3a3632" : color
  const bright = mixHex(color, "#ffffff", 0.45)
  if (glow) {
    if (wreck) return
    g.strokeStyle = color
    g.lineWidth = 0.9
    g.beginPath()
    TRACK(g)
    g.stroke()
    g.beginPath()
    TURRET_TOP(g)
    g.stroke()
    g.save()
    g.translate(PIVOT_X, PIVOT_Y)
    g.rotate(-aim)
    g.beginPath()
    g.moveTo(1, -1.15)
    g.lineTo(13.6, -0.75)
    g.stroke()
    g.restore()
    g.fillStyle = "#ffffff"
    g.beginPath()
    g.arc(11.4, -6.6, 1.2, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = color
    g.beginPath()
    g.arc(-1.6, -11, 1, 0, Math.PI * 2)
    g.fill()
    return
  }

  // barrel and mantlet sit behind the turret
  g.save()
  g.translate(PIVOT_X, PIVOT_Y)
  g.rotate(-aim)
  g.beginPath()
  BARREL(g)
  g.fillStyle = wreck ? "#0e0e0f" : "#0c1016"
  g.fill()
  g.strokeStyle = wreck ? edge : rgba(color, 0.55)
  g.lineWidth = 0.35
  g.stroke()
  if (!wreck) {
    g.beginPath()
    g.moveTo(1.5, -1.1)
    g.lineTo(13.4, -0.72)
    g.strokeStyle = bright
    g.lineWidth = 0.4
    g.stroke()
  }
  g.beginPath()
  g.rect(12.8, -1.15, 2.4, 2.3)
  g.fillStyle = wreck ? "#121212" : "#141a22"
  g.fill()
  g.strokeStyle = wreck ? edge : color
  g.lineWidth = 0.35
  g.stroke()
  g.beginPath()
  g.rect(-1.4, -1.8, 3.2, 3.6)
  g.fillStyle = wreck ? "#111" : "#161c25"
  g.fill()
  g.restore()

  // track pod
  g.beginPath()
  TRACK(g)
  g.fillStyle = wreck ? "#0c0c0d" : "#0a0d12"
  g.fill()
  g.strokeStyle = edge
  g.lineWidth = 0.55
  g.stroke()
  for (const [x, r] of WHEELS) {
    g.beginPath()
    g.arc(x, -3, r, 0, Math.PI * 2)
    g.fillStyle = wreck ? "#141414" : "#151b24"
    g.fill()
    g.strokeStyle = wreck ? "#2a2826" : rgba(color, r > 2 ? 0.8 : 0.45)
    g.lineWidth = 0.35
    g.stroke()
    if (r > 2) {
      g.beginPath()
      g.arc(x, -3, 0.7, 0, Math.PI * 2)
      g.fillStyle = wreck ? "#222" : rgba(color, 0.7)
      g.fill()
    }
  }

  // hull deck
  g.beginPath()
  DECK(g)
  g.fillStyle = wreck ? "#151516" : body(g, "#2a323d", "#141920")
  g.fill()
  g.beginPath()
  g.moveTo(-10.8, -7.6)
  g.lineTo(10.6, -7.6)
  g.lineTo(12, -5.6)
  g.strokeStyle = wreck ? edge : bright
  g.lineWidth = 0.45
  g.stroke()

  // turret: dark gunmetal with a faint team-tinted top face
  g.beginPath()
  TURRET(g)
  g.fillStyle = wreck ? "#131314" : body(g, mixHex(color, "#1c232d", 0.85), "#10141b")
  g.fill()
  g.strokeStyle = wreck ? edge : rgba(color, 0.6)
  g.lineWidth = 0.35
  g.stroke()
  g.beginPath()
  TURRET_TOP(g)
  g.strokeStyle = wreck ? edge : bright
  g.lineWidth = 0.5
  g.stroke()
  if (!wreck) {
    // panel seam and vision slit
    g.beginPath()
    g.moveTo(-5.4, -9.4)
    g.lineTo(4.6, -9.4)
    g.strokeStyle = rgba(color, 0.35)
    g.lineWidth = 0.3
    g.stroke()
    // antenna
    g.beginPath()
    g.moveTo(-5, -12.2)
    g.lineTo(-6.8, -17)
    g.strokeStyle = "#2a323d"
    g.lineWidth = 0.35
    g.stroke()
    g.fillStyle = bright
    g.fillRect(-7.1, -17.3, 0.6, 0.6)
    // lights
    g.fillStyle = "#f4fbff"
    g.beginPath()
    g.arc(11.4, -6.6, 0.5, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = bright
    g.beginPath()
    g.arc(-1.6, -11, 0.42, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = rgba(color, 0.9)
    g.fillRect(-11.2, -7.1, 1.2, 0.7)
  } else {
    // scorched hull glow
    g.fillStyle = "rgba(255,110,40,0.35)"
    g.fillRect(-3, -9, 4, 0.6)
  }
}

export function drawUnitBody(g: CanvasRenderingContext2D, u: Unit, color: string, _t: number, glow: boolean): void {
  const wreck = !u.alive
  const cos = Math.cos(u.angle)
  const face = cos >= 0 ? 1 : -1
  // aim angle in the local mirrored frame: 0 = forward, PI/2 = up
  const aim = wreck ? -0.22 : Math.atan2(Math.sin(u.angle), Math.abs(cos))
  g.save()
  g.translate(u.x, u.y)
  if (wreck) g.rotate(face * 0.1)
  g.scale(face * UNIT_SCALE, UNIT_SCALE)
  g.lineJoin = "round"
  g.lineCap = "round"
  drawTank(g, color, aim, glow, wreck)
  g.restore()
}

export function drawChevron(g: CanvasRenderingContext2D, x: number, y: number, color: string, size: number, glow: boolean): void {
  const base = g.globalAlpha
  g.save()
  g.translate(x, y)
  g.lineJoin = "miter"
  g.lineCap = "butt"
  g.strokeStyle = color
  g.lineWidth = glow ? 2.6 * size : 1.25 * size
  for (let i = 0; i < 2; i++) {
    const oy = i * 2.6 * size
    g.beginPath()
    g.moveTo(-3.2 * size, -2 * size + oy)
    g.lineTo(0, 0.6 * size + oy)
    g.lineTo(3.2 * size, -2 * size + oy)
    g.globalAlpha = base * (i === 0 ? 0.6 : 1)
    g.stroke()
  }
  g.restore()
}

export function drawShield(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, t: number, glow: boolean, flash: number): void {
  const pulse = 0.75 + Math.sin(t * 0.005) * 0.15 + flash
  g.save()
  g.translate(x, y)
  if (!glow) {
    const grd = g.createRadialGradient(0, 0, r * 0.4, 0, 0, r)
    grd.addColorStop(0, rgba(color, 0))
    grd.addColorStop(0.85, rgba(color, 0.1 * pulse))
    grd.addColorStop(1, rgba(color, 0.28 * pulse))
    g.fillStyle = grd
    g.beginPath()
    g.arc(0, 0, r, 0, Math.PI * 2)
    g.fill()
    g.save()
    g.clip()
    g.strokeStyle = rgba(color, 0.18 * pulse)
    g.lineWidth = 0.35
    const s = 3.2
    const hh = s * Math.sqrt(3)
    g.beginPath()
    for (let row = -6; row <= 6; row++) {
      for (let col = -5; col <= 5; col++) {
        const cx = col * s * 3 + (row & 1 ? s * 1.5 : 0)
        const cy = (row * hh) / 2
        for (let k = 0; k < 6; k++) {
          const an = (k / 6) * Math.PI * 2
          const px = cx + Math.cos(an) * s
          const py = cy + Math.sin(an) * s
          if (k === 0) g.moveTo(px, py)
          else g.lineTo(px, py)
        }
        g.closePath()
      }
    }
    g.stroke()
    g.restore()
  }
  g.beginPath()
  for (let k = 0; k <= 6; k++) {
    const an = (k / 6) * Math.PI * 2 + Math.PI / 6
    const px = Math.cos(an) * r
    const py = Math.sin(an) * r
    if (k === 0) g.moveTo(px, py)
    else g.lineTo(px, py)
  }
  g.strokeStyle = rgba(color, (glow ? 0.7 : 0.85) * pulse)
  g.lineWidth = glow ? 2 : 0.6
  g.stroke()
  g.restore()
}
