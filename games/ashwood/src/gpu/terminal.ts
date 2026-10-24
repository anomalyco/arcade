import { ScreenDisplay, ScreenQuadPass } from "@arcade/kit/gpu/screen/display"
import { screenSceneLight, type ScreenPlacement } from "@arcade/kit/gpu/screen/light"
import { createScreenDisplaySettings } from "@arcade/kit/gpu/screen/settings"
import type { PassContext, ScenePass } from "@arcade/kit/gpu/pass-graph"
import type { Terminal } from "../world/interactive/terminal"
import { keyLabel } from "@arcade/kit/client/controls"

export class TerminalPicture {
  readonly canvas = new OffscreenCanvas(640, 480)
  private readonly ctx = this.canvas.getContext("2d")!
  private previous = ""

  update(terminal: Terminal, time: number): boolean {
    const frame = terminal.frame(), blink = terminal.active && Math.floor(time * 2) % 2 === 0
    const key = JSON.stringify([frame, blink, terminal.active])
    if (key === this.previous) return false
    this.previous = key
    const c = this.ctx
    c.fillStyle = "#020803"; c.fillRect(0, 0, 640, 480)
    if (!frame.powered) return true
    c.font = "20px monospace"; c.textBaseline = "top"
    c.fillStyle = "#86ed9a"; c.fillText(frame.title, 24, 22, 592)
    c.fillStyle = "#386b42"; c.fillRect(24, 55, 592, 2)
    for (let i = 0; i < frame.lines.length; i++) {
      const selected = terminal.active && i === frame.selected
      if (selected) { c.fillStyle = "#123c1c"; c.fillRect(20, 76 + i * 29, 600, 28) }
      c.fillStyle = selected ? "#b1ffc0" : "#63c67a"
      c.fillText(`${selected ? ">" : " "} ${frame.lines[i]}`, 24, 80 + i * 29, 592)
    }
    c.font = "16px monospace"; c.fillStyle = "#63c67a"
    c.fillText(frame.status, 24, 390, 592)
    const help = terminal.active ? `${keyLabel("ArrowUp")}/${keyLabel("ArrowDown")} SELECT  ${keyLabel("Enter")} USE  ${keyLabel("Backspace")} BACK  ${keyLabel("KeyQ")} EXIT` : `${keyLabel("KeyE")} CONNECT`
    c.fillText(help, 24, 432, 592)
    if (blink) c.fillRect(24, 458, 10, 3)
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
    this.display = new ScreenDisplay(ctx.device, { label: terminal.id, settings: createScreenDisplaySettings({ preset: "terminal", power: terminal.services.powered(), brightness: 2, light: 1.2, lightRange: 3.5, autoDegauss: false }) })
    this.picture.update(terminal, 0)
    this.display.setSource({ image: this.picture.canvas, width: 640, height: 480, still: true })
    this.glass = new ScreenQuadPass(ctx, this.display, placement)
    this.pass = this.glass
  }

  update(dt: number): void {
    this.time += Math.max(0, dt)
    this.display.settings.power = this.terminal.services.powered()
    if (this.picture.update(this.terminal, this.time)) this.display.setSource({ image: this.picture.canvas, width: 640, height: 480, still: true })
    this.display.update(dt)
  }

  light() { return screenSceneLight(this.display, this.placement, { id: this.lightId, model: "physical", shape: "panel" }) }
  dispose(): void { this.terminal.leave(); this.glass.dispose(); this.display.dispose() }
}
