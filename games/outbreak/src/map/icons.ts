import type { PoiKind } from "./memory"

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/**
 * Draws a POI glyph centred on the current origin, `s` pixels across, in the current fill and stroke. Cut-outs are
 * painted in `hole` when given (a badge behind the glyph), otherwise erased.
 */
export function drawGlyph(ctx: Ctx2D, kind: PoiKind, s: number, hole?: string): void {
  const u = s / 12
  const cut = (x: number, y: number, w: number, h: number) => {
    ctx.save()
    if (hole) ctx.fillStyle = hole
    else ctx.globalCompositeOperation = "destination-out"
    ctx.fillRect(x * u, y * u, w * u, h * u)
    ctx.restore()
  }
  ctx.save()
  ctx.lineWidth = Math.max(1, 1.3 * u)
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  ctx.beginPath()
  switch (kind) {
    case "pharmacy":
      ctx.rect(-1.4 * u, -4.5 * u, 2.8 * u, 9 * u)
      ctx.rect(-4.5 * u, -1.4 * u, 9 * u, 2.8 * u)
      ctx.fill()
      break
    case "clinic":
      ctx.arc(0, 0, 4.8 * u, 0, Math.PI * 2)
      ctx.stroke()
      ctx.beginPath()
      ctx.rect(-1 * u, -3 * u, 2 * u, 6 * u)
      ctx.rect(-3 * u, -1 * u, 6 * u, 2 * u)
      ctx.fill()
      break
    case "hardware":
      ctx.moveTo(-3.6 * u, 4.4 * u)
      ctx.lineTo(1.2 * u, -0.4 * u)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(-0.6 * u, -3.4 * u)
      ctx.lineTo(2.2 * u, -4.8 * u)
      ctx.lineTo(4.8 * u, -2.2 * u)
      ctx.lineTo(3.4 * u, 0.6 * u)
      ctx.closePath()
      ctx.fill()
      break
    case "gas_station":
      ctx.rect(-4 * u, -4.5 * u, 5.2 * u, 9 * u)
      ctx.fill()
      ctx.beginPath()
      ctx.moveTo(1.2 * u, -1.5 * u)
      ctx.lineTo(3.6 * u, -0.5 * u)
      ctx.lineTo(3.6 * u, 3 * u)
      ctx.stroke()
      cut(-3, -3.5, 3.2, 2.4)
      break
    case "police": {
      for (let i = 0; i < 10; i++) {
        const r = (i % 2 ? 2.1 : 5) * u
        const a = -Math.PI / 2 + (i * Math.PI) / 5
        if (i) ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r)
        else ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r)
      }
      ctx.closePath()
      ctx.fill()
      break
    }
    case "church":
      ctx.rect(-0.9 * u, -5 * u, 1.8 * u, 10 * u)
      ctx.rect(-3.4 * u, -2.6 * u, 6.8 * u, 1.8 * u)
      ctx.fill()
      break
    case "grocery":
      ctx.moveTo(-4.8 * u, -3.6 * u)
      ctx.lineTo(-3.2 * u, -3.6 * u)
      ctx.lineTo(-2 * u, 1.6 * u)
      ctx.lineTo(3.6 * u, 1.6 * u)
      ctx.lineTo(4.6 * u, -2 * u)
      ctx.lineTo(-2.8 * u, -2 * u)
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(-1.4 * u, 3.6 * u, 1 * u, 0, Math.PI * 2)
      ctx.arc(3 * u, 3.6 * u, 1 * u, 0, Math.PI * 2)
      ctx.fill()
      break
    case "diner":
      ctx.moveTo(-4 * u, -2.4 * u)
      ctx.lineTo(2.4 * u, -2.4 * u)
      ctx.lineTo(1.6 * u, 3.6 * u)
      ctx.lineTo(-3.2 * u, 3.6 * u)
      ctx.closePath()
      ctx.fill()
      ctx.beginPath()
      ctx.arc(3 * u, 0, 1.6 * u, -Math.PI / 2, Math.PI / 2)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(-1.8 * u, -4.8 * u)
      ctx.lineTo(-1.8 * u, -3.6 * u)
      ctx.moveTo(0.4 * u, -4.8 * u)
      ctx.lineTo(0.4 * u, -3.6 * u)
      ctx.stroke()
      break
    case "warehouse":
      // Sawtooth factory roof.
      ctx.moveTo(-5 * u, 4.6 * u)
      ctx.lineTo(-5 * u, -1 * u)
      ctx.lineTo(-1.8 * u, -4.4 * u)
      ctx.lineTo(-1.8 * u, -1 * u)
      ctx.lineTo(1.4 * u, -4.4 * u)
      ctx.lineTo(1.4 * u, -1 * u)
      ctx.lineTo(5 * u, -4.4 * u)
      ctx.lineTo(5 * u, 4.6 * u)
      ctx.closePath()
      ctx.fill()
      cut(-3.2, 1.2, 1.6, 1.6)
      cut(-0.8, 1.2, 1.6, 1.6)
      cut(1.6, 1.2, 1.6, 1.6)
      break
    case "cabin":
      ctx.moveTo(0, -5.2 * u)
      ctx.lineTo(4.4 * u, 1.6 * u)
      ctx.lineTo(-4.4 * u, 1.6 * u)
      ctx.closePath()
      ctx.fill()
      ctx.fillRect(-0.8 * u, 1.6 * u, 1.6 * u, 3.2 * u)
      break
    case "safehouse":
      ctx.moveTo(-4.8 * u, -0.6 * u)
      ctx.lineTo(0, -5 * u)
      ctx.lineTo(4.8 * u, -0.6 * u)
      ctx.lineTo(3.4 * u, -0.6 * u)
      ctx.lineTo(3.4 * u, 4.6 * u)
      ctx.lineTo(-3.4 * u, 4.6 * u)
      ctx.lineTo(-3.4 * u, -0.6 * u)
      ctx.closePath()
      ctx.fill()
      // The workbench inside, cut out of the house.
      cut(-2.2, 0.8, 4.4, 1.1)
      cut(-1.9, 1.9, 0.8, 1.9)
      cut(1.1, 1.9, 0.8, 1.9)
      break
  }
  ctx.restore()
}

/** A round badge with the glyph in it; `accent` rings safehouses and the like. */
export function drawBadge(
  ctx: Ctx2D,
  kind: PoiKind,
  x: number,
  y: number,
  size: number,
  colours: { badge: string; ink: string; fill: string; accent?: string },
): void {
  const r = size / 2
  ctx.save()
  ctx.translate(Math.round(x), Math.round(y))
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  ctx.fillStyle = colours.badge
  ctx.fill()
  ctx.lineWidth = colours.accent ? 2 : 1.2
  ctx.strokeStyle = colours.accent ?? colours.ink
  ctx.stroke()
  ctx.fillStyle = colours.fill
  ctx.strokeStyle = colours.fill
  drawGlyph(ctx, kind, size * 0.62, colours.badge)
  ctx.restore()
}
