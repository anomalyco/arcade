// Fear and the lens: how close the lumberjack is, as a number that drives the heartbeat, the breath, flickering
// torches, a closing vignette and draining colour; and blood on the lens that dries.
import { active, type Jack, type World, lumberjackOf } from "../shared/sim"
import type { LookConfig } from "./look"

/** Smooth value noise in [-1, 1] for torch flicker: a stable stutter, not white noise. */
const hash = (n: number) => {
  const s = Math.sin(n * 127.1) * 43758.5453
  return (s - Math.floor(s)) * 2 - 1
}
const noise = (t: number) => {
  const i = Math.floor(t)
  const f = t - i
  const k = f * f * (3 - 2 * f)
  return hash(i) + (hash(i + 1) - hash(i)) * k
}

type Splat = { x: number; y: number; r: number; at: number; drops: { dx: number; dy: number; r: number }[]; run: number }

export class Dread {
  /** 0 calm .. 1 he's on you; eased (fast up, slow down). */
  fear = 0
  /** A spike after his engine cuts out near you: the vignette closes for a moment. */
  private spike = 0
  private readonly vignette: HTMLDivElement
  private readonly lens: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private splats: Splat[] = []
  private drawn = false
  private lastSplash = -1

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.vignette = document.createElement("div")
    this.vignette.style.cssText = "position:fixed;inset:0;pointer-events:none;opacity:0;background:radial-gradient(ellipse at center,rgba(0,0,0,0) 30%,rgba(0,0,0,.96) 92%)"
    this.lens = document.createElement("canvas")
    this.lens.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none"
    this.ctx = this.lens.getContext("2d")!
    canvas.after(this.vignette, this.lens)
  }

  /** How close he is to `focus` (a survivor still in it), 0..1, before easing. */
  static target(w: World, focus: Jack, look: LookConfig): number {
    const lj = lumberjackOf(w)
    if (!lj || !active(lj) || focus.role !== "survivor" || !active(focus) || w.phase !== "play") return 0
    const d = Math.hypot(lj.x - focus.x, lj.y - focus.y)
    let k = Math.max(0, 1 - d / look.fearRange)
    // A running saw is worse than a quiet one; being down is worse still.
    k *= lj.engine === "on" ? (lj.trigger ? 1 : 0.85) : 0.7
    if (focus.downed) k = Math.max(k, 0.6)
    return Math.min(1, k * 1.15)
  }

  /** Eases fear toward `target`, then sets the vignette and the canvas colour. */
  step(target: number, dt: number, look: LookConfig, setVignette: (v: number) => void, reduced: boolean): void {
    const tau = target > this.fear ? 0.35 : 2.2
    this.fear += (target - this.fear) * (1 - Math.exp(-dt / tau))
    this.spike = Math.max(0, this.spike - dt / 2.4)
    const f = this.fear
    setVignette(0.4 + f * look.fearVignette)
    const close = Math.min(1, f * look.fearVignette * 0.55 + this.spike * 0.6)
    this.vignette.style.opacity = close > 0.005 ? String(close) : "0"
    const desat = Math.min(1, f * look.fearDesat)
    this.canvas.style.filter = desat > 0.01 ? `saturate(${1 - desat}) contrast(${1 + desat * 0.15})` : ""
    this.drawLens(dt, look, reduced)
  }

  /** The silence after his engine dies: the view closes in for a breath. */
  hush(): void {
    this.spike = 1
  }

  /** A torch's level near him: it stutters and dips more the closer he is (deterministic in time and id). */
  flicker(level: number, t: number, id: number, fear: number, look: LookConfig): number {
    const k = fear * look.torchFlicker
    if (k <= 0.01) return level
    const n = noise(t * 9 + id * 13.7) * 0.5 + noise(t * 31 + id * 3.1) * 0.5
    const dip = n < -0.25 ? (0.25 - n) * 1.4 : 0
    return Math.max(0.03, level * (1 - Math.min(0.92, k * (0.18 + dip))))
  }

  /** Blood on the lens: a few uneven spatters, heavier with `amount`, that run a little and dry over `lensDry`. */
  splash(amount: number, look: LookConfig, rnd: () => number): void {
    if (look.lensBlood <= 0) return
    // A held saw sprays continuously; the lens takes a fresh hit at most every quarter second.
    if (this.now - this.lastSplash < 0.25) return
    this.lastSplash = this.now
    const n = Math.max(1, Math.round((0.6 + amount * 1.6) * look.lensBlood * (0.6 + rnd() * 0.8)))
    for (let i = 0; i < n; i++) {
      // Low and to the sides, where the spray comes up from the bar.
      const side = rnd() < 0.5 ? -1 : 1
      const x = 0.5 + side * (0.1 + rnd() * 0.4)
      const y = 0.5 + rnd() * 0.45
      const r = (0.008 + rnd() * rnd() * 0.05) * (0.7 + amount * 0.4)
      // A spatter is a lopsided cluster thrown along one direction, with a few satellite specks.
      const dir = rnd() * Math.PI * 2
      const lobes = 2 + Math.floor(rnd() * 3)
      const drops = Array.from({ length: lobes }, (_, k) => ({ dx: Math.cos(dir) * r * (0.6 + k * 0.7), dy: Math.sin(dir) * r * (0.6 + k * 0.7), r: r * (0.75 - k * 0.15) * (0.7 + rnd() * 0.4) }))
      for (let k = Math.floor(rnd() * 4); k > 0; k--) {
        const d = r * (2 + rnd() * 3)
        const a = dir + (rnd() - 0.5) * 1.2
        drops.push({ dx: Math.cos(a) * d, dy: Math.sin(a) * d, r: r * (0.08 + rnd() * 0.15) })
      }
      this.splats.push({ x, y, r, at: this.now, drops, run: rnd() < 0.5 ? rnd() * r * 5 : 0 })
    }
    if (this.splats.length > 24) this.splats.splice(0, this.splats.length - 24)
  }

  clear(): void {
    this.splats = []
    this.lastSplash = -1
    this.fear = 0
    this.spike = 0
  }

  private now = 0
  private drawLens(dt: number, look: LookConfig, reduced: boolean): void {
    this.now += dt
    const live = this.splats.filter((s) => this.now - s.at < look.lensDry)
    this.splats = live
    if (!live.length || reduced) {
      if (this.drawn) {
        this.ctx.clearRect(0, 0, this.lens.width, this.lens.height)
        this.drawn = false
      }
      return
    }
    const W = Math.round(innerWidth / 2)
    const H = Math.round(innerHeight / 2)
    if (this.lens.width !== W || this.lens.height !== H) Object.assign(this.lens, { width: W, height: H })
    const c = this.ctx
    c.clearRect(0, 0, W, H)
    const m = Math.min(W, H)
    for (const s of live) {
      const age = (this.now - s.at) / look.lensDry
      // Wet dark red, then browner and thinner as it dries; it runs down a little while wet.
      const a = 0.8 * (1 - age) ** 0.7
      const r = Math.round(70 - age * 30)
      const g = Math.round(3 + age * 12)
      const run = s.run * Math.min(1, age * 3)
      c.fillStyle = `rgba(${r},${g},2,${a})`
      const blob = (x: number, y: number, rx: number, ry: number) => {
        c.beginPath()
        c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2)
        c.fill()
      }
      blob(s.x * W, s.y * H, s.r * m, s.r * m * 0.85)
      for (const d of s.drops) blob(s.x * W + d.dx * m, s.y * H + d.dy * m, d.r * m, d.r * m * 0.9)
      // A thin trickle while it's wet.
      if (run > 0) c.fillRect(s.x * W - s.r * m * 0.18, s.y * H, s.r * m * 0.36, run * m)
    }
    this.drawn = true
  }
}
