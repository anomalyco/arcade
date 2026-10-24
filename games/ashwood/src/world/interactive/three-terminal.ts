import { ExternalTexture, Mesh, MeshBasicNodeMaterial, PlaneGeometry, LinearFilter, SRGBColorSpace, type Group } from "three/webgpu"
import { ScreenDisplay, ScreenFinalPass } from "@arcade/kit/gpu/screen/display"
import { createScreenDisplaySettings } from "@arcade/kit/gpu/screen/settings"
import { TerminalPicture } from "../../gpu/terminal"
import type { Terminal } from "./terminal"
import type { Lamp, WorldContext } from "../context"
import { power } from "../power"

/** The shared native CRT signal is sampled by Three through its public ExternalTexture API. */
export class ThreeTerminal {
  readonly picture = new TerminalPicture()
  readonly display: ScreenDisplay
  readonly final: ScreenFinalPass
  readonly texture: ExternalTexture
  readonly screen: Mesh
  readonly lamp: Lamp
  private readonly device: GPUDevice
  private readonly output: GPUTexture
  private time = 0
  private readonly frame = new Float32Array(0)

  constructor(ctx: WorldContext, readonly terminal: Terminal, readonly glass: Group, storey: number) {
    this.device = (ctx.renderer.backend as unknown as { device: GPUDevice }).device
    this.display = new ScreenDisplay(this.device, { label: terminal.id, settings: createScreenDisplaySettings({ preset: "terminal", brightness: 3, light: 20, autoDegauss: false }) })
    this.final = new ScreenFinalPass(this.device, "rgba8unorm", this.display)
    this.final.margin = 0
    this.final.source(640, 480)
    this.output = this.device.createTexture({ label: `${terminal.id} face`, size: [640, 480], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
    this.texture = new ExternalTexture(this.output)
    this.texture.colorSpace = SRGBColorSpace
    this.texture.minFilter = this.texture.magFilter = LinearFilter
    this.texture.generateMipmaps = false
    this.texture.flipY = false
    this.screen = new Mesh(new PlaneGeometry(0.46, 0.29), new MeshBasicNodeMaterial({ map: this.texture, toneMapped: false }))
    const uv = this.screen.geometry.getAttribute("uv")
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i))
    this.screen.name = `${terminal.id}:live-screen`
    glass.add(this.screen)
    const p = glass.getWorldPosition(glass.position.clone())
    this.lamp = { kind: "window", position: [p.x, p.y, p.z], color: [0.22, 1, 0.33], intensity: 0.6, range: 3.5, size: 0.2, zone: `interior:${storey}` }
    power.exempt(this.lamp)
    ctx.lamps.push(this.lamp)
    this.update(0, true)
  }

  update(dt: number, visible: boolean) {
    this.time += dt
    const on = this.terminal.services.powered()
    if (!on) this.terminal.leave()
    this.display.settings.power = on
    if (this.picture.update(this.terminal, this.time)) this.display.setSource({ image: this.picture.canvas, width: 640, height: 480, still: true })
    if (!visible) { this.lamp.intensity = 0; return }
    this.display.update(dt)
    const encoder = this.device.createCommandEncoder({ label: `${this.terminal.id} CRT` })
    this.final.encode(encoder, this.output.createView(), this.frame)
    this.device.queue.submit([encoder.finish()])
    const [r, g, b] = this.display.emission(), peak = Math.max(r, g, b)
    this.lamp.color = peak > 0 ? [r / peak, g / peak, b / peak] : [0.22, 1, 0.33]
    this.lamp.intensity = on ? peak * 0.46 * 0.29 * this.display.settings.light : 0
  }

  dispose() { this.final.dispose(); this.display.dispose(); this.texture.dispose(); this.output.destroy(); this.screen.geometry.dispose(); (this.screen.material as MeshBasicNodeMaterial).dispose() }
}
