import { resolveAccentColors } from "./tours"
import type { DevNotePayload, DevNoteResolvedRect, DevNoteTarget, TourDefinition } from "./types"

export interface NoteOverlayStateReader {
  getActiveNote(): DevNotePayload | null
  getStudioTour(): TourDefinition | null
  getStudioStep(): number
  isStudioStripExpanded(): boolean
  resolveNoteTargetRect(target: DevNoteTarget, revealSetting?: boolean): DevNoteResolvedRect | null
}

export function detectGameName(pathname: string): string {
  const m = pathname.match(/^\/arcade\/([a-z0-9-]+)/)
  return m?.[1] ?? "unknown"
}

export function getSubmitListeners(): Set<() => void> {
  if (typeof window === "undefined") return new Set()
  const w = window as Window & { __arcadeSubmitListeners?: Set<() => void>; __arcadeSubmitHooked?: boolean }
  w.__arcadeSubmitListeners ??= new Set<() => void>()
  if (import.meta.env?.DEV && !w.__arcadeSubmitHooked && typeof GPUQueue !== "undefined") {
    w.__arcadeSubmitHooked = true
    const origSubmit = GPUQueue.prototype.submit
    GPUQueue.prototype.submit = function (commandBuffers) {
      const res = origSubmit.call(this, commandBuffers)
      const listeners = w.__arcadeSubmitListeners
      if (listeners && listeners.size > 0) {
        for (const fn of [...listeners]) fn()
      }
      return res
    }
  }
  return w.__arcadeSubmitListeners
}

if (import.meta.env?.DEV && typeof window !== "undefined") {
  getSubmitListeners()
}

export function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rad = Math.max(0, Math.min(r, w * 0.5, h * 0.5))
  ctx.beginPath()
  ctx.moveTo(x + rad, y)
  ctx.arcTo(x + w, y, x + w, y + h, rad)
  ctx.arcTo(x + w, y + h, x, y + h, rad)
  ctx.arcTo(x, y + h, x, y, rad)
  ctx.arcTo(x, y, x + w, y, rad)
  ctx.closePath()
}

