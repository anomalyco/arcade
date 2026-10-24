import { ScreenDisplay, ScreenQuadPass } from "@arcade/kit/gpu/screen/display"
import { screenSceneLight, type ScreenPlacement } from "@arcade/kit/gpu/screen/light"
import { createScreenDisplaySettings } from "@arcade/kit/gpu/screen/settings"
import type { PassContext, ScenePass } from "@arcade/kit/gpu/pass-graph"
import type { Terminal } from "../world/interactive/terminal"
import { keyLabel } from "@arcade/kit/client/controls"

/** A sharp monochrome tube: the kit's terminal preset with its halation, afterglow trails and room glare cut back so
 *  the phosphor text stays legible from arm's length (the scene supplies real reflections on the glass). */
export const TERMINAL_TUBE = { preset: "terminal", brightness: 1.6, sharpness: 0.95, persistence: 0, lines: 384, scanlines: 0.35, beam: 0.5, curvature: 0.22, vignette: 0.32, corner: 0.06, glow: 0.22, glass: 0, roomReflection: 0, smudge: 0, faceGrey: 0.003, autoDegauss: false } as const

/** The terminal's frame buffer as drawn by a 1984 green-phosphor tube: bold monospace on a black face, inverse-video
 *  selection, a soft phosphor bloom under each glyph. Drawn at the display's signal resolution so the glyphs stay crisp
 *  through the tube pass. */
export class TerminalPicture {
  readonly canvas: OffscreenCanvas
  private readonly ctx: OffscreenCanvasRenderingContext2D
  private previous = ""

  constructor(readonly width = 1280, readonly height = 800) {
    this.canvas = new OffscreenCanvas(width, height)
    this.ctx = this.canvas.getContext("2d")!
  }

  update(terminal: Terminal, time: number): boolean {
    const frame = terminal.frame(), blink = terminal.active && Math.floor(time * 2) % 2 === 0
    const key = JSON.stringify([frame, blink, terminal.active])
    if (key === this.previous) return false
    this.previous = key
    const c = this.ctx, k = this.height / 768, W = this.width
    c.fillStyle = "#000200"; c.fillRect(0, 0, W, this.height)
    if (!frame.powered) return true
    const left = 56 * k, right = W - 56 * k, span = right - left
    const text = (s: string, x: number, y: number, size: number, color: string, glow = true) => {
      c.font = `bold ${Math.round(size * k)}px "Courier New", "Lucida Console", monospace`
      c.textBaseline = "top"
      if (glow) { c.shadowColor = "rgba(60,255,110,0.65)"; c.shadowBlur = 9 * k; c.fillStyle = color; c.fillText(s, x, y, span) }
      c.shadowBlur = 0; c.fillStyle = color; c.fillText(s, x, y, span)
    }
    text(frame.title, left, 44 * k, 38, "#8dffa4")
    c.fillStyle = "#3fd765"; c.fillRect(left, 98 * k, span, 3 * k)
    for (let i = 0; i < frame.lines.length; i++) {
      const selected = terminal.active && i === frame.selected, y = 124 * k + i * 46 * k
      if (selected) { c.shadowColor = "rgba(60,255,110,0.5)"; c.shadowBlur = 12 * k; c.fillStyle = "#62f582"; c.fillRect(left - 10 * k, y - 6 * k, span + 20 * k, 42 * k); c.shadowBlur = 0 }
      text(`${selected ? ">" : " "} ${frame.lines[i]}`, left, y, 31, selected ? "#001a04" : "#5ef07e", !selected)
    }
    c.fillStyle = "#1f7a35"; c.fillRect(left, 610 * k, span, 2 * k)
    text(frame.status, left, 628 * k, 27, "#5ef07e")
    const help = terminal.active ? `${keyLabel("ArrowUp")}/${keyLabel("ArrowDown")} SELECT  ${keyLabel("Enter")} USE  ${keyLabel("Backspace")} BACK  ${keyLabel("KeyQ")} EXIT` : `${keyLabel("KeyE")} CONNECT`
    text(help, left, 676 * k, 23, "#3cc45c")
    if (blink) { c.fillStyle = "#8dffa4"; c.fillRect(left, 716 * k, 18 * k, 26 * k) }
    return true
  }
}

/** Register pass in the renderer's opaque slot; include light() in the same storey's physical-light list. */
export class NativeTerminal {
  readonly picture = new TerminalPicture()
  readonly display: ScreenDisplay
  readonly pass: ScenePass
  readonly glass: ScreenQuadPass
  private time = 0
  constructor(ctx: PassContext, readonly terminal: Terminal, readonly placement: ScreenPlacement, readonly lightId: number) {
    this.display = new ScreenDisplay(ctx.device, { label: terminal.id, width: this.picture.width, height: this.picture.height, settings: createScreenDisplaySettings({ ...TERMINAL_TUBE, power: terminal.services.powered(), light: 1.2, lightRange: 3.5 }) })
    this.picture.update(terminal, 0)
    this.display.setSource({ image: this.picture.canvas, width: this.picture.width, height: this.picture.height, still: true })
    this.glass = new ScreenQuadPass(ctx, this.display, placement)
    this.pass = this.glass
  }

  update(dt: number): void {
    this.time += Math.max(0, dt)
    this.display.settings.power = this.terminal.services.powered()
    if (this.picture.update(this.terminal, this.time)) this.display.setSource({ image: this.picture.canvas, width: this.picture.width, height: this.picture.height, still: true })
    this.display.update(dt)
  }

  light() { return screenSceneLight(this.display, this.placement, { id: this.lightId, model: "physical", shape: "panel" }) }
  dispose(): void { this.terminal.leave(); this.glass.dispose(); this.display.dispose() }
}
