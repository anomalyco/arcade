import type { WeaponId } from "../../sim/weapons"
import { rgba } from "./common"

// Procedural trajectory illustration for the armory detail panel: layered ridges, a
// glowing terrain edge, the firing unit, a dashed arc and a weapon-specific impact.

function rand(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function ground(x: number, w: number, hgt: number): number {
  // high plateau left, valley right-of-center, rising cliff far right
  const u = x / w
  let y = 0.52
  if (u < 0.3) y = 0.5
  else if (u < 0.36) y = 0.5 + (u - 0.3) * 2.5
  else if (u < 0.62) y = 0.66 + Math.sin(u * 30) * 0.015
  else if (u < 0.82) y = 0.66 + Math.pow((u - 0.62) / 0.2, 2) * 0.22
  else y = 0.88 - (u - 0.82) * 2.6
  return Math.max(0.42, y) * hgt
}

export function drawPreview(ctx: CanvasRenderingContext2D, w: number, hgt: number, weapon: WeaponId | null, color: string, t: number): void {
  ctx.clearRect(0, 0, w, hgt)
  const sky = ctx.createLinearGradient(0, 0, 0, hgt)
  sky.addColorStop(0, "#0a1826")
  sky.addColorStop(1, "#0d2232")
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, w, hgt)

  // stars / grid dots
  ctx.fillStyle = "rgba(160,200,230,0.18)"
  for (let x = 12; x < w; x += 24) for (let y = 10; y < hgt * 0.5; y += 24) ctx.fillRect(x, y, 1, 1)

  // far mountains
  const r = rand(7)
  for (let layer = 0; layer < 2; layer++) {
    ctx.fillStyle = layer === 0 ? "#12283a" : "#0f2131"
    ctx.beginPath()
    ctx.moveTo(0, hgt)
    let x = 0
    const base = hgt * (0.5 + layer * 0.08)
    while (x <= w + 30) {
      ctx.lineTo(x, base - r() * hgt * (0.22 - layer * 0.06))
      x += 18 + r() * 26
    }
    ctx.lineTo(w, hgt)
    ctx.fill()
  }

  // terrain mass
  const land = new Path2D()
  land.moveTo(0, hgt)
  for (let x = 0; x <= w; x += 3) land.lineTo(x, ground(x, w, hgt))
  land.lineTo(w, hgt)
  land.closePath()
  ctx.fillStyle = "#0b0f14"
  ctx.fill(land)
  ctx.save()
  ctx.clip(land)
  ctx.strokeStyle = "rgba(120,150,170,0.08)"
  for (let k = 0; k < 8; k++) {
    ctx.beginPath()
    for (let x = 0; x <= w; x += 6) ctx.lineTo(x, ground(x, w, hgt) + 10 + k * 13 + Math.sin(x * 0.05 + k) * 3)
    ctx.stroke()
  }
  ctx.restore()
  // edge glow
  ctx.save()
  ctx.shadowColor = "rgba(90,200,255,0.6)"
  ctx.shadowBlur = 6
  ctx.strokeStyle = "rgba(150,215,240,0.75)"
  ctx.lineWidth = 1.2
  ctx.beginPath()
  for (let x = 0; x <= w; x += 3) ctx.lineTo(x, ground(x, w, hgt))
  ctx.stroke()
  ctx.restore()

  // unit
  const ux = w * 0.12
  const uy = ground(ux, w, hgt)
  ctx.save()
  ctx.shadowColor = color
  ctx.shadowBlur = 8
  ctx.strokeStyle = color
  ctx.fillStyle = "#0b1218"
  ctx.lineWidth = 1.4
  ctx.beginPath()
  ctx.roundRect(ux - 14, uy - 9, 28, 7, 3)
  ctx.fill()
  ctx.stroke()
  ctx.beginPath()
  ctx.roundRect(ux - 8, uy - 14, 14, 6, 2)
  ctx.fill()
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(ux + 2, uy - 12)
  ctx.lineTo(ux + 16, uy - 21)
  ctx.stroke()
  ctx.restore()

  if (!weapon) return

  // arc
  const tx = weapon === "builder" ? w * 0.48 : weapon === "teleport" ? w * 0.74 : w * 0.7
  const ty = ground(tx, w, hgt)
  const sx = ux + 16
  const sy = uy - 21
  const peak = hgt * 0.08
  const pt = (u: number): [number, number] => {
    const x = sx + (tx - sx) * u
    const y = (1 - u) * (1 - u) * sy + 2 * (1 - u) * u * (peak - (sy - peak) * 0.3) + u * u * ty
    return [x, y]
  }
  const split = weapon === "cluster" || weapon === "mirv"
  const stopAt = split ? 0.5 : weapon === "airstrike" ? 0.45 : 1
  ctx.save()
  ctx.strokeStyle = rgba(color, 0.9)
  ctx.shadowColor = color
  ctx.shadowBlur = 6
  ctx.lineWidth = 1.6
  ctx.setLineDash([6, 5])
  ctx.lineDashOffset = -t * 0.03
  ctx.beginPath()
  for (let u = 0; u <= stopAt + 0.001; u += 0.02) {
    const [x, y] = pt(u)
    if (u === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()

  if (split) {
    const [ax, ay] = pt(0.5)
    const n = weapon === "cluster" ? 5 : 3
    for (let i = 0; i < n; i++) {
      const ex = tx + (i - (n - 1) / 2) * (weapon === "cluster" ? 18 : 34)
      const ey = ground(ex, w, hgt)
      ctx.beginPath()
      ctx.moveTo(ax, ay)
      ctx.quadraticCurveTo((ax + ex) / 2 + 10, ay - 6, ex, ey)
      ctx.stroke()
    }
  }
  if (weapon === "airstrike") {
    for (let i = 0; i < 4; i++) {
      const ex = w * 0.55 + i * 26
      ctx.beginPath()
      ctx.moveTo(ex - 10, hgt * 0.12)
      ctx.lineTo(ex, ground(ex, w, hgt))
      ctx.stroke()
    }
  }
  ctx.restore()

  // impact
  const boom = (x: number, y: number, rr: number) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, rr)
    g.addColorStop(0, "rgba(255,255,255,0.95)")
    g.addColorStop(0.25, rgba(color, 0.85))
    g.addColorStop(1, rgba(color, 0))
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y, rr, 0, Math.PI * 2)
    ctx.fill()
    const rs = rand(Math.round(x * 13 + y))
    ctx.fillStyle = rgba(color, 0.9)
    for (let i = 0; i < 14; i++) {
      const a = -Math.PI * rs()
      const d = rr * (0.5 + rs() * 0.9)
      ctx.fillRect(x + Math.cos(a) * d, y + Math.sin(a) * d, 1.6, 1.6)
    }
  }
  const pulse = 0.85 + Math.sin(t * 0.006) * 0.15
  ctx.save()
  ctx.globalCompositeOperation = "lighter"
  switch (weapon) {
    case "drill":
    case "buster": {
      const depth = weapon === "drill" ? 46 : 34
      ctx.strokeStyle = rgba(color, 0.8)
      ctx.lineWidth = weapon === "drill" ? 5 : 3
      ctx.beginPath()
      ctx.moveTo(tx, ty)
      ctx.lineTo(tx + (weapon === "drill" ? 22 : 6), ty + depth)
      ctx.stroke()
      boom(tx + (weapon === "drill" ? 22 : 6), ty + depth, 22 * pulse)
      break
    }
    case "napalm":
      for (let i = -3; i <= 3; i++) {
        const x = tx + i * 9
        const y = ground(x, w, hgt)
        const fh = (10 + Math.abs(Math.sin(i * 1.7 + t * 0.008)) * 12) * (1 - Math.abs(i) / 5)
        const g = ctx.createLinearGradient(x, y - fh, x, y)
        g.addColorStop(0, rgba(color, 0))
        g.addColorStop(1, rgba(color, 0.9))
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.moveTo(x - 6, y)
        ctx.quadraticCurveTo(x, y - fh * 1.4, x + 6, y)
        ctx.fill()
      }
      break
    case "gravity":
      ctx.strokeStyle = rgba(color, 0.85)
      ctx.lineWidth = 1.5
      for (let k = 0; k < 3; k++) {
        ctx.beginPath()
        for (let a = 0; a < Math.PI * 3; a += 0.15) {
          const rr = 2 + a * 4.5 + k * 2
          const aa = a + t * 0.004 + k * 2
          ctx.lineTo(tx + Math.cos(aa) * rr, ty - 14 + Math.sin(aa) * rr * 0.7)
        }
        ctx.stroke()
      }
      break
    case "builder":
      ctx.fillStyle = rgba(color, 0.18)
      ctx.strokeStyle = rgba(color, 0.9)
      ctx.lineWidth = 1.2
      for (let row = 0; row < 3; row++)
        for (let c = 0; c < 3 - (row === 2 ? 1 : 0); c++) {
          const bx = tx - 18 + c * 13 + (row === 2 ? 6 : 0)
          const by = ty - 10 - row * 9
          ctx.fillRect(bx, by, 12, 8)
          ctx.strokeRect(bx, by, 12, 8)
        }
      break
    case "bouncer": {
      ctx.strokeStyle = rgba(color, 0.7)
      ctx.setLineDash([3, 4])
      ctx.lineWidth = 1.4
      let x = tx
      for (let i = 0; i < 3; i++) {
        const nx = x + 26 - i * 6
        ctx.beginPath()
        ctx.moveTo(x, ground(x, w, hgt))
        ctx.quadraticCurveTo((x + nx) / 2, ground(x, w, hgt) - 26 + i * 6, nx, ground(nx, w, hgt))
        ctx.stroke()
        x = nx
      }
      ctx.setLineDash([])
      boom(x, ground(x, w, hgt), 20 * pulse)
      break
    }
    case "shield":
      ctx.strokeStyle = rgba(color, 0.9)
      ctx.fillStyle = rgba(color, 0.12)
      ctx.lineWidth = 1.6
      ctx.beginPath()
      ctx.arc(ux, uy - 4, 26 * pulse, Math.PI, 0)
      ctx.fill()
      ctx.stroke()
      break
    case "teleport":
      ctx.strokeStyle = rgba(color, 0.8)
      ctx.lineWidth = 1.2
      for (let k = 1; k <= 3; k++) {
        ctx.beginPath()
        ctx.ellipse(tx, ty - 8, k * 7 * pulse, k * 3, 0, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.fillStyle = rgba(color, 0.9)
      ctx.fillRect(tx - 1.5, ty - 22, 3, 14)
      break
    case "cluster":
    case "mirv": {
      const n = weapon === "cluster" ? 5 : 3
      for (let i = 0; i < n; i++) {
        const ex = tx + (i - (n - 1) / 2) * (weapon === "cluster" ? 18 : 34)
        boom(ex, ground(ex, w, hgt), (weapon === "cluster" ? 11 : 18) * pulse)
      }
      break
    }
    case "airstrike":
      for (let i = 0; i < 4; i++) {
        const ex = w * 0.55 + i * 26
        boom(ex, ground(ex, w, hgt), 15 * pulse)
      }
      break
    default:
      boom(tx, ty, 26 * pulse)
  }
  ctx.restore()

  // projectile marker travelling the arc
  if (weapon !== "shield") {
    const u = ((t * 0.00045) % 1) * stopAt
    const [px, py] = pt(u)
    ctx.save()
    ctx.fillStyle = "#fff"
    ctx.shadowColor = color
    ctx.shadowBlur = 10
    ctx.beginPath()
    ctx.arc(px, py, 2.6, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
}