export function drawActiveNoteOverlayToCanvas(
  targetCanvas: HTMLCanvasElement,
  sourceCanvas: HTMLCanvasElement,
  rt: NoteOverlayStateReader | null | undefined,
) {
  if (!rt) return
  const note = rt.getActiveNote()
  const studioTour = rt.getStudioTour()
  const studioStep = rt.getStudioStep()
  const showStrip = Boolean(studioTour && studioTour.singleTab !== false && rt.isStudioStripExpanded())
  if (!note && !showStrip) return
  const ctx = targetCanvas.getContext("2d")
  if (!ctx) return

  const cw = targetCanvas.width
  const ch = targetCanvas.height
  const cRect = sourceCanvas.getBoundingClientRect()
  const refW = Math.max(1, cRect.width || window.innerWidth || cw)
  const refH = Math.max(1, cRect.height || window.innerHeight || ch)
  const sx = cw / refW
  const sy = ch / refH

  // 0. Draw Studio Tab Strip across the top if active
  if (showStrip && studioTour) {
    ctx.save()
    const stripH = 28 * sy
    ctx.fillStyle = "rgba(12, 14, 18, 0.96)"
    ctx.fillRect(0, 0, cw, stripH)
    ctx.fillStyle = "rgba(44, 52, 62, 0.85)"
    ctx.fillRect(0, stripH - 1, cw, 1)

    const monoFont = `600 ${Math.max(8, Math.round(10 * sx))}px ui-monospace, SFMono-Regular, Menlo, monospace`
    const tabFont = `500 ${Math.max(9, Math.round(11 * sx))}px system-ui, -apple-system, sans-serif`
    let x = 10 * sx
    ctx.font = monoFont
    ctx.fillStyle = "#7cc5d6"
    ctx.textBaseline = "middle"
    const badge = `◫ ${studioStep}/${studioTour.steps.length}`
    ctx.fillText(badge, x, stripH * 0.5)
    x += ctx.measureText(badge).width + 12 * sx

    for (let i = 0; i < studioTour.steps.length; i++) {
      const s = studioTour.steps[i]!
      const num = i + 1
      const active = num === studioStep
      const shortTitle = s.title.length > 24 ? `${s.title.slice(0, 23)}…` : s.title
      const label = `${num} ${shortTitle}`
      ctx.font = tabFont
      const tw = ctx.measureText(label).width + 14 * sx
      if (x + tw > cw - 50 * sx) break
      const th = 20 * sy
      const ty = (stripH - th) * 0.5
      roundRectPath(ctx, x, ty, tw, th, 4 * sx)
      const stepColors = resolveAccentColors(s.accent)
      ctx.fillStyle = active ? "rgba(77, 141, 255, 0.2)" : "rgba(255, 255, 255, 0.04)"
      ctx.fill()
      ctx.strokeStyle = active ? stepColors.text : "rgba(255, 255, 255, 0.1)"
      ctx.lineWidth = Math.max(1, (active ? 1.4 : 0.8) * sx)
      ctx.stroke()
      ctx.fillStyle = active ? "#f2f6fa" : "#8b949e"
      ctx.fillText(label, x + 7 * sx, stripH * 0.5)
      x += tw + 5 * sx
    }
    ctx.restore()
  }

  if (!note) return
  const colors = resolveAccentColors(note.accent)

  // 1. Draw target highlight ring if resolved and overlapping the canvas
  const targetRect = note.target ? rt.resolveNoteTargetRect(note.target, false) : null
  if (targetRect && targetRect.width > 0 && targetRect.height > 0) {
    const localX = targetRect.x - cRect.left
    const localY = targetRect.y - cRect.top
    const overlapsCanvas =
      localX + targetRect.width > 4 && localX < refW - 4 && localY + targetRect.height > 4 && localY < refH - 4
    if (overlapsCanvas) {
      const pad = 6
      const rx = (localX - pad) * sx
      const ry = (localY - pad) * sy
      const rw = (targetRect.width + pad * 2) * sx
      const rh = (targetRect.height + pad * 2) * sy
      const radius = targetRect.shape === "pill" ? Math.min(rw, rh) * 0.5 : 8 * sx

      ctx.save()
      if (note.target?.selector) {
        const domEl = document.querySelector<HTMLElement>(note.target.selector)
        const text = domEl?.innerText?.replace(/\s+/g, " ").trim()
        if (text) {
          roundRectPath(ctx, localX * sx, localY * sy, targetRect.width * sx, targetRect.height * sy, 6 * sx)
          ctx.fillStyle = "rgba(12, 16, 20, 0.88)"
          ctx.fill()
          ctx.font = `600 ${Math.max(10, Math.round(12 * sx))}px system-ui, -apple-system, sans-serif`
          ctx.fillStyle = "#eef4f8"
          ctx.textBaseline = "middle"
          ctx.fillText(text, (localX + 10) * sx, (localY + targetRect.height * 0.5) * sy)
        }
      }

      roundRectPath(ctx, rx - 3 * sx, ry - 3 * sy, rw + 6 * sx, rh + 6 * sy, radius + 3 * sx)
      ctx.strokeStyle = colors.glow
      ctx.lineWidth = Math.max(3, 5 * sx)
      ctx.stroke()

      roundRectPath(ctx, rx, ry, rw, rh, radius)
      ctx.strokeStyle = colors.text
      ctx.lineWidth = Math.max(2, 2.2 * sx)
      ctx.stroke()
      ctx.restore()
    }
  }

  // 2. Draw top-centered "Show me" card
  ctx.save()
  const topPx = (showStrip ? 36 : 10) * sy
  const titleFont = `600 ${Math.max(11, Math.round(13 * sx))}px system-ui, -apple-system, sans-serif`
  const bodyFont = `400 ${Math.max(10, Math.round(11.5 * sx))}px system-ui, -apple-system, sans-serif`
  const monoFont = `600 ${Math.max(9, Math.round(10.5 * sx))}px ui-monospace, SFMono-Regular, Menlo, monospace`

  ctx.font = titleFont
  const titleText = `▸ ${note.title}`
  const titleW = ctx.measureText(titleText).width
  ctx.font = bodyFont
  const bodyText = note.body ? (note.body.length > 96 ? `${note.body.slice(0, 95)}…` : note.body) : ""
  const bodyW = bodyText ? ctx.measureText(bodyText).width : 0
  ctx.font = monoFont
  const stepText = note.step ?? ""
  const stepW = stepText ? ctx.measureText(stepText).width + 14 * sx : 0
  const navW = note.prevUrl || note.nextUrl || (note.stepCount && note.stepCount > 1) ? 94 * sx : 0

  const padX = 14 * sx
  const cardW = Math.min(cw - 20 * sx, Math.max(260 * sx, titleW + stepW + navW + padX * 2 + 28 * sx, bodyW + padX * 2))
  const cardH = (bodyText ? 48 : 30) * sy
  const cardX = (cw - cardW) * 0.5
  const cardY = topPx

  roundRectPath(ctx, cardX, cardY, cardW, cardH, 9 * sx)
  ctx.fillStyle = "rgba(11, 15, 20, 0.93)"
  ctx.fill()
  ctx.strokeStyle = colors.border
  ctx.lineWidth = Math.max(1, 1.25 * sx)
  ctx.stroke()

  // Left accent bar
  roundRectPath(ctx, cardX + 4 * sx, cardY + 6 * sy, 3 * sx, cardH - 12 * sy, 2 * sx)
  ctx.fillStyle = colors.text
  ctx.fill()

  let curX = cardX + padX
  const row1Y = cardY + (bodyText ? 18 : 19) * sy

  if (stepText) {
    const bw = ctx.measureText(stepText).width + 10 * sx
    const bh = 15 * sy
    roundRectPath(ctx, curX, row1Y - 11.5 * sy, bw, bh, 4 * sx)
    ctx.fillStyle = colors.badgeBg
    ctx.fill()
    ctx.font = monoFont
    ctx.fillStyle = colors.text
    ctx.fillText(stepText, curX + 5 * sx, row1Y - 1 * sy)
    curX += bw + 8 * sx
  }

  ctx.font = titleFont
  ctx.fillStyle = "#f0f5f8"
  ctx.fillText(titleText, curX, row1Y)

  if (bodyText) {
    ctx.font = bodyFont
    ctx.fillStyle = "#a5b5c2"
    ctx.fillText(bodyText, cardX + padX, cardY + 36 * sy, cardW - padX * 2)
  }
  ctx.restore()
}

