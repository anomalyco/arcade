import { Color, ExternalTexture, Mesh, MeshStandardNodeMaterial, PlaneGeometry, LinearFilter, SRGBColorSpace, type Group } from "three/webgpu"
import { ScreenDisplay, ScreenFinalPass } from "@arcade/kit/gpu/screen/display"
import { createScreenDisplaySettings } from "@arcade/kit/gpu/screen/settings"
import { TERMINAL_TUBE, TerminalPicture } from "../../gpu/terminal"
import type { Terminal } from "./terminal"
import type { Lamp, WorldContext } from "../context"
import { power } from "../power"

const SCREEN_GAIN = "terminal.screenGain"

/** The shared native CRT signal is sampled by Three through its public ExternalTexture API. The picture glows from
 *  behind dark, glossy faceplate glass, so the torch and the room still reflect in it. */
export class ThreeTerminal {
  readonly picture = new TerminalPicture(1280, 800)
  readonly display: ScreenDisplay
  readonly final: ScreenFinalPass
  readonly texture: ExternalTexture
  readonly screen: Mesh
  readonly lamp: Lamp
  private readonly device: GPUDevice
  private readonly output: GPUTexture
  private readonly material: MeshStandardNodeMaterial
  private time = 0
  private readonly frame = new Float32Array(0)

  constructor(private readonly ctx: WorldContext, readonly terminal: Terminal, readonly glass: Group, storey: number) {
    if (!(SCREEN_GAIN in ctx.settings)) {
      ctx.settings[SCREEN_GAIN] = 3.2
      ctx.controls.push({ key: SCREEN_GAIN, label: "Terminal phosphor brightness", group: "Lighting", unit: "×", min: 0, max: 12, step: 0.1 })
    }
    const { width, height } = this.picture
    this.device = (ctx.renderer.backend as unknown as { device: GPUDevice }).device
    this.display = new ScreenDisplay(this.device, { label: terminal.id, width, height, settings: createScreenDisplaySettings({ ...TERMINAL_TUBE, light: 36 }) })
    this.final = new ScreenFinalPass(this.device, "rgba8unorm", this.display)
    this.final.margin = 0
    this.final.source(width, height)
    this.output = this.device.createTexture({ label: `${terminal.id} face`, size: [width, height], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
    this.texture = new ExternalTexture(this.output)
    this.texture.colorSpace = SRGBColorSpace
    this.texture.minFilter = this.texture.magFilter = LinearFilter
    this.texture.generateMipmaps = false
    this.texture.flipY = false
    this.material = new MeshStandardNodeMaterial({ color: 0x000000, roughness: 0.08, metalness: 0, emissive: new Color(1, 1, 1), emissiveMap: this.texture, emissiveIntensity: Number(ctx.settings[SCREEN_GAIN]) })
    this.material.name = "terminal:faceplate"
    this.screen = new Mesh(new PlaneGeometry(0.46, 0.29), this.material)
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
    if (this.picture.update(this.terminal, this.time)) this.display.setSource({ image: this.picture.canvas, width: this.picture.width, height: this.picture.height, still: true })
    if (!visible) { this.lamp.intensity = 0; return }
    this.material.emissiveIntensity = Number(this.ctx.settings[SCREEN_GAIN])
    this.display.update(dt)
    const encoder = this.device.createCommandEncoder({ label: `${this.terminal.id} CRT` })
    this.final.encode(encoder, this.output.createView(), this.frame)
    this.device.queue.submit([encoder.finish()])
    const [r, g, b] = this.display.emission(), peak = Math.max(r, g, b)
    this.lamp.color = peak > 0 ? [r / peak, g / peak, b / peak] : [0.22, 1, 0.33]
    this.lamp.intensity = on ? peak * 0.46 * 0.29 * this.display.settings.light : 0
  }

  dispose() { this.final.dispose(); this.display.dispose(); this.texture.dispose(); this.output.destroy(); this.screen.geometry.dispose(); this.material.dispose() }
}
