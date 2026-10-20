// Fitness over generations: best and mean of each population, the mean policy, and the pre-trained walker's score.

import type { GenerationStats } from "../shared/trainer"

export class Chart {
  private ctx: CanvasRenderingContext2D

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!
  }

  draw(history: readonly GenerationStats[], reference: number | null): void {
    const dpr = Math.min(2, devicePixelRatio || 1)
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight
    if (this.canvas.width !== Math.round(cw * dpr)) this.canvas.width = Math.round(cw * dpr)
    if (this.canvas.height !== Math.round(ch * dpr)) this.canvas.height = Math.round(ch * dpr)
    const { ctx } = this
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cw, ch)
    const padL = 34, padR = 10, padT = 22, padB = 20
    const w = cw - padL - padR, h = ch - padT - padB

    ctx.font = "600 11px ui-monospace, Menlo, monospace"
    ctx.fillStyle = "rgba(220,230,245,0.85)"
    ctx.textAlign = "left"
    ctx.fillText("FITNESS", padL, 13)
    const legend: [string, string][] = [["best", "#ff7a59"], ["mean", "#8fc1ff"], ["mean policy", "#e8eef4"]]
    if (reference !== null) legend.push(["pre-trained", "#f5c451"])
    let lx = padL + 64
    ctx.font = "10px ui-monospace, Menlo, monospace"
    for (const [name, color] of legend) {
      ctx.fillStyle = color
      ctx.fillRect(lx, 8, 10, 2)
      ctx.fillStyle = "rgba(220,230,245,0.65)"
      ctx.fillText(name, lx + 14, 13)
      lx += 14 + ctx.measureText(name).width + 12
    }

    const gens = Math.max(10, history.length)
    let lo = 0, hi = 4
    for (const s of history) {
      lo = Math.min(lo, s.mean, s.center)
      hi = Math.max(hi, s.best)
    }
    if (reference !== null) hi = Math.max(hi, reference)
    hi = Math.ceil(hi / 2) * 2
    lo = Math.floor(lo)
    const X = (i: number) => padL + (i / Math.max(1, gens - 1)) * w
    const Y = (v: number) => padT + h - ((v - lo) / (hi - lo)) * h

    ctx.strokeStyle = "rgba(150,170,200,0.12)"
    ctx.lineWidth = 1
    ctx.fillStyle = "rgba(200,212,230,0.5)"
    ctx.textAlign = "right"
    const step = hi - lo > 16 ? 5 : 2
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      ctx.beginPath()
      ctx.moveTo(padL, Math.round(Y(v)) + 0.5)
      ctx.lineTo(padL + w, Math.round(Y(v)) + 0.5)
      ctx.stroke()
      ctx.fillText(String(v), padL - 5, Y(v) + 3)
    }
    ctx.textAlign = "left"
    ctx.fillText("0", padL, ch - 6)
    ctx.textAlign = "right"
    ctx.fillText(`gen ${history.length}`, padL + w, ch - 6)

    if (reference !== null) {
      ctx.strokeStyle = "#f5c451"
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.moveTo(padL, Y(reference))
      ctx.lineTo(padL + w, Y(reference))
      ctx.stroke()
      ctx.setLineDash([])
    }
    const line = (pick: (s: GenerationStats) => number, color: string, width: number) => {
      if (!history.length) return
      ctx.strokeStyle = color
      ctx.lineWidth = width
      ctx.beginPath()
      history.forEach((s, i) => (i ? ctx.lineTo(X(i), Y(pick(s))) : ctx.moveTo(X(i), Y(pick(s)))))
      ctx.stroke()
    }
    line((s) => s.mean, "rgba(143,193,255,0.8)", 1.25)
    line((s) => s.center, "rgba(232,238,244,0.55)", 1)
    line((s) => s.best, "#ff7a59", 1.75)
  }
}
