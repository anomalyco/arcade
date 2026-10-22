import { attachSky } from "@arcade/kit/sky/controller"
import type { Renderer, FrameInput } from "@arcade/kit/gpu/renderer"
import type { OutbreakClientFrameContext } from "../feature-registry"

const skies = new WeakMap<Renderer, ReturnType<typeof attachSky>>()
export function renderSky(ctx: OutbreakClientFrameContext, input: FrameInput): void {
  const settings = ctx.settings.view
  let sky = skies.get(ctx.renderer)
  if (sky && sky.settings !== settings) { sky.dispose(); skies.delete(ctx.renderer); sky = undefined }
  if (!sky && settings.skyMode === "physical") { sky = attachSky(ctx.renderer, settings); skies.set(ctx.renderer, sky) }
  sky?.update({ time: input.frame[19]!, sceneUnitsPerCdM2: 1 })
}