export async function captureWebGPUOr2DCanvas(
  canvas: HTMLCanvasElement,
  customCapture: ((target: HTMLCanvasElement) => Promise<void> | void) | undefined,
  maxSize = 1280,
  includeOverlay = true,
  overlayReader?: NoteOverlayStateReader | null,
): Promise<{ dataUrl: string; width: number; height: number; sourceWidth: number; sourceHeight: number }> {
  const scratch = document.createElement("canvas")
  const srcW = Math.max(1, canvas.width || canvas.clientWidth || 320)
  const srcH = Math.max(1, canvas.height || canvas.clientHeight || 200)
  scratch.width = srcW
  scratch.height = srcH

  if (customCapture) {
    await customCapture(scratch)
  } else {
    const ctx2d = scratch.getContext("2d")!
    let capturedViaSubmit = false
    if (typeof GPUQueue !== "undefined") {
      const listeners = getSubmitListeners()
      await new Promise<void>(resolve => {
        let settled = false
        let rafAfter = 0
        const onSubmit = () => {
          try {
            ctx2d.drawImage(canvas, 0, 0, srcW, srcH)
            capturedViaSubmit = true
          } catch {}
          if (!rafAfter) {
            rafAfter = requestAnimationFrame(() => {
              window.clearTimeout(timer)
              finish()
            })
          }
        }
        const finish = () => {
          if (settled) return
          settled = true
          listeners.delete(onSubmit)
          if (rafAfter) cancelAnimationFrame(rafAfter)
          resolve()
        }
        const timer = window.setTimeout(() => {
          if (!capturedViaSubmit) {
            try {
              ctx2d.drawImage(canvas, 0, 0, srcW, srcH)
            } catch {}
          }
          finish()
        }, 250)
        listeners.add(onSubmit)
      })
    } else {
      ctx2d.drawImage(canvas, 0, 0, srcW, srcH)
    }
  }

  const limit = maxSize > 0 ? maxSize : Math.max(scratch.width, scratch.height)
  const longest = Math.max(scratch.width, scratch.height)
  let outCanvas = scratch
  if (longest > limit) {
    const scale = limit / longest
    const outW = Math.max(1, Math.round(scratch.width * scale))
    const outH = Math.max(1, Math.round(scratch.height * scale))
    const scaled = document.createElement("canvas")
    scaled.width = outW
    scaled.height = outH
    const sctx = scaled.getContext("2d")!
    sctx.drawImage(scratch, 0, 0, outW, outH)
    outCanvas = scaled
  }

  if (includeOverlay) {
    drawActiveNoteOverlayToCanvas(outCanvas, canvas, overlayReader)
  }

  return {
    dataUrl: outCanvas.toDataURL("image/png"),
    width: outCanvas.width,
    height: outCanvas.height,
    sourceWidth: scratch.width,
    sourceHeight: scratch.height,
  }
}

