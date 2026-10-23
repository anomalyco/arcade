import type { Renderer } from "@arcade/kit/gpu/renderer"
import { ScreenDisplay, ScreenQuadPass } from "@arcade/kit/gpu/screen/display"
import type { ScreenPlacement } from "@arcade/kit/gpu/screen/light"
import { ScreenProgramme } from "@arcade/kit/gpu/screen/programme"
import { SCREEN_PRESETS, applyScreenPreset, createScreenDisplaySettings } from "@arcade/kit/gpu/screen/settings"
import type { DetailSite } from "./placement"
import type { OutbreakDetailSettings } from "./settings"

/** The television model's glass (`models.ts` `tv`), in model space: centre, half size, front face at +Z, 7 mm proud of
 * the glow box (z 0.215) so depth keeps them apart at street distances. */
const GLASS = { x: -0.04, y: 0.7, z: 0.222, halfWidth: 0.21, halfHeight: 0.17 } as const

/** Where a television site's glass is in the world (instances turn +Z to (−sin yaw, cos yaw)). */
export function tvGlass(site: Pick<DetailSite, "x" | "y" | "z" | "yaw" | "scale">): ScreenPlacement {
  const c = Math.cos(site.yaw), s = Math.sin(site.yaw), k = site.scale
  return {
    center: [site.x + (GLASS.x * c - GLASS.z * s) * k, site.y + GLASS.y * k, site.z + (GLASS.x * s + GLASS.z * c) * k],
    yaw: site.yaw + Math.PI / 2,
    width: GLASS.halfWidth * 2 * k,
    height: GLASS.halfHeight * 2 * k,
  }
}

/** The lit television's light this frame: the picture's colour and its brightness against an average picture. */
export type TvPictureLight = { site: DetailSite; color: readonly [number, number, number]; level: number }

/**
 * Details › Televisions show a picture: the nearest lit television draws a real CRT picture (`@arcade/kit/gpu/screen`)
 * instead of its flat glow, and its light on the room follows that picture's colour and cuts instead of the noise
 * flicker. Off by default; nothing is created until it is first turned on.
 */
export class TvPicture {
  private display: ScreenDisplay | null = null
  private programme: ScreenProgramme | null = null
  private quad: ScreenQuadPass | null = null
  private readonly settings = createScreenDisplaySettings()
  private site: DetailSite | null = null

  constructor(private readonly renderer: Pick<Renderer, "addPass" | "passContext">) {}

  /** Places the picture on `site` (the television lit last frame, or null) and advances it by `dt`. */
  update(dt: number, s: OutbreakDetailSettings, site: DetailSite | null): void {
    const on = s.worldDetails && s.dtTvPicture && site !== null
    this.site = on ? site : null
    if (!on) {
      if (this.quad) this.quad.visible = false
      return
    }
    if (!this.display) {
      this.display = new ScreenDisplay(this.renderer.passContext.device, { settings: this.settings, label: "outbreak tv" })
      this.programme = new ScreenProgramme("show")
      this.display.setSource(this.programme.source)
    }
    const preset = SCREEN_PRESETS[s.dtTvSet] ? s.dtTvSet : "tv"
    if (this.settings.preset !== preset) applyScreenPreset(this.settings, preset)
    const glass = tvGlass(site)
    if (!this.quad) {
      this.quad = new ScreenQuadPass(this.renderer.passContext, this.display, glass)
      this.renderer.addPass("opaque", this.quad)
    } else this.quad.place(glass)
    this.quad.visible = true
    this.programme!.paint(this.display.time)
    this.display.update(dt)
  }

  /** The picture's light for the television it is on, or null while it is off or still warming its readback. */
  light(): TvPictureLight | null {
    const d = this.display
    if (!this.site || !d || !d.light.samples) return null
    const e = d.emission()
    const peak = Math.max(e[0], e[1], e[2])
    if (!(peak > 1e-5)) return { site: this.site, color: [0, 0, 0], level: 0 }
    const lum = 0.2126 * e[0] + 0.7152 * e[1] + 0.0722 * e[2]
    // An average programme sits near 40% of peak white; the noise flicker it replaces averages about 0.6.
    const level = Math.min(1.5, (lum / Math.max(this.settings.brightness * 0.4, 1e-4)) * 0.6)
    return { site: this.site, color: [e[0] / peak, e[1] / peak, e[2] / peak], level }
  }

  dispose(): void {
    this.quad?.dispose()
    this.display?.dispose()
    this.quad = null
    this.display = null
  }
}
