import type { Camera } from "@arcade/kit/client/camera"
import type { AIAgent } from "../../shared/ai"
import { ACTIVITY_NAMES, attentionOf, type ZombieAttention } from "../../shared/behaviour/activities"

const COLOUR: Record<ZombieAttention, string> = {
  none: "#8a959c",
  noticed: "#ff8a3d",
  searching: "#f5c242",
  "lost interest": "#9aa7ff",
  resting: "#63d488",
  feeding: "#e0506a",
  following: "#7ce0ff",
}

/**
 * Behaviour debug overlay (Backquote › Zombie behaviour › Behaviour overlay): a label over each zombie with its crowd
 * state, what it is doing and its attention, coloured by attention, so a crowd's chains of noticing, searching and
 * giving up can be read at a glance.
 */
export class BehaviourOverlay {
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  /** Labels drawn last frame (harness). */
  drawn = 0

  hide(): void {
    if (this.canvas) this.canvas.hidden = true
    this.drawn = 0
  }

  draw(
    agents: readonly AIAgent[],
    activity: (id: number) => number,
    support: (x: number, z: number) => number,
    cam: Camera,
    w: number,
    h: number,
  ): void {
    if (typeof document === "undefined") return
    if (!this.canvas) {
      const c = document.createElement("canvas")
      c.id = "behaviour-debug"
      c.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:5"
      document.body.appendChild(c)
      this.canvas = c
      this.ctx = c.getContext("2d")
    }
    const ctx = this.ctx
    if (!ctx) return
    this.canvas.hidden = false
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const cw = Math.round(w * dpr)
    const ch = Math.round(h * dpr)
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw
      this.canvas.height = ch
    }
    ctx.save()
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)
    ctx.font = "600 10px ui-monospace, SFMono-Regular, Menlo, monospace"
    ctx.textAlign = "center"
    let drawn = 0
    for (const a of agents) {
      if (a.state === "dead") continue
      const p = cam.project(a.x, support(a.x, a.y) + 2.3, a.y, w, h)
      if (p.x < -60 || p.x > w + 60 || p.y < -30 || p.y > h + 30) continue
      const act = activity(a.id)
      const attention = attentionOf(act)
      const text = act ? `${ACTIVITY_NAMES[act] ?? act} · ${a.state}` : a.state
      const tw = ctx.measureText(text).width + 8
      ctx.fillStyle = "rgba(10, 14, 16, 0.78)"
      ctx.fillRect(p.x - tw / 2, p.y - 10, tw, 14)
      ctx.fillStyle = COLOUR[attention]
      ctx.fillRect(p.x - tw / 2, p.y + 4, tw * Math.max(0.04, a.awareness), 2)
      ctx.fillText(text, p.x, p.y + 1)
      drawn++
    }
    ctx.restore()
    this.drawn = drawn
  }
}