export function synthesizeHubCanvas(): HTMLCanvasElement {
  const out = document.createElement("canvas")
  out.width = Math.max(640, Math.min(1280, window.innerWidth || 1280))
  out.height = Math.max(400, Math.min(800, window.innerHeight || 800))
  const ctx = out.getContext("2d")!
  ctx.fillStyle = "#0c0d0f"
  ctx.fillRect(0, 0, out.width, out.height)

  const studioPage = document.querySelector<HTMLElement>("[data-arcade-studio-page]:not([hidden])")
  if (studioPage) {
    const titleText = studioPage.querySelector<HTMLElement>("[data-studio-page-title]")?.textContent ?? document.title
    const bodyText = studioPage.querySelector<HTMLElement>("[data-studio-page-body]")?.textContent ?? ""
    ctx.fillStyle = "#f0f5f8"
    ctx.font = "700 20px system-ui, -apple-system, sans-serif"
    ctx.fillText(titleText, 32, 118)
    if (bodyText) {
      ctx.fillStyle = "#9fb0bd"
      ctx.font = "400 13px system-ui, -apple-system, sans-serif"
      ctx.fillText(bodyText.slice(0, 130), 32, 142)
    }

    const imgs = [...studioPage.querySelectorAll<HTMLImageElement>("img[data-studio-image]")]
    if (imgs.length > 0) {
      const cols = Math.min(3, Math.max(1, imgs.length <= 2 ? imgs.length : 3))
      const rows = Math.ceil(imgs.length / cols)
      const gridTop = 166
      const availW = out.width - 64
      const availH = out.height - gridTop - 24
      const gap = 14
      const cellW = Math.floor((availW - gap * (cols - 1)) / cols)
      const cellH = Math.floor((availH - gap * (rows - 1)) / rows)
      imgs.forEach((img, idx) => {
        const col = idx % cols
        const row = Math.floor(idx / cols)
        const cx = 32 + col * (cellW + gap)
        const cy = gridTop + row * (cellH + gap)
        ctx.fillStyle = "#141518"
        ctx.fillRect(cx, cy, cellW, cellH)
        ctx.strokeStyle = "#252a32"
        ctx.strokeRect(cx, cy, cellW, cellH)
        if (img.complete && img.naturalWidth > 0) {
          try {
            ctx.drawImage(img, cx + 2, cy + 2, cellW - 4, cellH - 28)
          } catch {}
        }
        const label = img.dataset.studioLabel || img.alt || ""
        if (label) {
          ctx.fillStyle = "#d8dbe0"
          ctx.font = "600 11.5px system-ui, -apple-system, sans-serif"
          ctx.fillText(label, cx + 10, cy + cellH - 10)
        }
      })
    }
    return out
  }

  ctx.fillStyle = "#171f27"
  ctx.fillRect(0, 0, out.width, 44)
  ctx.fillStyle = "#e4e9ed"
  ctx.font = "600 15px system-ui, -apple-system, sans-serif"
  ctx.fillText(`Arcade Dev Hub (${document.title || location.pathname + location.hash})`, 20, 27)
  const cards = [...document.querySelectorAll<HTMLElement>("a.game")]
  let y = 76
  for (const card of cards) {
    ctx.fillStyle = "#19222b"
    ctx.fillRect(24, y, 260, 54)
    ctx.strokeStyle = "#2d3c4a"
    ctx.strokeRect(24, y, 260, 54)
    ctx.fillStyle = "#e4e9ed"
    ctx.font = "600 14px system-ui, -apple-system, sans-serif"
    ctx.fillText(card.querySelector("span")?.textContent ?? card.dataset.game ?? "Game", 38, y + 24)
    ctx.fillStyle = "#8fa0ad"
    ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace"
    ctx.fillText(card.querySelector("small")?.textContent ?? card.getAttribute("href") ?? "", 38, y + 42)
    y += 66
  }
  return out
}
